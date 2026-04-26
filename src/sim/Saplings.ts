import { VoxelWorld } from '../voxel/VoxelWorld';
import { worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../voxel/types';
import { M_GRASS, M_WOOD, M_LEAF } from '../voxel/Materials';
import { stampTree, TreeShape } from '../voxel/Trees';
import { hash32 } from '../util/Rng';

/** Time (in seconds) between planting and maturation into a full tree. */
export const SAPLING_MATURE_SEC = 30;

export interface Sapling {
  /** Voxel-space position of the sapling's base (the grass voxel underneath). */
  vx: number; vy: number; vz: number;
  ageSec: number;
  /** Hashed seed used for the eventual stampTree call so size variation is stable. */
  seed: number;
}

export interface PlantResult {
  ok: boolean;
  reason?: string;
}

/**
 * Saplings: short-lived, in-memory entities that occupy 1–2 voxels of marker
 * geometry, age each tick, and finally stamp a full tree once mature. Workers
 * "plant" by calling `plant(world, wx, wz)`; players can also direct a worker
 * to plant via the plant-mode click in `Game.ts`.
 */
export class SaplingManager {
  saplings: Sapling[] = [];

  /**
   * Drop a sapling at the world-space (wx, wz). Finds the topmost grass voxel
   * in the column and writes a tiny wood + leaf marker on top so the player
   * sees something happen immediately. Returns ok=false (with a reason) when
   * there's no grass surface to plant on or the spot already has another
   * sapling within 1 voxel.
   */
  plant(world: VoxelWorld, wx: number, wz: number, rngSeed: number): PlantResult {
    const vx = Math.floor(wx);
    const vz = Math.floor(wz);
    if (vx < 1 || vz < 1 || vx >= WORLD_X - 1 || vz >= WORLD_Z - 1) {
      return { ok: false, reason: 'out of bounds' };
    }
    const surfaceY = findGrassTop(world.buffers.voxels, vx, vz);
    if (surfaceY < 0) return { ok: false, reason: 'no grass' };

    // Reject if another sapling already lives within 1 voxel — keeps a player
    // (or runaway worker) from spamming the same cell.
    for (const s of this.saplings) {
      const dx = s.vx - vx;
      const dz = s.vz - vz;
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
        return { ok: false, reason: 'too close to existing sapling' };
      }
    }

    // Stamp a 2-voxel-tall trunk + a single leaf cap on top so the sapling
    // is visible even before it matures.
    const yStem = surfaceY + 1;
    if (yStem + 2 < WORLD_Y) {
      world.set(vx, yStem, vz, M_WOOD);
      world.set(vx, yStem + 1, vz, M_WOOD);
      world.set(vx, yStem + 2, vz, M_LEAF);
    }

    this.saplings.push({
      vx, vy: surfaceY, vz,
      ageSec: 0,
      seed: rngSeed,
    });
    return { ok: true };
  }

  /**
   * Advance time. Saplings whose age crosses SAPLING_MATURE_SEC stamp a full
   * tree (using the same `stampTree` Trees.ts uses) and are removed from the
   * tracked list. Returns the count that matured this tick — callers use that
   * to decide whether to schedule a nav rebuild (matured trees raise canopy
   * heights into walkable headroom).
   */
  tick(dt: number, world: VoxelWorld): { matured: number } {
    let matured = 0;
    for (let i = this.saplings.length - 1; i >= 0; i--) {
      const s = this.saplings[i]!;
      s.ageSec += dt;
      if (s.ageSec < SAPLING_MATURE_SEC) continue;

      // Mature: clear the marker we stamped at plant time so the trunk
      // doesn't end up with a stray leaf voxel mid-trunk, then stamp a full
      // tree at the base. Use the same hash-based shape variation as
      // worldgen-placed trees.
      for (let dy = 1; dy <= 2; dy++) {
        const y = s.vy + dy;
        if (y >= 0 && y < WORLD_Y) world.set(s.vx, y, s.vz, AIR);
      }
      const yLeaf = s.vy + 3;
      if (yLeaf >= 0 && yLeaf < WORLD_Y) world.set(s.vx, yLeaf, s.vz, AIR);

      const sizeHash = hash32(s.vx, s.vz, 1, s.seed);
      const shape: TreeShape = {
        trunkRadius: 1 + ((sizeHash >>> 24) & 1),
        trunkHeight: 18 + ((sizeHash >>> 16) & 0x07),
        canopyRadius: 6 + ((sizeHash >>> 8) & 0x07),
      };
      stampTree(world.buffers.voxels, s.vx, s.vy, s.vz, shape, s.seed);
      // stampTree writes to the raw voxel buffer — mark chunks dirty so the
      // mesher picks them up. Conservatively dirty a column wide enough to
      // cover the canopy.
      const r = shape.canopyRadius + 1;
      for (let dz = -r; dz <= r; dz += 8) {
        for (let dx = -r; dx <= r; dx += 8) {
          for (let dy = 0; dy <= shape.trunkHeight + r; dy += 8) {
            world.markDirty(
              clamp(s.vx + dx, 0, WORLD_X - 1),
              clamp(s.vy + dy, 0, WORLD_Y - 1),
              clamp(s.vz + dz, 0, WORLD_Z - 1),
            );
          }
        }
      }

      // Pop in O(1) — order doesn't matter.
      const last = this.saplings[this.saplings.length - 1]!;
      this.saplings[i] = last;
      this.saplings.pop();
      matured++;
    }
    return { matured };
  }
}

function findGrassTop(voxels: Uint8Array, vx: number, vz: number): number {
  for (let y = WORLD_Y - 1; y >= 1; y--) {
    const m = voxels[worldIndex(vx, y, vz)]!;
    if (m === AIR) continue;
    if (m === M_WOOD || m === M_LEAF) return -1; // canopy/trunk: not bare ground
    return m === M_GRASS ? y : -1;
  }
  return -1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
