/**
 * A* and Theta* on a per-unit-type 3D pathfinding grid.
 *
 * 26-connected neighbours; octile-style 3D heuristic (chebyshev-with-roots).
 * For diggers, edges into solid cells pay an extra `digCost` from the
 * VolumeGrid so a tunneler prefers existing tunnels but will still cut
 * through stone if that's the only way.
 *
 *   findPath           — plain weighted A* (fast, axis-aligned waypoints).
 *   findPathThetaStar  — Theta* variant: every time a node is relaxed, we
 *                        check line-of-sight from its parent's parent. If
 *                        clear, the parent of the new node skips one step,
 *                        producing near-optimal any-angle paths.
 */
import { FourAryHeap } from '../util/Heap';
import {
  GRID_X, GRID_Y, GRID_Z, GRID_COUNT,
  cellIndex, unpackCell, getBit,
} from './Nav';
import { VolumeGrid } from './VolumeGrid';
import { UnitGrid, isPassable, isUnitCellPassable } from './UnitGrid';

export interface PathNode { cx: number; cy: number; cz: number; }

export interface PathTelemetry {
  /** 'astar' | 'thetastar' | 'hpa' */
  algorithm: string;
  /** Wall-clock ms for the whole search. */
  durationMs: number;
  /** HPA* only: Dijkstra within start+goal clusters. */
  hpaDijkstraMs?: number;
  /** HPA* only: abstract portal graph A*. */
  hpaAbstractMs?: number;
  /** HPA* only: sum of per-segment refinement A* calls. */
  hpaRefineMs?: number;
  /** HPA* only: number of segments refined. */
  hpaSegments?: number;
}

export interface PathResult {
  cells: PathNode[];
  reached: boolean;
  expanded: number;
  timings?: PathTelemetry;
}

export interface AStarOptions {
  /** Hard cap on cells expanded before bailing with a partial path. */
  maxExpansions?: number;
  /**
   * Inflate the heuristic by this factor. >1 = greedy / faster but
   * suboptimal; 1 = admissible. Defaults to 1.4.
   */
  heuristicWeight?: number;
  /**
   * If set, also consult the VolumeGrid for digger edge-cost (cells with any
   * solid pay `1 + digCost`). For non-diggers this is unused (solid cells
   * are already pruned by the bitmap).
   */
  volume?: VolumeGrid;
}

// y-major linear-index strides. Per +1 cy add Y_STRIDE, per +1 cz add Z_STRIDE.
const Y_STRIDE = GRID_X * GRID_Z;
const Z_STRIDE = GRID_X;

// 26-connected neighbour offsets in (dx, dy, dz). Built once at module load
// so the inner loop reads them as monomorphic Int8Array indexed loads.
// NB_DI is the precomputed flat-index delta — `i + NB_DI[n]` lands on the
// neighbour cell directly, avoiding a full cellIndex multiply per neighbour.
const NB_DX = new Int8Array(26);
const NB_DY = new Int8Array(26);
const NB_DZ = new Int8Array(26);
const NB_COST = new Float32Array(26);
const NB_DI = new Int32Array(26);
{
  const SQRT2 = Math.SQRT2;
  const SQRT3 = Math.sqrt(3);
  let k = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dim = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
        NB_DX[k] = dx;
        NB_DY[k] = dy;
        NB_DZ[k] = dz;
        NB_COST[k] = dim === 1 ? 1 : dim === 2 ? SQRT2 : SQRT3;
        NB_DI[k] = dx + dz * Z_STRIDE + dy * Y_STRIDE;
        k++;
      }
    }
  }
}

// Math constants pulled into module-local consts so the inner loop avoids
// a property lookup on the global Math object on every iteration.
const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);

