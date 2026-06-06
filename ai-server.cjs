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

// `expand_neighborhood` upgrade cost — mirrors the `expand` upgrade option's
// baseCost in src/sim/Buildings.ts. Expanding an existing enabled hood adds
// another house (+5 pop cap) for less than a fresh hood (30m/60w) and reuses
// the lot's already-built, base-proximate footprint, so its upgrade-delivery
// truck has a short, defended haul instead of a long exposed one. It's how a
// team grows pop past `hoods × 5` toward the tier-3 `hoods × 15` ceiling.
const EXPAND_COST = { metals: 25, wood: 50 };

// Unit training costs. Same caveat: client owns the canonical numbers
// (`UNIT_TRAIN_COST` in Buildings.ts); we use these to gate when an
// action is worth emitting.
const UNIT_COSTS = {
  soldier:        { food: 40, metals: 10, wood: 10 },
  gunner:         { food: 60, metals: 30, wood: 0  },
  mortar_soldier: { food: 60, metals: 35, wood: 5  },
  rocket_soldier: { food: 60, metals: 40, wood: 0  },
  tank:           { food: 20, metals: 80, wood: 0  },
  // Advanced vehicle-depot units. Costs mirror the canonical UNIT_TRAIN_COST
  // in src/sim/Buildings.ts. Before iter64 the brain had no cost rows for
  // these, so `canAffordUnitB('aa_vehicle')` returned false and the depot
  // only ever queued tanks — the AI never fielded anti-air or missile
  // launchers despite the depot being able to build them.
  rocket_truck:   { food: 20, metals: 80, wood: 0  },
  aa_vehicle:     { food: 20, metals: 90, wood: 0  },
  worker:         { food: 30, metals: 0,  wood: 10 },
  // Digging units. Costs mirror UNIT_TRAIN_COST in src/sim/Buildings.ts.
  // Both come out of the vehicle depot. The brain fields a tunneler (or
  // worm) so the army has a sapper that can carve a straight tunnel
  // through terrain to the enemy base — see the tunneler siege pass in
  // the attack section, and DIGGER_TARGET below for how many it wants.
  tunneler:       { food: 20, metals: 120, wood: 0 },
  worm:           { food: 20, metals: 100, wood: 0 },
};

const BARRACKS_PRODUCES = ['soldier', 'gunner', 'rocket_soldier', 'mortar_soldier'];
// Vehicle-depot rotation. The depot can build all of these (Buildings.ts
// VEHICLE_DEPOT.produces); the brain rotates through them so a teched-up AI
// fields a mix of tanks (HQ demolition), rocket trucks (siege/missile) and
// anti-air vehicles instead of tank-spamming. Order weights ground punch
// first (tank, rocket_truck) with AA folded in for air/projectile defence.
const DEPOT_PRODUCES = ['tank', 'rocket_truck', 'aa_vehicle'];
// Max metal cost across the depot rotation — used as the metal reserve so
// infantry training doesn't drain the pool below what a vehicle needs.
const MAX_DEPOT_METAL = Math.max(...DEPOT_PRODUCES.map(k => UNIT_COSTS[k].metals));

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
const TRAIN_INTERVAL_S = envNum('AI_TRAIN_INTERVAL_S', 0.30);
const MAX_FIELDED_ENEMIES = envNum('AI_MAX_FIELDED', 200);
const ATTACK_STOP_FRACTION = envNum('AI_ATTACK_STOP_FRACTION', 0.30);
const ATTACK_RETARGET_S = envNum('AI_ATTACK_RETARGET_S', 1.75);
// Global worker ceiling. Acts as an upper clamp on every strategy's own worker
// target (strategyWorkerCap = min(WORKER_TARGET, t.workers)). Raised 12→16 so
// econ_boom (which wants 16 gatherers) isn't silently clamped to 12 — at 12 it
// failed to out-economy the others, defeating its identity (iter85: 7 workers).
// Other strategies are unaffected (their t.workers are ≤ 12).
const WORKER_TARGET = envNum('AI_WORKER_TARGET', 16);
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
/** Adaptive-stance override. Even with a fixed seed stance, the
 *  effective stance shifts with game state:
 *  - HEAVY attack (3+ armed enemies within 40 m of own HQ AND HQ
 *    HP < 90 %) → defensive. Single scouts don't flip the team.
 *  - No build-out yet (< 2 farms or no hood) → economic.
 *  - Otherwise → whatever the seed says.
 *  Disable with AI_ADAPTIVE_STANCE=0 to keep the seed fixed. */
const ADAPTIVE_STANCE = envNum('AI_ADAPTIVE_STANCE', 1);
function effectiveStance(team, ctx) {
  const seed = stanceForTeam(team);
  if (!ADAPTIVE_STANCE) return seed;
  if (ctx.heavyAttackByTeam && ctx.heavyAttackByTeam[team]) return 'defensive';
  // Note: the original `!buildoutByTeam → economic` flip was removed.
  // Buildout requires 2 farms + 1 neighborhood, but neighborhoods cost
  // wood, and wood only arrives via supply trucks. When the truck loop
  // can't close (storage placement geometry plus AI placement order
  // produce layouts the truck planner can't navigate) the buildout
  // never completes, every team's stance flips to `economic`, and the
  // attack pass skips every combat unit for the full match. iter26
  // dump: 5 combat units, all skipped via `defender=2 economic=3`,
  // HQ HP 3000/3000. With the flip removed, seed stance (aggressive
  // by default) keeps the AI attacking even while wood collection is
  // slower than ideal — the seed strategy still cares about the home
  // garrison via the defender quota, so this isn't a free-for-all.
  return seed;
}
/** Wave-timing: don't dribble attackers to the enemy one at a time.
 *  Hold idle armed units back until at least WAVE_SIZE are ready,
 *  then release the whole pack in one cycle. The defending side
 *  faces a concentrated push instead of single-file traffic that
 *  dies on the way in. Tunable per round.
 *
 *  Default 5 (rally-then-commit, iter48): WAVE_SIZE is the number of
 *  attackers a team masses at its forward rally point before the whole
 *  army commits to a single enemy HQ. Earlier flat per-unit waves of 2
 *  (iter42) dribbled attackers across the 380 m map where 3-way midfield
 *  attrition ground them down (iter43: 71 unit kills, 0 HQ damage). With
 *  the rally/commit state machine below, a 5-unit massed push survives
 *  the crossing and arrives with enough force to demolish an HQ. The
 *  economy now fields 12+ combat units so the 5-unit gate is reachable;
 *  a gather-time cap (GATHER_MAX_S) force-commits with ≥2 ready so the
 *  never-release failure mode of the old WAVE=5 can't recur. */
