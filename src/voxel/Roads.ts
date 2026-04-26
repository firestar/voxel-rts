import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { worldIndex } from './VoxelWorld';
import { M_GRASS, M_PATH, M_DIRT_ROAD, M_MUD, M_WOOD, M_LEAF, M_BEDROCK } from './Materials';
import { NAV_W, NAV_H, NAV_CELL_VOXELS } from '../path/SurfaceNav';
import { Xoshiro128 } from '../util/Rng';
import { FourAryHeap } from '../util/Heap';

/**
 * Road network generation.
 *
 *   1. Build a coarse 1 m grid (matches the surface nav grid) with each cell's
 *      top walkable Y. Mud cells are blocked — roads don't run through bogs.
 *   2. Pick a handful of POIs on grass with mild local slope and good spacing.
 *   3. Trunk pass: connect POIs with a chain of grade-capped, slope-weighted
 *      A* paths and stamp them as paved (M_PATH).
 *   4. Branch pass: from each POI shoot 1–2 short dirt-road branches to nearby
 *      cells and stamp them as M_DIRT_ROAD.
 *   5. Each path is rasterised as a flat strip ~2× tank-width across (≈ 4.75 m)
 *      with cut-and-fill so the road surface is level across the strip and
 *      respects a 40° max grade along its length.
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
const ROAD_SLOPE_PENALTY = 0.6;       // soft cost per voxel of |ΔY|
const ROAD_MAX_EXPANSIONS = 50_000;   // belt-and-braces

// Hard grade cap: tan(40°) ≈ 0.839. With 1 m cells (8 voxels at 0.125 m):
//   cardinal max rise = 6 voxels (0.75 m) → 36.9°  (under 40°)
//   diagonal max rise = 9 voxels (1.125 m over √2 m run) → 38.5°
// Steeper edges are rejected outright by the search.
const ROAD_MAX_RISE_CARDINAL = 6;
const ROAD_MAX_RISE_DIAGONAL = 9;

// Stamp width / depth.
// Tank width is 2.4 m; roads are 2× that (≈ 4.75 m → half = 19 voxels).
const ROAD_HALF_VOXELS = 19;
// Top + 2 below — when carving into a ridge we still want a solid sub-base.
const ROAD_DEPTH_VOXELS = 3;

// Branch (dirt road) tunables.
const BRANCH_PER_POI = 2;
const BRANCH_LEN_CELLS_MIN = 6;
const BRANCH_LEN_CELLS_MAX = 14;
const BRANCH_TARGET_ATTEMPTS = 30;

export interface RoadGenStats {
  poiCount: number;
  pathSegments: number;
  pathCells: number;
  branchSegments: number;
  branchCells: number;
  /** 1 byte per voxel column (z * WORLD_X + x). 1 = column was paved. */
  columnMask: Uint8Array;
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
  const columnMask = new Uint8Array(WORLD_X * WORLD_Z);
  const pois = pickPOIs(grid, voxels, seed);
  if (pois.length < 2) {
    return {
      poiCount: pois.length, pathSegments: 0, pathCells: 0,
      branchSegments: 0, branchCells: 0, columnMask,
    };
  }

  // Trunk: paved between consecutive POIs.
  let segments = 0;
  let cells = 0;
  for (let k = 0; k + 1 < pois.length; k++) {
    const a = pois[k]!;
    const b = pois[k + 1]!;
    const cellsPath = aStarRoad(grid, a.cx, a.cz, b.cx, b.cz);
    if (cellsPath.length < 2) continue;
    stampRoadFlat(voxels, grid, cellsPath, M_PATH, columnMask);
    segments++;
    cells += cellsPath.length;
  }

  // Branches: short dirt roads peeled off each POI.
  const branchRng = new Xoshiro128((seed ^ 0xBADBEEF) >>> 0);
  let branchSegs = 0;
  let branchCells = 0;
  for (const poi of pois) {
    for (let b = 0; b < BRANCH_PER_POI; b++) {
      const target = pickBranchTarget(grid, voxels, poi, branchRng);
      if (!target) continue;
      const cellsPath = aStarRoad(grid, poi.cx, poi.cz, target.cx, target.cz);
      if (cellsPath.length < 2) continue;
      stampRoadFlat(voxels, grid, cellsPath, M_DIRT_ROAD, columnMask);
      branchSegs++;
      branchCells += cellsPath.length;
    }
  }

  return {
    poiCount: pois.length,
    pathSegments: segments,
    pathCells: cells,
    branchSegments: branchSegs,
    branchCells: branchCells,
    columnMask,
  };
}

/**
 * Clear any wood/leaf voxels sitting above road columns. Called after
 * tree placement so a canopy that drifted across a road gets trimmed
 * back, leaving the road open to the sky.
 */
