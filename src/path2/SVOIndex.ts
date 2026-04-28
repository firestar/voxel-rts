import {
  CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_COUNT, chunkKey,
} from '../voxel/types';
import { WORLD_X, WORLD_Z } from '../voxel/VoxelWorld';
import {
  ChunkSVO, allocateChunkSVO, buildChunkSVO,
  querySVO, SVOLookup, SVO_LEAF_AIR, SVO_LEAF_SOLID, SVO_MIXED,
} from './SVO';
import {
  ChunkSVOAnnotation, allocateChunkSVOAnnotation, annotateChunkSVO,
  leafCost, LeafCost, UnitTraversal,
} from './SVOAnnotation';

/**
 * Index of one ChunkSVO per chunk in the world (CHUNKS_X × CHUNKS_Y × CHUNKS_Z).
 *
 * Builds and rebuilds piggyback on the existing per-chunk dirty bit tracked by
 * VoxelWorld. After voxel edits the caller invokes {@link rebuildDirty} (or
 * {@link rebuildAll} for the initial build) which scans the dirty buffer and
 * rebuilds only those chunks. Per-chunk rebuild is ~32 K voxel reads — small
 * enough that we don't bother with sub-chunk incremental updates yet.
 *
 * World-space queries route through this layer: it resolves the world
 * coordinate to a chunk, then hands off to {@link querySVO} on that chunk.
 *
 * Index layout matches `chunkKey(cx, cy, cz)` from voxel/types so callers can
 * share keys with the dirty buffer.
 */
/** World-space leaf lookup augmented with the chunk it lives in, so callers can
 * resolve annotations or follow up with adjacency queries. */
export interface WorldLookup extends SVOLookup {
  chunkKey: number;
}

export class SVOIndex {
  readonly chunks: ChunkSVO[];
  readonly annotations: ChunkSVOAnnotation[];

  constructor() {
    this.chunks = new Array(CHUNK_COUNT);
    this.annotations = new Array(CHUNK_COUNT);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      this.chunks[i] = allocateChunkSVO();
      this.annotations[i] = allocateChunkSVOAnnotation();
    }
  }

  /** Build SVOs and annotations for every chunk in the world. */
  rebuildAll(voxels: Uint8Array): void {
    for (let cy = 0; cy < CHUNKS_Y; cy++) {
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) {
          const k = chunkKey(cx, cy, cz);
          const svo = this.chunks[k]!;
          buildChunkSVO(svo, voxels, cx, cy, cz, WORLD_X, WORLD_Z);
          annotateChunkSVO(svo, this.annotations[k]!);
        }
      }
    }
  }

  /**
   * Rebuild every chunk whose dirty byte is non-zero, then clear those bits.
   * Returns the count of chunks rebuilt. Annotations rebuild in lockstep with
   * the SVO so callers always see consistent (geometry, traversal) pairs.
   *
   * `dirty` is the same buffer VoxelWorld writes to in `markDirty` — we read
   * and clear it in lockstep with the rebuild. Callers that need atomicity
   * (e.g. a worker thread) must coordinate externally; this is intentionally
   * just the simplest pull-style update.
   */
  rebuildDirty(voxels: Uint8Array, dirty: Uint8Array): number {
    let rebuilt = 0;
    for (let cy = 0; cy < CHUNKS_Y; cy++) {
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) {
          const k = chunkKey(cx, cy, cz);
          if (dirty[k] === 0) continue;
          const svo = this.chunks[k]!;
          buildChunkSVO(svo, voxels, cx, cy, cz, WORLD_X, WORLD_Z);
          annotateChunkSVO(svo, this.annotations[k]!);
          dirty[k] = 0;
          rebuilt++;
        }
      }
    }
    return rebuilt;
  }

  /**
   * Look up the leaf at world voxel coordinates (wx, wy, wz). Returns null if
   * out of bounds. Resolves to the chunk via integer division, then defers to
   * the per-chunk SVO query.
   */
  queryWorld(wx: number, wy: number, wz: number): WorldLookup | null {
    if (wx < 0 || wy < 0 || wz < 0) return null;
    const cx = (wx / CHUNK) | 0;
    const cy = (wy / CHUNK) | 0;
    const cz = (wz / CHUNK) | 0;
    if (cx >= CHUNKS_X || cy >= CHUNKS_Y || cz >= CHUNKS_Z) return null;
    const k = chunkKey(cx, cy, cz);
    const lookup = querySVO(
      this.chunks[k]!,
      wx - cx * CHUNK,
      wy - cy * CHUNK,
      wz - cz * CHUNK,
    );
    return { ...lookup, chunkKey: k };
  }

  /**
   * Per-unit traversal cost at the leaf containing world (wx, wy, wz). Returns
   * `canEnter: false` for OOB queries — callers shouldn't ask outside the world,
   * but null-checking the lookup at every site is noisy.
   */
  traversalAt(wx: number, wy: number, wz: number, unit: UnitTraversal): LeafCost {
    const lookup = this.queryWorld(wx, wy, wz);
    if (!lookup) return { canEnter: false, costMult: 0 };
    return leafCost(this.chunks[lookup.chunkKey]!, this.annotations[lookup.chunkKey]!, lookup.nodeIdx, unit);
  }

  /**
   * Sum of node counts across all chunks. The metric we care about for the
   * "sparse" claim — uniform-region collapse should keep this far below the
   * 200 M voxel count.
   */
  totalNodes(): number {
    let n = 0;
    for (let i = 0; i < CHUNK_COUNT; i++) n += this.chunks[i]!.count;
    return n;
  }
}

export { SVO_LEAF_AIR, SVO_LEAF_SOLID, SVO_MIXED };
