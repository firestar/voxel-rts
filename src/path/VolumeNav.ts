/**
 * Compatibility surface over the new {@link VolumeGrid}. The old volume-nav
 * module exposed `VNAV_X/Y/Z`, `vnavIndex`, `getBit`, `allocateVolumeNav`,
 * `buildVolumeNav`, etc., and a handful of consumers (Units.tickVolume, Game,
 * a few tests) still reach for them. Rather than churn every callsite we
 * re-export those names here, backed by the new pathfinder primitives.
 *
 * The new architecture's "passable for this unit" data lives in per-unit-type
 * grids (UnitGrid). This file is purely the shared 3D voxel summary used by
 * the runtime to decide things like "is the destination cell still solid, so
 * the digger should carve" — same intent as before, same bit layout, just a
 * thinner implementation.
 */
import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE } from '../voxel/types';
import {
  NAV_CELL_VOXELS, GRID_X, GRID_Y, GRID_Z, GRID_COUNT, cellIndex,
} from './Nav';
import {
  VolumeGrid, allocateVolumeGrid, buildVolumeGrid, rebuildCell,
} from './VolumeGrid';

export const VNAV_X = GRID_X;
export const VNAV_Y = GRID_Y;
export const VNAV_Z = GRID_Z;
export const VNAV_COUNT = GRID_COUNT;
export const VNAV_CELL_METERS = NAV_CELL_VOXELS * VOXEL_SIZE;
export const VNAV_VOXELS_PER_CELL = NAV_CELL_VOXELS ** 3;

export interface VolumeNavBuffers {
  solid: Uint8Array;
  bedrock: Uint8Array;
  digCost: Uint8Array;
  /**
   * Voxel-y of the highest solid voxel inside each cell, or 255 if all-air.
   * Replaces the old `surfaceConnected` flood-fill bitmap (the new pathfinder
   * uses per-unit grids instead, so the sealed-cave gate is no longer needed
   * — units route into caves only when their body actually fits the corridor).
   */
  topY: Uint8Array;
  /**
   * Same shape as the old buffer for callers that still write to it. Always 0
   * after build; kept so any legacy code that consults it sees a defined
   * length and a benign value (no surface-connected gate any more).
   */
  surfaceConnected: Uint8Array;
}

export function vnavIndex(cx: number, cy: number, cz: number): number {
  return cellIndex(cx, cy, cz);
}

export function getBit(arr: Uint8Array, i: number): number {
  return (arr[i >> 3]! >> (i & 7)) & 1;
}

export function allocateVolumeNav(useShared: boolean): VolumeNavBuffers {
  const vg = allocateVolumeGrid(useShared);
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  const surfaceConnected = new Uint8Array(new Buf((GRID_COUNT + 7) >> 3));
  return {
    solid: vg.solid,
    bedrock: vg.bedrock,
    digCost: vg.digCost,
    topY: vg.topY,
    surfaceConnected,
  };
}

export function buildVolumeNav(voxels: Uint8Array, vnav: VolumeNavBuffers): void {
  const vg: VolumeGrid = {
    solid: vnav.solid,
    bedrock: vnav.bedrock,
    digCost: vnav.digCost,
    topY: vnav.topY,
    // VolumeNav doesn't own a building footprint mask — the legacy callers
    // (Units.tickVolume, sealed-cave checks) only consult solid/bedrock.
    // Pass a zero-length view so the type-check is satisfied without
    // allocating; rebuildCell never reads this field.
    buildingMask: new Uint8Array(0),
  };
  buildVolumeGrid(voxels, vg);
}

export function rebuildVolumeCell(voxels: Uint8Array, vnav: VolumeNavBuffers, cx: number, cy: number, cz: number): void {
  const vg: VolumeGrid = {
    solid: vnav.solid,
    bedrock: vnav.bedrock,
    digCost: vnav.digCost,
    topY: vnav.topY,
    buildingMask: new Uint8Array(0),
  };
  rebuildCell(voxels, vg, cx, cy, cz);
}

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

export { WORLD_X, WORLD_Y, WORLD_Z };
