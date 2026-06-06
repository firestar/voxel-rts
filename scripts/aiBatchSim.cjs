// Fast headless AI-vs-AI batch simulator.
//
// The full game's authoritative sim lives in the browser (Game.ts), so real
// matches need Chromium + the server stack and run ~realtime (minutes each) —
// impractical for hundreds of games. This is an ABSTRACTED model that runs the
// REAL brain (ai-server.cjs `decideActions`) on both teams over a simplified
// economy + lane-combat sim, so we can run many games in seconds to surface
// stalls (army never commits, economy never tech) and compare AI variants.
//
// Fidelity caveats: no terrain / pathfinding / projectiles / FoW. Combat is a
// nearest-enemy-in-range DPS exchange along a single lane; pop cap comes from
// neighborhoods directly (no civilian model). It captures build-order timing,
// pop scaling, wave/attrition dynamics and HQ demolition — NOT map geometry.
//
// Usage: node scripts/aiBatchSim.cjs [games]
//   GAMES env or argv[2] = number of games (default 50)
//   AI_* env vars pass through to the brain (e.g. AI_GATHER_MAX_S=0 to ablate).

// Import the brain as a library — AI_SERVER_TEST stops ai-server.cjs from
// binding its HTTP port (3030) so the sim is a pure in-process consumer.
process.env.AI_SERVER_TEST = '1';
const ai = require('../ai-server.cjs');

const GAMES = Number(process.env.GAMES || process.argv[2] || 50);
const AI_TICK_S = 1.0;          // brain pulse cadence (matches the real client)
const DT = 0.2;                 // sim step
const MAX_SIM_S = Number(process.env.MAX_SIM_S || 600);
const HQ_HP = 2000;
const LANE = { ax: 20, bx: 360, z: 100 }; // team A HQ at x=20, team B at x=360

// ---- unit stats (hp, dps, range m, speed m/s). hqDps defaults to dps; diggers
// carve the HQ but don't fight units. Mirrors the brain's UNIT_DPS ordering.
const U = {
  soldier:        { hp: 100, dps: 12, range: 18, speed: 4.0 },
  gunner:         { hp: 90,  dps: 20, range: 16, speed: 4.0 },
  rocket_soldier: { hp: 90,  dps: 22, range: 22, speed: 3.6 },
  mortar_soldier: { hp: 80,  dps: 18, range: 28, speed: 3.4 },
  sniper:         { hp: 70,  dps: 25, range: 32, speed: 3.6 },
  tank:           { hp: 420, dps: 60, range: 24, speed: 5.0 },
  rocket_truck:   { hp: 240, dps: 45, range: 30, speed: 5.0 },
  aa_vehicle:     { hp: 240, dps: 8,  range: 30, speed: 5.0 },
  tunneler:       { hp: 150, dps: 0,  range: 0,  speed: 2.0, hqDps: 40 },
  worm:           { hp: 120, dps: 0,  range: 0,  speed: 3.0, hqDps: 30 },
  worker:         { hp: 60,  dps: 0,  range: 0,  speed: 3.0 },
};
const COMBAT = new Set(['soldier', 'gunner', 'rocket_soldier', 'mortar_soldier', 'sniper', 'tank', 'rocket_truck', 'aa_vehicle']);

const BCOST = { barracks: { m: 40, w: 40 }, vehicle_depot: { m: 70, w: 50 }, farm: { m: 20, w: 30 }, neighborhood: { m: 30, w: 60 } };
const EXPAND_COST = { m: 25, w: 50 };
const UCOST = {
  soldier: { f: 40, m: 10, w: 10 }, gunner: { f: 60, m: 30, w: 0 }, rocket_soldier: { f: 60, m: 40, w: 0 },
  mortar_soldier: { f: 60, m: 35, w: 5 }, sniper: { f: 50, m: 20, w: 0 }, tank: { f: 20, m: 80, w: 0 },
  rocket_truck: { f: 20, m: 80, w: 0 }, aa_vehicle: { f: 20, m: 90, w: 0 }, worker: { f: 30, m: 0, w: 10 },
  tunneler: { f: 20, m: 120, w: 0 }, worm: { f: 20, m: 100, w: 0 },
};
const BUILD_TIME = { barracks: 25, vehicle_depot: 60, farm: 15, neighborhood: 30, storage: 15 };
const TRAIN_TIME = (k) => (k === 'worker' ? 3 : (k === 'tank' || k === 'rocket_truck' || k === 'aa_vehicle' || k === 'tunneler' || k === 'worm') ? 7 : 4);
const METAL_RATE = 2.6, WOOD_RATE = 2.1, FOOD_RATE = 8; // per worker / second

