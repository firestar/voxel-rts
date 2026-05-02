import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { M_WOOD, M_LEAF, M_PATH, M_DIRT_ROAD, M_METAL } from '../voxel/Materials';

// 1 m surface cells = 8 voxels (at 0.125 m).
export const NAV_CELL_VOXELS = 8;
export const NAV_W = WORLD_X / NAV_CELL_VOXELS; // 96
export const NAV_H = WORLD_Z / NAV_CELL_VOXELS; // 96
export const NAV_COUNT = NAV_W * NAV_H;
export const NAV_CELL_METERS = NAV_CELL_VOXELS * VOXEL_SIZE; // 1.0

// Slope tolerance for "even-enough" cells used by the Chamfer flatness pass.
// In voxels — at 0.125 m a value of 4 = 0.5 m vertical difference between adjacent cells.
export const FLAT_TOLERANCE_VOXELS = 4;
export const MAX_FLATNESS_RADIUS = 16;

export interface SurfaceNavBuffers {
  topY: Int16Array;        // top solid voxel y (or -1 if none / blocked)
  material: Uint8Array;
  slope: Uint8Array;       // max |topY - neighborTopY| over 3x3, in voxels
  flatness: Uint8Array;    // chamfer distance to nearest "uneven" cell, in cells (0..MAX_FLATNESS_RADIUS)
  road: Uint8Array;        // 0..255 road weight
  blocked: Uint8Array;     // 0/1
  /** Contiguous air voxels above topY before hitting solid (capped at 255). Used by
   *  the path search to keep units out of cells where their head would clip a tree
   *  canopy / overhang / building roof. */
  headroom: Uint8Array;
  /** 1 when the cell contains a tree trunk or low-canopy voxel (M_WOOD / M_LEAF)
   *  inside the trunk-base layer above topY. Folded into `blocked` after the
   *  scan, but kept exposed for renderers / diagnostics. */
  treeBlocked: Uint8Array;
}

export function navIndex(x: number, z: number): number { return z * NAV_W + x; }

export function allocateNav(useShared: boolean): SurfaceNavBuffers {
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  return {
    topY: new Int16Array(new Buf(NAV_COUNT * 2)),
    material: new Uint8Array(new Buf(NAV_COUNT)),
    slope: new Uint8Array(new Buf(NAV_COUNT)),
    flatness: new Uint8Array(new Buf(NAV_COUNT)),
    road: new Uint8Array(new Buf(NAV_COUNT)),
    blocked: new Uint8Array(new Buf(NAV_COUNT)),
    headroom: new Uint8Array(new Buf(NAV_COUNT)),
    treeBlocked: new Uint8Array(new Buf(NAV_COUNT)),
  };
}

/**
 * Voxels above topY scanned for tree obstructions. Trunks rise straight from
 * the ground voxel at topY+1; we check the first few voxels of the column to
 * catch trunk presence without reading every column-voxel.
 */
const TREE_TRUNK_PROBE_VOXELS = 4;

/**
 * Recompute pass-1 fields (topY, material, treeBlocked, blocked, road, headroom)
 * for a single cell from the live voxel buffer. Pure per-cell scan — no neighbour
 * dependency — so the caller can use this both for full-grid build and for an
 * incremental refresh inside a damage box.
 */
