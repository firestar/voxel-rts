import { VoxelWorld, worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../voxel/types';
import { M_WOOD, M_LEAF } from '../voxel/Materials';

/**
 * When a wood voxel is felled, the leaves attached to that branch drift away
 * and rot. We model that with a per-leaf decay timer: 0.3 s after a leaf
 * loses its connection to any wood voxel (through other leaves), it turns to
 * AIR. Cascading — each decayed leaf can disconnect more leaves, which then
 * start their own 0.3 s timers.
 *
 * Connectivity is checked via 6-face flood-fill through M_LEAF voxels seeded
 * from M_WOOD voxels in a search box around the recent edit. Leaves NOT
 * reached by that flood fill are considered disconnected and scheduled for
 * decay. Leaves later reattached to wood (rare — only happens via map edits)
 * have their decay cleared.
 */
export class LeafDecay {
  private static readonly DECAY_SECONDS = 0.3;
  // Tight radius: most canopies are ~12 voxels across; a 12-voxel scan box
  // (25³ = 15 K voxels) captures the connectivity of one tree without
  // burning frame budget. The previous 32-voxel radius (65³ = 274 K) was
  // ~18× more work per call and fell over once a forest started chopping.
  private static readonly SEARCH_RADIUS_VOXELS = 12;
  // Throttle: evaluateRegion is the expensive bit (BFS over a 25³ box). When
  // a worker is felling a tree, every WORK_DPS-sized swing destroys multiple
  // wood voxels per tick and each one wants to re-check the same canopy.
  // Batching by absolute voxel position with a small TTL coalesces those
  // bursts into one evaluation per ~150 ms per region.
  private static readonly EVAL_THROTTLE_SECONDS = 0.15;

  private timers = new Map<number, number>();
  /** Cooldown counters per region key — only used for log-burst throttling. */
  private lastEvalAt = new Map<number, number>();
  private simTime = 0;

  /**
   * Notify the decay system that a wood or leaf voxel was just removed at
   * (vx, vy, vz). Re-evaluates leaves within the search radius and updates
   * decay timers. Cheap when the search box is mostly air.
   */
  onVoxelRemoved(world: VoxelWorld, vx: number, vy: number, vz: number): void {
    // Skip when no leaves live in the small box around the edit. Mining
    // ore, dozing dirt, etc. all funnel through the same hook in Game.ts;
    // most of those calls have nothing to do with leaves and we can return
    // immediately after a quick bbox scan.
    if (!this.regionContainsLeaves(world, vx, vy, vz)) return;
    // Quantise to a coarse grid (8 voxels) to throttle bursts of edits inside
    // the same canopy without losing the per-tree distinction.
    const gx = vx >> 3, gy = vy >> 3, gz = vz >> 3;
    const key = ((gy * 1024) + gz) * 1024 + gx;
    const last = this.lastEvalAt.get(key) ?? -1;
    if (last >= 0 && this.simTime - last < LeafDecay.EVAL_THROTTLE_SECONDS) return;
    this.lastEvalAt.set(key, this.simTime);
    this.evaluateRegion(world, vx, vy, vz);
  }

  /**
   * Decrement timers; destroy leaves whose timer expires. We do NOT cascade
   * with another evaluateRegion when a leaf rots — the original flood fill
   * already scheduled every leaf in the affected canopy, so re-evaluating
   * inside the cascade just rakes the same voxels and burns frame budget.
   */
  tick(world: VoxelWorld, dt: number): void {
    this.simTime += dt;
    // Periodically prune the throttle map so it doesn't grow unbounded over
    // a long session. Cheap O(N) sweep, runs at most once per second.
    if (this.lastEvalAt.size > 1024) {
      const cutoff = this.simTime - LeafDecay.EVAL_THROTTLE_SECONDS * 4;
      for (const [k, t] of this.lastEvalAt) if (t < cutoff) this.lastEvalAt.delete(k);
    }
    if (this.timers.size === 0) return;
    const voxels = world.buffers.voxels;
    const expired: number[] = [];
    for (const [idx, t] of this.timers) {
      // Voxel was already removed by something else (chop, explosion, etc.)
      // — drop the tracking.
      if (voxels[idx] !== M_LEAF) {
        expired.push(idx);
        continue;
      }
      const next = t - dt;
      if (next <= 0) expired.push(idx);
      else this.timers.set(idx, next);
    }
    for (const idx of expired) {
      this.timers.delete(idx);
      if (voxels[idx] !== M_LEAF) continue;
      const { vx, vy, vz } = unpack(idx);
      world.set(vx, vy, vz, AIR);
      // No cascade: every leaf that lost its anchor was scheduled by the
      // original wood-removal flood fill.
    }
  }

  size(): number { return this.timers.size; }

  private regionContainsLeaves(world: VoxelWorld, vx: number, vy: number, vz: number): boolean {
    const voxels = world.buffers.voxels;
    const r = 2; // tiny pre-check — leaves attached to chopped wood sit within ~1 voxel
    const x0 = Math.max(0, vx - r), x1 = Math.min(WORLD_X - 1, vx + r);
    const y0 = Math.max(0, vy - r), y1 = Math.min(WORLD_Y - 1, vy + r);
    const z0 = Math.max(0, vz - r), z1 = Math.min(WORLD_Z - 1, vz + r);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (voxels[worldIndex(x, y, z)] === M_LEAF) return true;
        }
      }
    }
    return false;
  }

  private evaluateRegion(world: VoxelWorld, vx: number, vy: number, vz: number): void {
    const r = LeafDecay.SEARCH_RADIUS_VOXELS;
    const x0 = Math.max(0, vx - r), x1 = Math.min(WORLD_X - 1, vx + r);
    const y0 = Math.max(0, vy - r), y1 = Math.min(WORLD_Y - 1, vy + r);
    const z0 = Math.max(0, vz - r), z1 = Math.min(WORLD_Z - 1, vz + r);
    const voxels = world.buffers.voxels;

    // Seed BFS with leaves directly adjacent to wood. Visiting a leaf marks
    // it as supported.
    const visited = new Set<number>();
    const queue: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const idx = worldIndex(x, y, z);
          if (voxels[idx] !== M_LEAF) continue;
          if (hasAdjacentWood(voxels, x, y, z)) {
            visited.add(idx);
            queue.push(idx);
          }
        }
      }
    }
    // Spread through leaves (6-face). Only consider leaves inside the search
    // box — leaves further out are evaluated by their own region edits.
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const { vx: cx, vy: cy, vz: cz } = unpack(idx);
      const tryNeighbour = (nx: number, ny: number, nz: number): void => {
        if (nx < x0 || ny < y0 || nz < z0 || nx > x1 || ny > y1 || nz > z1) return;
        const nIdx = worldIndex(nx, ny, nz);
        if (visited.has(nIdx)) return;
        if (voxels[nIdx] !== M_LEAF) return;
        visited.add(nIdx);
        queue.push(nIdx);
      };
      tryNeighbour(cx + 1, cy, cz);
      tryNeighbour(cx - 1, cy, cz);
      tryNeighbour(cx, cy + 1, cz);
      tryNeighbour(cx, cy - 1, cz);
      tryNeighbour(cx, cy, cz + 1);
      tryNeighbour(cx, cy, cz - 1);
    }

    // Walk every leaf in the box, schedule unreached ones, clear reached ones.
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const idx = worldIndex(x, y, z);
          if (voxels[idx] !== M_LEAF) continue;
          if (visited.has(idx)) {
            // Reattached (rare) or stays supported. Either way clear any
            // pending decay so the leaf doesn't pop later.
            if (this.timers.has(idx)) this.timers.delete(idx);
          } else if (!this.timers.has(idx)) {
            this.timers.set(idx, LeafDecay.DECAY_SECONDS);
          }
        }
      }
    }
  }
}

function hasAdjacentWood(voxels: Uint8Array, vx: number, vy: number, vz: number): boolean {
  if (vx > 0           && voxels[worldIndex(vx - 1, vy, vz)] === M_WOOD) return true;
  if (vx < WORLD_X - 1 && voxels[worldIndex(vx + 1, vy, vz)] === M_WOOD) return true;
  if (vy > 0           && voxels[worldIndex(vx, vy - 1, vz)] === M_WOOD) return true;
  if (vy < WORLD_Y - 1 && voxels[worldIndex(vx, vy + 1, vz)] === M_WOOD) return true;
  if (vz > 0           && voxels[worldIndex(vx, vy, vz - 1)] === M_WOOD) return true;
  if (vz < WORLD_Z - 1 && voxels[worldIndex(vx, vy, vz + 1)] === M_WOOD) return true;
  return false;
}

/** Inverse of `worldIndex`: linear voxel index → (vx, vy, vz). */
function unpack(idx: number): { vx: number; vy: number; vz: number } {
  const vx = idx % WORLD_X;
  const tmp = (idx - vx) / WORLD_X;
  const vz = tmp % WORLD_Z;
  const vy = (tmp - vz) / WORLD_Z;
  return { vx, vy, vz };
}
