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

  it('grows ONLY while a farm-focus worker is tending the plot', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 30, 30);
    const mgr = new BuildingManager();
    const farm = mgr.place(world, FARM, fp.ox, fp.oz, fp.floorY);
    // Simulate a finished build: a fresh farm places as 'pending' and only
    // grows once construction completes and it flips to 'enabled'. (The test
    // harness has no supply-truck construction loop.)
    farm.upgradeState = 'enabled';
    expect(farm.cropProgress).toBe(0);
    expect(farm.cropReady).toBe(false);

    // No farmer present → the crop does NOT grow, no matter how long we tick.
    const um = new UnitManager();
    for (let i = 0; i < 5; i++) mgr.tick(FARM.productionInterval, world, um);
    expect(farm.cropProgress).toBe(0);
    expect(farm.cropReady).toBe(false);

    const cxw = (farm.ox + farm.spec.cellsW * 0.5) * 8 * 0.125;
    const czw = (farm.oz + farm.spec.cellsD * 0.5) * 8 * 0.125;

    // A NON-farmer (auto focus) standing on the plot does NOT tend it.
    const drifter = um.spawn('worker', cxw, (fp.floorY + 1) * 0.125, czw);
    drifter.workerFocus = 'auto';
    for (let i = 0; i < 3; i++) mgr.tick(FARM.productionInterval, world, um);
    expect(farm.cropProgress).toBe(0);

    // Switch it to farm focus → the crop grows continuously while it stands
    // there (no milestone pauses). Half an interval of tending ≈ 50 % grown.
    drifter.workerFocus = 'farm';
    mgr.tick(FARM.productionInterval * 0.5, world, um);
    expect(farm.cropProgress).toBeGreaterThan(0.4);
    expect(farm.cropProgress).toBeLessThan(0.6);
    expect(farm.farmerId).toBe(drifter.id);

    // Remove the farmer → growth PAUSES exactly where it was.
    const held = farm.cropProgress;
    um.units.length = 0;
    for (let i = 0; i < 3; i++) mgr.tick(FARM.productionInterval, world, um);
    expect(farm.cropProgress).toBe(held);
    expect(farm.farmerId).toBe(null);
  });

  it('a continuously-tended farm ripens, then a harvest pays out and resets', () => {
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 70, 70);
    const mgr = new BuildingManager();
    let foodAdded = 0;
    mgr.foodSink = (amount): void => { foodAdded += amount; };
    const farm = mgr.place(world, FARM, fp.ox, fp.oz, fp.floorY);
    farm.upgradeState = 'enabled'; // simulate finished construction (see above)

    // A farmer that stays on the plot grows it straight to 1.0 — no pauses.
    const um = new UnitManager();
    const cxw = (farm.ox + farm.spec.cellsW * 0.5) * 8 * 0.125;
    const czw = (farm.oz + farm.spec.cellsD * 0.5) * 8 * 0.125;
    const farmer = um.spawn('worker', cxw, (fp.floorY + 1) * 0.125, czw);
    farmer.workerFocus = 'farm';
    for (let i = 0; i < 5 && !farm.cropReady; i++) mgr.tick(FARM.productionInterval, world, um);
    expect(farm.cropProgress).toBe(1);
    expect(farm.cropReady).toBe(true);

    // Harvest pays out the farm yield and resets to a fresh growth cycle.
    const res = mgr.collectFarm(farm, farmer.id);
    expect(res.foodGained).toBe(60);
    expect(foodAdded).toBe(60);
    expect(farm.cropReady).toBe(false);
    expect(farm.cropProgress).toBe(0);
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

  it('doorWorldPos rotates through all 4 face doors', () => {
    // Regression: a worker pinned in a corner where the closest door
    // sits in an unreachable 1-cell channel must be able to fall back
    // to the next-closest face. Without rotation the worker re-targets
    // the same dead goal forever and the team's storage stays empty.
    const world = buildGrassPlane();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const fp = checkFootprint(world.buffers.voxels, nav, STORAGE, 80, 80);
    expect(fp.ok).toBe(true);
    const mgr = new BuildingManager();
    const b = mgr.place(world, STORAGE, fp.ox, fp.oz, fp.floorY);

    // Caller standing west of the storage. Closest face is -X.
    const callerX = (fp.ox * 8 - 40) * 0.125;
    const callerZ = (fp.oz + STORAGE.cellsD * 0.5) * 8 * 0.125;
    const r0 = doorWorldPos(b, callerX, callerZ, 0);
    const r1 = doorWorldPos(b, callerX, callerZ, 1);
    const r2 = doorWorldPos(b, callerX, callerZ, 2);
    const r3 = doorWorldPos(b, callerX, callerZ, 3);

    // rotation=0 must match the no-rotation default (closest face).
    const def = doorWorldPos(b, callerX, callerZ);
    expect(r0.x).toBe(def.x);
    expect(r0.z).toBe(def.z);

    // All 4 rotations land on distinct face anchors.
    const all = [r0, r1, r2, r3].map(p => `${p.x.toFixed(3)},${p.z.toFixed(3)}`);
    const uniq = new Set(all);
    expect(uniq.size).toBe(4);

    // Rotation wraps modulo 4: rotation=4 should equal rotation=0.
    const r4 = doorWorldPos(b, callerX, callerZ, 4);
    expect(r4.x).toBe(r0.x);
    expect(r4.z).toBe(r0.z);
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
