import { WORLD_X, WORLD_Y, WORLD_Z, AIR, VOXEL_SIZE } from './types';
import { worldIndex } from './VoxelWorld';
import { M_METAL } from './Materials';
import { fbm2 } from '../util/Noise';
import { hash32 } from '../util/Rng';

/**
 * Surface metal-ore pile placement. Each patch is a small dome of M_METAL
 * voxels sitting on top of the existing terrain — fully exposed, no digging
 * required to find it. Workers mine the pile directly; once the surface voxels
 * are gone, nothing is left (no buried reserve).
 *
 * Placement uses the same coarse-grid + fbm-density approach as trees:
 * candidate centres on a regular grid, jittered within each cell, gated by
 * a noise mask so ore clusters into "rich regions" the player can scout.
 */

/** XZ grid spacing for pile candidates (~2× max pile radius so piles rarely overlap). */
const METAL_GRID_SPACING_VOXELS = 64;
/** Density-mask frequency — coarser than trees so ore forms fewer, larger clusters. */
const METAL_DENSITY_FREQ = 1 / 160;
/** fbm threshold: above this → pile spawns. */
const METAL_DENSITY_THRESHOLD = 0.05;

// Large rare clusters: sparse grid, tight noise threshold so only ~5–10% of
// candidate cells actually spawn, giving at most a handful per map.
const LARGE_GRID_SPACING_VOXELS = 256;
const LARGE_DENSITY_FREQ = 1 / 512;
const LARGE_DENSITY_THRESHOLD = 0.35;

export const METAL_PER_VOXEL = 40;

/**
 * A surface ore pile. Workers chip individual voxels one metal at a time;
 * each voxel holds METAL_PER_VOXEL units and disappears once fully mined.
 * `totalMetal` tracks the remaining metal across all voxels for the health bar.
 */
export interface MetalCluster {
  id: number;
  /** Voxel-space ellipsoid centre and radii (for bounding-box scan on destruction). */
  vx: number; vy: number; vz: number;
  rxz: number; ry: number;
  /** Highest solid Y in voxels at placement time (= terrain surface Y). */
  surfaceTop: number;
  /** World-space position of the pile top (for health bar anchoring). */
  worldX: number; worldY: number; worldZ: number;
  voxelCount: number;
  /** Remaining metal across all live voxels (decremented as workers mine). */
  totalMetal: number;
  maxMetal: number;
  destroyed: boolean;
  /** Maximum simultaneous workers; scales with cluster size. */
  maxWorkers: number;
  /** Slot array: workerSlots[i] holds the unit ID of the worker in that slot, 0 = free. */
  workerSlots: number[];
}

export interface MetalGenStats {
  patches: number;
  voxels: number;
  clusters: MetalCluster[];
}

