import { FourAryHeap } from '../util/Heap';
import { SVOIndex, WorldLookup } from './SVOIndex';
import {
  UnitTraversal, leafCost,
} from './SVOAnnotation';
import { forEachFaceNeighbor, isGrounded } from './Neighbors';
import { CHUNK } from '../voxel/types';
import { SVO_LEAF_AIR } from './SVO';

/**
 * Single-tier A* over SVO leaves. Leaves are nodes; face-adjacency edges are
 * enumerated on demand by `forEachFaceNeighbor` — no persistent edge graph.
 *
 * The SVO already gives us "hierarchy for free" in the typical case: a 32³
 * cube of uniform air collapses to one leaf, so crossing it is one A*
 * expansion instead of 32 K. For long-distance paths through mostly-uniform
 * terrain, expansion counts stay in the low hundreds.
 *
 * The search uses a 4-ary heap and weighted Euclidean heuristic. A
 * generation-less Map tracks per-leaf state — node indices are stable within
 * a single search, but rebuilds between calls reassign them, so reusing
 * persistent state would just be wrong.
 */

export interface PathRequest {
  /** Start position in world voxel coordinates. */
  start: { x: number; y: number; z: number };
  /** Goal position in world voxel coordinates. */
  goal: { x: number; y: number; z: number };
  unit: UnitTraversal;
  /**
   * Heuristic weight ε ≥ 1. ε=1 → optimal (slow); ε=1.5 → up to 50%
   * suboptimal but a forward-biased fan dramatically cuts expansions.
   * Mirrors the existing pathfinder's convention. Default 1.5.
   */
  heuristicWeight?: number;
  /**
   * Hard cap on expansions. Returns failure when exceeded; caller decides
   * whether to fall back, retry with a larger budget, or give up. Default
   * 50_000 — generous for hierarchical-style searches that mostly traverse
   * large air leaves.
   */
  maxExpansions?: number;
}

export interface PathResult {
  /**
   * Leaf-center world voxel waypoints from start to goal, inclusive. Empty
   * when `reached` is false. The unit can lerp between consecutive waypoints
   * since each pair lies in face-adjacent leaves both passable for the unit.
   */
  waypoints: { x: number; y: number; z: number }[];
  reached: boolean;
  /** Number of leaves popped from the open set. */
  expansions: number;
}

/** Pack (chunkKey, nodeIdx) into one int32 key for heap / Map use.
 *  chunkKey ≤ CHUNKS_X*CHUNKS_Y*CHUNKS_Z ≈ 6 K, nodeIdx ≤ ~32 K → fits. */
function packKey(chunkKey: number, nodeIdx: number): number {
  return (chunkKey << 16) | (nodeIdx & 0xFFFF);
}

/** Voxel-units center of a leaf, used for distance calculations and waypoints. */
function leafCenter(leaf: WorldLookup): { x: number; y: number; z: number } {
  const half = leaf.size / 2;
  return { x: leaf.minWx + half, y: leaf.minWy + half, z: leaf.minWz + half };
}

