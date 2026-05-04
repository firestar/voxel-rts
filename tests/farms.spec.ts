import { describe, it, expect } from 'vitest';
import { BuildingManager, FARM, BARRACKS, STORAGE, checkFootprint, doorWorldPos } from '../src/sim/Buildings';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_FARM, M_DIRT_ROAD, M_WOOD } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';
import { UnitManager } from '../src/sim/Units';

function buildGrassPlane(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const surfaceY = 32;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('Farm building', () => {
  it('stamps cropland and a fence; leaves an open top', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);

    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 12, 12);
    expect(fp.ok).toBe(true);

    const mgr = new BuildingManager();
    const b = mgr.place(world, FARM, fp.ox, fp.oz, fp.floorY);
    expect(b.spec.kind).toBe('farm');

    // Centre of the farm should be M_FARM cropland on the floor + 1 layer.
    const v = world.buffers.voxels;
    const cxV = (fp.ox + 1) * 8 + 4;
    const czV = (fp.oz + 1) * 8 + 4;
    expect(v[worldIndex(cxV, fp.floorY + 1, czV)]).toBe(M_FARM);

    // Perimeter should have a fence voxel of M_DIRT_ROAD at the same Y.
    const fenceX = fp.ox * 8;
    const fenceZ = (fp.oz + 1) * 8 + 4;
    expect(v[worldIndex(fenceX, fp.floorY + 1, fenceZ)]).toBe(M_DIRT_ROAD);
  });

  it('crops grow to each 20% milestone; five collections complete a cycle', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 30, 30);
    const mgr = new BuildingManager();
    let foodAdded = 0;
    mgr.foodSink = (amount): void => { foodAdded += amount; };
    const farm = mgr.place(world, FARM, fp.ox, fp.oz, fp.floorY);
    expect(farm.cropProgress).toBe(0);
    expect(farm.cropReady).toBe(false);

    // Ambient growth: enough ticks to cross the first 20% milestone.
    // Rate = 0.25/interval per second; after 1 interval tick ≈ 0.25 > 0.20.
    const um = new UnitManager();
    mgr.tick(FARM.productionInterval + 0.01, world, um);
    expect(farm.cropReady).toBe(true);
    expect(foodAdded).toBe(0); // nothing collected yet

    // Collect at the first milestone: food produced, cropReady cleared,
    // harvestMilestone advances to 1, progress NOT reset yet.
    const r1 = mgr.collectFarm(farm, 999);
    expect(r1.foodGained).toBe(5);
    expect(foodAdded).toBe(5);
    expect(farm.cropReady).toBe(false);
    expect(farm.harvestMilestone).toBe(1);
    expect(farm.cropProgress).toBeGreaterThan(0); // progress continues from here

    // Tick through the remaining four milestones (milestones 2–5).
    for (let m = 2; m <= 5; m++) {
      // Advance growth past the next 20% threshold.
      for (let t = 0; t < 10; t++) mgr.tick(FARM.productionInterval * 0.15, world, um);
      if (!farm.cropReady) {
        // Tick once more if we haven't crossed yet.
        mgr.tick(FARM.productionInterval, world, um);
      }
      expect(farm.cropReady).toBe(true);
      mgr.collectFarm(farm, 999);
    }

    // After five collections the cycle resets.
    expect(farm.cropProgress).toBe(0);
    expect(farm.harvestMilestone).toBe(0);
    expect(foodAdded).toBe(25); // 5 × 5 food per collection
  });

  it('a tending farmer accelerates growth (~4×) vs ambient', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 70, 70);
    const mgr = new BuildingManager();
    const farm = mgr.place(world, FARM, fp.ox, fp.oz, fp.floorY);

    // Spawn a worker at the farm centre and assign them as the farmer.
    const um = new UnitManager();
    const cxw = (farm.ox + farm.spec.cellsW * 0.5) * 8 * 0.125; // NAV_CELL_VOXELS=8, VOXEL_SIZE=0.125
    const czw = (farm.oz + farm.spec.cellsD * 0.5) * 8 * 0.125;
    const worker = um.spawn('worker', cxw, (fp.floorY + 1) * 0.125, czw);
    worker.task = { kind: 'farm', buildingId: farm.id };
    farm.farmerId = worker.id;

    // 1.0 × productionInterval at the tended rate (1/interval per second)
    // should bring cropProgress to ~1.0. Ambient alone (rate 0.25/interval
    // per second) would only reach ~0.25 in the same window.
    mgr.tick(FARM.productionInterval, world, um);
    expect(farm.cropProgress).toBeGreaterThan(0.9);
  });
});

describe('Storage building', () => {
  it('stamps wooden walls and registers as a storage', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, STORAGE, 50, 50);
    expect(fp.ok).toBe(true);
    const mgr = new BuildingManager();
    const b = mgr.place(world, STORAGE, fp.ox, fp.oz, fp.floorY);
    expect(b.spec.kind).toBe('storage');

    const v = world.buffers.voxels;
    // Wall voxel sample at the corner.
    expect(v[worldIndex(fp.ox * 8, fp.floorY + 2, fp.oz * 8)]).toBe(M_WOOD);

    // nearestStorage at the door returns this building.
    const door = doorWorldPos(b);
    const found = mgr.nearestStorage(door.x, door.z);
    expect(found?.id).toBe(b.id);
  });

  it('Storage tick is a no-op (no production)', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, STORAGE, 60, 60);
    const mgr = new BuildingManager();
    let spawnCount = 0;
    mgr.spawner = (): null => { spawnCount++; return null; };
    mgr.place(world, STORAGE, fp.ox, fp.oz, fp.floorY);
    for (let i = 0; i < 10; i++) mgr.tick(2.0, world, new UnitManager());
    expect(spawnCount).toBe(0);
  });
});

describe('Barracks unit production still works after BuildingManager refactor', () => {
  it('produces queued units on its production interval', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 20, 20);
    expect(fp.ok).toBe(true);
    const mgr = new BuildingManager();
    let spawnCount = 0;
    mgr.spawner = (): null => { spawnCount++; return null; };
    const b = mgr.place(world, BARRACKS, fp.ox, fp.oz, fp.floorY);
    // Queue three units up front — barracks only trains queued kinds, so
    // without this push the building would sit idle indefinitely.
    b.trainQueue.push('soldier', 'soldier', 'soldier');
    for (let i = 0; i < 3; i++) {
      mgr.tick(BARRACKS.productionInterval + 0.01, world, new UnitManager());
    }
    expect(spawnCount).toBe(3);
  });
});