let nextId = 1;

function newMatch(seed) {
  const mk = (team, hx) => ({
    team, hx, hz: LANE.z, hqHp: HQ_HP, hqDead: false,
    res: { food: 200, metals: 55, wood: 45 },
    buildings: [
      { id: nextId++, kind: 'hq', team, x: hx, z: LANE.z, upgradeState: 'enabled', queue: [], trainT: 0, expandTier: 0, expandT: 0 },
      { id: nextId++, kind: 'storage', team, x: hx + (hx < 180 ? 8 : -8), z: LANE.z, upgradeState: 'enabled', queue: [], trainT: 0, expandTier: 0 },
    ],
    pendingT: new Map(),  // building id -> remaining construction seconds
    workers: Array.from({ length: 6 }, (_, i) => ({ id: nextId++, team, focus: i < 2 ? 'mine' : i < 4 ? 'chop' : 'farm', taskKind: 'idle' })),
    units: [],            // combat + diggers
  });
  return {
    seed, t: 0, aiAccum: 0, sessionId: `sim-${seed}-${Math.random().toString(36).slice(2, 7)}`,
    teams: { enemy: mk('enemy', LANE.ax), enemy2: mk('enemy2', LANE.bx) },
  };
}

function popCap(tm) {
  let cap = 0;
  for (const b of tm.buildings) {
    if (b.upgradeState !== 'enabled') continue;
    if (b.kind === 'hq') cap += 10;
    else if (b.kind === 'neighborhood') cap += 5 * (1 + (b.expandTier || 0));
  }
  return cap;
}
function popUsed(tm) { return tm.workers.length + tm.units.length; }

function snapshot(m) {
  const enemyHqs = [], enemyBuildings = [], enemyUnits = [], workers = [], targetBuildings = [];
  const teamResources = {}, teamPopUsed = {};
  for (const key of ['enemy', 'enemy2']) {
    const tm = m.teams[key];
    teamResources[key] = { food: tm.res.food | 0, metals: tm.res.metals | 0, wood: tm.res.wood | 0, popCap: popCap(tm) };
    teamPopUsed[key] = popUsed(tm);
    for (const b of tm.buildings) {
      if (b.kind === 'hq' && !tm.hqDead) {
        enemyHqs.push({ id: b.id, team: key, alive: true, x: b.x, z: b.z, ox: b.x, oz: b.z, cellsW: 6, cellsD: 5 });
      }
      const hqId = tm.buildings.find(x => x.kind === 'hq').id;
      enemyBuildings.push({ id: b.id, kind: b.kind, team: key, upgradeState: b.upgradeState, trainQueueLen: b.queue.length, anchorHqId: hqId, x: b.x, z: b.z, expandTier: b.expandTier || 0 });
      if ((b.kind === 'hq' && !tm.hqDead)) targetBuildings.push({ id: b.id, kind: 'hq', team: key, x: b.x, z: b.z, alive: true });
    }
    for (const w of tm.workers) workers.push({ id: w.id, team: key, focus: w.focus, taskKind: w.taskKind });
    for (const u of tm.units) {
      const s = U[u.kind];
      enemyUnits.push({ id: u.id, kind: u.kind, team: key, x: u.x, z: u.z, hp: u.hp, armed: (s.dps || 0) > 0, hasFiringTarget: !!u.firing, pathLen: u.goal ? 1 : 0 });
    }
  }
  return {
    enemyHqs, enemyBuildings, enemyUnits, workers, targetBuildings, playerBuildings: [],
    enemyResources: teamResources.enemy, teamResources, teamPopUsed, enemyUnitCount: enemyUnits.length,
  };
}

function teamOf(m, key) { return m.teams[key]; }
function bldgById(m, id) { for (const k of ['enemy', 'enemy2']) { const b = m.teams[k].buildings.find(x => x.id === id); if (b) return { tm: m.teams[k], b }; } return null; }

