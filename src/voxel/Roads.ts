import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { worldIndex } from './VoxelWorld';
import { M_GRASS, M_PATH, M_MUD, M_WOOD, M_LEAF, M_BEDROCK } from './Materials';
import { NAV_W, NAV_H, NAV_CELL_VOXELS } from '../path/SurfaceNav';
import { Xoshiro128 } from '../util/Rng';
import { FourAryHeap } from '../util/Heap';

/**
 * Road network generation.
 *
 *   1. Build a coarse 1 m grid (matches the surface nav grid) with each cell's
 *      top walkable Y. Mud cells are blocked — roads don't run through bogs.
 *   2. Pick a handful of POIs on grass with mild local slope and good spacing.
 *   3. Connect them with a chain of slope-weighted A* paths (POIᵢ → POIᵢ₊₁).
 *   4. Rasterise each path as a ~1 m wide swath of `M_PATH` voxels stamped
 *      onto the surface (top voxel + one below).
 *
 * Runs on the main thread once worldgen workers finish, before tree
 * placement. Trees skip non-grass surfaces, so the canopy + trunk pass
 * naturally avoids road cells.
 */

// 1 m in voxels.
const C = NAV_CELL_VOXELS;

// POI selection.
const POI_COUNT = 5;
const POI_MIN_SPACING_CELLS = 20;     // ~20 m apart
const POI_MARGIN_CELLS = 6;           // keep POIs out of map edges
const POI_MAX_LOCAL_SLOPE_VOXELS = 4; // POIs sit on roughly flat ground

// A* tunables.
const ROAD_SLOPE_PENALTY = 0.6;       // cost units per voxel of |ΔY|
const ROAD_MAX_EXPANSIONS = 50_000;   // belt-and-braces

// Stamp width / depth.
const ROAD_HALF_VOXELS = 4;           // 4 voxels ≈ 0.5 m → ~1 m wide road
const ROAD_DEPTH_VOXELS = 2;          // top voxel + 1 below
const ROAD_BRIDGE_SUBSTEPS = 4;       // discs between adjacent path cells (covers diagonals)

export interface RoadGenStats {
  poiCount: number;
  pathSegments: number;
  pathCells: number;
}

interface POI { cx: number; cz: number; }

interface RoadGrid {
  /** Top-walkable Y per cell, or -1 if unreachable. */
  topY: Int16Array;
  /** 1 if this cell can't host a road (no surface, or surface is mud). */
  blocked: Uint8Array;
}

/**
 * Place a road network into the voxel grid. Mutates `voxels` in place.
 */
export function placeRoads(voxels: Uint8Array, seed: number): RoadGenStats {
  const grid = buildRoadGrid(voxels);
  const pois = pickPOIs(grid, voxels, seed);
  if (pois.length < 2) return { poiCount: pois.length, pathSegments: 0, pathCells: 0 };

  let segments = 0;
  let cells = 0;
  for (let k = 0; k + 1 < pois.length; k++) {
    const a = pois[k]!;
    const b = pois[k + 1]!;
    const cellsPath = aStarRoad(grid, a.cx, a.cz, b.cx, b.cz);
    if (cellsPath.length < 2) continue;
    stampRoad(voxels, cellsPath);
    segments++;
    cells += cellsPath.length;
  }
  return { poiCount: pois.length, pathSegments: segments, pathCells: cells };
}

// ---------------------------------------------------------------------------
// 1. Coarse grid build.

function buildRoadGrid(voxels: Uint8Array): RoadGrid {
  const N = NAV_W * NAV_H;
  const topY = new Int16Array(N);
  const blocked = new Uint8Array(N);
  for (let cz = 0; cz < NAV_H; cz++) {
    const wz = cz * C + (C >> 1);
    for (let cx = 0; cx < NAV_W; cx++) {
      const wx = cx * C + (C >> 1);
      let top = -1;
      let mat = AIR;
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const m = voxels[worldIndex(wx, y, wz)]!;
        if (m === AIR || m === M_WOOD || m === M_LEAF) continue;
        top = y; mat = m;
        break;
      }
      const i = cz * NAV_W + cx;
      topY[i] = top;
      // Mud is too soft to take a road. Unwalkable columns also block.
      blocked[i] = (top < 0 || mat === M_MUD) ? 1 : 0;
    }
  }
  return { topY, blocked };
}

// ---------------------------------------------------------------------------
// 2. POI picking.

