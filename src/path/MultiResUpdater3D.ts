import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { MATERIALS, M_BEDROCK } from '../voxel/Materials';
import { NAV_CELL_VOXELS } from './SurfaceNav';
import {
  VolumeNavBuffers, vnavIndex, getBit,
  VNAV_X, VNAV_Y, VNAV_Z, VNAV_COUNT,
} from './VolumeNav';
import {
  MultiResNav3D, ResLevel3D, superCellIndex,
  rebuildSuperCellPlanes, rebuildSuperCellFaceEdges,
} from './MultiResNav3D';

export interface VoxelEdit {
  /** World-voxel AABB (inclusive min, exclusive max). */
  vx0: number; vy0: number; vz0: number;
  vx1: number; vy1: number; vz1: number;
}

/** Bounded re-flood radius for the surfaceConnected approximation. */
const SURFACE_REFLOOD_HOPS = 200;

function setBit(arr: Uint8Array, i: number): void {
  arr[i >> 3]! |= (1 << (i & 7));
}
function clearBit(arr: Uint8Array, i: number): void {
  arr[i >> 3]! &= ~(1 << (i & 7));
}

/**
 * Force-rebuild a single super-cell at a level: planes, cellPlaneMap slice,
 * bedrockOnly/avgDigCost, and every edge through any of its 6 faces (which
 * also touches the relevant neighbour-side edges). Exposed for tests and used
 * internally by applyEdits.
 */
export function rebuildSuperCell(
  vnav: VolumeNavBuffers,
  level: ResLevel3D,
  sx: number, sy: number, sz: number,
  navW: number, navH: number, navD: number,
): void {
  if (level.factor === 1) return;
  rebuildSuperCellPlanes(vnav, level, sx, sy, sz, navW, navH, navD);
  rebuildSuperCellFaceEdges(vnav, level, sx, sy, sz, navW, navH, navD);
}

/**
 * Recompute one base nav cell from the underlying voxel buffer. Returns the
 * solid bit value AFTER the recompute (0 or 1). Mirrors the per-cell loop in
 * buildVolumeNav (src/path/VolumeNav.ts:63-105).
 */
function recomputeBaseCell(voxels: Uint8Array, vnav: VolumeNavBuffers, cx: number, cy: number, cz: number): number {
  const i = vnavIndex(cx, cy, cz);
  let solidCount = 0;
  let hpSum = 0;
  let hasBedrock = false;
  const wxStart = cx * NAV_CELL_VOXELS;
  const wyStart = cy * NAV_CELL_VOXELS;
  const wzStart = cz * NAV_CELL_VOXELS;
  for (let dy = 0; dy < NAV_CELL_VOXELS; dy++) {
    const wy = wyStart + dy;
    if (wy >= WORLD_Y) break;
    for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
      const wz = wzStart + dz;
      if (wz >= WORLD_Z) break;
      for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
        const wx = wxStart + dx;
        if (wx >= WORLD_X) break;
        const m = voxels[worldIndex(wx, wy, wz)]!;
        if (m === AIR) continue;
        solidCount++;
        if (m === M_BEDROCK) hasBedrock = true;
        hpSum += MATERIALS[m]!.hp;
      }
    }
  }
  if (solidCount > 0) {
    setBit(vnav.solid, i);
    if (hasBedrock) setBit(vnav.bedrock, i); else clearBit(vnav.bedrock, i);
    const avg = hpSum / solidCount;
    vnav.digCost[i] = Math.min(200, 1 + Math.round(avg / 30 * 4));
    return 1;
  }
  clearBit(vnav.solid, i);
  clearBit(vnav.bedrock, i);
  vnav.digCost[i] = 0;
  return 0;
}

/**
 * TODO: surfaceConnected here is approximate. We do a bounded BFS from cells
 * that just became air (capped at SURFACE_REFLOOD_HOPS) and OR in any cells
 * the BFS reaches that connect to an already-marked surface cell. Cells that
 * just became solid get their bit cleared. This won't catch sealed pockets
 * that are now disconnected from the surface, nor newly-opened pockets more
 * than SURFACE_REFLOOD_HOPS hops from a known surface-connected cell. The next
 * full nav rebuild fixes any drift. Tests do not assert surfaceConnected after
 * applyEdits — only initial-build correctness.
 */
