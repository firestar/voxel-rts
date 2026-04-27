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
  /** Required clear-air voxels above topY for the unit to fit (head/turret clearance).
   *  Cells whose `nav.headroom` is below this are rejected. */
  headroomVoxels: number;
  /** If true, road cells are cheaper to traverse. */
  prefersRoads: boolean;
  /**
   * Optional 32-bit seed used to perturb per-cell costs by a small amount. Different units
   * passed different seeds will pick noticeably different routes between the same endpoints.
   * Zero or undefined disables the jitter.
   */
  routeSeed?: number;
  /** Hard cap on expansions (combined across forward + backward) before bailing. */
  maxExpansions?: number;
  /**
   * Nav-cell indices treated as blocked by other (stationary) units for this query.
   * The start and goal cells are exempt — even if listed, they pass through so a unit
   * standing on top of a "blocked" cell can still leave it and a goal under another
   * unit can still be approached.
   */
  unitObstacles?: number[];
}

export interface AStarResult {
  /** World-space waypoints in meters (including y from cell topY). */
  cells: { cx: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

// Diagonal+cardinal neighbor offsets and unit costs (octile). Stored as flat
// typed arrays so the inner A* loop reads them as monomorphic indexed loads.
const NB_DX = new Int8Array([ 1,-1, 0, 0,  1, 1,-1,-1]);
const NB_DZ = new Int8Array([ 0, 0, 1,-1,  1,-1, 1,-1]);
const NB_COST = new Float32Array([1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2]);

export function bodyRoughnessOk(
  nav: SurfaceNavBuffers,
  cx: number, cz: number,
  halfCells: number,
  maxResidualVoxels: number,
): boolean {
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

/**
 * Memoised `bodyRoughnessOk`. The plane-fit predicate is expensive and called
 * repeatedly for the same cell during a single A* run (every neighbour edge
 * that lands on it triggers a recheck). The cache keys on the workspace
 * generation tick so it auto-invalidates between queries without an explicit
 * clear. Exported so the post-A* smoother can reuse the same cache (the
 * generation tick is still valid until the next `findPathSurface` call).
 */
export function cachedBodyRoughnessOk(
  nav: SurfaceNavBuffers,
  ws: AStarWorkspace,
  gen: number,
  cellIdx: number,
  cx: number, cz: number,
  halfCells: number, maxResidualVoxels: number,
): boolean {
  if (ws.roughnessGen[cellIdx] === gen) {
    return ws.roughnessCache[cellIdx] === 1;
  }
  const ok = bodyRoughnessOk(nav, cx, cz, halfCells, maxResidualVoxels);
  ws.roughnessGen[cellIdx] = gen;
  ws.roughnessCache[cellIdx] = ok ? 1 : 2;
  return ok;
}

function octileH(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
  const m = Math.min(dx, dz), M = Math.max(dx, dz);
  return (M - m) + Math.SQRT2 * m;
}

/**
 * Workspace for the bidirectional surface A*. We keep two of every per-cell state
 * (g-score, came-from, closed, generation) — one set for the forward search rooted
 * at start, one for the backward search rooted at goal. Heaps live here too so we
 * don't reallocate them per query.
 */
export class AStarWorkspace {
  // Forward (from start)
  readonly fG = new Float32Array(NAV_COUNT);
  readonly fCameFrom = new Int32Array(NAV_COUNT);
  readonly fClosed = new Uint8Array(NAV_COUNT);
  readonly fGen = new Int32Array(NAV_COUNT);
  readonly fOpen = new FourAryHeap(2048);
  // Backward (from goal)
  readonly bG = new Float32Array(NAV_COUNT);
  readonly bCameFrom = new Int32Array(NAV_COUNT);
  readonly bClosed = new Uint8Array(NAV_COUNT);
  readonly bGen = new Int32Array(NAV_COUNT);
  readonly bOpen = new FourAryHeap(2048);
  /**
   * Per-call mask of cells blocked by other units. Stamped in by `markUnitObstacles`
   * before each search and cleared on the next call. The smoother reads the same
   * buffer so post-pass shortcuts don't slice through a blocking peer.
   */
  readonly unitBlock = new Uint8Array(NAV_COUNT);
  /**
   * Memoised `bodyRoughnessOk` results for the current request. 0 = not yet
   * computed for this query, 1 = ok, 2 = rejected. Reset on every `resetGeneration`
   * by piggy-backing on the generation tick stored in `roughnessGen`. The roughness
   * test does a 2-pass plane fit over a (2k+1)² window of cells and is the
   * single most expensive predicate inside the inner loop; caching it cuts vehicle
   * pathfinding latency dramatically without changing routes.
   */
  readonly roughnessCache = new Uint8Array(NAV_COUNT);
  readonly roughnessGen = new Int32Array(NAV_COUNT);
  private unitBlockMarks: number[] = [];
  private genTick = 0;

  resetGeneration(): number {
    this.genTick = (this.genTick + 1) | 0;
    if (this.genTick === 0) {
      this.fGen.fill(0);
      this.bGen.fill(0);
      this.genTick = 1;
    }
    this.fOpen.clear();
    this.bOpen.clear();
    return this.genTick;
  }

  /** Latest generation tick from the most recent `resetGeneration`. The smoother
   *  uses this to share the roughness-cache from the just-finished A* search. */
  currentGen(): number { return this.genTick; }

  markUnitObstacles(indices: readonly number[] | undefined, exemptStart: number, exemptGoal: number): void {
    this.clearUnitObstacles();
    if (!indices) return;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]!;
      if (i === exemptStart || i === exemptGoal) continue;
      if (i < 0 || i >= NAV_COUNT) continue;
      if (this.unitBlock[i] === 0) {
        this.unitBlock[i] = 1;
        this.unitBlockMarks.push(i);
      }
    }
  }

  clearUnitObstacles(): void {
    for (let k = 0; k < this.unitBlockMarks.length; k++) {
      this.unitBlock[this.unitBlockMarks[k]!] = 0;
    }
    this.unitBlockMarks.length = 0;
  }
}


/**
 * Bidirectional, weighted-A* "cone" search. Forward and backward fronts each grow
 * outward from start and goal with a weighted heuristic (w * h(n, other-end)). The
 * weight tightens the explored fan into a cone shape pointed at the other side, and
 * we accept the *first* meeting as the route — no further searching.
 *
 *   forward fan ─┐    ┌─ backward fan
 *               🔵====🔵
 *
 * This is faster than admissible A* because the search doesn't keep expanding to
 * prove optimality; the trade-off is paths that may be slightly suboptimal in
 * convoluted terrain (a wider detour may exist). For RTS movement that's a great
 * trade — units find a workable route quickly and the visual is intuitive.
 *
 * Reconstruction concatenates the forward chain (start → meet) with the reversed
 * backward chain (meet → goal). The meet cell appears once.
 */
// Heuristic multiplier — values >1 narrow the search into cone shape. 1.0 is
// admissible A* (broad fan); 2.5 is a tight cone that may miss long detours.
// 2.0 trades a small amount of route optimality for noticeably fewer expanded
// cells per query — the visual difference between 1.5 and 2.0 paths on the
// production maps is minor, and the latency win matters when several units
// repath at once.
const HEURISTIC_WEIGHT = 2.0;
export function findPathSurface(
  nav: SurfaceNavBuffers,
  ws: AStarWorkspace,
  req: AStarRequest,
): AStarResult {
  const gen = ws.resetGeneration();
  const { startCx, startCz, goalCx, goalCz, prefersRoads, maxStepVoxels, slopePenalty,
          bodyHalfCells, bodyRoughnessVoxels, footprintRadius, headroomVoxels } = req;
  const routeSeed = req.routeSeed ?? 0;
  // Agile units (single-cell footprint) skip the diagonal corner-cut entirely —
  // a soldier can scramble around an inside corner where both cardinals are blocked
  // or too tall to climb, as long as the diagonal itself is climbable.
  const agile = footprintRadius <= 1;
  const maxExpansions = req.maxExpansions ?? 20000;

  const startI = navIndex(startCx, startCz);
  const goalI = navIndex(goalCx, goalCz);

  // Stamp the per-query unit-obstacle mask. Start and goal cells are always exempt
  // so a unit standing on a "blocked" cell can still leave it. Cleared at the end
  // of the search (and again at the start of the next one).
  ws.markUnitObstacles(req.unitObstacles, startI, goalI);

  if (nav.blocked[startI] || nav.blocked[goalI]) {
    return { cells: [], reached: false, expanded: 0 };
  }
  if (bodyHalfCells > 0
      && !bodyRoughnessOk(nav, goalCx, goalCz, bodyHalfCells, bodyRoughnessVoxels)) {
    return { cells: [], reached: false, expanded: 0 };
  }
  // Goal must have headroom for the unit to fit (head doesn't poke into a tree
  // canopy / building roof / overhang). Start cell is exempt — the unit may
  // already be standing on a borderline spot, e.g. just clipped under a tree.
  if (headroomVoxels > 0 && nav.headroom[goalI]! < headroomVoxels) {
    return { cells: [], reached: false, expanded: 0 };
  }
  if (startI === goalI) {
    return { cells: [{ cx: startCx, cz: startCz }], reached: true, expanded: 0 };
  }

  // Hoist nav buffers into locals so the tight loop reads from monomorphic
  // typed-array references instead of property-loading them on every iteration.
  const navTopY = nav.topY;
  const navBlocked = nav.blocked;
  const navRoad = nav.road;
  const navHeadroom = nav.headroom;
  const unitBlockMask = ws.unitBlock;
  const NAV_W_LOCAL = NAV_W;
  const NAV_H_LOCAL = NAV_H;

  // Forward init.
  ws.fG[startI] = 0;
  ws.fGen[startI] = gen;
  ws.fCameFrom[startI] = -1;
  ws.fOpen.push(startI, HEURISTIC_WEIGHT * octileH(startCx, startCz, goalCx, goalCz));
  // Backward init.
  ws.bG[goalI] = 0;
  ws.bGen[goalI] = gen;
  ws.bCameFrom[goalI] = -1;
  ws.bOpen.push(goalI, HEURISTIC_WEIGHT * octileH(goalCx, goalCz, startCx, startCz));

  let meetNode = -1;
  let expanded = 0;

  while (ws.fOpen.length > 0 && ws.bOpen.length > 0) {
    if (expanded >= maxExpansions) break;
    if (meetNode >= 0) break; // first connection wins

    // Expand the smaller-priority side so the two cones grow at comparable rates.
    const expandForward = ws.fOpen.topPriority() <= ws.bOpen.topPriority();
    const open = expandForward ? ws.fOpen : ws.bOpen;
    const myG = expandForward ? ws.fG : ws.bG;
    const myCameFrom = expandForward ? ws.fCameFrom : ws.bCameFrom;
    const myClosed = expandForward ? ws.fClosed : ws.bClosed;
    const myGen = expandForward ? ws.fGen : ws.bGen;
    const otherGen = expandForward ? ws.bGen : ws.fGen;
    const heuristicTargetCx = expandForward ? goalCx : startCx;
    const heuristicTargetCz = expandForward ? goalCz : startCz;

    const i = open.pop();
    if (myClosed[i] === gen) continue;
    myClosed[i] = gen;
    expanded++;

    // First meeting on pop: the other side has already settled this exact cell.
    if (otherGen[i] === gen) { meetNode = i; break; }

    const cx = i % NAV_W_LOCAL;
    const cz = (i / NAV_W_LOCAL) | 0;
    const cy = navTopY[i]!;
    const gI = myG[i]!;

    for (let n = 0; n < 8; n++) {
      const dx = NB_DX[n]!;
      const dz = NB_DZ[n]!;
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= NAV_W_LOCAL || nz >= NAV_H_LOCAL) continue;
      const ni = nz * NAV_W_LOCAL + nx;
      if (myClosed[ni] === gen) continue;
      if (navBlocked[ni]) continue;
      if (unitBlockMask[ni] === 1) continue;
      const nyTop = navTopY[ni]!;
      const dY = nyTop > cy ? nyTop - cy : cy - nyTop;
      if (dY > maxStepVoxels) continue;
      if (bodyHalfCells > 0 && !cachedBodyRoughnessOk(nav, ws, gen, ni, nx, nz, bodyHalfCells, bodyRoughnessVoxels)) continue;
      if (headroomVoxels > 0 && navHeadroom[ni]! < headroomVoxels) continue;
      if (n >= 4) {
        // Cardinals adjacent to the diagonal: (nx, cz) and (cx, nz). These are
        // the two cells the unit would brush past on the way through. We
        // already know nx/nz are in bounds, and cx/cz are too (this is the
        // current cell), so the cardinal indices are always valid.
        const a = cz * NAV_W_LOCAL + nx;
        const b = nz * NAV_W_LOCAL + cx;
        const aBlocked = navBlocked[a]! === 1 || unitBlockMask[a] === 1;
        const bBlocked = navBlocked[b]! === 1 || unitBlockMask[b] === 1;
        if (aBlocked && bBlocked) continue;
        if (!agile) {
          // Vehicles also need at least one cardinal both passable AND within the
          // climb step — they can't squeeze through a wall corner.
          let aOk = !aBlocked;
          if (aOk) {
            const ay = navTopY[a]!;
            const ad = ay > cy ? ay - cy : cy - ay;
            if (ad > maxStepVoxels) aOk = false;
          }
          let bOk = !bBlocked;
          if (bOk) {
            const by = navTopY[b]!;
            const bd = by > cy ? by - cy : cy - by;
            if (bd > maxStepVoxels) bOk = false;
          }
          if (!aOk && !bOk) continue;
        }
      }

      // Edge cost — inlined so the per-request flags hoist out of branches:
      //   base + dY * slopePenalty
      //   * (road discount if prefersRoads && either endpoint is a road)
      //   + jitter (if routeSeed != 0)
      let cost = NB_COST[n]! + dY * slopePenalty;
      if (prefersRoads) {
        const rwA = navRoad[i]!;
        const rwB = navRoad[ni]!;
        const rw = (rwA > rwB ? rwA : rwB) * (1 / 255);
        cost *= 1.0 - 0.6 * rw;
      }
      if (routeSeed !== 0) {
        const lo = i < ni ? i : ni;
        const hi = i < ni ? ni : i;
        const h = ((Math.imul(lo, 0x9e3779b9) ^ Math.imul(hi, 0x85ebca6b) ^ routeSeed) >>> 0);
        cost += ((h & 0xff) * (1 / 255) - 0.5) * 0.6;
      }

      const g = gI + cost;
      const seen = myGen[ni] === gen;
      if (!seen || g < myG[ni]!) {
        myGen[ni] = gen;
        myG[ni] = g;
        myCameFrom[ni] = i;
        const f = g + HEURISTIC_WEIGHT * octileH(nx, nz, heuristicTargetCx, heuristicTargetCz);
        open.push(ni, f);

        // First meeting on relaxation: the other side has already settled this cell.
        // Take it immediately — this is the user-visible "first connection wins" rule.
        if (otherGen[ni] === gen) { meetNode = ni; break; }
      }
    }
  }

