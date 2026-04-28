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

export interface PathResult {
  cells: PathNode[];
  reached: boolean;
  expanded: number;
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

// 26-connected neighbour offsets in (dx, dy, dz). Built once at module load
// so the inner loop reads them as monomorphic Int8Array indexed loads.
const NB_DX = new Int8Array(26);
const NB_DY = new Int8Array(26);
const NB_DZ = new Int8Array(26);
const NB_COST = new Float32Array(26);
{
  let k = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dim = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
        NB_DX[k] = dx;
        NB_DY[k] = dy;
        NB_DZ[k] = dz;
        NB_COST[k] = dim === 1 ? 1 : dim === 2 ? Math.SQRT2 : Math.sqrt(3);
        k++;
      }
    }
  }
}

/** Octile-style 3D heuristic — never overestimates the true 26-connected cost. */
function heuristic(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by), dz = Math.abs(az - bz);
  const max = Math.max(dx, dy, dz);
  const min = Math.min(dx, dy, dz);
  const mid = dx + dy + dz - max - min;
  return (max - mid) + (mid - min) * Math.SQRT2 + min * Math.sqrt(3);
}

/**
 * Workspace owning the per-cell A* state. Reuse one workspace across many
 * queries — the generation counter auto-invalidates stale entries on every
 * `reset()` so we never clear the whole array.
 */
export class AStarWorkspace {
  readonly gScore = new Float32Array(GRID_COUNT);
  readonly cameFrom = new Int32Array(GRID_COUNT);
  readonly closed = new Uint8Array(GRID_COUNT);
  readonly gen = new Int32Array(GRID_COUNT);
  readonly open = new FourAryHeap(8192);
  private genTick = 0;

  reset(): number {
    this.genTick = (this.genTick + 1) | 0;
    if (this.genTick === 0) {
      this.gen.fill(0);
      this.genTick = 1;
    }
    this.open.clear();
    return this.genTick;
  }
}

/**
 * Compute the edge cost from `aIdx` to `bIdx` for a single 26-neighbour step.
 * Diggers pay an extra dig cost when the destination has any solid voxel; the
 * step cost itself is the geometric distance (1, √2, or √3).
 */
function stepCost(grid: UnitGrid, vol: VolumeGrid | undefined, baseCost: number, dy: number, bIdx: number): number {
  let c = baseCost;
  if (grid.profile.canDig && vol) {
    if (getBit(vol.solid, bIdx)) c += vol.digCost[bIdx]!;
  }
  if (grid.profile.slopePenalty > 0 && dy !== 0) {
    c += Math.abs(dy) * grid.profile.slopePenalty;
  }
  return c;
}

/**
 * Step-climb gate. Returns true when the unit can transition between two cells
 * given the local floor heights inferred from the volume grid below them. We
 * compare the voxel-y of the highest solid in the cell directly under each
 * (the floor the unit stands on). When the difference exceeds the unit's
 * `maxStepVoxels`, the edge is impassable. Diggers bypass this check (they
 * grind through anything in their way).
 */
