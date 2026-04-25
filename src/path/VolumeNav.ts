import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { MATERIALS, M_BEDROCK } from '../voxel/Materials';
import { NAV_CELL_VOXELS } from './SurfaceNav';

// 1m volume cells = 4 voxels per side.
export const VNAV_X = WORLD_X / NAV_CELL_VOXELS; // 128
export const VNAV_Y = WORLD_Y / NAV_CELL_VOXELS; // 32
export const VNAV_Z = WORLD_Z / NAV_CELL_VOXELS; // 128
export const VNAV_COUNT = VNAV_X * VNAV_Y * VNAV_Z; // 524288
export const VNAV_CELL_METERS = NAV_CELL_VOXELS * VOXEL_SIZE; // 1.0
export const VNAV_VOXELS_PER_CELL = NAV_CELL_VOXELS ** 3; // 64

export interface VolumeNavBuffers {
  /** Bit-packed: 1 if cell contains any solid voxel. 1 byte per 8 cells. */
  solid: Uint8Array;
  /** Bit-packed: 1 if cell contains any bedrock voxel (impassable to tunnelers). */
  bedrock: Uint8Array;
  /** Per-cell extra cost to enter when solid (1..200). 0 when empty. */
  digCost: Uint8Array;
}

export function vnavIndex(x: number, y: number, z: number): number {
  return (y * VNAV_Z + z) * VNAV_X + x;
}

export function getBit(arr: Uint8Array, i: number): number {
  return (arr[i >> 3]! >> (i & 7)) & 1;
}

function setBit(arr: Uint8Array, i: number): void {
  arr[i >> 3]! |= (1 << (i & 7));
}

function clearBit(arr: Uint8Array, i: number): void {
  arr[i >> 3]! &= ~(1 << (i & 7));
}

export function allocateVolumeNav(useShared: boolean): VolumeNavBuffers {
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  const bitBytes = (VNAV_COUNT + 7) >> 3;
  return {
    solid: new Uint8Array(new Buf(bitBytes)),
    bedrock: new Uint8Array(new Buf(bitBytes)),
    digCost: new Uint8Array(new Buf(VNAV_COUNT)),
  };
}

/**
 * Build the volume nav grid from the voxel buffer. Per cell, scans all 64 voxels:
 * - solid bit set if any voxel != AIR
 * - bedrock bit set if any voxel is bedrock
 * - digCost = 1 + sum_hp / N (clamped); 0 if empty
 */
export function buildVolumeNav(voxels: Uint8Array, vnav: VolumeNavBuffers): void {
  vnav.solid.fill(0);
  vnav.bedrock.fill(0);
  vnav.digCost.fill(0);
  for (let cy = 0; cy < VNAV_Y; cy++) {
    for (let cz = 0; cz < VNAV_Z; cz++) {
      for (let cx = 0; cx < VNAV_X; cx++) {
        const i = vnavIndex(cx, cy, cz);
        let solidCount = 0;
        let hpSum = 0;
        let hasBedrock = false;
        const wxStart = cx * NAV_CELL_VOXELS;
        const wyStart = cy * NAV_CELL_VOXELS;
        const wzStart = cz * NAV_CELL_VOXELS;
        for (let dy = 0; dy < NAV_CELL_VOXELS; dy++) {
          const wy = wyStart + dy;
          for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
            const wz = wzStart + dz;
            for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
              const m = voxels[worldIndex(wxStart + dx, wy, wz)]!;
              if (m === AIR) continue;
              solidCount++;
              if (m === M_BEDROCK) { hasBedrock = true; }
              hpSum += MATERIALS[m]!.hp;
            }
          }
        }
        if (solidCount > 0) {
          setBit(vnav.solid, i);
          if (hasBedrock) setBit(vnav.bedrock, i);
          // Avg HP / 30 + 1, clamped.
          const avg = hpSum / solidCount;
          const cost = Math.min(200, 1 + Math.round(avg / 30 * 4));
          vnav.digCost[i] = cost;
        } else {
          clearBit(vnav.solid, i);
          clearBit(vnav.bedrock, i);
          vnav.digCost[i] = 0;
        }
      }
    }
  }
}

/** Translate world meters → volume cell coords (clamped). */
export function worldToVolumeCell(wx: number, wy: number, wz: number): { cx: number; cy: number; cz: number } {
  const cx = Math.max(0, Math.min(VNAV_X - 1, Math.floor(wx / VNAV_CELL_METERS)));
  const cy = Math.max(0, Math.min(VNAV_Y - 1, Math.floor(wy / VNAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(VNAV_Z - 1, Math.floor(wz / VNAV_CELL_METERS)));
  return { cx, cy, cz };
}

export function volumeCellCenter(cx: number, cy: number, cz: number): { x: number; y: number; z: number } {
  return {
    x: (cx + 0.5) * VNAV_CELL_METERS,
    y: (cy + 0.5) * VNAV_CELL_METERS,
    z: (cz + 0.5) * VNAV_CELL_METERS,
  };
}
