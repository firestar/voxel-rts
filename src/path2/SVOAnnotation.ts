import { CHUNK } from '../voxel/types';
import { MATERIALS } from '../voxel/Materials';
import { ChunkSVO, SVO_LEAF_AIR, SVO_LEAF_SOLID } from './SVO';

/**
 * Per-leaf annotations supporting unit traversal queries.
 *
 * Lives parallel to {@link ChunkSVO} — one entry per node, indexed by node
 * index. Recomputed whenever the SVO is rebuilt.
 *
 * Per-leaf is enough for *node-level* gating: "can a unit of radius r occupy
 * this leaf?" Edge-level gating (does the shared face between two leaves fit
 * the unit?) reduces to `min(leafA.inscribedRadius, leafB.inscribedRadius)`,
 * so the same per-leaf data suffices for the abstract graph in Phase 3 — no
 * extra per-edge storage needed for clearance.
 *
 * Headroom and "needs floor" gates are NOT in here. They depend on the leaf's
 * neighbors (vertical face-adjacency), which the abstract graph constructs
 * later. Annotation is purely intrinsic-to-the-leaf properties.
 */

export interface ChunkSVOAnnotation {
  /**
   * For SVO_LEAF_AIR: largest sphere radius (in voxels) that fits inside the
   * leaf. Equals leaf-edge / 2. For SOLID leaves and MIXED nodes, 0.
   *
   * Capped at 255 — irrelevant in practice since CHUNK = 32 → max value 16.
   */
  inscribedRadius: Uint8Array;
  /**
   * For SVO_LEAF_SOLID: 1 if the material is destructible (hp > 0).
   * Tunnelers can enter diggable solids at higher cost; non-digging units
   * cannot enter at all.
   */
  diggable: Uint8Array;
}

export function allocateChunkSVOAnnotation(): ChunkSVOAnnotation {
  return {
    inscribedRadius: new Uint8Array(0),
    diggable: new Uint8Array(0),
  };
}

/**
 * (Re)compute annotations for a chunk SVO. The output arrays are sized to the
 * SVO's current `count` and overwritten in-place when capacity allows. We keep
 * the `ann` object identity stable across rebuilds so callers can hold a
 * reference.
 */
export function annotateChunkSVO(svo: ChunkSVO, ann: ChunkSVOAnnotation): void {
  if (ann.inscribedRadius.length < svo.count) {
    // Grow to match the SVO. Allocate a hair larger so successive rebuilds
    // that nudge the node count up don't reallocate every time.
    const cap = svo.count + (svo.count >> 1) + 8;
    ann.inscribedRadius = new Uint8Array(cap);
    ann.diggable = new Uint8Array(cap);
  } else {
    ann.inscribedRadius.fill(0, 0, svo.count);
    ann.diggable.fill(0, 0, svo.count);
  }
  for (let i = 0; i < svo.count; i++) {
    const tag = svo.tag[i]!;
    if (tag === SVO_LEAF_AIR) {
      // size in voxels = CHUNK / 2^level → radius = size / 2.
      // For level=SVO_MAX_DEPTH the leaf is 1 voxel and radius rounds down to 0
      // (no unit, even a soldier, fits inside a single voxel of air with solid
      // on every side; the predicate correctly rejects it).
      const size = CHUNK >> svo.level[i]!;
      ann.inscribedRadius[i] = (size >> 1) > 255 ? 255 : (size >> 1);
    } else if (tag === SVO_LEAF_SOLID) {
      const mat = MATERIALS[svo.material[i]!];
      if (mat && mat.hp > 0) ann.diggable[i] = 1;
    }
  }
}

/**
 * Per-unit-class traversal parameters. Specified in voxels and unitless cost
 * multipliers — independent of meters / nav-cell conventions, so the rewrite
 * is free to set its own units. Translate at the call site.
 */
export interface UnitTraversal {
  /** Collision sphere radius in voxels. A leaf must have inscribedRadius >= this for the unit to pass. */
  radiusVoxels: number;
  /** True if the unit can dig through destructible solids (tunnelers). */
  canDig: boolean;
  /**
   * Cost multiplier applied when crossing a solid leaf the unit must dig
   * through. Typically 5–20× the air-traversal cost — digging is slow.
   * Unused when `canDig` is false.
   */
  digCostMult: number;
}

export interface LeafCost {
  canEnter: boolean;
  /** Edge-cost multiplier for entering this leaf (1 = baseline). 0 if !canEnter. */
  costMult: number;
}

/**
 * Per-leaf entry predicate. Mixed (non-leaf) nodes are not enterable — query
 * routing must walk down to a leaf first.
 */
export function leafCost(
  svo: ChunkSVO,
  ann: ChunkSVOAnnotation,
  nodeIdx: number,
  unit: UnitTraversal,
): LeafCost {
  const tag = svo.tag[nodeIdx]!;
  if (tag === SVO_LEAF_AIR) {
    return ann.inscribedRadius[nodeIdx]! >= unit.radiusVoxels
      ? { canEnter: true, costMult: 1 }
      : { canEnter: false, costMult: 0 };
  }
  if (tag === SVO_LEAF_SOLID) {
    if (unit.canDig && ann.diggable[nodeIdx] === 1) {
      return { canEnter: true, costMult: unit.digCostMult };
    }
    return { canEnter: false, costMult: 0 };
  }
  return { canEnter: false, costMult: 0 };
}
