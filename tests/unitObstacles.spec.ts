import { describe, it, expect } from 'vitest';
import { allocateNav, buildSurfaceNav, navIndex, NAV_CELL_METERS } from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';
import { smoothPath } from '../src/path/Smooth';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_BEDROCK, M_STONE } from '../src/voxel/Materials';
import { UnitManager, BLOCKED_REPATH_FRAMES } from '../src/sim/Units';

const SURFACE_Y = 32;

function buildGrassPlane(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < SURFACE_Y; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, SURFACE_Y, z)] = M_GRASS;
    }
  }
  return world;
}

describe('A* respects unit obstacles', () => {
  it('routes around a cell listed in unitObstacles', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const startCx = 20, startCz = 40, goalCx = 60, goalCz = 40;
    // Reference path: straight east-west walk on the same row.
    const ref = findPathSurface(nav, ws, {
      startCx, startCz, goalCx, goalCz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    expect(ref.reached).toBe(true);
    // The unforced search hugs the row; pick the midpoint as the obstacle.
    const midCx = 40;
    const obstacleIdx = navIndex(midCx, startCz);

    const r = findPathSurface(nav, ws, {
      startCx, startCz, goalCx, goalCz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
      unitObstacles: [obstacleIdx],
    });
    expect(r.reached).toBe(true);
    for (const c of r.cells) {
      expect(c.cx === midCx && c.cz === startCz).toBe(false);
    }
  });

  it('exempts the start and goal cells even if listed as obstacles', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const startCx = 10, startCz = 10, goalCx = 20, goalCz = 20;
    const startIdx = navIndex(startCx, startCz);
    const goalIdx = navIndex(goalCx, goalCz);

    const r = findPathSurface(nav, ws, {
      startCx, startCz, goalCx, goalCz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
      unitObstacles: [startIdx, goalIdx],
    });
    expect(r.reached).toBe(true);
    expect(r.cells[0]).toEqual({ cx: startCx, cz: startCz });
    expect(r.cells[r.cells.length - 1]).toEqual({ cx: goalCx, cz: goalCz });
  });

  it('blocks a diagonal corner cut when both flanking cells are unit-blocked', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    // Start at (20, 20), goal at (22, 22). The diagonal step (21,21) would
    // normally be reached via (20,20) → (21,21). Block both cardinals (21,20)
    // and (20,21) — the search must fall back to a longer route.
    const r = findPathSurface(nav, ws, {
      startCx: 20, startCz: 20,
      goalCx: 22, goalCz: 22,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
      unitObstacles: [navIndex(21, 20), navIndex(20, 21)],
    });
    expect(r.reached).toBe(true);
    // No two consecutive cells may form the (20,20) → (21,21) shortcut step.
    for (let i = 1; i < r.cells.length; i++) {
      const a = r.cells[i - 1]!;
      const b = r.cells[i]!;
      const isCorner = a.cx === 20 && a.cz === 20 && b.cx === 21 && b.cz === 21;
      expect(isCorner).toBe(false);
    }
  });

  it('smoother does not slice through a unit-blocked cell', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const startCx = 20, startCz = 30, goalCx = 60, goalCz = 30;
    const obstacleCx = 40;
    const r = findPathSurface(nav, ws, {
      startCx, startCz, goalCx, goalCz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
      unitObstacles: [navIndex(obstacleCx, startCz)],
    });
    expect(r.reached).toBe(true);

    // Smoother gets the same mask via ws.unitBlock — collapsing the path must
    // still avoid the obstacle row cell.
    const smoothed = smoothPath(
      nav, r.cells, 1, 16, 0, 999, 0, ws.unitBlock,
    );
    // No segment endpoint may be the obstacle cell itself…
    for (const c of smoothed) {
      expect(c.cx === obstacleCx && c.cz === startCz).toBe(false);
    }
    // …and no straight segment may horizontally span past it on the same row.
    for (let i = 1; i < smoothed.length; i++) {
      const a = smoothed[i - 1]!;
      const b = smoothed[i]!;
      if (a.cz === startCz && b.cz === startCz) {
        const lo = Math.min(a.cx, b.cx), hi = Math.max(a.cx, b.cx);
        expect(lo <= obstacleCx - 1 && hi >= obstacleCx + 1).toBe(false);
      }
    }
  });

  it('clears the obstacle mask between calls so a stale mark never sticks', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ws = new AStarWorkspace();

    const startCx = 5, startCz = 5, goalCx = 30, goalCz = 5;
    // Plant an obstacle directly on the line, then call again with no obstacles.
    const r1 = findPathSurface(nav, ws, {
      startCx, startCz, goalCx, goalCz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
      unitObstacles: [navIndex(15, 5)],
    });
    expect(r1.reached).toBe(true);

    const r2 = findPathSurface(nav, ws, {
      startCx, startCz, goalCx, goalCz,
      footprintRadius: 1, maxStepVoxels: 16, slopePenalty: 0.15,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999, headroomVoxels: 0, prefersRoads: false,
    });
    expect(r2.reached).toBe(true);
    // Without obstacles the straight-line path can pass right through (15,5);
    // having r1 leave its mark behind would force r2 onto a detour.
    let touched = false;
    for (const c of r2.cells) if (c.cx === 15 && c.cz === 5) { touched = true; break; }
    expect(touched).toBe(true);
  });
});