function updateSurfaceConnectedApprox(
  vnav: VolumeNavBuffers,
  becameAir: number[],
  becameSolid: number[],
): void {
  for (const i of becameSolid) clearBit(vnav.surfaceConnected, i);
  if (becameAir.length === 0) return;

  // Bounded BFS from any air seed. If the search reaches an already-marked
  // surface-connected cell, every cell visited along the way is marked too.
  const visited = new Uint8Array((VNAV_COUNT + 7) >> 3);
  const queue = new Int32Array(VNAV_COUNT);
  for (const seed of becameAir) {
    if (getBit(vnav.solid, seed) === 1) continue;
    if (getBit(visited, seed) === 1) continue;
    let qhead = 0;
    let qtail = 0;
    queue[qtail++] = seed;
    setBit(visited, seed);
    const path: number[] = [];
    let foundSurface = getBit(vnav.surfaceConnected, seed) === 1;
    let hops = 0;
    while (qhead < qtail && hops < SURFACE_REFLOOD_HOPS) {
      const i = queue[qhead++]!;
      hops++;
      path.push(i);
      if (getBit(vnav.surfaceConnected, i) === 1) { foundSurface = true; break; }
      const cx = i % VNAV_X;
      const tmp = (i / VNAV_X) | 0;
      const cz = tmp % VNAV_Z;
      const cy = (tmp / VNAV_Z) | 0;
      // Top of the world is implicitly surface — seed it as well.
      if (cy === VNAV_Y - 1) { foundSurface = true; break; }
      if (cx + 1 < VNAV_X) {
        const ni = vnavIndex(cx + 1, cy, cz);
        if (getBit(vnav.solid, ni) === 0 && getBit(visited, ni) === 0) { setBit(visited, ni); queue[qtail++] = ni; }
      }
      if (cx > 0) {
        const ni = vnavIndex(cx - 1, cy, cz);
        if (getBit(vnav.solid, ni) === 0 && getBit(visited, ni) === 0) { setBit(visited, ni); queue[qtail++] = ni; }
      }
      if (cz + 1 < VNAV_Z) {
        const ni = vnavIndex(cx, cy, cz + 1);
        if (getBit(vnav.solid, ni) === 0 && getBit(visited, ni) === 0) { setBit(visited, ni); queue[qtail++] = ni; }
      }
      if (cz > 0) {
        const ni = vnavIndex(cx, cy, cz - 1);
        if (getBit(vnav.solid, ni) === 0 && getBit(visited, ni) === 0) { setBit(visited, ni); queue[qtail++] = ni; }
      }
      if (cy + 1 < VNAV_Y) {
        const ni = vnavIndex(cx, cy + 1, cz);
        if (getBit(vnav.solid, ni) === 0 && getBit(visited, ni) === 0) { setBit(visited, ni); queue[qtail++] = ni; }
      }
      if (cy > 0) {
        const ni = vnavIndex(cx, cy - 1, cz);
        if (getBit(vnav.solid, ni) === 0 && getBit(visited, ni) === 0) { setBit(visited, ni); queue[qtail++] = ni; }
      }
    }
    if (foundSurface) for (const i of path) setBit(vnav.surfaceConnected, i);
  }
}

/**
 * Apply voxel edits incrementally. See header for steps.
 */
