/**
 * HPA*-style cluster graph layered on a UnitGrid.
 *
 * Partitions the 128 × 24 × 128 nav grid into 16 × 8 × 16 clusters
 * (8 × 3 × 8 = 192 clusters). Within each cluster, passable cells form
 * connected components. At every shared face between two adjacent clusters
 * we emit one portal pair per contiguous run of passable boundary cells.
 *
 * The abstract graph is `Portal` nodes plus two kinds of edges:
 *   - intra-cluster: portals on the same component, weighted by the actual
 *     in-cluster Dijkstra distance.
 *   - inter-cluster: portal partners across a shared face, fixed cost 1.
 *
 * That graph is small (typically a few hundred nodes for a 128² map), so
 * abstract A* terminates almost instantly. Refinement back to per-cell
 * waypoints runs A* limited to one cluster at a time — see HPAStar.ts.
 *
 * The graph is per UnitGrid: passability differs per unit kind, so we keep
 * one ClusterGraph per registered profile.
 */
import {
  GRID_X, GRID_Y, GRID_Z, GRID_COUNT, cellIndex,
} from './Nav';
import { UnitGrid } from './UnitGrid';
import { FourAryHeap } from '../util/Heap';

export const CLUSTER_X = 16;
export const CLUSTER_Y = 8;
export const CLUSTER_Z = 16;
export const CLUSTERS_X = (GRID_X / CLUSTER_X) | 0;          // 8
export const CLUSTERS_Y = (GRID_Y / CLUSTER_Y) | 0;          // 3
export const CLUSTERS_Z = (GRID_Z / CLUSTER_Z) | 0;          // 8
export const CLUSTER_COUNT = CLUSTERS_X * CLUSTERS_Y * CLUSTERS_Z;

export function clusterIndex(cux: number, cuy: number, cuz: number): number {
  return (cuy * CLUSTERS_Z + cuz) * CLUSTERS_X + cux;
}

export function clusterOfCell(cx: number, cy: number, cz: number): number {
  return clusterIndex((cx / CLUSTER_X) | 0, (cy / CLUSTER_Y) | 0, (cz / CLUSTER_Z) | 0);
}

export function unpackCluster(cluster: number): { cux: number; cuy: number; cuz: number } {
  const cux = cluster % CLUSTERS_X;
  const tmp = (cluster / CLUSTERS_X) | 0;
  const cuz = tmp % CLUSTERS_Z;
  const cuy = (tmp / CLUSTERS_Z) | 0;
  return { cux, cuy, cuz };
}

export function clusterBounds(cluster: number): {
  x0: number; y0: number; z0: number; x1: number; y1: number; z1: number;
} {
  const { cux, cuy, cuz } = unpackCluster(cluster);
  return {
    x0: cux * CLUSTER_X, y0: cuy * CLUSTER_Y, z0: cuz * CLUSTER_Z,
    x1: cux * CLUSTER_X + CLUSTER_X - 1,
    y1: cuy * CLUSTER_Y + CLUSTER_Y - 1,
    z1: cuz * CLUSTER_Z + CLUSTER_Z - 1,
  };
}

const Y_STRIDE = GRID_X * GRID_Z;
const Z_STRIDE = GRID_X;
const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);

// 26-connected neighbour table — same layout as AStar.ts so component
// connectivity matches what the per-cell A* will accept.
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

export interface Portal {
  /** Linear cell index of the portal cell. */
  cell: number;
  /** Cluster owning this portal. */
  cluster: number;
  /** Global component id this portal belongs to. */
  component: number;
  /** Node index of the partner portal across the shared face, or -1 if none. */
  pair: number;
}

export interface AbstractEdge {
  to: number;
  cost: number;
}

export interface ClusterGraph {
  /** Global component id per cell, -1 if impassable. */
  componentOf: Int32Array;
  /** Cluster id for a given component. */
  componentCluster: Int32Array;
  componentCount: number;
  portals: Portal[];
  /** Adjacency list per portal node. */
  adj: AbstractEdge[][];
  /** Portal node indices contained in each cluster. */
  clusterPortals: Int32Array[];
  /** Portal node indices contained in each component. */
  componentPortals: Int32Array[];
}