describe('blocked unit signals a re-path request', () => {
  it('latches needsRepath after BLOCKED_REPATH_FRAMES of collision-stalling', () => {
    const world = buildGrassPlane();
    // Wall the parked tank in on both perpendicular flanks so the sidestep
    // nudge can't place a valid foothold — that forces the older fallback
    // (blocked-frames latch) to fire. Walls span the whole nav cells +Z and
    // -Z of the parked tank's cell (60, 60); each nav cell is 8 voxels.
    const v = world.buffers.voxels;
    for (const cellDz of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      for (let cellDx = -3; cellDx <= 3; cellDx++) {
        const cellX = 60 + cellDx;
        const cellZ = 60 + cellDz;
        for (let dx = 0; dx < 8; dx++) {
          for (let dz = 0; dz < 8; dz++) {
            for (let y = SURFACE_Y + 1; y <= SURFACE_Y + 12; y++) {
              v[worldIndex(cellX * 8 + dx, y, cellZ * 8 + dz)] = M_STONE;
            }
          }
        }
      }
    }
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const surfaceM = (SURFACE_Y + 1) * VOXEL_SIZE;
    // Parked tank in the chokepoint, mover tank pointed straight at it.
    const parked = um.spawn('tank', 60 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const mover = um.spawn('tank', 55 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    um.setPath(mover, [{ x: parked.x, y: parked.y, z: parked.z }]);

    const dt = 1 / 60;
    let latchedAtFrame = -1;
    let firstCollisionFrame = -1;
    // Tanks turn slowly + travel ~5m before contact, so the latch may not arrive
    // for a few seconds. The give-up timer doesn't drop the path until ~240
    // collision frames, so a 600-frame budget covers the latch comfortably.
    for (let i = 0; i < 600; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      if (mover.blockedFrames > 0 && firstCollisionFrame < 0) firstCollisionFrame = i;
      if (mover.needsRepath && latchedAtFrame < 0) {
        latchedAtFrame = i;
        // Simulate the harness consuming the flag; setPath would normally do
        // this, but here we just clear it so we can verify the test is
        // measuring the first latch, not later ones.
        mover.needsRepath = false;
        break;
      }
    }
    expect(firstCollisionFrame).toBeGreaterThanOrEqual(0);
    expect(latchedAtFrame).toBeGreaterThanOrEqual(0);
    // Latch arrives BLOCKED_REPATH_FRAMES frames after the first collision.
    expect(latchedAtFrame - firstCollisionFrame).toBe(BLOCKED_REPATH_FRAMES - 1);
    // Mover must still have a path at the latch instant — repath fires well
    // before the give-up timer (240 frames) drops the path.
    expect(mover.path.length).toBeGreaterThan(0);
    // Parked tank should not have moved.
    expect(parked.x).toBeCloseTo(60 * NAV_CELL_METERS, 5);
    expect(parked.z).toBeCloseTo(60 * NAV_CELL_METERS, 5);
  });
});
