import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_BEDROCK, M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';
import { UnitManager, CarveRequest } from '../src/sim/Units';
import { TUNNELER_CUTTER_HEIGHT } from '../src/render/UnitModels';

/**
 * Drive a tunneler through a single UnitManager.tick() and capture both the
 * post-tick unit state and any CarveRequests that were emitted. The test world
 * is just a slab of dirt with a small air pocket so we can position the unit
 * underground in air and aim its path wherever we like.
 */
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

describe('tunneler cutter — dig-down floor exception', () => {
  it('drops the floor guard when the dig direction has a downward component', () => {
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;

    // Carve a single-cell air pocket centered at (cx, cy, cz). The tunneler stands
    // here; the cell directly below is solid, so a path waypoint pointing down
    // will be in solid material → tickVolume runs the carving branch.
    const cx = 64, cz = 64;
    const cy = 60;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          voxels[worldIndex(cx + dx, cy + dy, cz + dz)] = 0; // AIR
        }
      }
    }

    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const ux = (cx + 0.5) * VOXEL_SIZE;
    const uy = (cy + 0.5) * VOXEL_SIZE - TUNNELER_CUTTER_HEIGHT;
    const uz = (cz + 0.5) * VOXEL_SIZE;
    const u = um.spawn('tunneler', ux, uy, uz);

    // Path target straight down, several metres into the dirt below the pocket.
    um.setPath(u, [{ x: ux, y: uy - 4.0, z: uz }]);

    const carves: CarveRequest[] = [];
    um.tick(1 / 60, nav, vnav, voxels, (req) => {
      if (req.kind === 'carve') carves.push(req);
    });

    expect(carves.length).toBeGreaterThan(0);
    const c = carves[0]!;
    // Direction must be downward (axisY < 0) and the floor guard must be lifted
    // (-Infinity) so the cylinder is free to chew below the unit's feet.
    expect(c.axisY).toBeLessThan(0);
    expect(c.floorMeters).toBe(-Infinity);
  });

  it('keeps the floor guard at u.y for forward / upward digs', () => {
    const surfaceY = 96;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;

    const cx = 64, cz = 64;
    const cy = 60;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          voxels[worldIndex(cx + dx, cy + dy, cz + dz)] = 0;
        }
      }
    }

    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const ux = (cx + 0.5) * VOXEL_SIZE;
    const uy = (cy + 0.5) * VOXEL_SIZE - TUNNELER_CUTTER_HEIGHT;
    const uz = (cz + 0.5) * VOXEL_SIZE;
    const u = um.spawn('tunneler', ux, uy, uz);

    // Path target straight forward (+X), into solid dirt at the same Y.
    um.setPath(u, [{ x: ux + 4.0, y: uy, z: uz }]);

    const carves: CarveRequest[] = [];
    um.tick(1 / 60, nav, vnav, voxels, (req) => {
      if (req.kind === 'carve') carves.push(req);
    });

    expect(carves.length).toBeGreaterThan(0);
    const c = carves[0]!;
    expect(c.axisY).toBe(0);
    expect(c.floorMeters).toBe(u.y);
  });
});

describe('underground unit gravity', () => {
  it('a tunneler over an empty shaft accelerates downward under gravity', () => {
    // Build a normal dirt world, then carve a buried air pocket: a wide shaft
    // through the lower half of the dirt slab, but leave the upper dirt + grass
    // intact so the surface nav still sees a high topY above the unit (i.e.
    // isUnderground reports true). The bedrock at y=0,1 is the eventual floor.
    const surfaceY = 150;
    const world = buildDirtWorld(surfaceY);
    const voxels = world.buffers.voxels;
    const cx = 64, cz = 64;
    // Shaft x/z extent: ±20 voxels so the volume nav's 8-voxel cells around the
    // unit are completely air — no solid bits in the cells the unit traverses.
    // Shaft y extent: 4..70 — well below the surface (y=150) so the column above
    // remains solid dirt, keeping isUnderground true.
    for (let y = 4; y <= 70; y++) {
      for (let dz = -20; dz <= 20; dz++) {
        for (let dx = -20; dx <= 20; dx++) {
          voxels[worldIndex(cx + dx, y, cz + dz)] = 0;
        }
      }
    }

    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    // Place the tunneler near the top of the air pocket and aim a path waypoint
    // straight down toward the bottom of the shaft. tickVolume's clear branch
    // runs (target cell is air), then the underground gravity branch should
    // take over for the Y axis.
    const startY = 60 * VOXEL_SIZE; // 7.5 m, mid-shaft
    const u = um.spawn(
      'tunneler',
      (cx + 0.5) * VOXEL_SIZE,
      startY,
      (cz + 0.5) * VOXEL_SIZE,
    );
    um.setPath(u, [{
      x: (cx + 0.5) * VOXEL_SIZE,
      y: 8 * VOXEL_SIZE,
      z: (cz + 0.5) * VOXEL_SIZE,
    }]);

    const dt = 1 / 60;
    let prevVy = u.vy;
    let prevY = u.y;
    for (let i = 0; i < 30; i++) {
      um.tick(dt, nav, vnav, voxels, () => { /* no carves expected — shaft is air */ });
      // While not yet at terminal velocity, vy this frame must be strictly more
      // negative than last frame.
      if (u.vy > -u.terminalFallSpeed + 0.5) {
        expect(u.vy).toBeLessThan(prevVy + 1e-6);
      }
      // And the unit must be lower than it was last frame.
      expect(u.y).toBeLessThan(prevY + 1e-6);
      prevVy = u.vy;
      prevY = u.y;
    }
    // Sanity: after 30 frames (~0.5 s) the unit should have moved a measurable
    // distance and built up real downward velocity.
    expect(u.y).toBeLessThan(startY - 1.0);
    expect(u.vy).toBeLessThan(-5.0);
  });

  it('terminal fall speed scales with mass: tunneler > tank > soldier', () => {
    const um = new UnitManager();
    const s = um.spawn('soldier',  0, 0, 0);
    const t = um.spawn('tank',     0, 0, 0);
    const d = um.spawn('tunneler', 0, 0, 0);
    expect(d.massKg).toBeGreaterThan(t.massKg);
    expect(t.massKg).toBeGreaterThan(s.massKg);
    expect(d.terminalFallSpeed).toBeGreaterThan(t.terminalFallSpeed);
    expect(t.terminalFallSpeed).toBeGreaterThan(s.terminalFallSpeed);
  });
});
