import { SVOIndex, WorldLookup } from './SVOIndex';
import { SVO_LEAF_SOLID } from './SVO';

/**
 * Geometric face-adjacency iteration on the SVO.
 *
 * Given a leaf, enumerate every leaf that shares one of its 6 faces. Used by
 * the hierarchical search in Phase 4 — each frontier expansion calls
 * forEachFaceNeighbor and applies its own per-unit predicate.
 *
 * No persistent edge graph is materialised. Voxel edits change the SVO
 * (which is dirty-tracked already); neighbor iteration always reads from the
 * fresh SVO, so we don't need a separate dirty channel for the graph layer.
 *
 * Cross-chunk adjacency is handled transparently: when the probe coord lands
 * past the owning chunk's bounds, queryWorld routes to the neighboring
 * chunk's SVO. Out-of-world probes return no neighbor.
 *
 * Mixed-leaf-size adjacency is handled by a scan-line dedupe set: a large
 * leaf face-adjacent to several small leaves emits one event per small leaf;
 * a small leaf face-adjacent to one large leaf emits one event for the large.
 */

/** Axis encoding. Lower 3 bits = positive face (000=+X, 001=+Y, 010=+Z); high bit = negative. */
export const FACE_PX = 0 as const;
export const FACE_NX = 1 as const;
export const FACE_PY = 2 as const;
export const FACE_NY = 3 as const;
export const FACE_PZ = 4 as const;
export const FACE_NZ = 5 as const;

export type FaceAxis =
  | typeof FACE_PX | typeof FACE_NX
  | typeof FACE_PY | typeof FACE_NY
  | typeof FACE_PZ | typeof FACE_NZ;

export interface FaceNeighbor {
  /** Neighbor leaf info (same shape as queryWorld returns). */
  leaf: WorldLookup;
  /** Which of self's faces this neighbor sits across. */
  axis: FaceAxis;
}

/**
 * Visit every face-neighbor leaf of `self`, exactly once per neighbor leaf.
 *
 * The enumeration is geometric — no per-unit gating. Callers compose with
 * `leafCost` from SVOAnnotation to decide whether to follow each neighbor.
 *
 * Duplicate suppression uses a small Set keyed by (chunkKey, nodeIdx). Leaves
 * are octree-aligned, so on a face the smallest neighbor's size dictates how
 * many query points we need; the Set prevents emitting the same large
 * neighbor twice when it spans multiple smaller neighbors' rows.
 */
export function forEachFaceNeighbor(
  index: SVOIndex,
  self: WorldLookup,
  visit: (n: FaceNeighbor) => void,
): void {
  const x0 = self.minWx, y0 = self.minWy, z0 = self.minWz;
  const s = self.size;

  // Each face's probe plane sits one voxel outside the leaf along the face
  // normal. The face spans `s × s` voxels in the two non-normal axes.
  // Order of probing inside scanFace doesn't affect correctness; we keep it
  // (low-axis, high-axis) for readability.

  scanFace(index, x0 + s,    y0,         z0,         0, s, 1, s, FACE_PX, visit);
  scanFace(index, x0 - 1,    y0,         z0,         0, s, 1, s, FACE_NX, visit);
  scanFace(index, x0,        y0 + s,     z0,         1, s, 0, s, FACE_PY, visit);
  scanFace(index, x0,        y0 - 1,     z0,         1, s, 0, s, FACE_NY, visit);
  scanFace(index, x0,        y0,         z0 + s,     2, s, 0, s, FACE_PZ, visit);
  scanFace(index, x0,        y0,         z0 - 1,     2, s, 0, s, FACE_NZ, visit);
}

/**
 * Scan a face plane.
 *
 * (probeX, probeY, probeZ) is the corner of the probe rectangle. The rectangle
 * spans `uExtent × vExtent` voxels in two of the world axes; `uAxis` and
 * `vAxis` are 0=X, 1=Y, 2=Z and must be distinct from each other and from the
 * face normal axis (encoded implicitly in `face`).
 *
 * For each unique neighbor leaf encountered, emits one visit. The leaf-size
 * skip-step on the U axis avoids re-querying inside a leaf we already saw;
 * the cross-row Set dedupe handles the V-axis case where one big leaf covers
 * several rows of smaller leaves.
 */
function scanFace(
  index: SVOIndex,
  probeX: number, probeY: number, probeZ: number,
  uAxis: number, uExtent: number,
  vAxis: number, vExtent: number,
  face: FaceAxis,
  visit: (n: FaceNeighbor) => void,
): void {
  const seen = new Set<number>();
  for (let dv = 0; dv < vExtent; ) {
    let dvAdvance = vExtent - dv;
    for (let du = 0; du < uExtent; ) {
      const wx = probeX + (uAxis === 0 ? du : 0) + (vAxis === 0 ? dv : 0);
      const wy = probeY + (uAxis === 1 ? du : 0) + (vAxis === 1 ? dv : 0);
      const wz = probeZ + (uAxis === 2 ? du : 0) + (vAxis === 2 ? dv : 0);
      const nbr = index.queryWorld(wx, wy, wz);
      if (!nbr) {
        // OOB — entire row to (uExtent, vExtent) is outside the world along
        // this face axis. Bail rather than spin.
        return;
      }
      // Dedupe by (chunkKey, nodeIdx) packed into a single number. chunkKey
      // < 6144 for the current world; nodeIdx < ~32K per chunk; product fits
      // comfortably in a Number's 53-bit safe integer range.
      const key = nbr.chunkKey * 100000 + nbr.nodeIdx;
      if (!seen.has(key)) {
        seen.add(key);
        visit({ leaf: nbr, axis: face });
      }
      // Skip past the neighbor's extent along the U axis. The neighbor's min
      // along U is the probe's U offset minus (probe-U-coord) % size; clamp
      // step to at least 1 so we always make progress.
      const ns = nbr.size;
      const step = ns - (du % ns);
      du += step > 0 ? step : 1;
      // Track the smallest V-extent of any tile in this row so we don't skip
      // past a small leaf when advancing V. The neighbor's V-min mod ns gives
      // its remaining V-extent from our current dv.
      const vRemain = ns - (dv % ns);
      if (vRemain < dvAdvance) dvAdvance = vRemain;
    }
    dv += dvAdvance > 0 ? dvAdvance : 1;
  }
}

/**
 * "Is there solid floor directly under this leaf's min-Y face?" Cheap helper
 * for ground-locked units (soldier, tank, tunneler-not-flying). The probe is a
 * single SVO query — much cheaper than the full neighbor scan.
 *
 * Caveat: only checks the leaf at the probe point. A leaf with a partial
 * floor (only some of its bottom face has solid below) is not detectable
 * without a full face scan — that's left to the search layer if needed.
 */
export function isGrounded(index: SVOIndex, leaf: WorldLookup): boolean {
  if (leaf.minWy <= 0) return false;
  const below = index.queryWorld(leaf.minWx, leaf.minWy - 1, leaf.minWz);
  return below !== null && below.tag === SVO_LEAF_SOLID;
}
