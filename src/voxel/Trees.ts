import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { worldIndex } from './VoxelWorld';
import { M_GRASS, M_WOOD, M_LEAF } from './Materials';
import { fbm2 } from '../util/Noise';
import { hash32 } from '../util/Rng';

/**
 * Tree placement tunables. The world is iterated in a coarse grid with this spacing
 * (the closest two trees can be is one cell-spacing apart, jittered). Density noise
 * then thins it from there.
 */
const TREE_GRID_SPACING_VOXELS = 24;     // ~3 m minimum spacing
const TREE_DENSITY_FREQ = 1 / 96;        // tree-cluster wavelength (~12 m)
const TREE_DENSITY_THRESHOLD = 0.10;     // raise to thin forests, lower to thicken

export interface TreeShape {
  /** Trunk diameter in voxels (rough). */
  trunkRadius: number;
  /** Trunk height in voxels above the ground. */
  trunkHeight: number;
  /** Canopy radius in voxels. */
  canopyRadius: number;
}

/**
 * Place a forest of procedural trees on grass cells of the already-generated world.
 *
 * Runs single-threaded on the main thread after the parallel worldgen workers are
 * done — trees would otherwise race across worker slab boundaries when a canopy
 * crosses one. This is fast: a 96x96 m world produces ~1k trees, each ~500 voxel
 * writes, so well under a million writes total.
 */
export function placeTrees(voxels: Uint8Array, seed: number): { count: number } {
  let count = 0;
  for (let cz = 0; cz < WORLD_Z; cz += TREE_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += TREE_GRID_SPACING_VOXELS) {
      // Jitter the candidate within its cell so the forest doesn't look gridded.
      const j = hash32(cx, cz, 0, seed + 31337);
      const jx = ((j & 0xff) / 255) * (TREE_GRID_SPACING_VOXELS - 4) + 2;
      const jz = (((j >>> 8) & 0xff) / 255) * (TREE_GRID_SPACING_VOXELS - 4) + 2;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 4 || wz < 4 || wx >= WORLD_X - 4 || wz >= WORLD_Z - 4) continue;

      // Surface must be grass.
      const surfaceY = findGrassTop(voxels, wx, wz);
      if (surfaceY < 0) continue;

      // Density noise — clusters trees into forests rather than uniform spacing.
      const n = fbm2(wx * TREE_DENSITY_FREQ, wz * TREE_DENSITY_FREQ, seed + 7777, 3);
      if (n < TREE_DENSITY_THRESHOLD) continue;

      // Per-tree size variation, hashed so it's stable across re-runs of the same seed.
      const sizeHash = hash32(wx, wz, 1, seed + 12345);
      const shape: TreeShape = {
        trunkRadius: 1 + ((sizeHash >>> 24) & 1),                    // 1..2
        // Trunks tall enough that the canopy bottom sits above the tallest unit's
        // head-clearance requirement (tank heightVoxels = 18). Path search rejects
        // any cell whose air-above-topY is below the unit's height; if the canopy
        // dips into walkable headroom, soldiers + tanks couldn't path past trees
        // and the world becomes a bunch of impassable forests.
        trunkHeight: 18 + ((sizeHash >>> 16) & 0x07),                 // 18..25
        canopyRadius: 6 + ((sizeHash >>> 8) & 0x07),                  // 6..13
      };
      stampTree(voxels, wx, surfaceY, wz, shape, seed + count);
      count++;
    }
  }
  return { count };
}

/** Walk the column at (wx, wz) downward from world top until the first grass voxel. */
function findGrassTop(voxels: Uint8Array, wx: number, wz: number): number {
  for (let y = WORLD_Y - 1; y >= 1; y--) {
    const m = voxels[worldIndex(wx, y, wz)]!;
    if (m === AIR) continue;
    return m === M_GRASS ? y : -1; // first non-air voxel must be grass
  }
  return -1;
}

/**
 * Stamp a single tree into the voxel grid. The trunk is a vertical cylinder of WOOD;
 * the canopy is an ellipsoidal blob of LEAF voxels with hashed jitter so each tree
 * isn't a perfect sphere.
 *
 * Exported so saplings can reuse the same stamping shape when they mature.
 */
export function stampTree(
  voxels: Uint8Array,
  baseX: number, baseY: number, baseZ: number,
  shape: TreeShape,
  seed: number,
): void {
  const trunkR2 = shape.trunkRadius * shape.trunkRadius;
  for (let dy = 1; dy <= shape.trunkHeight; dy++) {
    const y = baseY + dy;
    if (y >= WORLD_Y) break;
    for (let dx = -shape.trunkRadius; dx <= shape.trunkRadius; dx++) {
      for (let dz = -shape.trunkRadius; dz <= shape.trunkRadius; dz++) {
        if (dx * dx + dz * dz > trunkR2) continue;
        const x = baseX + dx, z = baseZ + dz;
        if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) continue;
        voxels[worldIndex(x, y, z)] = M_WOOD;
      }
    }
  }

  // Canopy: ellipsoidal blob centred a bit above the trunk top. Slightly squashed
  // vertically so it sits on top of the trunk like a leafy cap.
  const canopyCx = baseX;
  const canopyCy = baseY + shape.trunkHeight + Math.max(2, shape.canopyRadius - 2);
  const canopyCz = baseZ;
  const r = shape.canopyRadius;
  const rY = Math.max(3, Math.floor(r * 0.85));
  for (let dy = -rY; dy <= rY; dy++) {
    const y = canopyCy + dy;
    if (y < 0 || y >= WORLD_Y) continue;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ex = (dx / r);
        const ey = (dy / rY);
        const ez = (dz / r);
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
        // Hashed jitter — knocks a few voxels off the surface so the canopy looks
        // organic instead of a perfect ellipsoid.
        const h = hash32(dx, dy, dz, seed);
        const jitter = ((h & 0xff) / 255) * 0.18;
        if (e2 + jitter > 1) continue;
        const x = canopyCx + dx, z = canopyCz + dz;
        if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) continue;
        const idx = worldIndex(x, y, z);
        // Don't overwrite trunk wood (where the canopy intersects the top of the trunk).
        if (voxels[idx] === AIR) {
          voxels[idx] = M_LEAF;
        }
      }
    }
  }
}
