import { describe, it, expect } from 'vitest';
import { placeMetals } from '../src/voxel/Metals';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_METAL, M_BEDROCK } from '../src/voxel/Materials';

/**
 * Build a layered world: bedrock floor + thick stone column + dirt cap +
 * grass surface. placeMetals should only convert stone/dirt voxels and leave
 * grass/bedrock untouched.
 */
function buildLayeredWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const surfaceY = 96;
  const dirtTop = surfaceY - 1;
  const dirtBottom = surfaceY - 12;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < 4; y++) v[worldIndex(x, y, z)] = M_BEDROCK;
      for (let y = 4; y <= dirtBottom; y++) v[worldIndex(x, y, z)] = M_STONE;
      for (let y = dirtBottom + 1; y <= dirtTop; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

function countMetal(v: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < v.length; i++) if (v[i] === M_METAL) n++;
  return n;
}

describe('placeMetals', () => {
  it('writes at least one metal voxel', () => {
    const world = buildLayeredWorld();
    const stats = placeMetals(world.buffers.voxels, 4242);
    expect(stats.patches).toBeGreaterThan(0);
    expect(stats.voxels).toBeGreaterThan(0);
    expect(countMetal(world.buffers.voxels)).toBe(stats.voxels);
  });

  it('only replaces stone and dirt — never grass or bedrock', () => {
    const world = buildLayeredWorld();
    placeMetals(world.buffers.voxels, 7777);
    const v = world.buffers.voxels;
    // Sample every grass column — surface voxel must still be grass.
    for (let z = 0; z < WORLD_Z; z += 13) {
      for (let x = 0; x < WORLD_X; x += 13) {
        expect(v[worldIndex(x, 96, z)]).toBe(M_GRASS);
        // Bedrock layer (y < 4) untouched.
        expect(v[worldIndex(x, 0, z)]).toBe(M_BEDROCK);
        expect(v[worldIndex(x, 3, z)]).toBe(M_BEDROCK);
      }
    }
  });

  it('produces large patches — at least one cluster has many voxels', () => {
    const world = buildLayeredWorld();
    const stats = placeMetals(world.buffers.voxels, 12345);
    // Each patch is an ellipsoid of radius 4..11 xz × 3..6 y. The smallest is
    // ~4/3 π × 4×4×3 ≈ 200 voxels, the largest several thousand. Total over
    // many patches should land well above 200 even after stone-only filter.
    expect(stats.voxels).toBeGreaterThan(200);
    if (stats.patches > 0) {
      // Average patch size sanity bound.
      expect(stats.voxels / stats.patches).toBeGreaterThan(20);
    }
  });

  it('is deterministic across re-runs of the same seed', () => {
    const a = buildLayeredWorld();
    const b = buildLayeredWorld();
    placeMetals(a.buffers.voxels, 9090);
    placeMetals(b.buffers.voxels, 9090);
    expect(countMetal(a.buffers.voxels)).toBe(countMetal(b.buffers.voxels));
    // Spot-check identical at sampled offsets.
    for (let i = 0; i < 1_000_000; i += 7919) {
      expect(a.buffers.voxels[i]).toBe(b.buffers.voxels[i]);
    }
  });
});
