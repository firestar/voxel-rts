import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { M_WOOD, M_LEAF, M_PATH, M_DIRT_ROAD } from '../voxel/Materials';

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
 * Build the surface nav grid from the voxel buffer.
 *
 * For each 1m cell (cx, cz), sample the column at the cell center voxel; topY is the
 * highest solid voxel under the sky (overhanging cells are detected by checking that
 * the column has air above topY). Then compute slope (max |dY| over 3x3 neighborhood).
 * Then run a 2-pass Chamfer (3,4) distance transform on "uneven" cells — the result
 * (in cells, capped) is each cell's flatnessRadius.
 */
export function buildSurfaceNav(voxels: Uint8Array, nav: SurfaceNavBuffers): void {
  // Pass 1: per-column topY + material + initial blocked.
  for (let cz = 0; cz < NAV_H; cz++) {
    const wz = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
    for (let cx = 0; cx < NAV_W; cx++) {
      const wx = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
      let top = -1;
      let mat = 0;
      // Walk top-down to find the highest WALKABLE ground voxel — wood and leaf
      // (trees) are skipped, so the ground voxel under a canopy still wins.
      // Without this skip, a tree's TOP read as topY (it has air above), the
      // grass underneath was buried, and the cell appeared to have full sky
      // headroom above the canopy — exactly the wrong answer.
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
      // Tree-trunk scan: walk every voxel column inside this cell and check
      // the first TREE_TRUNK_PROBE_VOXELS voxels above topY for wood / leaf.
      // Catches trunks no matter where they jitter inside the cell, so the
      // entire cell goes blocked even when the trunk hugs an edge.
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
      // OR tree blocking into the main `blocked` flag so every A* user
      // (surface + headroom checks) routes around the tree without each
      // having to consult `treeBlocked` separately.
      nav.blocked[i] = (top < 0 || treeBlocked) ? 1 : 0;
      // Road weight: paved (M_PATH) gets a strong discount in A* edge cost,
      // dirt roads (M_DIRT_ROAD) a milder one. See edgeCost in AStar.ts:
      // 200/255 ≈ 0.78 → ~0.47x cost on paved, 120/255 ≈ 0.47 → ~0.72x on dirt.
      nav.road[i] = mat === M_PATH ? 200 : (mat === M_DIRT_ROAD ? 120 : 0);
      // Headroom: air voxels above topY before the next solid voxel. Capped at 255.
      // Sample MULTIPLE columns within the cell — corners + centre — and take the
      // minimum so a tree trunk sitting at a cell corner still flags the whole
      // cell as low-headroom. Without this, anything off the cell-centre column
      // (e.g. a 1-voxel-wide tree trunk stamped at a cell edge) was invisible.
      // Headroom: count contiguous air voxels above the walkable topY at the cell's
       // CENTRE column. We deliberately don't multi-probe — the previous "min over
       // 5 probes" version locked down the entire region around a forest because
       // canopies that overhang into a corner of an otherwise-clear cell would
       // reduce that cell's headroom to nearly zero. With centre-only sampling,
       // cells whose centre is genuinely under a canopy (or contain a trunk) get
       // marked as low headroom, but cells next to a tree stay walkable.
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
  }

  // Pass 2: slope (max |dY| over 3x3).
  for (let cz = 0; cz < NAV_H; cz++) {
    for (let cx = 0; cx < NAV_W; cx++) {
      const i = navIndex(cx, cz);
      if (nav.blocked[i]) { nav.slope[i] = 255; continue; }
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
  }

  // Pass 3: Chamfer (3,4) distance transform on "uneven" cells.
  // Score cell unevenness in cell-units: 0 if uneven, +Infinity if even, then propagate min(d+3 cardinal, d+4 diagonal).
  // Scaled so flatness = floor(d/3); we cap at MAX_FLATNESS_RADIUS.
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
