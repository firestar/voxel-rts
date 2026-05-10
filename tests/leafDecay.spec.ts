import { describe, it, expect } from 'vitest';
import { LeafDecay } from '../src/sim/LeafDecay';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { AIR } from '../src/voxel/types';
import { M_WOOD, M_LEAF } from '../src/voxel/Materials';

function blank(): VoxelWorld {
  return VoxelWorld.create(false);
}

describe('LeafDecay', () => {
  it('keeps leaves alive while they are connected to wood through other leaves', () => {
    const w = blank();
    const decay = new LeafDecay();
    // Wood column at (10..14, 10) — 5 voxels tall trunk.
    for (let dy = 0; dy < 5; dy++) w.set(10, 10 + dy, 10, M_WOOD);
    // 3-voxel leaf branch reaching east from the top of the trunk: the leaf
    // adjacent to wood, then two leaves chained off it.
    w.set(11, 14, 10, M_LEAF);
    w.set(12, 14, 10, M_LEAF);
    w.set(13, 14, 10, M_LEAF);
    decay.onVoxelRemoved(w, 11, 14, 10); // any in-region tickle to seed evaluator
    // No timers should be running — every leaf chains back to wood.
    expect(decay.size()).toBe(0);
    decay.tick(w, 1.0);
    expect(w.buffers.voxels[worldIndex(11, 14, 10)]).toBe(M_LEAF);
    expect(w.buffers.voxels[worldIndex(12, 14, 10)]).toBe(M_LEAF);
    expect(w.buffers.voxels[worldIndex(13, 14, 10)]).toBe(M_LEAF);
  });

  it('decays a chain of leaves once the wood that anchored them is chopped', () => {
    const w = blank();
    const decay = new LeafDecay();
    for (let dy = 0; dy < 5; dy++) w.set(10, 10 + dy, 10, M_WOOD);
    w.set(11, 14, 10, M_LEAF);
    w.set(12, 14, 10, M_LEAF);
    w.set(13, 14, 10, M_LEAF);
    // Fell the only wood voxel adjacent to the leaf chain.
    w.set(10, 14, 10, AIR);
    decay.onVoxelRemoved(w, 10, 14, 10);
    expect(decay.size()).toBe(3);
    // Leaves persist while their decay timers are still running.
    decay.tick(w, 0.1);
    expect(w.buffers.voxels[worldIndex(11, 14, 10)]).toBe(M_LEAF);
    // After the full 0.3 s window each leaf turns to AIR.
    decay.tick(w, 0.25);
    expect(w.buffers.voxels[worldIndex(11, 14, 10)]).toBe(AIR);
    expect(w.buffers.voxels[worldIndex(12, 14, 10)]).toBe(AIR);
    expect(w.buffers.voxels[worldIndex(13, 14, 10)]).toBe(AIR);
  });

  it('clears decay on a leaf if it later regains a wood connection', () => {
    const w = blank();
    const decay = new LeafDecay();
    w.set(10, 10, 10, M_WOOD);
    w.set(11, 10, 10, M_LEAF);
    // Disconnect: knock out the wood.
    w.set(10, 10, 10, AIR);
    decay.onVoxelRemoved(w, 10, 10, 10);
    expect(decay.size()).toBe(1);
    // Advance the throttle clock past the burst-coalescing window so the
    // second evaluateRegion call below isn't dropped.
    decay.tick(w, 0.2);
    // Restore the wood and notify the system. The leaf should drop out of
    // the decay map even though its timer hasn't fired yet.
    w.set(10, 10, 10, M_WOOD);
    decay.onVoxelRemoved(w, 10, 10, 10);
    expect(decay.size()).toBe(0);
    decay.tick(w, 1.0);
    expect(w.buffers.voxels[worldIndex(11, 10, 10)]).toBe(M_LEAF);
  });
});
