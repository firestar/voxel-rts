import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { VoxelWorld, worldIndex } from './VoxelWorld';
import {
  M_GRASS, M_DIRT, M_STONE, M_BEDROCK, M_METAL,
} from './Materials';
import { stampTree, TreeShape } from './Trees';
import { MetalCluster, METAL_PER_VOXEL } from './Metals';
import { hash32 } from '../util/Rng';

/**
 * Drop-in worldgen for the AI-debug page. Replaces the noisy heightmap +
 * caves + thousands of trees that {@link generateWorld} produces with a
 * dead-flat plane and a handful of resources, so the AI brain has a
 * minimal-variable sandbox to run in.
 *
 * Layout (constant for every (x, z) column):
 *   y in [0, 4)   bedrock
 *   y in [4, 90)  stone
 *   y in [90, 95) dirt
 *   y = 95        grass
 *   y > 95        air
 *
 * Trees: 12x12 deterministic grid in the central 70% of the map.
 * Metals: 4x4 deterministic grid in the central 60% of the map.
 *
 * Signature matches the `provider` parameter of {@link Game.generate} so
 * the debug entry point can pass this in unchanged.
 */
export async function generateDebugWorld(
  world: VoxelWorld,
  seed: number,
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<MetalCluster[]> {
  const voxels = world.buffers.voxels;
  const GRASS_Y = 95;
  const DIRT_TOP = GRASS_Y - 1;     // 94
  const STONE_TOP = DIRT_TOP - 5;   // 89, so y in [4, 90) is stone
  const BEDROCK_TOP = 3;            // y in [0, 4) is bedrock

  const total = WORLD_X * WORLD_Z;
  let done = 0;
  // Walk columns. Cheap — no noise sampling, no domain warp.
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y <= BEDROCK_TOP; y++) voxels[worldIndex(x, y, z)] = M_BEDROCK;
      for (let y = BEDROCK_TOP + 1; y <= STONE_TOP; y++) voxels[worldIndex(x, y, z)] = M_STONE;
      for (let y = STONE_TOP + 1; y <= DIRT_TOP; y++) voxels[worldIndex(x, y, z)] = M_DIRT;
      voxels[worldIndex(x, GRASS_Y, z)] = M_GRASS;
      done++;
    }
    // Coarse progress every Z row keeps the splash readable without
    // dragging the loop to a halt with per-column updates.
    if (onProgress && (z & 0x1f) === 0) onProgress({ done, total });
  }
  if (onProgress) onProgress({ done: total, total });

  placeDebugTrees(voxels, GRASS_Y, seed);
  const clusters = placeDebugMetals(voxels, GRASS_Y, seed);

  world.markAllDirty();
  return clusters;
}

/**
 * Stamp an evenly-spaced grid of trees that covers the FULL map so every
 * AI base has wood within a chop-focus worker's 32 m voxel scan range.
 *
 * Previous tuning (12×12 in the central 70 %) produced trees only
 * 60–325 m from origin and 60–325 m from the far edge. AI bases spawn at
 * `AI_BASE_RATIOS` corners (0.1 / 0.9), which put every wood voxel
 * ≥ ~40 m from the nearest worker — past the chop scan radius, so wood
 * focus tasks never resolved and the economy stalled.
 *
 * Spacing target: ≤ 24 m between trunks so a worker anywhere on the
 * map is within 32 m of at least one. 16 trees per axis on a 384 m map
 * with a 4 % edge buffer gives ~22 m spacing.
 */
