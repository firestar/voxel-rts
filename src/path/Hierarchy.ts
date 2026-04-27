import { NAV_W, NAV_H, NAV_COUNT, navIndex, SurfaceNavBuffers } from './SurfaceNav';
import { FourAryHeap } from '../util/Heap';

/**
 * Cluster size in nav cells. The 96×96 nav grid splits into 12×12 = 144 clusters
 * of 8×8 cells. Picked to give an abstract graph small enough to A*-search in
 * tens of expansions while still letting the fine A* prune ~80% of the grid.
 */
export const CLUSTER_SIZE = 8;
export const CLUSTER_W = (NAV_W / CLUSTER_SIZE) | 0;
export const CLUSTER_H = (NAV_H / CLUSTER_SIZE) | 0;
export const CLUSTER_COUNT = CLUSTER_W * CLUSTER_H;

// Neighbour direction bits packed into ClusterGraph.edges[i]. We only store
// cardinal connectivity — clusters share borders only with cardinal neighbours.
export const CL_N = 1, CL_E = 2, CL_S = 4, CL_W_BIT = 8;

export interface ClusterGraph {
  /** 4-bit NESW neighbour passability per cluster. */
  readonly edges: Uint8Array;
  /** 1 if the cluster contains at least one walkable cell. */
  readonly hasWalkable: Uint8Array;
}

export function clusterIndex(cluCx: number, cluCz: number): number {
  return cluCz * CLUSTER_W + cluCx;
}

export function cellToClusterCx(cellCx: number): number { return (cellCx / CLUSTER_SIZE) | 0; }
export function cellToClusterCz(cellCz: number): number { return (cellCz / CLUSTER_SIZE) | 0; }

export function allocateClusterGraph(): ClusterGraph {
  return {
    edges: new Uint8Array(CLUSTER_COUNT),
    hasWalkable: new Uint8Array(CLUSTER_COUNT),
  };
}

/**
 * Recompute the abstract cluster graph from the freshly-built nav grid. A border
 * between two adjacent clusters is marked passable if at least one cell-pair
 * across it is mutually unblocked — that's a permissive abstraction (it ignores
 * step-climb limits and per-unit footprint), so the fine A* may still fail to
 * find a route through a "passable" border. The corridor consumer falls back to
 * unrestricted A* in that case.
 */
export function buildClusterGraph(nav: SurfaceNavBuffers, hg: ClusterGraph): void {
  const blocked = nav.blocked;
  hg.edges.fill(0);
  hg.hasWalkable.fill(0);
  for (let cz = 0; cz < NAV_H; cz++) {
    const cluCz = (cz / CLUSTER_SIZE) | 0;
    for (let cx = 0; cx < NAV_W; cx++) {
      if (blocked[navIndex(cx, cz)]) continue;
      const cluCx = (cx / CLUSTER_SIZE) | 0;
      hg.hasWalkable[clusterIndex(cluCx, cluCz)] = 1;
    }
  }
  for (let cluCz = 0; cluCz < CLUSTER_H; cluCz++) {
    for (let cluCx = 0; cluCx < CLUSTER_W; cluCx++) {
      const here = clusterIndex(cluCx, cluCz);
      if (cluCx + 1 < CLUSTER_W) {
        const right = clusterIndex(cluCx + 1, cluCz);
        const xL = (cluCx + 1) * CLUSTER_SIZE - 1;
        const xR = (cluCx + 1) * CLUSTER_SIZE;
        const z0 = cluCz * CLUSTER_SIZE;
        for (let dz = 0; dz < CLUSTER_SIZE; dz++) {
          const z = z0 + dz;
          if (!blocked[navIndex(xL, z)] && !blocked[navIndex(xR, z)]) {
            hg.edges[here] |= CL_E;
            hg.edges[right] |= CL_W_BIT;
            break;
          }
        }
      }
      if (cluCz + 1 < CLUSTER_H) {
        const down = clusterIndex(cluCx, cluCz + 1);
        const zU = (cluCz + 1) * CLUSTER_SIZE - 1;
        const zD = (cluCz + 1) * CLUSTER_SIZE;
        const x0 = cluCx * CLUSTER_SIZE;
        for (let dx = 0; dx < CLUSTER_SIZE; dx++) {
          const x = x0 + dx;
          if (!blocked[navIndex(x, zU)] && !blocked[navIndex(x, zD)]) {
            hg.edges[here] |= CL_S;
            hg.edges[down] |= CL_N;
            break;
          }
        }
      }
    }
  }
}

/**
 * Workspace for the abstract A* on the cluster graph. Tiny — the cluster graph is
 * 144 nodes — so the heap rarely grows past 50 entries. We still use the same
 * 4-ary heap as the fine A* for type / API consistency.
 */
