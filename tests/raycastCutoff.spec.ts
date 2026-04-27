import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { raycastVoxel } from '../src/voxel/Raycast';
import { VOXEL_SIZE, WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_DIRT, M_STONE } from '../src/voxel/Materials';

/**
 * Coverage for the Y-axis cutoff overlay's raycast clip. The picker is what
 * lets a player LMB-click through the see-through (5%-opacity) overlay and
 * land on whatever ground is rendered solid below it.
 */
function buildLayeredWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  // Stone slab at y=80 (the "underground floor"); dirt cap at y=120 (the
  // "above-cutoff hill the player wants to see through").
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 80, z)] = M_STONE;
      v[worldIndex(x, 120, z)] = M_DIRT;
    }
  }
  return world;
}

describe('raycastVoxel maxVoxelY', () => {
  it('without the cutoff, a downward ray hits the topmost (above-cutoff) layer first', () => {
    const world = buildLayeredWorld();
    const origin = { x: 50 * VOXEL_SIZE, y: 200 * VOXEL_SIZE, z: 50 * VOXEL_SIZE };
    const hit = raycastVoxel(world, origin, { x: 0, y: -1, z: 0 }, 200);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBe(120);
  });

  it('with maxVoxelY=120 the ray pierces the top layer and lands on the underground floor', () => {
    const world = buildLayeredWorld();
    const origin = { x: 50 * VOXEL_SIZE, y: 200 * VOXEL_SIZE, z: 50 * VOXEL_SIZE };
    const hit = raycastVoxel(world, origin, { x: 0, y: -1, z: 0 }, 200, 120);
    expect(hit).not.toBeNull();
    // 120 reads as AIR with the cutoff; next solid below is the stone slab at y=80.
    expect(hit!.y).toBe(80);
  });

  it('cutoff is exclusive — a voxel exactly at maxVoxelY is treated as AIR', () => {
    const world = buildLayeredWorld();
    const origin = { x: 50 * VOXEL_SIZE, y: 200 * VOXEL_SIZE, z: 50 * VOXEL_SIZE };
    // maxVoxelY=121 — voxel y=120 is BELOW the cutoff and still solid.
    const hit = raycastVoxel(world, origin, { x: 0, y: -1, z: 0 }, 200, 121);
    expect(hit!.y).toBe(120);
  });
});
