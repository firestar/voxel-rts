// Worldgen parity check between the browser's local generation and
// the authoritative server's `/world/chunk/raw` output.
//
// Phase 6c-6: a sanity gate to catch divergence between
// `src/voxel/WorldGen.ts` (browser) and `worldgen.cjs` (server)
// before the migration cuts over to server-streaming. We sample a
// handful of chunks spanning the playable surface, the mountain
// edge, and the high-Y canopy band, and report any voxel mismatch
// with chunk + local coords for fast triage.

import { CHUNKS_X, CHUNKS_Z } from '../voxel/types';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import { WorldChunkClient } from './WorldChunkClient';

export interface ServerParityResult {
  /** Number of chunks sampled. */
  sampled: number;
  /** Number of chunks that matched byte-for-byte. */
  matched: number;
  /** Per-chunk mismatches. Empty array == full parity. */
  mismatches: Array<{
    cx: number; cy: number; cz: number;
    lx: number; ly: number; lz: number;
    expected: number; got: number;
  }>;
  /** Server seed at the time of the sample. Useful when a mismatch
   *  is actually a seed mismatch, not a worldgen divergence. */
  serverSeed: number;
}

/** Sample chunks chosen to exercise different regions of the
 *  generator: dead-centre plain, the mountain ring, far corner, and
 *  the high-Y band where canopy + air dominate. Y indices are picked
 *  to land in or just above the surface band. */
const DEFAULT_SAMPLE_CHUNKS: Array<[number, number, number]> = [
  [CHUNKS_X >> 1, 3, CHUNKS_Z >> 1],
  [4, 3, 4],
  [CHUNKS_X - 5, 3, CHUNKS_Z - 5],
  [48, 3, 48],
  [48, 4, 48],
];

/** Compare a sample of server chunks against the local voxel buffer.
 *  Returns a result object even on transport failure (with
 *  `sampled = 0` and the error logged), so callers can decide how to
 *  surface the mismatch without crashing the boot path. */
export async function verifyServerWorldParity(
  world: VoxelWorld,
  client: WorldChunkClient,
  expectedSeed: number,
  samples: ReadonlyArray<readonly [number, number, number]> = DEFAULT_SAMPLE_CHUNKS,
): Promise<ServerParityResult> {
  const result: ServerParityResult = {
    sampled: 0, matched: 0,
    mismatches: [],
    serverSeed: expectedSeed,
  };

  let seedInfo;
  try {
    seedInfo = await client.fetchSeed();
  } catch (err) {
    console.warn('[worldgen-parity] /world/seed unreachable:', err);
    return result;
  }
  result.serverSeed = seedInfo.seed;
  if (seedInfo.seed !== expectedSeed) {
    console.warn(
      `[worldgen-parity] server seed mismatch — local=${expectedSeed}, server=${seedInfo.seed}` +
      (seedInfo.locked ? ' (locked)' : ' (default — set_world_seed not yet applied)'));
  }

  for (const [cx, cy, cz] of samples) {
    let chunk;
    try {
      chunk = await client.fetchChunk(cx, cy, cz);
    } catch (err) {
      console.warn(`[worldgen-parity] failed to fetch chunk (${cx},${cy},${cz}):`, err);
      continue;
    }
    result.sampled++;
    const diff = WorldChunkClient.diffAgainstWorld(chunk, world.buffers.voxels);
    if (!diff) {
      result.matched++;
      continue;
    }
    result.mismatches.push({ cx, cy, cz, ...diff });
  }

  if (result.mismatches.length === 0 && result.sampled > 0) {
    console.info(`[worldgen-parity] OK — ${result.matched}/${result.sampled} chunks match server seed=${result.serverSeed}`);
  } else if (result.mismatches.length > 0) {
    console.warn(
      `[worldgen-parity] FAIL — ${result.mismatches.length}/${result.sampled} chunks differ:`,
      result.mismatches.slice(0, 5),
    );
  }

  return result;
}