export function clearAboveRoads(voxels: Uint8Array, columnMask: Uint8Array): void {
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      if (!columnMask[z * WORLD_X + x]) continue;
      // Find the road surface y by scanning down past any tree voxels.
      let surfY = -1;
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const m = voxels[worldIndex(x, y, z)]!;
        if (m === AIR || m === M_WOOD || m === M_LEAF) continue;
        surfY = y;
        break;
      }
      if (surfY < 0) continue;
      for (let y = surfY + 1; y < WORLD_Y; y++) {
        const idx = worldIndex(x, y, z);
        const m = voxels[idx]!;
        if (m === M_WOOD || m === M_LEAF) voxels[idx] = AIR;
      }
    }
  }
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

// Pick a branch endpoint a moderate distance from the POI, on grass, not blocked.
function pickBranchTarget(grid: RoadGrid, voxels: Uint8Array, poi: POI, rng: Xoshiro128): POI | null {
  for (let i = 0; i < BRANCH_TARGET_ATTEMPTS; i++) {
    const dist = BRANCH_LEN_CELLS_MIN + ((rng.nextU32() % (BRANCH_LEN_CELLS_MAX - BRANCH_LEN_CELLS_MIN + 1)) | 0);
    const ang = rng.next() * Math.PI * 2;
    const cx = poi.cx + Math.round(Math.cos(ang) * dist);
    const cz = poi.cz + Math.round(Math.sin(ang) * dist);
    if (cx < POI_MARGIN_CELLS || cz < POI_MARGIN_CELLS) continue;
    if (cx >= NAV_W - POI_MARGIN_CELLS || cz >= NAV_H - POI_MARGIN_CELLS) continue;
    const idx = cz * NAV_W + cx;
    if (grid.blocked[idx]) continue;
    const ty = grid.topY[idx]!;
    const wx = cx * C + (C >> 1);
    const wz = cz * C + (C >> 1);
    if (voxels[worldIndex(wx, ty, wz)] !== M_GRASS) continue;
    return { cx, cz };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Slope-weighted, grade-capped A* on the coarse grid.

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
        // Hard 40° grade cap per edge — see ROAD_MAX_RISE_* constants.
        const maxRise = (dx === 0 || dz === 0) ? ROAD_MAX_RISE_CARDINAL : ROAD_MAX_RISE_DIAGONAL;
        if (dy > maxRise) continue;
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
// 4. Flat-section rasterisation.

/**
 * Stamp a flat road along `cells` into `voxels`. The road surface is at a
 * smoothed centerline Y (clamped to respect the per-edge grade cap), and
 * each cell gets a footprint that is one cell long along travel × the road
 * width across travel. Any voxels above the surface in the footprint are
 * carved to AIR (cut), any below are filled with `material` (fill).
 */
function stampRoadFlat(
  voxels: Uint8Array,
  grid: RoadGrid,
  cells: POI[],
  material: number,
  columnMask: Uint8Array,
): void {
  const n = cells.length;
  if (n < 2) return;

  // 1. Build a smoothed centerline Y profile.
  const targetY = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const c = cells[k]!;
    targetY[k] = grid.topY[c.cz * NAV_W + c.cx]!;
  }
  // 3 sweeps of (3-tap smooth + grade clamp).
  for (let pass = 0; pass < 3; pass++) {
    // Smooth (centred 3-tap, endpoints kept).
    const tmp = new Int32Array(n);
    tmp[0] = targetY[0]!;
    tmp[n - 1] = targetY[n - 1]!;
    for (let k = 1; k < n - 1; k++) {
      tmp[k] = Math.round((targetY[k - 1]! + 2 * targetY[k]! + targetY[k + 1]!) / 4);
    }
    for (let k = 0; k < n; k++) targetY[k] = tmp[k]!;
    // Forward + backward grade clamp so |Δ| ≤ maxRise per step.
    for (let k = 1; k < n; k++) {
      const a = cells[k - 1]!, b = cells[k]!;
      const dx = b.cx - a.cx, dz = b.cz - a.cz;
      const maxRise = (dx === 0 || dz === 0) ? ROAD_MAX_RISE_CARDINAL : ROAD_MAX_RISE_DIAGONAL;
      const diff = targetY[k]! - targetY[k - 1]!;
      if (diff > maxRise) targetY[k] = targetY[k - 1]! + maxRise;
      else if (diff < -maxRise) targetY[k] = targetY[k - 1]! - maxRise;
    }
    for (let k = n - 2; k >= 0; k--) {
      const a = cells[k]!, b = cells[k + 1]!;
      const dx = b.cx - a.cx, dz = b.cz - a.cz;
      const maxRise = (dx === 0 || dz === 0) ? ROAD_MAX_RISE_CARDINAL : ROAD_MAX_RISE_DIAGONAL;
      const diff = targetY[k]! - targetY[k + 1]!;
      if (diff > maxRise) targetY[k] = targetY[k + 1]! + maxRise;
      else if (diff < -maxRise) targetY[k] = targetY[k + 1]! - maxRise;
    }
  }

  // 2. Per-cell footprint stamp.
  for (let k = 0; k < n; k++) {
    const cell = cells[k]!;
    const prev = k > 0 ? cells[k - 1]! : cell;
    const next = k < n - 1 ? cells[k + 1]! : cell;
    // Travel direction in cells (unit length 1 m).
    let tdx = next.cx - prev.cx;
    let tdz = next.cz - prev.cz;
    const tlen = Math.hypot(tdx, tdz) || 1;
    tdx /= tlen; tdz /= tlen;
    // Perpendicular.
    const px = -tdz, pz = tdx;
    stampFlatSection(voxels, cell, targetY[k]!, tdx, tdz, px, pz, material, columnMask);
    // Disc stamp at the cell centre. The rectangular ribbon above leaves
    // notches on the inside/outside of sharp turns because consecutive
    // cells stamp rectangles aligned to different travel directions; the
    // disc fills those notches and keeps the road continuous.
    stampDisc(voxels, cell, targetY[k]!, material, columnMask);
  }
}

function stampFlatSection(
  voxels: Uint8Array,
  cell: POI,
  ty: number,
  tdx: number, tdz: number,
  px: number, pz: number,
  material: number,
  columnMask: Uint8Array,
): void {
  const cxw = cell.cx * C + (C >> 1);
  const czw = cell.cz * C + (C >> 1);
  // Sub-sample length and width at voxel resolution. Length covers one cell
  // (8 voxels). Width is 2*ROAD_HALF_VOXELS+1.
  const halfLen = C / 2; // 4 voxels each side of cell centre = 1 m total
  for (let li = -halfLen; li < halfLen; li++) {
    for (let ni = -ROAD_HALF_VOXELS; ni <= ROAD_HALF_VOXELS; ni++) {
      const wx = Math.round(cxw + tdx * (li + 0.5) + px * ni);
      const wz = Math.round(czw + tdz * (li + 0.5) + pz * ni);
      if (wx < 0 || wz < 0 || wx >= WORLD_X || wz >= WORLD_Z) continue;
      paveColumn(voxels, wx, wz, ty, material);
      columnMask[wz * WORLD_X + wx] = 1;
    }
  }
}

function stampDisc(
  voxels: Uint8Array,
  cell: POI,
  ty: number,
  material: number,
  columnMask: Uint8Array,
): void {
  const cxw = cell.cx * C + (C >> 1);
  const czw = cell.cz * C + (C >> 1);
  const r = ROAD_HALF_VOXELS;
  const r2 = r * r;
  for (let dz = -r; dz <= r; dz++) {
    const wz = czw + dz;
    if (wz < 0 || wz >= WORLD_Z) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r2) continue;
      const wx = cxw + dx;
      if (wx < 0 || wx >= WORLD_X) continue;
      paveColumn(voxels, wx, wz, ty, material);
      columnMask[wz * WORLD_X + wx] = 1;
    }
  }
}

