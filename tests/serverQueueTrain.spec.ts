import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface ServerBuilding {
  id: number; clientTag: string | null; kind: string; owner: string;
  ox: number; oz: number; floorY: number;
  cellsW: number; cellsD: number;
  upgradeState: string;
  hp: number; maxHp: number;
  trainQueue: string[]; destroyed: boolean;
}

interface ServerStateShape {
  buildings: Map<number, ServerBuilding>;
  buildingsByTag: Map<string, number>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string; trainQueueLen?: number };
  state: ServerStateShape;
};

function reset(): void {
  gs.state.buildings.clear();
  gs.state.buildingsByTag.clear();
}

function spawnBarracks(tag: string, owner: string): ServerBuilding {
  const r = gs.applyCommand({
    type: 'place_building',
    clientTag: tag,
    owner,
    kind: 'barracks',
    ox: 100, oz: 100, floorY: 50,
    cellsW: 4, cellsD: 4,
    upgradeState: 'enabled',
    hp: 500, maxHp: 500,
    trainQueue: [],
  });
  expect(r.ok).toBe(true);
  return gs.state.buildings.get(gs.state.buildingsByTag.get(tag)!)!;
}

describe('server queue_train', () => {
  beforeEach(reset);

  it('appends a unit kind to the trainQueue', () => {
    const b = spawnBarracks('bk1', 'enemy');
    // Phase 6+ cost gate — fund the soldier + gunner the test queues.
    gs.applyCommand({ type: 'set_resources', owner: 'enemy', food: 200, metals: 100, wood: 100, popCap: 0 });
    expect(b.trainQueue).toEqual([]);
    const r = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk1',
      owner: 'enemy',
      unitKind: 'soldier',
    });
    expect(r.ok).toBe(true);
    expect(r.trainQueueLen).toBe(1);
    expect(b.trainQueue).toEqual(['soldier']);
    // A second append extends the queue rather than replacing it.
    const r2 = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk1',
      owner: 'enemy',
      unitKind: 'gunner',
    });
    expect(r2.ok).toBe(true);
    expect(r2.trainQueueLen).toBe(2);
    expect(b.trainQueue).toEqual(['soldier', 'gunner']);
  });

  it('refuses cross-owner attempts', () => {
    spawnBarracks('bk2', 'enemy');
    const r = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk2',
      owner: 'p-mallory',
      unitKind: 'soldier',
    });
    expect(r.ok).toBe(false);
  });

  it('caps at 8 pending', () => {
    const b = spawnBarracks('bk3', 'enemy');
    // 8 soldiers × 40 food + 10 metals + 10 wood each → 320/80/80 budget.
    gs.applyCommand({ type: 'set_resources', owner: 'enemy', food: 320, metals: 80, wood: 80, popCap: 0 });
    for (let i = 0; i < 8; i++) {
      const r = gs.applyCommand({
        type: 'queue_train',
        clientTag: 'bk3',
        owner: 'enemy',
        unitKind: 'soldier',
      });
      expect(r.ok).toBe(true);
    }
    const overflow = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk3',
      owner: 'enemy',
      unitKind: 'soldier',
    });
    expect(overflow.ok).toBe(false);
    expect(b.trainQueue.length).toBe(8);
  });

  it('rejects an unknown building', () => {
    const r = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'no-such-bk',
      owner: 'enemy',
      unitKind: 'soldier',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing unitKind', () => {
    spawnBarracks('bk4', 'enemy');
    const r = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk4',
      owner: 'enemy',
      unitKind: '',
    });
    expect(r.ok).toBe(false);
  });
});

