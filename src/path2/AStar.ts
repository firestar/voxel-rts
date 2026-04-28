import { FourAryHeap } from '../util/Heap';
import { SVOIndex, WorldLookup } from './SVOIndex';
import {
  UnitTraversal, leafCost,
} from './SVOAnnotation';
import { forEachFaceNeighbor, isGrounded } from './Neighbors';
import { CHUNK } from '../voxel/types';
import { SVO_LEAF_AIR } from './SVO';

/**
 * Bidirectional weighted A* over SVO leaves.
 *
 * Two searches run in tandem — one forward from `start`, one backward from
 * `goal`. First-meet termination: when one side expands a node the other has
 * already closed, stitch the two halves. For long, mostly-symmetric routes
 * this roughly halves expansions vs single-direction A*. Path quality
 * matches the existing pathfinder's bidirectional weighted A* (sub-optimal
 * by at most ε for ε ≥ 1).
 *
 * Edges are enumerated on demand by `forEachFaceNeighbor` — no persistent
 * graph. The SVO already gives "hierarchy for free": a 32³ uniform-air leaf
 * is one expansion, not 32 K voxels. For mostly-uniform terrain, expansion
 * counts stay in the low tens.
 *
 * Edge cost is symmetric: `euclidean × max(curCostMult, nbrCostMult)`. This
 * is mildly pessimistic for digger paths (a one-way air→solid step costs
 * the dig multiplier even though entering air is free), but symmetry is
 * required for bidirectional first-meet correctness on non-trivial cost
 * fields. Mirrors the convention in `src/path/AStar.ts`.
 */

export interface PathRequest {
  /** Start position in world voxel coordinates. */
  start: { x: number; y: number; z: number };
  /** Goal position in world voxel coordinates. */
  goal: { x: number; y: number; z: number };
  unit: UnitTraversal;
  /**
   * Heuristic weight ε ≥ 1. ε=1 → optimal (slow); ε=1.5 → up to 50%
   * suboptimal but a forward-biased fan from each end dramatically cuts
   * expansions. Mirrors the existing pathfinder's convention. Default 1.5.
   */
  heuristicWeight?: number;
  /**
   * Hard cap on expansions across both sides combined. Returns failure when
   * exceeded. Default 50_000.
   */
  maxExpansions?: number;
}

export interface PathResult {
  /**
   * Leaf-center world voxel waypoints from start to goal, inclusive. Empty
   * when `reached` is false. Consecutive pairs lie in face-adjacent passable
   * leaves so a unit can lerp between them.
   */
  waypoints: { x: number; y: number; z: number }[];
  reached: boolean;
  /** Total leaves popped across both forward and backward sides. */
  expansions: number;
}

interface Vec3 { x: number; y: number; z: number; }

interface SearchSide {
  heap: FourAryHeap;
  g: Map<number, number>;
  parent: Map<number, number>;
  closed: Set<number>;
  leaves: Map<number, WorldLookup>;
  /** Heuristic target (the *other* side's start). */
  targetCenter: Vec3;
}

/** Pack (chunkKey, nodeIdx) into one int32. chunkKey ≤ 6 K, nodeIdx ≤ 32 K. */
function packKey(chunkKey: number, nodeIdx: number): number {
  return (chunkKey << 16) | (nodeIdx & 0xFFFF);
}

function leafCenter(leaf: WorldLookup): Vec3 {
  const half = leaf.size / 2;
  return { x: leaf.minWx + half, y: leaf.minWy + half, z: leaf.minWz + half };
}

