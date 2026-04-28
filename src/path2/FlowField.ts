import { FourAryHeap } from '../util/Heap';
import { SVOIndex, WorldLookup } from './SVOIndex';
import { SVO_LEAF_AIR } from './SVO';
import { UnitTraversal, leafCost } from './SVOAnnotation';
import { forEachFaceNeighbor, isGrounded } from './Neighbors';
import { Vec3 } from './LineOfSight';

/**
 * Goal-anchored flow field over SVO leaves.
 *
 * One reverse Dijkstra from a goal position assigns every reachable leaf a
 * cost-to-goal and a "next leaf" pointer. Hundreds of units converging on
 * the same goal each look up their leaf in O(log N) (SVO query) and read
 * their direction without ever running A*. Cost is independent of unit
 * count — the dominant work is the single Dijkstra build.
 *
 * The field is unit-class specific because traversability and cost depend on
 * the unit (clearance, dig cost, ground requirement). Each unit class that
 * shares the goal needs its own field; if you have one squad, you build one
 * field. Build cost is bounded by `maxExpansions` so far-away regions don't
 * inflate the cost.
 *
 * Use case: RTS player issues "rally to (X, Y, Z)" for a squad. Game runs
 * one buildLeafFlowField; each unit calls flowDirectionAt every tick (or on
 * leaf transition) to know which way to go.
 */

export interface LeafFlowField {
  /**
   * Map from packed leaf key (chunkKey << 16 | nodeIdx) to cost-to-goal.
   * Leaves not in the map are unreachable or beyond the build budget.
   */
  cost: Map<number, number>;
  /**
   * Map from leaf key to the "next" leaf key on the shortest path toward the
   * goal. The goal leaf itself has no next entry. Unreachable leaves have
   * no entry. Use this when steering a unit between leaves.
   */
  next: Map<number, number>;
  unit: UnitTraversal;
  goalPos: Vec3;
  /** The goal leaf's packed key, if it was enterable for the unit. -1 otherwise. */
  goalKey: number;
  /** Number of leaves popped during the build. */
  expanded: number;
}

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

export interface FlowFieldOptions {
  /**
   * Hard cap on Dijkstra expansions. Default 50_000 — enough to cover a few
   * tens of thousands of leaves, comfortably more than a single RTS rally
   * command's reach. Beyond the cap, `cost` and `next` are simply empty for
   * uncovered leaves; consumers fall back to per-unit A*.
   */
  maxExpansions?: number;
}

/**
 * Build a flow field rooted at `goal` for `unit`.
 *
 * Returns an empty-ish field (cost/next empty, goalKey = -1) when the goal
 * leaf is unenterable for the unit. Otherwise runs reverse Dijkstra from
 * the goal until either every connected reachable leaf is settled, or
 * `maxExpansions` is hit.
 */
export function buildLeafFlowField(
  index: SVOIndex,
  goal: Vec3,
  unit: UnitTraversal,
  options: FlowFieldOptions = {},
): LeafFlowField {
  const maxExp = options.maxExpansions ?? 50_000;
  const field: LeafFlowField = {
    cost: new Map(),
    next: new Map(),
    unit,
    goalPos: { ...goal },
    goalKey: -1,
    expanded: 0,
  };

  const goalLeaf = index.queryWorld(goal.x | 0, goal.y | 0, goal.z | 0);
  if (!goalLeaf || !enterable(index, goalLeaf, unit)) return field;

  const goalKey = packKey(goalLeaf.chunkKey, goalLeaf.nodeIdx);
  field.goalKey = goalKey;
  field.cost.set(goalKey, 0);

  const heap = new FourAryHeap(1024);
  heap.push(goalKey, 0);
  // Stash leaf objects so we don't re-query during relaxation.
  const leaves = new Map<number, WorldLookup>();
  leaves.set(goalKey, goalLeaf);
  const closed = new Set<number>();

  while (heap.length > 0 && field.expanded < maxExp) {
    const curKey = heap.pop();
    if (curKey === -1) break;
    if (closed.has(curKey)) continue;
    closed.add(curKey);
    field.expanded++;

    const cur = leaves.get(curKey)!;
    const curG = field.cost.get(curKey)!;
    const curCenter = leafCenter(cur);
    const curAnn = index.annotations[cur.chunkKey]!;

    forEachFaceNeighbor(index, cur, ({ leaf: nbr }) => {
      const nbrKey = packKey(nbr.chunkKey, nbr.nodeIdx);
      if (closed.has(nbrKey)) return;
      if (!enterable(index, nbr, unit)) return;

      // Edge clearance: when traversing from neighbor (forward direction)
      // into cur, both must accommodate the unit if both are air. Solid
      // leaves don't constrain (digger carves them). Mirror the A* gate.
      const nbrAnn = index.annotations[nbr.chunkKey]!;
      if (cur.tag === SVO_LEAF_AIR && nbr.tag === SVO_LEAF_AIR) {
        const minR = Math.min(
          curAnn.inscribedRadius[cur.nodeIdx]!,
          nbrAnn.inscribedRadius[nbr.nodeIdx]!,
        );
        if (minR < unit.radiusVoxels) return;
      } else if (cur.tag === SVO_LEAF_AIR) {
        // Forward direction nbr→cur: cur (the destination) must hold the unit.
        if (curAnn.inscribedRadius[cur.nodeIdx]! < unit.radiusVoxels) return;
      }

      // Reverse-Dijkstra relaxation. The cost charged to step from nbr (in the
      // forward-path sense) into cur is dist × cur.costMult — entering cur is
      // what's paid in the forward direction, and reverse Dijkstra credits
      // that to nbr's cost-to-goal.
      const curEnterCost = leafCost(
        index.chunks[cur.chunkKey]!, curAnn, cur.nodeIdx, unit,
      ).costMult;
      const stepDist = euclidean(curCenter, leafCenter(nbr));
      const tentative = curG + stepDist * curEnterCost;
      const prev = field.cost.get(nbrKey);
      if (prev !== undefined && tentative >= prev) return;
      field.cost.set(nbrKey, tentative);
      field.next.set(nbrKey, curKey);
      leaves.set(nbrKey, nbr);
      heap.push(nbrKey, tentative);
    });
  }

  return field;
}

