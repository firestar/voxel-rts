import { WORLD_X, WORLD_Z } from './types';
import { VoxelWorld } from './VoxelWorld';
import { placeTrees } from './Trees';
import { placeRoads } from './Roads';

import WorldgenWorker from '../workers/worldgen.worker?worker';

export interface GenProgress {
  done: number;     // columns completed
  total: number;    // total columns
}

export async function generateWorld(
  world: VoxelWorld,
  seed: number,
  onProgress?: (p: GenProgress) => void,
): Promise<void> {
  const cores = Math.max(2, Math.min((navigator.hardwareConcurrency ?? 4) - 1, 8));
  const slabs = cores;
  const slabZ = Math.ceil(WORLD_Z / slabs);
  const total = WORLD_X * WORLD_Z;

  // Shared progress counter.
  const progressBuf = (typeof SharedArrayBuffer !== 'undefined')
    ? new SharedArrayBuffer(4)
    : new ArrayBuffer(4);
  const progress = new Int32Array(progressBuf);

  const workers: Worker[] = [];
  const done: Promise<void>[] = [];

  for (let i = 0; i < slabs; i++) {
    const zStart = i * slabZ;
    const zEnd = Math.min(WORLD_Z, zStart + slabZ);
    if (zStart >= zEnd) break;
    const w = new WorldgenWorker();
    workers.push(w);
    done.push(new Promise<void>((resolve) => {
      w.onmessage = () => resolve();
    }));
    w.postMessage({
      voxels: world.buffers.voxels,
      dirty: world.buffers.dirty,
      seed,
      zStart,
      zEnd,
      progress,
    });
  }

  if (onProgress) {
    const tick = () => {
      const cur = Atomics.load(progress, 0);
      onProgress({ done: cur, total });
      if (cur < total) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  await Promise.all(done);
  for (const w of workers) w.terminate();
  // Roads first: they paint M_PATH onto the surface where the network runs.
  // Then trees, which skip non-grass cells — road cells are naturally
  // tree-free without any extra check. Both run on the main thread post-merge
  // to avoid races on writes that cross worker slab boundaries.
  placeRoads(world.buffers.voxels, seed);
  placeTrees(world.buffers.voxels, seed);
  world.markAllDirty();
}
