import {
  WORLD_X, WORLD_Y, WORLD_Z, CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_COUNT,
  AIR, MaterialId, chunkKey,
} from './types';

// Linear voxel index in the entire world (Y-major, then Z, then X).
// Chosen so that horizontal slabs are contiguous (cache-friendly heightmap fill, Y-axis greedy sweeps).
export function worldIndex(x: number, y: number, z: number): number {
  return (y * WORLD_Z + z) * WORLD_X + x;
}

export const WORLD_VOLUME = WORLD_X * WORLD_Y * WORLD_Z;

export interface WorldBuffers {
  /** Material id per voxel (0 = air). */
  voxels: Uint8Array;
  /** Per-chunk dirty flag (1 byte). Set by edits, cleared by mesher. */
  dirty: Uint8Array;
  /** Per-chunk mesh version, bumped each remesh. Used by renderer to detect updates. */
  version: Int32Array;
}

export function allocateWorldBuffers(useShared: boolean): WorldBuffers {
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined'
    ? SharedArrayBuffer
    : ArrayBuffer;
  const voxels = new Uint8Array(new Buf(WORLD_VOLUME));
  const dirty = new Uint8Array(new Buf(CHUNK_COUNT));
  const version = new Int32Array(new Buf(CHUNK_COUNT * 4));
  return { voxels, dirty, version };
}

export class VoxelWorld {
  readonly buffers: WorldBuffers;

  constructor(buffers: WorldBuffers) {
    this.buffers = buffers;
  }

  static create(useShared = true): VoxelWorld {
    return new VoxelWorld(allocateWorldBuffers(useShared));
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z;
  }

  get(x: number, y: number, z: number): MaterialId {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.buffers.voxels[worldIndex(x, y, z)]!;
  }

  set(x: number, y: number, z: number, m: MaterialId): void {
    if (!this.inBounds(x, y, z)) return;
    this.buffers.voxels[worldIndex(x, y, z)] = m;
    this.markDirty(x, y, z);
  }

  /** Mark the chunk containing (x,y,z) dirty, plus any neighbor whose face the voxel touches. */
  markDirty(x: number, y: number, z: number): void {
    const cx = (x / CHUNK) | 0;
    const cy = (y / CHUNK) | 0;
    const cz = (z / CHUNK) | 0;
    this.buffers.dirty[chunkKey(cx, cy, cz)] = 1;
    const lx = x - cx * CHUNK;
    const ly = y - cy * CHUNK;
    const lz = z - cz * CHUNK;
    if (lx === 0 && cx > 0) this.buffers.dirty[chunkKey(cx - 1, cy, cz)] = 1;
    if (lx === CHUNK - 1 && cx < CHUNKS_X - 1) this.buffers.dirty[chunkKey(cx + 1, cy, cz)] = 1;
    if (ly === 0 && cy > 0) this.buffers.dirty[chunkKey(cx, cy - 1, cz)] = 1;
    if (ly === CHUNK - 1 && cy < CHUNKS_Y - 1) this.buffers.dirty[chunkKey(cx, cy + 1, cz)] = 1;
    if (lz === 0 && cz > 0) this.buffers.dirty[chunkKey(cx, cy, cz - 1)] = 1;
    if (lz === CHUNK - 1 && cz < CHUNKS_Z - 1) this.buffers.dirty[chunkKey(cx, cy, cz + 1)] = 1;
  }

  markAllDirty(): void {
    this.buffers.dirty.fill(1);
  }
}

export { CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_COUNT, WORLD_X, WORLD_Y, WORLD_Z };
