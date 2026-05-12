// Backend AI server for voxel-rts.
//
// The browser game POSTs the enemy-side snapshot of the world state to
// /ai/tick at a fixed cadence and we respond with a list of actions
// for the client to apply (place a building, queue a unit). All
// decision logic lives here so the AI can be iterated on without
// touching the sim.
//
// The brain does not directly spawn units — every enemy unit comes out
// of an enemy building, just like a player unit. The AI controls
// production by issuing `place_building` and `queue_train` actions;
// the client owns world state, footprint validation, and resource
// bookkeeping.
//
// Run: `node ai-server.cjs`. The dev server (vite) and this server
// share no state — the client treats us as best-effort: if we're
// offline, the AI just sleeps.

const http = require('http');

const PORT = process.env.AI_PORT ? Number(process.env.AI_PORT) : 3030;

// Per-session AI brain. Single-player only ships one session
// ('default') today, but we key on a string so a future multi-game
// lobby can fan out without changing the protocol.
const sessions = new Map();

// Building costs. Mirror `spec.upgradeCost` for the kinds the AI ever
// asks for. The client also validates against the canonical specs, so
// these numbers are advisory — they let the brain decide *when* to
// emit an action rather than firing requests the client will refuse.
const BUILDING_COSTS = {
  barracks:      { metals: 40, wood: 40 },
  vehicle_depot: { metals: 70, wood: 50 },
  farm:          { metals: 20, wood: 30 },
  neighborhood:  { metals: 30, wood: 60 },
};

// Unit training costs. Same caveat: client owns the canonical numbers
// (`UNIT_TRAIN_COST` in Buildings.ts); we use these to gate when an
// action is worth emitting.
const UNIT_COSTS = {
  soldier:        { food: 40, metals: 10, wood: 10 },
  gunner:         { food: 60, metals: 30, wood: 0  },
  mortar_soldier: { food: 60, metals: 35, wood: 5  },
  rocket_soldier: { food: 60, metals: 40, wood: 0  },
  tank:           { food: 20, metals: 80, wood: 0  },
  worker:         { food: 30, metals: 0,  wood: 10 },
};

const BARRACKS_PRODUCES = ['soldier', 'gunner', 'rocket_soldier', 'mortar_soldier'];

// Tournament-tunable parameters. Each parallel game gets a slightly
// different env-var seed so we can compare AI variants head-to-head
// and breed the winner forward into the next round.
const env = process.env;
const envNum = (name, fallback) => {
  const v = env[name];
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const TRAIN_INTERVAL_S = envNum('AI_TRAIN_INTERVAL_S', 0.50);
const MAX_FIELDED_ENEMIES = envNum('AI_MAX_FIELDED', 200);
const ATTACK_STOP_FRACTION = envNum('AI_ATTACK_STOP_FRACTION', 0.30);
const ATTACK_RETARGET_S = envNum('AI_ATTACK_RETARGET_S', 1.75);
const WORKER_TARGET = envNum('AI_WORKER_TARGET', 12);
/** How many combat units each base wants to keep within
 *  DEFENDER_RADIUS_M of its own HQ before routing the rest out to
 *  attack. Bigger value = more defensive. Tournament-tunable. */
const DEFENDER_QUOTA = envNum('AI_DEFENDER_QUOTA', 4);
const DEFENDER_RADIUS_M = envNum('AI_DEFENDER_RADIUS_M', 30);
/** Stance: 'aggressive' team routes everything, 'defensive' keeps
 *  DEFENDER_QUOTA*2 at home and waits for attacks, 'economic' delays
 *  the first attack until anyFarms>=2 + anyHoods>=1 so the base has
 *  finished building up before sending units out. Per-team override
 *  via env (AI_STANCE_player / AI_STANCE_enemy / AI_STANCE_enemy2). */
const STANCE_DEFAULT = env.AI_STANCE_DEFAULT || 'aggressive';
function stanceForTeam(team) {
  return env[`AI_STANCE_${team}`] || STANCE_DEFAULT;
}
process.stderr.write(`[ai-server] params train=${TRAIN_INTERVAL_S} attack=${ATTACK_STOP_FRACTION} retarget=${ATTACK_RETARGET_S} workers=${WORKER_TARGET} defenders=${DEFENDER_QUOTA} stance=${STANCE_DEFAULT}\n`);

function ensureSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      lastTickAt: Date.now(),
      attackRetargetCooldown: 0,
      perHq: new Map(),         // hqId → { placeCooldown, trainCooldown, pickIndex }
    };
    sessions.set(id, s);
  }
  return s;
}

function ensurePerHq(s, hqId) {
  let h = s.perHq.get(hqId);
  if (!h) {
    h = {
      placeCooldown: 0.50,
      trainCooldown: TRAIN_INTERVAL_S,
      pickIndex: 0,
    };
    s.perHq.set(hqId, h);
  }
  return h;
}

/** Approximate per-kind weapon range, in metres. The client carries the
 *  canonical numbers; we just need a coarse value to compute a
 *  stop-short distance for the attack-move action. */
const APPROX_WEAPON_RANGE_M = {
  soldier:        18,
  sniper:         32,
  gunner:         16,
  mortar_soldier: 28,
  rocket_soldier: 22,
  tank:           24,
  rocket_truck:   30,
  aa_vehicle:     30,
  worker:         0,
  civilian:       0,
};

