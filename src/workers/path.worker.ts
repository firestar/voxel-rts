/// <reference lib="webworker" />
/**
 * Path worker — runs A* / Theta* and incremental nav-grid rebuilds off the main
 * thread, reading and writing the same SharedArrayBuffer-backed VolumeGrid
 * and per-kind UnitGrid bitmaps the main thread holds. No copies cross the
 * postMessage boundary; only request descriptors and result waypoints do.
 *
 * Message protocol — see `PathWorkerClient` for the typed wrappers.
 *
 *   init                  → wire up shared buffers + register every unit profile.
 *   findPath              → run A* / Theta* against the shared grids.
 *   applyDamage           → rebuild volume + per-kind unit cells inside an AABB.
 *   rebuildAll            → full rebuild from the live voxel buffer.
 *   scanNearestMetal      → scan for the nearest air-exposed metal voxel near
 *                           the given world position (may return null).
 *
 * Ordering: postMessage delivers in FIFO order, and the worker processes
 * messages serially, so an `applyDamage` posted before a `findPath` is
 * guaranteed to have completed before the search runs.
 */
import { GRID_X, GRID_Y, GRID_Z, NAV_CELL_METERS, cellCenter, worldToCell } from '../path/Nav';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, VOXEL_SIZE } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { M_METAL } from '../voxel/Materials';
import {
  VolumeGrid, buildVolumeGrid, rebuildCell,
} from '../path/VolumeGrid';
import {
  UnitProfile, UnitGrid, buildUnitGrid, refreshUnitGridBox,
} from '../path/UnitGrid';
import {
  AStarWorkspace, findPath as runFindPath, findPathThetaStar, PathNode, PathResult,
} from '../path/AStar';

interface InitMsg {
  type: 'init';
  voxels: Uint8Array;
  volume: VolumeGrid;
  profiles: Array<{ profile: UnitProfile; passable: Uint8Array }>;
}

interface FindPathMsg {
  type: 'findPath';
  reqId: number;
  kind: string;
  start: PathNode;
  goal: PathNode;
  anyAngle: boolean;
  maxExpansions?: number;
  heuristicWeight?: number;
}

interface ApplyDamageMsg {
  type: 'applyDamage';
  reqId: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

interface RebuildAllMsg {
  type: 'rebuildAll';
  reqId: number;
}

interface ScanNearestMetalMsg {
  type: 'scanNearestMetal';
  reqId: number;
  /** World-meters position of the requesting worker unit. */
  wx: number; wy: number; wz: number;
  /** Search radius in world meters. */
  radiusM: number;
}

type InMsg = InitMsg | FindPathMsg | ApplyDamageMsg | RebuildAllMsg | ScanNearestMetalMsg;

let voxels: Uint8Array | null = null;
let volume: VolumeGrid | null = null;
const grids = new Map<string, UnitGrid>();
const ws = new AStarWorkspace();

self.onmessage = (ev: MessageEvent<InMsg>): void => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      voxels = msg.voxels;
      volume = msg.volume;
      grids.clear();
      for (const { profile, passable } of msg.profiles) {
        grids.set(profile.kind, { profile, passable });
      }
      (self as unknown as Worker).postMessage({ type: 'init', reqId: 0 });
      return;
    case 'findPath':
      handleFindPath(msg);
      return;
    case 'applyDamage':
      handleApplyDamage(msg);
      return;
    case 'rebuildAll':
      handleRebuildAll(msg);
      return;
    case 'scanNearestMetal':
      handleScanNearestMetal(msg);
      return;
  }
};

function handleFindPath(msg: FindPathMsg): void {
  const grid = grids.get(msg.kind);
  if (!grid || !volume) {
    (self as unknown as Worker).postMessage({
      type: 'findPath', reqId: msg.reqId, waypoints: [], reached: false, expanded: 0,
    });
    return;
  }
  const opts = {
    maxExpansions: msg.maxExpansions,
    heuristicWeight: msg.heuristicWeight,
    volume,
  };
  const res: PathResult = msg.anyAngle && grid.profile.footprintRadiusCells <= 1
    ? findPathThetaStar(grid, msg.start, msg.goal, ws, opts)
    : runFindPath(grid, msg.start, msg.goal, ws, opts);
  // Convert cells → world-space waypoints here (the main thread would do the
  // same conversion right after receiving the result).
  const waypoints: { x: number; y: number; z: number }[] = res.cells.length
    ? res.cells.map(c => cellCenter(c.cx, c.cy, c.cz))
    : [];
  (self as unknown as Worker).postMessage({
    type: 'findPath',
    reqId: msg.reqId,
    waypoints,
    reached: res.reached,
    expanded: res.expanded,
    timings: res.timings,
  });
}