/**
 * Find the Y of the highest non-air voxel in column (wx, wz).
 * Returns -1 when the column is entirely air.
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
  const clusters: MetalCluster[] = [];

  // Normal small piles — frequent but gated by a moderate density threshold.
  for (let cz = 0; cz < WORLD_Z; cz += METAL_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += METAL_GRID_SPACING_VOXELS) {
      const j = hash32(cx, cz, 7, seed + 23173);
      const jx = ((j & 0xff) / 255) * (METAL_GRID_SPACING_VOXELS - 16) + 8;
      const jz = (((j >>> 8) & 0xff) / 255) * (METAL_GRID_SPACING_VOXELS - 16) + 8;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 8 || wz < 8 || wx >= WORLD_X - 8 || wz >= WORLD_Z - 8) continue;

      const dens = fbm2(wx * METAL_DENSITY_FREQ, wz * METAL_DENSITY_FREQ, seed + 4242, 3);
      if (dens < METAL_DENSITY_THRESHOLD) continue;

      const surfaceTop = findSurfaceTop(voxels, wx, wz);
      if (surfaceTop < 0) continue;

      const sizeHash = hash32(wx, wz, 11, seed + 0x51001);
      // Pile dimensions: 3–6 voxels wide (XZ radius), 2–3 voxels tall.
      const rxz = 3 + ((sizeHash >>> 16) & 0x03);  // 3..6
      const ry  = 2 + ((sizeHash >>> 20) & 0x01);  // 2..3
      const stamped = stampSurfacePile(voxels, wx, surfaceTop, wz, rxz, ry, seed + patches);
      if (stamped > 0) {
        clusters.push(makeCluster(clusters.length, wx, surfaceTop, wz, rxz, ry, stamped));
        patches++;
        totalVoxels += stamped;
      }
    }
  }

  // Large rare clusters — very sparse grid, tight noise threshold so only a
  // handful spawn per map. rxz 12..20, ry 6..10 → much larger footprint.
  for (let cz = 0; cz < WORLD_Z; cz += LARGE_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += LARGE_GRID_SPACING_VOXELS) {
      const j = hash32(cx, cz, 13, seed + 0xbeef42);
      const jx = ((j & 0xff) / 255) * (LARGE_GRID_SPACING_VOXELS - 32) + 16;
      const jz = (((j >>> 8) & 0xff) / 255) * (LARGE_GRID_SPACING_VOXELS - 32) + 16;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 24 || wz < 24 || wx >= WORLD_X - 24 || wz >= WORLD_Z - 24) continue;

      const dens = fbm2(wx * LARGE_DENSITY_FREQ, wz * LARGE_DENSITY_FREQ, seed + 0x7777, 4);
      if (dens < LARGE_DENSITY_THRESHOLD) continue;

      const surfaceTop = findSurfaceTop(voxels, wx, wz);
      if (surfaceTop < 0) continue;

      const sizeHash = hash32(wx, wz, 17, seed + 0xc0ffee);
      // Large cluster: 12–20 voxel XZ radius, 6–10 voxels tall.
      const rxz = 12 + ((sizeHash >>> 16) & 0x07);  // 12..19
      const ry  =  6 + ((sizeHash >>> 20) & 0x03);  // 6..9
      const stamped = stampSurfacePile(voxels, wx, surfaceTop, wz, rxz, ry, seed + 0x1000 + patches);
      if (stamped > 0) {
        clusters.push(makeCluster(clusters.length, wx, surfaceTop, wz, rxz, ry, stamped));
        patches++;
        totalVoxels += stamped;
      }
    }
  }

  return { patches, voxels: totalVoxels, clusters };
}

function makeCluster(
  id: number,
  vx: number, surfaceTop: number, vz: number,
  rxz: number, ry: number,
  voxelCount: number,
): MetalCluster {
  // Ellipsoid centre is surfaceTop + ry (same as stampSurfacePile).
  const vy = surfaceTop + ry;
  // World-space top of pile: highest Y the ellipsoid can reach + 1 voxel clearance.
  const worldX = (vx + 0.5) * VOXEL_SIZE;
  const worldY = (surfaceTop + 1 + ry * 2 + 1) * VOXEL_SIZE;
  const worldZ = (vz + 0.5) * VOXEL_SIZE;
  return {
    id, vx, vy, vz, rxz, ry, surfaceTop,
    worldX, worldY, worldZ,
    voxelCount,
    totalMetal: voxelCount * METAL_PER_VOXEL,
    maxMetal: voxelCount * METAL_PER_VOXEL,
    destroyed: false,
    maxWorkers: Math.max(2, Math.floor(rxz / 2)),
    workerSlots: new Array<number>(Math.max(2, Math.floor(rxz / 2))).fill(0),
  };
}

/**
 * Stamp a dome of M_METAL voxels sitting on top of the terrain at
 * `(cx, surfaceTop, cz)`. The ellipsoid is centred at `surfaceTop + ry`
 * so its bottom face grazes the terrain top; only air voxels are replaced,
 * so the pile never buries existing grass or trees.
 */
function stampSurfacePile(
  voxels: Uint8Array,
  cx: number, surfaceTop: number, cz: number,
  rxz: number, ry: number,
  seed: number,
): number {
  // Ellipsoid centre sits ry voxels above the terrain surface so the
  // bottom of the ellipsoid exactly touches surfaceTop + 1.
  const cy = surfaceTop + ry;
  let count = 0;
  for (let dy = 0; dy <= ry * 2; dy++) {
    const y = surfaceTop + 1 + dy;
    if (y >= WORLD_Y) break;
    for (let dz = -rxz; dz <= rxz; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let dx = -rxz; dx <= rxz; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= WORLD_X) continue;
        // Ellipsoid test relative to the dome centre.
        const ex = dx / rxz;
        const ey = (y - cy) / ry;
        const ez = dz / rxz;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
        // Hashed jitter for an organic silhouette.
        const h = hash32(dx, dy, dz, seed);
        const jitter = ((h & 0xff) / 255) * 0.25;
        if (e2 + jitter > 1) continue;
        const idx = worldIndex(x, y, z);
        if (voxels[idx] === AIR) {
          voxels[idx] = M_METAL;
          count++;
        }
      }
    }
  }
  return count;
}
