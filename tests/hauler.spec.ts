import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, WORLD_Y, AIR, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT, M_GRASS, M_BEDROCK } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';
import { UnitManager, ScoopRequest, DumpRequest } from '../src/sim/Units';

function buildSlabWorld(slabY: number): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < slabY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, slabY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('VoxelWorld.scoopColumn', () => {
  it('removes voxels from the top of the column down to a non-bedrock floor', () => {
    const slabY = 80;
    const world = buildSlabWorld(slabY);
    const v = world.buffers.voxels;
    const taken = world.scoopColumn(120, 120, 5);
    expect(taken).toBe(5);
    // Top 5 voxels (slabY .. slabY-4) must now be AIR.
    for (let dy = 0; dy < 5; dy++) {
      expect(v[worldIndex(120, slabY - dy, 120)]).toBe(AIR);
    }
    // The next voxel below should still be solid dirt.
    expect(v[worldIndex(120, slabY - 5, 120)]).toBe(M_DIRT);
  });

  it('stops at bedrock', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    v[worldIndex(50, 0, 50)] = M_BEDROCK;
    v[worldIndex(50, 1, 50)] = M_BEDROCK;
    v[worldIndex(50, 2, 50)] = M_DIRT;
    v[worldIndex(50, 3, 50)] = M_DIRT;
    const taken = world.scoopColumn(50, 50, 100);
    expect(taken).toBe(2);
    // Bedrock is intact.
    expect(v[worldIndex(50, 0, 50)]).toBe(M_BEDROCK);
    expect(v[worldIndex(50, 1, 50)]).toBe(M_BEDROCK);
  });

  it('returns 0 for an empty column', () => {
    const world = VoxelWorld.create(false);
    const taken = world.scoopColumn(10, 10, 5);
    expect(taken).toBe(0);
  });
});

describe('VoxelWorld.dumpColumn', () => {
  it('stacks voxels of the requested material on top of the column', () => {
    const slabY = 60;
    const world = buildSlabWorld(slabY);
    const v = world.buffers.voxels;
    const placed = world.dumpColumn(140, 140, 4, M_DIRT);
    expect(placed).toBe(4);
    for (let i = 1; i <= 4; i++) {
      expect(v[worldIndex(140, slabY + i, 140)]).toBe(M_DIRT);
    }
    // The original cap is untouched.
    expect(v[worldIndex(140, slabY, 140)]).toBe(M_GRASS);
  });

  it('caps at WORLD_Y - 1', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    v[worldIndex(10, 0, 10)] = M_DIRT;
    const placed = world.dumpColumn(10, 10, WORLD_Y * 2, M_DIRT);
    // Only WORLD_Y - 1 voxels can be placed above the existing dirt at y=0
    // (the column has slots y=1 .. y=WORLD_Y-1 = WORLD_Y - 1 places).
    expect(placed).toBe(WORLD_Y - 1);
    expect(v[worldIndex(10, WORLD_Y - 1, 10)]).toBe(M_DIRT);
  });
});

describe('Hauler integration', () => {
  it('emits one ScoopRequest on arrival when empty, one DumpRequest when loaded', () => {
    const slabY = 60;
    const world = buildSlabWorld(slabY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const startVx = 80, startVz = 80;
    const u = um.spawn(
      'hauler',
      (startVx + 0.5) * VOXEL_SIZE,
      (slabY + 1) * VOXEL_SIZE,
      (startVz + 0.5) * VOXEL_SIZE,
    );
    // Empty hauler with a load job at column (90, 80). Path is short so the
    // unit reaches the goal within a few seconds of simulation.
    const loadVx = 90, loadVz = 80;
    u.haulerJob = { vx: loadVx, vz: loadVz, mode: 'load' };
    um.setPath(u, [{
      x: (loadVx + 0.5) * VOXEL_SIZE,
      y: (slabY + 1) * VOXEL_SIZE,
      z: (loadVz + 0.5) * VOXEL_SIZE,
    }]);

    const scoops: ScoopRequest[] = [];
    const dumps: DumpRequest[] = [];
    const dt = 1 / 30;
    for (let i = 0; i < 600; i++) {
      um.tick(dt, nav, vnav, voxels, (req) => {
        if (req.kind === 'scoop') scoops.push(req);
        else if (req.kind === 'dump') dumps.push(req);
      });
      // Stop a few frames after arrival so we don't run forever once the
      // job has fired.
      if (u.path.length === 0 && u.haulerJob === null && scoops.length + dumps.length > 0) break;
    }
    expect(scoops.length).toBe(1);
    expect(dumps.length).toBe(0);
    expect(scoops[0]!.vx).toBe(loadVx);
    expect(scoops[0]!.vz).toBe(loadVz);
    expect(scoops[0]!.maxVoxels).toBe(u.spoilCapacity);
    expect(u.haulerJob).toBeNull();
  });

  it('a loaded hauler emits a DumpRequest with the carried voxels and target column', () => {
    const slabY = 60;
    const world = buildSlabWorld(slabY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const u = um.spawn(
      'hauler',
      80 * VOXEL_SIZE,
      (slabY + 1) * VOXEL_SIZE,
      80 * VOXEL_SIZE,
    );
    u.spoilLoad = 256;
    const dumpVx = 92, dumpVz = 80;
    u.haulerJob = { vx: dumpVx, vz: dumpVz, mode: 'dump' };
    um.setPath(u, [{
      x: (dumpVx + 0.5) * VOXEL_SIZE,
      y: (slabY + 1) * VOXEL_SIZE,
      z: (dumpVz + 0.5) * VOXEL_SIZE,
    }]);

    const dumps: DumpRequest[] = [];
    for (let i = 0; i < 600; i++) {
      um.tick(1 / 30, nav, vnav, voxels, (req) => {
        if (req.kind === 'dump') dumps.push(req);
      });
      if (u.path.length === 0 && u.haulerJob === null && dumps.length > 0) break;
    }
    expect(dumps.length).toBe(1);
    expect(dumps[0]!.vx).toBe(dumpVx);
    expect(dumps[0]!.vz).toBe(dumpVz);
    expect(dumps[0]!.voxels).toBe(256);
    expect(dumps[0]!.material).toBe(M_DIRT);
  });

  it('an empty hauler at full capacity does NOT emit a scoop', () => {
    const slabY = 60;
    const world = buildSlabWorld(slabY);
    const voxels = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    const u = um.spawn('hauler', 80 * VOXEL_SIZE, (slabY + 1) * VOXEL_SIZE, 80 * VOXEL_SIZE);
    u.spoilLoad = u.spoilCapacity;
    u.haulerJob = { vx: 92, vz: 80, mode: 'load' };
    um.setPath(u, [{
      x: 92.5 * VOXEL_SIZE,
      y: (slabY + 1) * VOXEL_SIZE,
      z: 80.5 * VOXEL_SIZE,
    }]);

    const scoops: ScoopRequest[] = [];
    for (let i = 0; i < 600; i++) {
      um.tick(1 / 30, nav, vnav, voxels, (req) => {
        if (req.kind === 'scoop') scoops.push(req);
      });
      if (u.path.length === 0 && u.haulerJob === null) break;
    }
    expect(scoops.length).toBe(0);
  });
});