function recomputeCellPass1(voxels: Uint8Array, nav: SurfaceNavBuffers, cx: number, cz: number): void {
  const wx = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
  const wz = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
  let top = -1;
  let mat = 0;
  // Walk top-down to find the highest WALKABLE ground voxel — wood and leaf
  // (trees) are skipped, so the ground voxel under a canopy still wins.
  for (let y = WORLD_Y - 1; y >= 1; y--) {
    const m = voxels[worldIndex(wx, y, wz)]!;
    if (m === AIR) continue;
    if (m === M_WOOD || m === M_LEAF) continue;
    top = y; mat = m;
    break;
  }
  const i = navIndex(cx, cz);
  nav.topY[i] = top;
  nav.material[i] = mat;
  // Tree-trunk scan: walk every voxel column inside this cell and check the
  // first TREE_TRUNK_PROBE_VOXELS voxels above topY for wood / leaf.
  let treeBlocked = 0;
  if (top >= 0) {
    const x0 = cx * NAV_CELL_VOXELS;
    const z0 = cz * NAV_CELL_VOXELS;
    outer: for (let dz = 0; dz < NAV_CELL_VOXELS; dz++) {
      for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
        const ax = x0 + dx, az = z0 + dz;
        if (ax >= WORLD_X || az >= WORLD_Z) continue;
        for (let h = 1; h <= TREE_TRUNK_PROBE_VOXELS; h++) {
          const yy = top + h;
          if (yy >= WORLD_Y) break;
          const m = voxels[worldIndex(ax, yy, az)]!;
          if (m === M_WOOD || m === M_LEAF) { treeBlocked = 1; break outer; }
        }
      }
    }
  }
  nav.treeBlocked[i] = treeBlocked;
  // Metal surface voxels (ore clusters) are impassable — units path around them.
  nav.blocked[i] = (top < 0 || treeBlocked || mat === M_METAL) ? 1 : 0;
  nav.road[i] = mat === M_PATH ? 200 : (mat === M_DIRT_ROAD ? 120 : 0);
  // Headroom: count contiguous air voxels above the walkable topY at the cell's
  // CENTRE column. Centre-only sampling keeps cells next to a tree walkable
  // while still flagging the cell whose centre is genuinely under a canopy.
  let head = 0;
  if (top >= 0) {
    for (let y = top + 1; y < WORLD_Y; y++) {
      if (voxels[worldIndex(wx, y, wz)] !== AIR) break;
      head++;
      if (head >= 255) { head = 255; break; }
    }
  }
  nav.headroom[i] = head;
}

/** Recompute slope (max |dY| over 3x3 neighbours) for one cell. */
function recomputeCellSlope(nav: SurfaceNavBuffers, cx: number, cz: number): void {
  const i = navIndex(cx, cz);
  if (nav.blocked[i]) { nav.slope[i] = 255; return; }
  const ty = nav.topY[i]!;
  let maxD = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
      const ni = navIndex(nx, nz);
      if (nav.blocked[ni]) { maxD = Math.max(maxD, 99); continue; }
      const d = Math.abs(nav.topY[ni]! - ty);
      if (d > maxD) maxD = d;
    }
  }
  nav.slope[i] = Math.min(255, maxD);
}

/**
 * Run a 2-pass Chamfer (3,4) distance transform across the whole grid to
 * derive `flatness` from `blocked` + `slope`. Result is in cells, capped at
 * MAX_FLATNESS_RADIUS. Cheap (~16 K cells × small constant) so it's fine to
 * rerun after an incremental box refresh — flatness is global by definition.
 */
export function recomputeFlatness(nav: SurfaceNavBuffers): void {
  const INF = 1 << 28;
  const dist = new Int32Array(NAV_COUNT);
  for (let i = 0; i < NAV_COUNT; i++) {
    const uneven = nav.blocked[i]! || nav.slope[i]! > FLAT_TOLERANCE_VOXELS;
    dist[i] = uneven ? 0 : INF;
  }
  // Forward pass.
  for (let cz = 0; cz < NAV_H; cz++) {
    for (let cx = 0; cx < NAV_W; cx++) {
      const i = navIndex(cx, cz);
      let d = dist[i]!;
      if (cz > 0) {
        if (cx > 0) d = Math.min(d, dist[navIndex(cx - 1, cz - 1)]! + 4);
        d = Math.min(d, dist[navIndex(cx, cz - 1)]! + 3);
        if (cx < NAV_W - 1) d = Math.min(d, dist[navIndex(cx + 1, cz - 1)]! + 4);
      }
      if (cx > 0) d = Math.min(d, dist[navIndex(cx - 1, cz)]! + 3);
      dist[i] = d;
    }
  }
  // Backward pass.
  for (let cz = NAV_H - 1; cz >= 0; cz--) {
    for (let cx = NAV_W - 1; cx >= 0; cx--) {
      const i = navIndex(cx, cz);
      let d = dist[i]!;
      if (cz < NAV_H - 1) {
        if (cx < NAV_W - 1) d = Math.min(d, dist[navIndex(cx + 1, cz + 1)]! + 4);
        d = Math.min(d, dist[navIndex(cx, cz + 1)]! + 3);
        if (cx > 0) d = Math.min(d, dist[navIndex(cx - 1, cz + 1)]! + 4);
      }
      if (cx < NAV_W - 1) d = Math.min(d, dist[navIndex(cx + 1, cz)]! + 3);
      dist[i] = d;
    }
  }
  for (let i = 0; i < NAV_COUNT; i++) {
    const r = Math.floor((dist[i]!) / 3);
    nav.flatness[i] = Math.min(MAX_FLATNESS_RADIUS, r);
  }
}

