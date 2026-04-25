// World is in voxel units; voxel size in meters is VOXEL_SIZE.
export const VOXEL_SIZE = 0.25;

// Bounded map dimensions in voxels.
export const WORLD_X = 512;
export const WORLD_Y = 128;
export const WORLD_Z = 512;

export const CHUNK = 32;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;

export const CHUNKS_X = WORLD_X / CHUNK; // 16
export const CHUNKS_Y = WORLD_Y / CHUNK; // 4
export const CHUNKS_Z = WORLD_Z / CHUNK; // 16
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 1024

export type MaterialId = number; // 0 = air

export const AIR: MaterialId = 0;

export function chunkKey(cx: number, cy: number, cz: number): number {
  return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
}

export function localIndex(lx: number, ly: number, lz: number): number {
  // Y-major within a chunk so vertical slabs are contiguous (good for greedy mesh sweeps).
  return (ly * CHUNK + lz) * CHUNK + lx;
}
