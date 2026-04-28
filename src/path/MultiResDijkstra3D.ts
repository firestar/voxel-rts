import { FourAryHeap } from '../util/Heap';
import {
  VolumeNavBuffers, vnavIndex, getBit,
  VNAV_X, VNAV_Y, VNAV_Z, VNAV_COUNT,
} from './VolumeNav';
import {
  MultiResNav3D, ResLevel3D, MAX_PLANES_PER_CELL,
  superCellIndex, baseCellPlane,
} from './MultiResNav3D';

export interface MR3DRequest {
  startCx: number; startCy: number; startCz: number;
  goalCx: number;  goalCy: number;  goalCz: number;
  canDig: boolean;
  requiresGround: boolean;
  /** Per-level corridor widening, in super-cells at the level being widened. Default 1. */
  corridorWiden?: number;
  /** Hard cap on expansions across all levels. Default 50_000. */
  maxExpansions?: number;
}

export interface MR3DResult {
  /** Base-cell path, start → goal. Empty if !reached. */
  cells: { cx: number; cy: number; cz: number }[];
  reached: boolean;
  /** Expansions per level, ordered coarsest → base. Same length as mr.factors. */
  expandedPerLevel: number[];
  totalExpanded: number;
}

// 26-neighbor offsets and step costs. Inlined here so the inner Dijkstra loop
// reads from monomorphic typed-array slots — duplicates the table in
// src/path/AStar3D.ts deliberately to avoid a cross-module import.
const NB26_DX = new Int8Array(26);
const NB26_DY = new Int8Array(26);
const NB26_DZ = new Int8Array(26);
const NB26_COST = new Float32Array(26);
{
  let k = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dim = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
        const cost = dim === 1 ? 1 : dim === 2 ? Math.SQRT2 : Math.sqrt(3);
        NB26_DX[k] = dx; NB26_DY[k] = dy; NB26_DZ[k] = dz; NB26_COST[k] = cost;
        k++;
      }
    }
  }
}
const NB26_LEN = 26;

/**
 * Per-coarse-level Dijkstra workspace. Allocated lazily and grown on demand
 * (a single workspace3D may serve multiple maps with different level shapes).
 * The generation tick lets us avoid full clears between calls.
 */
interface CoarseScratch {
  capacity: number;
  g: Float32Array;
  came: Int32Array;
  closed: Uint8Array;
  gen: Int32Array;
}

function makeCoarseScratch(capacity: number): CoarseScratch {
  return {
    capacity,
    g: new Float32Array(capacity),
    came: new Int32Array(capacity),
    closed: new Uint8Array(capacity),
    gen: new Int32Array(capacity),
  };
}

export class MultiResWorkspace3D {
  private genTick = 0;
  /** Per-level scratch; index into mr.levels[]. */
  private coarseScratch: (CoarseScratch | null)[] = [];
  readonly heap = new FourAryHeap(4096);

  // Base-level (factor=1) Dijkstra arrays — sized to VNAV_COUNT once.
  readonly baseG = new Float32Array(VNAV_COUNT);
  readonly baseCame = new Int32Array(VNAV_COUNT);
  readonly baseClosed = new Uint8Array(VNAV_COUNT);
  readonly baseGen = new Int32Array(VNAV_COUNT);

  // Corridor masks. corridorBase is bit-byte (1 byte per base cell).
  // corridorCoarse is grown to the largest level.count we encounter.
  readonly corridorBase = new Uint8Array(VNAV_COUNT);
  private corridorCoarseCap = 0;
  private corridorCoarseBuf: Uint8Array = new Uint8Array(0);
  private corridorTmpBuf: Uint8Array = new Uint8Array(0);

  resetGeneration(): number {
    this.genTick = (this.genTick + 1) | 0;
    if (this.genTick === 0) {
      // Wrap — full clear so stale gen ticks don't false-match.
      for (let i = 0; i < this.coarseScratch.length; i++) {
        const s = this.coarseScratch[i];
        if (s) s.gen.fill(0);
      }
      this.baseGen.fill(0);
      this.genTick = 1;
    }
    this.heap.clear();
    return this.genTick;
  }