/**
 * Cut anything above ty in the column to AIR (preserving bedrock), set the
 * surface voxel at ty to `material`, and ensure ROAD_DEPTH_VOXELS-1 voxels
 * below are solid (fill air with `material`, leave existing solids alone).
 */
function paveColumn(voxels: Uint8Array, wx: number, wz: number, ty: number, material: number): void {
  if (ty < 1 || ty >= WORLD_Y) return;
  // Cut: clear anything above ty (skip bedrock).
  for (let y = ty + 1; y < WORLD_Y; y++) {
    const idx = worldIndex(wx, y, wz);
    const cur = voxels[idx]!;
    if (cur === AIR) continue;
    if (cur === M_BEDROCK) continue;
    voxels[idx] = AIR;
  }
  // Surface (don't pave bedrock).
  const surfIdx = worldIndex(wx, ty, wz);
  if (voxels[surfIdx]! !== M_BEDROCK) voxels[surfIdx] = material;
  // Sub-base: fill any air below the surface, up to ROAD_DEPTH_VOXELS-1 deep.
  for (let dy = 1; dy < ROAD_DEPTH_VOXELS; dy++) {
    const y = ty - dy;
    if (y < 1) break;
    const idx = worldIndex(wx, y, wz);
    const cur = voxels[idx]!;
    if (cur === M_BEDROCK) break;
    if (cur === AIR) voxels[idx] = material;
  }
}
