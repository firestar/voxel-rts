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

  it('seeds a path history covering the full chain length', () => {
    const um = new UnitManager();
    const u = um.spawn('worm', 10, 5, 10);
    // History must extend back at least the full chain reach so the very first
    // tickWormChain can place every segment without needing to extrapolate.
    let acc = 0;
    let prevX = u.x, prevY = u.y, prevZ = u.z;
    for (const b of u.pathHistory) {
      acc += Math.hypot(b.x - prevX, b.y - prevY, b.z - prevZ);
      prevX = b.x; prevY = b.y; prevZ = b.z;
    }
    expect(acc).toBeGreaterThan(WORM_SEGMENT_COUNT * WORM_SEGMENT_SPACING);
  });
});

describe('worm chain follows the head', () => {
  it('every segment is exactly WORM_SEGMENT_SPACING of arc length apart', () => {
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

    // Path the head a long way along +X.
    um.setPath(u, [{ x: startX + 30, y: headY, z: startZ }]);

    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
    }

    // Head must have advanced significantly along +X.
    expect(u.x).toBeGreaterThan(startX + 5);

    // Each adjacent link is WORM_SEGMENT_SPACING apart in 3D (path-exact placement,
    // not pull-only — so this is an equality check, not just an upper bound).
    let prevX = u.x, prevY = u.y, prevZ = u.z;
    for (const s of u.segments) {
      const d = Math.hypot(s.x - prevX, s.y - prevY, s.z - prevZ);
      expect(d).toBeCloseTo(WORM_SEGMENT_SPACING, 3);
      prevX = s.x; prevY = s.y; prevZ = s.z;
    }
    // Chain has rotated to follow the head along +X — segment 0 sits behind the
    // head on the head's track (i.e. at smaller X than the head).
    expect(u.segments[0]!.x).toBeLessThan(u.x);
  });

  it('every segment lies on a position the head actually visited (no corner-cutting)', () => {
    // The head is dragged through a sharp 90° turn. Each segment must trace the
    // exact same path — landing on points the head was at earlier — instead of
    // cutting the inside of the corner like a pull-only chain would.
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const startX = 60, startZ = 60;
    const headY = (surfaceY + 1) * VOXEL_SIZE;
    const u = um.spawn('worm', startX, headY, startZ);

    // Drive the head straight along +X for ~12 m, then turn hard onto +Z. Record
    // every head position we observe so we can check segment placement against it.
    const trail: { x: number; y: number; z: number }[] = [{ x: u.x, y: u.y, z: u.z }];
    const dt = 1 / 60;

    um.setPath(u, [{ x: startX + 12, y: headY, z: startZ }]);
    for (let i = 0; i < 400 && u.path.length > 0; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
      trail.push({ x: u.x, y: u.y, z: u.z });
    }
    um.setPath(u, [{ x: startX + 12, y: headY, z: startZ + 12 }]);
    for (let i = 0; i < 400 && u.path.length > 0; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
      trail.push({ x: u.x, y: u.y, z: u.z });
    }

    // For every segment, find the closest point on the recorded head trail. With
    // exact path-following, the maximum distance from the head's actual track must
    // be small (a corner-cutting chain would jump straight across the L and miss
    // the trail by several meters at the bend).
    for (const s of u.segments) {
      let best = Infinity;
      for (const p of trail) {
        const d = Math.hypot(s.x - p.x, s.z - p.z);
        if (d < best) best = d;
      }
      // Tolerance: PATH_HISTORY_STEP_MIN (0.15 m) plus a small slack — the segment
      // sits between two breadcrumbs, never far from the head's recorded track.
      expect(best).toBeLessThan(0.3);
    }
  });

  it('segment Y mirrors the head Y profile when the head climbs', () => {
    // Head surfaces from underground up to the surface. With path-following each
    // segment passes through the same Y profile a moment later — so segments
    // further back are at lower Y than segments closer to the head.
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const startX = 60, startZ = 60;
    const headY = (surfaceY + 1) * VOXEL_SIZE;
    const u = um.spawn('worm', startX, headY, startZ);

    // Manually crank the head Y up a step at a time as we tick — emulates a climb
    // out of a freshly carved shaft. We don't carve here; we just want to check
    // that segments inherit the head's Y trajectory along the breadcrumb trail.
    const dt = 1 / 60;
    for (let i = 0; i < 200; i++) {
      // Advance head along +X and step Y up over the run.
      u.x += 0.05;
      u.y = headY + (i * 0.02);
      um.tick(dt, nav, vnav, voxels, () => { /* no-op carve */ });
    }

    // The head ended at the highest Y it ever held. Segments behind the head
    // should be at lower Y (they're sitting on parts of the trail recorded
    // earlier in the climb), and progressively lower the further back you go.
    for (let i = 1; i < u.segments.length; i++) {
      expect(u.segments[i]!.y).toBeLessThanOrEqual(u.segments[i - 1]!.y + 1e-3);
    }
    expect(u.segments[u.segments.length - 1]!.y).toBeLessThan(u.y);
  });
});
