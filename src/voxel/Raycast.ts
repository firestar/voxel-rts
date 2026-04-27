import { VOXEL_SIZE, WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { VoxelWorld } from './VoxelWorld';

export interface VoxelHit {
  /** Voxel coords of the hit cell. */
  x: number; y: number; z: number;
  /** Distance along the ray in *meters*. */
  tMeters: number;
  /** Face normal (unit), in voxel space. */
  nx: number; ny: number; nz: number;
}

/**
 * Amanatides & Woo (1987) voxel raycast.
 * `origin` is in meters (world space); `dir` is a unit direction in world space.
 * `maxMeters` caps the traversal distance.
 *
 * Internally we work in voxel units so cell stepping is unit-cost.
 *
 * `maxVoxelY` (optional) is an exclusive ceiling in voxel coords: any solid
 * voxel at y >= maxVoxelY reads as AIR. Used by the Y-axis cutoff overlay
 * so clicks pierce the (visually 5%-opacity) terrain above the cutoff and
 * land on the underground ground that's still rendered solid.
 */
export function raycastVoxel(
  world: VoxelWorld,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxMeters: number,
  maxVoxelY?: number,
): VoxelHit | null {
  const inv = 1 / VOXEL_SIZE;
  // Convert origin to voxel-space (continuous coords; floor() = cell index).
  const ox = origin.x * inv, oy = origin.y * inv, oz = origin.z * inv;
  const dx = dir.x, dy = dir.y, dz = dir.z;

  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  // tDelta: how far (in voxel units along the ray) to traverse one cell on each axis.
  // tMax: distance along the ray to the next cell boundary on each axis.
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  const nextBoundaryX = stepX > 0 ? x + 1 : x;
  const nextBoundaryY = stepY > 0 ? y + 1 : y;
  const nextBoundaryZ = stepZ > 0 ? z + 1 : z;
  let tMaxX = dx !== 0 ? (nextBoundaryX - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? (nextBoundaryY - oy) / dy : Infinity;
  let tMaxZ = dz !== 0 ? (nextBoundaryZ - oz) / dz : Infinity;

  const maxVoxelDist = maxMeters * inv; // ray param maxes out in voxel units
  let nx = 0, ny = 0, nz = 0;
  let tMeters = 0;

  // Step at most ~4*maxVoxelDist times (safety bound).
  const maxSteps = (maxVoxelDist | 0) * 4 + 16;
  for (let i = 0; i < maxSteps; i++) {
    if (x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z) {
      // When a Y-cutoff is active, voxels at or above the cutoff are treated
      // as AIR by this raycast so the click can pierce the see-through
      // overlay and land on the actual underground geometry below.
      if (maxVoxelY === undefined || y < maxVoxelY) {
        const m = world.get(x, y, z);
        if (m !== AIR) {
          return { x, y, z, tMeters, nx, ny, nz };
        }
      }
    }
    // Step on whichever axis crosses the next cell boundary first. Compare
    // BEFORE incrementing tMax{X,Y,Z}: whichever current value is smallest
    // is the next crossing along the ray. Then advance the chosen axis and
    // bump that tMax by its tDelta. The break is keyed off the stepped-onto
    // tMeters (= the smallest tMax), so when even the closest next crossing
    // already lies past the ray's max length we stop — but stepping a tiny
    // sliver on one axis no longer prematurely aborts traversal of the
    // other axes (which was the bug for near-axis-aligned rays like
    // ballistic projectiles fired almost-horizontally).
    let nextT: number;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      nextT = tMaxX;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY <= tMaxZ) {
      nextT = tMaxY;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      nextT = tMaxZ;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
    tMeters = nextT * VOXEL_SIZE;
    if (nextT > maxVoxelDist) break;
  }
  return null;
}
