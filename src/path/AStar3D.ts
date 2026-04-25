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
  /** Hard cap on expansions before bailing with partial path. */
  maxExpansions?: number;
}

export interface AStar3DResult {
  cells: { cx: number; cy: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

const NB26: { dx: number; dy: number; dz: number; cost: number }[] = (() => {
  const out: { dx: number; dy: number; dz: number; cost: number }[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const k = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
        const cost = k === 1 ? 1 : k === 2 ? Math.SQRT2 : Math.sqrt(3);
        out.push({ dx, dy, dz, cost });
      }
    }
  }
  return out;
})();

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

export function findPathVolume(
  vnav: VolumeNavBuffers,
  ws: AStar3DWorkspace,
  req: AStar3DRequest,
): AStar3DResult {
  const gen = ws.resetGeneration();
  const { startCx, startCy, startCz, goalCx, goalCy, goalCz, canDig, requiresGround, footprintRadius } = req;
  const maxExpansions = req.maxExpansions ?? 8000;

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
  ws.open.push(startI, chebyshev3(startCx, startCy, startCz, goalCx, goalCy, goalCz));

  let expanded = 0;
  let reached = false;
  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.closed[i] === gen) continue;
    ws.closed[i] = gen;
    expanded++;
    if (i === goalI) { reached = true; break; }
    if (expanded >= maxExpansions) break;

    const cx = i % VNAV_X;
    const tmp = (i / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;

    for (let n = 0; n < NB26.length; n++) {
      const off = NB26[n]!;
      const nx = cx + off.dx;
      const ny = cy + off.dy;
      const nz = cz + off.dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= VNAV_X || ny >= VNAV_Y || nz >= VNAV_Z) continue;
      const ni = vnavIndex(nx, ny, nz);
      if (ws.closed[ni] === gen) continue;
      if (!footprintPassable(vnav, nx, ny, nz, canDig, requiresGround, footprintRadius, ni === goalI)) continue;

      let stepCost = off.cost;
      const isSolid = getBit(vnav.solid, ni);
      if (isSolid) {
        stepCost += vnav.digCost[ni]!;
      }

      const g = ws.gScore[i]! + stepCost;
      const seen = ws.gen[ni] === gen;
      if (!seen || g < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = g;
        ws.cameFrom[ni] = i;
        const f = g + chebyshev3(nx, ny, nz, goalCx, goalCy, goalCz);
        ws.open.push(ni, f);
      }
    }
  }

  let endI = goalI;
  if (!reached) {
    let bestH = Infinity, best = -1;
    for (let i = 0; i < VNAV_COUNT; i++) {
      if (ws.closed[i] !== gen) continue;
      const cx = i % VNAV_X;
      const tmp = (i / VNAV_X) | 0;
      const cz = tmp % VNAV_Z;
      const cy = (tmp / VNAV_Z) | 0;
      const h = chebyshev3(cx, cy, cz, goalCx, goalCy, goalCz);
      if (h < bestH) { bestH = h; best = i; }
    }
    if (best < 0) return { cells: [], reached: false, expanded };
    endI = best;
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
