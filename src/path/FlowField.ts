/**
 * Flow-field pathing for many-units-one-goal scenarios.
 *
 * Computes a single 3D Dijkstra integration field rooted at the goal over a
 * UnitGrid's passable cells, then derives a per-cell direction byte pointing
 * to the lowest-cost 26-neighbour. Every unit reads its current cell's
 * direction in O(1) per tick, so the per-search cost is amortised across the
 * whole group rather than paid per unit.
 *
 * For very large maps you'd typically pair this with a cluster restriction
 * (HPA* picks a corridor of clusters; the flow field is computed only over
 * cells inside that corridor). The plain `buildFlowField` here is the basic
 * full-grid version; pass an optional cluster filter to restrict.
 *
 * Layout: the field is sized to the full GRID_COUNT but only entries inside
 * `region` (or every passable cell if no region is set) get populated. The
 * `dir` byte is one of 0..25 pointing into the AStar 26-neighbour table, or
 * 26 for "this cell IS the goal", or 27 for "no direction (unreachable)".
 */
import {
  GRID_X, GRID_Y, GRID_Z, GRID_COUNT, cellIndex,
} from './Nav';
import { UnitGrid } from './UnitGrid';
import { FourAryHeap } from '../util/Heap';
import { clusterOfCell } from './ClusterGraph';

const Y_STRIDE = GRID_X * GRID_Z;
const Z_STRIDE = GRID_X;
const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);

const NB_DX = new Int8Array(26);
const NB_DY = new Int8Array(26);
const NB_DZ = new Int8Array(26);
const NB_COST = new Float32Array(26);
const NB_DI = new Int32Array(26);
{
  let k = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dim = (dx ? 1 : 0) + (dy ? 1 : 0) + (dz ? 1 : 0);
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

export const FLOW_GOAL = 26;
export const FLOW_NONE = 27;

export interface FlowField {
  /** Goal cell index — the field's root. */
  goal: number;
  /** Integration cost from each cell to the goal, Infinity if unreachable. */
  cost: Float32Array;
  /** Direction index 0..25 (neighbour idx), 26 (goal), or 27 (none). */
  dir: Uint8Array;
}

export interface FlowFieldOptions {
  /**
   * If set, restricts expansion to cells in clusters whose index is set in
   * this Uint8Array. Pair with HPA* to compute only the corridor of clusters
   * along the abstract path — the field stays cheap on large maps with
   * tightly-grouped destinations.
   */
  clusterMask?: Uint8Array;
  /** Stop expansion once the cost from goal exceeds this radius. */
  maxCost?: number;
}

/**
 * Build a flow field rooted at `goal`. Returns a fresh field; reuse the
 * returned object if you cache by goal cell. Cost is one Dijkstra over the
 * passable cells in the (optionally cluster-restricted) region.
 */
export function buildFlowField(
  grid: UnitGrid,
  goal: { cx: number; cy: number; cz: number },
  opts: FlowFieldOptions = {},
): FlowField {
  const goalI = cellIndex(goal.cx, goal.cy, goal.cz);
  const cost = new Float32Array(GRID_COUNT);
  cost.fill(Infinity);
  const dir = new Uint8Array(GRID_COUNT);
  dir.fill(FLOW_NONE);

  const passable = grid.passable;
  if (((passable[goalI >> 3]! >> (goalI & 7)) & 1) === 0) {
    return { goal: goalI, cost, dir };
  }

  cost[goalI] = 0;
  dir[goalI] = FLOW_GOAL;

  const heap = new FourAryHeap(2048);
  heap.push(goalI, 0);
  const maxCost = opts.maxCost ?? Infinity;
  const mask = opts.clusterMask;

  while (heap.length > 0) {
    const i = heap.pop();
    const d = cost[i]!;
    if (d > maxCost) break; // priority order — everything after is also > maxCost.

    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;

    for (let n = 0; n < 26; n++) {
      const nx = cx + NB_DX[n]!;
      const ny = cy + NB_DY[n]!;
      const nz = cz + NB_DZ[n]!;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= GRID_X || ny >= GRID_Y || nz >= GRID_Z) continue;
      const ni = i + NB_DI[n]!;
      if (((passable[ni >> 3]! >> (ni & 7)) & 1) === 0) continue;
      if (mask && mask[clusterOfCell(nx, ny, nz)] === 0) continue;
      const nd = d + NB_COST[n]!;
      if (nd < cost[ni]!) {
        cost[ni] = nd;
        // Direction stored at the *neighbour* cell points back toward `i`.
        // We invert n by negating the deltas — the table layout has the
        // inverse at index (25 - n) since neighbours are emitted in a fixed
        // dz/dy/dx triple-loop and the inversion flips all three signs.
        dir[ni] = (25 - n) as number;
        heap.push(ni, nd);
      }
    }
  }

  return { goal: goalI, cost, dir };
}

/**
 * Look up the direction at cell `(cx,cy,cz)` and return the neighbour cell
 * the unit should step to next. Returns null if the cell is unreachable or
 * already at the goal.
 */
export function nextStep(field: FlowField, cx: number, cy: number, cz: number): {
  cx: number; cy: number; cz: number;
} | null {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return null;
  const i = cellIndex(cx, cy, cz);
  const d = field.dir[i]!;
  if (d === FLOW_NONE || d === FLOW_GOAL) return null;
  return {
    cx: cx + NB_DX[d]!,
    cy: cy + NB_DY[d]!,
    cz: cz + NB_DZ[d]!,
  };
}

/**
 * Per-goal flow-field cache. Holds the most recently requested fields so
 * units sharing a goal hit the same field without rebuilding. Cache eviction
 * is plain LRU keyed on the goal cell index.
 *
 * Invalidate via `clear()` after the unit grid changes — the field is tied to
 * the grid's passability bitmap at build time.
 */
export class FlowFieldCache {
  private map = new Map<number, FlowField>();
  constructor(private capacity = 8) {}

  /** Look up a cached field for the goal, or build one (and cache it). */
  get(grid: UnitGrid, goal: { cx: number; cy: number; cz: number }, opts?: FlowFieldOptions): FlowField {
    const key = cellIndex(goal.cx, goal.cy, goal.cz);
    const hit = this.map.get(key);
    if (hit) {
      // Touch — move to most-recently-used by re-inserting.
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const field = buildFlowField(grid, goal, opts);
    this.map.set(key, field);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return field;
  }

  has(goal: { cx: number; cy: number; cz: number }): boolean {
    return this.map.has(cellIndex(goal.cx, goal.cy, goal.cz));
  }

  clear(): void { this.map.clear(); }
}
