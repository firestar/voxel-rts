import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface ServerStateShape {
  resources: Map<string, { food: number; metals: number; wood: number; popCap: number }>;
  entities: Map<number, unknown>;
  byTag: Map<string, number>;
  buildings: Map<number, unknown>;
  buildingsByTag: Map<string, number>;
  projectiles: Map<number, unknown>;
  projectilesByTag: Map<string, number>;
  voxelOverrides: Map<number, number>;
  voxelEdits: unknown[];
  voxelEditSeq: number;
  projectileImpactSeq: number;
  saplings: unknown[];
  tick: number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string };
  snapshot: (viewer?: string | null) => {
    resources: Record<string, { food: number; metals: number; wood: number; popCap: number }>;
    entities: unknown[]; buildings: unknown[]; projectiles: unknown[];
  };
  state: ServerStateShape;
};

function reset(): void {
  gs.state.resources.clear();
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.buildings.clear();
  gs.state.buildingsByTag.clear();
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.projectileImpactSeq = 0;
  gs.state.saplings.length = 0;
  gs.state.tick = 0;
}

describe('snapshot viewer filter', () => {
  beforeEach(() => {
    reset();
    gs.applyCommand({ type: 'set_resources', owner: 'red', food: 10, metals: 0, wood: 0, popCap: 0 });
    gs.applyCommand({ type: 'set_resources', owner: 'blue', food: 20, metals: 0, wood: 0, popCap: 0 });
    gs.applyCommand({ type: 'set_resources', owner: 'enemy', food: 30, metals: 0, wood: 0, popCap: 0 });
  });

  it('default snapshot includes every owner', () => {
    const snap = gs.snapshot();
    expect(Object.keys(snap.resources).sort()).toEqual(['blue', 'enemy', 'red']);
  });

  it('null viewer is treated as no filter', () => {
    const snap = gs.snapshot(null);
    expect(Object.keys(snap.resources).sort()).toEqual(['blue', 'enemy', 'red']);
  });

  it('viewer="red" only sees red resources', () => {
    const snap = gs.snapshot('red');
    expect(Object.keys(snap.resources)).toEqual(['red']);
    expect(snap.resources.red!.food).toBe(10);
  });

  it('viewer="enemy" only sees enemy resources', () => {
    const snap = gs.snapshot('enemy');
    expect(Object.keys(snap.resources)).toEqual(['enemy']);
    expect(snap.resources.enemy!.food).toBe(30);
  });

  it('unknown viewer sees nothing', () => {
    const snap = gs.snapshot('mallory');
    expect(Object.keys(snap.resources)).toEqual([]);
  });
});
