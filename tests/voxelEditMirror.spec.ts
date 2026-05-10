import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { AIR, VOXEL_SIZE } from '../src/voxel/types';
import { M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import { VoxelEditMirror } from '../src/net/VoxelEditMirror';
import type { VoxelEditEvent } from '../src/net/GameClient';

// VoxelWorld.create allocates the full WORLD-sized buffer (~1.5 GB);
// we re-use it across the spec suite.
function makeWorld(): VoxelWorld {
  return VoxelWorld.create(false);
}

describe('VoxelEditMirror', () => {
  it('applies a sphere op to the local voxel buffer', () => {
    const world = makeWorld();
    // Seed a small column of stone the projectile can carve through.
    const cx = 100, cy = 50, cz = 100;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -3; dy <= 3; dy++) {
          world.set(cx + dx, cy + dy, cz + dz, M_STONE);
        }
      }
    }
    const mirror = new VoxelEditMirror(world, 'self');
    const evt: VoxelEditEvent = {
      seq: 1, tick: 0, sender: 'peer',
      op: {
        kind: 'sphere',
        x: cx * VOXEL_SIZE, y: cy * VOXEL_SIZE, z: cz * VOXEL_SIZE,
        radius: 2 * VOXEL_SIZE,
        mat: AIR,
      },
    };
    mirror.onEvent(evt);
    // Centre voxel should be AIR.
    expect(world.get(cx, cy, cz)).toBe(AIR);
    // Voxel just outside the radius should still be stone.
    expect(world.get(cx + 3, cy, cz)).toBe(M_STONE);
    expect(mirror.highestAppliedSeq()).toBe(1);
  });

  it('skips echoes of locally-issued edits', () => {
    const world = makeWorld();
    const cx = 200, cy = 60, cz = 200;
    world.set(cx, cy, cz, M_STONE);
    const mirror = new VoxelEditMirror(world, 'self');
    const evt: VoxelEditEvent = {
      seq: 5, tick: 0, sender: 'self',
      op: {
        kind: 'sphere',
        x: cx * VOXEL_SIZE, y: cy * VOXEL_SIZE, z: cz * VOXEL_SIZE,
        radius: VOXEL_SIZE * 2,
        mat: AIR,
      },
    };
    mirror.onEvent(evt);
    // Echo — local stone untouched, but seq advanced so a future
    // catch-up doesn't re-replay this entry.
    expect(world.get(cx, cy, cz)).toBe(M_STONE);
    expect(mirror.highestAppliedSeq()).toBe(5);
  });

  it('applies a set op for explicit per-voxel writes', () => {
    const world = makeWorld();
    const mirror = new VoxelEditMirror(world, 'self');
    const evt: VoxelEditEvent = {
      seq: 2, tick: 0, sender: 'peer',
      op: {
        kind: 'set',
        ops: [
          { x: 50, y: 50, z: 50, mat: M_STONE },
          { x: 51, y: 50, z: 50, mat: M_STONE },
        ],
      },
    };
    mirror.onEvent(evt);
    expect(world.get(50, 50, 50)).toBe(M_STONE);
    expect(world.get(51, 50, 50)).toBe(M_STONE);
  });

  it('ignores out-of-order events', () => {
    const world = makeWorld();
    const mirror = new VoxelEditMirror(world, 'self');
    world.set(80, 50, 80, M_STONE);
    // Apply seq=10 first.
    mirror.onEvent({
      seq: 10, tick: 0, sender: 'peer',
      op: { kind: 'set', ops: [{ x: 80, y: 50, z: 80, mat: AIR }] },
    });
    expect(world.get(80, 50, 80)).toBe(AIR);
    expect(mirror.highestAppliedSeq()).toBe(10);
    // Re-deliver an older seq=5 — should be ignored.
    world.set(80, 50, 80, M_STONE);
    mirror.onEvent({
      seq: 5, tick: 0, sender: 'peer',
      op: { kind: 'set', ops: [{ x: 80, y: 50, z: 80, mat: AIR }] },
    });
    expect(world.get(80, 50, 80)).toBe(M_STONE);
    expect(mirror.highestAppliedSeq()).toBe(10);
  });

  it('refuses to overwrite bedrock', () => {
    const world = makeWorld();
    // Bedrock is the indestructible foundation — neither sphere nor
    // set should pierce it, mirroring the server's own check.
    world.set(60, 0, 60, M_BEDROCK);
    const mirror = new VoxelEditMirror(world, 'self');
    mirror.onEvent({
      seq: 1, tick: 0, sender: 'peer',
      op: { kind: 'set', ops: [{ x: 60, y: 0, z: 60, mat: AIR }] },
    });
    expect(world.get(60, 0, 60)).toBe(M_BEDROCK);
    mirror.onEvent({
      seq: 2, tick: 0, sender: 'peer',
      op: {
        kind: 'sphere',
        x: 60 * VOXEL_SIZE, y: 0, z: 60 * VOXEL_SIZE,
        radius: VOXEL_SIZE * 2,
        mat: AIR,
      },
    });
    expect(world.get(60, 0, 60)).toBe(M_BEDROCK);
    // Sanity: worldIndex still resolves the bedrock voxel.
    expect(world.buffers.voxels[worldIndex(60, 0, 60)]).toBe(M_BEDROCK);
  });
});
