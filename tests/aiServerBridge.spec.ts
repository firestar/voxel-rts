import { describe, it, expect, beforeEach } from 'vitest';

// Skip ai-server's `server.listen` + bridge setInterval so the test
// process doesn't get a pinned port + a polling timer underneath us.
process.env.AI_SERVER_TEST = '1';

interface Snapshot {
  tick: number;
  rev: number;
  entities: Array<{ id: number; clientTag: string | null; kind: string; owner: string; x: number; y: number; z: number; hp: number; target: { x: number; z: number } | null; pathLen: number }>;
  buildings: Array<{ id: number; clientTag: string | null; kind: string; owner: string; ox: number; oz: number; floorY: number; cellsW: number; cellsD: number; upgradeState: string; hp: number; maxHp: number; trainQueueLen: number; destroyed: boolean }>;
  resources: Record<string, { food: number; metals: number; wood: number; popCap: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ai = require('../ai-server.cjs') as {
  snapshotToEnemyState: (snap: Snapshot, opts?: { enemyOwner?: string }) => {
    enemyHq: { alive: boolean } | null;
    enemyResources: { food: number; metals: number; wood: number };
    enemyBuildings: Array<{ id: number; kind: string }>;
    enemyUnitCount: number;
    enemyUnits: Array<{ id: number; kind: string; armed: boolean; hasFiringTarget: boolean; pathLen: number }>;
    playerBuildings: Array<{ id: number; alive: boolean; x: number; z: number }>;
  };
  snapshotToCommands: (snap: Snapshot, sessionId: string, opts?: { enemyOwner?: string }) => Array<{
    type: string; id?: number; owner?: string; x?: number; z?: number;
  }>;
  ensureSession: (id: string) => { trainCooldown: number; placeCooldown: number; attackRetargetCooldown: number; perHq?: Map<number, unknown> };
  decideActions: (state: BrainState, sessionId: string) => { actions: BrainAction[] };
};

// Minimal `decideActions` state shape (mirrors RemoteAIClient.snapshot).
interface BrainHq { id: number; team: string; alive: boolean; x: number; z: number; ox?: number; oz?: number; cellsW?: number; cellsD?: number; }
interface BrainBldg { id: number; kind: string; team: string; upgradeState: string; trainQueueLen?: number; anchorHqId?: number | null; x?: number; z?: number; }
interface BrainWorker { id: number; team: string; focus: string; taskKind: string; }
interface BrainState {
  enemyHqs: BrainHq[];
  enemyBuildings: BrainBldg[];
  targetBuildings: Array<{ id: number; kind: string; team: string; x: number; z: number; alive: boolean }>;
  playerBuildings: unknown[];
  enemyUnits: unknown[];
  workers: BrainWorker[];
  enemyResources: { food: number; metals: number; wood: number };
  teamResources: Record<string, { food: number; metals: number; wood: number; popCap: number }>;
  teamPopUsed: Record<string, number>;
  enemyUnitCount: number;
}
interface BrainAction { type: string; workerId?: number; focus?: string; kind?: string; buildingId?: number; unitKind?: string; }

function emptySnapshot(): Snapshot {
  return {
    tick: 0, rev: 0,
    entities: [],
    buildings: [],
    resources: { enemy: { food: 100, metals: 100, wood: 100, popCap: 0 } },
  };
}

function snapshotWithEnemyHq(): Snapshot {
  const snap = emptySnapshot();
  snap.buildings.push({
    id: 1, clientTag: 'hq', kind: 'hq', owner: 'enemy',
    ox: 100, oz: 100, floorY: 0, cellsW: 6, cellsD: 6,
    upgradeState: 'enabled', hp: 1000, maxHp: 1000, trainQueueLen: 0, destroyed: false,
  });
  return snap;
}

describe('ai-server bridge', () => {
  beforeEach(() => {
    // Reset session timers between tests so cooldowns don't leak.
    const s = ai.ensureSession('default');
    s.trainCooldown = 0;
    s.placeCooldown = 0;
    s.attackRetargetCooldown = 0;
  });

  it('snapshotToEnemyState extracts enemy + player buildings', () => {
    const snap = snapshotWithEnemyHq();
    snap.buildings.push({
      id: 2, clientTag: 'p-hq', kind: 'hq', owner: 'p-alice',
      ox: 200, oz: 200, floorY: 0, cellsW: 6, cellsD: 6,
      upgradeState: 'enabled', hp: 1000, maxHp: 1000, trainQueueLen: 0, destroyed: false,
    });
    snap.buildings.push({
      id: 3, clientTag: 'p-bk', kind: 'barracks', owner: 'enemy',
      ox: 110, oz: 110, floorY: 0, cellsW: 4, cellsD: 4,
      upgradeState: 'enabled', hp: 500, maxHp: 500, trainQueueLen: 1, destroyed: false,
    });
    const es = ai.snapshotToEnemyState(snap);
    expect(es.enemyHq).not.toBeNull();
    expect(es.enemyBuildings.length).toBe(2);
    expect(es.enemyBuildings.map(b => b.kind).sort()).toEqual(['barracks', 'hq']);
    expect(es.playerBuildings.length).toBe(1);
    expect(es.playerBuildings[0]!.x).toBeCloseTo(203);
    expect(es.playerBuildings[0]!.z).toBeCloseTo(203);
  });

  it('flags armed-eligible enemy units (combat kinds) and skips civilians', () => {
    const snap = snapshotWithEnemyHq();
    snap.entities.push({
      id: 10, clientTag: 'e-soldier', kind: 'soldier', owner: 'enemy',
      x: 50, y: 6, z: 50, hp: 80, target: null, pathLen: 0,
    });
    snap.entities.push({
      id: 11, clientTag: 'e-civ', kind: 'civilian', owner: 'enemy',
      x: 51, y: 6, z: 51, hp: 35, target: null, pathLen: 0,
    });
    snap.entities.push({
      id: 12, clientTag: 'e-worker', kind: 'worker', owner: 'enemy',
      x: 52, y: 6, z: 52, hp: 50, target: null, pathLen: 0,
    });
    const es = ai.snapshotToEnemyState(snap);
    expect(es.enemyUnits.map(u => u.kind).sort()).toEqual(['soldier', 'worker']);
    const soldier = es.enemyUnits.find(u => u.kind === 'soldier')!;
    expect(soldier.armed).toBe(true);
    const worker = es.enemyUnits.find(u => u.kind === 'worker')!;
    expect(worker.armed).toBe(false);
  });

  it('produces a move_entity command per idle armed enemy near a player building', () => {
    const snap = snapshotWithEnemyHq();
    snap.buildings.push({
      id: 2, clientTag: 'p-hq', kind: 'hq', owner: 'p-alice',
      ox: 200, oz: 200, floorY: 0, cellsW: 6, cellsD: 6,
      upgradeState: 'enabled', hp: 1000, maxHp: 1000, trainQueueLen: 0, destroyed: false,
    });
    snap.entities.push({
      id: 10, clientTag: 'e-soldier', kind: 'soldier', owner: 'enemy',
      x: 110, y: 6, z: 110, hp: 80, target: null, pathLen: 0,
    });
    const cmds = ai.snapshotToCommands(snap, 'default');
    const moves = cmds.filter(c => c.type === 'move_entity');
    expect(moves.length).toBe(1);
    expect(moves[0]!.id).toBe(10);
    expect(moves[0]!.owner).toBe('enemy');
    // Stop-short pulls the goal toward the soldier; both x and z
    // should fall between the soldier and the building centre.
    expect(moves[0]!.x).toBeGreaterThan(110);
    expect(moves[0]!.x).toBeLessThan(203);
    expect(moves[0]!.z).toBeGreaterThan(110);
    expect(moves[0]!.z).toBeLessThan(203);
  });

  it('emits no commands when the enemy hq is missing', () => {
    const snap = emptySnapshot();
    snap.entities.push({
      id: 10, clientTag: 'e-soldier', kind: 'soldier', owner: 'enemy',
      x: 110, y: 6, z: 110, hp: 80, target: null, pathLen: 0,
    });
    expect(ai.snapshotToCommands(snap, 'default').length).toBe(0);
  });

  it('produces a queue_train command for a live enemy barracks', () => {
    const snap = snapshotWithEnemyHq();
    snap.buildings.push({
      id: 3, clientTag: 'e-bk', kind: 'barracks', owner: 'enemy',
      ox: 110, oz: 110, floorY: 0, cellsW: 4, cellsD: 4,
      upgradeState: 'enabled', hp: 500, maxHp: 500, trainQueueLen: 0, destroyed: false,
    });
    // Enemy has the resources to afford the first rotation entry.
    snap.resources.enemy = { food: 200, metals: 200, wood: 200, popCap: 40 };
    const cmds = ai.snapshotToCommands(snap, 'default');
    const trains = cmds.filter(c => c.type === 'queue_train') as Array<{ type: string; id?: number; owner?: string; unitKind?: string }>;
    expect(trains.length).toBe(1);
    expect(trains[0]!.id).toBe(3);
    expect(trains[0]!.owner).toBe('enemy');
    expect(typeof trains[0]!.unitKind).toBe('string');
  });

  it('skips queue_train when the enemy cannot afford any rotation kind', () => {
    const snap = snapshotWithEnemyHq();
    snap.buildings.push({
      id: 3, clientTag: 'e-bk', kind: 'barracks', owner: 'enemy',
      ox: 110, oz: 110, floorY: 0, cellsW: 4, cellsD: 4,
      upgradeState: 'enabled', hp: 500, maxHp: 500, trainQueueLen: 0, destroyed: false,
    });
    snap.resources.enemy = { food: 0, metals: 0, wood: 0, popCap: 40 };
    const cmds = ai.snapshotToCommands(snap, 'default');
    expect(cmds.filter(c => c.type === 'queue_train').length).toBe(0);
  });

  it('emits place_building when the enemy has no barracks yet', () => {
    // Empty enemy base — only the HQ. Brain should issue a barracks
    // place + the queue_train pass should be quiet (no live barracks).
    const snap = snapshotWithEnemyHq();
    snap.resources.enemy = { food: 200, metals: 200, wood: 200, popCap: 40 };
    const cmds = ai.snapshotToCommands(snap, 'default');
    const places = cmds.filter(c => c.type === 'place_building') as Array<{ type: string; owner?: string; kind?: string; clientTag?: string }>;
    expect(places.length).toBe(1);
    expect(places[0]!.owner).toBe('enemy');
    expect(places[0]!.kind).toBe('barracks');
    expect(typeof places[0]!.clientTag).toBe('string');
  });

  it('redirects farmers to mining when food is abundant and metals are dry', () => {
    // A fully-built base (no outstanding building bill) sitting on a huge
    // food bank with empty metals is the iter53-59 failure: the brain used
    // to leave seed farmers over-producing food while the army starved for
    // metals. With the iter60 worker-economy fix, abundant food → 0 farmers
    // and the whole pool funds the metal/wood the army needs.
    const s = ai.ensureSession('focus-test');
    if (s.perHq) s.perHq.clear();
    const team = 'enemy';
    const state: BrainState = {
      enemyHqs: [{ id: 1, team, alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
      enemyBuildings: [
        { id: 1, kind: 'hq', team, upgradeState: 'enabled', anchorHqId: 1 },
        { id: 2, kind: 'barracks', team, upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
        { id: 3, kind: 'barracks', team, upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
        { id: 4, kind: 'barracks', team, upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
        { id: 5, kind: 'farm', team, upgradeState: 'enabled', anchorHqId: 1 },
        { id: 6, kind: 'farm', team, upgradeState: 'enabled', anchorHqId: 1 },
        { id: 7, kind: 'neighborhood', team, upgradeState: 'enabled', anchorHqId: 1 },
        { id: 8, kind: 'neighborhood', team, upgradeState: 'enabled', anchorHqId: 1 },
        { id: 9, kind: 'vehicle_depot', team, upgradeState: 'enabled', anchorHqId: 1 },
      ],
      targetBuildings: [],
      playerBuildings: [],
      enemyUnits: [],
      workers: [
        { id: 101, team, focus: 'farm', taskKind: 'farm' },
        { id: 102, team, focus: 'farm', taskKind: 'farm' },
        { id: 103, team, focus: 'farm', taskKind: 'farm' },
        { id: 104, team, focus: 'farm', taskKind: 'farm' },
        { id: 105, team, focus: 'farm', taskKind: 'farm' },
      ],
      enemyResources: { food: 5000, metals: 0, wood: 0 },
      teamResources: { enemy: { food: 5000, metals: 0, wood: 0, popCap: 30 } },
      teamPopUsed: { enemy: 5 },
      enemyUnitCount: 5,
    };
    const { actions } = ai.decideActions(state, 'focus-test');
    const focusActions = actions.filter(a => a.type === 'set_worker_focus');
    // The brain must redirect the over-farming pool.
    expect(focusActions.length).toBeGreaterThan(0);
    // None should re-assign anyone TO farm (food is abundant → 0 farmers).
    expect(focusActions.every(a => a.focus !== 'farm')).toBe(true);
    // At least one farmer goes to mining (metals are the dry resource the
    // army needs).
    expect(focusActions.some(a => a.focus === 'mine')).toBe(true);
  });

  it('reserves metals for a tank when a depot is live (no infantry starving the armor)', () => {
    // Depot built, no tank queued, metals below the 80 a tank needs but above
    // infantry costs. Before iter61 the brain spent those metals on infantry
    // every tick so the pool never reached 80 and 0 tanks ever built (iter53-60).
    // Now the tank's metals are reserved: no combat unit queues until either the
    // pool climbs to 80 (tank) or the reserve lifts.
    const mkState = (metals: number): BrainState => ({
      enemyHqs: [{ id: 1, team: 'enemy', alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
      enemyBuildings: [
        { id: 1, kind: 'hq', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1 },
        { id: 2, kind: 'barracks', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
        { id: 9, kind: 'vehicle_depot', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
      ],
      targetBuildings: [], playerBuildings: [], enemyUnits: [],
      // Workers at the cap so the worker pump doesn't queue anything.
      workers: Array.from({ length: 12 }, (_, i) => ({ id: 200 + i, team: 'enemy', focus: 'mine', taskKind: 'mine' })),
      enemyResources: { food: 500, metals, wood: 500 },
      teamResources: { enemy: { food: 500, metals, wood: 500, popCap: 40 } },
      teamPopUsed: { enemy: 12 },
      enemyUnitCount: 12,
    });
    // Below tank cost: reserve blocks infantry AND tank can't afford → no combat queue.
    {
      const s = ai.ensureSession('reserve-a'); if (s.perHq) s.perHq.clear();
      const { actions } = ai.decideActions(mkState(50), 'reserve-a');
      const trains = actions.filter(a => a.type === 'queue_train' && a.unitKind !== 'worker');
      expect(trains.length).toBe(0);
    }
    // At tank cost: the tank queues (armor finally gets built).
    {
      const s = ai.ensureSession('reserve-b'); if (s.perHq) s.perHq.clear();
      const { actions } = ai.decideActions(mkState(80), 'reserve-b');
      const tankTrains = actions.filter(a => a.type === 'queue_train' && a.unitKind === 'tank');
      expect(tankTrains.length).toBe(1);
    }
  });

  it('fields advanced vehicle-depot units (tank, rocket_truck, aa_vehicle) once teched up', () => {
    // A teched-up base (depot + barracks live) with metals to spare must
    // rotate the depot through ALL three vehicle kinds, not tank-spam. Before
    // iter64 the depot block hard-coded 'tank' and the AI never built anti-air
    // or missile launchers despite owning the producer.
    const s = ai.ensureSession('depot-rot'); if (s.perHq) s.perHq.clear();
    const mkState = (): BrainState => ({
      enemyHqs: [{ id: 1, team: 'enemy', alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
      enemyBuildings: [
        { id: 1, kind: 'hq', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1 },
        { id: 2, kind: 'barracks', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
        { id: 9, kind: 'vehicle_depot', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
      ],
      targetBuildings: [], playerBuildings: [], enemyUnits: [],
      workers: Array.from({ length: 12 }, (_, i) => ({ id: 200 + i, team: 'enemy', focus: 'mine', taskKind: 'mine' })),
      enemyResources: { food: 2000, metals: 3000, wood: 2000 },
      teamResources: { enemy: { food: 2000, metals: 3000, wood: 2000, popCap: 60 } },
      teamPopUsed: { enemy: 12 },
      enemyUnitCount: 12,
    });
    // Drive several brain cycles; the depot fixture keeps trainQueueLen at 0
    // (we don't simulate production) so each cycle queues one depot unit and
    // the per-HQ rotation index advances. Collect the depot's unit kinds.
    const depotKinds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { actions } = ai.decideActions(mkState(), 'depot-rot');
      for (const a of actions) {
        if (a.type === 'queue_train' && a.buildingId === 9 && a.unitKind) depotKinds.add(a.unitKind);
      }
    }
    expect(depotKinds.has('tank')).toBe(true);
    expect(depotKinds.has('rocket_truck')).toBe(true);
    expect(depotKinds.has('aa_vehicle')).toBe(true);
  });

  it('skips a unit that already has a path / firing target', () => {
    const snap = snapshotWithEnemyHq();
    snap.buildings.push({
      id: 2, clientTag: 'p-hq', kind: 'hq', owner: 'p-alice',
      ox: 200, oz: 200, floorY: 0, cellsW: 6, cellsD: 6,
      upgradeState: 'enabled', hp: 1000, maxHp: 1000, trainQueueLen: 0, destroyed: false,
    });
    // pathLen > 0 → already routed.
    snap.entities.push({
      id: 10, clientTag: 'e-busy', kind: 'soldier', owner: 'enemy',
      x: 110, y: 6, z: 110, hp: 80, target: { x: 200, z: 200 }, pathLen: 4,
    });
    const cmds = ai.snapshotToCommands(snap, 'default');
    expect(cmds.filter(c => c.type === 'move_entity').length).toBe(0);
  });
});
