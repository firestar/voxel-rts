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
  /** Half-extent in nav cells of the unit's body footprint (0 = single cell, no check). */
  bodyHalfCells: number;
  /** Max permitted spread of topY across the footprint cells, in voxels. */
  bodyRoughnessVoxels: number;
  /** If true, road cells are cheaper to traverse. */
  prefersRoads: boolean;
  /**
   * Optional 32-bit seed used to perturb per-cell costs by a small amount. Different units
   * passed different seeds will pick noticeably different routes between the same endpoints.
   * Zero or undefined disables the jitter.
   */
  routeSeed?: number;
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

/**
 * Sample topY across a (2*halfCells+1)² square centered on (cx, cz), fit a least-squares
 * plane to those samples, and return whether every cell's residual from that plane stays
 * within `maxResidualVoxels`. Out-of-bounds or blocked cells in the footprint also fail.
 *
 * This passes uniform slopes (the unit can sit on a tilted hill) and rejects bumps, steps,
 * and ridges that span the body — which is the actual physics we want for a vehicle's
 * chassis. The previous max-min range version was over-eager: every steep slope failed.
 */
export function bodyRoughnessOk(
  nav: SurfaceNavBuffers,
  cx: number, cz: number,
  halfCells: number,
  maxResidualVoxels: number,
): boolean {
  // For a centered symmetric square, the cross-term sum(dx*dz) is 0 and sum(dx) = sum(dz) = 0,
  // so the least-squares plane decouples: y_pred = a*dx + b*dz + c, with c = mean(y),
  // a = sum(dx*y) / sum(dx²), b = sum(dz*y) / sum(dz²).
  let sumY = 0;
  let sumDxY = 0, sumDzY = 0;
  let sumDx2 = 0, sumDz2 = 0;
  let n = 0;
  for (let dz = -halfCells; dz <= halfCells; dz++) {
    const z = cz + dz;
    if (z < 0 || z >= NAV_H) return false;
    for (let dx = -halfCells; dx <= halfCells; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= NAV_W) return false;
      const i = navIndex(x, z);
      if (nav.blocked[i]) return false;
      const y = nav.topY[i]!;
      sumY += y;
      sumDxY += dx * y;
      sumDzY += dz * y;
      sumDx2 += dx * dx;
      sumDz2 += dz * dz;
      n++;
    }
  }
  if (n === 0) return false;
  const meanY = sumY / n;
  const a = sumDx2 > 0 ? sumDxY / sumDx2 : 0;
  const b = sumDz2 > 0 ? sumDzY / sumDz2 : 0;

  // Second pass: check residuals against the fitted plane.
  for (let dz = -halfCells; dz <= halfCells; dz++) {
    for (let dx = -halfCells; dx <= halfCells; dx++) {
      const i = navIndex(cx + dx, cz + dz);
      const y = nav.topY[i]!;
      const pred = a * dx + b * dz + meanY;
      if (Math.abs(y - pred) > maxResidualVoxels) return false;
    }
  }
  return true;
}

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
  const { startCx, startCz, goalCx, goalCz, prefersRoads, maxStepVoxels, slopePenalty,
          bodyHalfCells, bodyRoughnessVoxels } = req;
  const routeSeed = req.routeSeed ?? 0;
  void req.footprintRadius; // currently used only by building placement; surface pathing uses climb-step alone
  const maxExpansions = req.maxExpansions ?? 20000;

  const startI = navIndex(startCx, startCz);
  const goalI = navIndex(goalCx, goalCz);

  if (nav.blocked[startI] || nav.blocked[goalI]) {
    return { cells: [], reached: false, expanded: 0 };
  }
  // Goal must satisfy the body-roughness check too; no point pathing somewhere the
  // unit can't actually park.
  if (req.bodyHalfCells > 0
      && !bodyRoughnessOk(nav, goalCx, goalCz, req.bodyHalfCells, req.bodyRoughnessVoxels)) {
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
      // Step-up/down limit: bail on jumps the unit can't physically climb.
      const nyTop = nav.topY[ni]!;
      const dY = Math.abs(nyTop - cy);
      if (dY > maxStepVoxels) continue;

      // Body-roughness gate: the spread of topY across the unit's footprint area must
      // stay under bodyRoughnessVoxels, otherwise the cell would have the unit straddling
      // a ledge / step / boulder. Soldiers (bodyHalfCells = 0) skip this check.
      if (bodyHalfCells > 0 && !bodyRoughnessOk(nav, nx, nz, bodyHalfCells, bodyRoughnessVoxels)) continue;

      // Diagonal corner cutting: at least one adjacent cardinal must be passable
      // (not blocked) AND within the unit's climb limit. The far diagonal is otherwise
      // a "squeeze through a wall" move which we still want to forbid.
      if (n >= 4) {
        const a = navIndex(cx + NB_DX[n]!, cz);
        const b = navIndex(cx, cz + NB_DZ[n]!);
        if (nav.blocked[a] && nav.blocked[b]) continue;
        const aOk = !nav.blocked[a] && Math.abs(nav.topY[a]! - cy) <= maxStepVoxels;
        const bOk = !nav.blocked[b] && Math.abs(nav.topY[b]! - cy) <= maxStepVoxels;
        if (!aOk && !bOk) continue;
      }

      let stepCost = NB_COST[n]!;
      // Slope penalty scales with the unit's tolerance — soldiers care more, tanks less.
      stepCost += dY * slopePenalty;
      // Road preference.
      if (prefersRoads) {
        const rw = nav.road[ni]! / 255;
        stepCost *= 1.0 - 0.6 * rw;
      }
      // Per-cell deterministic jitter keyed by routeSeed — different units passed
      // different seeds explore the map along different routes instead of all funneling
      // through the single A*-shortest line.
      if (routeSeed !== 0) {
        const h = ((Math.imul(ni, 0x9e3779b9) ^ routeSeed) >>> 0);
        const jitter = ((h & 0xff) / 255 - 0.5) * 0.6; // ±0.3 cost units
        stepCost += jitter;
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