/**
 * Build the surface nav grid from the voxel buffer.
 *
 * For each 1m cell (cx, cz), sample the column at the cell center voxel; topY is the
 * highest solid voxel under the sky (overhanging cells are detected by checking that
 * the column has air above topY). Then compute slope (max |dY| over 3x3 neighborhood).
 * Then run a 2-pass Chamfer (3,4) distance transform on "uneven" cells — the result
 * (in cells, capped) is each cell's flatnessRadius.
 */
export function buildSurfaceNav(voxels: Uint8Array, nav: SurfaceNavBuffers): void {
  for (let cz = 0; cz < NAV_H; cz++) {
    for (let cx = 0; cx < NAV_W; cx++) recomputeCellPass1(voxels, nav, cx, cz);
  }
  for (let cz = 0; cz < NAV_H; cz++) {
    for (let cx = 0; cx < NAV_W; cx++) recomputeCellSlope(nav, cx, cz);
  }
  recomputeFlatness(nav);
}

/**
 * Refresh the surface nav for cells whose voxel columns might have changed
 * inside the given cell-space AABB. Pass 1 (per-column scan) runs over the
 * box; pass 2 (slope) widens the box by 1 cell on each side because slope
 * reads 3×3 neighbours. Pass 3 (chamfer flatness) is global and cheap, so
 * we re-run it across the whole grid — its result is stable enough not to
 * warrant a windowed update.
 */
export function refreshSurfaceNavBox(
  voxels: Uint8Array, nav: SurfaceNavBuffers,
  cx0: number, cz0: number, cx1: number, cz1: number,
): void {
  const x0 = Math.max(0, cx0);
  const z0 = Math.max(0, cz0);
  const x1 = Math.min(NAV_W - 1, cx1);
  const z1 = Math.min(NAV_H - 1, cz1);
  if (x0 > x1 || z0 > z1) return;
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) recomputeCellPass1(voxels, nav, cx, cz);
  }
  const sx0 = Math.max(0, x0 - 1);
  const sz0 = Math.max(0, z0 - 1);
  const sx1 = Math.min(NAV_W - 1, x1 + 1);
  const sz1 = Math.min(NAV_H - 1, z1 + 1);
  for (let cz = sz0; cz <= sz1; cz++) {
    for (let cx = sx0; cx <= sx1; cx++) recomputeCellSlope(nav, cx, cz);
  }
  recomputeFlatness(nav);
}

/** Nearest in-bounds nav cell containing the world-space (x, z) in meters. */
export function worldToNav(wx: number, wz: number): { cx: number; cz: number } {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
  return { cx, cz };
}

/** World-space center of a nav cell, in meters (Y comes from topY). */
export function navCenter(nav: SurfaceNavBuffers, cx: number, cz: number): { x: number; y: number; z: number } {
  const i = navIndex(cx, cz);
  const top = nav.topY[i]!;
  return {
    x: (cx + 0.5) * NAV_CELL_METERS,
    y: (top + 1) * VOXEL_SIZE,
    z: (cz + 0.5) * NAV_CELL_METERS,
  };
}