/** Fast bitmap test inlined for the build hot loops. */
function bit(arr: Uint8Array, i: number): number {
  return (arr[i >> 3]! >> (i & 7)) & 1;
}

/**
 * Build the cluster graph from scratch for the given unit grid. Allocates new
 * typed arrays; previous graph (if any) can be discarded.
 *
 * Cost is dominated by one Dijkstra per portal limited to its cluster, so
 * scales with portal count × cluster size — typically ~50 ms on a full map.
 */
export function buildClusterGraph(grid: UnitGrid): ClusterGraph {
  const passable = grid.passable;
  const componentOf = new Int32Array(GRID_COUNT);
  componentOf.fill(-1);

  // -------- 1. Per-cluster connected components (26-connected flood). --------
  const componentCluster: number[] = [];
  let componentCount = 0;
  const stack = new Int32Array(CLUSTER_X * CLUSTER_Y * CLUSTER_Z);
  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
    const { x0, y0, z0, x1, y1, z1 } = clusterBounds(cluster);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const i = cellIndex(cx, cy, cz);
          if (componentOf[i] !== -1) continue;
          if (bit(passable, i) === 0) continue;
          const comp = componentCount++;
          componentCluster.push(cluster);
          let top = 0;
          stack[top++] = i;
          componentOf[i] = comp;
          while (top > 0) {
            const j = stack[--top]!;
            const jx = j % GRID_X;
            const jtmp = (j / GRID_X) | 0;
            const jz = jtmp % GRID_Z;
            const jy = (jtmp / GRID_Z) | 0;
            for (let n = 0; n < 26; n++) {
              const nx = jx + NB_DX[n]!;
              const ny = jy + NB_DY[n]!;
              const nz = jz + NB_DZ[n]!;
              if (nx < x0 || ny < y0 || nz < z0 || nx > x1 || ny > y1 || nz > z1) continue;
              const ni = j + NB_DI[n]!;
              if (componentOf[ni] !== -1) continue;
              if (bit(passable, ni) === 0) continue;
              componentOf[ni] = comp;
              stack[top++] = ni;
            }
          }
        }
      }
    }
  }

  // -------- 2. Portals across each +x/+y/+z cluster face. --------
  // For each shared face, scan boundary cell pairs (a in A, b in B cardinally
  // adjacent across the face). Group cardinal-adjacent runs of valid pairs
  // along the face plane, emit one portal pair per run (median cell of the
  // run). This keeps the abstract graph small while preserving every distinct
  // entrance.
  const portals: Portal[] = [];
  const adj: AbstractEdge[][] = [];

  function addPortal(cellIdx: number, cluster: number): number {
    const node = portals.length;
    portals.push({
      cell: cellIdx,
      cluster,
      component: componentOf[cellIdx]!,
      pair: -1,
    });
    adj.push([]);
    return node;
  }

  function emitFacePortalPairs(
    faceCellsA: number[], faceCellsB: number[], clusterA: number, clusterB: number,
  ): void {
    // Walk the parallel sequences and pick out runs of consecutive valid pairs.
    let runStart = -1;
    for (let k = 0; k <= faceCellsA.length; k++) {
      const valid = k < faceCellsA.length
        && bit(passable, faceCellsA[k]!) === 1
        && bit(passable, faceCellsB[k]!) === 1;
      if (valid && runStart === -1) runStart = k;
      if ((!valid || k === faceCellsA.length) && runStart !== -1) {
        const runEnd = k - 1;
        const mid = (runStart + runEnd) >> 1;
        const a = addPortal(faceCellsA[mid]!, clusterA);
        const b = addPortal(faceCellsB[mid]!, clusterB);
        portals[a]!.pair = b;
        portals[b]!.pair = a;
        adj[a]!.push({ to: b, cost: 1 });
        adj[b]!.push({ to: a, cost: 1 });
        runStart = -1;
      }
    }
  }

  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
    const { x0, y0, z0, x1, y1, z1 } = clusterBounds(cluster);
    const { cux, cuy, cuz } = unpackCluster(cluster);

    // +X face: column of cells at x=x1 in A, x=x1+1 in B.
    if (cux + 1 < CLUSTERS_X) {
      const cb = clusterIndex(cux + 1, cuy, cuz);
      const facesA: number[] = [];
      const facesB: number[] = [];
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          facesA.push(cellIndex(x1, cy, cz));
          facesB.push(cellIndex(x1 + 1, cy, cz));
        }
      }
      emitFacePortalPairs(facesA, facesB, cluster, cb);
    }

    // +Y face: cells at y=y1 in A, y=y1+1 in B.
    if (cuy + 1 < CLUSTERS_Y) {
      const cb = clusterIndex(cux, cuy + 1, cuz);
      const facesA: number[] = [];
      const facesB: number[] = [];
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          facesA.push(cellIndex(cx, y1, cz));
          facesB.push(cellIndex(cx, y1 + 1, cz));
        }
      }
      emitFacePortalPairs(facesA, facesB, cluster, cb);
    }

    // +Z face.
    if (cuz + 1 < CLUSTERS_Z) {
      const cb = clusterIndex(cux, cuy, cuz + 1);
      const facesA: number[] = [];
      const facesB: number[] = [];
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          facesA.push(cellIndex(cx, cy, z1));
          facesB.push(cellIndex(cx, cy, z1 + 1));
        }
      }
      emitFacePortalPairs(facesA, facesB, cluster, cb);
    }
  }

  // -------- 3. Bucket portals by cluster and by component. --------
  const clusterPortals: number[][] = Array.from({ length: CLUSTER_COUNT }, () => [] as number[]);
  const componentPortals: number[][] = Array.from({ length: componentCount }, () => [] as number[]);
  for (let n = 0; n < portals.length; n++) {
    clusterPortals[portals[n]!.cluster]!.push(n);
    componentPortals[portals[n]!.component]!.push(n);
  }

  // -------- 4. Intra-cluster portal-to-portal edges via Dijkstra. --------
  // For each portal, run Dijkstra limited to its cluster bounds; relax-and-
  // record into other portals in the same cluster sharing a component.
  // 26-connected, octile costs — same metric as the per-cell A* so the
  // abstract distances stay consistent with the refined path.
  //
  // The Dijkstra workspace is sized to a single cluster (≤ 2048 cells) and
  // reused across every portal in the build. Allocating a GRID_COUNT-sized
  // array per portal would dominate build time on a 393 K-cell map.
  const ws = new ClusterDijkstraWorkspace();
  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
    const portalIdxs = clusterPortals[cluster]!;
    if (portalIdxs.length < 2) continue;
    const bounds = clusterBounds(cluster);
    for (let pi = 0; pi < portalIdxs.length; pi++) {
      const fromNode = portalIdxs[pi]!;
      const fromCell = portals[fromNode]!.cell;
      const fromComp = portals[fromNode]!.component;
      ws.run(passable, fromCell, bounds);
      for (let pj = 0; pj < portalIdxs.length; pj++) {
        if (pj === pi) continue;
        const toNode = portalIdxs[pj]!;
        if (portals[toNode]!.component !== fromComp) continue;
        const c = ws.distAt(portals[toNode]!.cell, bounds);
        if (c < Infinity) {
          adj[fromNode]!.push({ to: toNode, cost: c });
        }
      }
    }
  }

  return {
    componentOf,
    componentCluster: Int32Array.from(componentCluster),
    componentCount,
    portals,
    adj,
    clusterPortals: clusterPortals.map(a => Int32Array.from(a)),
    componentPortals: componentPortals.map(a => Int32Array.from(a)),
  };
}

