import { describe, it, expect } from 'vitest';
import { SaplingManager, SAPLING_MATURE_SEC } from '../src/sim/Saplings';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_WOOD, M_LEAF } from '../src/voxel/Materials';

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

function countWoodLeaf(v: Uint8Array): { wood: number; leaf: number } {
  let wood = 0, leaf = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === M_WOOD) wood++;
    else if (v[i] === M_LEAF) leaf++;
  }
  return { wood, leaf };
}

describe('SaplingManager.plant', () => {
  it('writes a tiny marker (wood + leaf) when planted on grass', () => {
    const world = buildGrassPlane();
    const sm = new SaplingManager();
    const before = countWoodLeaf(world.buffers.voxels);
    const r = sm.plant(world, 100, 100, 1);
    expect(r.ok).toBe(true);
    const after = countWoodLeaf(world.buffers.voxels);
    expect(after.wood).toBeGreaterThan(before.wood);
    expect(after.leaf).toBeGreaterThan(before.leaf);
    expect(sm.saplings.length).toBe(1);
  });

  it('refuses to plant when there is no grass surface', () => {
    const world = VoxelWorld.create(false); // no grass anywhere
    const sm = new SaplingManager();
    const r = sm.plant(world, 50, 50, 1);
    expect(r.ok).toBe(false);
    expect(sm.saplings.length).toBe(0);
  });

  it('refuses to plant within 1 voxel of an existing sapling', () => {
    const world = buildGrassPlane();
    const sm = new SaplingManager();
    const a = sm.plant(world, 200, 200, 1);
    expect(a.ok).toBe(true);
    const b = sm.plant(world, 200, 201, 2);
    expect(b.ok).toBe(false);
    expect(sm.saplings.length).toBe(1);
  });
});

describe('SaplingManager.tick growth', () => {
  it('matures into a full tree after SAPLING_MATURE_SEC', () => {
    const world = buildGrassPlane();
    const sm = new SaplingManager();
    sm.plant(world, 300, 300, 99);
    const beforeMature = countWoodLeaf(world.buffers.voxels);

    // Tick well past maturity in two big steps to exercise multi-frame age.
    let res = sm.tick(SAPLING_MATURE_SEC / 2, world);
    expect(res.matured).toBe(0);
    expect(sm.saplings.length).toBe(1);

    res = sm.tick(SAPLING_MATURE_SEC / 2 + 1, world);
    expect(res.matured).toBe(1);
    expect(sm.saplings.length).toBe(0);

    const afterMature = countWoodLeaf(world.buffers.voxels);
    // Full tree adds many wood + leaf voxels — way more than the marker did.
    expect(afterMature.wood).toBeGreaterThan(beforeMature.wood + 30);
    expect(afterMature.leaf).toBeGreaterThan(beforeMature.leaf + 30);
  });
});
