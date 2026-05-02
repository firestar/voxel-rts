// World is in voxel units; voxel size in meters is VOXEL_SIZE.
export const VOXEL_SIZE = 0.125;

// Bounded map dimensions in voxels. 256 m x 24 m x 256 m at 0.125 m.
export const WORLD_X = 2048;
export const WORLD_Y = 192;
export const WORLD_Z = 2048;

export const CHUNK = 32;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;

export const CHUNKS_X = WORLD_X / CHUNK; // 64
export const CHUNKS_Y = WORLD_Y / CHUNK; // 6
export const CHUNKS_Z = WORLD_Z / CHUNK; // 64
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 24576

export type MaterialId = number; // 0 = air

export const AIR: MaterialId = 0;

export function chunkKey(cx: number, cy: number, cz: number): number {
  return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
}

export function localIndex(lx: number, ly: number, lz: number): number {
  // Y-major within a chunk so vertical slabs are contiguous (good for greedy mesh sweeps).
  return (ly * CHUNK + lz) * CHUNK + lx;
}