/** Octile-style 3D heuristic — never overestimates the true 26-connected cost. */
function heuristic(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  let dx = ax - bx; if (dx < 0) dx = -dx;
  let dy = ay - by; if (dy < 0) dy = -dy;
  let dz = az - bz; if (dz < 0) dz = -dz;
  // Order so dx >= dy >= dz to avoid Math.max/min calls.
  if (dx < dy) { const t = dx; dx = dy; dy = t; }
  if (dy < dz) { const t = dy; dy = dz; dz = t; }
  if (dx < dy) { const t = dx; dx = dy; dy = t; }
  // dx = max, dz = min, dy = mid.
  return (dx - dy) + (dy - dz) * SQRT2 + dz * SQRT3;
}

/**
 * Workspace owning the per-cell A* state. Reuse one workspace across many
 * queries — the generation counter auto-invalidates stale entries on every
 * `reset()` so we never clear the whole array.
 *
 * Each query owns a pair of consecutive generation tickets: `g` for cells that
 * have been relaxed (open), and `g + 1` for cells that have been popped
 * (closed). genTick advances by 2 per query so the two markers never collide
 * with another query's. This folds the previous separate `closed` Uint8Array
 * into the `gen` Int32Array, saving ~384 KB per workspace.
 */
export class AStarWorkspace {
  readonly gScore = new Float32Array(GRID_COUNT);
  readonly cameFrom = new Int32Array(GRID_COUNT);
  readonly gen = new Int32Array(GRID_COUNT);
  readonly open = new FourAryHeap(8192);
  private genTick = 0;

  /** Returns the open marker for this query; closed marker is `+ 1`. */
  reset(): number {
    this.genTick = (this.genTick + 2) | 0;
    if (this.genTick <= 0) {
      this.gen.fill(0);
      this.genTick = 2;
    }
    this.open.clear();
    return this.genTick;
  }
}

/**
 * Find a path on the unit grid using weighted A*. Returns a list of cell
 * waypoints from start to goal (inclusive). `reached` is false when the goal
 * is unreachable or the expansion cap fired — the result still contains the
 * partial chain to the closest expanded cell so the caller can move toward
 * the goal.
 */