  currentGen(): number { return this.genTick; }

  scratchForLevel(levelIdx: number, capacity: number): CoarseScratch {
    let s = this.coarseScratch[levelIdx] ?? null;
    if (s === null || s.capacity < capacity) {
      s = makeCoarseScratch(capacity);
      this.coarseScratch[levelIdx] = s;
    }
    return s;
  }

  coarseCorridor(count: number): Uint8Array {
    if (this.corridorCoarseCap < count) {
      this.corridorCoarseCap = count;
      this.corridorCoarseBuf = new Uint8Array(count);
      this.corridorTmpBuf = new Uint8Array(count);
    } else {
      this.corridorCoarseBuf.fill(0, 0, count);
    }
    return this.corridorCoarseBuf;
  }

  coarseCorridorTmp(count: number): Uint8Array {
    // coarseCorridor() must be called first; tmp shares its sizing.
    if (this.corridorTmpBuf.length < count) this.corridorTmpBuf = new Uint8Array(count);
    else this.corridorTmpBuf.fill(0, 0, count);
    return this.corridorTmpBuf;
  }
}

function inBoundsBase(cx: number, cy: number, cz: number): boolean {
  return cx >= 0 && cy >= 0 && cz >= 0 && cx < VNAV_X && cy < VNAV_Y && cz < VNAV_Z;
}

function cellPassable(
  vnav: VolumeNavBuffers,
  cx: number, cy: number, cz: number,
  canDig: boolean, requiresGround: boolean,
  isStartOrGoal: boolean, gateSealedCaves: boolean,
): boolean {
  if (!inBoundsBase(cx, cy, cz)) return false;
  const i = vnavIndex(cx, cy, cz);
  if (getBit(vnav.bedrock, i)) return false;
  const solid = getBit(vnav.solid, i) === 1;
  if (solid && !canDig) return false;
  if (!solid && requiresGround && !isStartOrGoal) {
    if (cy === 0) return false;
    if (getBit(vnav.solid, vnavIndex(cx, cy - 1, cz)) !== 1) return false;
  }
  if (gateSealedCaves && !solid && !isStartOrGoal && getBit(vnav.surfaceConnected, i) === 0) return false;
  return true;
}

/** Map a base cell to its super-cell index at a given coarse level. */
function baseToSuper(level: ResLevel3D, cx: number, cy: number, cz: number): number {
  const f = level.factor;
  const sx = (cx / f) | 0;
  const sy = (cy / f) | 0;
  const sz = (cz / f) | 0;
  return superCellIndex(level, sx, sy, sz);
}

/** Run Dijkstra over (cellIdx, planeIdx) pairs at one coarse level. corridor
 *  is null for unrestricted, or a Uint8Array of length level.count where 1 = allowed. */