describe('server place_building auto-spot', () => {
  beforeEach(reset);

  function spawnEnemyHq(): ServerBuilding {
    // HQ at (200, 200) cells × 6×6, floor y=80 — well inside the
    // inland plain. The default seed's heightmap puts the surface
    // around y=96 there, so the slope tolerance check has plenty of
    // room.
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'enemy-hq',
      owner: 'enemy',
      kind: 'hq',
      ox: 200, oz: 200, floorY: 80,
      cellsW: 6, cellsD: 6,
      upgradeState: 'enabled',
      hp: 1000, maxHp: 1000,
    });
    expect(r.ok).toBe(true);
    return gs.state.buildings.get(gs.state.buildingsByTag.get('enemy-hq')!)!;
  }

  it('auto-picks a spot near the enemy HQ', () => {
    spawnEnemyHq();
    // Enemy needs the barracks budget for the cost gate added in 6+.
    gs.applyCommand({ type: 'set_resources', owner: 'enemy', food: 0, metals: 100, wood: 100, popCap: 0 });
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'ai-bk',
      owner: 'enemy',
      kind: 'barracks',
    });
    expect(r.ok).toBe(true);
    const b = gs.state.buildings.get(gs.state.buildingsByTag.get('ai-bk')!)!;
    expect(b.kind).toBe('barracks');
    expect(b.cellsW).toBe(4);
    expect(b.cellsD).toBe(4);
    // Anchored within ±30 cells of the HQ centre (203, 203).
    expect(Math.abs(b.ox + 2 - 203)).toBeLessThanOrEqual(32);
    expect(Math.abs(b.oz + 2 - 203)).toBeLessThanOrEqual(32);
  });

  it('refuses to auto-spot when the owner has no HQ', () => {
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'orphan',
      owner: 'enemy',
      kind: 'barracks',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spot|hq|owner/i);
  });

  it('does not overlap the existing HQ', () => {
    const hq = spawnEnemyHq();
    // Enough budget for several barracks tries.
    gs.applyCommand({ type: 'set_resources', owner: 'enemy', food: 0, metals: 1000, wood: 1000, popCap: 0 });
    for (let i = 0; i < 5; i++) {
      const r = gs.applyCommand({
        type: 'place_building',
        clientTag: `ai-bk-${i}`,
        owner: 'enemy',
        kind: 'barracks',
      });
      if (!r.ok) continue;
      const b = gs.state.buildings.get(gs.state.buildingsByTag.get(`ai-bk-${i}`)!)!;
      // No corner of the new footprint should land inside the HQ AABB.
      const hqX1 = hq.ox + hq.cellsW;
      const hqZ1 = hq.oz + hq.cellsD;
      const bX1 = b.ox + b.cellsW;
      const bZ1 = b.oz + b.cellsD;
      const overlapX = b.ox < hqX1 && hq.ox < bX1;
      const overlapZ = b.oz < hqZ1 && hq.oz < bZ1;
      expect(overlapX && overlapZ).toBe(false);
    }
  });

  it('explicit ox/oz placement bypasses the picker (browser-driven path)', () => {
    // No HQ on the map — explicit-cell place still succeeds.
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'manual',
      owner: 'p-alice',
      kind: 'barracks',
      ox: 50, oz: 50, floorY: 96,
      cellsW: 4, cellsD: 4,
      upgradeState: 'enabled',
      hp: 500, maxHp: 500,
    });
    expect(r.ok).toBe(true);
    const b = gs.state.buildings.get(gs.state.buildingsByTag.get('manual')!)!;
    expect(b.ox).toBe(50);
    expect(b.oz).toBe(50);
  });
});

interface ServerStateWithRes {
  resources: Map<string, { food: number; metals: number; wood: number; popCap: number }>;
}

function setRes(owner: string, food: number, metals: number, wood: number): void {
  const r = gs.applyCommand({
    type: 'set_resources',
    owner, food, metals, wood, popCap: 0,
  });
  expect(r.ok).toBe(true);
}

function getRes(owner: string): { food: number; metals: number; wood: number } {
  const r = (gs.state as unknown as ServerStateWithRes).resources.get(owner);
  return r ? { food: r.food, metals: r.metals, wood: r.wood } : { food: 0, metals: 0, wood: 0 };
}

