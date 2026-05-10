import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface ServerStateShape {
  tick: number;
  voxelOverrides: Map<number, number>;
  voxelEdits: Array<{
    seq: number; sender: string;
    op: { kind: 'sphere'; x: number; y: number; z: number; radius: number; mat: number }
       | { kind: 'set'; ops: Array<{ x: number; y: number; z: number; mat: number }> };
  }>;
  voxelEditSeq: number;
  worldSeed: number;
  projectiles: Map<number, unknown>;
  projectilesByTag: Map<string, number>;
  entities: Map<number, unknown>;
  byTag: Map<string, number>;
  projectileImpactSeq: number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string };
  tick: (dt: number) => void;
  state: ServerStateShape;
};

const SERVER_WORLD_X = 3072;
const SERVER_WORLD_Z = 3072;
const M_AIR = 0;
const M_WOOD = 4;
const M_LEAF = 5;

function voxelIdx(x: number, y: number, z: number): number {
  return (y * SERVER_WORLD_Z + z) * SERVER_WORLD_X + x;
}

function reset(): void {
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.tick = 0;
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.projectileImpactSeq = 0;
}

/** Small canopy: a vertical 2-voxel wood trunk + a 3×3×3 leaf cluster
 *  whose centre touches the trunk top. Sized to fit within the leaf
 *  decay BFS radius (12 voxels). */
function plantCanopy(cx: number, cy: number, cz: number): { woodIdx: number[]; leafIdx: number[] } {
  const woodIdx: number[] = [];
  const leafIdx: number[] = [];
  for (let dy = 0; dy < 2; dy++) {
    const idx = voxelIdx(cx, cy + dy, cz);
    gs.state.voxelOverrides.set(idx, M_WOOD);
    woodIdx.push(idx);
  }
  // 3×3×3 leaves centred at (cx, cy + 3, cz). Skip voxel exactly at
  // the trunk top so the leaf-touching-wood seed is distinct.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + 3 + dy, z = cz + dz;
        const idx = voxelIdx(x, y, z);
        gs.state.voxelOverrides.set(idx, M_LEAF);
        leafIdx.push(idx);
      }
    }
  }
  return { woodIdx, leafIdx };
}

describe('server leaf decay', () => {
  beforeEach(reset);

  it('decays the canopy after the trunk is felled', () => {
    const { woodIdx, leafIdx } = plantCanopy(200, 60, 200);
    // Sanity: leaves are present in overrides.
    for (const idx of leafIdx) expect(gs.state.voxelOverrides.get(idx)).toBe(M_LEAF);
    // Fell the trunk via a small voxel_edit set op (server applies +
    // triggers leaf decay evaluation).
    const r = gs.applyCommand({
      type: 'voxel_edit',
      owner: 'lumberjack',
      ops: woodIdx.map(i => {
        const x = i % SERVER_WORLD_X;
        const xz = (i - x) / SERVER_WORLD_X;
        const z = xz % SERVER_WORLD_Z;
        const y = (xz - z) / SERVER_WORLD_Z;
        return { x, y, z, mat: M_AIR };
      }),
    });
    expect(r.ok).toBe(true);
    // Leaves are still present immediately after — only timer started.
    for (const idx of leafIdx) expect(gs.state.voxelOverrides.get(idx)).toBe(M_LEAF);
    // Tick past LEAF_DECAY_SECONDS (0.3 s).
    const editsBefore = gs.state.voxelEditSeq;
    gs.tick(0.4);
    // Server should have shipped a 'set' op turning the leaves to AIR.
    expect(gs.state.voxelEditSeq).toBe(editsBefore + 1);
    const last = gs.state.voxelEdits[gs.state.voxelEdits.length - 1]!;
    expect(last.op.kind).toBe('set');
    expect(last.sender).toBe('server');
    if (last.op.kind === 'set') {
      // All scheduled leaf voxels should have been cleared in the
      // single batched op.
      expect(last.op.ops.length).toBeGreaterThanOrEqual(leafIdx.length - 1);
    }
    // Override map reflects the AIR result.
    for (const idx of leafIdx) {
      expect(gs.state.voxelOverrides.get(idx)).toBe(M_AIR);
    }
  });

  it('does not decay leaves still anchored to wood', () => {
    plantCanopy(400, 60, 400);
    // Touch a region nowhere near a tree — should be a no-op.
    gs.applyCommand({
      type: 'voxel_edit',
      owner: 'misc',
      ops: [{ x: 1000, y: 50, z: 1000, mat: M_AIR }],
    });
    gs.tick(1.0);
    // Trunk + canopy intact.
    expect(gs.state.voxelOverrides.get(voxelIdx(400, 60, 400))).toBe(M_WOOD);
    expect(gs.state.voxelOverrides.get(voxelIdx(400, 63, 400))).toBe(M_LEAF);
  });

  it('clears the timer when a leaf is reattached before it expires', () => {
    const { woodIdx } = plantCanopy(600, 60, 600);
    // Knock out the trunk to start the decay timer.
    gs.applyCommand({
      type: 'voxel_edit',
      owner: 'lumberjack',
      ops: woodIdx.map(i => {
        const x = i % SERVER_WORLD_X;
        const xz = (i - x) / SERVER_WORLD_X;
        const z = xz % SERVER_WORLD_Z;
        const y = (xz - z) / SERVER_WORLD_Z;
        return { x, y, z, mat: M_AIR };
      }),
    });
    // Re-plant the trunk — leaves should be re-anchored when the
    // sensitive-edit hook re-evaluates. We wait past the throttle
    // window (0.15 s) so the second BFS actually runs, then tick a
    // hair past 0.3 s and assert the canopy is still leaves.
    gs.tick(0.16);
    gs.applyCommand({
      type: 'voxel_edit',
      owner: 'lumberjack',
      ops: woodIdx.map(i => {
        const x = i % SERVER_WORLD_X;
        const xz = (i - x) / SERVER_WORLD_X;
        const z = xz % SERVER_WORLD_Z;
        const y = (xz - z) / SERVER_WORLD_Z;
        return { x, y, z, mat: M_WOOD };
      }),
    });
    gs.tick(0.4);
    expect(gs.state.voxelOverrides.get(voxelIdx(600, 63, 600))).toBe(M_LEAF);
  });
});
