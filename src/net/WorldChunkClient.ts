// Browser bridge to the server's chunked voxel endpoint. The server
// owns the canonical post-worldgen voxel state (heightmap + roads +
// metals + trees + clearAboveRoads + every in-game edit so far);
// this client lets the browser fetch any 32³ chunk over plain HTTP.
//
// Phase 6c-6 of the zero-trust migration uses this for *parity
// verification* — after local worldgen runs, sample a few chunks from
// the server and compare to the local voxel buffer. Future phases
// will use the same client to actually populate the world from the
// server (lazy chunk loading, replacing the local worldgen pass).

import { CHUNK, CHUNK_VOL, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, localIndex } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';

const DEFAULT_CHUNK_URL = '/world/chunk/raw';
const DEFAULT_SEED_URL = '/world/seed';
const DEFAULT_METALS_URL = '/world/metals';

export interface ServerChunk {
  cx: number; cy: number; cz: number;
  /** Y-major chunk-local material bytes (length CHUNK_VOL). */
  voxels: Uint8Array;
  worldSeed: number;
  /** Most recent voxel-edit sequence the server applied before
   *  serving this chunk. Useful when later phases add lazy-load with
   *  per-chunk rev tracking. */
  voxelEditSeq: number;
}

export interface ServerSeedInfo {
  seed: number;
  locked: boolean;
  defaultSeed: number;
}

/** Server-shaped metal cluster — `workerSlots` is browser-side
 *  bookkeeping so it's not on the wire. The streaming worldgen
 *  refills it from `maxWorkers` after fetching. */
export interface ServerMetalCluster {
  id: number;
  vx: number; vy: number; vz: number;
  rxz: number; ry: number;
  surfaceTop: number;
  worldX: number; worldY: number; worldZ: number;
  voxelCount: number;
  totalMetal: number;
  maxMetal: number;
  destroyed: boolean;
  maxWorkers: number;
}

export interface ServerMetalsPayload {
  seed: number;
  clusters: ServerMetalCluster[];
}

export class WorldChunkClient {
  private chunkUrl: string;
  private seedUrl: string;
  private metalsUrl: string;

  constructor(opts: { chunkUrl?: string; seedUrl?: string; metalsUrl?: string } = {}) {
    this.chunkUrl = opts.chunkUrl ?? DEFAULT_CHUNK_URL;
    this.seedUrl = opts.seedUrl ?? DEFAULT_SEED_URL;
    this.metalsUrl = opts.metalsUrl ?? DEFAULT_METALS_URL;
  }

  /** Fetch the server's authoritative metal-pile cluster list. */
  async fetchMetals(): Promise<ServerMetalsPayload> {
    const r = await fetch(this.metalsUrl);
    if (!r.ok) throw new Error(`/world/metals failed: ${r.status}`);
    return await r.json() as ServerMetalsPayload;
  }

  /** Fetch the server's current world seed metadata. */
  async fetchSeed(): Promise<ServerSeedInfo> {
    const r = await fetch(this.seedUrl);
    if (!r.ok) throw new Error(`/world/seed failed: ${r.status}`);
    return await r.json() as ServerSeedInfo;
  }

  /** Fetch a single chunk's authoritative voxel state. Throws on
   *  HTTP error; out-of-bounds chunk indices yield 416. */
  async fetchChunk(cx: number, cy: number, cz: number): Promise<ServerChunk> {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= CHUNKS_X || cy >= CHUNKS_Y || cz >= CHUNKS_Z) {
      throw new Error(`chunk out of world bounds: (${cx}, ${cy}, ${cz})`);
    }
    const url = `${this.chunkUrl}?cx=${cx}&cy=${cy}&cz=${cz}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`/world/chunk/raw (${cx}, ${cy}, ${cz}) failed: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length !== CHUNK_VOL) {
      throw new Error(`/world/chunk/raw returned ${buf.length} bytes, expected ${CHUNK_VOL}`);
    }
    const seed = Number.parseInt(r.headers.get('X-World-Seed') ?? '0', 10);
    const editSeq = Number.parseInt(r.headers.get('X-Voxel-Edit-Seq') ?? '0', 10);
    return { cx, cy, cz, voxels: buf, worldSeed: seed, voxelEditSeq: editSeq };
  }

  /** Compare a server chunk against an in-memory full-world voxel
   *  buffer; returns the first differing voxel or null when match. */
  static diffAgainstWorld(chunk: ServerChunk, voxels: Uint8Array): {
    lx: number; ly: number; lz: number;
    expected: number; got: number;
  } | null {
    const baseX = chunk.cx * CHUNK;
    const baseY = chunk.cy * CHUNK;
    const baseZ = chunk.cz * CHUNK;
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const got = chunk.voxels[localIndex(lx, ly, lz)]!;
          const expected = voxels[worldIndex(baseX + lx, baseY + ly, baseZ + lz)]!;
          if (got !== expected) return { lx, ly, lz, expected, got };
        }
      }
    }
    return null;
  }
}
