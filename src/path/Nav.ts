/**
 * Pathfinding grid constants. The world is 3072 × 160 × 3072 voxels at
 * 0.125 m/voxel; each nav cell is an 8-voxel cube = 1 m on a side.
 * That gives a 384 × 20 × 384 grid (≈ 2.95 M cells), still cheap enough
 * to keep a passable bitmap per unit kind (~360 KB each).
 */
import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE } from '../voxel/types';

export const NAV_CELL_VOXELS = 8;
export const NAV_CELL_METERS = NAV_CELL_VOXELS * VOXEL_SIZE; // 1.0
export const GRID_X = WORLD_X / NAV_CELL_VOXELS;             // 384
export const GRID_Y = WORLD_Y / NAV_CELL_VOXELS;             // 20
export const GRID_Z = WORLD_Z / NAV_CELL_VOXELS;             // 384
export const GRID_COUNT = GRID_X * GRID_Y * GRID_Z;          // 2_949_120

/** Linear cell index: y-major, then z, then x. */
export function cellIndex(cx: number, cy: number, cz: number): number {
  return (cy * GRID_Z + cz) * GRID_X + cx;
}

/** Decompose a flat index back into cell coordinates. */
export function unpackCell(i: number): { cx: number; cy: number; cz: number } {
  const cx = i % GRID_X;
  const tmp = (i / GRID_X) | 0;
  const cz = tmp % GRID_Z;
  const cy = (tmp / GRID_Z) | 0;
  return { cx, cy, cz };
}

/** World meters → cell coords (clamped to grid). */
export function worldToCell(wx: number, wy: number, wz: number): { cx: number; cy: number; cz: number } {
  const cx = Math.max(0, Math.min(GRID_X - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cy = Math.max(0, Math.min(GRID_Y - 1, Math.floor(wy / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(GRID_Z - 1, Math.floor(wz / NAV_CELL_METERS)));
  return { cx, cy, cz };
}

/** Cell center in world meters. */
export function cellCenter(cx: number, cy: number, cz: number): { x: number; y: number; z: number } {
  return {
    x: (cx + 0.5) * NAV_CELL_METERS,
    y: (cy + 0.5) * NAV_CELL_METERS,
    z: (cz + 0.5) * NAV_CELL_METERS,
  };
}

/** Bit-packed bitmap helpers. */
export function getBit(arr: Uint8Array, i: number): number {
  return (arr[i >> 3]! >> (i & 7)) & 1;
}
export function setBit(arr: Uint8Array, i: number): void {
  arr[i >> 3]! |= (1 << (i & 7));
}
export function clearBit(arr: Uint8Array, i: number): void {
  arr[i >> 3]! &= ~(1 << (i & 7));
}

export function allocateBitmap(useShared: boolean, bits: number): Uint8Array {
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  return new Uint8Array(new Buf((bits + 7) >> 3));
}
