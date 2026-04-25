import { FourAryHeap } from '../util/Heap';
import {
  SurfaceNavBuffers, NAV_W, NAV_H, NAV_COUNT, navIndex, NAV_CELL_METERS,
  FLAT_TOLERANCE_VOXELS,
} from './SurfaceNav';

export interface AStarRequest {
  startCx: number; startCz: number;
  goalCx: number; goalCz: number;
  /** Cell-radius the unit needs in even terrain (e.g. 1 = single cell, 2 = 1.5m wide). */
  footprintRadius: number;
  /** Maximum step (voxels) the unit can climb between adjacent cells. Cliffs above this are impassable. */
  maxStepVoxels: number;
  /** Per-voxel-step cost coefficient — lets soldiers pay more for slope than tanks. */
  slopePenalty: number;
  /** If true, road cells are cheaper to traverse. */
  prefersRoads: boolean;
  /** Hard cap on expansions before bailing with partial path. */
  maxExpansions?: number;
}

export interface AStarResult {
  /** World-space waypoints in meters (including y from cell topY). */
  cells: { cx: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

// Diagonal+cardinal neighbor offsets and unit costs (octile).
const NB_DX = [ 1,-1, 0, 0,  1, 1,-1,-1];
const NB_DZ = [ 0, 0, 1,-1,  1,-1, 1,-1];
const NB_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

function octileH(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
  const m = Math.min(dx, dz), M = Math.max(dx, dz);
  return (M - m) + Math.SQRT2 * m;
}

/** Reusable workspace, allocated once per worker. */
export class AStarWorkspace {
  readonly gScore = new Float32Array(NAV_COUNT);
  readonly cameFrom = new Int32Array(NAV_COUNT);
  readonly closed = new Uint8Array(NAV_COUNT);
  readonly open = new FourAryHeap(2048);
  /** Generation marker so we can skip O(N) reset between queries. */
  readonly gen = new Int32Array(NAV_COUNT);
  private genTick = 0;

  resetGeneration(): number {
    this.genTick = (this.genTick + 1) | 0;
    if (this.genTick === 0) {
      // Wraparound — clear arrays once to be safe.
      this.gen.fill(0);
      this.genTick = 1;
    }
    this.open.clear();
    return this.genTick;
  }
}

export function findPathSurface(
  nav: SurfaceNavBuffers,
  ws: AStarWorkspace,
  req: AStarRequest,
): AStarResult {
  const gen = ws.resetGeneration();
  const { startCx, startCz, goalCx, goalCz, footprintRadius, prefersRoads, maxStepVoxels, slopePenalty } = req;
  const maxExpansions = req.maxExpansions ?? 20000;

  const startI = navIndex(startCx, startCz);
  const goalI = navIndex(goalCx, goalCz);

  if (nav.blocked[startI] || nav.blocked[goalI]) {
    return { cells: [], reached: false, expanded: 0 };
  }
  if (nav.flatness[goalI]! < footprintRadius) {
    return { cells: [], reached: false, expanded: 0 };
  }

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, octileH(startCx, startCz, goalCx, goalCz));

  let expanded = 0;
  let reached = false;
  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.closed[i] === gen) continue;
    ws.closed[i] = gen;
    expanded++;
    if (i === goalI) { reached = true; break; }
    if (expanded >= maxExpansions) break;

    const cx = i % NAV_W;
    const cz = (i / NAV_W) | 0;
    const cy = nav.topY[i]!;

    for (let n = 0; n < 8; n++) {
      const nx = cx + NB_DX[n]!;
      const nz = cz + NB_DZ[n]!;
      if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
      const ni = navIndex(nx, nz);
      if (ws.closed[ni] === gen) continue;
      if (nav.blocked[ni]) continue;
      if (nav.flatness[ni]! < footprintRadius) continue;
      // Step-up/down limit: bail on jumps the unit can't physically climb.
      const nyTop = nav.topY[ni]!;
      const dY = Math.abs(nyTop - cy);
      if (dY > maxStepVoxels) continue;

      // Diagonal corner cutting check: both adjacent cardinals must be passable.
      if (n >= 4) {
        const a = navIndex(cx + NB_DX[n]!, cz);
        const b = navIndex(cx, cz + NB_DZ[n]!);
        if (nav.blocked[a] || nav.blocked[b]) continue;
        if (nav.flatness[a]! < footprintRadius || nav.flatness[b]! < footprintRadius) continue;
      }

      let stepCost = NB_COST[n]!;
      // Slope penalty scales with the unit's tolerance — soldiers care more, tanks less.
      stepCost += dY * slopePenalty;
      // Road preference.
      if (prefersRoads) {
        const rw = nav.road[ni]! / 255;
        stepCost *= 1.0 - 0.6 * rw;
      }

      const g = (ws.gen[i] === gen ? ws.gScore[i]! : 0) + stepCost;
      const seen = ws.gen[ni] === gen;
      if (!seen || g < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = g;
        ws.cameFrom[ni] = i;
        const f = g + octileH(nx, nz, goalCx, goalCz);
        ws.open.push(ni, f);
      }
    }
  }

  // Reconstruct path (or partial path to whichever closed cell came nearest).
  let endI = goalI;
  if (!reached) {
    // Find the closed cell with smallest h to goal.
    let bestH = Infinity, best = -1;
    for (let i = 0; i < NAV_COUNT; i++) {
      if (ws.closed[i] !== gen) continue;
      const cx = i % NAV_W, cz = (i / NAV_W) | 0;
      const h = octileH(cx, cz, goalCx, goalCz);
      if (h < bestH) { bestH = h; best = i; }
    }
    if (best < 0) return { cells: [], reached: false, expanded };
    endI = best;
  }

  const out: { cx: number; cz: number }[] = [];
  let cur = endI;
  while (cur !== -1) {
    const cx = cur % NAV_W, cz = (cur / NAV_W) | 0;
    out.push({ cx, cz });
    if (cur === startI) break;
    if (ws.gen[cur] !== gen) break;
    cur = ws.cameFrom[cur]!;
  }
  out.reverse();
  return { cells: out, reached, expanded };
}

export { NAV_CELL_METERS };