export function findPath(
  grid: UnitGrid,
  start: PathNode,
  goal: PathNode,
  ws: AStarWorkspace,
  opts: AStarOptions = {},
): PathResult {
  const t0 = performance.now();
  const gen = ws.reset();
  const closedMark = gen + 1;
  const w = opts.heuristicWeight ?? 1.4;
  const cap = opts.maxExpansions ?? 40000;
  const vol = opts.volume;

  const gcx = goal.cx, gcy = goal.cy, gcz = goal.cz;
  const startI = cellIndex(start.cx, start.cy, start.cz);
  const goalI = cellIndex(gcx, gcy, gcz);

  if (startI === goalI) {
    return { cells: [{ ...start }], reached: true, expanded: 0, timings: { algorithm: 'astar', durationMs: performance.now() - t0 } };
  }
  // Goal must be a cell the unit could actually stand in. For diggers, any
  // non-bedrock cell where the body fits is already marked passable, so a
  // goal inside dirt/stone is fine; only bedrock or out-of-bounds rejects.
  // The start cell is allowed to be impassable (the unit may be partially
  // buried after a cave-in); the search just doesn't gate it.
  if (!isPassable(grid, gcx, gcy, gcz)) {
    return { cells: [], reached: false, expanded: 0, timings: { algorithm: 'astar', durationMs: performance.now() - t0 } };
  }

  const passable = grid.passable;
  const profile = grid.profile;
  const canDig = profile.canDig;
  const slopePenalty = profile.slopePenalty;
  const hasSlopePenalty = slopePenalty > 0;
  const enforceStep = !canDig && profile.requiresGround && !!vol;
  const maxStep = profile.maxStepVoxels;
  const digCostArr = vol ? vol.digCost : null;
  const solidArr = vol ? vol.solid : null;
  const topYArr = vol ? vol.topY : null;
  const useDigCost = canDig && !!digCostArr && !!solidArr;

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, w * heuristic(start.cx, start.cy, start.cz, gcx, gcy, gcz));

  let bestPartial = startI;
  let bestPartialH = heuristic(start.cx, start.cy, start.cz, gcx, gcy, gcz);
  let expanded = 0;
  let reached = false;

  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.gen[i] === closedMark) continue;
    ws.gen[i] = closedMark;
    expanded++;

    if (i === goalI) { reached = true; break; }

    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    const gI = ws.gScore[i]!;
    const hI = heuristic(cx, cy, cz, gcx, gcy, gcz);
    if (hI < bestPartialH) { bestPartialH = hI; bestPartial = i; }
    if (expanded >= cap) break;

    // Step-climb floor for the parent cell — same for every neighbour, so
    // hoist it once. 255 is the topY "no solid in column below" sentinel.
    let aFloorY = 255;
    if (enforceStep && cy !== 0) {
      aFloorY = topYArr![i - Y_STRIDE]!;
    }

    for (let n = 0; n < 26; n++) {
      const dx = NB_DX[n]!;
      const dy = NB_DY[n]!;
      const dz = NB_DZ[n]!;
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= GRID_X || ny >= GRID_Y || nz >= GRID_Z) continue;
      const ni = i + NB_DI[n]!;
      // Inlined bitmap passable check — same shape as isPassable() but skips
      // a function call and a redundant cellIndex multiply.
      if (((passable[ni >> 3]! >> (ni & 7)) & 1) === 0) continue;
      if (ws.gen[ni] === closedMark) continue;

      // Step-climb gate (only meaningful for non-digger, requires-ground).
      if (enforceStep && cy !== 0 && ny !== 0 && aFloorY !== 255) {
        const bFloorY = topYArr![ni - Y_STRIDE]!;
        if (bFloorY !== 255) {
          const dY = aFloorY < bFloorY ? bFloorY - aFloorY : aFloorY - bFloorY;
          if (dY > maxStep) continue;
        }
      }

      // Edge cost: base distance + dig cost (diggers only, if cell has
      // any solid voxel) + slope penalty (if kind has one).
      let stepC = NB_COST[n]!;
      if (useDigCost) {
        if ((solidArr![ni >> 3]! >> (ni & 7)) & 1) stepC += digCostArr![ni]!;
      }
      if (hasSlopePenalty && dy !== 0) {
        stepC += (dy < 0 ? -dy : dy) * slopePenalty;
      }
      const g = gI + stepC;
      const seen = ws.gen[ni] === gen;
      if (!seen || g < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = g;
        ws.cameFrom[ni] = i;
        const f = g + w * heuristic(nx, ny, nz, gcx, gcy, gcz);
        ws.open.push(ni, f);
      }
    }
  }

  const endI = reached ? goalI : bestPartial;
  return { cells: reconstruct(ws, gen, startI, endI), reached, expanded, timings: { algorithm: 'astar', durationMs: performance.now() - t0 } };
}

/**
 * Theta* — every time we relax a node, check line-of-sight from the new
 * node back to its parent's parent (the grandparent). If the line is clear,
 * skip the parent and connect directly. The result is a chain of cells
 * that, when joined, forms a near-optimal any-angle path. Use this for
 * agile single-cell units (soldier, worker) where smooth diagonals matter.
 *
 * Wider units fall back to grid A* — Theta*'s line-of-sight check on a
 * thick footprint becomes its own pathological cost when paths constantly
 * fail the check (the path reverts to A*-quality anyway).
 */
