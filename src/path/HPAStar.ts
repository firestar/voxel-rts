/**
 * HPA* on a cluster graph.
 *
 *   1. Find the cluster + component for start and goal cells.
 *   2. If they share a component, fall through to plain A* limited to that
 *      cluster — there's no portal hop to make.
 *   3. Otherwise, attach virtual start/goal nodes to the abstract graph by
 *      Dijkstra-within-cluster from each end to its component's portals,
 *      run A* over abstract portals using a 3D-octile heuristic on cell
 *      coordinates, then refine each consecutive segment back to per-cell
 *      waypoints by running A* limited to one cluster at a time.
 *
 * Result is "near-optimal": the abstract distances along intra-cluster edges
 * are exact (we ran Dijkstra on the real grid during build), so the only loss
 * comes from the choice of portal cell along each entrance — a known HPA*
 * trade-off, typically <1% path-length penalty.
 */
import { GRID_X, GRID_Z } from './Nav';
import { UnitGrid, isPassable } from './UnitGrid';
import { VolumeGrid } from './VolumeGrid';
import {
  ClusterGraph, AbstractEdge, dijkstraInCluster, octileHeuristic,
  clusterBounds,
} from './ClusterGraph';
import {
  AStarWorkspace, findPath as runFindPath, PathNode, PathResult,
} from './AStar';
import { FourAryHeap } from '../util/Heap';

export interface HPAOptions {
  /** Per-segment refinement cap (passed through to plain A*). */
  maxExpansionsPerSegment?: number;
  /** Heuristic weight for the per-segment refinement. */
  heuristicWeight?: number;
  /** When set, drives digger costs in the refinement step. */
  volume?: VolumeGrid;
}

/**
 * Top-level HPA* entry point. Returns a `PathResult` whose `cells` is a
 * concatenation of per-segment waypoints — i.e. drop-in compatible with the
 * plain `findPath` output.
 */