function euclidean(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Returns a PathResult whose `reached` is true iff a passable corridor of
 * face-adjacent leaves connects start to goal under the unit predicate.
 *
 * Both start and goal are resolved via `queryWorld`; the search runs leaf-
 * to-leaf. If start or goal is in an impassable leaf the search returns
 * failure with zero expansions.
 *
 * The waypoint list interpolates the start and goal positions exactly: the
 * first waypoint is the start, the last is the goal, with leaf centers in
 * between. Saves the caller from a separate "snap to leaf center" pass.
 */
export function findPath(index: SVOIndex, req: PathRequest): PathResult {
  const weight = req.heuristicWeight ?? 1.5;
  const maxExp = req.maxExpansions ?? 50_000;

  const startLeaf = index.queryWorld(req.start.x | 0, req.start.y | 0, req.start.z | 0);
  const goalLeaf = index.queryWorld(req.goal.x | 0, req.goal.y | 0, req.goal.z | 0);
  if (!startLeaf || !goalLeaf) return { waypoints: [], reached: false, expansions: 0 };

  // Fast-path rejection: start or goal is in a non-enterable leaf for this
  // unit. Saves opening a hopeless search.
  if (!enterable(index, startLeaf, req.unit) || !enterable(index, goalLeaf, req.unit)) {
    return { waypoints: [], reached: false, expansions: 0 };
  }

  // Same-leaf shortcut.
  const startKey = packKey(startLeaf.chunkKey, startLeaf.nodeIdx);
  const goalKey = packKey(goalLeaf.chunkKey, goalLeaf.nodeIdx);
  if (startKey === goalKey) {
    return {
      waypoints: [
        { x: req.start.x, y: req.start.y, z: req.start.z },
        { x: req.goal.x, y: req.goal.y, z: req.goal.z },
      ],
      reached: true,
      expansions: 0,
    };
  }

  const heap = new FourAryHeap(1024);
  const gScore = new Map<number, number>();
  const parent = new Map<number, number>();
  const closed = new Set<number>();
  // Stash leaf objects so we can reconstruct the path without re-querying.
  // The query is cheap, but holding the same object across the whole search
  // also lets us retrieve `size` and `minW*` for the waypoint without a
  // second SVO walk.
  const leaves = new Map<number, WorldLookup>();
  leaves.set(startKey, startLeaf);
  leaves.set(goalKey, goalLeaf);

  const goalCenter = leafCenter(goalLeaf);
  const startCenter = leafCenter(startLeaf);

  gScore.set(startKey, 0);
  heap.push(startKey, weight * euclidean(startCenter, goalCenter));

  let expansions = 0;
  let reached = false;

  while (heap.length > 0) {
    if (expansions >= maxExp) break;
    const curKey = heap.pop();
    if (curKey === -1) break;
    if (closed.has(curKey)) continue;
    closed.add(curKey);
    expansions++;
    if (curKey === goalKey) { reached = true; break; }

    const cur = leaves.get(curKey)!;
    const curG = gScore.get(curKey)!;
    const curCenter = leafCenter(cur);

    forEachFaceNeighbor(index, cur, ({ leaf: nbr }) => {
      const nbrKey = packKey(nbr.chunkKey, nbr.nodeIdx);
      if (closed.has(nbrKey)) return;
      if (!enterable(index, nbr, req.unit)) return;
      // Edge clearance is bounded by air leaves only — solid leaves are
      // carved out as the digger passes through, so their inscribed radius
      // (which is 0) is irrelevant to the unit's bottleneck. Without this,
      // every "dig out of solid into air" transition would be rejected.
      const ann = index.annotations[nbr.chunkKey]!;
      const ownAnn = index.annotations[cur.chunkKey]!;
      if (cur.tag === SVO_LEAF_AIR && nbr.tag === SVO_LEAF_AIR) {
        const minR = Math.min(
          ownAnn.inscribedRadius[cur.nodeIdx]!,
          ann.inscribedRadius[nbr.nodeIdx]!,
        );
        if (minR < req.unit.radiusVoxels) return;
      } else if (nbr.tag === SVO_LEAF_AIR) {
        // Solid → air: the air leaf alone must hold the unit.
        if (ann.inscribedRadius[nbr.nodeIdx]! < req.unit.radiusVoxels) return;
      }
      // Air → solid and solid → solid: no clearance check; the digger's
      // own carve diameter is the only constraint and it's by construction
      // ≥ the unit body.

      const nbrCost = leafCost(
        index.chunks[nbr.chunkKey]!,
        index.annotations[nbr.chunkKey]!,
        nbr.nodeIdx,
        req.unit,
      );
      // enterable() already established canEnter — but the costMult is needed
      // for the edge weight here.
      const nbrCenter = leafCenter(nbr);
      const stepDist = euclidean(curCenter, nbrCenter);
      const tentativeG = curG + stepDist * nbrCost.costMult;
      const prevG = gScore.get(nbrKey);
      if (prevG !== undefined && tentativeG >= prevG) return;
      gScore.set(nbrKey, tentativeG);
      parent.set(nbrKey, curKey);
      leaves.set(nbrKey, nbr);
      const f = tentativeG + weight * euclidean(nbrCenter, goalCenter);
      heap.push(nbrKey, f);
    });
  }

  if (!reached) return { waypoints: [], reached: false, expansions };

  // Reconstruct: walk parents back from goalKey to startKey, then reverse.
  const reverseLeaves: WorldLookup[] = [];
  let k: number | undefined = goalKey;
  while (k !== undefined) {
    reverseLeaves.push(leaves.get(k)!);
    if (k === startKey) break;
    k = parent.get(k);
  }
  reverseLeaves.reverse();

  const waypoints: { x: number; y: number; z: number }[] = [
    { x: req.start.x, y: req.start.y, z: req.start.z },
  ];
  // Skip the start leaf's center waypoint (we already used the actual start
  // position) and the goal leaf's (replaced with the actual goal). The middle
  // leaves contribute their centers.
  for (let i = 1; i < reverseLeaves.length - 1; i++) {
    waypoints.push(leafCenter(reverseLeaves[i]!));
  }
  waypoints.push({ x: req.goal.x, y: req.goal.y, z: req.goal.z });

  return { waypoints, reached: true, expansions };
}

/**
 * Centralised "can the unit enter this leaf" predicate. Combines clearance,
 * dig capability, and (for ground-locked units) presence of a solid floor.
 *
 * Pulled out of the hot loop because the search calls it twice per neighbor
 * (once for the early-reject, once for the cost lookup); inlining the dig
 * branch directly was muddier than it saved.
 */
function enterable(index: SVOIndex, leaf: WorldLookup, unit: UnitTraversal): boolean {
  const cost = leafCost(
    index.chunks[leaf.chunkKey]!,
    index.annotations[leaf.chunkKey]!,
    leaf.nodeIdx,
    unit,
  );
  if (!cost.canEnter) return false;
  if (unit.requiresGround && leaf.tag === SVO_LEAF_AIR) {
    if (!isGrounded(index, leaf)) return false;
  }
  return true;
}

// CHUNK is re-exported for tests that want to inspect leaf alignment.
export { CHUNK };