function canAffordBuilding(res, kind) {
  const c = BUILDING_COSTS[kind];
  if (!c) return false;
  return res.metals >= c.metals && res.wood >= c.wood;
}

function canAffordUnit(res, kind) {
  const c = UNIT_COSTS[kind];
  if (!c) return false;
  return res.food >= c.food && res.metals >= c.metals && res.wood >= c.wood;
}

/**
 * Brain. Takes the enemy-side snapshot the client sent and returns a
 * list of actions to execute. Mutates the per-session timers.
 *
 * `state` shape:
 *   {
 *     enemyHq: { alive } | null,
 *     enemyResources: { food, metals, wood },
 *     enemyBuildings: [{ id, kind, upgradeState, trainQueueLen }],
 *     enemyUnitCount: number
 *   }
 *
 * Returned action shapes:
 *   { type: 'place_building', kind }
 *   { type: 'queue_train', buildingId, unitKind }
 */
// ============================================================
// Influence maps. Each tick we build a coarse 64×64 grid over the
// world (≈ 4 m per cell). For each team we store two layers:
//   threat[team]: stamps of enemy combat-unit DPS-falloff discs.
//                 An attacker reads this on a candidate target's
//                 cell to discount heavily-defended objectives.
//   value[team]:  stamps of OWN buildings + units. Used by the
//                 defender pass (future) and to break ties between
//                 attack targets — high-value structures get
//                 priority.
// Update is O(units × disc_cells). With ~50 units stamping a 10-cell
// disc, that's ~50×314 = ~16k float adds per tick. Cheap.
// ============================================================
const IM_CELL_M = 4.0;
const IM_W = 64;
const IM_H = 64;
const IM_SIZE = IM_W * IM_H;
const TEAMS_KNOWN = ['player', 'enemy', 'enemy2'];

// Per-unit-kind threat radius + DPS estimate. Numbers are rough but
// preserve the ordering: tanks dominate, soldiers/gunners next,
// melee/utility low.
const UNIT_DPS = {
  soldier:        12,   sniper:         25,
  gunner:         20,   mortar_soldier: 18,
  rocket_soldier: 22,   tank:           60,
  rocket_truck:   45,   aa_vehicle:     8,
  tunneler:       8,    worm:           12,
  worker:         0,    civilian:       0,
  dozer:          0,    supply_truck:   0,
};
const UNIT_THREAT_RADIUS_M = {
  soldier:        20,   sniper:         60,
  gunner:         30,   mortar_soldier: 30,
  rocket_soldier: 20,   tank:           28,
  rocket_truck:   40,   aa_vehicle:     8,
  tunneler:       6,    worm:           6,
  worker:         0,    civilian:       0,
  dozer:          0,    supply_truck:   0,
};
const BUILDING_VALUE = {
  hq:            1000,
  vehicle_depot: 250,
  barracks:      200,
  neighborhood:  120,
  refinery:      90,
  power_plant:   80,
  tech_lab:      80,
  farm:          70,
  storage:       60,
  silo:          120,
  turret:        120,
};

function imIndex(cx, cz) { return cz * IM_W + cx; }
function imCellOfWorld(wx, wz) {
  const cx = Math.max(0, Math.min(IM_W - 1, Math.floor(wx / IM_CELL_M)));
  const cz = Math.max(0, Math.min(IM_H - 1, Math.floor(wz / IM_CELL_M)));
  return imIndex(cx, cz);
}

/** Stamp a linear-falloff disc onto `grid` centred at (cx, cz) in
 *  cell coordinates with radius `r` cells and peak `value`. */
function stampDisc(grid, cx, cz, r, value) {
  if (r <= 0 || value === 0) return;
  const r2 = r * r;
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(IM_W - 1, cx + r);
  const z0 = Math.max(0, cz - r);
  const z1 = Math.min(IM_H - 1, cz + r);
  for (let z = z0; z <= z1; z++) {
    const dz = z - cz;
    const dz2 = dz * dz;
    const row = z * IM_W;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dz2;
      if (d2 > r2) continue;
      const dist = Math.sqrt(d2);
      const falloff = 1 - dist / r;
      grid[row + x] += value * falloff;
    }
  }
}

