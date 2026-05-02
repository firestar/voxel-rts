import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit, GRID_X } from '../src/path/Pathfinder';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';

const NAV_CELL_VOXELS = 8;
const SURFACE_VY = 64; // 8 m

function buildLayeredWorld(world: VoxelWorld): void {
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      for (let y = 1; y < SURFACE_VY; y++) v[worldIndex(x, y, z)] = M_STONE;
      for (let y = SURFACE_VY; y < SURFACE_VY + 4; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, SURFACE_VY + 4, z)] = M_GRASS;
    }
  }
}

/**
 * Drop a stone wall on top of the existing grass surface. The wall is one nav
 * cell wide along z=cellZ (so it spans 8 voxels at zStart..zStart+8 on the z
 * axis), runs from xStart to xEnd along x, and rises `wallVoxelsAbove` above
 * the surface. If a `gapCellX` is given, that 2-cell-wide range of x cells is
 * left clear so a path can squeeze through.
 */
function buildWall(
  world: VoxelWorld,
  cellZ: number,
  xStart: number,
  xEnd: number,
  wallVoxelsAbove: number,
  gapCellX: number | null,
): void {
  const v = world.buffers.voxels;
  const surfTop = SURFACE_VY + 4; // grass voxel
  const wallTop = surfTop + 1 + wallVoxelsAbove;
  const zVoxStart = cellZ * NAV_CELL_VOXELS;
  const zVoxEnd = zVoxStart + NAV_CELL_VOXELS;
  for (let cx = xStart; cx <= xEnd; cx++) {
    if (gapCellX !== null && Math.abs(cx - gapCellX) <= 1) continue; // 2-cell gap (cx-1, cx, cx+1)
    const xVoxStart = cx * NAV_CELL_VOXELS;
    const xVoxEnd = xVoxStart + NAV_CELL_VOXELS;
    for (let z = zVoxStart; z < zVoxEnd; z++) {
      for (let x = xVoxStart; x < xVoxEnd; x++) {
        for (let y = surfTop + 1; y <= wallTop; y++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
  }
}

const SOLDIER = profileFromUnit({
  kind: 'soldier',
  footprintRadius: 1,
  heightVoxels: 14,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 6,
  slopePenalty: 0,
});
const TANK = profileFromUnit({
  kind: 'tank',
  footprintRadius: 2,
  heightVoxels: 18,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 4,
  slopePenalty: 0,
});
const DOZER = profileFromUnit({
  kind: 'dozer',
  footprintRadius: 2,
  heightVoxels: 16,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 4,
  slopePenalty: 0,
});
const WORKER = profileFromUnit({
  kind: 'worker',
  footprintRadius: 1,
  heightVoxels: 14,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 6,
  slopePenalty: 0,
});

describe('largeMapObstacles', () => {
  it('every unit kind reaches the goal through a single gap in a long wall', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    // Wall on row cellZ=64, from cellX=30 to cellX=90 (60 cells long). 24
    // voxels (3 cells) above surface — tall enough that no unit can stand on
    // top within their step-climb budget, so the gap is the only way through.
    // Gap centered at cellX=72 — off-center so a straight line is *not* the
    // shortest path.
    const wallZ = 64;
    const gapCx = 72;
    buildWall(world, wallZ, 30, 90, 24, gapCx);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    pf.registerProfile(TANK);
    pf.registerProfile(DOZER);
    pf.registerProfile(WORKER);

    // Start on the south side of the wall, goal on the north side.
    const startMeters = { x: 50.5, z: 56.5 };
    const goalMeters = { x: 50.5, z: 72.5 };

    function plan(kind: string) {
      const start = pf.groundCellAt(kind, startMeters.x, startMeters.z);
      const goal = pf.groundCellAt(kind, goalMeters.x, goalMeters.z);
      expect(start).not.toBeNull();
      expect(goal).not.toBeNull();
      return pf.findPath(kind, { start: start!, goal: goal!, maxExpansions: 100000 });
    }

    const sol = plan('soldier');
    const tank = plan('tank');
    const dozer = plan('dozer');
    const worker = plan('worker');

    expect(sol.reached).toBe(true);
    expect(tank.reached).toBe(true);
    expect(dozer.reached).toBe(true);
    expect(worker.reached).toBe(true);

    // Each path crosses the wall row at cellZ ~ wallZ via the gap. We accept
    // any cell in [gapCx-2, gapCx+2] at z within [wallZ-1, wallZ+1] (the
    // wall body sits across cz=wallZ but the unit may pass on an adjacent
    // cell depending on footprint).
    for (const [name, p] of [
      ['soldier', sol],
      ['tank', tank],
      ['dozer', dozer],
      ['worker', worker],
    ] as const) {
      const usedGap = p.cells.some(c =>
        Math.abs(c.cx - gapCx) <= 2 &&
        Math.abs(c.cz - wallZ) <= 2,
      );
      expect(usedGap, `${name} path did not pass through the gap`).toBe(true);
    }

    // Single-cell units (soldier, worker) should not have a *longer* path
    // than the wider-footprint units — wider footprints can be detoured
    // further by the wall.
    expect(sol.cells.length).toBeLessThanOrEqual(tank.cells.length);
    expect(worker.cells.length).toBeLessThanOrEqual(dozer.cells.length);
  });

  it('a fully blocking wall reports reached=false for every unit kind', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    // Same tall wall but no gap.
    buildWall(world, 64, 0, GRID_X_END, 24, null);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    pf.registerProfile(TANK);
    pf.registerProfile(DOZER);
    pf.registerProfile(WORKER);

    function plan(kind: string) {
      const start = pf.groundCellAt(kind, 50.5, 56.5);
      const goal = pf.groundCellAt(kind, 50.5, 72.5);
      // Start and goal must both fit; for a single-cell soldier the goal
      // should still find the surface on the far side.
      expect(start).not.toBeNull();
      expect(goal).not.toBeNull();
      return pf.findPath(kind, { start: start!, goal: goal!, maxExpansions: 100000 });
    }

    expect(plan('soldier').reached).toBe(false);
    expect(plan('tank').reached).toBe(false);
    expect(plan('dozer').reached).toBe(false);
    expect(plan('worker').reached).toBe(false);
  });
});

// Wall covering the full grid width, less the very edges so footprint padding works.
const GRID_X_END = GRID_X - 1;