function applyActions(m, actions) {
  for (const a of actions) {
    if (!a || !a.type) continue;
    if (a.type === 'place_building') {
      const tm = teamOf(m, m.teams.enemy.buildings.some(b => b.id === a.anchorHqId) ? 'enemy' : 'enemy2');
      const c = BCOST[a.kind]; if (!c) continue;
      if (tm.res.metals < c.m || tm.res.wood < c.w) continue;
      tm.res.metals -= c.m; tm.res.wood -= c.w;
      const hq = tm.buildings.find(x => x.kind === 'hq');
      const dir = hq.x < 180 ? 1 : -1;
      const id = nextId++;
      tm.buildings.push({ id, kind: a.kind, team: hq.team, x: hq.x + dir * (12 + tm.buildings.length), z: LANE.z, upgradeState: 'pending', queue: [], trainT: 0, expandTier: 0, expandT: 0 });
      tm.pendingT.set(id, BUILD_TIME[a.kind] || 20);
    } else if (a.type === 'queue_train') {
      const hit = bldgById(m, a.buildingId); if (!hit) continue;
      const { tm, b } = hit; const c = UCOST[a.unitKind]; if (!c) continue;
      if (b.upgradeState !== 'enabled') continue;
      if (tm.res.food < c.f || tm.res.metals < c.m || tm.res.wood < c.w) continue;
      tm.res.food -= c.f; tm.res.metals -= c.m; tm.res.wood -= c.w;
      b.queue.push(a.unitKind);
    } else if (a.type === 'upgrade_building') {
      const hit = bldgById(m, a.buildingId); if (!hit) continue;
      const { tm, b } = hit;
      if (b.kind !== 'neighborhood' || b.upgradeState !== 'enabled' || (b.expandTier || 0) >= 2) continue;
      if (tm.res.metals < EXPAND_COST.m || tm.res.wood < EXPAND_COST.w) continue;
      tm.res.metals -= EXPAND_COST.m; tm.res.wood -= EXPAND_COST.w;
      b.upgradeState = 'pending'; b.expandT = 20;
    } else if (a.type === 'set_worker_focus') {
      for (const k of ['enemy', 'enemy2']) { const w = m.teams[k].workers.find(x => x.id === a.workerId); if (w) { w.focus = a.focus; break; } }
    } else if (a.type === 'route_unit') {
      for (const k of ['enemy', 'enemy2']) { const u = m.teams[k].units.find(x => x.id === a.unitId); if (u) { u.goal = { x: a.x, z: a.z }; break; } }
    } else if (a.type === 'set_focus_fire') {
      // honored implicitly by nearest-target combat
    }
  }
}

function stepEconomy(m, dt) {
  for (const key of ['enemy', 'enemy2']) {
    const tm = m.teams[key]; if (tm.hqDead) continue;
    // income
    let miners = 0, choppers = 0, farmers = 0;
    for (const w of tm.workers) { if (w.focus === 'mine' || w.focus === 'auto') miners++; else if (w.focus === 'chop') choppers++; else if (w.focus === 'farm') farmers++; }
    const farms = tm.buildings.filter(b => b.kind === 'farm' && b.upgradeState === 'enabled').length;
    tm.res.metals += miners * METAL_RATE * dt;
    tm.res.wood += choppers * WOOD_RATE * dt;
    tm.res.food += Math.min(farmers, Math.max(1, farms * 2)) * FOOD_RATE * dt;
    // construction
    for (const [id, rem] of [...tm.pendingT]) {
      const nrem = rem - dt;
      if (nrem <= 0) { tm.pendingT.delete(id); const b = tm.buildings.find(x => x.id === id); if (b) b.upgradeState = 'enabled'; }
      else tm.pendingT.set(id, nrem);
    }
    // expands
    for (const b of tm.buildings) {
      if (b.upgradeState === 'pending' && b.expandT > 0) {
        b.expandT -= dt; if (b.expandT <= 0) { b.upgradeState = 'enabled'; b.expandTier = (b.expandTier || 0) + 1; }
      }
    }
    // training
    const cap = popCap(tm);
    for (const b of tm.buildings) {
      if (b.upgradeState !== 'enabled' || b.queue.length === 0) continue;
      if (b.kind !== 'barracks' && b.kind !== 'vehicle_depot') continue;
      b.trainT += dt;
      const kind = b.queue[0];
      if (b.trainT >= TRAIN_TIME(kind)) {
        if (popUsed(tm) >= cap) { b.trainT = TRAIN_TIME(kind); continue; } // pop-blocked, hold
        b.trainT = 0; b.queue.shift();
        if (kind === 'worker') tm.workers.push({ id: nextId++, team: key, focus: 'auto', taskKind: 'idle' });
        else { const hq = tm.buildings.find(x => x.kind === 'hq'); tm.units.push({ id: nextId++, team: key, kind, hp: U[kind].hp, x: hq.x + (hq.x < 180 ? 6 : -6), z: LANE.z, goal: null, firing: false }); }
      }
    }
  }
}

