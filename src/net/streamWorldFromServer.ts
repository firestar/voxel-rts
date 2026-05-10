// Drop-in replacement for `src/voxel/WorldGen.ts:generateWorld` that
// pulls the post-worldgen voxel state from the authoritative server
// instead of running the full local pipeline. Phase 6d of the
// zero-trust migration: the browser still holds a 1.5 GB voxel
// buffer (renderer + sim depend on it), but every byte of that
// buffer is sourced from `/world/chunk/raw` rather than the
// `worldgen.worker.ts` + roads/metals/trees passes.
//
// Memory: same as local generation (one 1.5 GB Uint8Array). Wire
// cost: 46 080 chunks × 32 KB raw ≈ 1.4 GB; nginx gzip + the fact
// that most chunks are uniform AIR/BEDROCK pulls the wire size
// down significantly. The fetcher dispatches CONCURRENCY chunks at a
// time so the server isn't slammed by a 46 K-deep request queue.

import { CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, localIndex } from '../voxel/types';
import { VoxelWorld, worldIndex } from '../voxel/VoxelWorld';
import { MetalCluster } from '../voxel/Metals';
import { WorldChunkClient, type ServerChunk } from './WorldChunkClient';

export interface StreamProgress {
  done: number;     // chunks completed
  total: number;    // total chunks
}

const TOTAL_CHUNKS = CHUNKS_X * CHUNKS_Y * CHUNKS_Z;
/** Max in-flight HTTP requests. Browsers cap concurrent connections to
 *  the same origin around 6–8; going higher just queues at the
 *  socket layer without speeding anything up. */
const CONCURRENCY = 8;

/** Stream the entire post-worldgen voxel state from the server into
 *  `world`'s voxel buffer, then fetch the canonical metal-cluster
 *  list. Same shape as `generateWorld(world, seed, onProgress)` so
 *  callers can swap the source without touching anything else. */
export async function streamWorldFromServer(
  world: VoxelWorld,
  seed: number,
  client: WorldChunkClient,
  onProgress?: (p: StreamProgress) => void,
): Promise<MetalCluster[]> {
  // Seed sanity check first — a mismatched seed at this stage means
  // the streamed chunks would be useless against the local sim's
  // assumed terrain. Surface as an error before we burn bandwidth.
  const seedInfo = await client.fetchSeed();
  if (seedInfo.locked && seedInfo.seed !== seed) {
    throw new Error(`server seed locked at ${seedInfo.seed}, browser asked for ${seed}`);
  }

  // Build the work queue. We walk Y-major (cy outer) so the surface
  // band (cy=2..3) finishes before the all-air canopy band (cy=4) —
  // the renderer can start meshing visible terrain sooner.
  const queue: Array<[number, number, number]> = new Array(TOTAL_CHUNKS);
  let qi = 0;
  for (let cy = 0; cy < CHUNKS_Y; cy++) {
    for (let cz = 0; cz < CHUNKS_Z; cz++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        queue[qi++] = [cx, cy, cz];
      }
    }
  }

  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const i = cursor++;
      const triple = queue[i]!;
      let chunk: ServerChunk;
      try {
        chunk = await client.fetchChunk(triple[0], triple[1], triple[2]);
      } catch (err) {
        // Best-effort: log and continue. A missing chunk leaves the
        // local buffer at AIR for those voxels, which the mesher will
        // render as empty space — visible bug but not fatal.
        console.warn(`[streamWorld] chunk (${triple.join(',')}) failed:`, err);
        done++;
        onProgress?.({ done, total: TOTAL_CHUNKS });
        continue;
      }
      writeChunkIntoWorld(world, chunk);
      done++;
      onProgress?.({ done, total: TOTAL_CHUNKS });
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  // Mark every chunk dirty so the mesher rebuilds from the freshly
  // streamed bytes, then fetch metals.
  world.markAllDirty();

  const metals = await client.fetchMetals();
  // Re-hydrate the browser-side `workerSlots` array per cluster — the
  // server doesn't track per-worker slot allocation (that's local
  // bookkeeping for the unit AI).
  return metals.clusters.map<MetalCluster>(c => ({
    ...c,
    workerSlots: new Array<number>(c.maxWorkers).fill(0),
  }));
}

/** Copy a chunk's Y-major chunk-local material bytes into the world's
 *  Y-major-then-Z-then-X full-world voxel array. */
function writeChunkIntoWorld(world: VoxelWorld, chunk: ServerChunk): void {
  const baseX = chunk.cx * CHUNK;
  const baseY = chunk.cy * CHUNK;
  const baseZ = chunk.cz * CHUNK;
  const dst = world.buffers.voxels;
  const src = chunk.voxels;
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      // Each Z-row is contiguous in both layouts; copy 32 bytes at a time.
      const srcRow = (ly * CHUNK + lz) * CHUNK; // localIndex(0, ly, lz)
      const dstRow = worldIndex(baseX, baseY + ly, baseZ + lz);
      dst.set(src.subarray(srcRow, srcRow + CHUNK), dstRow);
    }
  }
  // Single-cell sanity check that the loop maths agree with the index
  // helper — this is a no-op at runtime but cheap insurance against a
  // future refactor breaking either layout.
  if (chunk.cx === 0 && chunk.cy === 0 && chunk.cz === 0) {
    const probe = src[localIndex(0, 0, 0)]!;
    if (dst[worldIndex(0, 0, 0)] !== probe) {
      console.warn('[streamWorld] layout mismatch at (0,0,0)');
    }
  }
}
