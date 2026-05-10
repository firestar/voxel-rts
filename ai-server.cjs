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

const TRAIN_INTERVAL_S = 0.50;
// Counts ALL non-player units (workers + combat across both AI
// factions). 200 leaves plenty of headroom — even at full barracks
// throughput (5 buildings × 0.5 units/s = 2.5/s) the cap holds ~80 s
// of continuous production, so the harness's drought rule almost
// never trips for "nothing produced this second".
const MAX_FIELDED_ENEMIES = 200;
/** AUTO_ENGAGE_STOP_FRACTION mirrored from the client. The hunt-and-attack
 *  pass routes idle enemies toward player buildings and stops short at
 *  this fraction of the unit's weapon range so the projectile arc check
 *  has room to succeed. */
// Was 0.65. Lowered to 0.45 so attacking units crowd in closer
// to enemy HQs — more units inside LOS distance = more shots
// landing per second = HQ HP comes down before drought triggers.
const ATTACK_STOP_FRACTION = 0.45;
/** Throttle hunt-and-attack so we don't slam the path worker. The
 *  client routes a unit and the path takes a beat to resolve; rerouting
 *  every 1 s is wasteful. */
const ATTACK_RETARGET_S = 1.75;

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
function decideActions(state, sessionId) {
  const s = ensureSession(sessionId);
  const now = Date.now();
  const dt = Math.max(0, Math.min(2.0, (now - s.lastTickAt) / 1000));
  s.lastTickAt = now;
  const actions = [];

  if (!state) return { actions };
  // Multi-HQ aware: every enemy HQ runs its own per-base brain so
  // multiple AI players each build their own barracks + farms.
  // Resources are shared across all enemy bases (single Resources
  // pool on the client) but each base independently decides whether
  // to spend on its next placement.
  const hqs = Array.isArray(state.enemyHqs) && state.enemyHqs.length > 0
    ? state.enemyHqs
    : (state.enemyHq && state.enemyHq.alive ? [state.enemyHq] : []);
  if (hqs.length === 0) return { actions };
  const buildings = Array.isArray(state.enemyBuildings) ? state.enemyBuildings : [];
  const res = state.enemyResources || { food: 0, metals: 0, wood: 0 };

  // Track shared resources across the per-HQ loop so two AIs don't
  // try to place a barracks at the same instant when only one
  // affordable bundle is on the table.
  const budget = { food: res.food, metals: res.metals, wood: res.wood };
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

    // Build order: 1 barracks → 2 farms → more barracks.
    // Putting farms before scaling barracks keeps the food economy
    // alive — the AI's seeded metals/wood bank only covers ~5
    // buildings total, so spending all of it on barracks first
    // leaves nothing for farms and the AI starves the moment its
    // food bank empties.
    const wantMoreBarracks = (anyBarracks.length === 0 && anyFarms.length === 0)
                          || (anyBarracks.length < 3 && anyFarms.length >= 2);
    if (h.placeCooldown === 0 && wantMoreBarracks && canAffordBldg('barracks')) {
      actions.push({ type: 'place_building', kind: 'barracks', anchorHqId: hq.id });
      debit(BUILDING_COSTS.barracks);
      h.placeCooldown = 3.0;
    } else if (h.placeCooldown === 0 && anyFarms.length < 2 && anyBarracks.length > 0 && canAffordBldg('farm')) {
      actions.push({ type: 'place_building', kind: 'farm', anchorHqId: hq.id });
      debit(BUILDING_COSTS.farm);
      // Re-arm in 3 s. If the place_building action succeeded, the
      // building condition (anyBarracks.length === 0 / anyFarms.length < 2)
      // turns false on the next pass and we skip the place. If it
      // failed (footprint invalid, resources stolen by another HQ
      // mid-frame), we retry. Setting NaN here used to leave the AI
      // stuck waiting forever on a placement that never landed.
      h.placeCooldown = 3.0;
    }
    void liveFarms;

    if (h.trainCooldown === 0 && state.enemyUnitCount < MAX_FIELDED_ENEMIES && liveBarracks.length > 0) {
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
      let skipFiring = 0, skipPath = 0, skipUnarmed = 0, skipNoBldg = 0, skipInRange = 0;
      for (const u of enemyUnits) {
        if (!u || u.hp <= 0) continue;
        if (!u.armed) { skipUnarmed++; continue; }
        if (u.hasFiringTarget) { skipFiring++; continue; }
        if (u.pathLen > 0) { skipPath++; continue; }
        // Prefer enemy HQs over other buildings — destroying an HQ
        // ends the game (HQ_WIN), so concentrating fire on HQ kinds
        // accelerates the win condition. Only fall back to "nearest
        // anything" when no enemy HQ is in sight.
        let bestB = null;
        let bestD2 = Infinity;
        for (const b of targets) {
          if (!b || !b.alive) continue;
          if (b.team && b.team === u.team) continue;
          if (b.kind !== 'hq') continue;
          const dx = b.x - u.x, dz = b.z - u.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; bestB = b; }
        }
        if (!bestB) {
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
        const distToTarget = Math.sqrt(bestD2);
        if (distToTarget <= stopRange) { skipInRange++; continue; }
        const scale = (distToTarget - stopRange) / distToTarget;
        const goalX = u.x + (bestB.x - u.x) * scale;
        const goalZ = u.z + (bestB.z - u.z) * scale;
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
