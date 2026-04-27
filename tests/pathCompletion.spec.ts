import { describe, it, expect } from 'vitest';
import {
  allocateNav, buildSurfaceNav, NAV_W, NAV_H, navIndex, NAV_CELL_VOXELS,
} from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';
import {
  allocateVolumeNav, buildVolumeNav, VNAV_X, VNAV_Z,
} from '../src/path/VolumeNav';
import { findPathVolume, AStar3DWorkspace } from '../src/path/AStar3D';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_STONE, M_BEDROCK } from '../src/voxel/Materials';

/**
 * Regression tests for "pathfinding completes" — i.e. findPathSurface /
 * findPathVolume returns reached=true when a route exists, even when the
 * route is geometrically far from the heuristic-preferred straight line
 * (long detours, mazes, narrow channels, sparse obstacle fields).
 *
 * The bidirectional cone-A* uses a heuristic weight of 2.0 and a hard cap
 * on expansions; both can cause completion failures when obstacles force
 * the search to expand many cells against the heuristic. These tests pin
 * down the scenarios we expect to keep working so a future tuning of the
 * heuristic weight or expansion cap can't silently break them.
 */

const SURFACE_Y = 96;

function buildFlatWorld(): VoxelWorld {
  const w = VoxelWorld.create(false);
  const v = w.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < SURFACE_Y; y++) v[worldIndex(x, y, z)] = M_STONE;
      v[worldIndex(x, SURFACE_Y, z)] = M_GRASS;
    }
  }
  return w;
}

/** Carve every voxel in a single nav cell — the cell becomes blocked (topY = -1). */
function carveCell(v: Uint8Array, cx: number, cz: number): void {
  const x0 = cx * NAV_CELL_VOXELS;
  const z0 = cz * NAV_CELL_VOXELS;
  for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
    for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
      for (let y = 0; y < SURFACE_Y + 4; y++) {
        v[worldIndex(x0 + dx, y, z0 + dz)] = 0;
      }
    }
  }
}

function expectContiguousPath(cells: { cx: number; cz: number }[], start: { cx: number; cz: number }, goal: { cx: number; cz: number }): void {
  expect(cells.length).toBeGreaterThan(0);
  expect(cells[0]).toEqual(start);
  expect(cells[cells.length - 1]).toEqual(goal);
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]!;
    const b = cells[i]!;
    const dx = Math.abs(a.cx - b.cx);
    const dz = Math.abs(a.cz - b.cz);
    expect(dx).toBeLessThanOrEqual(1);
    expect(dz).toBeLessThanOrEqual(1);
    expect(dx + dz).toBeGreaterThan(0);
  }
}

const baseSurfaceReq = {
  footprintRadius: 1,
  maxStepVoxels: 16,
  slopePenalty: 0.15,
  bodyHalfCells: 0,
  bodyRoughnessVoxels: 999,
  headroomVoxels: 0,
  prefersRoads: false,
};