/**
 * Look up the next-leaf direction for a unit at world coords (wx, wy, wz).
 * Returns:
 *   - { goal: true, ... } if the unit's leaf is the goal (no further step).
 *   - { reached: false } if the unit is in a leaf not covered by the field.
 *   - Otherwise, a Vec3 direction (unit-length) toward the next leaf's center.
 *
 * The direction is from the unit's actual position to the *next leaf's
 * center*, not to the next leaf's nearest face. This makes steering smooth
 * across leaf transitions; a unit that's already past the boundary still
 * gets a sensible direction.
 */
export interface FlowDirection {
  /** True iff the unit's leaf is the goal — no further movement needed. */
  reachedGoal: boolean;
  /** True iff the unit's leaf has a flow entry. False = consumer must fall back to A*. */
  hasFlow: boolean;
  /** Unit-length direction to head toward the next leaf's center. Zero vector when reachedGoal or !hasFlow. */
  dx: number;
  dy: number;
  dz: number;
  /** Cost-to-goal at the unit's current leaf, if hasFlow. Infinity otherwise. */
  costToGoal: number;
}

export function flowDirectionAt(
  index: SVOIndex,
  field: LeafFlowField,
  wx: number, wy: number, wz: number,
): FlowDirection {
  const leaf = index.queryWorld(wx | 0, wy | 0, wz | 0);
  if (!leaf) return { reachedGoal: false, hasFlow: false, dx: 0, dy: 0, dz: 0, costToGoal: Infinity };
  const key = packKey(leaf.chunkKey, leaf.nodeIdx);
  if (key === field.goalKey) {
    return { reachedGoal: true, hasFlow: true, dx: 0, dy: 0, dz: 0, costToGoal: 0 };
  }
  const nextKey = field.next.get(key);
  const cost = field.cost.get(key);
  if (nextKey === undefined || cost === undefined) {
    return { reachedGoal: false, hasFlow: false, dx: 0, dy: 0, dz: 0, costToGoal: Infinity };
  }
  // Decode next leaf's center from the chunk key + nodeIdx → query the SVO.
  // Since this is on the hot path of unit steering we'd cache leaf centers
  // alongside `next`. For now, look up via SVO; the query is O(log N).
  const nextChunkKey = nextKey >>> 16;
  const nextNodeIdx = nextKey & 0xFFFF;
  // We don't have direct (chunkKey → world coords) helper here, so reach
  // into SVOIndex; chunks are stored in the same array as before, so the
  // chunk's coords are derivable from the index. Cheaper: probe the leaf
  // by walking from the recorded `leaf` and following `next` direction.
  // Keep it simple — query at the goal-direction-side face of `leaf`'s
  // bounding box, which is where the next leaf must lie.
  const nextLeafCenter = leafCenterFromKey(index, nextChunkKey, nextNodeIdx);
  if (!nextLeafCenter) return { reachedGoal: false, hasFlow: false, dx: 0, dy: 0, dz: 0, costToGoal: cost };
  const dx = nextLeafCenter.x - wx;
  const dy = nextLeafCenter.y - wy;
  const dz = nextLeafCenter.z - wz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) {
    return { reachedGoal: false, hasFlow: true, dx: 0, dy: 0, dz: 0, costToGoal: cost };
  }
  return { reachedGoal: false, hasFlow: true, dx: dx / len, dy: dy / len, dz: dz / len, costToGoal: cost };
}

import { CHUNK, CHUNKS_X, CHUNKS_Z } from '../voxel/types';
import { forEachLeaf } from './SVO';

/**
 * Resolve a (chunkKey, nodeIdx) pair to that leaf's world-space center by
 * walking the chunk's leaves. Slower than SVO_query (O(N) in chunk leaves)
 * but unambiguous given just the index pair. Used by flowDirectionAt's lookup
 * of the next leaf's position.
 *
 * For hot loops (many units / tick), the right thing is to extend
 * `LeafFlowField` to also store next-leaf centers. That's a follow-up
 * optimization once integration shows it matters.
 */
function leafCenterFromKey(index: SVOIndex, chunkKey: number, nodeIdx: number): Vec3 | null {
  const svo = index.chunks[chunkKey]!;
  // Decompose chunkKey into (cx, cy, cz). chunkKey = (cy * CHUNKS_Z + cz) * CHUNKS_X + cx.
  const cx = chunkKey % CHUNKS_X;
  const layer = (chunkKey / CHUNKS_X) | 0;
  const cz = layer % CHUNKS_Z;
  const cy = (layer / CHUNKS_Z) | 0;

  let found: Vec3 | null = null;
  forEachLeaf(svo, (lx, ly, lz, size, _tag, _mat, idx) => {
    if (idx === nodeIdx && !found) {
      const half = size / 2;
      found = {
        x: cx * CHUNK + lx + half,
        y: cy * CHUNK + ly + half,
        z: cz * CHUNK + lz + half,
      };
    }
  });
  return found;
}