export function findPathThetaStar(
  grid: UnitGrid,
  start: PathNode,
  goal: PathNode,
  ws: AStarWorkspace,
  opts: AStarOptions = {},
): PathResult {
  const t0 = performance.now();
  const gen = ws.reset();
  const closedMark = gen + 1;
  const w = opts.heuristicWeight ?? 1.4;
  const cap = opts.maxExpansions ?? 40000;
  const vol = opts.volume;

  const gcx = goal.cx, gcy = goal.cy, gcz = goal.cz;
  const startI = cellIndex(start.cx, start.cy, start.cz);
  const goalI = cellIndex(gcx, gcy, gcz);
  if (startI === goalI) return { cells: [{ ...start }], reached: true, expanded: 0, timings: { algorithm: 'thetastar', durationMs: performance.now() - t0 } };

  const passable = grid.passable;
  const profile = grid.profile;
  const canDig = profile.canDig;
  const slopePenalty = profile.slopePenalty;
  const hasSlopePenalty = slopePenalty > 0;
  const enforceStep = !canDig && profile.requiresGround && !!vol;
  const maxStep = profile.maxStepVoxels;
  const digCostArr = vol ? vol.digCost : null;
  const solidArr = vol ? vol.solid : null;
  const topYArr = vol ? vol.topY : null;
  const useDigCost = canDig && !!digCostArr && !!solidArr;

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, w * heuristic(start.cx, start.cy, start.cz, gcx, gcy, gcz));

  let bestPartial = startI;
  let bestPartialH = heuristic(start.cx, start.cy, start.cz, gcx, gcy, gcz);
  let expanded = 0;
  let reached = false;

  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.gen[i] === closedMark) continue;
    ws.gen[i] = closedMark;
    expanded++;
    if (i === goalI) { reached = true; break; }

    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    const gI = ws.gScore[i]!;
    const hI = heuristic(cx, cy, cz, gcx, gcy, gcz);
    if (hI < bestPartialH) { bestPartialH = hI; bestPartial = i; }
    if (expanded >= cap) break;

    const parentI = ws.cameFrom[i]!;
    // Parent is whatever cell relaxed `i` (so `gen[parentI]` is `gen` if it
    // was just opened, or `closedMark` if it has since been popped).
    const parentGen = parentI >= 0 ? ws.gen[parentI] : 0;
    const parentValid = parentI >= 0 && (parentGen === gen || parentGen === closedMark);
    let pcx = 0, pcy = 0, pcz = 0;
    let parentG = 0;
    if (parentValid) {
      pcx = parentI % GRID_X;
      const ptmp = (parentI / GRID_X) | 0;
      pcz = ptmp % GRID_Z;
      pcy = (ptmp / GRID_Z) | 0;
      parentG = ws.gScore[parentI]!;
    }

    let aFloorY = 255;
    if (enforceStep && cy !== 0) {
      aFloorY = topYArr![i - Y_STRIDE]!;
    }

    for (let n = 0; n < 26; n++) {
      const dx = NB_DX[n]!;
      const dy = NB_DY[n]!;
      const dz = NB_DZ[n]!;
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= GRID_X || ny >= GRID_Y || nz >= GRID_Z) continue;
      const ni = i + NB_DI[n]!;
      if (((passable[ni >> 3]! >> (ni & 7)) & 1) === 0) continue;
      if (ws.gen[ni] === closedMark) continue;

      if (enforceStep && cy !== 0 && ny !== 0 && aFloorY !== 255) {
        const bFloorY = topYArr![ni - Y_STRIDE]!;
        if (bFloorY !== 255) {
          const dY = aFloorY < bFloorY ? bFloorY - aFloorY : aFloorY - bFloorY;
          if (dY > maxStep) continue;
        }
      }

      // Path 1: standard relax through current cell.
      let stepC = NB_COST[n]!;
      if (useDigCost) {
        if ((solidArr![ni >> 3]! >> (ni & 7)) & 1) stepC += digCostArr![ni]!;
      }
      if (hasSlopePenalty && dy !== 0) {
        stepC += (dy < 0 ? -dy : dy) * slopePenalty;
      }
      const g1 = gI + stepC;
      let bestG = g1;
      let bestParent = i;

      // Path 2 (Theta*): relax through grandparent if line-of-sight is clear.
      if (parentValid && lineOfSight(grid, vol, pcx, pcy, pcz, nx, ny, nz)) {
        const dxp = nx - pcx;
        const dyp = ny - pcy;
        const dzp = nz - pcz;
        const lineCost = euclideanCost(grid, vol, pcx, pcy, pcz, nx, ny, nz, dxp, dyp, dzp);
        const g2 = parentG + lineCost;
        if (g2 < bestG) { bestG = g2; bestParent = parentI; }
      }

      const seen = ws.gen[ni] === gen;
      if (!seen || bestG < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = bestG;
        ws.cameFrom[ni] = bestParent;
        const f = bestG + w * heuristic(nx, ny, nz, gcx, gcy, gcz);
        ws.open.push(ni, f);
      }
    }
  }

  const endI = reached ? goalI : bestPartial;
  return { cells: reconstruct(ws, gen, startI, endI), reached, expanded, timings: { algorithm: 'thetastar', durationMs: performance.now() - t0 } };
}