const WAVE_SIZE = envNum('AI_WAVE_SIZE', 5);
/** Gather-time force-commit. The WAVE_SIZE gate holds attackers home until a
 *  full pack of WAVE_SIZE is idle-and-ready at once. A team that can't reach
 *  that — pop-capped to a small army, or bleeding units to midfield attrition
 *  as fast as it masses — would otherwise sit on its army for the WHOLE match
 *  (iter comment promised this cap but it was never wired up). Once a team has
 *  been massing this long with at least a minimal pack (2) ready, commit the
 *  wave anyway so a stalled army still pressures the enemy. Tournament-tunable;
 *  0 disables (pure WAVE_SIZE gate). */
const GATHER_MAX_S = envNum('AI_GATHER_MAX_S', 30);
/** Auto-rebuild: when a barracks / farm / hood is destroyed the count-based
 *  build order re-places it automatically (the snapshot drops destroyed
 *  buildings, so `anyBarracks.length < target` fires again). This flag is
 *  retained as an ablation knob but the rebuild is implicit in the build order. */
const AUTO_REBUILD = envNum('AI_AUTO_REBUILD', 1);

/** How many digging units (tunnelers) a depot-teching team wants to field.
 *  Diggers carve a straight tunnel through terrain toward the enemy HQ (see the
 *  depot-train rule and the tunneler siege pass), bypassing the surface front to
 *  attack the base directly. Default 2: a lone sapper surfaces at the HQ and the
 *  home garrison kills it before it carves through, but a PAIR overwhelms the
 *  defenders and breaks the base — in the headless batch sim (scripts/
 *  aiBatchSim.cjs, with underground-transit modelled) decisive-game rate rose
 *  monotonically 1→2→3 diggers (58→61→65%), so 2 buys most of the gain without
 *  over-investing 120 metals/digger away from the army. Non-teching strategies
 *  (no depot) field none; diggers queue AFTER the depot's first combat vehicle
 *  so primary armour still leads. Tournament-tunable. */
const DIGGER_TARGET = envNum('AI_DIGGER_TARGET', 2);

/** Build-order STRATEGY (goal D). Orthogonal to stance: a strategy picks the
 *  shape of the build plan (how many barracks/farms/hoods, whether & when to
 *  tech to a vehicle depot, the worker target), while stance picks aggression.
 *  Per-team override via AI_STRATEGY_player / _enemy / _enemy2; default via
 *  AI_STRATEGY_DEFAULT. The harness seed-randomises a strategy per team so
 *  AI-vs-AI matches show real opening variety. */
const STRATEGY_DEFAULT = env.AI_STRATEGY_DEFAULT || '';
/** Resolve a team's strategy. Priority: explicit AI_STRATEGY_<team> env →
 *  AI_STRATEGY_DEFAULT env → per-session seed-random pick. The random fallback
 *  means a persistent sidecar still gives each MATCH (session) a fresh mix of
 *  openings per team, so AI-vs-AI runs vary without restarting the server. */
function strategyForTeam(team, session) {
  const explicit = env[`AI_STRATEGY_${team}`] || STRATEGY_DEFAULT;
  if (explicit) return explicit;
  if (session) {
    if (!session.strategies) session.strategies = {};
    if (!session.strategies[team]) {
      const keys = Object.keys(BUILD_TARGETS);
      session.strategies[team] = keys[Math.floor(Math.random() * keys.length)];
      process.stderr.write(`[ai-server] strategy ${team}=${session.strategies[team]} (seed-random)\n`);
    }
    return session.strategies[team];
  }
  return 'balanced';
}
/**
 * Per-strategy build plan.
 *  - barracks/farms/hoods: max of each the HQ builds.
 *  - depot: 1 = tech to a vehicle depot (tanks / rocket trucks / anti-air),
 *    0 = never tech (pure infantry).
 *  - depotFarmReq: farms required before the depot is placed. `tech_air`
 *    rushes it at 1 so the depot's 75 s construction timer finishes inside a
 *    normal ~180 s match and the team actually FIELDS advanced units; the
 *    others wait for a fuller economy (2-3) and usually win/lose on infantry
 *    before teching, which is what makes the openings visibly different.
 *  - workers: worker target (caps the gatherer count for this strategy).
 *  - depotMix: per-strategy vehicle-build rotation (defaults to DEPOT_PRODUCES,
 *    tank-first). `tech_air` still techs early (depotFarmReq 1) and keeps the
 *    aa_vehicle SECOND so it reliably fields its namesake within the ~2-3
 *    vehicles a match produces — but it now LEADS with a tank. Leading with the
 *    aa_vehicle (dps ~8 vs ground) crippled tech_air's offence: in the headless
 *    batch sim (scripts/aiBatchSim.cjs) it won 0% of games until the first
 *    vehicle became a tank (then ~24-34%). Paired with barracks 1→2 for more
 *    infantry punch behind the armour.
 */
const BUILD_TARGETS = {
  balanced:      { barracks: 3, farms: 2, hoods: 2, depot: 1, depotFarmReq: 2, workers: 12 },
  econ_boom:     { barracks: 2, farms: 3, hoods: 3, depot: 1, depotFarmReq: 3, workers: 16 },
  military_rush: { barracks: 3, farms: 1, hoods: 1, depot: 0, depotFarmReq: 2, workers: 8  },
  tech_air:      { barracks: 2, farms: 1, hoods: 3, depot: 1, depotFarmReq: 1, workers: 6, depotMix: ['tank', 'aa_vehicle', 'rocket_truck'] },
};
function buildTargetsFor(team, session) {
  return BUILD_TARGETS[strategyForTeam(team, session)] || BUILD_TARGETS.balanced;
}