function handleApplyDamage(msg: ApplyDamageMsg): void {
  if (!voxels || !volume) {
    (self as unknown as Worker).postMessage({ type: 'applyDamage', reqId: msg.reqId });
    return;
  }
  const c0 = worldToCell(msg.minX, msg.minY, msg.minZ);
  const c1 = worldToCell(msg.maxX, msg.maxY, msg.maxZ);
  const x0 = Math.max(0, c0.cx - 1);
  const y0 = Math.max(0, c0.cy - 1);
  const z0 = Math.max(0, c0.cz - 1);
  const x1 = Math.min(GRID_X - 1, c1.cx + 1);
  const y1 = Math.min(GRID_Y - 1, c1.cy + 1);
  const z1 = Math.min(GRID_Z - 1, c1.cz + 1);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        rebuildCell(voxels, volume, cx, cy, cz);
      }
    }
  }
  for (const grid of grids.values()) {
    refreshUnitGridBox(volume, grid, x0, y0, z0, x1, y1, z1);
  }
  (self as unknown as Worker).postMessage({ type: 'applyDamage', reqId: msg.reqId });
}

function handleRebuildAll(msg: RebuildAllMsg): void {
  if (!voxels || !volume) {
    (self as unknown as Worker).postMessage({ type: 'rebuildAll', reqId: msg.reqId });
    return;
  }
  buildVolumeGrid(voxels, volume);
  for (const grid of grids.values()) buildUnitGrid(volume, grid);
  (self as unknown as Worker).postMessage({ type: 'rebuildAll', reqId: msg.reqId });
}

/**
 * Scan the voxel buffer for the nearest metal-ore voxel within `radiusM`
 * metres of `(wx, wy, wz)` that has at least one air-adjacent face (i.e. is
 * "exposed" to some open void the worker can dig toward).  Runs entirely on
 * the path-worker thread so it cannot stall the main thread's render loop.
 */
function handleScanNearestMetal(msg: ScanNearestMetalMsg): void {
  if (!voxels) {
    (self as unknown as Worker).postMessage({ type: 'scanNearestMetal', reqId: msg.reqId, hit: null });
    return;
  }
  const radiusVoxels = Math.ceil(msg.radiusM / VOXEL_SIZE);
  const cx = Math.floor(msg.wx / VOXEL_SIZE);
  const cy = Math.floor(msg.wy / VOXEL_SIZE);
  const cz = Math.floor(msg.wz / VOXEL_SIZE);
  const x0 = Math.max(0, cx - radiusVoxels);
  const y0 = Math.max(0, cy - radiusVoxels);
  const z0 = Math.max(0, cz - radiusVoxels);
  const x1 = Math.min(WORLD_X - 1, cx + radiusVoxels);
  const y1 = Math.min(WORLD_Y - 1, cy + radiusVoxels);
  const z1 = Math.min(WORLD_Z - 1, cz + radiusVoxels);
  const r2vox = radiusVoxels * radiusVoxels;
  const STRIDE = 2;
  let best: { vx: number; vy: number; vz: number } | null = null;
  let bestD2 = Infinity;
  for (let y = y0; y <= y1; y += STRIDE) {
    const dyV = y - cy;
    for (let z = z0; z <= z1; z += STRIDE) {
      const dzV = z - cz;
      for (let x = x0; x <= x1; x += STRIDE) {
        const dxV = x - cx;
        const d2 = dxV * dxV + dyV * dyV + dzV * dzV;
        if (d2 >= bestD2 || d2 > r2vox) continue;
        if (voxels[worldIndex(x, y, z)] !== M_METAL) continue;
        if (!isVoxelExposed(voxels, x, y, z)) continue;
        bestD2 = d2;
        best = { vx: x, vy: y, vz: z };
      }
    }
  }
  (self as unknown as Worker).postMessage({
    type: 'scanNearestMetal', reqId: msg.reqId, hit: best,
  });
}

/** True when at least one of the 6 face-neighbours of (vx, vy, vz) is air. */
function isVoxelExposed(voxels: Uint8Array, vx: number, vy: number, vz: number): boolean {
  if (vx > 0           && voxels[worldIndex(vx - 1, vy, vz)] === AIR) return true;
  if (vx < WORLD_X - 1 && voxels[worldIndex(vx + 1, vy, vz)] === AIR) return true;
  if (vy > 0           && voxels[worldIndex(vx, vy - 1, vz)] === AIR) return true;
  if (vy < WORLD_Y - 1 && voxels[worldIndex(vx, vy + 1, vz)] === AIR) return true;
  if (vz > 0           && voxels[worldIndex(vx, vy, vz - 1)] === AIR) return true;
  if (vz < WORLD_Z - 1 && voxels[worldIndex(vx, vy, vz + 1)] === AIR) return true;
  return false;
}

// Silence "unused" — exported names aren't part of the worker protocol but
// keep the import graph honest in case future changes need them.
void GRID_X; void GRID_Y; void GRID_Z; void NAV_CELL_METERS;

export {};
