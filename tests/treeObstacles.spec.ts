import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_DIRT, M_GRASS, M_WOOD, M_LEAF } from '../src/voxel/Materials';
import {
  allocateNav, buildSurfaceNav, navIndex, NAV_CELL_VOXELS,
} from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';

function buildFlatWorld(surfaceY = 32): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

/** Plant a single trunk + canopy at world voxel (wx, wz) sitting on `surfaceY`. */
function plantTree(v: Uint8Array, wx: number, wz: number, surfaceY: number): void {
  const trunkH = 18;
  for (let dy = 1; dy <= trunkH; dy++) v[worldIndex(wx, surfaceY + dy, wz)] = M_WOOD;
  // Tiny leaf canopy directly above the trunk; a few voxels just to make
  // the column non-trivial above the trunk top.
  for (let dy = trunkH; dy <= trunkH + 3; dy++) {
    v[worldIndex(wx, surfaceY + dy, wz)] = M_LEAF;
  }
}

describe('Trees as A* obstacles', () => {
  it('a cell with a tree trunk gets blocked + treeBlocked set', () => {
    const world = buildFlatWorld();
    const v = world.buffers.voxels;
    // Plant a tree at the centre of cell (8, 8). Cell (8,8) covers voxels
    // [64..72) × [64..72), so x=68, z=68 sits inside it.
    plantTree(v, 68, 68, 32);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const i = navIndex(8, 8);
    expect(nav.treeBlocked[i]).toBe(1);
    expect(nav.blocked[i]).toBe(1);
  });

  it('A* routes around the tree-blocked cell', () => {
    const world = buildFlatWorld();
    const v = world.buffers.voxels;
    // Block cell (8, 8) so the direct east-west path through it is blocked.
    plantTree(v, 68, 68, 32);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const ws = new AStarWorkspace();
    // Start cell (5, 8), goal cell (12, 8) — the straight line passes
    // through (8, 8). Path should detour around.
    const r = findPathSurface(nav, ws, {
      startCx: 5, startCz: 8,
      goalCx: 12, goalCz: 8,
      footprintRadius: 1,
      maxStepVoxels: 32,
      slopePenalty: 0.05,
      bodyHalfCells: 0,
      bodyRoughnessVoxels: 999,
      headroomVoxels: 14,
      prefersRoads: false,
      routeSeed: 1,
    });
    expect(r.reached).toBe(true);
    // The tree-blocked cell must NOT appear in the returned path.
    for (const c of r.cells) {
      expect(c.cx === 8 && c.cz === 8).toBe(false);
    }
  });

  it('chopping down the tree clears both flags after a nav rebuild', () => {
    const world = buildFlatWorld();
    const v = world.buffers.voxels;
    plantTree(v, 68, 68, 32);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    expect(nav.treeBlocked[navIndex(8, 8)]).toBe(1);
    // Wipe the tree.
    for (let dy = 1; dy <= 22; dy++) {
      v[worldIndex(68, 32 + dy, 68)] = 0;
    }
    buildSurfaceNav(v, nav);
    expect(nav.treeBlocked[navIndex(8, 8)]).toBe(0);
    expect(nav.blocked[navIndex(8, 8)]).toBe(0);
  });

  it('a trunk hugging the cell edge still flags the entire cell as blocked', () => {
    // Plant a trunk at (64, 64) — that's the corner of cell (8, 8). Even
    // though the trunk is only 1 voxel thick on the edge, the per-cell
    // tree scan should still mark the cell as blocked.
    const world = buildFlatWorld();
    const v = world.buffers.voxels;
    plantTree(v, 64, 64, 32);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    expect(nav.treeBlocked[navIndex(8, 8)]).toBe(1);
  });
});
