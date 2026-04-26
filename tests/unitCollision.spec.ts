import { describe, it, expect } from 'vitest';
import { UnitManager } from '../src/sim/Units';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_BEDROCK } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_METERS } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';

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

describe('unit-vs-unit surface collision', () => {
  it('a moving soldier stops short of a parked soldier instead of phasing through', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    // Two soldiers on the surface. Parked soldier sits at (60, 60), moving
    // soldier starts at (50, 60) and is given a one-shot waypoint at the
    // parked soldier's foot position. Without collision the moving soldier
    // would walk straight through and end up on top of the parked one.
    const surfaceM = (SURFACE_Y + 1) * VOXEL_SIZE;
    const parked = um.spawn('soldier', 60 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const mover = um.spawn('soldier', 50 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    um.setPath(mover, [{ x: parked.x, y: parked.y, z: parked.z }]);

    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      // Stop early once the mover is clearly stationary against the parked
      // soldier (path dropped on collision give-up timer).
      if (mover.path.length === 0) break;
    }

    const dx = mover.x - parked.x;
    const dz = mover.z - parked.z;
    const dist = Math.hypot(dx, dz);
    // Soldier collision radius is widthMeters * 0.45 ≈ 0.34 m, clamped to
    // 0.3 m. Two soldiers must end up at least ~0.6 m apart (sum of radii).
    expect(dist).toBeGreaterThan(0.5);
    // And the parked soldier should not have been displaced.
    expect(parked.x).toBeCloseTo(60 * NAV_CELL_METERS, 5);
    expect(parked.z).toBeCloseTo(60 * NAV_CELL_METERS, 5);
  });

  it('the give-up timer drops the path when stuck behind a parked unit', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const surfaceM = (SURFACE_Y + 1) * VOXEL_SIZE;
    const parked = um.spawn('tank', 60 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const mover = um.spawn('tank', 55 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    um.setPath(mover, [{ x: parked.x, y: parked.y, z: parked.z }]);

    const dt = 1 / 60;
    let dropped = false;
    for (let i = 0; i < 1200; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      if (mover.path.length === 0) { dropped = true; break; }
    }
    expect(dropped).toBe(true);
  });
});