  if (meetNode < 0) {
    return { cells: [], reached: false, expanded };
  }

  // Reconstruct: walk forward chain from meet → start (then reverse), append backward
  // chain meet → goal (excluding meet itself which was already pushed).
  const forwardCells: { cx: number; cz: number }[] = [];
  for (let cur = meetNode; cur !== -1; cur = ws.fCameFrom[cur]!) {
    forwardCells.push({ cx: cur % NAV_W, cz: (cur / NAV_W) | 0 });
    if (cur === startI) break;
    if (ws.fGen[cur] !== gen) {
      // Forward chain doesn't reach the start — search met but couldn't reconstruct
      // forward. Shouldn't happen in practice; bail out cleanly.
      return { cells: [], reached: false, expanded };
    }
  }
  forwardCells.reverse();
  const backwardCells: { cx: number; cz: number }[] = [];
  for (let cur = ws.bCameFrom[meetNode]!; cur !== -1; cur = ws.bCameFrom[cur]!) {
    backwardCells.push({ cx: cur % NAV_W, cz: (cur / NAV_W) | 0 });
    if (cur === goalI) break;
    if (ws.bGen[cur] !== gen) {
      return { cells: [], reached: false, expanded };
    }
  }
  return { cells: [...forwardCells, ...backwardCells], reached: true, expanded };
}

export { NAV_CELL_METERS, FLAT_TOLERANCE_VOXELS };