export class HierarchyWorkspace {
  readonly g = new Float32Array(CLUSTER_COUNT);
  readonly came = new Int32Array(CLUSTER_COUNT);
  readonly closed = new Uint8Array(CLUSTER_COUNT);
  readonly gen = new Int32Array(CLUSTER_COUNT);
  readonly open = new FourAryHeap(256);
  /** Per-cell corridor mask, 1 = inside corridor (or its 1-cluster widening). */
  readonly corridor = new Uint8Array(NAV_COUNT);
  /** Per-cluster scratch used while computing the corridor (1 = on abstract path). */
  readonly clusterMark = new Uint8Array(CLUSTER_COUNT);
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

function clusterH(ax: number, az: number, bx: number, bz: number): number {
  // Cardinal-only abstract graph → Manhattan is exact and admissible.
  const dx = ax > bx ? ax - bx : bx - ax;
  const dz = az > bz ? az - bz : bz - az;
  return dx + dz;
}

/**
 * Run abstract A* on the cluster graph and stamp a per-cell corridor mask into
 * `ws.corridor`. Returns true if a corridor was successfully built (start and
 * goal connected); false otherwise — the caller should run unrestricted A*.
 *
 * The corridor is the cluster path widened by one cluster in every cardinal
 * direction, so the fine A* still has wiggle room to go around small in-cluster
 * obstacles without escaping the abstract route.
 */
export function computeCorridor(
  hg: ClusterGraph,
  ws: HierarchyWorkspace,
  startCluCx: number, startCluCz: number,
  goalCluCx: number, goalCluCz: number,
): boolean {
  const startI = clusterIndex(startCluCx, startCluCz);
  const goalI = clusterIndex(goalCluCx, goalCluCz);
  if (!hg.hasWalkable[startI] || !hg.hasWalkable[goalI]) return false;
  if (startI === goalI) {
    // Same cluster — the fine A* will be tiny anyway. No corridor needed.
    return false;
  }
  const gen = ws.resetGeneration();
  ws.g[startI] = 0;
  ws.came[startI] = -1;
  ws.gen[startI] = gen;
  ws.open.push(startI, clusterH(startCluCx, startCluCz, goalCluCx, goalCluCz));

  let reached = false;
  // Cardinal direction tables matching the bit ordering in CL_N..CL_W_BIT.
  // dx, dz, bitmask required from the *source* cluster's edges entry.
  const DX = [0, 1, 0, -1];
  const DZ = [-1, 0, 1, 0];
  const MASK = [CL_N, CL_E, CL_S, CL_W_BIT];

  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.closed[i] === gen) continue;
    ws.closed[i] = gen;
    if (i === goalI) { reached = true; break; }
    const cluCx = i % CLUSTER_W;
    const cluCz = (i / CLUSTER_W) | 0;
    const eMask = hg.edges[i]!;
    const gI = ws.g[i]!;
    for (let d = 0; d < 4; d++) {
      if ((eMask & MASK[d]!) === 0) continue;
      const nx = cluCx + DX[d]!;
      const nz = cluCz + DZ[d]!;
      if (nx < 0 || nz < 0 || nx >= CLUSTER_W || nz >= CLUSTER_H) continue;
      const ni = clusterIndex(nx, nz);
      if (ws.closed[ni] === gen) continue;
      const ng = gI + 1;
      if (ws.gen[ni] !== gen || ng < ws.g[ni]!) {
        ws.gen[ni] = gen;
        ws.g[ni] = ng;
        ws.came[ni] = i;
        ws.open.push(ni, ng + clusterH(nx, nz, goalCluCx, goalCluCz));
      }
    }
  }

  if (!reached) return false;

  // Mark every cluster on the abstract path.
  ws.clusterMark.fill(0);
  for (let cur = goalI; cur !== -1; cur = ws.came[cur]!) {
    ws.clusterMark[cur] = 1;
    if (cur === startI) break;
    if (ws.gen[cur] !== gen) return false; // shouldn't happen, but bail rather than loop
  }

  // Stamp the per-cell corridor mask: a cell is in-corridor if its cluster is
  // marked OR any of its 4 cardinal neighbour clusters is marked. That gives the
  // fine A* one cluster of headroom on each side of the abstract route.
  ws.corridor.fill(0);
  for (let cluCz = 0; cluCz < CLUSTER_H; cluCz++) {
    for (let cluCx = 0; cluCx < CLUSTER_W; cluCx++) {
      const ci = clusterIndex(cluCx, cluCz);
      let inWidened = ws.clusterMark[ci]!;
      if (!inWidened) {
        if (cluCz > 0 && ws.clusterMark[ci - CLUSTER_W]!) inWidened = 1;
        else if (cluCz + 1 < CLUSTER_H && ws.clusterMark[ci + CLUSTER_W]!) inWidened = 1;
        else if (cluCx > 0 && ws.clusterMark[ci - 1]!) inWidened = 1;
        else if (cluCx + 1 < CLUSTER_W && ws.clusterMark[ci + 1]!) inWidened = 1;
      }
      if (!inWidened) continue;
      const x0 = cluCx * CLUSTER_SIZE;
      const z0 = cluCz * CLUSTER_SIZE;
      for (let dz = 0; dz < CLUSTER_SIZE; dz++) {
        const rowBase = (z0 + dz) * NAV_W + x0;
        for (let dx = 0; dx < CLUSTER_SIZE; dx++) {
          ws.corridor[rowBase + dx] = 1;
        }
      }
    }
  }
  return true;
}
