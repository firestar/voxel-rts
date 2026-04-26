import { VoxelWorld } from '../voxel/VoxelWorld';
import { worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, MaterialId, VOXEL_SIZE } from '../voxel/types';
import { M_WOOD, M_FARM, M_DIRT_ROAD } from '../voxel/Materials';
import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_VOXELS, NAV_CELL_METERS, FLAT_TOLERANCE_VOXELS } from '../path/SurfaceNav';
import { UnitManager, UnitKind, Unit } from './Units';

export type BuildingKind = 'barracks' | 'farm' | 'storage';

export interface BuildingSpec {
  kind: BuildingKind;
  /** Footprint in nav cells (square). */
  cellsW: number;
  cellsD: number;
  /** Required headroom in voxels above the floor. */
  headroomVoxels: number;
  /** Construction wall material. */
  wall: MaterialId;
  /** Time between unit spawns in seconds. */
  productionInterval: number;
  /** Cycled through on each spawn; lets one Barracks alternate Soldier/Tunneler. */
  produces: UnitKind[];
}

export const BARRACKS: BuildingSpec = {
  kind: 'barracks',
  cellsW: 4,
  cellsD: 4,
  headroomVoxels: 24, // 3 m at 0.125 m voxels
  wall: M_WOOD,
  productionInterval: 6.0,
  produces: ['soldier', 'tank', 'tunneler', 'worm', 'worker'],
};

/**
 * Farm — passive food generator. Smaller footprint than a barracks, no roof
 * or door (it's an open field). Once built, it ticks `+5 food` every
 * `productionInterval` seconds via the `foodSink` callback on
 * `BuildingManager`. `produces` is empty — no units come out of farms.
 */
export const FARM: BuildingSpec = {
  kind: 'farm',
  cellsW: 3,
  cellsD: 3,
  headroomVoxels: 4,            // ~0.5 m fence + open sky
  wall: M_DIRT_ROAD,            // low fence stamped from packed dirt
  productionInterval: 5.0,      // food tick interval (seconds)
  produces: [],
};

/**
 * Storage depot — where transporter workers drop resources for the player's
 * counters. Same wooden walls as a barracks but smaller and roofless. No
 * production. The visit detection lives in `tickWorkers` (Workers.ts), not
 * here — `BuildingManager.tick` for storage is a no-op.
 */
export const STORAGE: BuildingSpec = {
  kind: 'storage',
  cellsW: 3,
  cellsD: 3,
  headroomVoxels: 12,
  wall: M_WOOD,
  productionInterval: 0,        // no timer-driven behaviour
  produces: [],
};

export interface FootprintHit {
  ok: boolean;
  reason?: string;
  /** Floor topY (voxel y of the highest solid in column at footprint center). */
  floorY: number;
  /** Lower-left nav cell of the footprint (origin). */
  ox: number;
  oz: number;
}

export interface Building {
  id: number;
  spec: BuildingSpec;
  ox: number; oz: number;
  floorY: number;
  productionTimer: number;
  wallVoxelsAtBuild: number;
  destroyed: boolean;
  /** Index into spec.produces for the next spawn. */
  nextProduceIdx: number;
}

/**
 * Validate a footprint at nav cell (ox, oz) for the given spec.
 * Floor topY is taken from the cell containing (ox, oz). All cells in the footprint must
 * have a topY within FLAT_TOLERANCE_VOXELS, must not be blocked, must have flatness covering
 * the footprint, and must have `headroomVoxels` of contiguous air above.
 *
 * Works for both surface and underground placements (the algorithm doesn't care about sky access).
 */
