import { describe, it, expect } from 'vitest';
import { UnitManager } from '../src/sim/Units';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_BEDROCK, M_STONE } from '../src/voxel/Materials';
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
  it('a parked soldier sidesteps so a moving soldier can pass on its path', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const surfaceM = (SURFACE_Y + 1) * VOXEL_SIZE;
    const parked = um.spawn('soldier', 60 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const mover = um.spawn('soldier', 50 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const goalX = 70 * NAV_CELL_METERS;
    const goalZ = 60 * NAV_CELL_METERS;
    um.setPath(mover, [{ x: goalX, y: parked.y, z: goalZ }]);
    const startedAt = { x: parked.x, z: parked.z };

    const dt = 1 / 60;
    let reached = false;
    for (let i = 0; i < 1200; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      if (mover.path.length === 0 && Math.hypot(mover.x - goalX, mover.z - goalZ) < 0.5) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    // The parked soldier must have stepped clear of the mover's line. Lateral
    // displacement (perpendicular to the +X travel direction = the Z axis) is
    // what matters; the sidestep nudge picks one body-width perpendicular.
    expect(Math.abs(parked.z - startedAt.z)).toBeGreaterThan(0.4);
    // And the mover should not be sitting on top of the (now-displaced) parked
    // unit — both should have ended up clearly separated.
    expect(Math.hypot(mover.x - parked.x, mover.z - parked.z)).toBeGreaterThan(0.5);
  });

  it('a parked tank in the way is nudged aside so the mover reaches its goal', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const surfaceM = (SURFACE_Y + 1) * VOXEL_SIZE;
    const parked = um.spawn('tank', 60 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const mover = um.spawn('tank', 55 * NAV_CELL_METERS, surfaceM, 60 * NAV_CELL_METERS);
    const startedAt = { x: parked.x, z: parked.z };
    const goalX = 70 * NAV_CELL_METERS;
    const goalZ = 60 * NAV_CELL_METERS;
    um.setPath(mover, [{ x: goalX, y: parked.y, z: goalZ }]);

    const dt = 1 / 60;
    let reached = false;
    for (let i = 0; i < 1800; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      if (mover.path.length === 0 && Math.hypot(mover.x - goalX, mover.z - goalZ) < 1.0) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    // Parked tank stepped off the path line.
    expect(Math.hypot(parked.x - startedAt.x, parked.z - startedAt.z)).toBeGreaterThan(0.8);
  });

  it('keeps retrying when the parked unit has nowhere to step aside', () => {
    // Walls fill nav cells flanking the parked soldier on +Z and -Z so the
    // sidestep nudge has no valid foothold. With the mover approaching along
    // +X, both perpendicular candidates land on stone. The mover must keep
    // its path (continuous reroute) and must not teleport through the parked unit.
    const world = buildGrassPlane();
    const v = world.buffers.voxels;
    for (const cellDz of [-1, 1]) {
      for (let cellDx = -1; cellDx <= 1; cellDx++) {
        const cellX = 60 + cellDx;
        const cellZ = 60 + cellDz;
        for (let dx = 0; dx < 8; dx++) {
          for (let dz = 0; dz < 8; dz++) {
            for (let y = SURFACE_Y + 1; y <= SURFACE_Y + 8; y++) {
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
    const parked = um.spawn('soldier',
      (60 * 8 + 4) * VOXEL_SIZE, surfaceM, (60 * 8 + 4) * VOXEL_SIZE);
    const mover = um.spawn('soldier',
      (50 * 8 + 4) * VOXEL_SIZE, surfaceM, (60 * 8 + 4) * VOXEL_SIZE);
    um.setPath(mover, [{ x: parked.x, y: parked.y, z: parked.z }]);

    const dt = 1 / 60;
    // Run well past the old give-up window (240 frames). The mover must keep
    // its path and not clip through the parked unit.
    for (let i = 0; i < 600; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
    }
    // Mover still has a path — continuously rerouting, not abandoned.
    expect(mover.path.length).toBeGreaterThan(0);
    // Parked soldier had no walkable sidestep — must still be where it started.
    expect(parked.x).toBeCloseTo((60 * 8 + 4) * VOXEL_SIZE, 5);
    expect(parked.z).toBeCloseTo((60 * 8 + 4) * VOXEL_SIZE, 5);
  });
});
