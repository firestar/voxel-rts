import { FourAryHeap } from '../util/Heap';
import {
  VolumeNavBuffers, VNAV_X, VNAV_Y, VNAV_Z, VNAV_COUNT,
  vnavIndex, getBit,
} from './VolumeNav';

export interface AStar3DRequest {
  startCx: number; startCy: number; startCz: number;
  goalCx: number;  goalCy: number;  goalCz: number;
  /** Whether the unit may carve through solid material. False for tank/soldier. */
  canDig: boolean;
  /** Empty cells must have a solid cell directly below to be enterable. */
  requiresGround: boolean;
  /** Cell-radius footprint — adjacent cells in XZ within this radius must also be enterable. */
  footprintRadius: number;
  /**
   * Optional maximum climb / dive angle in radians. Edges whose vertical component sits
   * above the slope tan(maxPitchRad) are rejected — keeps the tunneler from being asked
   * to dig straight up or down.
   */
  maxPitchRad?: number;
  /** Hard cap on expansions before bailing with partial path. */
  maxExpansions?: number;
}

export interface AStar3DResult {
  cells: { cx: number; cy: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

// 26-neighbor offsets and step costs. Stored as flat typed arrays so the inner
// loop reads them as monomorphic indexed loads instead of object property reads.
const NB26_DX = new Int8Array(26);
const NB26_DY = new Int8Array(26);
const NB26_DZ = new Int8Array(26);
const NB26_COST = new Float32Array(26);
// Squared horizontal step (dx² + dz²) — used by the squared-pitch comparison
// so we never call Math.hypot inside the inner loop.
const NB26_HORIZ2 = new Float32Array(26);
{
  let k = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dim = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
        const cost = dim === 1 ? 1 : dim === 2 ? Math.SQRT2 : Math.sqrt(3);
        NB26_DX[k] = dx;
        NB26_DY[k] = dy;
        NB26_DZ[k] = dz;
        NB26_COST[k] = cost;
        NB26_HORIZ2[k] = dx * dx + dz * dz;
        k++;
      }
    }
  }
}
const NB26_LEN = 26;

function chebyshev3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by), dz = Math.abs(az - bz);
  const max = Math.max(dx, dy, dz);
  const min = Math.min(dx, dy, dz);
  const mid = dx + dy + dz - max - min;
  return (max - mid) + (mid - min) * Math.SQRT2 + min * Math.sqrt(3);
}

export class AStar3DWorkspace {
  readonly gScore = new Float32Array(VNAV_COUNT);
  readonly cameFrom = new Int32Array(VNAV_COUNT);
  readonly closed = new Uint8Array(VNAV_COUNT);
  readonly gen = new Int32Array(VNAV_COUNT);
  readonly open = new FourAryHeap(8192);
  private genTick = 0;

  resetGeneration(): number {
    this.genTick = (this.genTick + 1) | 0;
    if (this.genTick === 0) {
      this.gen.fill(0);
      this.genTick = 1;
    }
    this.open.clear();
    return this.genTick;
  }
}

/** A cell is enterable for the requesting unit. */
function cellPassable(
  vnav: VolumeNavBuffers,
  cx: number, cy: number, cz: number,
  canDig: boolean,
  requiresGround: boolean,
  isStartOrGoal: boolean,
): boolean {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= VNAV_X || cy >= VNAV_Y || cz >= VNAV_Z) return false;
  const i = vnavIndex(cx, cy, cz);
  if (getBit(vnav.bedrock, i)) return false;
  const solid = getBit(vnav.solid, i) === 1;
  if (solid && !canDig) return false;
  if (!solid && requiresGround && !isStartOrGoal) {
    // Need a support below: solid cell at cy-1, or floor of world.
    if (cy === 0) return false;
    if (getBit(vnav.solid, vnavIndex(cx, cy - 1, cz)) !== 1) return false;
  }
  return true;
}