function stepCombat(m, dt) {
  const all = [];
  for (const k of ['enemy', 'enemy2']) for (const u of m.teams[k].units) all.push(u);
  // move
  for (const u of all) {
    u.firing = false;
    if (u.goal) {
      const dx = u.goal.x - u.x, dz = u.goal.z - u.z; const d = Math.hypot(dx, dz);
      const sp = U[u.kind].speed * dt;
      if (d <= sp || d < 1.5) { u.x = u.goal.x; u.z = u.goal.z; u.goal = null; }
      else { u.x += dx / d * sp; u.z += dz / d * sp; }
    }
  }
  // A digger is "underground" (immune to surface fire) while still in transit —
  // i.e. not yet surfaced at an enemy HQ to carve. This models the real game's
  // tunneler, whose whole purpose is to bypass the frontline. Without it the
  // sim shoots tunnelers in the open and they never reach the objective.
  const undergroundDigger = (o) => {
    if (o.kind !== 'tunneler' && o.kind !== 'worm') return false;
    for (const k of ['enemy', 'enemy2']) {
      const tm = m.teams[k]; if (k === o.team || tm.hqDead) continue;
      if (Math.hypot(tm.hx - o.x, tm.hz - o.z) <= 14) return false; // surfaced at the HQ
    }
    return true;
  };
  // fire at nearest enemy unit in range
  for (const u of all) {
    const s = U[u.kind]; if ((s.dps || 0) <= 0 || s.range <= 0) continue;
    let best = null, bd = Infinity;
    for (const o of all) {
      if (o.team === u.team || o.hp <= 0 || undergroundDigger(o)) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d <= s.range && d < bd) { bd = d; best = o; }
    }
    if (best) { best.hp -= s.dps * dt; u.firing = true; }
  }
  // damage enemy HQ when in range
  for (const u of all) {
    const s = U[u.kind]; const hqDps = s.hqDps != null ? s.hqDps : s.dps;
    if (!hqDps) continue;
    for (const k of ['enemy', 'enemy2']) {
      const tm = m.teams[k]; if (k === u.team || tm.hqDead) continue;
      const reach = Math.max(s.range, 4);
      if (Math.hypot(tm.hx - u.x, tm.hz - u.z) <= reach) { tm.hqHp -= hqDps * dt; u.firing = true; }
    }
  }
  // cull dead units + mark dead HQs
  for (const k of ['enemy', 'enemy2']) {
    const tm = m.teams[k];
    tm.units = tm.units.filter(u => u.hp > 0);
    if (!tm.hqDead && tm.hqHp <= 0) { tm.hqDead = true; const hq = tm.buildings.find(x => x.kind === 'hq'); if (hq) hq.upgradeState = 'cancelled'; }
  }
}

function winner(m) {
  const aDead = m.teams.enemy.hqDead, bDead = m.teams.enemy2.hqDead;
  if (aDead && bDead) return { over: true, winner: null };
  if (aDead) return { over: true, winner: 'enemy2' };
  if (bDead) return { over: true, winner: 'enemy' };
  return { over: false };
}

