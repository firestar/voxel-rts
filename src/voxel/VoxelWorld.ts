import {
  WORLD_X, WORLD_Y, WORLD_Z, CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_COUNT,
  AIR, MaterialId, chunkKey,
} from './types';
import { MATERIALS, M_BEDROCK } from './Materials';

// Linear voxel index in the entire world (Y-major, then Z, then X).
// Chosen so that horizontal slabs are contiguous (cache-friendly heightmap fill, Y-axis greedy sweeps).
export function worldIndex(x: number, y: number, z: number): number {
  return (y * WORLD_Z + z) * WORLD_X + x;
}

export const WORLD_VOLUME = WORLD_X * WORLD_Y * WORLD_Z;

export interface WorldBuffers {
  /** Material id per voxel (0 = air). */
  voxels: Uint8Array;
  /** Per-chunk dirty flag (1 byte). Set by edits, cleared by mesher. */
  dirty: Uint8Array;
  /** Per-chunk mesh version, bumped each remesh. Used by renderer to detect updates. */
  version: Int32Array;
}

export function allocateWorldBuffers(useShared: boolean): WorldBuffers {
  const Buf = useShared && typeof SharedArrayBuffer !== 'undefined'
    ? SharedArrayBuffer
    : ArrayBuffer;
  const voxels = new Uint8Array(new Buf(WORLD_VOLUME));
  const dirty = new Uint8Array(new Buf(CHUNK_COUNT));
  const version = new Int32Array(new Buf(CHUNK_COUNT * 4));
  return { voxels, dirty, version };
}

export interface DestroyedVoxel {
  x: number; y: number; z: number;
  /** The material that was destroyed, before it was set to air. */
  material: MaterialId;
}

export interface ExplosionResult {
  destroyed: DestroyedVoxel[];
  /** Number of voxels touched (damaged or destroyed). */
  touched: number;
}

export class VoxelWorld {
  readonly buffers: WorldBuffers;
  /** Sparse cumulative damage. Key = worldIndex, value = damage so far in [0, 255]. */
  readonly damage = new Map<number, number>();

  constructor(buffers: WorldBuffers) {
    this.buffers = buffers;
  }

  static create(useShared = true): VoxelWorld {
    return new VoxelWorld(allocateWorldBuffers(useShared));
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z;
  }

  get(x: number, y: number, z: number): MaterialId {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.buffers.voxels[worldIndex(x, y, z)]!;
  }

  set(x: number, y: number, z: number, m: MaterialId): void {
    if (!this.inBounds(x, y, z)) return;
    this.buffers.voxels[worldIndex(x, y, z)] = m;
    this.markDirty(x, y, z);
  }