describe('server-authoritative cost deduction', () => {
  beforeEach(reset);

  function spawnEnemyHq(): void {
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'enemy-hq',
      owner: 'enemy',
      kind: 'hq',
      ox: 200, oz: 200, floorY: 80,
      cellsW: 6, cellsD: 6,
      upgradeState: 'enabled',
      hp: 1000, maxHp: 1000,
    });
    expect(r.ok).toBe(true);
  }

  it('place_building auto-spot rejects when poor and leaves resources untouched', () => {
    spawnEnemyHq();
    setRes('enemy', 0, 0, 0);
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'ai-bk-poor',
      owner: 'enemy',
      kind: 'barracks',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/resources/i);
    // No new building, no resource debit.
    expect(gs.state.buildingsByTag.has('ai-bk-poor')).toBe(false);
    expect(getRes('enemy')).toEqual({ food: 0, metals: 0, wood: 0 });
  });

  it('place_building auto-spot debits the cost on success', () => {
    spawnEnemyHq();
    setRes('enemy', 0, 100, 100);
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'ai-bk-rich',
      owner: 'enemy',
      kind: 'barracks',
    });
    expect(r.ok).toBe(true);
    // Barracks cost: 40 metals + 40 wood.
    expect(getRes('enemy')).toEqual({ food: 0, metals: 60, wood: 60 });
  });

  it('explicit ox/oz placement is NOT charged (browser path)', () => {
    setRes('enemy', 0, 100, 100);
    const r = gs.applyCommand({
      type: 'place_building',
      clientTag: 'manual-bk',
      owner: 'enemy',
      kind: 'barracks',
      ox: 50, oz: 50, floorY: 96,
      cellsW: 4, cellsD: 4,
      upgradeState: 'enabled',
      hp: 500, maxHp: 500,
    });
    expect(r.ok).toBe(true);
    expect(getRes('enemy')).toEqual({ food: 0, metals: 100, wood: 100 });
  });

  it('queue_train rejects when poor and leaves the queue alone', () => {
    spawnBarracks('bk-cost', 'enemy');
    setRes('enemy', 0, 0, 0);
    const r = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk-cost',
      owner: 'enemy',
      unitKind: 'soldier',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/resources/i);
    const b = gs.state.buildings.get(gs.state.buildingsByTag.get('bk-cost')!)!;
    expect(b.trainQueue).toEqual([]);
  });

  it('queue_train debits the unit cost on success', () => {
    spawnBarracks('bk-train', 'enemy');
    setRes('enemy', 100, 100, 100);
    const r = gs.applyCommand({
      type: 'queue_train',
      clientTag: 'bk-train',
      owner: 'enemy',
      unitKind: 'soldier',
    });
    expect(r.ok).toBe(true);
    // Soldier cost: 40 food, 10 metals, 10 wood.
    expect(getRes('enemy')).toEqual({ food: 60, metals: 90, wood: 90 });
  });

  it('AI emits multiple commands; each debit composes', () => {
    spawnBarracks('bk-multi', 'enemy');
    setRes('enemy', 200, 0, 0);
    for (let i = 0; i < 3; i++) {
      const r = gs.applyCommand({
        type: 'queue_train',
        clientTag: 'bk-multi',
        owner: 'enemy',
        unitKind: 'soldier',
      });
      expect(r.ok).toBe(false);  // Not enough metals/wood.
    }
    // Resources untouched on every reject.
    expect(getRes('enemy')).toEqual({ food: 200, metals: 0, wood: 0 });

    setRes('enemy', 200, 100, 100);
    let bm = gs.state.buildings.get(gs.state.buildingsByTag.get('bk-multi')!)!;
    expect(bm.trainQueue.length).toBe(0);
    for (let i = 0; i < 3; i++) {
      const r = gs.applyCommand({
        type: 'queue_train',
        clientTag: 'bk-multi',
        owner: 'enemy',
        unitKind: 'soldier',
      });
      expect(r.ok).toBe(true);
    }
    bm = gs.state.buildings.get(gs.state.buildingsByTag.get('bk-multi')!)!;
    expect(bm.trainQueue.length).toBe(3);
    // 3 × (40, 10, 10) → final 80, 70, 70.
    expect(getRes('enemy')).toEqual({ food: 80, metals: 70, wood: 70 });
  });
});