function buildInfluenceMaps(state) {
  const maps = {};
  for (const team of TEAMS_KNOWN) {
    maps[team] = {
      threat: new Float32Array(IM_SIZE),
      value:  new Float32Array(IM_SIZE),
    };
  }
  const units = Array.isArray(state.enemyUnits) ? state.enemyUnits : [];
  const buildings = Array.isArray(state.enemyBuildings) ? state.enemyBuildings : [];

  // Threat per team: every unit stamps onto EVERY OTHER team's threat
  // layer. (Units don't threaten their own team.) Use the unit's
  // weapon-derived DPS + radius.
  for (const u of units) {
    if (!u || u.hp <= 0) continue;
    const dps = UNIT_DPS[u.kind] || 0;
    const radM = UNIT_THREAT_RADIUS_M[u.kind] || 0;
    if (dps <= 0 || radM <= 0) continue;
    const cx = Math.floor(u.x / IM_CELL_M);
    const cz = Math.floor(u.z / IM_CELL_M);
    const rCells = Math.max(1, Math.round(radM / IM_CELL_M));
    for (const team of TEAMS_KNOWN) {
      if (team === u.team) continue;
      stampDisc(maps[team].threat, cx, cz, rCells, dps);
    }
  }

  // Value per team: own buildings + units stamp onto own team's value
  // layer. Buildings get the big numbers; units get a small +DPS
  // contribution so a unit cluster near a building reads as a
  // hard-to-kill objective.
  for (const b of buildings) {
    if (!b || b.destroyed || !b.team) continue;
    const cx = Math.floor(b.x / IM_CELL_M);
    const cz = Math.floor(b.z / IM_CELL_M);
    const base = BUILDING_VALUE[b.kind] || 30;
    stampDisc(maps[b.team].value, cx, cz, 3, base);
  }
  for (const u of units) {
    if (!u || u.hp <= 0) continue;
    const dps = UNIT_DPS[u.kind] || 0;
    if (dps <= 0) continue;
    const cx = Math.floor(u.x / IM_CELL_M);
    const cz = Math.floor(u.z / IM_CELL_M);
    stampDisc(maps[u.team].value, cx, cz, 2, dps);
  }
  return maps;
}

/** Read a layer at a world position. */
function imSampleAtWorld(layer, wx, wz) {
  return layer[imCellOfWorld(wx, wz)];
}

