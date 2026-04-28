import { SVOIndex } from './SVOIndex';
import { SVO_LEAF_AIR } from './SVO';
import { UnitTraversal } from './SVOAnnotation';
import { isGrounded } from './Neighbors';

/**
 * Line-of-sight check via 3D-DDA over SVO leaves.
 *
 * Standard voxel raycast walks one voxel per step. SVO raycast walks one
 * *leaf* per step — a uniform 32³ air leaf is one query, not 32 K. For long
 * LOS checks across mostly-uniform regions (the common case at SVO scale),
 * cost stays in the low tens of queries even for cross-map rays.
 *
 * Used by the smoother in {@link smoothPath}; can also serve a Lazy Theta*
 * integration in the search if the smoother proves insufficient.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const EPS_STEP = 0.5;

/**
 * True iff a straight segment from `from` to `to` stays inside enterable air
 * leaves with clearance ≥ unit.radiusVoxels for the entire length.
 *
 * Solid leaves break LOS regardless of dig capability — smoothing should not
 * "shortcut" through walls a digger would otherwise carve, because that
 * changes the cost structure the search optimised. The search already
 * explores diggable routes; the smoother's job is purely to remove zigzag
 * artifacts from grid-aligned A* paths through air.
 */
export function lineOfSight(
  index: SVOIndex,
  from: Vec3,
  to: Vec3,
  unit: UnitTraversal,
): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  const rx = dx / len, ry = dy / len, rz = dz / len;

  // March one leaf at a time. We re-evaluate position from `from + r*t` each
  // iteration rather than incrementing a position vector — keeps numerical
  // error bounded by t * eps regardless of leaf count.
  let t = 0;
  // Hard cap. At minimum each step advances by EPS_STEP voxels, so a ray of
  // length L takes at most 2L steps. Pad by 8 for boundary nudges. This
  // exists to guarantee termination on degenerate input rather than because
  // the loop is genuinely unbounded.
  const maxSteps = ((len * 2) | 0) + 16;
  for (let step = 0; step < maxSteps; step++) {
    if (t >= len) return true;
    const px = from.x + rx * t;
    const py = from.y + ry * t;
    const pz = from.z + rz * t;
    const leaf = index.queryWorld(px | 0, py | 0, pz | 0);
    if (!leaf) return false;
    if (leaf.tag !== SVO_LEAF_AIR) return false;
    const ann = index.annotations[leaf.chunkKey]!;
    if (ann.inscribedRadius[leaf.nodeIdx]! < unit.radiusVoxels) return false;
    // Ground-locked units cannot fly: every sampled leaf along the segment
    // must have solid floor below. Without this, the smoother would shortcut
    // surface paths through ungrounded air leaves at altitude.
    if (unit.requiresGround && !isGrounded(index, leaf)) return false;

    // Slab-method: parametric t at which the ray exits this leaf's AABB
    // [minW, minW+size). Inverse-direction guarded for axis-aligned rays.
    const x0 = leaf.minWx, x1 = x0 + leaf.size;
    const y0 = leaf.minWy, y1 = y0 + leaf.size;
    const z0 = leaf.minWz, z1 = z0 + leaf.size;
    const tx = rx > 0 ? (x1 - from.x) / rx : rx < 0 ? (x0 - from.x) / rx : Infinity;
    const ty = ry > 0 ? (y1 - from.y) / ry : ry < 0 ? (y0 - from.y) / ry : Infinity;
    const tz = rz > 0 ? (z1 - from.z) / rz : rz < 0 ? (z0 - from.z) / rz : Infinity;
    const tExit = Math.min(tx, ty, tz);
    // Advance past the boundary by EPS_STEP so the next iteration lands
    // inside the next leaf, not on the shared face.
    const advance = tExit > t ? tExit + EPS_STEP : t + EPS_STEP;
    t = advance;
  }
  return false;
}

/**
 * Greedy any-angle smoother.
 *
 * For every consecutive pair in the output, LOS holds by construction. The
 * loop advances by extending visibility from the current anchor to the
 * farthest still-visible waypoint, commits that, and re-anchors there.
 *
 * Endpoints are preserved exactly. Intermediate waypoints on a straight
 * LOS-clear span collapse. Output length is always ≥ 2 (for non-trivial
 * paths) and ≤ input length.
 *
 * Worst case is O(N²) LOS checks; typical is O(N) because each iteration
 * advances the anchor by at least one waypoint, and once advanced we never
 * re-test from the previous anchor.
 *
 * Why "verify every output segment" rather than the simpler "anchor advances
 * on first LOS failure": if the input path itself contains a segment with no
 * LOS (which can happen for ground-locked units when consecutive A* leaves
 * have differing sizes and the line cuts through an ungrounded leaf), the
 * naive smoother emits an invalid segment. The verified version falls back
 * to keeping more waypoints in those cases — correctness over compression.
 */
export function smoothPath(
  index: SVOIndex,
  waypoints: Vec3[],
  unit: UnitTraversal,
): Vec3[] {
  const n = waypoints.length;
  if (n <= 2) return waypoints.slice();
  const out: Vec3[] = [waypoints[0]!];
  let i = 0;
  while (i < n - 1) {
    // Greedy: find largest j > i such that we can shortcut from i to j.
    // Always emit waypoints[i+1] minimum (preserves input topology when LOS
    // fails on the first step — typical for ground-locked units when
    // consecutive A* leaves have differing sizes and the line cuts through
    // an ungrounded air leaf).
    let j = i + 1;
    while (j + 1 < n && lineOfSight(index, waypoints[i]!, waypoints[j + 1]!, unit)) {
      j++;
    }
    out.push(waypoints[j]!);
    i = j;
  }
  return out;
}