export function checkFootprint(
  voxels: Uint8Array,
  nav: SurfaceNavBuffers,
  spec: BuildingSpec,
  ox: number, oz: number,
): FootprintHit {
  if (ox < 0 || oz < 0 || ox + spec.cellsW > NAV_W || oz + spec.cellsD > NAV_H) {
    return { ok: false, reason: 'out of bounds', floorY: -1, ox, oz };
  }
  const i0 = navIndex(ox, oz);
  if (nav.blocked[i0]) return { ok: false, reason: 'no surface', floorY: -1, ox, oz };
  const baseY = nav.topY[i0]!;

  for (let dz = 0; dz < spec.cellsD; dz++) {
    for (let dx = 0; dx < spec.cellsW; dx++) {
      const i = navIndex(ox + dx, oz + dz);
      if (nav.blocked[i]) return { ok: false, reason: 'blocked cell', floorY: baseY, ox, oz };
      const y = nav.topY[i]!;
      if (Math.abs(y - baseY) > FLAT_TOLERANCE_VOXELS) {
        return { ok: false, reason: 'uneven floor', floorY: baseY, ox, oz };
      }
      // Don't require flatnessRadius here — we directly check the rectangle.
    }
  }

  // Headroom: scan voxels above each footprint column. Use 2 sample voxels per cell to be quick
  // (cell center + opposite corner).
  const headroom = spec.headroomVoxels;
  for (let dz = 0; dz < spec.cellsD; dz++) {
    for (let dx = 0; dx < spec.cellsW; dx++) {
      const i = navIndex(ox + dx, oz + dz);
      const y = nav.topY[i]!;
      const wxMid = (ox + dx) * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
      const wzMid = (oz + dz) * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
      for (let h = 1; h <= headroom; h++) {
        const yy = y + h;
        if (yy >= WORLD_Y) break;
        if (voxels[worldIndex(wxMid, yy, wzMid)] !== AIR) {
          return { ok: false, reason: 'no headroom', floorY: baseY, ox, oz };
        }
      }
    }
  }

  return { ok: true, floorY: baseY, ox, oz };
}

/**
 * Stamp a Barracks-style hollow box into the world.
 * Floor + walls + roof of `wall` material; interior is air; a 2-voxel-wide door cut from one wall.
 * Returns the count of wall voxels written.
 */
export function stampBarracks(
  world: VoxelWorld,
  spec: BuildingSpec,
  ox: number, oz: number,
  floorY: number,
): number {
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;

  let wallCount = 0;
  // Door: a 2-voxel-wide, 6-voxel-tall opening centered on the +X wall at (wxEnd-1, .., wzMid).
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      // Floor.
      if (yFloor >= 0 && yFloor < WORLD_Y && x < WORLD_X && z < WORLD_Z) {
        world.set(x, yFloor, z, spec.wall);
        wallCount++;
      }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const onPerimeter =
          x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (y === yRoof) {
          // Roof.
          world.set(x, y, z, spec.wall);
          wallCount++;
        } else if (onPerimeter) {
          // Door cutout.
          const isDoor = (x === wxEnd - 1 && (z === doorWz0 || z === doorWz1) && y < doorYTop);
          if (!isDoor) {
            world.set(x, y, z, spec.wall);
            wallCount++;
          } else {
            world.set(x, y, z, AIR);
          }
        } else {
          world.set(x, y, z, AIR);
        }
      }
    }
  }
  return wallCount;
}

/**
 * Stamp a Farm: an open square of M_FARM crop tiles, surrounded by a
 * single-voxel-tall fence of `spec.wall`. No roof, no door — just a field.
 * Returns the count of fence voxels written so the manager can detect
 * destruction with the same threshold logic barracks uses.
 */
export function stampFarm(
  world: VoxelWorld,
  spec: BuildingSpec,
  ox: number, oz: number,
  floorY: number,
): number {
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yField = floorY + 1;
  const yFenceTop = yField; // single-voxel fence sits AT yField on the perimeter

  let fenceCount = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      const onPerimeter =
        x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      if (onPerimeter) {
        // Fence column: a single voxel of wall at yField, air just above.
        if (yFenceTop >= 0 && yFenceTop < WORLD_Y) {
          world.set(x, yFenceTop, z, spec.wall);
          fenceCount++;
        }
      } else {
        // Interior cropland: golden wheat at yField.
        if (yField >= 0 && yField < WORLD_Y) {
          world.set(x, yField, z, M_FARM);
        }
      }
    }
  }
  return fenceCount;
}