function euclidean(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

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

function makeSide(targetCenter: Vec3): SearchSide {
  return {
    heap: new FourAryHeap(1024),
    g: new Map(),
    parent: new Map(),
    closed: new Set(),
    leaves: new Map(),
    targetCenter,
  };
}

/**
 * Find a path from `req.start` to `req.goal` for `req.unit` using
 * bidirectional weighted A*. Returns `reached: false` when no path exists
 * within the expansion budget, or when start/goal lies in a non-enterable
 * leaf.
 *
 * Waypoints interpolate the start and goal positions exactly: the first is
 * `req.start`, the last is `req.goal`, with leaf centers in between.
 */
export function findPath(index: SVOIndex, req: PathRequest): PathResult {
  const weight = req.heuristicWeight ?? 1.5;
  const maxExp = req.maxExpansions ?? 50_000;

  const startLeaf = index.queryWorld(req.start.x | 0, req.start.y | 0, req.start.z | 0);
  const goalLeaf = index.queryWorld(req.goal.x | 0, req.goal.y | 0, req.goal.z | 0);
  if (!startLeaf || !goalLeaf) return { waypoints: [], reached: false, expansions: 0 };
  if (!enterable(index, startLeaf, req.unit) || !enterable(index, goalLeaf, req.unit)) {
    return { waypoints: [], reached: false, expansions: 0 };
  }

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

  const startCenter = leafCenter(startLeaf);
  const goalCenter = leafCenter(goalLeaf);

  const fwd = makeSide(goalCenter);
  const bwd = makeSide(startCenter);

  fwd.g.set(startKey, 0);
  fwd.leaves.set(startKey, startLeaf);
  fwd.heap.push(startKey, weight * euclidean(startCenter, goalCenter));

  bwd.g.set(goalKey, 0);
  bwd.leaves.set(goalKey, goalLeaf);
  bwd.heap.push(goalKey, weight * euclidean(goalCenter, startCenter));

  let expansions = 0;
  let meetKey = -1;

  while (fwd.heap.length > 0 && bwd.heap.length > 0 && expansions < maxExp) {
    // Expand the side with the lower min f. Empty heap pushes that side to
    // infinity so we always pull from the live one.
    const fTop = fwd.heap.length > 0 ? fwd.heap.topPriority() : Infinity;
    const bTop = bwd.heap.length > 0 ? bwd.heap.topPriority() : Infinity;
    const side = fTop <= bTop ? fwd : bwd;
    const other = side === fwd ? bwd : fwd;

    const curKey = side.heap.pop();
    if (curKey === -1) break;
    if (side.closed.has(curKey)) continue;
    side.closed.add(curKey);
    expansions++;

    // First-meet termination: this node was already settled by the other
    // side. Stitch the two halves through it.
    if (other.closed.has(curKey)) {
      meetKey = curKey;
      break;
    }

    const cur = side.leaves.get(curKey)!;
    const curG = side.g.get(curKey)!;
    const curCenter = leafCenter(cur);
    const ownAnn = index.annotations[cur.chunkKey]!;
    const curCostMult = leafCost(
      index.chunks[cur.chunkKey]!, ownAnn, cur.nodeIdx, req.unit,
    ).costMult;

    forEachFaceNeighbor(index, cur, ({ leaf: nbr }) => {
      const nbrKey = packKey(nbr.chunkKey, nbr.nodeIdx);
      if (side.closed.has(nbrKey)) return;
      if (!enterable(index, nbr, req.unit)) return;

      // Edge clearance: only constrains pairs of air leaves. Solid leaves
      // are carved out by the digger, so their inscribedRadius=0 doesn't
      // bound the bottleneck.
      const nbrAnn = index.annotations[nbr.chunkKey]!;
      if (cur.tag === SVO_LEAF_AIR && nbr.tag === SVO_LEAF_AIR) {
        const minR = Math.min(
          ownAnn.inscribedRadius[cur.nodeIdx]!,
          nbrAnn.inscribedRadius[nbr.nodeIdx]!,
        );
        if (minR < req.unit.radiusVoxels) return;
      } else if (nbr.tag === SVO_LEAF_AIR) {
        if (nbrAnn.inscribedRadius[nbr.nodeIdx]! < req.unit.radiusVoxels) return;
      }

      const nbrCostMult = leafCost(
        index.chunks[nbr.chunkKey]!, nbrAnn, nbr.nodeIdx, req.unit,
      ).costMult;
      // Symmetric edge cost — both forward and backward searches must agree
      // on the cost of traversing this edge for first-meet stitching to
      // produce a path with consistent g-scores.
      const edgeMult = curCostMult > nbrCostMult ? curCostMult : nbrCostMult;
      const nbrCenter = leafCenter(nbr);
      const stepDist = euclidean(curCenter, nbrCenter);
      const tentativeG = curG + stepDist * edgeMult;
      const prevG = side.g.get(nbrKey);
      if (prevG !== undefined && tentativeG >= prevG) return;
      side.g.set(nbrKey, tentativeG);
      side.parent.set(nbrKey, curKey);
      side.leaves.set(nbrKey, nbr);
      const f = tentativeG + weight * euclidean(nbrCenter, side.targetCenter);
      side.heap.push(nbrKey, f);
    });
  }

  if (meetKey === -1) return { waypoints: [], reached: false, expansions };

  // Stitch: walk fwd parents from meet → start (reverse and prepend), then
  // walk bwd parents from meet → goal (forward and append, skipping meet).
  const leafFor = (k: number): WorldLookup => fwd.leaves.get(k) ?? bwd.leaves.get(k)!;
  const fullPath: WorldLookup[] = [];
  {
    const rev: WorldLookup[] = [];
    let k: number | undefined = meetKey;
    while (k !== undefined) {
      rev.push(leafFor(k));
      if (k === startKey) break;
      k = fwd.parent.get(k);
    }
    rev.reverse();
    for (const l of rev) fullPath.push(l);
  }
  {
    let k = bwd.parent.get(meetKey);
    while (k !== undefined) {
      fullPath.push(leafFor(k));
      if (k === goalKey) break;
      k = bwd.parent.get(k);
    }
  }

  const waypoints: Vec3[] = [{ x: req.start.x, y: req.start.y, z: req.start.z }];
  for (let i = 1; i < fullPath.length - 1; i++) {
    waypoints.push(leafCenter(fullPath[i]!));
  }
  // If meetKey == goalKey the bwd loop produced no nodes after meet, so the
  // last fullPath entry is the goal leaf; otherwise the loop ran until goalKey
  // was appended. Either way, the path ends at the goal leaf.
  waypoints.push({ x: req.goal.x, y: req.goal.y, z: req.goal.z });

  return { waypoints, reached: true, expansions };
}

// CHUNK is re-exported for tests that want to inspect leaf alignment.
export { CHUNK };