function runCoarseDijkstra(
  ws: MultiResWorkspace3D,
  levelIdx: number,
  level: ResLevel3D,
  startCellIdx: number, startPlaneIdx: number,
  goalCellIdx: number, goalPlaneIdx: number,
  corridor: Uint8Array | null,
  remainingExpansions: number,
): { reached: boolean; chain: { cellIdx: number; planeIdx: number }[]; expanded: number } {
  const capacity = level.count * MAX_PLANES_PER_CELL;
  const scratch = ws.scratchForLevel(levelIdx, capacity);
  const gen = ws.resetGeneration();
  const heap = ws.heap;
  const startNode = startCellIdx * MAX_PLANES_PER_CELL + startPlaneIdx;
  const goalNode = goalCellIdx * MAX_PLANES_PER_CELL + goalPlaneIdx;

  if (corridor !== null && corridor[startCellIdx] !== 1) {
    return { reached: false, chain: [], expanded: 0 };
  }
  if (corridor !== null && corridor[goalCellIdx] !== 1) {
    return { reached: false, chain: [], expanded: 0 };
  }

  scratch.g[startNode] = 0;
  scratch.came[startNode] = -1;
  scratch.gen[startNode] = gen;
  heap.push(startNode, 0);

  let expanded = 0;
  let reached = false;

  while (heap.length > 0) {
    if (expanded >= remainingExpansions) break;
    const node = heap.pop();
    if (scratch.closed[node] === gen) continue;
    scratch.closed[node] = gen;
    expanded++;
    if (node === goalNode) { reached = true; break; }

    const cellIdx = (node / MAX_PLANES_PER_CELL) | 0;
    const planeIdx = node - cellIdx * MAX_PLANES_PER_CELL;
    const cell = level.cells[cellIdx]!;
    const gHere = scratch.g[node]!;

    const edges = cell.edges;
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e]!;
      if (edge.localPlaneIdx !== planeIdx) continue;
      const nCellIdx = edge.neighbourCellIdx;
      if (corridor !== null && corridor[nCellIdx] !== 1) continue;
      const nNode = nCellIdx * MAX_PLANES_PER_CELL + edge.neighbourPlaneIdx;
      if (scratch.closed[nNode] === gen) continue;
      const ng = gHere + edge.cost;
      const seen = scratch.gen[nNode] === gen;
      if (!seen || ng < scratch.g[nNode]!) {
        scratch.gen[nNode] = gen;
        scratch.g[nNode] = ng;
        scratch.came[nNode] = node;
        heap.push(nNode, ng);
      }
    }
  }

  if (!reached) return { reached: false, chain: [], expanded };

  const chain: { cellIdx: number; planeIdx: number }[] = [];
  let cur = goalNode;
  // Bound the walk by capacity to defend against any pathological loop.
  for (let safety = 0; safety < capacity; safety++) {
    const cellIdx = (cur / MAX_PLANES_PER_CELL) | 0;
    const planeIdx = cur - cellIdx * MAX_PLANES_PER_CELL;
    chain.push({ cellIdx, planeIdx });
    if (cur === startNode) break;
    if (scratch.gen[cur] !== gen) break;
    cur = scratch.came[cur]!;
    if (cur < 0) break;
  }
  chain.reverse();
  return { reached: true, chain, expanded };
}

/** Stamp + dilate a coarse corridor at level k-1 from the chain at level k. */
function stampCoarseCorridor(
  ws: MultiResWorkspace3D,
  finer: ResLevel3D,
  coarser: ResLevel3D,
  chain: readonly { cellIdx: number; planeIdx: number }[],
  widen: number,
): Uint8Array {
  const mask = ws.coarseCorridor(finer.count);
  const ratio = (coarser.factor / finer.factor) | 0;
  if (ratio < 1) {
    // Defensive: shouldn't happen since factors are monotonic, but if it does
    // mark every finer cell so the search can still proceed.
    mask.fill(1, 0, finer.count);
    return mask;
  }
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]!.cellIdx;
    const csx = c % coarser.w;
    const tmp = (c / coarser.w) | 0;
    const csz = tmp % coarser.d;
    const csy = (tmp / coarser.d) | 0;
    // Children of this coarser cell at the finer level: a ratio³ block
    // anchored at (csx*ratio, csy*ratio, csz*ratio).
    const fx0 = csx * ratio;
    const fy0 = csy * ratio;
    const fz0 = csz * ratio;
    const fx1 = Math.min(finer.w, fx0 + ratio);
    const fy1 = Math.min(finer.h, fy0 + ratio);
    const fz1 = Math.min(finer.d, fz0 + ratio);
    for (let fy = fy0; fy < fy1; fy++) {
      for (let fz = fz0; fz < fz1; fz++) {
        const rowBase = (fy * finer.d + fz) * finer.w;
        for (let fx = fx0; fx < fx1; fx++) {
          mask[rowBase + fx] = 1;
        }
      }
    }
  }
  // Dilate by `widen` super-cells at the finer level. One pass per widen step.
  for (let step = 0; step < widen; step++) {
    const tmp = ws.coarseCorridorTmp(finer.count);
    tmp.set(mask);
    for (let sy = 0; sy < finer.h; sy++) {
      for (let sz = 0; sz < finer.d; sz++) {
        const rowBase = (sy * finer.d + sz) * finer.w;
        for (let sx = 0; sx < finer.w; sx++) {
          if (tmp[rowBase + sx] !== 1) continue;
          // Mark 6 cardinal neighbours.
          if (sx > 0)            mask[rowBase + sx - 1] = 1;
          if (sx + 1 < finer.w)  mask[rowBase + sx + 1] = 1;
          if (sz > 0)            mask[rowBase + sx - finer.w] = 1;
          if (sz + 1 < finer.d)  mask[rowBase + sx + finer.w] = 1;
          if (sy > 0)            mask[rowBase + sx - finer.d * finer.w] = 1;
          if (sy + 1 < finer.h)  mask[rowBase + sx + finer.d * finer.w] = 1;
        }
      }
    }
  }
  return mask;
}