function placeDebugTrees(voxels: Uint8Array, grassY: number, seed: number): void {
  const TREE_COUNT_PER_AXIS = 20;
  const margin = 0.02;
  const x0 = Math.floor(WORLD_X * margin);
  const x1 = Math.floor(WORLD_X * (1 - margin));
  const z0 = Math.floor(WORLD_Z * margin);
  const z1 = Math.floor(WORLD_Z * (1 - margin));
  const stepX = (x1 - x0) / TREE_COUNT_PER_AXIS;
  const stepZ = (z1 - z0) / TREE_COUNT_PER_AXIS;
  let n = 0;
  for (let iz = 0; iz < TREE_COUNT_PER_AXIS; iz++) {
    for (let ix = 0; ix < TREE_COUNT_PER_AXIS; ix++) {
      const wx = Math.floor(x0 + (ix + 0.5) * stepX);
      const wz = Math.floor(z0 + (iz + 0.5) * stepZ);
      const sizeHash = hash32(wx, wz, 1, seed + 12345);
      const shape: TreeShape = {
        trunkRadius: 1 + ((sizeHash >>> 24) & 1),
        trunkHeight: 18 + ((sizeHash >>> 16) & 0x07),
        canopyRadius: 6 + ((sizeHash >>> 8) & 0x07),
      };
      stampTree(voxels, wx, grassY, wz, shape, seed + n);
      n++;
    }
  }
}

/**
 * Stamp an evenly-spaced grid of small ore piles across the FULL map.
 * 8×8 piles on a 384 m world with a 4 % edge buffer = ~48 m spacing,
 * so every AI base has at least one pile within `findBestMineTarget`'s
 * search radius (the cluster finder isn't capped like the chop voxel
 * scan, but having ore near every base keeps walk distances short and
 * the metals economy responsive in the debug sandbox).
 */
function placeDebugMetals(voxels: Uint8Array, grassY: number, seed: number): MetalCluster[] {
  const METAL_COUNT_PER_AXIS = 10;
  const margin = 0.02;
  const x0 = Math.floor(WORLD_X * margin);
  const x1 = Math.floor(WORLD_X * (1 - margin));
  const z0 = Math.floor(WORLD_Z * margin);
  const z1 = Math.floor(WORLD_Z * (1 - margin));
  const stepX = (x1 - x0) / METAL_COUNT_PER_AXIS;
  const stepZ = (z1 - z0) / METAL_COUNT_PER_AXIS;
  const clusters: MetalCluster[] = [];
  for (let iz = 0; iz < METAL_COUNT_PER_AXIS; iz++) {
    for (let ix = 0; ix < METAL_COUNT_PER_AXIS; ix++) {
      const cx = Math.floor(x0 + (ix + 0.5) * stepX);
      const cz = Math.floor(z0 + (iz + 0.5) * stepZ);
      const sizeHash = hash32(cx, cz, 11, seed + 0x51001);
      const rxz = 4 + ((sizeHash >>> 16) & 0x03); // 4..7
      const ry = 2 + ((sizeHash >>> 20) & 0x01);  // 2..3
      const stamped = stampSurfacePileLocal(voxels, cx, grassY, cz, rxz, ry, seed + clusters.length);
      if (stamped > 0) {
        clusters.push(makeClusterLocal(clusters.length, cx, grassY, cz, rxz, ry, stamped));
      }
    }
  }
  return clusters;
}

/**
 * Local copy of `stampSurfacePile` from {@link Metals.ts} — the
 * original isn't exported. Same behaviour: dome of M_METAL voxels
 * sitting on top of `surfaceTop`, ellipsoid jitter for an organic
 * silhouette.
 */
function stampSurfacePileLocal(
  voxels: Uint8Array,
  cx: number, surfaceTop: number, cz: number,
  rxz: number, ry: number,
  seed: number,
): number {
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
        const ex = dx / rxz;
        const ey = (y - cy) / ry;
        const ez = dz / rxz;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
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

/**
 * Local copy of `makeCluster` from {@link Metals.ts}, kept in sync
 * with the upstream signature so the rest of the game (worker focus,
 * health bars, etc.) treats debug-spawned piles identically.
 */
function makeClusterLocal(
  id: number,
  vx: number, surfaceTop: number, vz: number,
  rxz: number, ry: number,
  voxelCount: number,
): MetalCluster {
  const VOXEL_SIZE = 0.125;
  const vy = surfaceTop + ry;
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