process.stderr.write(`[ai-server] params train=${TRAIN_INTERVAL_S} attack=${ATTACK_STOP_FRACTION} retarget=${ATTACK_RETARGET_S} workers=${WORKER_TARGET} defenders=${DEFENDER_QUOTA} stance=${STANCE_DEFAULT} strategy=${STRATEGY_DEFAULT || 'seed-random'}\n`);

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
      depotPickIndex: 0,
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
  const allEnemyUnits = Array.isArray(state.enemyUnits) ? state.enemyUnits : [];
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
    h.diggerCooldown = Math.max(0, (h.diggerCooldown ?? 0) - dt);

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

    // Once a depot is up but no vehicle is queued, hold a vehicle's worth of
    // metals back from EXPANSION buildings (extra barracks, 2nd hood) so the
    // depot can actually fund a tank / rocket_truck / aa_vehicle. iter65 showed
    // depots built but 0 vehicles produced — the team spent every metal on its
    // 6 barracks + 4 hoods and never had the 80-90 spare a vehicle needs. The
    // essential early buildings (first barracks, farms, first hood, the depot
    // itself) ignore the hold so the opening never stalls.
    const vehicleQueuedNow = liveDepots.some(b => (b.trainQueueLen ?? 0) > 0);
    const vehicleHold = (liveDepots.length > 0 && !vehicleQueuedNow) ? MAX_DEPOT_METAL : 0;
    const canAffordExpansion = (kind) => {
      const c = BUILDING_COSTS[kind];
      if (!c) return false;
      return (budget.metals - vehicleHold) >= c.metals && budget.wood >= c.wood;
    };
    // Build order driven by the team's STRATEGY (goal D). `t` carries the
    // per-strategy caps + depot timing. Construction is gated by BOTH a
    // per-building timer (depot 75 s) AND full material delivery, and matches
    // end ~180 s (Buildings.ts:3756) — so a depot placed late can never enable.
    // iter68 over-placed and the glut starved the depot's material delivery;
    // iter69's serial throttle fixed the glut but DELAYED the depot. iter70 fix:
    // keep essentials placing early, gate EXPANSION behind the depot being
    // ENABLED so no expansion glut competes for construction trucks. iter72:
    // `tech_air` rushes the depot at depotFarmReq=1 so its timer finishes in a
    // normal match and the team actually fields tanks / AA / rocket trucks.
    const t = buildTargetsFor(hq.team, s);
    const depotUp = liveDepots.length > 0;
    // Expansion gate. The hold-expansion-until-the-depot-is-enabled rule exists
    // only to protect a RUSHED depot (tech_air, depotFarmReq 1) from being
    // drowned by an expansion glut while its 75 s timer runs. Strategies that
    // DEFER the depot (balanced/econ_boom, depotFarmReq ≥ 2) place it well after
    // the economy is up, so gating their expansion on that late depot just
    // cripples them — iter85 econ_boom stalled at 7 workers / cap 25 because its
    // 2nd-3rd hoods never built until its depot finished at ~218 s. Those teams
    // expand freely (construction-first dispatch still protects the depot). And
    // no-depot strategies (military_rush) always expand freely.
    const rushesDepot = t.depot > 0 && (t.depotFarmReq ?? 2) <= 1;
    const expansionOk = !rushesDepot || depotUp;
    // Hoods that can still grow another house: ENABLED (the sim only accepts an
    // upgrade on an enabled building) and below tier 3 (expand caps at 2 levels
    // = 3 houses). Expanding one adds +5 pop cap. Picking the lowest-tier one
    // tops hoods up evenly; preferring expansion over a brand-new lot keeps the
    // upgrade-delivery truck on a short, defended haul to an existing house
    // rather than a long exposed run to a fresh forward lot (the dump showed
    // forward hoods stalling at hp=0 because their construction trucks were
    // killed mid-haul). With the pop-cap fix in Game.ts the hood keeps counting
    // its current houses while the expand is `pending`, so the cap no longer
    // dips during the upgrade.
    const expandableHoods = anyHoods.filter(b => b.upgradeState === 'enabled' && (b.expandTier ?? 0) < 2);
    const lowestTierExpandable = () => expandableHoods.reduce(
      (lo, b) => ((b.expandTier ?? 0) < (lo.expandTier ?? 0) ? b : lo), expandableHoods[0]);
    const canAffordExpandNow = () => budget.metals >= EXPAND_COST.metals && budget.wood >= EXPAND_COST.wood;
    const canAffordExpandHeld = () => (budget.metals - vehicleHold) >= EXPAND_COST.metals && budget.wood >= EXPAND_COST.wood;
    if (popPressure && h.placeCooldown === 0 && expandableHoods.length > 0 && canAffordExpandNow()) {
      // Pop relief, preferred: expand an existing enabled hood (+5 cap). Cheaper
      // than a fresh lot (25m/50w vs 30m/60w) and safer to deliver. Emergency,
      // so it ignores the vehicle metal hold exactly like the first hood does.
      const tgt = lowestTierExpandable();
      actions.push({ type: 'upgrade_building', buildingId: tgt.id, upgradeId: 'expand' });
      debit(EXPAND_COST);
      h.placeCooldown = 3.0;
    } else if (popPressure && h.placeCooldown === 0 && anyHoods.length < t.hoods && canAffordBldg('neighborhood')) {
      // Emergency: drop another hood when no enabled hood can expand yet
      // (e.g. the only hood is still mid initial-build).
      actions.push({ type: 'place_building', kind: 'neighborhood', anchorHqId: hq.id });
      debit(BUILDING_COSTS.neighborhood);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyBarracks.length === 0 && canAffordBldg('barracks')) {
      // First barracks — the opening.
      actions.push({ type: 'place_building', kind: 'barracks', anchorHqId: hq.id });
      debit(BUILDING_COSTS.barracks);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyFarms.length === 0 && anyBarracks.length > 0 && canAffordBldg('farm')) {
      // First farm — food economy.
      actions.push({ type: 'place_building', kind: 'farm', anchorHqId: hq.id });
      debit(BUILDING_COSTS.farm);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyHoods.length === 0 && anyFarms.length >= 1 && canAffordBldg('neighborhood')) {
      // First neighborhood — unlocks pop cap for the army.
      actions.push({ type: 'place_building', kind: 'neighborhood', anchorHqId: hq.id });
      debit(BUILDING_COSTS.neighborhood);
      h.placeCooldown = 3.0;
    } else if (t.depot > 0 && h.placeCooldown === 0 && anyDepots.length === 0 && anyHoods.length >= 1 && anyFarms.length >= t.depotFarmReq && canAffordBldg('vehicle_depot')) {
      // Vehicle depot — placed at the strategy's depotFarmReq so its 75 s
      // construction timer has time to finish. Tech to advanced units (goal A).
      actions.push({ type: 'place_building', kind: 'vehicle_depot', anchorHqId: hq.id });
      debit(BUILDING_COSTS.vehicle_depot);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyFarms.length < t.farms && canAffordExpansion('farm')) {
      // Remaining farms (held behind the depot via canAffordExpansion's metal
      // reserve so they don't starve a vehicle, but not behind depotUp — food
      // matters for pop).
      actions.push({ type: 'place_building', kind: 'farm', anchorHqId: hq.id });
      debit(BUILDING_COSTS.farm);
      h.placeCooldown = 3.0;
    } else if (expansionOk && h.placeCooldown === 0 && anyBarracks.length < t.barracks && anyFarms.length >= 1 && anyHoods.length >= 1 && canAffordExpansion('barracks')) {
      // Expansion barracks — gated behind the depot being ENABLED (for teching
      // strategies) so it can't glut the construction queue and starve the
      // depot's own material delivery.
      actions.push({ type: 'place_building', kind: 'barracks', anchorHqId: hq.id });
      debit(BUILDING_COSTS.barracks);
      h.placeCooldown = 3.0;
    } else if (expansionOk && h.placeCooldown === 0 && anyHoods.length < t.hoods && anyFarms.length >= 1 && canAffordExpansion('neighborhood')) {
      // Additional neighborhoods — also held behind the depot completing.
      actions.push({ type: 'place_building', kind: 'neighborhood', anchorHqId: hq.id });
      debit(BUILDING_COSTS.neighborhood);
      h.placeCooldown = 3.0;
    } else if (expansionOk && h.placeCooldown === 0 && anyHoods.length >= t.hoods && expandableHoods.length > 0 && anyFarms.length >= 1 && canAffordExpandHeld()) {
      // Proactive expansion: the strategy's hood COUNT is maxed, so the only way
      // to keep raising the pop ceiling is to add houses to existing hoods
      // (toward tier 3). Held behind the same vehicle-metal reserve as other
      // expansion so it never starves a queued tank.
      const tgt = lowestTierExpandable();
      actions.push({ type: 'upgrade_building', buildingId: tgt.id, upgradeId: 'expand' });
      debit(EXPAND_COST);
      h.placeCooldown = 3.0;
    }
    void liveFarms;

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
      // Farmer count scales DOWN as the food bank grows. Food is rarely the
      // binding constraint — farms tick passive income and the pop cap limits
      // how fast units can spend it — so a fat food bank means farmers are
      // wasted labor. iter53-59 showed every AI hoarding 3000-6000 food while
      // metals/wood ran dry and tanks never trained. Drop to 0 farmers when
      // food is abundant and put the WHOLE pool on the metal/wood the build
      // and the army actually need.
      const FARM_FOOD_BUFFER = 600;
      const FARM_FOOD_ABUNDANT = 1500;
      const wantFarm = budget.food > FARM_FOOD_ABUNDANT ? 0
        : budget.food > FARM_FOOD_BUFFER ? 1 : 2;
      // Manage the ENTIRE worker pool, not a hardcoded 6 (the old constant
      // left half a 12-worker team unmanaged on their seed focus — usually
      // farming — which is the other half of the food-overflow bug).
      const totalWorkers = myWorkers.length;
      const otherWorkers = Math.max(0, totalWorkers - wantFarm);
      let wantChop = 0, wantMine = 0;
      if (needWood > 0 && needMetals > 0) {
        wantChop = needWood >= needMetals
          ? Math.ceil(otherWorkers * 0.6)
          : Math.floor(otherWorkers * 0.4);
        wantMine = otherWorkers - wantChop;
      } else if (needWood > 0) {
        wantChop = otherWorkers;
      } else if (needMetals > 0) {
        wantMine = otherWorkers;
      } else {
        // No outstanding BUILDING bill — fund ongoing UNIT production. Combat
        // infantry + tanks are metal-heavy, so weight the pool toward mining
        // with a chop minority for the wood that resupply / repairs consume.
        // Without this branch the focus logic stopped redirecting once the
        // buildings were placed and the seed farmers kept over-producing food.
        wantMine = Math.ceil(otherWorkers * 0.6);
        wantChop = otherWorkers - wantMine;
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
    // Vehicle pop reserve (iter73). A teching strategy WILL want to field a
    // ~5-pop vehicle (tank) once its depot is up, but infantry + workers fill
    // pop to the cap long before the depot enables (~111 s), and live units
    // can't be evicted — so the queued vehicle is permanently pop-blocked
    // (iter72: depot enabled, q=2, but supplied=0 at 24/25 pop). Hold 5 pop
    // open from the START for depot strategies so there's room the moment the
    // depot finishes. Non-teching strategies reserve nothing.
    // Hold one vehicle's worth of pop open for the depot's output. (A larger
    // reserve to field two vehicles, e.g. AA + tank, was trialled in iter87 but
    // reliably spawned the 2nd vehicle into a boxed pad in the compact base and
    // tripped FAILURE_STUCK — that needs a depot-placement clearance fix first.)
    const vehiclePopReserve = t.depot > 0 ? 5 : 0;
    const effTeamPopCap = teamPopCap - vehiclePopReserve;
    // Count in-flight QUEUED units toward pop. Queued units don't occupy pop
    // until they spawn, so without this both HQs (and successive ticks) keep
    // queuing infantry while teamPop still reads below cap — by the time the
    // convoy lands the team is OVER cap (iter73: 34 pop / 30 cap) and the
    // 5-pop vehicle reserve is blown, so a queued tank/AA can never be supplied
    // (popHasRoom fails forever). Charge a conservative 1.5 pop per queued unit
    // so the brain stops short and the reserve actually holds.
    const teamQueuedPop = buildings.reduce(
      (a, b) => (b.team === hq.team && !b.destroyed ? a + (b.trainQueueLen || 0) * 1.5 : a), 0);
    const trainBlocked = (teamPop + teamQueuedPop) >= effTeamPopCap;
    // Tank production first: an HQ kill takes a long time with rifles
    // (~5 DPS each vs. 3000 HP), but a tank shell crushes wall voxels
    // and the +90 score on a tank kill is the biggest single
    // contributor we can earn. Spend metals on tanks before infantry
    // when a depot is online.
    // Vehicle-depot production: rotate through the DEPOT_PRODUCES mix (tank,
    // rocket_truck, aa_vehicle) so the AI fields anti-air + missile launchers,
    // not just tanks. Pick the next affordable kind in the rotation starting
    // at the per-HQ depotPickIndex so the choice cycles instead of always
    // re-queuing the cheapest. iter64: before this the block hard-coded 'tank'
    // and the AI never built aa_vehicle / rocket_truck despite owning a depot.
    if (!trainBlocked && liveDepots.length > 0) {
      const depot = liveDepots.find(b => (b.trainQueueLen ?? 0) < 2);
      if (depot) {
        // Sapper rule: field DIGGER_TARGET tunnelers so the army has a unit
        // that can cut a tunnel straight to the enemy base. Gated AFTER the
        // depot's first rotation vehicle (depotPickIndex > 0) so a team's
        // primary armour/AA still leads, and behind a cooldown + a live-count
        // cap so it builds exactly the target rather than spamming diggers.
        const diggerTarget = t.depot > 0 ? (t.diggers ?? DIGGER_TARGET) : 0;
        const myDiggers = allEnemyUnits.filter(
          u => u && (u.hp ?? 1) > 0 && u.team === hq.team
            && (u.kind === 'tunneler' || u.kind === 'worm')).length;
        const wantDigger = diggerTarget > 0 && h.depotPickIndex > 0
          && myDiggers < diggerTarget && h.diggerCooldown === 0
          && canAffordUnitB('tunneler');
        if (wantDigger) {
          actions.push({ type: 'queue_train', buildingId: depot.id, unitKind: 'tunneler' });
          debit(UNIT_COSTS.tunneler);
          // Hold off re-queuing until this one has had time to build, so a
          // not-yet-spawned tunneler (still 0 in myDiggers) isn't double-ordered.
          h.diggerCooldown = 25.0;
        } else {
          const mix = t.depotMix || DEPOT_PRODUCES;
          for (let i = 0; i < mix.length; i++) {
            const idx = (h.depotPickIndex + i) % mix.length;
            const kind = mix[idx];
            if (!canAffordUnitB(kind)) continue;
            actions.push({ type: 'queue_train', buildingId: depot.id, unitKind: kind });
            debit(UNIT_COSTS[kind]);
            h.depotPickIndex = idx + 1;
            break;
          }
        }
      }
    }
    // Vehicle metal reserve. Depot units cost 80-90 metals; infantry (10-40)
    // drain the pool below that every tick, so before iter61 the depot was
    // built but NO vehicle ever trained (iter53-60: 0 tanks across every
    // dump). When a depot is live and no vehicle is already queued, hold back
    // a vehicle's metals from infantry training so the pool can climb to the
    // vehicle cost — the depot block above then fires and the reserve lifts (a
    // queued vehicle means vehicleQueued=true), letting infantry resume. Net:
    // the team folds vehicles in among its infantry instead of never building
    // armor / AA / rocket trucks.
    let metalReserve = 0;
    if (liveDepots.length > 0) {
      const vehicleQueued = liveDepots.some(b => (b.trainQueueLen ?? 0) > 0);
      if (!vehicleQueued) metalReserve = MAX_DEPOT_METAL;
    }
    // Reserve-aware affordability for INFANTRY only (workers cost 0 metals).
    const canAffordInfantry = (kind) => {
      const c = UNIT_COSTS[kind];
      if (!c) return false;
      return budget.food >= c.food
        && (budget.metals - metalReserve) >= c.metals
        && budget.wood >= c.wood;
    };
    // Worker pump: more workers = faster gather rate = bigger army.
    // Each base seeds 6 workers; train extras from the barracks until
    // we hit WORKER_TARGET per team. Don't share `h.trainCooldown`
    // with the combat queue — workers are tracked on a SEPARATE
    // cadence so the barracks combat rotation isn't blocked.
    // WORKER_TARGET is env-tunable for the tournament.
    //
    // Pop-aware cap: reserve at least 4 pop slots for combat. In the
    // debug.html boot path civilians never spawn (Game.debugMode skips
    // tickCivilians) so popCap stays at the 10-slot base — without
    // this floor the worker queue saturates the cap at 12 workers and
    // every `queue_train` for soldiers/gunners hits trainBlocked, so
    // teams field 0 combat units across a full match (iter14 dump:
    // enemy=12 workers + 0 combat). The 4-slot buffer leaves room for
    // 2 soldiers + 1 gunner (or similar) without starving the
    // gathering economy. WORKER_TARGET remains the hard ceiling for
    // resource-rich runs where popCap is far above 10.
    // Pop-aware cap: reserve at least 4 pop slots for combat (one
    // soldier + one gunner + buffer). In `debug.html` boot the civilian
    // spawner is gated off (`Game.debugMode`) so popCap stays at the
    // 10-slot base — without the floor the worker queue saturates the
    // cap before any combat unit gets a slot, and the brain emits 0
    // combat training all match.
    // Worker ceiling is the smaller of the strategy's worker target and the
    // global env cap, then pop-limited. econ_boom pushes more gatherers;
    // military_rush keeps the count lean so pop goes to infantry.
    const strategyWorkerCap = Math.min(WORKER_TARGET, buildTargetsFor(hq.team, s).workers);
    const effectiveWorkerTarget = Math.min(strategyWorkerCap, Math.max(2, effTeamPopCap - 4));
    // Anticipated team workers must count units in barracks training
    // queues, otherwise both HQs of a multi-HQ team and successive
    // brain ticks both see `myWorkers.length < cap` while the same
    // workers are still pending production — the queues drain and the
    // team ends up with 2× the intended pool (iter21 enemy team: 12
    // workers alive vs. 6-cell intent). Treat every queued slot as a
    // worker; over-counting combat ramps up worker discipline but is
    // fine for the early/economy phase where worker training is the
    // dominant action anyway.
    const teamBarracks = buildings.filter(b => b.team === hq.team && !b.destroyed && b.kind === 'barracks');
    const teamQueueLen = teamBarracks.reduce((acc, b) => acc + (b.trainQueueLen || 0), 0);
    h.workerCooldown = Math.max(0, (h.workerCooldown ?? 0) - dt);
    if (!trainBlocked && h.workerCooldown === 0 && liveBarracks.length > 0
        && (myWorkers.length + teamQueueLen) < effectiveWorkerTarget
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
      // Pick the barracks with the SHORTEST queue and only emit if it
      // still has room. Previously this used `|| liveBarracks[0]` as a
      // fallback, which meant once every barracks hit the cap we kept
      // piling trains onto barracks #0 — driving queue depths into the
      // dozens, none of which ever cleared because production was pop-
      // capped. Hard skip when no barracks has room.
      let target = null;
      let bestLen = Infinity;
      for (const b of liveBarracks) {
        const len = b.trainQueueLen ?? 0;
        if (len >= 4) continue;
        if (len < bestLen) { bestLen = len; target = b; }
      }
      if (target) {
        for (let i = 0; i < BARRACKS_PRODUCES.length; i++) {
          const idx = (h.pickIndex + i) % BARRACKS_PRODUCES.length;
          const kind = BARRACKS_PRODUCES[idx];
          if (!canAffordInfantry(kind)) continue;
          actions.push({ type: 'queue_train', buildingId: target.id, unitKind: kind });
          debit(UNIT_COSTS[kind]);
          h.pickIndex = idx + 1;
          h.trainCooldown = TRAIN_INTERVAL_S;
          break;
        }
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
      const readyAttackersByTeam = {};
      for (const h of hqs) homeHqByTeam[h.team] = h;
      for (const u of enemyUnits) {
        if (!u || u.hp <= 0) continue;
        const hq = homeHqByTeam[u.team];
        if (!hq) continue;
        const dx = u.x - hq.x, dz = u.z - hq.z;
        if (dx * dx + dz * dz <= DEFENDER_RADIUS_M * DEFENDER_RADIUS_M) {
          defendersByTeam[u.team] = (defendersByTeam[u.team] || 0) + 1;
        }
        // "Ready attacker" = armed, no path, no firing target, not at
        // home defender slot. We tally these for wave-timing — only
        // release the attack when the pack reaches WAVE_SIZE.
        if (u.armed && !u.hasFiringTarget && u.pathLen === 0) {
          readyAttackersByTeam[u.team] = (readyAttackersByTeam[u.team] || 0) + 1;
        }
      }
      for (const team of Object.keys(homeHqByTeam)) {
        const teamBldgs = buildings.filter(b => b.team === team && !b.destroyed && b.upgradeState !== 'cancelled');
        const f = teamBldgs.filter(b => b.kind === 'farm').length;
        const h = teamBldgs.filter(b => b.kind === 'neighborhood').length;
        buildoutByTeam[team] = (f >= 2 && h >= 1);
      }
      // Adaptive-stance signal: a team is in "heavy attack" only
      // when 3+ armed enemies are within 40 m of its HQ. A single
      // scout doesn't justify flipping the whole team to defensive
      // — the previous 1-unit threshold caused stalemates (everyone
      // defensive, nobody attacking).
      const heavyAttackByTeam = {};
      const UNDER_ATTACK_R = 40;
      const UA_R2 = UNDER_ATTACK_R * UNDER_ATTACK_R;
      const HEAVY_THRESHOLD = 3;
      for (const team of Object.keys(homeHqByTeam)) {
        const hq = homeHqByTeam[team];
        let near = 0;
        for (const o of enemyUnits) {
          if (!o || o.hp <= 0 || o.team === team || !o.armed) continue;
          const odx = o.x - hq.x, odz = o.z - hq.z;
          if (odx * odx + odz * odz <= UA_R2) {
            near++;
            if (near >= HEAVY_THRESHOLD) { heavyAttackByTeam[team] = true; break; }
          }
        }
      }
      const adaptiveCtx = { buildoutByTeam, heavyAttackByTeam };

      // ---- Force concentration via a single sticky target HQ per team.
      // iter41-47 showed piecemeal trickle across the map is what 3-way
      // midfield attrition feeds on, and iter45's per-home-HQ target
      // scattered multi-HQ teams. iter48-52 added a rally-staging hop, but
      // that proved boom-or-bust: units got pulled into field fights en
      // route to the rally and never assembled, so waves often never
      // committed (iter52: 0 HQ damage). The robust concentration lever is
      // simpler — every released attacker on a team drives at the SAME
      // sticky enemy HQ (nearest live enemy HQ to the team's HQ centroid,
      // re-picked only when it dies). Shared target = damage piles on one
      // structure even when units arrive staggered, without the fragile
      // assembly gamble. The proven wave-release hysteresis (iter39/40
      // HQ_WIN) gates how many leave home at once.
      if (!s.armyTargetByTeam) s.armyTargetByTeam = {};
      if (!s.waveByTeam) s.waveByTeam = {};
      // Sticky single target per team: the whole army drives at ONE enemy
      // HQ (nearest live enemy HQ to the team's HQ centroid), re-picked only
      // when it dies. Shared target = damage piles on one structure; the
      // stickiness avoids the cross-map thrash of per-unit nearest targeting
      // (iter45). A weakest-HQ "snowball" variant was trialled (iter56/57)
      // but did not out-win sticky-nearest (iter53 produced a clean HQ_WIN
      // at 1/3 seeds; snowball 0/2) and needed extra hp plumbing, so the
      // simpler sticky-nearest is kept.
      const teamTarget = {};          // team -> sticky target HQ obj
      for (const team of Object.keys(homeHqByTeam)) {
        let sx = 0, sz = 0, n = 0;
        for (const h of hqs) { if (h.team === team) { sx += h.x; sz += h.z; n++; } }
        if (n === 0) continue;
        const cx = sx / n, cz = sz / n;
        let tgt = null;
        const prevId = s.armyTargetByTeam[team];
        if (prevId != null) {
          tgt = targets.find(b => b && b.alive && b.kind === 'hq' && b.id === prevId && b.team !== team) || null;
        }
        if (!tgt) {
          let best = null, bestD2 = Infinity;
          for (const b of targets) {
            if (!b || !b.alive || b.kind !== 'hq') continue;
            if (b.team && b.team === team) continue;
            const dx = b.x - cx, dz = b.z - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; best = b; }
          }
          tgt = best;
          s.armyTargetByTeam[team] = tgt ? tgt.id : null;
        }
        if (tgt) teamTarget[team] = tgt;
      }

      // Gather-time force-commit (GATHER_MAX_S). Track how long each team has
      // been massing — idle-ready attackers waiting at home but below the
      // WAVE_SIZE release threshold. Once that exceeds GATHER_MAX_S with at
      // least a minimal pack ready, flip the wave to releasing so a team that
      // can never reach WAVE_SIZE still commits instead of holding its army for
      // the entire match. Done once per team, before the per-unit routing loop.
      // Accumulate massing time in SECONDS per attack-cycle (this block runs
      // about once every ATTACK_RETARGET_S of game time). dt-style accumulation
      // — rather than a wall-clock timestamp — keeps it correct under sim
      // fast-forward and matches how the cooldowns above are driven.
      if (!s.massingTimeByTeam) s.massingTimeByTeam = {};
      if (GATHER_MAX_S > 0) {
        for (const team of Object.keys(homeHqByTeam)) {
          const wave = s.waveByTeam[team] || { releasing: false };
          s.waveByTeam[team] = wave;
          const ready = readyAttackersByTeam[team] || 0;
          if (wave.releasing || ready === 0) {
            s.massingTimeByTeam[team] = 0; // committing already, or nobody massing
          } else {
            s.massingTimeByTeam[team] = (s.massingTimeByTeam[team] || 0) + ATTACK_RETARGET_S;
            if (ready >= 2 && s.massingTimeByTeam[team] >= GATHER_MAX_S) {
              wave.releasing = true; // force the stalled pack out
              s.massingTimeByTeam[team] = 0;
              console.log(`[ai-attack] team=${team} force-commit after ~${GATHER_MAX_S}s massing (ready=${ready})`);
            }
          }
        }
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
        const stance = effectiveStance(u.team, adaptiveCtx);
        const quota = stance === 'defensive' ? DEFENDER_QUOTA * 2
          : stance === 'economic' ? DEFENDER_QUOTA
          : Math.min(2, DEFENDER_QUOTA); // aggressive

        const hq = homeHqByTeam[u.team];
        if (hq) {
          const dx = u.x - hq.x, dz = u.z - hq.z;
          const atHome = dx * dx + dz * dz <= DEFENDER_RADIUS_M * DEFENDER_RADIUS_M;
          if (atHome && (defendersByTeam[u.team] || 0) <= quota) {
            // Phase 4 — active defense. Instead of just holding the
            // unit at the HQ, look for an armed enemy within
            // INTERCEPT_RADIUS_M of the HQ. If one is incoming, route
            // the defender to intercept. The defender naturally
            // returns to attacker status next tick (it's no longer
            // "at home" so the quota gate stops applying).
            const INTERCEPT_R = 60;
            const INTERCEPT_R2 = INTERCEPT_R * INTERCEPT_R;
            let closestEnemy = null;
            let closestD2 = Infinity;
            for (const o of enemyUnits) {
              if (!o || o.hp <= 0 || o.team === u.team || !o.armed) continue;
              const odxh = o.x - hq.x, odzh = o.z - hq.z;
              if (odxh * odxh + odzh * odzh > INTERCEPT_R2) continue;
              const odxu = o.x - u.x, odzu = o.z - u.z;
              const d2u = odxu * odxu + odzu * odzu;
              if (d2u < closestD2) { closestD2 = d2u; closestEnemy = o; }
            }
            if (closestEnemy) {
              actions.push({ type: 'route_unit', unitId: u.id, x: closestEnemy.x, z: closestEnemy.z });
              actions.push({ type: 'set_focus_fire', unitId: u.id, targetId: closestEnemy.id });
              routedThisCycle++;
              continue;
            }
            skipDefender++; continue;
          }
        }
        if (stance === 'economic' && !buildoutByTeam[u.team]) {
          skipEconomic++; continue;
        }
        // Wave-release hysteresis (proven iter39/40): hold attackers until
        // WAVE_SIZE are ready, then keep releasing until the ready pool
        // drains below WAVE_SIZE/2, so the team pushes in packs rather than
        // single file.
        const wave = s.waveByTeam[u.team] || { releasing: false };
        s.waveByTeam[u.team] = wave;
        const ready = readyAttackersByTeam[u.team] || 0;
        if (!wave.releasing && ready < WAVE_SIZE) continue; // hold — massing
        wave.releasing = true;
        if (ready <= Math.floor(WAVE_SIZE / 2)) wave.releasing = false;

        // Single sticky target HQ for the whole team (force concentration).
        // Fall back to nearest enemy building only when no enemy HQ is live.
        let bestB = teamTarget[u.team] || null;
        if (!bestB) {
          let fbD2 = Infinity;
          for (const b of targets) {
            if (!b || !b.alive) continue;
            if (b.team && b.team === u.team) continue;
            const dx = b.x - u.x, dz = b.z - u.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < fbD2) { fbD2 = d2; bestB = b; }
          }
        }
        if (!bestB) { skipNoBldg++; continue; }

        // Escort gate: tanks + rocket trucks need ≥2 friendly infantry
        // within 30 m so the soft chassis isn't melted before it cracks a
        // wall.
        if (u.kind === 'tank' || u.kind === 'rocket_truck') {
          let escort = 0;
          const ER2 = 30 * 30;
          for (const o of enemyUnits) {
            if (!o || o.hp <= 0) continue;
            if (o.team !== u.team || o.id === u.id) continue;
            if (o.kind === 'tank' || o.kind === 'rocket_truck') continue;
            if (o.kind === 'worker' || o.kind === 'civilian' || o.kind === 'supply_truck') continue;
            const dx = o.x - u.x, dz = o.z - u.z;
            if (dx * dx + dz * dz <= ER2) escort++;
          }
          if (escort < 2) continue; // hold the tank — infantry not ready
        }
        const range = APPROX_WEAPON_RANGE_M[u.kind] || 18;
        const stopRange = Math.max(1, range * ATTACK_STOP_FRACTION);
        const bdx = bestB.x - u.x, bdz = bestB.z - u.z;
        const bestD2 = bdx * bdx + bdz * bdz;
        const distToTarget = Math.sqrt(bestD2);
        if (distToTarget <= stopRange) { skipInRange++; continue; }
        const scale = (distToTarget - stopRange) / distToTarget;
        // Per-unit jitter so attackers don't stack on one XZ (the
        // post-move separation pass can't disentangle a perfect stack
        // within the harness STUCK budget).
        const jitterRad = 1.5; // ~12 voxels of spread
        const jx = ((u.id * 2654435761) >>> 0) / 0x100000000 * 2 - 1;
        const jz = ((u.id * 40503) >>> 0) / 0x100000000 * 2 - 1;
        const goalX = u.x + (bestB.x - u.x) * scale + jx * jitterRad;
        const goalZ = u.z + (bestB.z - u.z) * scale + jz * jitterRad;
        actions.push({ type: 'route_unit', unitId: u.id, x: goalX, z: goalZ });
        // Squad fire-concentration: pick the highest-threat enemy unit
        // within 25 m as the shared focus target so the massed volley
        // converges instead of dribbling across the defending formation.
        let focusUnit = null;
        let focusBest = -Infinity;
        const FOCUS_R2 = 25 * 25;
        for (const e of enemyUnits) {
          if (!e || e.hp <= 0 || e.team === u.team) continue;
          const dps = UNIT_DPS[e.kind] || 0;
          if (dps <= 0) continue;
          const dx = e.x - u.x, dz = e.z - u.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > FOCUS_R2) continue;
          const score = dps - (e.hp ?? 0) * 0.01;
          if (score > focusBest) { focusBest = score; focusUnit = e; }
        }
        if (focusUnit) {
          actions.push({ type: 'set_focus_fire', unitId: u.id, targetId: focusUnit.id });
        }
        routedThisCycle++;
      }

      // ---- Tunneler / worm siege pass. Diggers carry no weapon, so the
      // armed-attacker loop above skips them (skipUnarmed). They're the team's
      // sappers: route each idle digger straight at the team's sticky target
      // HQ. Game.routePath gives a canDig unit with ground underfoot a direct,
      // terrain-cutting path (no A* detour around the hill), so a single
      // route_unit at the enemy HQ IS a dig order — the tunneler carves a
      // tunnel the rest of the army can follow underground to the base. Drive
      // it all the way onto the HQ (no stop-short) so the breach reaches the
      // structure. Re-issued only when idle (pathLen 0) so it isn't yanked
      // mid-cut; on arrival it re-routes and keeps carving.
      let dugThisCycle = 0;
      for (const u of enemyUnits) {
        if (!u || u.hp <= 0) continue;
        if (u.kind !== 'tunneler' && u.kind !== 'worm') continue;
        if (u.pathLen > 0) continue;
        const tgt = teamTarget[u.team];
        if (!tgt) continue;
        actions.push({ type: 'route_unit', unitId: u.id, x: tgt.x, z: tgt.z });
        routedThisCycle++;
        dugThisCycle++;
      }
      if (dugThisCycle > 0) console.log(`[ai-attack] diggers routed=${dugThisCycle}`);

      // Always log the per-cycle skip breakdown when there are
      // armed-idle units but no routes — that's the signal that
      // something silently dropped them and we need to know which gate.
      if (routedThisCycle > 0 || skipPath > 0 || skipFiring > 0
          || (armedIdle > 0 && routedThisCycle === 0)) {
        console.log(`[ai-attack] skips firing=${skipFiring} path=${skipPath} unarmed=${skipUnarmed} noBldg=${skipNoBldg} inRange=${skipInRange} defender=${skipDefender} economic=${skipEconomic}`);
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
      // Carry the completed expand level so the brain knows when a hood has
      // hit tier 3 and can't expand further (matches the browser path's
      // RemoteAIClient mapping). Without it the engine-bridge brain would keep
      // emitting expand actions the sim rejects on a maxed hood.
      expandTier: (b.upgradeTracks && b.upgradeTracks.expand) || b.expandTier || 0,
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
