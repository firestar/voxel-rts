import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_BEDROCK, M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';
import { UnitManager, unitConfig } from '../src/sim/Units';
import {
  WORM_SEGMENT_COUNT, WORM_SEGMENT_SPACING,
  WORM_CUTTER_RADIUS, WORM_CUTTER_FORWARD,
  TUNNELER_CUTTER_RADIUS,
} from '../src/render/UnitModels';

function buildDirtWorld(surfaceY: number): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('worm unit config', () => {
  it('is a digger with a chain of trailing segments', () => {
    const cfg = unitConfig('worm');
    expect(cfg.canDig).toBe(true);
    expect(cfg.requiresGround).toBe(true);
    expect(cfg.segmentCount).toBe(WORM_SEGMENT_COUNT);
    expect(cfg.segmentSpacing).toBe(WORM_SEGMENT_SPACING);
    expect(cfg.cutterRadius).toBe(WORM_CUTTER_RADIUS);
    expect(cfg.cutterForward).toBe(WORM_CUTTER_FORWARD);
  });

  it('has a smaller cutter than the heavy TBM tunneler', () => {
    expect(unitConfig('worm').cutterRadius).toBeLessThan(TUNNELER_CUTTER_RADIUS);
  });

  it('non-diggers have no segments', () => {
    expect(unitConfig('soldier').segmentCount).toBe(0);
    expect(unitConfig('tank').segmentCount).toBe(0);
  });
});

describe('worm spawn', () => {
  it('spawns with WORM_SEGMENT_COUNT trailing segments', () => {
    const um = new UnitManager();
    const u = um.spawn('worm', 10, 5, 10);
    expect(u.segments.length).toBe(WORM_SEGMENT_COUNT);
  });

  it('initial segments are stretched out behind the head', () => {
    const um = new UnitManager();
    const u = um.spawn('worm', 10, 5, 10);
    // Heading 0 → forward = -Z, so segments trail to +Z.
    for (let i = 0; i < u.segments.length; i++) {
      const s = u.segments[i]!;
      expect(s.x).toBeCloseTo(10, 6);
      expect(s.z).toBeGreaterThan(10);
    }
    // Adjacent segments are spaced by WORM_SEGMENT_SPACING along Z.
    for (let i = 1; i < u.segments.length; i++) {
      const dz = u.segments[i]!.z - u.segments[i - 1]!.z;
      expect(dz).toBeCloseTo(WORM_SEGMENT_SPACING, 6);
    }
  });
});

describe('worm chain follows the head', () => {
  it('segment positions are pulled toward the head when it moves', () => {
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const startX = 40, startZ = 40;
    const headY = (surfaceY + 1) * VOXEL_SIZE;
    const u = um.spawn('worm', startX, headY, startZ);

    // Path the head a long way along +X. After many ticks the head will have moved
    // far from its spawn; the chain should be dragged along it.
    um.setPath(u, [{ x: startX + 30, y: headY, z: startZ }]);

    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
    }

    // Head must have advanced significantly along +X.
    expect(u.x).toBeGreaterThan(startX + 5);

    // Pull-only constraint: every adjacent link is at most WORM_SEGMENT_SPACING apart in
    // the horizontal plane (with a tiny epsilon for floating-point slack).
    let prevX = u.x, prevZ = u.z;
    for (const s of u.segments) {
      const d = Math.hypot(s.x - prevX, s.z - prevZ);
      expect(d).toBeLessThanOrEqual(WORM_SEGMENT_SPACING + 1e-3);
      prevX = s.x; prevZ = s.z;
    }
    // The chain has rotated to follow the head along +X — segment 0 sits behind the
    // head on the head's track (i.e. at smaller X than the head).
    expect(u.segments[0]!.x).toBeLessThan(u.x);
  });
});

describe('worm segment gravity', () => {
  it('a segment held above the surface falls and settles on the ground', () => {
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const headY = (surfaceY + 1) * VOXEL_SIZE;
    const u = um.spawn('worm', 40, headY, 40);

    // Put segment 0 floating well above the surface — well within the chain spacing
    // so the constraint doesn't tug it down by itself, but high enough that gravity
    // is the obvious explanation.
    u.segments[0]!.x = 40;
    u.segments[0]!.z = 41;
    u.segments[0]!.y = headY + 6.0;
    u.segments[0]!.vy = 0;

    const dt = 1 / 60;
    const startY = u.segments[0]!.y;
    for (let i = 0; i < 120; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
    }
    const expectedFloor = (surfaceY + 1) * VOXEL_SIZE;
    // Segment must have descended from its perched starting height.
    expect(u.segments[0]!.y).toBeLessThan(startY - 1.0);
    // And settled on top of the surface, never inside or below it.
    expect(u.segments[0]!.y).toBeGreaterThanOrEqual(expectedFloor - 1e-3);
    expect(u.segments[0]!.y).toBeLessThanOrEqual(expectedFloor + 0.4);
    expect(u.segments[0]!.vy).toBe(0);
  });

  it('an underground segment over a tunnel floor lands on the floor, not the surface', () => {
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;

    // Carve a wide air pocket buried well below the surface so isUnderground is true
    // for the segment but solid dirt remains far below as the floor.
    const cx = 60, cz = 60;
    for (let y = 30; y <= 70; y++) {
      for (let dz = -10; dz <= 10; dz++) {
        for (let dx = -10; dx <= 10; dx++) {
          voxels[worldIndex(cx + dx, y, cz + dz)] = 0;
        }
      }
    }
    // Plug a 1-voxel "tunnel floor" at y=29 (top of solid).
    const tunnelFloorY = 30 * VOXEL_SIZE; // air starts at y=30, top of solid voxel y=29
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    // Head sits underground in the air pocket. Its actual gravity / floor logic is
    // handled by tickVolume; we only care about a segment dropping toward the
    // tunnel floor here.
    const headY = 50 * VOXEL_SIZE;
    const u = um.spawn('worm', (cx + 0.5) * VOXEL_SIZE, headY, (cz + 0.5) * VOXEL_SIZE);
    // Place a segment in the air pocket above the tunnel floor.
    u.segments[0]!.x = (cx + 0.5) * VOXEL_SIZE;
    u.segments[0]!.z = (cz + 0.5) * VOXEL_SIZE;
    u.segments[0]!.y = 60 * VOXEL_SIZE;
    u.segments[0]!.vy = 0;

    const dt = 1 / 60;
    for (let i = 0; i < 240; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
    }
    // Segment 0 should have settled on the underground tunnel floor — way below the
    // surface, not floating.
    expect(u.segments[0]!.y).toBeGreaterThanOrEqual(tunnelFloorY - 1e-3);
    expect(u.segments[0]!.y).toBeLessThan((surfaceY + 1) * VOXEL_SIZE);
  });
});