/** Footprint check: every cell of the footprint at this center must be passable. */
function footprintPassable(
  vnav: VolumeNavBuffers,
  cx: number, cy: number, cz: number,
  canDig: boolean,
  requiresGround: boolean,
  footprintRadius: number,
  isStartOrGoal: boolean,
): boolean {
  if (footprintRadius <= 1) {
    return cellPassable(vnav, cx, cy, cz, canDig, requiresGround, isStartOrGoal);
  }
  const r = footprintRadius - 1;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!cellPassable(vnav, cx + dx, cy, cz + dz, canDig, requiresGround, isStartOrGoal)) return false;
    }
  }
  return true;
}

/**
 * Heuristic weight for the volume A*. Inflating the heuristic above 1 makes the
 * search inadmissible (paths may be slightly suboptimal) but cone-shaped, which
 * is what we need for tunnelers — every step into solid stone costs `1 +
 * digCost` (≈18 for stone), so a weight-1 chebyshev3 heuristic is dwarfed by
 * the g-score and the search degenerates to a uniform-cost ball that hits the
 * expansion cap before reaching even modest goals. A weight of 8 lands a
 * 100-cell dig in ~7 k expansions instead of 170 k+, well inside the cap. The
 * trade-off is acceptable for RTS use — tunnelers prioritise getting there
 * over following the absolute cheapest dig.
 */
const HEURISTIC_WEIGHT = 8;

export function findPathVolume(
  vnav: VolumeNavBuffers,
  ws: AStar3DWorkspace,
  req: AStar3DRequest,
): AStar3DResult {
  const gen = ws.resetGeneration();
  const { startCx, startCy, startCz, goalCx, goalCy, goalCz, canDig, requiresGround, footprintRadius } = req;
  const maxTanPitch = req.maxPitchRad === undefined ? Infinity : Math.tan(req.maxPitchRad);
  // Squared form so the inner pitch test is `dy² > horiz² * tan²` — no sqrt.
  const maxTanPitchSq = maxTanPitch === Infinity ? Infinity : maxTanPitch * maxTanPitch;
  const havePitch = maxTanPitch !== Infinity;
  const maxExpansions = req.maxExpansions ?? 20000;

  const startI = vnavIndex(startCx, startCy, startCz);
  const goalI = vnavIndex(goalCx, goalCy, goalCz);

  // Goal must be enterable (allow start/goal to skip the requiresGround check so units can
  // be on stairs / doorway thresholds).
  if (!footprintPassable(vnav, goalCx, goalCy, goalCz, canDig, requiresGround, footprintRadius, true)) {
    return { cells: [], reached: false, expanded: 0 };
  }

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, HEURISTIC_WEIGHT * chebyshev3(startCx, startCy, startCz, goalCx, goalCy, goalCz));

  // Track the closed cell with the smallest heuristic-to-goal so partial paths
  // don't require an O(VNAV_COUNT) scan after a cap-out.
  let bestPartialNode = startI;
  let bestPartialH = chebyshev3(startCx, startCy, startCz, goalCx, goalCy, goalCz);

  let expanded = 0;
  let reached = false;
  // Hoist into locals to avoid property loads in the inner loop.
  const vnavSolid = vnav.solid;
  const vnavDigCost = vnav.digCost;
  const closedArr = ws.closed;
  const genArr = ws.gen;
  const gArr = ws.gScore;
  const cameFromArr = ws.cameFrom;
  const open = ws.open;
  while (open.length > 0) {
    const i = open.pop();
    if (closedArr[i] === gen) continue;
    closedArr[i] = gen;
    expanded++;
    if (i === goalI) { reached = true; break; }

    const cx = i % VNAV_X;
    const tmp = (i / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;
    const gI = gArr[i]!;

    // Track best partial as we settle each cell. Done before the expansion-cap
    // break so the very last cell we close is still a candidate (matches the
    // pre-optimisation behaviour of scanning every closed cell post-hoc).
    const hI = chebyshev3(cx, cy, cz, goalCx, goalCy, goalCz);
    if (hI < bestPartialH) { bestPartialH = hI; bestPartialNode = i; }
    if (expanded >= maxExpansions) break;

    for (let n = 0; n < NB26_LEN; n++) {
      const dx = NB26_DX[n]!;
      const dy = NB26_DY[n]!;
      const dz = NB26_DZ[n]!;
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= VNAV_X || ny >= VNAV_Y || nz >= VNAV_Z) continue;
      const ni = (ny * VNAV_Z + nz) * VNAV_X + nx;
      if (closedArr[ni] === gen) continue;
      // Pitch gate: |dy|/horiz <= tan(pitch). Squared form avoids hypot/sqrt.
      // Pure-vertical edges (horiz==0) are rejected when pitch is set.
      if (havePitch && dy !== 0) {
        const h2 = NB26_HORIZ2[n]!;
        if (h2 === 0 || dy * dy > h2 * maxTanPitchSq) continue;
      }
      if (!footprintPassable(vnav, nx, ny, nz, canDig, requiresGround, footprintRadius, ni === goalI)) continue;

      let stepCost = NB26_COST[n]!;
      const isSolid = (vnavSolid[ni >> 3]! >> (ni & 7)) & 1;
      if (isSolid) {
        stepCost += vnavDigCost[ni]!;
      }

      const g = gI + stepCost;
      const seen = genArr[ni] === gen;
      if (!seen || g < gArr[ni]!) {
        genArr[ni] = gen;
        gArr[ni] = g;
        cameFromArr[ni] = i;
        const f = g + HEURISTIC_WEIGHT * chebyshev3(nx, ny, nz, goalCx, goalCy, goalCz);
        open.push(ni, f);
      }
    }
  }

  let endI = goalI;
  if (!reached) {
    if (bestPartialNode < 0) return { cells: [], reached: false, expanded };
    endI = bestPartialNode;
  }

  const out: { cx: number; cy: number; cz: number }[] = [];
  let cur = endI;
  while (cur !== -1) {
    const cx = cur % VNAV_X;
    const tmp = (cur / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;
    out.push({ cx, cy, cz });
    if (cur === startI) break;
    if (ws.gen[cur] !== gen) break;
    cur = ws.cameFrom[cur]!;
  }
  out.reverse();
  return { cells: out, reached, expanded };
}

