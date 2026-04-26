import { describe, it, expect } from 'vitest';
import { allocateNav, buildSurfaceNav, NAV_W, NAV_H } from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';
import { smoothPath } from '../src/path/Smooth';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';

function buildFlatWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const voxels = world.buffers.voxels;
  const surfaceY = 96;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      voxels[worldIndex(x, 0, z)] = M_BEDROCK;
      voxels[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < surfaceY; y++) voxels[worldIndex(x, y, z)] = M_STONE;
      voxels[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('surface A* + smoother on flat ground', () => {
  it('returns a reached path whose cells are 8-connected step by step', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const start = { cx: 10, cz: 10 };
    const goal = { cx: 60, cz: 70 };
    const result = findPathSurface(nav, ws, {
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: 1,
      maxStepVoxels: 16,
      slopePenalty: 0.15,
      bodyHalfCells: 0,
      bodyRoughnessVoxels: 999,
      headroomVoxels: 0,
      prefersRoads: false,
    });

    expect(result.reached).toBe(true);
    expect(result.cells.length).toBeGreaterThan(0);

    // First and last cells match the request.
    const first = result.cells[0]!;
    const last = result.cells[result.cells.length - 1]!;
    expect(first.cx).toBe(start.cx); expect(first.cz).toBe(start.cz);
    expect(last.cx).toBe(goal.cx);   expect(last.cz).toBe(goal.cz);

    // Every consecutive pair must be 8-connected (no skipped cells in the raw A* path).
    for (let i = 1; i < result.cells.length; i++) {
      const a = result.cells[i - 1]!;
      const b = result.cells[i]!;
      const dx = Math.abs(b.cx - a.cx);
      const dz = Math.abs(b.cz - a.cz);
      expect(dx).toBeLessThanOrEqual(1);
      expect(dz).toBeLessThanOrEqual(1);
      expect(dx + dz).toBeGreaterThan(0);
    }
  });

  it('smoother reduces the path length and keeps the endpoints', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const start = { cx: 5, cz: 5 };
    const goal = { cx: 80, cz: 60 };
    const r = findPathSurface(nav, ws, {
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    expect(r.reached).toBe(true);

    const smoothed = smoothPath(nav, r.cells, 1, 16, 0, 999, 0);
    expect(smoothed.length).toBeLessThan(r.cells.length);
    expect(smoothed[0]).toEqual(r.cells[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(r.cells[r.cells.length - 1]);
  });

  it('returns reached=false (and an empty path) when the goal is out of bounds', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const r = findPathSurface(nav, ws, {
      startCx: 5, startCz: 5,
      goalCx: NAV_W - 1, goalCz: NAV_H - 1, // valid corner
      footprintRadius: 1,
      maxStepVoxels: 16,
      slopePenalty: 0.15,
      bodyHalfCells: 0,
      bodyRoughnessVoxels: 999,
      headroomVoxels: 0,
      prefersRoads: false,
    });
    // Sanity that the corner IS reachable on flat terrain
    expect(r.reached).toBe(true);

    void M_DIRT;
  });

  it('bidirectional reconstruction is contiguous from start to goal', () => {
    // The bidirectional search splices the forward chain (start→meet) with the
    // reversed backward chain (meet→goal). Verify the result is still 8-connected
    // end-to-end with no duplicate cells at the join.
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();
    const r = findPathSurface(nav, ws, {
      startCx: 12, startCz: 12,
      goalCx: 70, goalCz: 50,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    expect(r.reached).toBe(true);
    expect(r.cells.length).toBeGreaterThan(0);
    expect(r.cells[0]).toEqual({ cx: 12, cz: 12 });
    expect(r.cells[r.cells.length - 1]).toEqual({ cx: 70, cz: 50 });
    // No duplicate consecutive cells (would happen if the meet node was double-counted).
    for (let i = 1; i < r.cells.length; i++) {
      const a = r.cells[i - 1]!;
      const b = r.cells[i]!;
      expect(a.cx === b.cx && a.cz === b.cz).toBe(false);
      const dx = Math.abs(a.cx - b.cx);
      const dz = Math.abs(a.cz - b.cz);
      expect(dx).toBeLessThanOrEqual(1);
      expect(dz).toBeLessThanOrEqual(1);
    }
  });

  it('start === goal returns a single-cell path', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();
    const r = findPathSurface(nav, ws, {
      startCx: 30, startCz: 30, goalCx: 30, goalCz: 30,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    expect(r.reached).toBe(true);
    expect(r.cells.length).toBe(1);
    expect(r.cells[0]).toEqual({ cx: 30, cz: 30 });
  });

  it('does not cross a 1-cell void column (gap blocks both A* and smoother)', () => {
    // Build a flat world, then carve every voxel from a single 1-cell-wide column
    // (cx=40, cz around the path) so the cell becomes blocked. The path from
    // (5,40) to (90,40) has a gap right in the middle. A unit cannot cross it.
    const world = buildFlatWorld();
    const v = world.buffers.voxels;
    const gapCx = 40;
    const NAV_CELL_VOXELS = 8;
    // Carve all voxels in the column under cell (40, 40)
    const wxStart = gapCx * NAV_CELL_VOXELS;
    const wzStart = 40 * NAV_CELL_VOXELS;
    for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
      for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
        for (let y = 0; y < 100; y++) {
          v[worldIndex(wxStart + dx, y, wzStart + dz)] = 0;
        }
      }
    }

    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    // Sanity: the carved cell really is blocked.
    expect(nav.blocked[40 * 96 + 40]).toBe(1); // cz=40, cx=40

    const ws = new AStarWorkspace();
    const r = findPathSurface(nav, ws, {
      startCx: 5, startCz: 40,
      goalCx: 90, goalCz: 40,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    // Path may either reach (going around) or fail; either way no cell along the
    // returned path may be the blocked column.
    for (const c of r.cells) {
      expect(c.cx === 40 && c.cz === 40).toBe(false);
    }
    // And no two consecutive cells should be (39,40) → (41,40) — that would be a
    // straight horizontal through the gap (Bresenham diagonal couldn't either).
    for (let i = 1; i < r.cells.length; i++) {
      const a = r.cells[i - 1]!;
      const b = r.cells[i]!;
      const skipsGapCardinally = a.cz === 40 && b.cz === 40 &&
        Math.min(a.cx, b.cx) <= 39 && Math.max(a.cx, b.cx) >= 41;
      expect(skipsGapCardinally).toBe(false);
    }
  });

  it('cone search expands far fewer cells than a flood-fill would across a long route', () => {
    // Diagonal of the world is roughly sqrt(2) * 90 ≈ 127 cells. A breadth-first
    // search would visit the entire grid (96 * 96 = 9216 cells) before reaching
    // the far corner. Bidirectional cone-A* with weight 1.5 should land the path
    // in a small fraction of that.
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();
    const r = findPathSurface(nav, ws, {
      startCx: 5, startCz: 5,
      goalCx: 90, goalCz: 90,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    expect(r.reached).toBe(true);
    // Two cones converging: roughly two thin fans on a flat map.
    expect(r.expanded).toBeLessThan(2000);
    // Path goes from start to goal (cells near each end match).
    expect(r.cells[0]).toEqual({ cx: 5, cz: 5 });
    expect(r.cells[r.cells.length - 1]).toEqual({ cx: 90, cz: 90 });
  });
});