/** Stamp the base-level corridor mask (size VNAV_COUNT) from the level-1 chain. */
function stampBaseCorridor(
  ws: MultiResWorkspace3D,
  level1: ResLevel3D,
  chain: readonly { cellIdx: number; planeIdx: number }[],
  widen: number,
): Uint8Array {
  const mask = ws.corridorBase;
  mask.fill(0);
  const f = level1.factor;
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]!.cellIdx;
    const csx = c % level1.w;
    const tmp = (c / level1.w) | 0;
    const csz = tmp % level1.d;
    const csy = (tmp / level1.d) | 0;
    const x0 = csx * f, y0 = csy * f, z0 = csz * f;
    const x1 = Math.min(VNAV_X, x0 + f);
    const y1 = Math.min(VNAV_Y, y0 + f);
    const z1 = Math.min(VNAV_Z, z0 + f);
    for (let cy = y0; cy < y1; cy++) {
      for (let cz = z0; cz < z1; cz++) {
        const rowBase = (cy * VNAV_Z + cz) * VNAV_X;
        for (let cx = x0; cx < x1; cx++) {
          mask[rowBase + cx] = 1;
        }
      }
    }
  }
  // Widen at the level-1 super-cell granularity by extending each box by `widen`
  // super-cells in each cardinal direction. Implemented inline rather than a
  // 6-neighbour dilation pass so a single call extends by `widen * f` base cells
  // — keeps the corridor wide enough that the base Dijkstra has slack to wiggle.
  if (widen > 0) {
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]!.cellIdx;
      const csx = c % level1.w;
      const tmp = (c / level1.w) | 0;
      const csz = tmp % level1.d;
      const csy = (tmp / level1.d) | 0;
      const x0 = Math.max(0, (csx - widen) * f);
      const y0 = Math.max(0, (csy - widen) * f);
      const z0 = Math.max(0, (csz - widen) * f);
      const x1 = Math.min(VNAV_X, (csx + widen + 1) * f);
      const y1 = Math.min(VNAV_Y, (csy + widen + 1) * f);
      const z1 = Math.min(VNAV_Z, (csz + widen + 1) * f);
      for (let cy = y0; cy < y1; cy++) {
        for (let cz = z0; cz < z1; cz++) {
          const rowBase = (cy * VNAV_Z + cz) * VNAV_X;
          for (let cx = x0; cx < x1; cx++) {
            mask[rowBase + cx] = 1;
          }
        }
      }
    }
  }
  return mask;
}

