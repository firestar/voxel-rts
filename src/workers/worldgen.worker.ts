/// <reference lib="webworker" />
import { warpedFbm2, fbm3, worley3 } from '../util/Noise';
import {
  WORLD_X, WORLD_Y, WORLD_Z, CHUNK_COUNT,
} from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { M_AIR, M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../voxel/Materials';

interface GenJob {
  voxels: Uint8Array;        // shared
  dirty: Uint8Array;         // shared
  seed: number;
  zStart: number;            // inclusive
  zEnd: number;              // exclusive — this worker fills [zStart, zEnd)
  progress: Int32Array;      // shared, length 1; bumped per Z column
}

self.onmessage = (ev: MessageEvent<GenJob>) => {
  const job = ev.data;
  generate(job);
  // Signal completion via posting back the slab range.
  (self as unknown as Worker).postMessage({ done: true, zStart: job.zStart, zEnd: job.zEnd });
};

function generate(job: GenJob): void {
  const { voxels, dirty, seed, zStart, zEnd, progress } = job;

  // Tunables (voxels). All distances scaled for 0.125 m voxels.
  const baseHeight = 96;       // 12 m above bedrock
  const heightAmp = 56;        // ±7 m
  const heightFreq = 1 / 160;  // gentle ridges (~10 m wavelength)
  const dirtDepth = 12;        // 1.5 m
  const grassDepth = 2;        // 0.25 m

  // Cave parameters (noise periods scaled to keep similar feature sizes).
  const caveStartY = 8;
  const caveEndY = WORLD_Y - 8;
  const worleyFreq = 1 / 28;
  const fbmFreq = 1 / 44;

  for (let z = zStart; z < zEnd; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      // Heightmap via domain-warped fbm — single sample per (x,z). Cheap.
      const w = warpedFbm2(x * heightFreq, z * heightFreq, seed);
      const h = (baseHeight + w * heightAmp) | 0;
      const top = Math.max(2, Math.min(WORLD_Y - 1, h));

      // Bedrock floor (a bit thicker now that voxels are smaller).
      for (let by = 0; by < 4; by++) voxels[worldIndex(x, by, z)] = M_BEDROCK;

      // Stone column up to top - dirtDepth - grassDepth, dirt below grass, grass at top.
      const grassY = top;
      const dirtTopY = top - grassDepth;
      const stoneTopY = dirtTopY - dirtDepth;

      for (let y = 4; y < top; y++) {
        const idx = worldIndex(x, y, z);
        if (y <= stoneTopY) voxels[idx] = M_STONE;
        else if (y <= dirtTopY) voxels[idx] = M_DIRT;
        else voxels[idx] = M_DIRT;
      }
      voxels[worldIndex(x, grassY, z)] = M_GRASS;

      // Above terrain: air (already zero).

      // Caves: carve from stone/dirt where worley distance is small AND fbm threshold met.
      // Use the cheaper test first to short-circuit.
      for (let y = caveStartY; y < Math.min(caveEndY, top); y++) {
        // Bedrock layer is sacred.
        if (y < 5) continue;
        // Quick reject via fbm threshold.
        const f = fbm3(x * fbmFreq, y * fbmFreq, z * fbmFreq, seed + 7919, 2);
        if (f < 0.18) continue;
        // Confirm with worley closeness — caves run along cell boundaries.
        const wd = worley3(x * worleyFreq, y * worleyFreq, z * worleyFreq, seed + 1031);
        if (wd > 0.55) continue;
        voxels[worldIndex(x, y, z)] = M_AIR;
      }

      // Bump progress (atomically — multiple workers may race).
      Atomics.add(progress, 0, 1);
    }
  }

  // Mark every chunk in this Z slab dirty so the renderer queues meshes.
  // (We don't know cleanly which chunks were touched; this slab covers all of them in Z range.)
  void dirty;
  // The driver marks all dirty after all workers complete, simpler & race-free.
}

export {}; // module
