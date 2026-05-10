import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface Entity { id: number; clientTag: string | null; kind: string; owner: string; x: number; y: number; z: number; hp: number; target: unknown; pathLen: number }
interface Building { id: number; kind: string; owner: string; ox: number; oz: number; cellsW: number; cellsD: number }

interface ServerStateShape {
  tick: number;
  entities: Map<number, { id: number; kind: string; owner: string; x: number; y: number; z: number; hp: number; path: unknown[]; target: unknown; clientTag: string | null }>;
  byTag: Map<string, number>;
  buildings: Map<number, { id: number; kind: string; owner: string; ox: number; oz: number; cellsW: number; cellsD: number; destroyed: boolean }>;
  buildingsByTag: Map<string, number>;
  projectiles: Map<number, unknown>;
  projectilesByTag: Map<string, number>;
  resources: Map<string, unknown>;
  voxelOverrides: Map<number, number>;
  voxelEdits: unknown[];
  voxelEditSeq: number;
  projectileImpactSeq: number;
  saplings: unknown[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string };
  snapshot: (viewer?: string | null) => {
    entities: Entity[]; buildings: Building[]; projectiles: unknown[];
  };
  state: ServerStateShape;
};

function reset(): void {
  gs.state.tick = 1;  // non-zero so vision rebuilds when test asks
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.buildings.clear();
  gs.state.buildingsByTag.clear();
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.resources.clear();
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.projectileImpactSeq = 0;
  gs.state.saplings.length = 0;
}

function bumpTick(): void { gs.state.tick++; }

function spawnEntity(tag: string, owner: string, kind: string, x: number, z: number): void {
  const r = gs.applyCommand({
    type: 'spawn_entity',
    clientTag: tag, owner, kind,
    x, y: 6, z, hp: 100,
  });
  expect(r.ok).toBe(true);
}

function placeBuilding(tag: string, owner: string, kind: string, ox: number, oz: number): void {
  const r = gs.applyCommand({
    type: 'place_building',
    clientTag: tag, owner, kind,
    ox, oz, floorY: 80, cellsW: 4, cellsD: 4,
    upgradeState: 'enabled', hp: 500, maxHp: 500,
  });
  expect(r.ok).toBe(true);
}

describe('snapshot FoW filter', () => {
  beforeEach(reset);

  it('no viewer → unfiltered (legacy callers)', () => {
    spawnEntity('p1', 'red', 'soldier', 50, 50);
    spawnEntity('e1', 'enemy', 'soldier', 200, 200);
    const snap = gs.snapshot(null);
    expect(snap.entities.length).toBe(2);
  });

  it("viewer sees own entities and ones inside their vision", () => {
    spawnEntity('p1', 'red', 'soldier', 50, 50);
    // Default soldier sight is 16 cells; cell width = 1 m. An enemy
    // 5 m away is well inside.
    spawnEntity('e-near', 'enemy', 'soldier', 55, 50);
    // 200 m away — far outside the 16 m radius.
    spawnEntity('e-far', 'enemy', 'soldier', 250, 50);
    bumpTick();
    const snap = gs.snapshot('red');
    const tags = snap.entities.map(e => e.clientTag).sort();
    expect(tags).toEqual(['e-near', 'p1']);
  });

  it("viewer's own buildings are always visible regardless of sight cone", () => {
    placeBuilding('p-hq', 'red', 'hq', 50, 50);
    bumpTick();
    const snap = gs.snapshot('red');
    expect(snap.buildings.find(b => b.kind === 'hq')).toBeDefined();
  });

  it('hides cross-team buildings outside vision', () => {
    spawnEntity('p1', 'red', 'soldier', 50, 50);
    placeBuilding('e-bk-far', 'enemy', 'barracks', 200, 200);
    bumpTick();
    const snap = gs.snapshot('red');
    // Player can't see the enemy barracks 200 m away.
    expect(snap.buildings.find(b => b.kind === 'barracks')).toBeUndefined();
  });

  it('reveals cross-team buildings when something gets close', () => {
    spawnEntity('p1', 'red', 'soldier', 50, 50);
    placeBuilding('e-bk-far', 'enemy', 'barracks', 200, 200);
    bumpTick();
    expect(gs.snapshot('red').buildings.length).toBe(0);
    // Move the scout next to the barracks (cell centre at ox+2, oz+2 = 202, 202).
    const id = gs.state.byTag.get('p1')!;
    const u = gs.state.entities.get(id)!;
    u.x = 200; u.z = 200;
    bumpTick();
    const snap = gs.snapshot('red');
    expect(snap.buildings.find(b => b.kind === 'barracks')).toBeDefined();
  });

  it('viewer with no assets sees nothing they don\'t own', () => {
    spawnEntity('e1', 'enemy', 'soldier', 50, 50);
    placeBuilding('e-hq', 'enemy', 'hq', 50, 50);
    bumpTick();
    // Mallory has no on-map presence; even cross-team rows in range
    // of nothing of theirs are filtered out.
    const snap = gs.snapshot('mallory');
    expect(snap.entities.length).toBe(0);
    expect(snap.buildings.length).toBe(0);
  });

  it('vision recomputes on tick advance (entity move reveals new ground)', () => {
    spawnEntity('p1', 'red', 'soldier', 50, 50);
    spawnEntity('e1', 'enemy', 'soldier', 200, 200);
    bumpTick();
    expect(gs.snapshot('red').entities.length).toBe(1); // own only
    // Teleport the scout next to the enemy.
    const id = gs.state.byTag.get('p1')!;
    const u = gs.state.entities.get(id)!;
    u.x = 200; u.z = 200;
    bumpTick();
    const tags = gs.snapshot('red').entities.map(e => e.clientTag).sort();
    expect(tags).toEqual(['e1', 'p1']);
  });
});