function reconstruct(ws: AStarWorkspace, gen: number, startI: number, endI: number): PathNode[] {
  const closedMark = gen + 1;
  const out: PathNode[] = [];
  let cur = endI;
  let safety = GRID_COUNT;
  while (cur !== -1 && safety-- > 0) {
    out.push(unpackCell(cur));
    if (cur === startI) break;
    const g = ws.gen[cur];
    if (g !== gen && g !== closedMark) break;
    cur = ws.cameFrom[cur]!;
  }
  out.reverse();
  return out;
}

/**
 * Supercover 3D line-of-sight on the unit grid. Walks every cell touched by
 * the line from (ax, ay, az) to (bx, by, bz) and rejects when any cell is not
 * passable for this unit. Used by Theta* to validate any-angle shortcuts.
 *
 * We sample at unit-cell granularity; the small over-sampling is fine for the
 * line-of-sight gate (false negatives cost a tiny amount of path quality, false
 * positives let the unit cut through walls). Diggers also reject bedrock cells
 * along the line — they can carve dirt but bedrock is hard-blocked.
 */
export function lineOfSight(
  grid: UnitGrid,
  vol: VolumeGrid | undefined,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  const adz = dz < 0 ? -dz : dz;
  const steps = adx > ady ? (adx > adz ? adx : adz) : (ady > adz ? ady : adz);
  if (steps === 0) return true;
  const passable = grid.passable;
  const checkBedrock = grid.profile.canDig && !!vol;
  const bedrock = vol ? vol.bedrock : null;
  const inv = 1 / steps;
  for (let s = 1; s <= steps; s++) {
    const t = s * inv;
    const cx = Math.round(ax + dx * t);
    const cy = Math.round(ay + dy * t);
    const cz = Math.round(az + dz * t);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return false;
    const i = cellIndex(cx, cy, cz);
    if (((passable[i >> 3]! >> (i & 7)) & 1) === 0) return false;
    // Diggers can't cut through bedrock — even on a Theta* shortcut.
    if (checkBedrock && ((bedrock![i >> 3]! >> (i & 7)) & 1)) return false;
  }
  return true;
}

/**
 * Edge cost for a Theta* shortcut between two non-adjacent cells. Approximated
 * as the Euclidean distance plus the average dig cost over the line for diggers
 * (so a long shortcut through stone still pays for itself proportionally).
 */
function euclideanCost(
  grid: UnitGrid,
  vol: VolumeGrid | undefined,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  dx: number, dy: number, dz: number,
): number {
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let extra = 0;
  if (grid.profile.canDig && vol) {
    const adx = dx < 0 ? -dx : dx;
    const ady = dy < 0 ? -dy : dy;
    const adz = dz < 0 ? -dz : dz;
    const steps = (adx > ady ? (adx > adz ? adx : adz) : (ady > adz ? ady : adz)) || 1;
    const inv = 1 / steps;
    let solidCost = 0;
    for (let s = 1; s <= steps; s++) {
      const t = s * inv;
      const cx = Math.round(ax + dx * t);
      const cy = Math.round(ay + dy * t);
      const cz = Math.round(az + dz * t);
      const i = cellIndex(cx, cy, cz);
      if (getBit(vol.solid, i)) solidCost += vol.digCost[i]!;
    }
    extra = solidCost / steps * dist;
  }
  if (grid.profile.slopePenalty > 0 && dy !== 0) {
    extra += (dy < 0 ? -dy : dy) * grid.profile.slopePenalty;
  }
  return dist + extra;
}

/** Re-export so consumers can build the unit-grid passability check on the fly. */
export { isUnitCellPassable };