/**
 * 3D supercover line check: all cells touched by the line A→B (in volume cells) must be
 * passable for the requesting unit. Used by smoothPathVolume to collapse waypoints.
 */
function lineClearVolume(
  vnav: VolumeNavBuffers,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  canDig: boolean,
  requiresGround: boolean,
  footprintRadius: number,
): boolean {
  // Step in unit-cell steps, checking the closest cell at each.
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return true;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(ax + dx * t);
    const cy = Math.round(ay + dy * t);
    const cz = Math.round(az + dz * t);
    if (!footprintPassable(vnav, cx, cy, cz, canDig, requiresGround, footprintRadius, false)) return false;
  }
  return true;
}

/** Greedy line-of-sight reduction over a volume-cell path. */
export function smoothPathVolume(
  vnav: VolumeNavBuffers,
  cells: { cx: number; cy: number; cz: number }[],
  canDig: boolean,
  requiresGround: boolean,
  footprintRadius: number,
): { cx: number; cy: number; cz: number }[] {
  if (cells.length <= 2) return cells;
  const out: { cx: number; cy: number; cz: number }[] = [cells[0]!];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1) {
      const a = cells[i]!;
      const b = cells[j]!;
      if (lineClearVolume(vnav, a.cx, a.cy, a.cz, b.cx, b.cy, b.cz, canDig, requiresGround, footprintRadius)) break;
      j--;
    }
    out.push(cells[j]!);
    i = j;
  }
  return out;
}
