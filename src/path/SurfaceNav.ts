import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';

// 1 m surface cells = 4 voxels.
export const NAV_CELL_VOXELS = 4;
export const NAV_W = WORLD_X / NAV_CELL_VOXELS; // 128
export const NAV_H = WORLD_Z / NAV_CELL_VOXELS; // 128
export const NAV_COUNT = NAV_W * NAV_H;
export const NAV_CELL_METERS = NAV_CELL_VOXELS * VOXEL_SIZE; // 1.0

// Slope tolerance: cells within this many voxels of vertical neighbor diff count as "even".
export const FLAT_TOLERANCE_VOXELS = 2;
export const MAX_FLATNESS_RADIUS = 16; // capped — no unit needs more than this in cells

export interface SurfaceNavBuffers {
  topY: Int16Array;        // top solid voxel y (or -1 if none / blocked)
  material: Uint8Array;
  slope: Uint8Array;       // max |topY - neighborTopY| over 3x3, in voxels
  flatness: Uint8Array;    // chamfer distance to nearest "uneven" cell, in cells (0..MAX_FLATNESS_RADIUS)
  road: Uint8Array;        // 0..255 road weight
  blocked: Uint8Array;     // 0/1
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
  };
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
  // Pass 1: per-column topY + material + initial blocked.
  for (let cz = 0; cz < NAV_H; cz++) {
    const wz = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
    for (let cx = 0; cx < NAV_W; cx++) {
      const wx = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
      let top = -1;
      let mat = 0;
      // Walk top-down to find the highest solid voxel with air immediately above.
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const m = voxels[worldIndex(wx, y, wz)]!;
        if (m !== AIR) {
          // Check air above (or top of world).
          const above = y + 1 >= WORLD_Y ? AIR : voxels[worldIndex(wx, y + 1, wz)]!;
          if (above === AIR) { top = y; mat = m; break; }
        }
      }
      const i = navIndex(cx, cz);
      nav.topY[i] = top;
      nav.material[i] = mat;
      nav.blocked[i] = top < 0 ? 1 : 0;
      nav.road[i] = 0;
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