describe('surface pathfinding completes — long detours', () => {
  it('routes around a U-shaped wall that blocks the direct line', () => {
    // Wall at cx=64 from cz=0 to cz=100 (NAV_H = 128), forcing a southward detour.
    const w = buildFlatWorld();
    const v = w.buffers.voxels;
    for (let cz = 0; cz <= 100; cz++) carveCell(v, 64, cz);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const ws = new AStarWorkspace();

    const start = { cx: 50, cz: 5 };
    const goal = { cx: 80, cz: 5 };
    const r = findPathSurface(nav, ws, {
      ...baseSurfaceReq,
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
    // The path must actually bend around the wall — at least one cell must be at cz > 100.
    expect(r.cells.some(c => c.cz > 100)).toBe(true);
  });

  it('escapes a pocket whose only exit is on the side away from the goal', () => {
    // ⊃-shaped pocket open on the west; goal is east. The path must travel west
    // to leave the pocket, then loop back east — forcing the cone search to
    // expand against the heuristic before making progress.
    const w = buildFlatWorld();
    const v = w.buffers.voxels;
    for (let cz = 50; cz <= 70; cz++) carveCell(v, 70, cz); // east wall
    for (let cx = 4; cx <= 70; cx++) {
      carveCell(v, cx, 50); // top wall
      carveCell(v, cx, 70); // bottom wall
    }
    // West side (cx < 4) stays open as the only escape.
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const ws = new AStarWorkspace();

    const start = { cx: 60, cz: 60 };
    const goal = { cx: 110, cz: 60 };
    const r = findPathSurface(nav, ws, {
      ...baseSurfaceReq,
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
    // Path must cross cx <= 3 at some point (the only exit).
    expect(r.cells.some(c => c.cx <= 3)).toBe(true);
  });

  it('serpentines through a multi-ring spiral maze', () => {
    const w = buildFlatWorld();
    const v = w.buffers.voxels;
    const center = 64;
    const rings = [12, 24, 36, 48];
    for (let r = 0; r < rings.length; r++) {
      const R = rings[r]!;
      for (let off = -R; off <= R; off++) {
        carveCell(v, center + off, center - R);
        carveCell(v, center + off, center + R);
        carveCell(v, center - R, center + off);
        carveCell(v, center + R, center + off);
      }
      // Open a 3-cell gap on a different side of each ring.
      const side = r % 4;
      for (let g = -1; g <= 1; g++) {
        const gx = side === 0 ? center + g : side === 1 ? center + R : side === 2 ? center + g : center - R;
        const gz = side === 0 ? center - R : side === 1 ? center + g : side === 2 ? center + R : center + g;
        // Restore the cell to a normal walkable column.
        const x0 = gx * NAV_CELL_VOXELS;
        const z0 = gz * NAV_CELL_VOXELS;
        for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
          for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
            v[worldIndex(x0 + dx, 0, z0 + dz)] = M_BEDROCK;
            v[worldIndex(x0 + dx, 1, z0 + dz)] = M_BEDROCK;
            for (let y = 2; y < SURFACE_Y; y++) v[worldIndex(x0 + dx, y, z0 + dz)] = M_STONE;
            v[worldIndex(x0 + dx, SURFACE_Y, z0 + dz)] = M_GRASS;
          }
        }
      }
    }
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const ws = new AStarWorkspace();

    const start = { cx: center, cz: center };
    const goal = { cx: 5, cz: 5 };
    const r = findPathSurface(nav, ws, {
      ...baseSurfaceReq,
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
  });
});

describe('surface pathfinding completes — dense obstacle fields', () => {
  it('finds a route through a 30%-blocked obstacle cloud', () => {
    const w = buildFlatWorld();
    const v = w.buffers.voxels;
    let s = 1;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let cz = 5; cz < NAV_H - 5; cz++) {
      for (let cx = 5; cx < NAV_W - 5; cx++) {
        if (rand() < 0.30) carveCell(v, cx, cz);
      }
    }
    // Make sure start and goal sit on walkable ground.
    const restore = (cx: number, cz: number) => {
      const x0 = cx * NAV_CELL_VOXELS;
      const z0 = cz * NAV_CELL_VOXELS;
      for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
        for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
          v[worldIndex(x0 + dx, 0, z0 + dz)] = M_BEDROCK;
          v[worldIndex(x0 + dx, 1, z0 + dz)] = M_BEDROCK;
          for (let y = 2; y < SURFACE_Y; y++) v[worldIndex(x0 + dx, y, z0 + dz)] = M_STONE;
          v[worldIndex(x0 + dx, SURFACE_Y, z0 + dz)] = M_GRASS;
        }
      }
    };
    const start = { cx: 7, cz: 7 };
    const goal = { cx: NAV_W - 8, cz: NAV_H - 8 };
    restore(start.cx, start.cz);
    restore(goal.cx, goal.cz);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const ws = new AStarWorkspace();

    const r = findPathSurface(nav, ws, {
      ...baseSurfaceReq,
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
  });

  it('routes a unit ringed by stationary peers through the lone gap', () => {
    // A 5x5 ring of stationary peers around the start, with a single 1-cell
    // gap on a cardinal side facing the goal. The unit should plan a route
    // that exits through the gap rather than refusing to move.
    //
    // The gap is placed on a cardinal (not a corner) because diagonals
    // through a corner gap are rejected by A*'s corner-cut rule whenever
    // both adjoining cardinals are blocked.
    const w = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(w.buffers.voxels, nav);
    const ws = new AStarWorkspace();
    const start = { cx: 40, cz: 40 };
    const goal = { cx: 80, cz: 80 };
    const obstacles: number[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue; // ring perimeter only
        if (dx === 0 && dz === 2) continue; // single-cell gap due south
        obstacles.push(navIndex(start.cx + dx, start.cz + dz));
      }
    }
    const r = findPathSurface(nav, ws, {
      ...baseSurfaceReq,
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      unitObstacles: obstacles,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
    // The path must traverse the gap cell (the only way out of the ring).
    const gap = { cx: start.cx, cz: start.cz + 2 };
    expect(r.cells.some(c => c.cx === gap.cx && c.cz === gap.cz)).toBe(true);
  });
});

describe('surface pathfinding completes — vehicles & wide footprints', () => {
  it('routes a footprint=2 vehicle through a 3-cell-wide channel', () => {
    const w = buildFlatWorld();
    const v = w.buffers.voxels;
    // Two parallel walls leaving a 3-cell channel between them.
    for (let cx = 10; cx < NAV_W - 10; cx++) {
      carveCell(v, cx, 50);
      carveCell(v, cx, 54);
    }
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);
    const ws = new AStarWorkspace();
    const start = { cx: 5, cz: 52 };
    const goal = { cx: NAV_W - 6, cz: 52 };
    const r = findPathSurface(nav, ws, {
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: 2,
      maxStepVoxels: 8,
      slopePenalty: 0.5,
      bodyHalfCells: 1,
      bodyRoughnessVoxels: 4,
      headroomVoxels: 0,
      prefersRoads: false,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
  });
});

describe('surface pathfinding completes — full-map traversals', () => {
  it('routes corner-to-corner on flat ground without exhausting the expansion budget', () => {
    const w = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(w.buffers.voxels, nav);
    const ws = new AStarWorkspace();
    const start = { cx: 4, cz: 4 };
    const goal = { cx: NAV_W - 5, cz: NAV_H - 5 };
    const r = findPathSurface(nav, ws, {
      ...baseSurfaceReq,
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
    });
    expect(r.reached).toBe(true);
    expectContiguousPath(r.cells, start, goal);
    // Cone search should land this in well under the 20 000 expansion cap on
    // an unobstructed map — if it ever explodes, completion guarantees on
    // harder maps will follow.
    expect(r.expanded).toBeLessThan(5000);
  });

  it('handles repeated queries on the same workspace without state leak', () => {
    // The workspace's generation counter is the only invalidation mechanism;
    // a leak between queries would surface as the second query failing or
    // returning a corrupted path. Run several different queries back-to-back.
    const w = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(w.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const queries: Array<{ start: { cx: number; cz: number }; goal: { cx: number; cz: number } }> = [
      { start: { cx: 5, cz: 5 }, goal: { cx: 50, cz: 50 } },
      { start: { cx: 80, cz: 10 }, goal: { cx: 10, cz: 80 } },
      { start: { cx: 50, cz: 50 }, goal: { cx: 5, cz: 5 } },
      { start: { cx: 60, cz: 60 }, goal: { cx: 90, cz: 30 } },
      { start: { cx: 5, cz: 5 }, goal: { cx: 50, cz: 50 } }, // repeat first query
    ];
    for (const q of queries) {
      const r = findPathSurface(nav, ws, {
        ...baseSurfaceReq,
        startCx: q.start.cx, startCz: q.start.cz,
        goalCx: q.goal.cx, goalCz: q.goal.cz,
      });
      expect(r.reached).toBe(true);
      expectContiguousPath(r.cells, q.start, q.goal);
    }
  });
});

describe('volume pathfinding completes — winding 3D routes', () => {
  it('walks the full length of a long underground tunnel without digging', () => {
    // Solid stone everywhere up through cell-y 14, with a single cell-y 4
    // tunnel running along cz=64 from cx=5 to cx=120. A non-digger must be
    // able to find this tunnel end-to-end without exhausting expansions.
    const w = VoxelWorld.create(false);
    const v = w.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        v[worldIndex(x, 1, z)] = M_BEDROCK;
        for (let y = 2; y < 120; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const tunnelYBase = 4 * NAV_CELL_VOXELS;       // voxel y 32..39
    const tunnelZBase = 64 * NAV_CELL_VOXELS;      // voxel z 512..519
    for (let cx = 5; cx <= 120; cx++) {
      const x0 = cx * NAV_CELL_VOXELS;
      // Floor support directly below the tunnel cell so requiresGround=false units
      // can rest in the tunnel; we leave the layer below as solid stone, which is
      // already the case from the fill loop. Just carve the tunnel cell itself.
      for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
        for (let dy = 0; dy < NAV_CELL_VOXELS; dy++) {
          for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
            v[worldIndex(x0 + dx, tunnelYBase + dy, tunnelZBase + dz)] = 0;
          }
        }
      }
    }
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(v, vnav);
    const ws = new AStar3DWorkspace();
    const r = findPathVolume(vnav, ws, {
      startCx: 5, startCy: 4, startCz: 64,
      goalCx: 120, goalCy: 4, goalCz: 64,
      canDig: false, requiresGround: false, footprintRadius: 1,
    });
    expect(r.reached).toBe(true);
    expect(r.cells.length).toBeGreaterThan(0);
    expect(r.cells[0]).toEqual({ cx: 5, cy: 4, cz: 64 });
    const last = r.cells[r.cells.length - 1]!;
    expect(last).toEqual({ cx: 120, cy: 4, cz: 64 });
  });

  it('routes a tunneler around a bedrock pillar that blocks the straight line', () => {
    // Solid stone with a bedrock pillar between start and goal — the tunneler
    // must re-route around it instead of bailing.
    const w = VoxelWorld.create(false);
    const v = w.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        v[worldIndex(x, 1, z)] = M_BEDROCK;
        for (let y = 2; y < 120; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Bedrock pillar at cell (40, 6, 40) — 1 cell on each side.
    const px = 40 * NAV_CELL_VOXELS;
    const py = 6 * NAV_CELL_VOXELS;
    const pz = 40 * NAV_CELL_VOXELS;
    for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
      for (let dy = 0; dy < NAV_CELL_VOXELS; dy++) {
        for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
          v[worldIndex(px + dx, py + dy, pz + dz)] = M_BEDROCK;
        }
      }
    }
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(v, vnav);
    const ws = new AStar3DWorkspace();
    const r = findPathVolume(vnav, ws, {
      startCx: 30, startCy: 6, startCz: 40,
      goalCx: 50, goalCy: 6, goalCz: 40,
      canDig: true, requiresGround: false, footprintRadius: 1,
    });
    expect(r.reached).toBe(true);
    // The bedrock pillar itself must not be on the route.
    expect(r.cells.some(c => c.cx === 40 && c.cy === 6 && c.cz === 40)).toBe(false);
  });
});

// Silence unused-import warnings for symbols we keep re-exported for clarity.
void WORLD_Y;
void VNAV_X;
void VNAV_Z;
