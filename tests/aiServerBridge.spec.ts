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
  ensureSession: (id: string) => { trainCooldown: number; placeCooldown: number; attackRetargetCooldown: number };
};

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