function decideActions(state, sessionId) {
  const s = ensureSession(sessionId);
  const now = Date.now();
  const dt = Math.max(0, Math.min(2.0, (now - s.lastTickAt) / 1000));
  s.lastTickAt = now;
  const actions = [];

  if (!state) return { actions };
  // Influence maps for the hunt-and-attack pass. Rebuilt every tick.
  const influence = buildInfluenceMaps(state);
  // Multi-HQ aware: every enemy HQ runs its own per-base brain so
  // multiple AI players each build their own barracks + farms with
  // their own resource pool.
  const hqs = Array.isArray(state.enemyHqs) && state.enemyHqs.length > 0
    ? state.enemyHqs
    : (state.enemyHq && state.enemyHq.alive ? [state.enemyHq] : []);
  if (hqs.length === 0) return { actions };
  const buildings = Array.isArray(state.enemyBuildings) ? state.enemyBuildings : [];
  const teamRes = state.teamResources || {};
  const fallbackRes = state.enemyResources || { food: 0, metals: 0, wood: 0 };

  // Per-team budget snapshot. Each AI's queue/place decisions debit
  // from its own pool so two AI factions don't compete for a shared
  // bank — that competition would let the more efficient gatherer
  // starve the other AI of resources.
  const teamBudgets = {};
  for (const hq of hqs) {
    const r = teamRes[hq.team] || fallbackRes;
    teamBudgets[hq.team] = { food: r.food, metals: r.metals, wood: r.wood };
  }

  for (const hq of hqs) {
    if (!hq || !hq.alive) continue;
    const h = ensurePerHq(s, hq.id);
    h.placeCooldown = Math.max(0, h.placeCooldown - dt);
    h.trainCooldown = Math.max(0, h.trainCooldown - dt);

    // Filter buildings claimed by this HQ. With multi-team AIs we also
    // require the building to belong to the same team as the HQ — the
    // anchorHqId is set by closest-HQ proximity, which can otherwise
    // cross teams when bases are mixed in the same quadrant.
    const myBldgs = buildings.filter(b => {
      if (b.team && hq.team && b.team !== hq.team) return false;
      return b.anchorHqId === hq.id || b.anchorHqId == null;
    });
    const liveBarracks = myBldgs.filter(b => b.kind === 'barracks' && b.upgradeState === 'enabled');
    const anyBarracks  = myBldgs.filter(b => b.kind === 'barracks' && b.upgradeState !== 'cancelled');
    const liveFarms    = myBldgs.filter(b => b.kind === 'farm' && b.upgradeState === 'enabled');
    const anyFarms     = myBldgs.filter(b => b.kind === 'farm' && b.upgradeState !== 'cancelled');
    const liveDepots   = myBldgs.filter(b => b.kind === 'vehicle_depot' && b.upgradeState === 'enabled');
    const anyDepots    = myBldgs.filter(b => b.kind === 'vehicle_depot' && b.upgradeState !== 'cancelled');
    const anyHoods     = myBldgs.filter(b => b.kind === 'neighborhood' && b.upgradeState !== 'cancelled');

    // Per-team budget: this HQ's faction has its own resource pool,
    // independent of any other AI faction. Two AIs can't drain a
    // shared bank.
    const budget = teamBudgets[hq.team];
    const debit = (cost) => {
      budget.food   = Math.max(0, budget.food   - (cost.food   || 0));
      budget.metals = Math.max(0, budget.metals - (cost.metals || 0));
      budget.wood   = Math.max(0, budget.wood   - (cost.wood   || 0));
    };
    const canAffordBldg = (kind) => {
      const c = BUILDING_COSTS[kind];
      if (!c) return false;
      return budget.metals >= c.metals && budget.wood >= c.wood;
    };
    const canAffordUnitB = (kind) => {
      const c = UNIT_COSTS[kind];
      if (!c) return false;
      return budget.food >= c.food && budget.metals >= c.metals && budget.wood >= c.wood;
    };

    // Build order: 1 barracks → 2 farms → 1 neighborhood (pop cap)
    // → vehicle depot → more barracks → more neighborhoods.
    // Each AI faction now competes from its own bank, so identical
    // build orders mean both sides scale forces in parallel.
    // Pop cap is 10 + (alive civilians). Without a neighborhood the
    // base stalls at 10 (6 workers + 4 combat), so the hood goes in
    // before the depot to unlock troop scaling.
    // Pop-cap pressure: if we're within 2 slots of the cap, the next
    // unit's production will be frozen at 99%. Top priority is to
    // unfreeze it — either place a second hood (cheap, +5 cap per
    // civilian) or upgrade an existing one (expand_neighborhood adds
    // another house = another civilian quota).
    const teamPop = (state.teamPopUsed && state.teamPopUsed[hq.team]) || 0;
    const teamPopCap = (teamRes[hq.team] && teamRes[hq.team].popCap) || 10;
    const popPressure = teamPop >= teamPopCap - 2;

    const wantMoreBarracks = (anyBarracks.length === 0 && anyFarms.length === 0)
                          || (anyBarracks.length < 3 && anyFarms.length >= 2 && anyHoods.length >= 1);
    if (popPressure && h.placeCooldown === 0 && anyHoods.length < 2 && canAffordBldg('neighborhood')) {
      // Drop a second hood as soon as we're near cap, regardless of
      // where we are in the build order.
      actions.push({ type: 'place_building', kind: 'neighborhood', anchorHqId: hq.id });
      debit(BUILDING_COSTS.neighborhood);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && wantMoreBarracks && canAffordBldg('barracks')) {
      actions.push({ type: 'place_building', kind: 'barracks', anchorHqId: hq.id });
      debit(BUILDING_COSTS.barracks);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyFarms.length < 2 && anyBarracks.length > 0 && canAffordBldg('farm')) {
      actions.push({ type: 'place_building', kind: 'farm', anchorHqId: hq.id });
      debit(BUILDING_COSTS.farm);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyHoods.length < 2 && anyFarms.length >= 2 && canAffordBldg('neighborhood')) {
      // Neighborhoods are the ONLY pop-cap source. Place up to two
      // so the AI can field a real army (each tier-3 hood = +15 cap).
      actions.push({ type: 'place_building', kind: 'neighborhood', anchorHqId: hq.id });
      debit(BUILDING_COSTS.neighborhood);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyDepots.length === 0 && anyHoods.length >= 1 && canAffordBldg('vehicle_depot')) {
      // Vehicle depot once the food economy is steady and we have
      // pop-cap room from the first neighborhood. Tanks do dramatically
      // more damage to enemy HQs than infantry, so adding even one
      // depot accelerates HQ destruction sharply.
      actions.push({ type: 'place_building', kind: 'vehicle_depot', anchorHqId: hq.id });
      debit(BUILDING_COSTS.vehicle_depot);
      h.placeCooldown = 3.0;
    }
    void liveFarms;
    void liveDepots;

    // Dynamic worker-focus assignment. The seed gives each base 2
    // auto + 2 farm + 2 chop. That's enough food/wood for a barracks
    // and farms but the 30m/60w neighborhood + 70m/50w depot need a
    // larger chop pool. Pick the next building we still need to fund
    // and push idle/auto workers onto the bottleneck resource.
    const myWorkers = Array.isArray(state.workers)
      ? state.workers.filter(w => w.team === hq.team)
      : [];
    if (myWorkers.length > 0) {
      // Sum the cost of every building we still plan to place. That
      // way once wood crosses the most-expensive single cost the AI
      // doesn't suddenly send every worker to mine — it keeps a chop
      // contingent until the TOTAL outstanding lumber bill is met.
      let totalWood = 0, totalMetals = 0;
      const want = (cost, n = 1) => {
        totalMetals += cost.metals * n;
        totalWood   += cost.wood   * n;
      };
      if (anyFarms.length    < 2) want(BUILDING_COSTS.farm,         2 - anyFarms.length);
      if (anyHoods.length    < 2) want(BUILDING_COSTS.neighborhood, 2 - anyHoods.length);
      if (anyDepots.length === 0) want(BUILDING_COSTS.vehicle_depot);
      if (anyBarracks.length < 3) want(BUILDING_COSTS.barracks,     3 - anyBarracks.length);
      const needMetals = Math.max(0, totalMetals - budget.metals);
      const needWood   = Math.max(0, totalWood   - budget.wood);

      // Target focus counts. Food rarely runs out (a soldier costs 40
      // food and farms tick a +60 bag every cycle), so once the team
      // pool has more than a comfortable buffer we drop down to 1
      // farm worker and put the freed worker on the metal/wood
      // shortfall. Without this the AI ends up sitting on 5000+ food
      // while metals/wood are dry — and combat-unit production stalls.
      const FARM_FOOD_BUFFER = 800;
      const wantFarm = budget.food > FARM_FOOD_BUFFER ? 1 : 2;
      let wantChop = 0, wantMine = 0;
      const otherWorkers = 6 - wantFarm;
      if (needWood > 0 && needMetals > 0) {
        wantChop = needWood >= needMetals
          ? Math.ceil(otherWorkers * 0.6)
          : Math.floor(otherWorkers * 0.4);
        wantMine = otherWorkers - wantChop;
      } else if (needWood > 0) {
        wantChop = otherWorkers;
      } else if (needMetals > 0) {
        wantMine = otherWorkers;
      }
      const haveFocus = (f) => myWorkers.filter(w => w.focus === f).length;
      const reassign = (toFocus, deficit) => {
        if (deficit <= 0) return;
        // Pull from auto first, then from the other gathering focus.
        const pullOrder = ['auto', 'mine', 'chop', 'farm'].filter(f => f !== toFocus);
        for (const fromFocus of pullOrder) {
          if (deficit <= 0) return;
          const idle = myWorkers
            .filter(w => w.focus === fromFocus)
            // Don't yank a worker that's actively delivering a
            // resource — let it finish so we don't waste the trip.
            .filter(w => w.taskKind !== 'storage_drop' && w.taskKind !== 'deliver');
          for (const w of idle) {
            if (deficit <= 0) break;
            actions.push({ type: 'set_worker_focus', workerId: w.id, focus: toFocus });
            w.focus = toFocus; // local mirror so the next iteration sees it
            deficit--;
          }
        }
      };
      reassign('farm', wantFarm - haveFocus('farm'));
      reassign('chop', wantChop - haveFocus('chop'));
      reassign('mine', wantMine - haveFocus('mine'));
    }

    // While at pop cap, queueing more units just freezes them at 99%
    // and burns resources reserved by the supply truck (= less metals
    // for the neighborhood we need to break out of the cap). Pause
    // training until the hood lands and pop opens up.
    const trainBlocked = popPressure && teamPop >= teamPopCap;
    // Tank production first: an HQ kill takes a long time with rifles
    // (~5 DPS each vs. 3000 HP), but a tank shell crushes wall voxels
    // and the +90 score on a tank kill is the biggest single
    // contributor we can earn. Spend metals on tanks before infantry
    // when a depot is online.
    if (!trainBlocked && liveDepots.length > 0 && canAffordUnitB('tank')) {
      const depot = liveDepots.find(b => (b.trainQueueLen ?? 0) < 2) || liveDepots[0];
      if ((depot.trainQueueLen ?? 0) < 2) {
        actions.push({ type: 'queue_train', buildingId: depot.id, unitKind: 'tank' });
        debit(UNIT_COSTS.tank);
      }
    }
    // Worker pump: more workers = faster gather rate = bigger army.
    // Each base seeds 6 workers; train extras from the barracks until
    // we hit WORKER_TARGET per team. Don't share `h.trainCooldown`
    // with the combat queue — workers are tracked on a SEPARATE
    // cadence so the barracks combat rotation isn't blocked.
    // WORKER_TARGET is env-tunable for the tournament.
    h.workerCooldown = Math.max(0, (h.workerCooldown ?? 0) - dt);
    if (!trainBlocked && h.workerCooldown === 0 && liveBarracks.length > 0
        && myWorkers.length < WORKER_TARGET
        && canAffordUnitB('worker')) {
      // Pick the barracks with the FEWEST queued items so workers
      // distribute and don't starve any single barracks of combat
      // slots. Cap at 2 queued items so combat training can still
      // share the slot.
      let target = null;
      let bestLen = Infinity;
      for (const b of liveBarracks) {
        const len = b.trainQueueLen ?? 0;
        if (len >= 2) continue;
        if (len < bestLen) { bestLen = len; target = b; }
      }
      if (target) {
        actions.push({ type: 'queue_train', buildingId: target.id, unitKind: 'worker' });
        debit(UNIT_COSTS.worker);
        // 2 s between worker queues so combat training keeps the
        // remaining slots.
        h.workerCooldown = 2.0;
      }
    }
    if (!trainBlocked && h.trainCooldown === 0 && state.enemyUnitCount < MAX_FIELDED_ENEMIES && liveBarracks.length > 0) {
      const target = liveBarracks.find(b => (b.trainQueueLen ?? 0) < 4) || liveBarracks[0];
      for (let i = 0; i < BARRACKS_PRODUCES.length; i++) {
        const idx = (h.pickIndex + i) % BARRACKS_PRODUCES.length;
        const kind = BARRACKS_PRODUCES[idx];
        if (!canAffordUnitB(kind)) continue;
        actions.push({ type: 'queue_train', buildingId: target.id, unitKind: kind });
        debit(UNIT_COSTS[kind]);
        h.pickIndex = idx + 1;
        h.trainCooldown = TRAIN_INTERVAL_S;
        break;
      }
    }
  }

  // 3. Hunt-and-attack: idle aggressive enemy units get routed toward
  //    the nearest player building. Throttled so the path worker
  //    isn't flooded; the per-unit autoengage gate further limits how
  //    often any given unit gets a fresh route.
  s.attackRetargetCooldown = Math.max(0, s.attackRetargetCooldown - dt);
  if (s.attackRetargetCooldown === 0) {
    const enemyUnits = Array.isArray(state.enemyUnits) ? state.enemyUnits : [];
    // Team-aware target list: every live building that isn't owned by
    // the unit's own team is a candidate. With 2+ AI factions this
    // means an `enemy` soldier walks toward `enemy2` HQs as well as
    // the human's HQ — and vice versa, so AIs actually fight each
    // other instead of just attacking the spectator.
    const targets = Array.isArray(state.targetBuildings) && state.targetBuildings.length > 0
      ? state.targetBuildings
      : (Array.isArray(state.playerBuildings) ? state.playerBuildings.map(b => ({ ...b, team: 'player' })) : []);
    let routedThisCycle = 0;
    let armedIdle = 0;
    for (const u of enemyUnits) {
      if (!u || u.hp <= 0) continue;
      if (u.armed && !u.hasFiringTarget && u.pathLen === 0) armedIdle++;
    }
    console.log(`[ai-attack] enemyUnits=${enemyUnits.length} armed-idle=${armedIdle} tgts=${targets.length}`);
    if (enemyUnits.length > 0 && targets.length > 0) {
      // Per-team home HQ for the defender-quota gate. Each combat unit
      // within DEFENDER_RADIUS_M of its team's HQ counts as a "home
      // defender"; we hold back the first DEFENDER_QUOTA per team.
      // Economic stance also delays the FIRST attack until the
      // build-out is mostly done (2 farms + 1 hood on the team).
      const homeHqByTeam = {};
      const defendersByTeam = {};
      const buildoutByTeam = {};
      for (const h of hqs) homeHqByTeam[h.team] = h;
      for (const u of enemyUnits) {
        if (!u || u.hp <= 0) continue;
        const hq = homeHqByTeam[u.team];
        if (!hq) continue;
        const dx = u.x - hq.x, dz = u.z - hq.z;
        if (dx * dx + dz * dz <= DEFENDER_RADIUS_M * DEFENDER_RADIUS_M) {
          defendersByTeam[u.team] = (defendersByTeam[u.team] || 0) + 1;
        }
      }
      for (const team of Object.keys(homeHqByTeam)) {
        const teamBldgs = buildings.filter(b => b.team === team && !b.destroyed && b.upgradeState !== 'cancelled');
        const f = teamBldgs.filter(b => b.kind === 'farm').length;
        const h = teamBldgs.filter(b => b.kind === 'neighborhood').length;
        buildoutByTeam[team] = (f >= 2 && h >= 1);
      }

      let skipFiring = 0, skipPath = 0, skipUnarmed = 0, skipNoBldg = 0, skipInRange = 0, skipDefender = 0, skipEconomic = 0;
      for (const u of enemyUnits) {
        if (!u || u.hp <= 0) continue;
        if (!u.armed) { skipUnarmed++; continue; }
        if (u.hasFiringTarget) { skipFiring++; continue; }
        if (u.pathLen > 0) { skipPath++; continue; }
        // Stance gate. Aggressive teams keep a token garrison (2) so
        // their HQ isn't undefended but route almost everything else.
        // Defensive teams hold a larger garrison home. Economic teams
        // refuse to launch the first attack until the build-out is in
        // (2 farms + 1 hood + barracks) but then attack at the
        // defensive quota.
        const stance = stanceForTeam(u.team);
        const quota = stance === 'defensive' ? DEFENDER_QUOTA * 2
          : stance === 'economic' ? DEFENDER_QUOTA
          : Math.min(2, DEFENDER_QUOTA); // aggressive

        const hq = homeHqByTeam[u.team];
        if (hq) {
          const dx = u.x - hq.x, dz = u.z - hq.z;
          const atHome = dx * dx + dz * dz <= DEFENDER_RADIUS_M * DEFENDER_RADIUS_M;
          if (atHome && (defendersByTeam[u.team] || 0) <= quota) {
            skipDefender++; continue;
          }
        }
        if (stance === 'economic' && !buildoutByTeam[u.team]) {
          skipEconomic++; continue;
        }
        // ============================================================
        // Influence-map target selection. Instead of "pick nearest HQ",
        // score every enemy building by
        //   score = base_value × (1 / (1 + 0.05 × threat_at_cell))
        //                       × (1 / (1 + 0.005 × dist_m))
        // The threat term routes attackers AROUND the strongest
        // defenses toward soft targets; the value term keeps HQs the
        // top priority when defenses are roughly equal; the distance
        // term breaks ties in favour of closer buildings so a unit
        // doesn't walk across the whole map past easy targets.
        // ============================================================
        const threatLayer = influence[u.team] ? influence[u.team].threat : null;
        let imBest = null;
        let imBestScore = -Infinity;
        for (const b of targets) {
          if (!b || !b.alive) continue;
          if (b.team && b.team === u.team) continue;
          const base = BUILDING_VALUE[b.kind];
          if (!base) continue;
          const localThreat = threatLayer ? imSampleAtWorld(threatLayer, b.x, b.z) : 0;
          const dx = b.x - u.x, dz = b.z - u.z;
          const distM = Math.sqrt(dx * dx + dz * dz);
          const score = base
            / (1 + localThreat * 0.05)
            / (1 + distM * 0.005);
          if (score > imBestScore) { imBestScore = score; imBest = b; }
        }
        // Use the influence-map pick if available, otherwise fall back
        // to "nearest HQ / nearest anything" so a snapshot with no
        // value-scored targets still routes attackers somewhere.
        let bestB = imBest;
        if (!bestB) {
          let bestD2 = Infinity;
          for (const b of targets) {
            if (!b || !b.alive) continue;
            if (b.team && b.team === u.team) continue;
            if (b.kind !== 'hq') continue;
            const dx = b.x - u.x, dz = b.z - u.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; bestB = b; }
          }
        }
        if (!bestB) {
          let bestD2 = Infinity;
          for (const b of targets) {
            if (!b || !b.alive) continue;
            if (b.team && b.team === u.team) continue;
            const dx = b.x - u.x, dz = b.z - u.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; bestB = b; }
          }
        }
        if (!bestB) { skipNoBldg++; continue; }
        const range = APPROX_WEAPON_RANGE_M[u.kind] || 18;
        const stopRange = Math.max(1, range * ATTACK_STOP_FRACTION);
        const bdx = bestB.x - u.x, bdz = bestB.z - u.z;
        const bestD2 = bdx * bdx + bdz * bdz;
        const distToTarget = Math.sqrt(bestD2);
        if (distToTarget <= stopRange) { skipInRange++; continue; }
        const scale = (distToTarget - stopRange) / distToTarget;
        // Add a per-unit jitter offset to the firing-line goal so
        // multiple attackers don't stack on the same XZ — without
        // this, several units routing to the same enemy HQ all chose
        // the same goalX/Z and the post-move separation pass couldn't
        // disentangle them within the harness STUCK budget.
        const jitterRad = 1.5; // ~12 voxels of spread
        const jx = ((u.id * 2654435761) >>> 0) / 0x100000000 * 2 - 1;
        const jz = ((u.id * 40503) >>> 0) / 0x100000000 * 2 - 1;
        const goalX = u.x + (bestB.x - u.x) * scale + jx * jitterRad;
        const goalZ = u.z + (bestB.z - u.z) * scale + jz * jitterRad;
        actions.push({ type: 'route_unit', unitId: u.id, x: goalX, z: goalZ });
        routedThisCycle++;
      }
      if (routedThisCycle > 0 || skipPath > 0 || skipFiring > 0) {
        console.log(`[ai-attack] skips firing=${skipFiring} path=${skipPath} unarmed=${skipUnarmed} noBldg=${skipNoBldg} inRange=${skipInRange}`);
      }
    }
    if (routedThisCycle > 0) console.log(`[ai-attack] routed=${routedThisCycle}`);
    s.attackRetargetCooldown = ATTACK_RETARGET_S;
  }

  return { actions };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/ai/tick') {
    res.writeHead(404); res.end(); return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch (_e) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
    const sessionId = (payload && payload.sessionId) || 'default';
    let result;
    try { result = decideActions(payload && payload.state, sessionId); }
    catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  req.on('error', () => { try { res.writeHead(400); res.end(); } catch (_e) { /* ignore */ } });
});

