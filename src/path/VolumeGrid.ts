/**
 * Voxel-summary grid. One entry per 1 m³ nav cell (393 K total) describing
 * what's inside the 8³ block of voxels: any-solid, any-bedrock, average dig
 * cost, and the voxel-y of the highest solid voxel inside the cell. Built
 * once from the world buffer and incrementally updated when chunks are
 * dirtied. Every per-unit-type grid is derived from this layer, so the
 * voxel scan only happens once across all unit kinds.
 */
import { WORLD_Y, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { MATERIALS, M_BEDROCK } from '../voxel/Materials';
import {
  NAV_CELL_VOXELS, GRID_X, GRID_Y, GRID_Z, GRID_COUNT,
  cellIndex, getBit, setBit, clearBit, allocateBitmap,
} from './Nav';

export interface VolumeGrid {
  /** 1 bit per cell — set when the cell contains *any* solid voxel. */
  solid: Uint8Array;
  /** 1 bit per cell — set when the cell contains *any* bedrock voxel. */
  bedrock: Uint8Array;
  /**
   * Per-cell extra cost to dig through (1..200). 0 when the cell is fully air.
   * Used by the digger A* so cutting through stone costs more than dirt.
   */
  digCost: Uint8Array;
  /**
   * Highest solid voxel y inside the cell, or 255 if the cell is fully air.
   * Used by the step-climb gate during pathfinding. Voxel y is in 0..WORLD_Y-1
   * (= 0..191), so a Uint8Array fits with 255 as the "all-air" sentinel.
   */
  topY: Uint8Array;
  /**
   * 1 byte per (cx, cz) nav column — set when a building's footprint occupies
   * this column. Marked off-limits to ground units regardless of the volume
   * grid's solid/bedrock bits, so units never path on top of building roofs
   * or through their interior. Maintained by BuildingManager (place sets
   * bits, destroy clears them); shared via SAB so the path worker and main
   * thread see the same mask.
   */
  buildingMask: Uint8Array;
}

export function allocateVolumeGrid(useShared: boolean): VolumeGrid {
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  return {
    solid: allocateBitmap(useShared, GRID_COUNT),
    bedrock: allocateBitmap(useShared, GRID_COUNT),
    digCost: new Uint8Array(new Buf(GRID_COUNT)),
    topY: new Uint8Array(new Buf(GRID_COUNT)),
    // GRID_X * GRID_Z = NAV_W * NAV_H — one byte per ground column.
    buildingMask: new Uint8Array(new Buf(GRID_X * GRID_Z)),
  };
}

/** Re-evaluate the contents of a single cell from the live voxel buffer. */
export function rebuildCell(voxels: Uint8Array, vg: VolumeGrid, cx: number, cy: number, cz: number): void {
  const i = cellIndex(cx, cy, cz);
  let solidCount = 0;
  let hpSum = 0;
  let hasBedrock = false;
  let topVoxelY = -1;
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
        if (m === M_BEDROCK) hasBedrock = true;
        hpSum += MATERIALS[m]!.hp;
        if (wy > topVoxelY) topVoxelY = wy;
      }
    }
  }
  if (solidCount > 0) {
    setBit(vg.solid, i);
    if (hasBedrock) setBit(vg.bedrock, i); else clearBit(vg.bedrock, i);
    const avg = hpSum / solidCount;
    vg.digCost[i] = Math.min(200, 1 + Math.round(avg / 30 * 4));
    vg.topY[i] = topVoxelY;
  } else {
    clearBit(vg.solid, i);
    clearBit(vg.bedrock, i);
    vg.digCost[i] = 0;
    vg.topY[i] = 255;
  }
}

export function buildVolumeGrid(voxels: Uint8Array, vg: VolumeGrid): void {
  for (let cy = 0; cy < GRID_Y; cy++) {
    for (let cz = 0; cz < GRID_Z; cz++) {
      for (let cx = 0; cx < GRID_X; cx++) {
        rebuildCell(voxels, vg, cx, cy, cz);
      }
    }
  }
}

/**
 * Refresh every cell that overlaps any of the world's dirty chunks. Each chunk
 * is `CHUNK` voxels = `CHUNK / NAV_CELL_VOXELS` cells per axis, so a single
 * dirty chunk maps to a small box of cells. Caller is responsible for clearing
 * the dirty flags afterwards (typically the mesher does that).
 */
export function rebuildVolumeFromDirtyChunks(
  voxels: Uint8Array,
  dirty: Uint8Array,
  chunksX: number, chunksY: number, chunksZ: number,
  chunkVoxels: number,
  vg: VolumeGrid,
): boolean {
  const cellsPerChunk = chunkVoxels / NAV_CELL_VOXELS;
  let touched = false;
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cz = 0; cz < chunksZ; cz++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const ck = (cy * chunksZ + cz) * chunksX + cx;
        if (dirty[ck] === 0) continue;
        touched = true;
        const x0 = cx * cellsPerChunk;
        const y0 = cy * cellsPerChunk;
        const z0 = cz * cellsPerChunk;
        for (let dy = 0; dy < cellsPerChunk; dy++) {
          for (let dz = 0; dz < cellsPerChunk; dz++) {
            for (let dx = 0; dx < cellsPerChunk; dx++) {
              rebuildCell(voxels, vg, x0 + dx, y0 + dy, z0 + dz);
            }
          }
        }
      }
    }
  }
  return touched;
}

/** True if the cell at (cx, cy, cz) contains any solid voxel. */
export function isCellSolid(vg: VolumeGrid, cx: number, cy: number, cz: number): boolean {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return true;
  return getBit(vg.solid, cellIndex(cx, cy, cz)) === 1;
}

/** True if the cell contains any bedrock — unconditional block, even for diggers. */
export function isCellBedrock(vg: VolumeGrid, cx: number, cy: number, cz: number): boolean {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return true;
  return getBit(vg.bedrock, cellIndex(cx, cy, cz)) === 1;
}

export { GRID_X, GRID_Y, GRID_Z, GRID_COUNT, cellIndex };
export const VOLUME_VOXELS_PER_CELL = NAV_CELL_VOXELS ** 3;
export const WORLD_TOP_Y = WORLD_Y;
