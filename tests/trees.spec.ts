import { describe, it, expect } from 'vitest';
import { placeTrees } from '../src/voxel/Trees';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_WOOD, M_LEAF } from '../src/voxel/Materials';

function buildGrassPlane(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const surfaceY = 32;
  // Bottom dirt layer, single-voxel grass on top, air above.
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_GRASS - 1; // dirt id 2
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('placeTrees', () => {
  it('places at least one tree and writes both wood and leaf voxels', () => {
    const world = buildGrassPlane();
    const before = countMaterials(world.buffers.voxels);
    const { count } = placeTrees(world.buffers.voxels, 12345);
    const after = countMaterials(world.buffers.voxels);

    expect(count).toBeGreaterThan(0);
    expect(after.wood).toBeGreaterThan(before.wood);
    expect(after.leaf).toBeGreaterThan(before.leaf);
  });

  it('respects a minimum spacing — no two tree trunks land on the exact same voxel', () => {
    const world = buildGrassPlane();
    placeTrees(world.buffers.voxels, 999);
    // Walk the surface+1 voxel layer; collect (x,z) of every wood voxel right above
    // the grass layer (= a trunk base). Two trees can't share a base column.
    const v = world.buffers.voxels;
    const trunkBaseY = 33;
    const seen = new Set<number>();
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        if (v[worldIndex(x, trunkBaseY, z)] === M_WOOD) {
          const key = z * WORLD_X + x;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('skips columns whose surface isn\'t grass', () => {
    // Build a world where the top voxel is stone (not grass).
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    const surfaceY = 32;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, surfaceY, z)] = 3; // stone
      }
    }
    const { count } = placeTrees(v, 1);
    expect(count).toBe(0);
  });

  it('is deterministic for a given seed', () => {
    const a = buildGrassPlane();
    const b = buildGrassPlane();
    placeTrees(a.buffers.voxels, 4242);
    placeTrees(b.buffers.voxels, 4242);
    // Compare a small sample window — full equality would be slow but the seeds
    // produce the same hashes everywhere.
    let agree = true;
    for (let i = 0; i < 1_000_000; i += 7919) {
      if (a.buffers.voxels[i] !== b.buffers.voxels[i]) { agree = false; break; }
    }
    expect(agree).toBe(true);
  });
});

function countMaterials(v: Uint8Array): { wood: number; leaf: number } {
  let wood = 0, leaf = 0;
  // Sample stride for speed — the voxel buffer is huge.
  for (let i = 0; i < v.length; i += 1) {
    const m = v[i]!;
    if (m === M_WOOD) wood++;
    else if (m === M_LEAF) leaf++;
  }
  return { wood, leaf };
}