// ----------------------------------------------------------------------------
// Phase 5d — engine bridge
// ----------------------------------------------------------------------------
//
// When AI_DIRECT_URL points at a running game-server, this process
// can drive enemies without a browser in the loop: poll the
// authoritative snapshot, derive the same `enemyState` shape the
// pre-zero-trust /ai/tick used to take, run `decideActions`, and ship
// the resulting actions back as game-server commands. Phase 5c
// already gated the browser's RemoteAIClient off under zero-trust, so
// this bridge is what keeps the AI-controlled side breathing.
//
// Today only `route_unit` actions translate cleanly (game-server's
// `move_entity`). `place_building` + `queue_train` need server-side
// footprint validation + train-queue mutation we haven't ported yet —
// they'll get queued for a follow-up phase.

const NAV_CELL_METERS = 1.0;
/** Game-server "owner" string for the enemy side. The lobby will own
 *  the team↔owner mapping eventually; for single-player the enemy
 *  brain runs against `enemy`. */
const ENEMY_OWNER_DEFAULT = 'enemy';

function snapshotToEnemyState(snapshot, opts) {
  const enemyOwner = (opts && opts.enemyOwner) || ENEMY_OWNER_DEFAULT;
  const buildings = Array.isArray(snapshot.buildings) ? snapshot.buildings : [];
  const entities = Array.isArray(snapshot.entities) ? snapshot.entities : [];
  const resources = (snapshot.resources && typeof snapshot.resources === 'object') ? snapshot.resources : {};

  const enemyBuildings = buildings
    .filter(b => b && b.owner === enemyOwner && !b.destroyed)
    .map(b => ({
      id: b.id,
      kind: b.kind,
      upgradeState: b.upgradeState,
      trainQueueLen: b.trainQueueLen ?? 0,
      x: (b.ox + (b.cellsW || 1) * 0.5) * NAV_CELL_METERS,
      z: (b.oz + (b.cellsD || 1) * 0.5) * NAV_CELL_METERS,
    }));
  const playerBuildings = buildings
    .filter(b => b && b.owner !== enemyOwner && !b.destroyed)
    .map(b => ({
      id: b.id,
      alive: !b.destroyed,
      x: (b.ox + (b.cellsW || 1) * 0.5) * NAV_CELL_METERS,
      z: (b.oz + (b.cellsD || 1) * 0.5) * NAV_CELL_METERS,
    }));
  const enemyUnits = entities
    .filter(e => e && e.owner === enemyOwner && (e.kind || '') !== 'civilian' && (e.hp ?? 0) > 0)
    .map(e => ({
      id: e.id,
      kind: e.kind,
      hp: e.hp,
      x: e.x,
      z: e.z,
      pathLen: e.pathLen ?? 0,
      // The pre-zero-trust /ai/tick fed `armed` and `hasFiringTarget`
      // from the browser. The snapshot doesn't carry those today, so
      // we treat an idle (path-empty, no target) unit as eligible to
      // receive a fresh route. The game-server's tickAutoEngage gates
      // actual firing.
      armed: APPROX_WEAPON_RANGE_M[e.kind] != null && APPROX_WEAPON_RANGE_M[e.kind] > 0,
      hasFiringTarget: !!e.target,
    }));
  const enemyHq = enemyBuildings.find(b => b.kind === 'hq');
  return {
    enemyHq: enemyHq ? { alive: true } : null,
    enemyResources: resources[enemyOwner] || { food: 0, metals: 0, wood: 0 },
    enemyBuildings,
    enemyUnitCount: enemyUnits.length,
    enemyUnits,
    playerBuildings,
  };
}