/**
 * Single-source Dijkstra limited to a cluster's bounds. Convenience wrapper
 * that allocates a fresh distance array of GRID_COUNT entries — handy for
 * one-off queries (e.g. HPA* attaching virtual start/goal nodes) where the
 * 1.5 MB allocation isn't on a hot loop. For repeated calls during graph
 * build, prefer `ClusterDijkstraWorkspace`.
 */
export function dijkstraInCluster(
  passable: Uint8Array,
  fromCell: number,
  bounds: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number },
): Float32Array {
  const dist = new Float32Array(GRID_COUNT);
  dist.fill(Infinity);
  dist[fromCell] = 0;
  const heap = new FourAryHeap(256);
  heap.push(fromCell, 0);
  const { x0, y0, z0, x1, y1, z1 } = bounds;
  while (heap.length > 0) {
    const i = heap.pop();
    const d = dist[i]!;
    if (d === Infinity) continue;
    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    for (let n = 0; n < 26; n++) {
      const nx = cx + NB_DX[n]!;
      const ny = cy + NB_DY[n]!;
      const nz = cz + NB_DZ[n]!;
      if (nx < x0 || ny < y0 || nz < z0 || nx > x1 || ny > y1 || nz > z1) continue;
      const ni = i + NB_DI[n]!;
      if (((passable[ni >> 3]! >> (ni & 7)) & 1) === 0) continue;
      const nd = d + NB_COST[n]!;
      if (nd < dist[ni]!) {
        dist[ni] = nd;
        heap.push(ni, nd);
      }
    }
  }
  return dist;
}

