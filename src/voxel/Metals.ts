import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { worldIndex } from './VoxelWorld';
import { M_STONE, M_DIRT, M_METAL } from './Materials';
import { fbm2 } from '../util/Noise';
import { hash32 } from '../util/Rng';

/**
 * Underground metal-ore placement. Large blob patches of M_METAL replacing
 * stone (and occasionally dirt) at depth. Patches sit mostly inside the stone
 * column so they're invisible at worldgen time — tunnelers expose them by
 * cutting nearby caves / shafts. A handful spawn near the surface so a fresh
 * map always shows at least some exposed ore for early-game harvesting.
 *
 * Placement runs single-threaded on the main thread after worldgen workers
 * finish, mirroring how placeTrees / placeRoads do it. We pick a coarse XZ
 * grid of candidate centres, gate by an fbm density mask, then stamp each
 * survivor as an irregular ellipsoid blob with hashed jitter.
 */

/** Candidate centres land on this XZ spacing. ~2× the patch radius so two
 *  patches normally don't merge. */
const METAL_GRID_SPACING_VOXELS = 64;
/** Density mask wavelength. Coarser than trees so patches cluster into
 *  "ore-rich regions" the player can scout. */
const METAL_DENSITY_FREQ = 1 / 160;
/** Above-this fbm value spawns a patch; raise to thin, lower to thicken. */
const METAL_DENSITY_THRESHOLD = 0.05;

interface OreShape {
  /** Patch radius in voxels (XZ extent). */
  rxz: number;
  /** Patch radius in voxels (Y extent). Slightly squashed → ellipsoidal. */
  ry: number;
}

export interface MetalGenStats {
  patches: number;
  voxels: number;
}

/**
 * Find the highest non-air voxel in column (wx, wz). -1 if the column is
 * entirely air (shouldn't happen on a generated world, but cheap guard).
 */
function findSurfaceTop(voxels: Uint8Array, wx: number, wz: number): number {
  for (let y = WORLD_Y - 1; y >= 0; y--) {
    if (voxels[worldIndex(wx, y, wz)] !== AIR) return y;
  }
  return -1;
}

export function placeMetals(voxels: Uint8Array, seed: number): MetalGenStats {
  let patches = 0;
  let totalVoxels = 0;
  for (let cz = 0; cz < WORLD_Z; cz += METAL_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += METAL_GRID_SPACING_VOXELS) {
      const j = hash32(cx, cz, 7, seed + 23173);
      // Jitter the patch centre within its cell — same trick trees use.
      const jx = ((j & 0xff) / 255) * (METAL_GRID_SPACING_VOXELS - 16) + 8;
      const jz = (((j >>> 8) & 0xff) / 255) * (METAL_GRID_SPACING_VOXELS - 16) + 8;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 8 || wz < 8 || wx >= WORLD_X - 8 || wz >= WORLD_Z - 8) continue;

      const dens = fbm2(wx * METAL_DENSITY_FREQ, wz * METAL_DENSITY_FREQ, seed + 4242, 3);
      if (dens < METAL_DENSITY_THRESHOLD) continue;

      const surfaceY = findSurfaceTop(voxels, wx, wz);
      if (surfaceY < 12) continue;

      // Depth selection: most patches sit deep inside the stone column. Pick a
      // depth band relative to surface — 60% of patches go medium-deep
      // (16..36 voxels under), 25% shallow (6..16), 15% very deep (36..60).
      // Shallow ones poke out at surface so a fresh map shows ore without
      // requiring a tunneler.
      const sizeHash = hash32(wx, wz, 11, seed + 0x51001);
      const depthRoll = (sizeHash & 0xff) / 255;
      let minDepth: number, maxDepth: number;
      if (depthRoll < 0.25) { minDepth = 4;  maxDepth = 14; }
      else if (depthRoll < 0.85) { minDepth = 16; maxDepth = 36; }
      else                       { minDepth = 36; maxDepth = 60; }
      const depthFrac = ((sizeHash >>> 8) & 0xff) / 255;
      const depth = minDepth + Math.floor((maxDepth - minDepth) * depthFrac);
      const wy = surfaceY - depth;
      if (wy < 6) continue; // keep clear of bedrock floor

      const shape: OreShape = {
        rxz: 4 + ((sizeHash >>> 16) & 0x07),  // 4..11
        ry:  3 + ((sizeHash >>> 20) & 0x03),  // 3..6
      };
      const stamped = stampOreBlob(voxels, wx, wy, wz, shape, seed + patches);
      if (stamped > 0) {
        patches++;
        totalVoxels += stamped;
      }
    }
  }
  return { patches, voxels: totalVoxels };
}

/**
 * Stamp an irregular ellipsoidal ore blob centred at (cx, cy, cz). Only
 * replaces stone or dirt voxels — leaves air, bedrock, grass, etc. alone.
 * Hashed jitter knocks the surface roughness so blobs aren't perfect
 * ellipsoids.
 */
function stampOreBlob(
  voxels: Uint8Array,
  cx: number, cy: number, cz: number,
  shape: OreShape,
  seed: number,
): number {
  let count = 0;
  for (let dy = -shape.ry; dy <= shape.ry; dy++) {
    const y = cy + dy;
    if (y < 4 || y >= WORLD_Y) continue;
    for (let dz = -shape.rxz; dz <= shape.rxz; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let dx = -shape.rxz; dx <= shape.rxz; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= WORLD_X) continue;
        const ex = dx / shape.rxz;
        const ey = dy / shape.ry;
        const ez = dz / shape.rxz;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
        const h = hash32(dx, dy, dz, seed);
        const jitter = ((h & 0xff) / 255) * 0.20;
        if (e2 + jitter > 1) continue;
        const idx = worldIndex(x, y, z);
        const m = voxels[idx]!;
        // Only overwrite stone or dirt — keep caves open and don't bury
        // grass / mud / bedrock under ore.
        if (m === M_STONE || m === M_DIRT) {
          voxels[idx] = M_METAL;
          count++;
        }
      }
    }
  }
  return count;
}