/** Base-level Dijkstra over 26-connected base cells, optionally restricted to a corridor. */
function runBaseDijkstra(
  vnav: VolumeNavBuffers,
  ws: MultiResWorkspace3D,
  startI: number, goalI: number,
  startCx: number, startCy: number, startCz: number,
  goalCx: number, goalCy: number, goalCz: number,
  canDig: boolean, requiresGround: boolean,
  corridor: Uint8Array | null,
  remainingExpansions: number,
): { reached: boolean; cells: { cx: number; cy: number; cz: number }[]; expanded: number } {
  const gen = ws.resetGeneration();
  const heap = ws.heap;
  const g = ws.baseG;
  const came = ws.baseCame;
  const closed = ws.baseClosed;
  const genArr = ws.baseGen;

  const startSurface = getBit(vnav.solid, startI) === 0
    ? getBit(vnav.surfaceConnected, startI) === 1
    : true;
  const goalSurface = getBit(vnav.solid, goalI) === 0
    ? getBit(vnav.surfaceConnected, goalI) === 1
    : true;
  const gateSealedCaves = startSurface && goalSurface;

  if (!cellPassable(vnav, goalCx, goalCy, goalCz, canDig, requiresGround, true, gateSealedCaves)) {
    return { reached: false, cells: [], expanded: 0 };
  }

  g[startI] = 0;
  came[startI] = -1;
  genArr[startI] = gen;
  heap.push(startI, 0);

  let expanded = 0;
  let reached = false;

  // Hoist for the inner loop.
  const vnavSolid = vnav.solid;
  const vnavDigCost = vnav.digCost;

  while (heap.length > 0) {
    if (expanded >= remainingExpansions) break;
    const i = heap.pop();
    if (closed[i] === gen) continue;
    closed[i] = gen;
    expanded++;
    if (i === goalI) { reached = true; break; }

    const cx = i % VNAV_X;
    const tmp = (i / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;
    const gI = g[i]!;

    for (let n = 0; n < NB26_LEN; n++) {
      const dx = NB26_DX[n]!;
      const dy = NB26_DY[n]!;
      const dz = NB26_DZ[n]!;
      const nx = cx + dx, ny = cy + dy, nz = cz + dz;
      if (!inBoundsBase(nx, ny, nz)) continue;
      const ni = (ny * VNAV_Z + nz) * VNAV_X + nx;
      if (closed[ni] === gen) continue;
      if (corridor !== null && corridor[ni] !== 1) continue;
      const isGoal = ni === goalI;
      if (!cellPassable(vnav, nx, ny, nz, canDig, requiresGround, isGoal, gateSealedCaves)) continue;

      let stepCost = NB26_COST[n]!;
      const isSolid = (vnavSolid[ni >> 3]! >> (ni & 7)) & 1;
      if (isSolid) stepCost += vnavDigCost[ni]!;

      const ng = gI + stepCost;
      const seen = genArr[ni] === gen;
      if (!seen || ng < g[ni]!) {
        genArr[ni] = gen;
        g[ni] = ng;
        came[ni] = i;
        heap.push(ni, ng);
      }
    }
  }

  if (!reached) return { reached: false, cells: [], expanded };

  const cells: { cx: number; cy: number; cz: number }[] = [];
  let cur = goalI;
  for (let safety = 0; safety < VNAV_COUNT; safety++) {
    const cx = cur % VNAV_X;
    const tmp = (cur / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;
    cells.push({ cx, cy, cz });
    if (cur === startI) break;
    if (genArr[cur] !== gen) break;
    cur = came[cur]!;
    if (cur < 0) break;
  }
  cells.reverse();
  return { reached: true, cells, expanded };
}

/**
 * Multi-resolution Dijkstra. Coarsest-first level walk; each level produces a
 * (cell, plane) chain that stamps the next finer level's corridor mask. Base
 * level (factor=1) uses a 26-connected Dijkstra over `VolumeNavBuffers`
 * restricted to the corridor.
 *
 * If a level fails to reach inside the corridor we retry that level WITHOUT
 * the corridor — same fallback the production worker uses for 2D corridors
 * (see `path.worker.ts:85-89`).
 */
export function findPathMultiRes3D(
  vnav: VolumeNavBuffers,
  mr: MultiResNav3D,
  ws: MultiResWorkspace3D,
  req: MR3DRequest,
): MR3DResult {
  const widen = req.corridorWiden ?? 1;
  let remaining = req.maxExpansions ?? 50000;
  const expandedPerLevel = new Array<number>(mr.factors.length).fill(0);

  if (!inBoundsBase(req.startCx, req.startCy, req.startCz)) {
    return { cells: [], reached: false, expandedPerLevel, totalExpanded: 0 };
  }
  if (!inBoundsBase(req.goalCx, req.goalCy, req.goalCz)) {
    return { cells: [], reached: false, expandedPerLevel, totalExpanded: 0 };
  }
  const startI = vnavIndex(req.startCx, req.startCy, req.startCz);
  const goalI = vnavIndex(req.goalCx, req.goalCy, req.goalCz);
  if (startI === goalI) {
    return {
      cells: [{ cx: req.startCx, cy: req.startCy, cz: req.startCz }],
      reached: true, expandedPerLevel, totalExpanded: 0,
    };
  }

  // Walk coarse levels top-down (skip level 0). Each iteration produces a
  // chain at the current level and stamps a corridor for the next finer level.
  let chainAtFinerLevel: { cellIdx: number; planeIdx: number }[] | null = null;
  let chainLevelIdx = -1;

  for (let li = mr.factors.length - 1; li >= 1; li--) {
    const level = mr.levels[li]!;

    const startSCellIdx = baseToSuper(level, req.startCx, req.startCy, req.startCz);
    const goalSCellIdx = baseToSuper(level, req.goalCx, req.goalCy, req.goalCz);
    const startPlane = baseCellPlane(level, req.startCx, req.startCy, req.startCz);
    const goalPlane = baseCellPlane(level, req.goalCx, req.goalCy, req.goalCz);
    if (startPlane < 0 || goalPlane < 0) {
      // Start or goal isn't air at this level (e.g. solid cell). Skip the
      // coarse search at this level — leave any prior corridor in place. The
      // base level's Dijkstra still respects canDig and will dig if allowed.
      continue;
    }

    let corridor: Uint8Array | null = null;
    if (chainAtFinerLevel !== null) {
      // The "finer level" data we computed last iteration is actually coarser
      // than this level (we walk top-down). Stamp this level's corridor from it.
      const coarser = mr.levels[chainLevelIdx]!;
      corridor = stampCoarseCorridor(ws, level, coarser, chainAtFinerLevel, widen);
    }

    let res = runCoarseDijkstra(
      ws, li, level,
      startSCellIdx, startPlane,
      goalSCellIdx, goalPlane,
      corridor, remaining,
    );
    expandedPerLevel[mr.factors.length - 1 - li] += res.expanded;
    remaining -= res.expanded;
    if (remaining <= 0) {
      return { cells: [], reached: false, expandedPerLevel, totalExpanded: sum(expandedPerLevel) };
    }
    if (!res.reached && corridor !== null) {
      // Corridor too tight for the planar connectivity at this level — retry
      // unrestricted, mirroring the fallback in path.worker.ts:85-89.
      res = runCoarseDijkstra(
        ws, li, level,
        startSCellIdx, startPlane,
        goalSCellIdx, goalPlane,
        null, remaining,
      );
      expandedPerLevel[mr.factors.length - 1 - li] += res.expanded;
      remaining -= res.expanded;
    }

    if (!res.reached) {
      // Coarse reach failed even unrestricted. Drop the corridor for finer
      // levels and let the base Dijkstra do its thing unrestricted.
      chainAtFinerLevel = null;
      chainLevelIdx = -1;
      continue;
    }

    chainAtFinerLevel = res.chain;
    chainLevelIdx = li;
  }

  // Base level (factor=1).
  let baseCorridor: Uint8Array | null = null;
  if (chainAtFinerLevel !== null) {
    baseCorridor = stampBaseCorridor(ws, mr.levels[chainLevelIdx]!, chainAtFinerLevel, widen);
  }

  let baseRes = runBaseDijkstra(
    vnav, ws,
    startI, goalI,
    req.startCx, req.startCy, req.startCz,
    req.goalCx, req.goalCy, req.goalCz,
    req.canDig, req.requiresGround,
    baseCorridor, remaining,
  );
  const baseLevelEntry = mr.factors.length - 1;
  expandedPerLevel[baseLevelEntry] += baseRes.expanded;
  remaining -= baseRes.expanded;

  if (!baseRes.reached && baseCorridor !== null && remaining > 0) {
    baseRes = runBaseDijkstra(
      vnav, ws,
      startI, goalI,
      req.startCx, req.startCy, req.startCz,
      req.goalCx, req.goalCy, req.goalCz,
      req.canDig, req.requiresGround,
      null, remaining,
    );
    expandedPerLevel[baseLevelEntry] += baseRes.expanded;
  }

  return {
    cells: baseRes.cells,
    reached: baseRes.reached,
    expandedPerLevel,
    totalExpanded: sum(expandedPerLevel),
  };
}

function sum(arr: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i]!;
  return s;
}