function actionsToCommands(actions, opts) {
  const enemyOwner = (opts && opts.enemyOwner) || ENEMY_OWNER_DEFAULT;
  const commands = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'route_unit') {
      commands.push({
        type: 'move_entity',
        id: a.unitId,
        owner: enemyOwner,
        x: a.x,
        z: a.z,
      });
      continue;
    }
    if (a.type === 'queue_train') {
      // Phase 5e: server-side queue_train appends a unit kind to the
      // building's existing queue without round-tripping its current
      // contents. owner-stamped so a runaway brain can't poke a
      // non-enemy building.
      commands.push({
        type: 'queue_train',
        id: a.buildingId,
        owner: enemyOwner,
        unitKind: a.unitKind,
      });
      continue;
    }
    if (a.type === 'place_building') {
      // Phase 5f: server runs its own spot picker when ox/oz are
      // omitted, anchored at the owner's HQ. Brain just declares
      // intent (kind); actual cells + floorY come from the server's
      // pickBuildingSpot reading the worldgen overlay.
      commands.push({
        type: 'place_building',
        owner: enemyOwner,
        kind: a.kind,
        clientTag: `ai-${enemyOwner}-${a.kind}-${Date.now()}`,
      });
      continue;
    }
  }
  return commands;
}

/** Compose: take a game-server snapshot, run the brain, return a
 *  flat list of /game/input commands. Pure (modulo per-session
 *  timer mutation inside `decideActions`). */
