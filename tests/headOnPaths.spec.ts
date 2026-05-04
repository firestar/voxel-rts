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

/**
 * Two units approach each other along the same Z lane on opposing paths so
 * their routes meet at the midpoint. The collision-avoidance system should
 * make them steer around each other — each one keeps making forward progress
 * toward its goal, no backwards motion, no permanent stop. Lateral (Z)
 * deflection is expected.
 */
describe('head-on path crossing', () => {
  it('two soldiers on opposing paths pass each other and reach their goals', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const y = (SURFACE_Y + 1) * VOXEL_SIZE;
    // Same Z lane (cell row 60), 14 nav cells apart along X.
    const z = 60 * NAV_CELL_METERS;
    const xLeft = 50 * NAV_CELL_METERS;
    const xRight = 64 * NAV_CELL_METERS;
    const a = um.spawn('soldier', xLeft, y, z)!;
    const b = um.spawn('soldier', xRight, y, z)!;
    // Opposing one-waypoint paths. Each unit's goal is the other unit's
    // starting cell — with no avoidance they'd collide head-on.
    um.setPath(a, [{ x: xRight, y, z }]);
    um.setPath(b, [{ x: xLeft, y, z }]);

    const startA = { x: a.x, z: a.z };
    const startB = { x: b.x, z: b.z };

    const dt = 1 / 60;
    // Track per-unit minimum forward progress so we can assert "no backwards
    // motion" — A moves +X, B moves -X. Allow only a small jitter tolerance
    // (collision deflection can micro-rebound, but no big retreat).
    let aMinForward = 0;     // worst (least) gain in X for A so far
    let bMinForward = 0;     // worst (least) gain in -X for B so far
    let lateralA = 0;        // how far A has deflected in Z from its lane
    let lateralB = 0;
    let bothReached = false;
    for (let i = 0; i < 2400; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      const dxA = a.x - startA.x;          // positive when A makes progress (toward +X)
      const dxB = startB.x - b.x;          // positive when B makes progress (toward -X)
      if (dxA < aMinForward) aMinForward = dxA;
      if (dxB < bMinForward) bMinForward = dxB;
      lateralA = Math.max(lateralA, Math.abs(a.z - startA.z));
      lateralB = Math.max(lateralB, Math.abs(b.z - startB.z));
      if (
        a.path.length === 0 && Math.hypot(a.x - xRight, a.z - z) < 1.0 &&
        b.path.length === 0 && Math.hypot(b.x - xLeft,  b.z - z) < 1.0
      ) {
        bothReached = true;
        break;
      }
    }
    expect(bothReached).toBe(true);
    // No major backwards motion: each soldier may rebound up to ~0.4 m
    // during avoidance but never significantly retreats from its goal.
    expect(aMinForward).toBeGreaterThan(-0.4);
    expect(bMinForward).toBeGreaterThan(-0.4);
    // They actually steered around each other — non-trivial lateral motion.
    expect(Math.max(lateralA, lateralB)).toBeGreaterThan(0.15);
    // Final separation: each soldier ended near its own goal.
    expect(Math.hypot(a.x - xRight, a.z - z)).toBeLessThan(1.0);
    expect(Math.hypot(b.x - xLeft,  b.z - z)).toBeLessThan(1.0);
  });

  it('two supply trucks on opposing paths pass each other without backing up', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const y = (SURFACE_Y + 1) * VOXEL_SIZE;
    // Same Z lane, but spaced wider than the soldier case because supply
    // trucks have a 3-cell footprint and need room to manoeuvre.
    const z = 60 * NAV_CELL_METERS;
    const xLeft = 48 * NAV_CELL_METERS;
    const xRight = 72 * NAV_CELL_METERS;
    const a = um.spawn('supply_truck', xLeft, y, z)!;
    const b = um.spawn('supply_truck', xRight, y, z)!;
    um.setPath(a, [{ x: xRight, y, z }]);
    um.setPath(b, [{ x: xLeft, y, z }]);

    const startA = { x: a.x, z: a.z };
    const startB = { x: b.x, z: b.z };

    const dt = 1 / 60;
    let aMinForward = 0;
    let bMinForward = 0;
    let bothReached = false;
    for (let i = 0; i < 6000; i++) {
      um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
      const dxA = a.x - startA.x;
      const dxB = startB.x - b.x;
      if (dxA < aMinForward) aMinForward = dxA;
      if (dxB < bMinForward) bMinForward = dxB;
      if (
        a.path.length === 0 && Math.hypot(a.x - xRight, a.z - z) < 2.0 &&
        b.path.length === 0 && Math.hypot(b.x - xLeft,  b.z - z) < 2.0
      ) {
        bothReached = true;
        break;
      }
    }
    expect(bothReached).toBe(true);
    expect(aMinForward).toBeGreaterThan(-0.6);
    expect(bMinForward).toBeGreaterThan(-0.6);
    // Final separation: each truck ended near its own goal.
    expect(Math.hypot(a.x - xRight, a.z - z)).toBeLessThan(2.0);
    expect(Math.hypot(b.x - xLeft,  b.z - z)).toBeLessThan(2.0);
    // Trucks pass through each other since they clip same-team movers — the
    // important contract is they DIDN'T retreat and DID arrive. Lateral
    // motion isn't required for this case because clip-through trumps
    // deflection for automated logistics.
  });
});