function stepClimbOk(grid: UnitGrid, vol: VolumeGrid | undefined, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  if (grid.profile.canDig) return true;
  if (!grid.profile.requiresGround || !vol) return true;
  if (ay === 0 || by === 0) return true;
  const aFloorY = vol.topY[cellIndex(ax, ay - 1, az)]!;
  const bFloorY = vol.topY[cellIndex(bx, by - 1, bz)]!;
  if (aFloorY < 0 || bFloorY < 0) return true; // floor handled elsewhere
  const dY = Math.abs(aFloorY - bFloorY);
  if (dY > grid.profile.maxStepVoxels) return false;
  return true;
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
  const gen = ws.reset();
  const w = opts.heuristicWeight ?? 1.4;
  const cap = opts.maxExpansions ?? 40000;
  const vol = opts.volume;

  const startI = cellIndex(start.cx, start.cy, start.cz);
  const goalI = cellIndex(goal.cx, goal.cy, goal.cz);

  if (startI === goalI) {
    return { cells: [{ ...start }], reached: true, expanded: 0 };
  }
  // Goal must be a cell the unit could actually stand in. For diggers, any
  // non-bedrock cell where the body fits is already marked passable, so a
  // goal inside dirt/stone is fine; only bedrock or out-of-bounds rejects.
  // The start cell is allowed to be impassable (the unit may be partially
  // buried after a cave-in); the search just doesn't gate it.
  if (!isPassable(grid, goal.cx, goal.cy, goal.cz)) {
    return { cells: [], reached: false, expanded: 0 };
  }

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, w * heuristic(start.cx, start.cy, start.cz, goal.cx, goal.cy, goal.cz));

  let bestPartial = startI;
  let bestPartialH = heuristic(start.cx, start.cy, start.cz, goal.cx, goal.cy, goal.cz);
  let expanded = 0;
  let reached = false;

  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.closed[i] === gen) continue;
    ws.closed[i] = gen;
    expanded++;

    if (i === goalI) { reached = true; break; }

    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    const gI = ws.gScore[i]!;
    const hI = heuristic(cx, cy, cz, goal.cx, goal.cy, goal.cz);
    if (hI < bestPartialH) { bestPartialH = hI; bestPartial = i; }
    if (expanded >= cap) break;

    for (let n = 0; n < 26; n++) {
      const dx = NB_DX[n]!;
      const dy = NB_DY[n]!;
      const dz = NB_DZ[n]!;
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= GRID_X || ny >= GRID_Y || nz >= GRID_Z) continue;
      const ni = cellIndex(nx, ny, nz);
      if (!isPassable(grid, nx, ny, nz)) continue;
      if (ws.closed[ni] === gen) continue;
      if (!stepClimbOk(grid, vol, cx, cy, cz, nx, ny, nz)) continue;

      const g = gI + stepCost(grid, vol, NB_COST[n]!, dy, ni);
      const seen = ws.gen[ni] === gen;
      if (!seen || g < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = g;
        ws.cameFrom[ni] = i;
        const f = g + w * heuristic(nx, ny, nz, goal.cx, goal.cy, goal.cz);
        ws.open.push(ni, f);
      }
    }
  }

  const endI = reached ? goalI : bestPartial;
  return { cells: reconstruct(ws, gen, startI, endI), reached, expanded };
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
  const gen = ws.reset();
  const w = opts.heuristicWeight ?? 1.4;
  const cap = opts.maxExpansions ?? 40000;
  const vol = opts.volume;

  const startI = cellIndex(start.cx, start.cy, start.cz);
  const goalI = cellIndex(goal.cx, goal.cy, goal.cz);
  if (startI === goalI) return { cells: [{ ...start }], reached: true, expanded: 0 };

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, w * heuristic(start.cx, start.cy, start.cz, goal.cx, goal.cy, goal.cz));

  let bestPartial = startI;
  let bestPartialH = heuristic(start.cx, start.cy, start.cz, goal.cx, goal.cy, goal.cz);
  let expanded = 0;
  let reached = false;

  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.closed[i] === gen) continue;
    ws.closed[i] = gen;
    expanded++;
    if (i === goalI) { reached = true; break; }

    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    const hI = heuristic(cx, cy, cz, goal.cx, goal.cy, goal.cz);
    if (hI < bestPartialH) { bestPartialH = hI; bestPartial = i; }
    if (expanded >= cap) break;

    const parentI = ws.cameFrom[i]!;
    const parentValid = parentI >= 0 && ws.gen[parentI] === gen;
    let pcx = 0, pcy = 0, pcz = 0;
    if (parentValid) {
      pcx = parentI % GRID_X;
      const ptmp = (parentI / GRID_X) | 0;
      pcz = ptmp % GRID_Z;
      pcy = (ptmp / GRID_Z) | 0;
    }

    for (let n = 0; n < 26; n++) {
      const dx = NB_DX[n]!;
      const dy = NB_DY[n]!;
      const dz = NB_DZ[n]!;
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= GRID_X || ny >= GRID_Y || nz >= GRID_Z) continue;
      const ni = cellIndex(nx, ny, nz);
      if (!isPassable(grid, nx, ny, nz)) continue;
      if (ws.closed[ni] === gen) continue;
      if (!stepClimbOk(grid, vol, cx, cy, cz, nx, ny, nz)) continue;

      // Path 1: standard relax through current cell.
      const g1 = ws.gScore[i]! + stepCost(grid, vol, NB_COST[n]!, dy, ni);
      let bestG = g1;
      let bestParent = i;

      // Path 2 (Theta*): relax through grandparent if line-of-sight is clear.
      if (parentValid && lineOfSight(grid, vol, pcx, pcy, pcz, nx, ny, nz)) {
        const dxp = nx - pcx;
        const dyp = ny - pcy;
        const dzp = nz - pcz;
        const lineCost = euclideanCost(grid, vol, pcx, pcy, pcz, nx, ny, nz, dxp, dyp, dzp);
        const g2 = ws.gScore[parentI]! + lineCost;
        if (g2 < bestG) { bestG = g2; bestParent = parentI; }
      }

      const seen = ws.gen[ni] === gen;
      if (!seen || bestG < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = bestG;
        ws.cameFrom[ni] = bestParent;
        const f = bestG + w * heuristic(nx, ny, nz, goal.cx, goal.cy, goal.cz);
        ws.open.push(ni, f);
      }
    }
  }

  const endI = reached ? goalI : bestPartial;
  return { cells: reconstruct(ws, gen, startI, endI), reached, expanded };
}

function reconstruct(ws: AStarWorkspace, gen: number, startI: number, endI: number): PathNode[] {
  const out: PathNode[] = [];
  let cur = endI;
  let safety = GRID_COUNT;
  while (cur !== -1 && safety-- > 0) {
    out.push(unpackCell(cur));
    if (cur === startI) break;
    if (ws.gen[cur] !== gen) break;
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
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return true;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(ax + dx * t);
    const cy = Math.round(ay + dy * t);
    const cz = Math.round(az + dz * t);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return false;
    if (!isPassable(grid, cx, cy, cz)) return false;
    if (grid.profile.canDig && vol) {
      // Diggers can't cut through bedrock — even on a Theta* shortcut.
      const i = cellIndex(cx, cy, cz);
      if (getBit(vol.bedrock, i)) return false;
    }
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
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) || 1;
    let solidCost = 0;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cx = Math.round(ax + dx * t);
      const cy = Math.round(ay + dy * t);
      const cz = Math.round(az + dz * t);
      const i = cellIndex(cx, cy, cz);
      if (getBit(vol.solid, i)) solidCost += vol.digCost[i]!;
    }
    extra = solidCost / steps * dist;
  }
  if (grid.profile.slopePenalty > 0 && dy !== 0) {
    extra += Math.abs(dy) * grid.profile.slopePenalty;
  }
  return dist + extra;
}

/** Re-export so consumers can build the unit-grid passability check on the fly. */
export { isUnitCellPassable };