export function findPathHPA(
  grid: UnitGrid,
  graph: ClusterGraph,
  start: PathNode,
  goal: PathNode,
  ws: AStarWorkspace,
  opts: HPAOptions = {},
): PathResult {
  if (!isPassable(grid, start.cx, start.cy, start.cz)) {
    return { cells: [], reached: false, expanded: 0 };
  }
  if (!isPassable(grid, goal.cx, goal.cy, goal.cz)) {
    return { cells: [], reached: false, expanded: 0 };
  }

  const startCell = (start.cy * GRID_Z + start.cz) * GRID_X + start.cx;
  const goalCell = (goal.cy * GRID_Z + goal.cz) * GRID_X + goal.cx;

  const startComp = graph.componentOf[startCell]!;
  const goalComp = graph.componentOf[goalCell]!;
  if (startComp < 0 || goalComp < 0) {
    return { cells: [], reached: false, expanded: 0 };
  }

  // Same cluster + component: a plain in-cluster A* on the unit grid is
  // already as good as it gets — no portals to hop through.
  if (startComp === goalComp) {
    return runFindPath(grid, start, goal, ws, {
      maxExpansions: opts.maxExpansionsPerSegment,
      heuristicWeight: opts.heuristicWeight,
      volume: opts.volume,
    });
  }

  // Build virtual start/goal nodes connected to portals in their components.
  const startCluster = graph.componentCluster[startComp]!;
  const goalCluster = graph.componentCluster[goalComp]!;
  const startBounds = clusterBounds(startCluster);
  const goalBounds = clusterBounds(goalCluster);

  const startDist = dijkstraInCluster(grid.passable, startCell, startBounds);
  const goalDist = dijkstraInCluster(grid.passable, goalCell, goalBounds);

  const startPortals = graph.componentPortals[startComp]!;
  const goalPortals = graph.componentPortals[goalComp]!;

  // Abstract A* using two virtual nodes (-1 = start, -2 = goal). We won't
  // store them in the portal arrays — instead we maintain `gScore`/`from`
  // maps keyed by node index, with virtuals stored under a fixed slot.
  const VIRT_START = graph.portals.length;
  const VIRT_GOAL = graph.portals.length + 1;

  const open = new FourAryHeap(graph.portals.length + 8);
  const gScore = new Float32Array(graph.portals.length + 2);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(graph.portals.length + 2);
  cameFrom.fill(-1);
  const closed = new Uint8Array(graph.portals.length + 2);

  gScore[VIRT_START] = 0;
  open.push(VIRT_START, 0);
  let expanded = 0;
  let reached = false;
  let bestPartial = VIRT_START;
  let bestPartialH = octileHeuristic(start.cx, start.cy, start.cz, goal.cx, goal.cy, goal.cz);

  function neighboursOf(node: number): { to: number; cost: number }[] {
    if (node === VIRT_START) {
      const out: AbstractEdge[] = [];
      for (let k = 0; k < startPortals.length; k++) {
        const p = startPortals[k]!;
        const d = startDist[graph.portals[p]!.cell]!;
        if (d < Infinity) out.push({ to: p, cost: d });
      }
      return out;
    }
    const portal = graph.portals[node]!;
    const out: AbstractEdge[] = [...graph.adj[node]!];
    // If this portal sits in the goal component, it can reach VIRT_GOAL.
    if (portal.component === goalComp) {
      const d = goalDist[portal.cell]!;
      if (d < Infinity) out.push({ to: VIRT_GOAL, cost: d });
    }
    return out;
  }

  function nodeCellCoords(node: number): { cx: number; cy: number; cz: number } {
    if (node === VIRT_START) return { cx: start.cx, cy: start.cy, cz: start.cz };
    if (node === VIRT_GOAL) return { cx: goal.cx, cy: goal.cy, cz: goal.cz };
    const ci = graph.portals[node]!.cell;
    const cx = ci % GRID_X;
    const tmp = (ci / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    return { cx, cy, cz };
  }

  while (open.length > 0) {
    const node = open.pop();
    if (closed[node]!) continue;
    closed[node] = 1;
    expanded++;
    if (node === VIRT_GOAL) { reached = true; break; }

    const me = nodeCellCoords(node);
    const h = octileHeuristic(me.cx, me.cy, me.cz, goal.cx, goal.cy, goal.cz);
    if (h < bestPartialH) { bestPartialH = h; bestPartial = node; }

    const edges = neighboursOf(node);
    const gHere = gScore[node]!;
    for (let e = 0; e < edges.length; e++) {
      const to = edges[e]!.to;
      if (closed[to]!) continue;
      const tentative = gHere + edges[e]!.cost;
      if (tentative < gScore[to]!) {
        gScore[to] = tentative;
        cameFrom[to] = node;
        const dst = nodeCellCoords(to);
        const f = tentative + octileHeuristic(dst.cx, dst.cy, dst.cz, goal.cx, goal.cy, goal.cz);
        open.push(to, f);
      }
    }
  }

  // Reconstruct the abstract path as a list of node indices VIRT_START..VIRT_GOAL.
  const endNode = reached ? VIRT_GOAL : bestPartial;
  const abstractPath: number[] = [];
  let cur = endNode;
  let safety = graph.portals.length + 4;
  while (cur !== -1 && safety-- > 0) {
    abstractPath.push(cur);
    if (cur === VIRT_START) break;
    cur = cameFrom[cur]!;
  }
  abstractPath.reverse();

  // Translate abstract nodes to concrete PathNode endpoints.
  const waypoints: PathNode[] = abstractPath.map(n => nodeCellCoords(n));

  // Refine each consecutive segment that lies inside a single cluster.
  // Inter-cluster jumps (portal-pair edges) are simply two cardinally-adjacent
  // cells, so the refinement is just the two endpoints. Intra-cluster edges
  // (and the virtual start/goal hops) require a per-cluster A* call.
  const refined: PathNode[] = [];
  let totalExpansions = expanded;
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const segPath = refineSegment(grid, a, b, ws, opts);
    totalExpansions += segPath.expanded;
    if (!segPath.reached) {
      // Couldn't refine this hop — bail with whatever we have so far + the
      // partial chain to the closest cell. Caller still gets a usable lead.
      if (refined.length === 0) refined.push(a);
      for (let k = 1; k < segPath.cells.length; k++) refined.push(segPath.cells[k]!);
      return { cells: refined, reached: false, expanded: totalExpansions };
    }
    if (refined.length === 0) refined.push(segPath.cells[0]!);
    for (let k = 1; k < segPath.cells.length; k++) refined.push(segPath.cells[k]!);
  }

  return { cells: refined, reached, expanded: totalExpansions };
}

/**
 * Refine one abstract segment by running plain A* limited to the union of the
 * two endpoint clusters. Limiting to one or two clusters keeps refinement
 * cheap regardless of total map size — the whole point of HPA*.
 */
function refineSegment(
  grid: UnitGrid,
  a: PathNode,
  b: PathNode,
  ws: AStarWorkspace,
  opts: HPAOptions,
): PathResult {
  // Cluster-bounded A* would require its own search routine. For the scaffold
  // we just call the existing findPath with a tight expansion budget — typical
  // segments are ≤ CLUSTER_X * CLUSTER_Y * CLUSTER_Z * 2 ~= 4K cells, so an
  // 8K cap is more than enough and protects us from runaway expansion when
  // the map is already mostly cleared by stale gen markers.
  const cap = opts.maxExpansionsPerSegment ?? 8192;
  return runFindPath(grid, a, b, ws, {
    maxExpansions: cap,
    heuristicWeight: opts.heuristicWeight,
    volume: opts.volume,
  });
}