  /**
   * Spherical explosion with quadratic falloff.
   * Per-voxel damage = peak * (1 - (d/r)^2). Voxels destroyed when cumulative damage >= material HP.
   * Indestructible materials (hp == 0, e.g. bedrock) are skipped.
   *
   * `cx, cy, cz` are in voxel coordinates.
   */
  damageSphere(cx: number, cy: number, cz: number, radius: number, peakDamage: number): ExplosionResult {
    const result: ExplosionResult = { destroyed: [], touched: 0 };
    const r = Math.max(0.1, radius);
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const z0 = Math.max(0, Math.floor(cz - r));
    const x1 = Math.min(WORLD_X - 1, Math.ceil(cx + r));
    const y1 = Math.min(WORLD_Y - 1, Math.ceil(cy + r));
    const z1 = Math.min(WORLD_Z - 1, Math.ceil(cz + r));
    const voxels = this.buffers.voxels;

    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let z = z0; z <= z1; z++) {
        const dz = z + 0.5 - cz;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const idx = worldIndex(x, y, z);
          const m = voxels[idx]!;
          if (m === AIR) continue;
          const mat = MATERIALS[m]!;
          if (mat.hp === 0) continue; // indestructible (bedrock, air sentinel)
          result.touched++;
          const falloff = 1 - d2 / r2;
          const dmg = Math.max(1, Math.min(255, Math.round(peakDamage * falloff)));
          const prev = this.damage.get(idx) ?? 0;
          const total = prev + dmg;
          if (total >= mat.hp) {
            voxels[idx] = AIR;
            this.damage.delete(idx);
            this.markDirty(x, y, z);
            result.destroyed.push({ x, y, z, material: m });
          } else {
            this.damage.set(idx, total);
          }
        }
      }
    }
    return result;
  }

  /**
   * Oriented cylinder damage. The cylinder's axis is `(ax, ay, az)` (unit length), the
   * cylinder extends from `-halfLength` to `+halfLength` along that axis from `(cx, cy, cz)`,
   * and `radius` is its perpendicular half-extent. All inputs in voxel units.
   *
   * Used by the tunneler so the carve hugs the blade face instead of being a fat sphere
   * that digs out the ground around it.
   */
  damageOrientedCylinder(
    cx: number, cy: number, cz: number,
    ax: number, ay: number, az: number,
    halfLength: number, radius: number,
    peakDamage: number,
    minYVoxels: number = -Infinity,
  ): ExplosionResult {
    const result: ExplosionResult = { destroyed: [], touched: 0 };
    const halfLen = Math.max(0.1, halfLength);
    const r = Math.max(0.1, radius);
    const r2 = r * r;
    // Bounding box of the oriented cylinder = bounding sphere of radius (halfLen + r).
    const bound = halfLen + r;
    const x0 = Math.max(0, Math.floor(cx - bound));
    const y0 = Math.max(0, Math.floor(cy - bound));
    const z0 = Math.max(0, Math.floor(cz - bound));
    const x1 = Math.min(WORLD_X - 1, Math.ceil(cx + bound));
    const y1 = Math.min(WORLD_Y - 1, Math.ceil(cy + bound));
    const z1 = Math.min(WORLD_Z - 1, Math.ceil(cz + bound));
    const voxels = this.buffers.voxels;

    // Hard floor for the carve. Lets the tunneler cap its cutter so the disc-shaped
    // carve volume never bites voxels below the unit's body bottom (which would dig
    // out the floor under the unit and have it sink into its own hole).
    const yFloor = Math.max(y0, Math.ceil(minYVoxels));
    for (let y = yFloor; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let z = z0; z <= z1; z++) {
        const dz = z + 0.5 - cz;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx;
          // Project onto axis.
          const t = dx * ax + dy * ay + dz * az;
          if (t < -halfLen || t > halfLen) continue;
          // Radial distance² (subtract axial component).
          const px = dx - t * ax;
          const py = dy - t * ay;
          const pz = dz - t * az;
          const rad2 = px * px + py * py + pz * pz;
          if (rad2 > r2) continue;
          const idx = worldIndex(x, y, z);
          const m = voxels[idx]!;
          if (m === AIR) continue;
          const mat = MATERIALS[m]!;
          if (mat.hp === 0) continue;
          result.touched++;
          const dmg = Math.max(1, Math.min(255, peakDamage));
          const prev = this.damage.get(idx) ?? 0;
          const total = prev + dmg;
          if (total >= mat.hp) {
            voxels[idx] = AIR;
            this.damage.delete(idx);
            this.markDirty(x, y, z);
            result.destroyed.push({ x, y, z, material: m });
          } else {
            this.damage.set(idx, total);
          }
        }
      }
    }
    return result;
  }

  /**
   * Cut every non-bedrock voxel above `targetY` to AIR, and fill every AIR voxel from
   * `targetY` down to the first existing solid voxel with `fillMaterial`. Used by the
   * dozer to level a single column to a target Y while driving through it.
   *
   * Returns the number of voxels cut (above targetY) and filled (at/below targetY) so
   * the caller can update the dozer's spoil bookkeeping.
   */
  editColumnToY(wx: number, wz: number, targetY: number, fillMaterial: MaterialId): { cut: number; filled: number } {
    const out = { cut: 0, filled: 0 };
    if (wx < 0 || wz < 0 || wx >= WORLD_X || wz >= WORLD_Z) return out;
    const v = this.buffers.voxels;
    const ty = Math.max(0, Math.min(WORLD_Y - 1, targetY | 0));
    // Cut: clear everything strictly above targetY (skip bedrock).
    for (let y = WORLD_Y - 1; y > ty; y--) {
      const idx = worldIndex(wx, y, wz);
      const m = v[idx]!;
      if (m === AIR) continue;
      if (m === M_BEDROCK) continue;
      v[idx] = AIR;
      this.markDirty(wx, y, wz);
      out.cut++;
    }
    // Fill: starting at targetY and walking down, replace AIR with fillMaterial until
    // the first solid (or bedrock, which is treated as solid). This intentionally
    // doesn't touch existing solid voxels under the target — we only fill the dip.
    for (let y = ty; y >= 0; y--) {
      const idx = worldIndex(wx, y, wz);
      const m = v[idx]!;
      if (m === AIR) {
        v[idx] = fillMaterial;
        this.markDirty(wx, y, wz);
        out.filled++;
      } else {
        break;
      }
    }
    return out;
  }

  /**
   * Remove up to `maxVoxels` non-bedrock voxels from the top of the column at (wx, wz),
   * walking downward from the highest solid voxel. Returns the number actually removed.
   * Stops on the first bedrock voxel (or empty column) so the hauler can't dig forever.
   */
  scoopColumn(wx: number, wz: number, maxVoxels: number): number {
    if (maxVoxels <= 0) return 0;
    if (wx < 0 || wz < 0 || wx >= WORLD_X || wz >= WORLD_Z) return 0;
    const v = this.buffers.voxels;
    // Find the highest solid voxel.
    let top = -1;
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      const m = v[worldIndex(wx, y, wz)]!;
      if (m !== AIR) { top = y; break; }
    }
    if (top < 0) return 0;
    let taken = 0;
    for (let y = top; y >= 0 && taken < maxVoxels; y--) {
      const idx = worldIndex(wx, y, wz);
      const m = v[idx]!;
      if (m === AIR) continue;
      if (m === M_BEDROCK) break;
      v[idx] = AIR;
      this.markDirty(wx, y, wz);
      taken++;
    }
    return taken;
  }

  /**
   * Stack `count` voxels of `material` on top of the column at (wx, wz), starting at the
   * voxel directly above the current top (or y=0 if the column is empty). Returns the
   * number actually placed (capped by `WORLD_Y`).
   */
  dumpColumn(wx: number, wz: number, count: number, material: MaterialId): number {
    if (count <= 0) return 0;
    if (wx < 0 || wz < 0 || wx >= WORLD_X || wz >= WORLD_Z) return 0;
    const v = this.buffers.voxels;
    let top = -1;
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      const m = v[worldIndex(wx, y, wz)]!;
      if (m !== AIR) { top = y; break; }
    }
    let placed = 0;
    let y = top + 1;
    while (placed < count && y < WORLD_Y) {
      const idx = worldIndex(wx, y, wz);
      // Defensive: only place into AIR. (top is the highest solid; everything above
      // should be air, but a future caller might pass an arbitrary column.)
      if (v[idx]! === AIR) {
        v[idx] = material;
        this.markDirty(wx, y, wz);
        placed++;
      }
      y++;
    }
    return placed;
  }

  /** Mark the chunk containing (x,y,z) dirty, plus any neighbor whose face the voxel touches. */
  markDirty(x: number, y: number, z: number): void {
    const cx = (x / CHUNK) | 0;
    const cy = (y / CHUNK) | 0;
    const cz = (z / CHUNK) | 0;
    this.buffers.dirty[chunkKey(cx, cy, cz)] = 1;
    const lx = x - cx * CHUNK;
    const ly = y - cy * CHUNK;
    const lz = z - cz * CHUNK;
    if (lx === 0 && cx > 0) this.buffers.dirty[chunkKey(cx - 1, cy, cz)] = 1;
    if (lx === CHUNK - 1 && cx < CHUNKS_X - 1) this.buffers.dirty[chunkKey(cx + 1, cy, cz)] = 1;
    if (ly === 0 && cy > 0) this.buffers.dirty[chunkKey(cx, cy - 1, cz)] = 1;
    if (ly === CHUNK - 1 && cy < CHUNKS_Y - 1) this.buffers.dirty[chunkKey(cx, cy + 1, cz)] = 1;
    if (lz === 0 && cz > 0) this.buffers.dirty[chunkKey(cx, cy, cz - 1)] = 1;
    if (lz === CHUNK - 1 && cz < CHUNKS_Z - 1) this.buffers.dirty[chunkKey(cx, cy, cz + 1)] = 1;
  }

  markAllDirty(): void {
    this.buffers.dirty.fill(1);
  }
}

export { CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_COUNT, WORLD_X, WORLD_Y, WORLD_Z };
