/// <reference lib="webworker" />
import { warpedFbm2, fbm3, worley3 } from '../util/Noise';
import {
  WORLD_X, WORLD_Y, WORLD_Z, CHUNK_COUNT,
} from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { M_AIR, M_GRASS, M_DIRT, M_STONE, M_BEDROCK, M_MUD } from '../voxel/Materials';
import { fbm2 } from '../util/Noise';

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
  const heightAmp = 12;        // ±1.5 m of rolling variation across the interior
  const heightFreq = 1 / 160;  // gentle ridges (~10 m wavelength)
  const dirtDepth = 12;        // 1.5 m
  const grassDepth = 2;        // 0.25 m

  // Edge mountain ring: columns within `mountainBand` voxels of any map edge get
  // pushed up by a smoothstep ramp so the playable interior stays open and the
  // perimeter rises into a stone-capped wall. `mountainAmp` is the peak boost in
  // voxels; the actual peak per-column is modulated by ridge noise so the ring
  // isn't a uniform berm.
  const mountainBand = 96;     // 12 m of edge frontage becomes mountainous
  const mountainAmp = 72;      // up to ~9 m peak above the flat plane
  const ridgeFreq = 1 / 48;    // ridge variation along the edge
  // Anything taller than this gets a bare-stone cap (no dirt/grass), giving
  // mountains a rocky look that contrasts with the grass plain.
  const stoneCapTop = baseHeight + heightAmp + 16; // 124 voxels = 15.5 m

  // Cave parameters (noise periods scaled to keep similar feature sizes).
  const caveStartY = 8;
  const caveEndY = WORLD_Y - 8;
  const worleyFreq = 1 / 28;
  const fbmFreq = 1 / 44;

  for (let z = zStart; z < zEnd; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      // Heightmap via domain-warped fbm — single sample per (x,z). Cheap.
      const w = warpedFbm2(x * heightFreq, z * heightFreq, seed);
      // Flat-ish interior height first.
      let h = baseHeight + w * heightAmp;

      // Distance to nearest edge in voxels. tEdge is 0 well inland, 1 at the border.
      const edgeDist = Math.min(x, z, WORLD_X - 1 - x, WORLD_Z - 1 - z);
      const tEdge = Math.max(0, Math.min(1, (mountainBand - edgeDist) / mountainBand));
      if (tEdge > 0) {
        // Smoothstep so the foot of the range eases into the plain.
        const sEdge = tEdge * tEdge * (3 - 2 * tEdge);
        // Ridge noise in [0, 1] so peaks vary in height along the edge instead of
        // forming a uniform wall. Bias toward the upper half so most edge columns
        // still rise meaningfully.
        const ridgeN = fbm2(x * ridgeFreq, z * ridgeFreq, seed + 3001, 3); // -1..1
        const ridge = 0.55 + 0.45 * (ridgeN * 0.5 + 0.5);                   // 0.55..1
        h += sEdge * mountainAmp * ridge;
      }

      const top = Math.max(2, Math.min(WORLD_Y - 1, h | 0));
      const mountainous = top >= stoneCapTop;

      // Bedrock floor (a bit thicker now that voxels are smaller).
      for (let by = 0; by < 4; by++) voxels[worldIndex(x, by, z)] = M_BEDROCK;

      if (mountainous) {
        // Bare-rock column. No dirt or grass cap so the edge ring reads as
        // mountains instead of a tall grassy bump.
        for (let y = 4; y <= top; y++) voxels[worldIndex(x, y, z)] = M_STONE;
      } else {
        // Stone column up to top - dirtDepth - grassDepth, dirt below grass, grass at top.
        const grassY = top;
        const dirtTopY = top - grassDepth;
        const stoneTopY = dirtTopY - dirtDepth;

        for (let y = 4; y < top; y++) {
          const idx = worldIndex(x, y, z);
          if (y <= stoneTopY) voxels[idx] = M_STONE;
          else voxels[idx] = M_DIRT;
        }
        voxels[worldIndex(x, grassY, z)] = M_GRASS;

        // Mud patches: low-elevation cells with high "moisture" become mud at the very
        // top. This swaps the grass voxel out for mud and replaces the next 1–2 dirt
        // voxels below with more mud, so a tank rolling through can sink several voxels
        // before it bottoms out on dirt.
        const elevationT = (h - baseHeight) / heightAmp; // -1 (low) .. +1 (high)
        const moisture = fbm2(x * (1 / 96), z * (1 / 96), seed + 4099, 3);
        // Mud iff elevation is below average AND moisture noise is positive enough.
        if (elevationT < -0.15 && moisture > 0.05) {
          voxels[worldIndex(x, grassY, z)] = M_MUD;
          const mudDepth = 1 + Math.floor((moisture - 0.05) * 6); // 1..3 voxels of mud
          for (let dy = 1; dy <= mudDepth; dy++) {
            const yy = grassY - dy;
            if (yy <= stoneTopY) break;
            voxels[worldIndex(x, yy, z)] = M_MUD;
          }
        }
      }

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