function pickPOIs(grid: RoadGrid, voxels: Uint8Array, seed: number): POI[] {
  const rng = new Xoshiro128((seed ^ 0xC0FFEE) >>> 0);
  const out: POI[] = [];
  const minLo = POI_MARGIN_CELLS;
  const maxHi = NAV_W - POI_MARGIN_CELLS;
  const minSpacing2 = POI_MIN_SPACING_CELLS * POI_MIN_SPACING_CELLS;
  for (let attempt = 0; attempt < 600 && out.length < POI_COUNT; attempt++) {
    const cx = rng.intRange(minLo, maxHi);
    const cz = rng.intRange(minLo, NAV_H - POI_MARGIN_CELLS);
    const i = cz * NAV_W + cx;
    if (grid.blocked[i]) continue;
    // Surface must be grass — POIs sit at "settlements", not on stone outcrops.
    const wx = cx * C + (C >> 1);
    const wz = cz * C + (C >> 1);
    const ty = grid.topY[i]!;
    if (voxels[worldIndex(wx, ty, wz)] !== M_GRASS) continue;
    // Local slope check: 3x3 max |ΔY|.
    let okFlat = true;
    for (let dz = -1; dz <= 1 && okFlat; dz++) {
      for (let dx = -1; dx <= 1 && okFlat; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
        const ni = nz * NAV_W + nx;
        if (grid.blocked[ni]) { okFlat = false; break; }
        if (Math.abs(grid.topY[ni]! - ty) > POI_MAX_LOCAL_SLOPE_VOXELS) okFlat = false;
      }
    }
    if (!okFlat) continue;
    // Spacing check.
    let okSpacing = true;
    for (const p of out) {
      const ddx = p.cx - cx;
      const ddz = p.cz - cz;
      if (ddx * ddx + ddz * ddz < minSpacing2) { okSpacing = false; break; }
    }
    if (!okSpacing) continue;
    out.push({ cx, cz });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Slope-weighted A* on the coarse grid.

function octileH(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
}

function aStarRoad(grid: RoadGrid, sx: number, sz: number, gx: number, gz: number): POI[] {
  const W = NAV_W, H = NAV_H, N = W * H;
  const startI = sz * W + sx;
  const goalI = gz * W + gx;
  if (grid.blocked[startI] || grid.blocked[goalI]) return [];

  const g = new Float32Array(N);
  const came = new Int32Array(N);
  const closed = new Uint8Array(N);
  for (let i = 0; i < N; i++) { g[i] = Infinity; came[i] = -1; }
  g[startI] = 0;

  const open = new FourAryHeap(1024);
  open.push(startI, octileH(sx, sz, gx, gz));

  let expansions = 0;
  let reached = false;
  while (open.length > 0 && expansions < ROAD_MAX_EXPANSIONS) {
    const i = open.pop();
    if (i === goalI) { reached = true; break; }
    if (closed[i]) continue;
    closed[i] = 1;
    expansions++;
    const cx = i % W;
    const cz = (i - cx) / W;
    const ty = grid.topY[i]!;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const ni = nz * W + nx;
        if (grid.blocked[ni]) continue;
        if (closed[ni]) continue;
        // Diagonal corner-cut: don't squeeze between two blocked cardinals.
        if (dx !== 0 && dz !== 0) {
          const aI = cz * W + nx;
          const bI = nz * W + cx;
          if (grid.blocked[aI] || grid.blocked[bI]) continue;
        }
        const dy = Math.abs(grid.topY[ni]! - ty);
        const base = (dx === 0 || dz === 0) ? 1 : Math.SQRT2;
        const cost = base + ROAD_SLOPE_PENALTY * dy;
        const ng = g[i]! + cost;
        if (ng < g[ni]!) {
          g[ni] = ng;
          came[ni] = i;
          open.push(ni, ng + octileH(nx, nz, gx, gz));
        }
      }
    }
  }
  if (!reached) return [];

  // Reconstruct.
  const out: POI[] = [];
  let cur = goalI;
  while (cur !== -1) {
    const cx = cur % W;
    const cz = (cur - cx) / W;
    out.push({ cx, cz });
    if (cur === startI) break;
    cur = came[cur]!;
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// 4. Rasterise the path into M_PATH voxels.

function stampRoad(voxels: Uint8Array, cells: POI[]): void {
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k]!;
    const wx = c.cx * C + (C >> 1);
    const wz = c.cz * C + (C >> 1);
    stampDisc(voxels, wx, wz);
    if (k > 0) {
      // Substep stamps between adjacent cells so diagonals don't leave gaps.
      const p = cells[k - 1]!;
      const pwx = p.cx * C + (C >> 1);
      const pwz = p.cz * C + (C >> 1);
      for (let s = 1; s < ROAD_BRIDGE_SUBSTEPS; s++) {
        const t = s / ROAD_BRIDGE_SUBSTEPS;
        const x = Math.round(pwx + (wx - pwx) * t);
        const z = Math.round(pwz + (wz - pwz) * t);
        stampDisc(voxels, x, z);
      }
    }
  }
}

function stampDisc(voxels: Uint8Array, wx: number, wz: number): void {
  const r = ROAD_HALF_VOXELS;
  const r2 = r * r;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r2) continue;
      const x = wx + dx;
      const z = wz + dz;
      if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) continue;
      // Find the column's top walkable voxel (skip canopies, but those don't
      // exist yet — trees haven't been placed).
      let top = -1;
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const m = voxels[worldIndex(x, y, z)]!;
        if (m === AIR) continue;
        if (m === M_WOOD || m === M_LEAF) continue;
        top = y;
        break;
      }
      if (top < 0) continue;
      for (let dy = 0; dy < ROAD_DEPTH_VOXELS; dy++) {
        const y = top - dy;
        if (y < 1) break;
        const idx = worldIndex(x, y, z);
        const cur = voxels[idx]!;
        // Don't pave over bedrock or air.
        if (cur === AIR || cur === M_BEDROCK) continue;
        voxels[idx] = M_PATH;
      }
    }
  }
}
