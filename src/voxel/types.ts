// World is in voxel units; voxel size in meters is VOXEL_SIZE.
export const VOXEL_SIZE = 0.125;

// Bounded map dimensions in voxels. 384 m x 20 m x 384 m at 0.125 m
// (1.5× the 256 m baseline → 2.25× playable area). 4× area (4096²)
// blew past the browser's SharedArrayBuffer ceiling (~2 GB on most
// Chromes); 3072² × 160 lands at ~1.5 GB which loads reliably.
export const WORLD_X = 3072;
export const WORLD_Y = 160;
export const WORLD_Z = 3072;

export const CHUNK = 32;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;

export const CHUNKS_X = WORLD_X / CHUNK; // 96
export const CHUNKS_Y = WORLD_Y / CHUNK; // 5
export const CHUNKS_Z = WORLD_Z / CHUNK; // 96
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 46080

export type MaterialId = number; // 0 = air

export const AIR: MaterialId = 0;

export function chunkKey(cx: number, cy: number, cz: number): number {
  return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
}

export function localIndex(lx: number, ly: number, lz: number): number {
  // Y-major within a chunk so vertical slabs are contiguous (good for greedy mesh sweeps).
  return (ly * CHUNK + lz) * CHUNK + lx;
}
