import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface ServerStateShape {
  tick: number;
  buildings: Map<number, { owner: string; kind: string; upgradeState: string; destroyed: boolean }>;
  buildingsByTag: Map<string, number>;
  resources: Map<string, { food: number; metals: number; wood: number; popCap: number }>;
  entities: Map<number, unknown>;
  byTag: Map<string, number>;
  projectiles: Map<number, unknown>;
  projectilesByTag: Map<string, number>;
  voxelOverrides: Map<number, number>;
  voxelEdits: unknown[];
  voxelEditSeq: number;
  projectileImpactSeq: number;
  saplings: unknown[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string };
  tick: (dt: number) => void;
  state: ServerStateShape;
};

function reset(): void {
  gs.state.tick = 0;
  gs.state.buildings.clear();
  gs.state.buildingsByTag.clear();
  gs.state.resources.clear();
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.projectileImpactSeq = 0;
  gs.state.saplings.length = 0;
}

function placeFarm(tag: string, owner: string, upgradeState: string): void {
  const r = gs.applyCommand({
    type: 'place_building',
    clientTag: tag, owner, kind: 'farm',
    ox: 100, oz: 100, floorY: 80,
    cellsW: 3, cellsD: 3,
    upgradeState,
    hp: 100, maxHp: 100,
  });
  expect(r.ok).toBe(true);
}

describe('server farm income', () => {
  beforeEach(reset);

  it('accrues food for each enabled farm per tick', () => {
    placeFarm('f1', 'enemy', 'enabled');
    expect(gs.state.resources.get('enemy')?.food ?? 0).toBe(0);
    gs.tick(1.0);
    // FARM_INCOME_FOOD_PER_SEC = 2.5
    const food = gs.state.resources.get('enemy')!.food;
    expect(food).toBeCloseTo(2.5, 5);
  });

  it('does not tick a pending farm', () => {
    placeFarm('f-pending', 'enemy', 'pending');
    gs.tick(2.0);
    const r = gs.state.resources.get('enemy');
    expect(r?.food ?? 0).toBe(0);
  });

  it('does not tick a destroyed farm', () => {
    placeFarm('f-dead', 'enemy', 'enabled');
    const id = gs.state.buildingsByTag.get('f-dead')!;
    const b = gs.state.buildings.get(id)!;
    b.destroyed = true;
    gs.tick(2.0);
    const r = gs.state.resources.get('enemy');
    expect(r?.food ?? 0).toBe(0);
  });

  it('multiple farms compose linearly', () => {
    placeFarm('f-a', 'enemy', 'enabled');
    // Need a different ox/oz for the second farm so footprint check (none on
    // explicit-cell path) doesn't matter, but tagging is unique.
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'f-b', owner: 'enemy', kind: 'farm',
      ox: 110, oz: 110, floorY: 80,
      cellsW: 3, cellsD: 3,
      upgradeState: 'enabled',
      hp: 100, maxHp: 100,
    });
    expect(r.ok).toBe(true);
    gs.tick(1.0);
    expect(gs.state.resources.get('enemy')!.food).toBeCloseTo(5.0, 5);
  });

  it('farm income flows to its own owner only', () => {
    placeFarm('e-farm', 'enemy', 'enabled');
    placeFarm('p-farm', 'p-alice', 'enabled');
    // Alice's farm needs different cells.
    const id = gs.state.buildingsByTag.get('p-farm')!;
    const b = gs.state.buildings.get(id)!;
    // Just keep it as-is; place_building accepts overlap (no validation
    // on explicit-cell path).
    void b;
    gs.tick(1.0);
    expect(gs.state.resources.get('enemy')!.food).toBeCloseTo(2.5, 5);
    expect(gs.state.resources.get('p-alice')!.food).toBeCloseTo(2.5, 5);
  });

  it('income composes with cost deduction across consecutive ticks', () => {
    placeFarm('f-econ', 'enemy', 'enabled');
    // Long enough to pay for a soldier (40 food). 40/2.5 = 16 s.
    for (let i = 0; i < 20; i++) gs.tick(1.0);
    expect(gs.state.resources.get('enemy')!.food).toBeGreaterThanOrEqual(40);
    // Place an HQ + barracks (explicit cells, no cost) so queue_train
    // has a target. Add metals/wood manually for the soldier cost.
    gs.applyCommand({
      type: 'place_building', clientTag: 'hq', owner: 'enemy', kind: 'hq',
      ox: 200, oz: 200, floorY: 80, cellsW: 6, cellsD: 6,
      upgradeState: 'enabled', hp: 1000, maxHp: 1000,
    });
    gs.applyCommand({
      type: 'place_building', clientTag: 'bk', owner: 'enemy', kind: 'barracks',
      ox: 210, oz: 210, floorY: 80, cellsW: 4, cellsD: 4,
      upgradeState: 'enabled', hp: 500, maxHp: 500,
    });
    const before = gs.state.resources.get('enemy')!.food;
    gs.applyCommand({
      type: 'set_resources', owner: 'enemy',
      food: before, metals: 10, wood: 10, popCap: 0,
    });
    const r = gs.applyCommand({
      type: 'queue_train', clientTag: 'bk', owner: 'enemy', unitKind: 'soldier',
    });
    expect(r.ok).toBe(true);
    expect(gs.state.resources.get('enemy')!.food).toBeCloseTo(before - 40, 5);
  });
});