export function applyEdits(
  voxels: Uint8Array,
  vnav: VolumeNavBuffers,
  mr: MultiResNav3D,
  edits: readonly VoxelEdit[],
): void {
  if (edits.length === 0) return;

  // Step A: per-base-cell rebuild + collect connectivity-changed dirty set.
  const dirtyBaseCells: number[] = [];
  const dirtySeen = new Uint8Array((VNAV_COUNT + 7) >> 3);
  const becameAir: number[] = [];
  const becameSolid: number[] = [];

  for (const edit of edits) {
    const cx0 = Math.max(0, Math.min(VNAV_X, Math.floor(edit.vx0 / NAV_CELL_VOXELS)));
    const cy0 = Math.max(0, Math.min(VNAV_Y, Math.floor(edit.vy0 / NAV_CELL_VOXELS)));
    const cz0 = Math.max(0, Math.min(VNAV_Z, Math.floor(edit.vz0 / NAV_CELL_VOXELS)));
    // Inclusive max cell = ceil(vx1 / NAV_CELL_VOXELS) - 1 since vx1 is exclusive.
    const cx1 = Math.max(-1, Math.min(VNAV_X - 1, Math.ceil(edit.vx1 / NAV_CELL_VOXELS) - 1));
    const cy1 = Math.max(-1, Math.min(VNAV_Y - 1, Math.ceil(edit.vy1 / NAV_CELL_VOXELS) - 1));
    const cz1 = Math.max(-1, Math.min(VNAV_Z - 1, Math.ceil(edit.vz1 / NAV_CELL_VOXELS) - 1));
    if (cx0 > cx1 || cy0 > cy1 || cz0 > cz1) continue;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const i = vnavIndex(cx, cy, cz);
          if (getBit(dirtySeen, i) === 1) continue;
          setBit(dirtySeen, i);
          const before = getBit(vnav.solid, i);
          const after = recomputeBaseCell(voxels, vnav, cx, cy, cz);
          if (before !== after) {
            dirtyBaseCells.push(i);
            if (after === 0) becameAir.push(i); else becameSolid.push(i);
          } else {
            // Even if solid bit unchanged, planes/digCost may have shifted within
            // the cell; we still need higher-level re-fuse for digCost stats.
            dirtyBaseCells.push(i);
          }
        }
      }
    }
  }

  // Step B: surfaceConnected (approximate, see fn doc).
  updateSurfaceConnectedApprox(vnav, becameAir, becameSolid);

  // Step C: per-level dirty propagation.
  if (dirtyBaseCells.length === 0) return;

  // Build level-1 dirty set. Each dirty base cell maps to its level-1 super-cell
  // plus the 6 cardinal neighbours so face-edges across the dirty face get re-evaluated.
  let prevDirty: Set<number> | null = null;
  for (let li = 1; li < mr.levels.length; li++) {
    const level = mr.levels[li]!;
    const f = level.factor;
    if (f === 1) continue;
    const dirty = new Set<number>();

    if (li === 1) {
      // Seed from base-cell dirty set directly using level.factor.
      for (const bi of dirtyBaseCells) {
        const cx = bi % VNAV_X;
        const tmp = (bi / VNAV_X) | 0;
        const cz = tmp % VNAV_Z;
        const cy = (tmp / VNAV_Z) | 0;
        const sx = (cx / f) | 0;
        const sy = (cy / f) | 0;
        const sz = (cz / f) | 0;
        addCellAndNeighbours(dirty, level, sx, sy, sz);
      }
    } else {
      // Propagate from previous level: every dirty (sx,sy,sz) at level li-1 maps
      // to its parent at level li, plus 6 neighbours.
      const prevLevel = mr.levels[li - 1]!;
      const ratio = level.factor / prevLevel.factor;
      for (const psIdx of prevDirty!) {
        const psx = psIdx % prevLevel.w;
        const tmp = (psIdx / prevLevel.w) | 0;
        const psz = tmp % prevLevel.d;
        const psy = (tmp / prevLevel.d) | 0;
        const sx = (psx / ratio) | 0;
        const sy = (psy / ratio) | 0;
        const sz = (psz / ratio) | 0;
        addCellAndNeighbours(dirty, level, sx, sy, sz);
      }
    }

    // First pass: rebuild planes for every dirty super-cell at this level. We
    // must do this before edges so that addFaceEdges sees up-to-date plane
    // tables on both sides of every face it touches.
    for (const sIdx of dirty) {
      const sx = sIdx % level.w;
      const tmp = (sIdx / level.w) | 0;
      const sz = tmp % level.d;
      const sy = (tmp / level.d) | 0;
      rebuildSuperCellPlanes(vnav, level, sx, sy, sz, mr.navW, mr.navH, mr.navD);
    }
    // Second pass: rebuild edges. rebuildSuperCellFaceEdges is idempotent over
    // double-covered faces (both endpoints land here) — the filter step drops
    // any stale edge first, and the seen-set inside addFaceEdges dedupes.
    for (const sIdx of dirty) {
      const sx = sIdx % level.w;
      const tmp = (sIdx / level.w) | 0;
      const sz = tmp % level.d;
      const sy = (tmp / level.d) | 0;
      rebuildSuperCellFaceEdges(vnav, level, sx, sy, sz, mr.navW, mr.navH, mr.navD);
    }

    prevDirty = dirty;
  }
}

function addCellAndNeighbours(set: Set<number>, level: ResLevel3D, sx: number, sy: number, sz: number): void {
  if (sx < 0 || sy < 0 || sz < 0 || sx >= level.w || sy >= level.h || sz >= level.d) return;
  set.add(superCellIndex(level, sx, sy, sz));
  if (sx > 0) set.add(superCellIndex(level, sx - 1, sy, sz));
  if (sx + 1 < level.w) set.add(superCellIndex(level, sx + 1, sy, sz));
  if (sy > 0) set.add(superCellIndex(level, sx, sy - 1, sz));
  if (sy + 1 < level.h) set.add(superCellIndex(level, sx, sy + 1, sz));
  if (sz > 0) set.add(superCellIndex(level, sx, sy, sz - 1));
  if (sz + 1 < level.d) set.add(superCellIndex(level, sx, sy, sz + 1));
}