function runGame(seed) {
  const m = newMatch(seed);
  // prime the session so strategies get assigned
  ai.ensureSession(m.sessionId);
  let peakArmy = { enemy: 0, enemy2: 0 }, builtDepot = { enemy: false, enemy2: false }, builtTunneler = { enemy: false, enemy2: false };
  let minHqHp = { enemy: HQ_HP, enemy2: HQ_HP };
  while (m.t < MAX_SIM_S) {
    m.aiAccum += DT;
    if (m.aiAccum >= AI_TICK_S) {
      m.aiAccum = 0;
      const s = ai.ensureSession(m.sessionId);
      s.lastTickAt = Date.now() - Math.round(AI_TICK_S * 1000); // force dt≈AI_TICK_S
      const { actions } = ai.decideActions(snapshot(m), m.sessionId);
      applyActions(m, actions);
    }
    stepEconomy(m, DT);
    stepCombat(m, DT);
    for (const k of ['enemy', 'enemy2']) {
      peakArmy[k] = Math.max(peakArmy[k], m.teams[k].units.filter(u => COMBAT.has(u.kind)).length);
      if (m.teams[k].buildings.some(b => b.kind === 'vehicle_depot' && b.upgradeState === 'enabled')) builtDepot[k] = true;
      if (m.teams[k].units.some(u => u.kind === 'tunneler' || u.kind === 'worm')) builtTunneler[k] = true;
      minHqHp[k] = Math.min(minHqHp[k], m.teams[k].hqHp);
    }
    m.t += DT;
    const w = winner(m);
    if (w.over) {
      const s = ai.ensureSession(m.sessionId);
      return { seed, winner: w.winner, durationS: +m.t.toFixed(0), reason: w.winner ? 'hq-destroyed' : 'mutual', strategies: s.strategies || {}, peakArmy, builtDepot, builtTunneler, minHqHp };
    }
  }
  const s = ai.ensureSession(m.sessionId);
  return { seed, winner: null, durationS: MAX_SIM_S, reason: 'timeout', strategies: s.strategies || {}, peakArmy, builtDepot, builtTunneler, minHqHp };
}

function main() {
  // The brain logs heavily ([ai-attack], [AI-PLACE], …). Silence stdout while
  // simulating so hundreds of games stay fast + quiet; restore for the report.
  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  const realWrite = process.stderr.write.bind(process.stderr);
  console.log = console.warn = console.error = () => {};
  process.stderr.write = () => true;
  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < GAMES; i++) results.push(runGame(1000 + i));
  const ms = Date.now() - t0;
  console.log = realLog; console.warn = realWarn; console.error = realErr;
  process.stderr.write = realWrite;
  const decisive = results.filter(r => r.reason === 'hq-destroyed').length;
  const timeouts = results.filter(r => r.reason === 'timeout').length;
  const mutual = results.filter(r => r.reason === 'mutual').length;
  const avgDur = (results.reduce((a, r) => a + r.durationS, 0) / results.length).toFixed(0);
  const depotRate = results.filter(r => r.builtDepot.enemy || r.builtDepot.enemy2).length / results.length;
  const tunnelerRate = results.filter(r => r.builtTunneler.enemy || r.builtTunneler.enemy2).length / results.length;
  // win-rate by strategy
  const stratGames = {}, stratWins = {};
  for (const r of results) {
    for (const team of ['enemy', 'enemy2']) {
      const st = r.strategies[team] || '?';
      stratGames[st] = (stratGames[st] || 0) + 1;
      if (r.winner === team) stratWins[st] = (stratWins[st] || 0) + 1;
    }
  }
  console.log(`\n=== ${GAMES} games in ${ms}ms (${(ms / GAMES).toFixed(0)}ms/game) | AI_GATHER_MAX_S=${process.env.AI_GATHER_MAX_S ?? '30(default)'} ===`);
  console.log(`decisive(HQ kill)=${decisive} (${(decisive / GAMES * 100).toFixed(0)}%)  timeout=${timeouts} (${(timeouts / GAMES * 100).toFixed(0)}%)  mutual=${mutual}`);
  console.log(`avg duration=${avgDur}s  depot-built rate=${(depotRate * 100).toFixed(0)}%  tunneler-built rate=${(tunnelerRate * 100).toFixed(0)}%`);
  // Stalemate diagnosis: in timeout games, how close did the most-damaged HQ
  // come to dying, and how big were the armies? Tells us whether attacks never
  // reach the HQ (min-hp near full) vs reach but can't finish (min-hp low).
  const tos = results.filter(r => r.reason === 'timeout');
  if (tos.length) {
    const avgMinHq = (tos.reduce((a, r) => a + Math.min(r.minHqHp.enemy, r.minHqHp.enemy2), 0) / tos.length).toFixed(0);
    const avgPeak = (tos.reduce((a, r) => a + Math.max(r.peakArmy.enemy, r.peakArmy.enemy2), 0) / tos.length).toFixed(1);
    console.log(`timeouts: avg most-damaged HQ hp=${avgMinHq}/${HQ_HP} (lower=attacks landed)  avg peak army=${avgPeak}`);
  }
  console.log('win rate by strategy:');
  for (const st of Object.keys(stratGames).sort()) {
    console.log(`  ${st.padEnd(14)} ${stratWins[st] || 0}/${stratGames[st]} (${(((stratWins[st] || 0) / stratGames[st]) * 100).toFixed(0)}%)`);
  }
}

main();