/**
 * Sample wall voxels and return roughly how many remain. Used for "destroyed" check.
 * Cheap: only checks perimeter columns.
 */
export function countLivingWalls(world: VoxelWorld, b: Building): number {
  const wxStart = b.ox * NAV_CELL_VOXELS;
  const wzStart = b.oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = b.floorY + 1;
  const yRoof = b.floorY + b.spec.headroomVoxels;
  let alive = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const onPerimeter = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      if (!onPerimeter) continue;
      for (let y = yFloor; y <= yRoof; y++) {
        if (world.get(x, y, z) !== AIR) alive++;
      }
    }
  }
  return alive;
}

export interface DoorWorldPos { x: number; y: number; z: number; }

export function doorWorldPos(b: Building): DoorWorldPos {
  const wxEnd = (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS;
  const wzMid = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS;
  return {
    x: (wxEnd + 1) * VOXEL_SIZE,
    y: (b.floorY + 1) * VOXEL_SIZE,
    z: (wzMid) * VOXEL_SIZE,
  };
}

export class BuildingManager {
  buildings: Building[] = [];
  private nextId = 1;
  /** Called when a building wants to spawn a unit. Returns true if accepted. */
  spawner: ((kind: UnitKind, x: number, y: number, z: number) => Unit | null) | null = null;
  /**
   * Food sink. A farm calls this every `productionInterval` seconds while
   * alive. The Game wires it to its Resources counter. If null, farms tick
   * silently (used by tests that don't bother with a Resources instance).
   */
  foodSink: ((amount: number, b: Building) => void) | null = null;

  place(world: VoxelWorld, spec: BuildingSpec, ox: number, oz: number, floorY: number): Building {
    const wallCount = spec.kind === 'farm'
      ? stampFarm(world, spec, ox, oz, floorY)
      : stampBarracks(world, spec, ox, oz, floorY);
    const b: Building = {
      id: this.nextId++,
      spec,
      ox, oz,
      floorY,
      productionTimer: spec.productionInterval,
      wallVoxelsAtBuild: wallCount,
      destroyed: false,
      nextProduceIdx: 0,
    };
    this.buildings.push(b);
    return b;
  }

  tick(dt: number, world: VoxelWorld, units: UnitManager): void {
    void units;
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      // Storage buildings have no production timer — skip the timer logic.
      if (b.spec.kind === 'storage' || b.spec.productionInterval <= 0) continue;
      b.productionTimer -= dt;
      if (b.productionTimer > 0) continue;
      b.productionTimer += b.spec.productionInterval;

      // Liveness check: structures whose perimeter has been chewed below 25%
      // count as destroyed and stop ticking.
      const alive = countLivingWalls(world, b);
      if (alive < b.wallVoxelsAtBuild * 0.25) {
        b.destroyed = true;
        continue;
      }

      if (b.spec.kind === 'farm') {
        // Each tick generates a fixed food bundle. We don't model crop growth
        // per-voxel — the farm is treated as a passive +5 food / interval
        // generator. Tweak the per-tick amount here when balance demands it.
        if (this.foodSink) this.foodSink(5, b);
        continue;
      }

      // Barracks: cycle through `produces`, spawning a unit at the door.
      if (b.spec.produces.length > 0 && this.spawner) {
        const door = doorWorldPos(b);
        const kind = b.spec.produces[b.nextProduceIdx % b.spec.produces.length]!;
        b.nextProduceIdx++;
        this.spawner(kind, door.x, door.y, door.z);
      }
    }
  }

  /** Lookup the nearest live storage building (in XZ). Returns null if there are none. */
  nearestStorage(x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD2 = Infinity;
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'storage') continue;
      const dpos = doorWorldPos(b);
      const dx = dpos.x - x, dz = dpos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }
}