/**
 * Reusable Dijkstra workspace sized to one cluster (CLUSTER_X × CLUSTER_Y ×
 * CLUSTER_Z = 2048 cells). Kept around for the duration of a graph build so
 * we don't reallocate the 1.5 MB GRID_COUNT-sized distance array per portal.
 *
 * Distances are stored under cluster-local coords; lookups via `distAt(i,
 * bounds)` translate the global cell index back to local on the fly.
 */
class ClusterDijkstraWorkspace {
  private readonly LOCAL_COUNT = CLUSTER_X * CLUSTER_Y * CLUSTER_Z;
  private readonly dist = new Float32Array(this.LOCAL_COUNT);
  private readonly heap = new FourAryHeap(this.LOCAL_COUNT);

  run(
    passable: Uint8Array,
    fromCell: number,
    bounds: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number },
  ): void {
    this.dist.fill(Infinity);
    this.heap.clear();
    const { x0, y0, z0, x1, y1, z1 } = bounds;
    const fromLocal = this.toLocal(fromCell, bounds);
    this.dist[fromLocal] = 0;
    this.heap.push(fromCell, 0);
    while (this.heap.length > 0) {
      const i = this.heap.pop();
      const li = this.toLocal(i, bounds);
      const d = this.dist[li]!;
      if (d === Infinity) continue;
      const cx = i % GRID_X;
      const tmp = (i / GRID_X) | 0;
      const cz = tmp % GRID_Z;
      const cy = (tmp / GRID_Z) | 0;
      for (let n = 0; n < 26; n++) {
        const nx = cx + NB_DX[n]!;
        const ny = cy + NB_DY[n]!;
        const nz = cz + NB_DZ[n]!;
        if (nx < x0 || ny < y0 || nz < z0 || nx > x1 || ny > y1 || nz > z1) continue;
        const ni = i + NB_DI[n]!;
        if (((passable[ni >> 3]! >> (ni & 7)) & 1) === 0) continue;
        const nd = d + NB_COST[n]!;
        const nli = ((ny - y0) * CLUSTER_Z + (nz - z0)) * CLUSTER_X + (nx - x0);
        if (nd < this.dist[nli]!) {
          this.dist[nli] = nd;
          this.heap.push(ni, nd);
        }
      }
    }
  }

  distAt(globalCell: number, bounds: { x0: number; y0: number; z0: number }): number {
    return this.dist[this.toLocal(globalCell, bounds)]!;
  }

  private toLocal(i: number, bounds: { x0: number; y0: number; z0: number }): number {
    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    return ((cy - bounds.y0) * CLUSTER_Z + (cz - bounds.z0)) * CLUSTER_X + (cx - bounds.x0);
  }
}

/** Cluster-bounded 3D octile heuristic between two cells. */
export function octileHeuristic(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): number {
  let dx = ax - bx; if (dx < 0) dx = -dx;
  let dy = ay - by; if (dy < 0) dy = -dy;
  let dz = az - bz; if (dz < 0) dz = -dz;
  if (dx < dy) { const t = dx; dx = dy; dy = t; }
  if (dy < dz) { const t = dy; dy = dz; dz = t; }
  if (dx < dy) { const t = dx; dx = dy; dy = t; }
  return (dx - dy) + (dy - dz) * SQRT2 + dz * SQRT3;
}
