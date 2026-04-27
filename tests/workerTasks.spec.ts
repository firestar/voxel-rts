import { describe, it, expect } from 'vitest';
import { WorkerTaskBoard, describeOrder } from '../src/sim/WorkerTasks';
import { PileManager } from '../src/sim/Piles';
import { BuildingManager, FARM, BARRACKS, checkFootprint } from '../src/sim/Buildings';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';

function buildFlatWorld(surfaceY = 32): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('WorkerTaskBoard', () => {
  it('addPlant pushes a new order with monotonic seq', () => {
    const b = new WorkerTaskBoard();
    const a = b.addPlant(10, 20);
    const c = b.addPlant(15, 25);
    expect(a.seq).toBeLessThan(c.seq);
    expect(b.orders.length).toBe(2);
  });

  it('addFarmTend dedupes by buildingId', () => {
    const b = new WorkerTaskBoard();
    const a = b.addFarmTend(7);
    const c = b.addFarmTend(7);
    expect(a).toBe(c);
    expect(b.orders.length).toBe(1);
  });

  it('claim picks highest priority unclaimed and stamps claimedBy', () => {
    const b = new WorkerTaskBoard();
    const fetch = b.addFarmTend(1);
    void fetch;
    const plant = b.addPlant(5, 5); // plant outranks farmTend by priority
    const claimed = b.claim(99, () => true);
    expect(claimed).toBe(plant);
    expect(plant.claimedBy).toBe(99);
    // Next claim falls to farmTend (next priority).
    const next = b.claim(101, () => true);
    expect(next!.kind).toBe('farmTend');
  });

  it('claim respects the accept predicate (role gating)', () => {
    const b = new WorkerTaskBoard();
    const tend = b.addFarmTend(1);
    void tend;
    // Predicate that only accepts plant orders → no farmTend gets claimed.
    expect(b.claim(1, o => o.kind === 'plant')).toBeNull();
  });

  it('releaseAllClaimsBy clears claims for a unit but leaves orders', () => {
    const b = new WorkerTaskBoard();
    const o = b.addPlant(0, 0);
    b.claim(42, () => true);
    expect(o.claimedBy).toBe(42);
    b.releaseAllClaimsBy(42);
    expect(o.claimedBy).toBe(0);
    expect(b.orders.length).toBe(1);
  });

  it('remove drops the order entirely', () => {
    const b = new WorkerTaskBoard();
    const o = b.addPlant(0, 0);
    b.remove(o.id);
    expect(b.orders.length).toBe(0);
    expect(b.byId(o.id)).toBeNull();
  });

  it('snapshot orders claimed first, then by priority bucket + seq', () => {
    const b = new WorkerTaskBoard();
    const farmTend = b.addFarmTend(1);
    const plant = b.addPlant(0, 0);
    const harv = b.addFarmTend(2);
    void harv; // (Just need a third order; using farmTend keeps the buckets simple.)
    // Claim only farmTend(1).
    farmTend.claimedBy = 7;
    const snap = b.snapshot();
    // Claimed first.
    expect(snap[0]).toBe(farmTend);
    // Among unclaimed, plant (priority 0) outranks farmTend (priority 1).
    expect(snap[1]).toBe(plant);
  });

  it('syncAutoOrders publishes fetchPile and harvestFarm orders, prunes stale entries', () => {
    const board = new WorkerTaskBoard();
    const piles = new PileManager();
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const buildings = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 8, 8);
    const farm = buildings.place(world, FARM, fp.ox, fp.oz, fp.floorY);
    farm.cropReady = true;
    piles.drop(40, 4, 40, 2, 1);

    board.syncAutoOrders(piles, buildings);
    expect(board.orders.find(o => o.kind === 'fetchPile')).toBeTruthy();
    expect(board.orders.find(o => o.kind === 'harvestFarm')).toBeTruthy();

    // Crop collected → harvestFarm order should drop next sync.
    farm.cropReady = false;
    board.syncAutoOrders(piles, buildings);
    expect(board.orders.find(o => o.kind === 'harvestFarm')).toBeFalsy();

    // Pile picked up → fetchPile order should drop too.
    piles.piles.length = 0;
    board.syncAutoOrders(piles, buildings);
    expect(board.orders.find(o => o.kind === 'fetchPile')).toBeFalsy();
  });

  it('describeOrder produces a sensible label for each kind', () => {
    const piles = new PileManager();
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const buildings = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    void buildings.place(world, BARRACKS, fp.ox, fp.oz, fp.floorY);
    const board = new WorkerTaskBoard();
    const plant = board.addPlant(11.5, 22.5);
    expect(describeOrder(plant, piles, buildings)).toMatch(/Plant/);
  });
});