function snapshotToCommands(snapshot, sessionId, opts) {
  const enemyState = snapshotToEnemyState(snapshot, opts);
  const { actions } = decideActions(enemyState, sessionId || 'default');
  return actionsToCommands(actions, opts);
}

async function postCommands(gameUrl, commands) {
  if (commands.length === 0) return;
  const url = new URL('/game/input', gameUrl).toString();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`/game/input ${r.status}`);
}

async function bridgeTick(gameUrl, sessionId, opts) {
  // Identify ourselves so the server's per-viewer snapshot filter
  // hands back the enemy resource pool (without `?player=` we'd see
  // every owner's resources, but we'd also be acting as a maphack).
  const enemyOwner = (opts && opts.enemyOwner) || ENEMY_OWNER_DEFAULT;
  const u = new URL('/game/state', gameUrl);
  u.searchParams.set('player', enemyOwner);
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error(`/game/state ${r.status}`);
  const snapshot = await r.json();
  const commands = snapshotToCommands(snapshot, sessionId, opts);
  await postCommands(gameUrl, commands);
}

let bridgeHandle = null;
function startEngineBridge(gameUrl, opts) {
  if (bridgeHandle) return;
  const intervalMs = (opts && opts.intervalMs) || 1000;
  const sessionId = (opts && opts.sessionId) || 'default';
  bridgeHandle = setInterval(() => {
    bridgeTick(gameUrl, sessionId, opts).catch(err => {
      // Don't take the process down on a transient — the bridge
      // is best-effort.
      process.stderr.write(`ai-server bridge: ${String(err)}\n`);
    });
  }, intervalMs);
  bridgeHandle.unref?.();
  process.stderr.write(`ai-server bridge: polling ${gameUrl} every ${intervalMs}ms\n`);
}

if (!process.env.AI_SERVER_TEST) {
  server.listen(PORT, () => process.stderr.write(`ai-server listening on :${PORT}\n`));
  if (process.env.AI_DIRECT_URL) {
    startEngineBridge(process.env.AI_DIRECT_URL);
  }
}

module.exports = {
  decideActions,
  ensureSession,
  TRAIN_INTERVAL_S,
  MAX_FIELDED_ENEMIES,
  BUILDING_COSTS,
  UNIT_COSTS,
  snapshotToEnemyState,
  actionsToCommands,
  snapshotToCommands,
  bridgeTick,
  startEngineBridge,
};
