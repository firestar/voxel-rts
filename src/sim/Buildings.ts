import { VoxelWorld } from '../voxel/VoxelWorld';
import { worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, MaterialId, VOXEL_SIZE } from '../voxel/types';
import { M_WOOD, M_FARM, M_STONE, M_PATH, M_DIRT_ROAD, M_METAL } from '../voxel/Materials';
import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_VOXELS, FLAT_TOLERANCE_VOXELS } from '../path/SurfaceNav';
import { UnitManager, UnitKind, Unit } from './Units';
import { WeaponKind, WEAPONS } from './Weapons';
import { ProjectileManager, muzzleOrigin, PROJECTILES, PROJECTILE_GRAVITY, Projectile, ProjectileImpact, solveBallisticDirection } from './Projectiles';

export type BuildingKind =
  | 'barracks'
  | 'farm'
  | 'storage'
  | 'power_plant'
  | 'refinery'
  | 'tech_lab'
  | 'turret'
  | 'silo';

/**
 * Faction the building belongs to. Mirrors the unit `Team` type — buildings
 * default to 'player'; the sandbox can place 'enemy' buildings for testing
 * the attack pipeline. Projectile damage is team-agnostic (any round that
 * lands inside / near the AABB hurts the building's HP).
 */
export type BuildingTeam = 'player' | 'enemy';

export interface BuildingSpec {
  kind: BuildingKind;
  /** Display name for HUD. */
  label: string;
  /** Footprint in nav cells (square or rectangular). */
  cellsW: number;
  cellsD: number;
  /** Required headroom in voxels above the floor. */
  headroomVoxels: number;
  /** Primary wall material — used for the perimeter + countLivingWalls sample. */
  wall: MaterialId;
  /**
   * Hit-point pool the building starts with. Drained by projectile impacts
   * (direct hits inside the AABB take the round's full `hitDamage`; explosive
   * blasts apply falloff damage based on distance to the AABB). Once HP
   * reaches zero the building flips to `destroyed` and stops ticking.
   */
  maxHp: number;
  /** Time between unit spawns in seconds. Infinity disables production. */
  productionInterval: number;
  /** Cycled through on each spawn. Empty array = doesn't produce units. */
  produces: UnitKind[];
  /** Voxel stamper for this building. Returns the wall-voxel count for liveness math. */
  stamp: (world: VoxelWorld, ox: number, oz: number, floorY: number) => number;
  /**
   * Optional weapon mounted on this building. Buildings with a weapon
   * auto-target the nearest enemy unit within the weapon's `rangeMeters` and
   * fire on its cooldown. Aim mount is always treated as 'turret' regardless
   * of the weapon catalog entry, since the building itself doesn't yaw.
   */
  weapon?: WeaponKind;
  /**
   * Cap on actual muzzle velocity (m/s) for shots fired by this building. Same
   * semantics as `UnitConfig.launcherMaxStrength` — the projectile manager
   * clamps the spawn speed to this. Allows a fixed turret to outrange hand-
   * carried weapons and a silo to reach much further still.
   */
  launcherMaxStrength?: number;
  /**
   * Height in meters above the building's floor where projectiles emerge from
   * the weapon mount. Used to position the muzzle origin so shots come out
   * the top of the turret head / silo cluster, not from inside the wall.
   */
  weaponMuzzleHeight?: number;
  /**
   * Optional magazine capacity. When set, the weapon fires this many rounds
   * before forcing a reload of `weaponReloadSeconds`. Undefined = unlimited
   * ammo (regular turrets / silos). Used by the AA flak turret so a wave of
   * incoming fire can saturate the dome before it goes offline to reload.
   */
  weaponMagazineSize?: number;
  /**
   * Seconds the weapon stays offline after the magazine is emptied. During
   * this window the building cannot target or fire, and the renderer drops
   * the turret head to a stowed pose so the reload is visually obvious.
   */
  weaponReloadSeconds?: number;
}

export const BARRACKS: BuildingSpec = {
  kind: 'barracks',
  label: 'Barracks',
  cellsW: 4,
  cellsD: 4,
  headroomVoxels: 24, // 3 m at 0.125 m voxels
  wall: M_WOOD,
  maxHp: 600,
  productionInterval: 6.0,
  // Cycle through every kind the barracks can produce so a single building
  // visibly outputs a balanced mix. Order is roughly "infantry → vehicles
  // → diggers → economy" so the early ticks favour combat units.
  produces: ['soldier', 'tank', 'tunneler', 'worm', 'dozer', 'worker'],
  stamp: stampBarracks,
};

/**
 * Farm — passive food generator. Smaller footprint than a barracks, no roof
 * or door (it's an open field). Once built, it ticks `+5 food` every
 * `productionInterval` seconds via the `foodSink` callback on
 * `BuildingManager`. `produces` is empty — no units come out of farms.
 */
export const FARM: BuildingSpec = {
  kind: 'farm',
  label: 'Farm',
  cellsW: 3,
  cellsD: 3,
  headroomVoxels: 4,            // ~0.5 m fence + open sky
  wall: M_DIRT_ROAD,            // low fence stamped from packed dirt
  maxHp: 200,
  productionInterval: 5.0,      // food tick interval (seconds)
  produces: [],
  stamp: stampFarm,
};

/**
 * Storage depot — where transporter workers drop resources for the player's
 * counters. Same wooden walls as a barracks but smaller and roofless. No
 * production. The visit detection lives in `tickWorkers` (Workers.ts), not
 * here — `BuildingManager.tick` for storage is a no-op.
 */
export const STORAGE: BuildingSpec = {
  kind: 'storage',
  label: 'Storage',
  cellsW: 3,
  cellsD: 3,
  headroomVoxels: 12,
  wall: M_WOOD,
  maxHp: 400,
  productionInterval: 0,        // no timer-driven behaviour
  produces: [],
  stamp: stampStorage,
};

export const POWER_PLANT: BuildingSpec = {
  kind: 'power_plant',
  label: 'Power Plant',
  cellsW: 5,
  cellsD: 5,
  headroomVoxels: 24, // 3 m main hall — wind turbine pylon sits above
  wall: M_STONE,
  maxHp: 800,
  productionInterval: Infinity,
  produces: [],
  stamp: stampPowerPlant,
};

export const REFINERY: BuildingSpec = {
  kind: 'refinery',
  label: 'Metal Refinery',
  cellsW: 6,
  cellsD: 4,
  headroomVoxels: 28, // 3.5 m hall — chimney rises above the roof
  wall: M_STONE,
  maxHp: 800,
  productionInterval: Infinity,
  produces: [],
  stamp: stampRefinery,
};

export const TECH_LAB: BuildingSpec = {
  kind: 'tech_lab',
  label: 'Tech Lab',
  cellsW: 4,
  cellsD: 4,
  headroomVoxels: 20, // 2.5 m base — domed roof rises above
  wall: M_STONE,
  maxHp: 700,
  productionInterval: Infinity,
  produces: [],
  stamp: stampTechLab,
};

/**
 * Defensive turret. A small stone emplacement with a rotating cannon head on
 * top — auto-fires `building_turret` rounds at the nearest enemy unit in
 * range (90 m, with a launcher cap that lets the lobbed shell actually reach
 * that far against the doubled gravity). Smaller footprint than a barracks
 * and roofless so the cannon head can swing freely.
 */
export const TURRET: BuildingSpec = {
  kind: 'turret',
  label: 'Turret',
  cellsW: 2,
  cellsD: 2,
  headroomVoxels: 12,           // ~1.5 m base; the cannon head sits above
  wall: M_STONE,
  maxHp: 500,
  productionInterval: Infinity, // doesn't produce units; weapon firing is per-frame
  produces: [],
  stamp: stampTurret,
  weapon: 'building_turret',
  launcherMaxStrength: 110,
  // Top of the base + a 4-voxel pintle column the renderer's turret head
  // sits on. Matches the visual mount point so projectiles come out the
  // barrel, not the floor.
  weaponMuzzleHeight: (12 + 4) * VOXEL_SIZE,
};

/**
 * Anti-air flak turret. Same chassis as the regular turret but its weapon
 * targets airborne projectiles instead of ground units. The firing pipeline
 * leads the target so the flak shell detonates just below the projectile on
 * its way through — `tickAntiAir` in BuildingManager owns that logic.
 *
 * Reuses `stampTurret` for the visible model (small stone emplacement). The
 * AA-specific behaviour is keyed off the spec's `weapon === 'aa_turret'`.
 */
export const AA_TURRET: BuildingSpec = {
  kind: 'turret',
  label: 'Anti-air Turret',
  cellsW: 2,
  cellsD: 2,
  headroomVoxels: 12,
  wall: M_STONE,
  maxHp: 500,
  productionInterval: Infinity,
  produces: [],
  stamp: stampTurret,
  weapon: 'aa_turret',
  launcherMaxStrength: 130,
  weaponMuzzleHeight: (12 + 4) * VOXEL_SIZE,
  // 12-round magazine, 30 s reload. While reloading the turret tilts its
  // barrel down (see BuildingRenderer) and refuses to engage — a saturation
  // attack can punch a hole in the AA umbrella by emptying the magazine.
  weaponMagazineSize: 12,
  weaponReloadSeconds: 30,
};

/**
 * Heavy silo launcher. A large fortified emplacement with a missile cluster
 * on the roof. Auto-fires `silo_missile` rounds at the nearest enemy in a
 * very long range (320 m). Long cooldown — the missile is devastating but
 * you only get one off every several seconds.
 */
export const SILO: BuildingSpec = {
  kind: 'silo',
  label: 'Silo Launcher',
  cellsW: 5,
  cellsD: 5,
  headroomVoxels: 36,           // ~4.5 m main hall + missile tubes above
  wall: M_STONE,
  maxHp: 1000,
  productionInterval: Infinity,
  produces: [],
  stamp: stampSilo,
  weapon: 'silo_launcher',
  launcherMaxStrength: 220,
  // Top of the missile cluster sits ~6 voxels above the parapet.
  weaponMuzzleHeight: (36 + 6) * VOXEL_SIZE,
};

/** All building specs in the order they appear on the build-mode hotkeys (1..N). */
export const ALL_BUILDINGS: BuildingSpec[] = [BARRACKS, FARM, STORAGE, POWER_PLANT, REFINERY, TECH_LAB, TURRET, AA_TURRET, SILO];

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
  /**
   * Faction this building belongs to. Player buildings are placed by the
   * normal build flow; enemy buildings come from the sandbox / scenarios.
   * Damage doesn't read team — any projectile hurts any building — but the
   * player UI and aggressive-stance targeting do.
   */
  team: BuildingTeam;
  /**
   * Current hit-point pool. Drained by projectile impacts; once it reaches
   * zero the building flips to `destroyed` and is treated as dead by every
   * subsequent tick. Visual destruction (wall voxels carved away by the
   * round's `damageSphere`) still happens in parallel — the HP gate just
   * gives the building a clean numeric death even when only the roof has
   * collapsed.
   */
  hp: number;
  /** Snapshot of `spec.maxHp` taken at place-time — exposed on the instance
   *  so renderers / HUD don't need to walk back to the spec. */
  maxHp: number;
  /** True when this building is the player's currently selected building. */
  selected: boolean;
  /**
   * Player-queued unit kinds for buildings that produce units (e.g. barracks).
   * Producer buildings only train when this queue is non-empty — there is no
   * auto-cycle fallback, so an empty queue means the building sits idle.
   */
  trainQueue: UnitKind[];
  /**
   * Farm-only: 0..1 crop progress. Advances each tick at the slow ambient
   * rate, or at 4× when a worker-farmer (`farmerId`) is at the farm with a
   * `farm` task. When it reaches 1, `cropReady` flips true and the renderer
   * draws ripe (slightly amber) stalks until a harvester collects.
   */
  cropProgress: number;
  /** Farm-only: true once `cropProgress` hit 1; reset by harvester collection. */
  cropReady: boolean;
  /**
   * Farm-only: id of the worker currently dedicated as farmer here, or null
   * if unassigned. Set by RMB-on-farm with a worker selected; cleared when
   * the worker drops the task or dies.
   */
  farmerId: number | null;
  /**
   * Farm-only: id of the harvester that has claimed the ripe crop, so
   * multiple harvesters don't all converge on the same field. Cleared when
   * the harvester delivers / dies / drops task.
   */
  harvesterClaimId: number | null;
  /**
   * Weapon-bearing buildings (turret, silo): seconds until the weapon is
   * ready to fire again. 0 = ready. Buildings without a weapon never touch
   * this field; it stays at 0 forever.
   */
  weaponFireCooldown: number;
  /**
   * Weapon-bearing buildings: world-space yaw (radians) of the visible turret
   * head. Slewed toward the current target each tick, same convention as
   * unit `turretYaw` (yaw=0 → forward = -Z). For buildings without a weapon
   * the value stays at 0.
   */
  weaponTurretYaw: number;
  /**
   * Visible turret-head pitch (radians, X-axis, YXZ Euler order). 0 = barrel
   * level, negative = tilted down. Only the AA turret currently moves this
   * value — it slews to a steep down-tilt while reloading and back to 0 when
   * the magazine is fresh, so the renderer reads "offline" at a glance. All
   * other buildings leave it at 0.
   */
  weaponTurretPitch: number;
  /**
   * Rounds remaining in the magazine for buildings whose spec sets
   * `weaponMagazineSize`. Decremented on each shot; when it hits 0 the
   * building enters a reload cycle (`weaponReloadTimer`). Buildings without
   * a magazine spec leave this at 0 and ignore it.
   */
  weaponAmmo: number;
  /**
   * Seconds remaining on the current reload, or 0 when the weapon is ready.
   * While > 0 the building's weapon tick refuses to target/fire and the
   * renderer shows the stowed pose. Decays each tick; when it crosses 0 the
   * magazine refills to `weaponMagazineSize` and the turret comes back online.
   */
  weaponReloadTimer: number;
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
 * Shared hollow-box stamper used by Barracks and Storage. Floor + walls + roof
 * of `spec.wall`; interior is air; a 2-voxel-wide door cut from the +X wall.
 * Returns the count of wall voxels written.
 */
function stampHollowBox(
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
  // Door: a 2-voxel-wide, 6-voxel-tall opening centered on the +X wall.
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

export function stampBarracks(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  return stampHollowBox(world, BARRACKS, ox, oz, floorY);
}

export function stampStorage(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  return stampHollowBox(world, STORAGE, ox, oz, floorY);
}

/**
 * Stamp a Farm: an open square of M_FARM crop tiles, surrounded by a
 * single-voxel-tall fence of `spec.wall`. No roof, no door — just a field.
 * Returns the count of fence voxels written so the manager can detect
 * destruction with the same threshold logic barracks uses.
 */
export function stampFarm(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = FARM;
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
 * Power plant: stone perimeter walls, M_DIRT_ROAD tiled floor, a recessed second-tier
 * crown around the parapet, and a stout wood pylon column stub at the centre of the
 * roof. The pylon stub is what the renderer's wind-turbine accessory bolts to.
 */
export function stampPowerPlant(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = POWER_PLANT;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  // Door on +X face.
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let wallCount = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      // Floor: dirt-road tiles for visual contrast vs barracks wood floor.
      if (yFloor < WORLD_Y && x < WORLD_X && z < WORLD_Z) {
        world.set(x, yFloor, z, M_DIRT_ROAD);
        wallCount++;
      }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const onPerimeter =
          x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (y === yRoof) {
          world.set(x, y, z, spec.wall);
          wallCount++;
        } else if (onPerimeter) {
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

  // Crown parapet: a 2-voxel-tall ring of M_STONE on top of the roof, inset 2
  // voxels from each edge. Reads as a flat-roofed industrial building.
  const parapetInset = 2;
  const parapetH = 2;
  for (let dy = 1; dy <= parapetH; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    for (let z = wzStart + parapetInset; z < wzEnd - parapetInset; z++) {
      for (let x = wxStart + parapetInset; x < wxEnd - parapetInset; x++) {
        const onParapet =
          x === wxStart + parapetInset || x === wxEnd - parapetInset - 1 ||
          z === wzStart + parapetInset || z === wzEnd - parapetInset - 1;
        if (!onParapet) continue;
        world.set(x, py, z, spec.wall);
        wallCount++;
      }
    }
  }

  // Wood turbine pylon stub at the centre — a 2x2 column of M_WOOD, 6 voxels tall,
  // mounted on top of the roof. The animated turbine head sits above it.
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;
  const pylonH = 6;
  for (let dy = 1; dy <= pylonH; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    for (let xo = -1; xo <= 0; xo++) {
      for (let zo = -1; zo <= 0; zo++) {
        world.set(cxv + xo, py, czv + zo, M_WOOD);
        wallCount++;
      }
    }
  }
  return wallCount;
}

/**
 * Metal refinery: a long rectangular hall with a stepped chimney rising above the
 * back-left corner. The chimney is a 2x2 stone column; visible smoke is drawn by the
 * BuildingRenderer.
 */
export function stampRefinery(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = REFINERY;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let wallCount = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      // Stone floor.
      if (yFloor < WORLD_Y && x < WORLD_X && z < WORLD_Z) {
        world.set(x, yFloor, z, M_STONE);
        wallCount++;
      }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const onPerimeter =
          x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (y === yRoof) {
          world.set(x, y, z, spec.wall);
          wallCount++;
        } else if (onPerimeter) {
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

  // Chimney: a 2x2 stone column rising 24 voxels (~3 m) above the roof, planted at
  // the back-left corner of the building (interior side of the perimeter so the column
  // doesn't poke out of the wall).
  const chimX0 = wxStart + 2;
  const chimZ0 = wzStart + 2;
  const chimH = 24;
  const chimBaseY = yRoof + 1;
  for (let dy = 0; dy < chimH; dy++) {
    const py = chimBaseY + dy;
    if (py >= WORLD_Y) break;
    for (let xo = 0; xo < 2; xo++) {
      for (let zo = 0; zo < 2; zo++) {
        world.set(chimX0 + xo, py, chimZ0 + zo, M_STONE);
        wallCount++;
      }
    }
  }

  // Loading-bay style hopper: a low wood ramp on the +X side of the building (just
  // outside the wall, below door height). It's purely cosmetic — just a stack of
  // M_WOOD voxels making a stepped ramp on the door face.
  const rampSteps = 4;
  for (let s = 0; s < rampSteps; s++) {
    const px = wxEnd + s;
    if (px >= WORLD_X) break;
    for (let dy = 0; dy < rampSteps - s; dy++) {
      const py = yFloor + dy;
      if (py >= WORLD_Y) break;
      for (let zo = -1; zo <= 1; zo++) {
        const pz = ((wzStart + wzEnd) >> 1) + zo;
        if (pz < 0 || pz >= WORLD_Z) continue;
        world.set(px, py, pz, M_WOOD);
        wallCount++;
      }
    }
  }
  return wallCount;
}

/**
 * Tech lab: small square hall with a stepped pyramidal dome on top and a slim wood
 * antenna mast at the dome's apex. The renderer mounts a sweeping satellite dish
 * and a pulsing core on the mast.
 */
export function stampTechLab(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = TECH_LAB;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let wallCount = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (yFloor < WORLD_Y && x < WORLD_X && z < WORLD_Z) {
        world.set(x, yFloor, z, M_PATH);
        wallCount++;
      }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const onPerimeter =
          x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (y === yRoof) {
          // Roof level — fill solid (this is the base of the dome).
          world.set(x, y, z, spec.wall);
          wallCount++;
        } else if (onPerimeter) {
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

  // Stepped dome: 3 tiers of stone, each one voxel taller and with a smaller footprint.
  const tiers = 3;
  for (let t = 1; t <= tiers; t++) {
    const inset = t * 4; // 4-voxel inset per tier (half a nav cell)
    const py = yRoof + t * 2;
    if (py >= WORLD_Y) break;
    const x0 = wxStart + inset;
    const x1 = wxEnd - inset;
    const z0 = wzStart + inset;
    const z1 = wzEnd - inset;
    if (x1 <= x0 || z1 <= z0) break;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        // Two-voxel-tall tier so the stepping reads at distance.
        for (let dy = -1; dy <= 0; dy++) {
          const yy = py + dy;
          if (yy >= WORLD_Y) continue;
          world.set(x, yy, z, spec.wall);
          wallCount++;
        }
      }
    }
  }

  // Antenna mast: a single-voxel wood column rising 6 voxels above the dome.
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;
  const mastBaseY = yRoof + tiers * 2 + 1;
  const mastH = 6;
  for (let dy = 0; dy < mastH; dy++) {
    const py = mastBaseY + dy;
    if (py >= WORLD_Y) break;
    world.set(cxv, py, czv, M_WOOD);
    wallCount++;
  }
  return wallCount;
}

/**
 * Defensive turret: a 2x2 stone emplacement with a stout pintle column at the
 * centre. The renderer mounts the rotating cannon head on top of the column;
 * the stamp here only lays out the static base + pintle.
 */
export function stampTurret(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = TURRET;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;

  let wallCount = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      // Stone floor.
      if (yFloor < WORLD_Y && x < WORLD_X && z < WORLD_Z) {
        world.set(x, yFloor, z, spec.wall);
        wallCount++;
      }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const onPerimeter =
          x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (onPerimeter) {
          world.set(x, y, z, spec.wall);
          wallCount++;
        } else {
          world.set(x, y, z, AIR);
        }
      }
    }
  }
  // Pintle column at the centre — a 2x2 metal column 4 voxels tall sitting on
  // top of the perimeter wall. The renderer's turret head bolts to the top of
  // this column.
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;
  const pintleH = 4;
  for (let dy = 1; dy <= pintleH; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    for (let xo = -1; xo <= 0; xo++) {
      for (let zo = -1; zo <= 0; zo++) {
        world.set(cxv + xo, py, czv + zo, M_METAL);
        wallCount++;
      }
    }
  }
  return wallCount;
}

/**
 * Heavy silo launcher: a 5x5 stone fortress with a tall parapet and a 3x3
 * missile-tube cluster on the roof (six metal columns capped with red warhead
 * voxels). The renderer doesn't add any animated accessories — the missile
 * tubes are part of the static stamp.
 */
export function stampSilo(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = SILO;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  // Door on +X face (matches barracks/refinery convention).
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let wallCount = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (yFloor < WORLD_Y && x < WORLD_X && z < WORLD_Z) {
        world.set(x, yFloor, z, M_STONE);
        wallCount++;
      }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const onPerimeter =
          x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (y === yRoof) {
          world.set(x, y, z, spec.wall);
          wallCount++;
        } else if (onPerimeter) {
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
  // Parapet — 2-voxel-tall ring of stone inset 1 from the perimeter.
  const parapetInset = 1;
  for (let dy = 1; dy <= 2; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    for (let z = wzStart + parapetInset; z < wzEnd - parapetInset; z++) {
      for (let x = wxStart + parapetInset; x < wxEnd - parapetInset; x++) {
        const onParapet =
          x === wxStart + parapetInset || x === wxEnd - parapetInset - 1 ||
          z === wzStart + parapetInset || z === wzEnd - parapetInset - 1;
        if (!onParapet) continue;
        world.set(x, py, z, spec.wall);
        wallCount++;
      }
    }
  }
  // Missile tube cluster — 6 vertical tubes arranged in a 3x2 grid on the
  // roof. Each tube is a 2x2 metal column 5 voxels tall capped with a single
  // red-tinted M_METAL warhead voxel (we just use M_METAL throughout; the
  // renderer's voxel-meshes pick the colour from the material catalog).
  const tubeBaseY = yRoof + 3; // sits above the parapet
  const tubeHeight = 5;
  // Layout: 3 tubes along X × 2 tubes along Z, centred. Tube footprint is 2
  // voxels each side, gap of 1 between → 3*2+2*1 = 8 voxels along X (fits the
  // 5-cell × 8-voxel = 40-voxel building width with margin).
  const tubeStride = 3; // 2-wide tube + 1 gap
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;
  const xStartTube = cxv - tubeStride - 1; // covers tube columns at -4..-3, -1..0, +2..+3
  const zStartTube = czv - 2;
  for (let tx = 0; tx < 3; tx++) {
    for (let tz = 0; tz < 2; tz++) {
      const baseX = xStartTube + tx * tubeStride;
      const baseZ = zStartTube + tz * tubeStride;
      for (let dy = 0; dy < tubeHeight; dy++) {
        const py = tubeBaseY + dy;
        if (py >= WORLD_Y) break;
        for (let xo = 0; xo < 2; xo++) {
          for (let zo = 0; zo < 2; zo++) {
            world.set(baseX + xo, py, baseZ + zo, M_METAL);
            wallCount++;
          }
        }
      }
    }
  }
  return wallCount;
}

/**
 * Sample wall voxels and return roughly how many remain. Used for "destroyed" check.
 * Cheap: only checks perimeter columns of the main hall (ignores chimneys / domes —
 * those are accents, the building is "alive" while the perimeter still stands).
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
  /**
   * Projectile manager that weapon-bearing buildings (turret, silo) use to
   * launch their rounds. Wired by Game; null in tests that don't care about
   * building weapons (the firing logic short-circuits when null).
   */
  projectiles: ProjectileManager | null = null;
  /**
   * Muzzle-flash sink. Same shape as the unit weapon-tick hook so Game can
   * forward both into the same FlashPool. Optional — when null, building
   * shots fire without a visible flash (still works for tests).
   */
  onBuildingMuzzleFlash:
    | ((x: number, y: number, z: number, radiusMeters: number, lifeSeconds: number,
        color: { r: number; g: number; b: number }) => void)
    | null = null;

  place(
    world: VoxelWorld,
    spec: BuildingSpec,
    ox: number, oz: number, floorY: number,
    opts?: { team?: BuildingTeam },
  ): Building {
    const wallCount = spec.stamp(world, ox, oz, floorY);
    const b: Building = {
      id: this.nextId++,
      spec,
      ox, oz,
      floorY,
      productionTimer: spec.productionInterval,
      wallVoxelsAtBuild: wallCount,
      destroyed: false,
      team: opts?.team ?? 'player',
      hp: spec.maxHp,
      maxHp: spec.maxHp,
      selected: false,
      trainQueue: [],
      cropProgress: 0,
      cropReady: false,
      farmerId: null,
      harvesterClaimId: null,
      weaponFireCooldown: 0,
      weaponTurretYaw: 0,
      weaponTurretPitch: 0,
      weaponAmmo: spec.weaponMagazineSize ?? 0,
      weaponReloadTimer: 0,
    };
    this.buildings.push(b);
    return b;
  }

  /**
   * Apply a projectile impact's damage to every building in range. Direct
   * hits — impact point lying inside the building's footprint AABB — take
   * the round's full `hitDamage`. Explosive blasts apply falloff damage to
   * every building whose AABB lies within `explosionRadiusMeters`, scaled
   * linearly to zero at the blast edge (same shape as the unit splash math
   * in Game.handleProjectileImpact). HP that drops to zero flips
   * `destroyed`, mirroring the existing wall-count threshold.
   *
   * Buildings are not team-filtered here — anyone's projectile can damage
   * anyone's structure. Friendly-fire on your own base is the player's
   * problem, just like turret placement next to a barracks.
   */
  applyImpactDamage(impact: ProjectileImpact): void {
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      const dist = aabbDistance(b, impact.x, impact.y, impact.z);
      let damage = 0;
      // Direct hit: impact point lies inside the AABB. Full direct damage.
      if (dist <= 0) damage += impact.hitDamage;
      // Explosive splash: any AABB-overlap within the blast radius takes a
      // falloff fraction of the explosion peak. The directly-hit building
      // (dist == 0) catches the splash on top of the direct hit, mirroring
      // the unit pipeline.
      if (impact.explosive && impact.explosionRadiusMeters > 0 && dist < impact.explosionRadiusMeters) {
        const falloff = 1 - dist / impact.explosionRadiusMeters;
        damage += impact.damagePeak * falloff;
      }
      if (damage <= 0) continue;
      b.hp -= damage;
      if (b.hp <= 0) {
        b.hp = 0;
        b.destroyed = true;
      }
    }
  }

  tick(dt: number, world: VoxelWorld, units: UnitManager): void {
    for (const b of this.buildings) {
      if (b.destroyed) continue;

      // Weapon-bearing buildings (turret, silo, AA): auto-target and fire on
      // cooldown. Anti-air uses a different targeting pipeline (incoming
      // projectiles, not enemy units) so it gets its own tick.
      if (b.spec.weapon === 'aa_turret') {
        this.tickAntiAir(b, dt, units);
      } else if (b.spec.weapon) {
        this.tickBuildingWeapon(b, dt, units, world);
      }

      // Farm crop growth runs every tick (continuous), independent of the
      // production-timer cycle the barracks uses. Slow ambient growth lets
      // an unattended farm eventually ripen; an assigned + co-located
      // farmer multiplies the rate so dedicating a worker is worthwhile.
      if (b.spec.kind === 'farm') {
        this.tickFarm(b, dt, world, units);
        continue;
      }

      // Storage has no timer; non-producers (power plant / refinery / tech lab,
      // turret, silo) carry an Infinity interval so the spawn loop never fires
      // for them.
      if (b.spec.kind === 'storage' || b.spec.productionInterval <= 0 || !isFinite(b.spec.productionInterval)) continue;
      // Producer buildings (barracks) only train units the player has
      // explicitly queued. With nothing queued, the timer is held at the full
      // interval so a freshly-queued kind still takes the configured time to
      // come out — but the building never auto-spawns a default cycle.
      if (b.spec.produces.length > 0 && b.trainQueue.length === 0) {
        b.productionTimer = b.spec.productionInterval;
        continue;
      }
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

      // Barracks: spawn the next queued unit at the door. We've already
      // gated on `trainQueue.length > 0` above, so the queue can't be empty
      // here for a producer building.
      if (b.spec.produces.length > 0 && this.spawner && b.trainQueue.length > 0) {
        const door = doorWorldPos(b);
        const kind = b.trainQueue.shift()!;
        this.spawner(kind, door.x, door.y, door.z);
      }
    }
  }

  /**
   * Per-frame firing pipeline for a weapon-bearing building. Mirrors the
   * unit-side `tickWeapons`:
   *
   *   1. Decay cooldown.
   *   2. Pick the nearest enemy unit within `weapon.rangeMeters`.
   *   3. Slew the building's `weaponTurretYaw` toward the target at the
   *      weapon's slew rate.
   *   4. When aligned within `aimToleranceRad` AND cooldown == 0, spawn one
   *      projectile from the muzzle position and reset the cooldown.
   *
   * Buildings always treat the mount as 'turret' regardless of catalog —
   * they don't have a hull to spin. Friendly-fire gating is deliberately
   * skipped for now: a player turret will happily shoot through their own
   * units. Real turret-line awareness can be layered on later.
   */
  private tickBuildingWeapon(b: Building, dt: number, units: UnitManager, world: VoxelWorld): void {
    if (b.weaponFireCooldown > 0) {
      b.weaponFireCooldown = Math.max(0, b.weaponFireCooldown - dt);
    }
    const wKind = b.spec.weapon!;
    const w = WEAPONS[wKind];

    // Building's footprint centre in world meters, plus muzzle height above
    // the floor (per spec).
    const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const floorTopMeters = (b.floorY + 1) * VOXEL_SIZE;
    const muzzleY = floorTopMeters + (b.spec.weaponMuzzleHeight ?? 1.0);
    const muzzleXZRange2 = w.rangeMeters * w.rangeMeters;
    const pcfgScan = PROJECTILES[w.projectile];
    const boostMeters = pcfgScan.boostMetersDefault ?? 0;
    const launcherCap = b.spec.launcherMaxStrength ?? Infinity;
    // Hittability scan needs the manager to predict trajectories; when it's
    // missing (test sandbox), skip the filter and just pick the nearest.
    const pmForScan = this.projectiles;

    // Find the closest LIVING enemy in horizontal range whose body the round
    // can actually reach with this weapon. If nobody is hittable we still
    // pick the closest enemy as a tracking target (the turret slews to face
    // them) but skip the fire — better than freezing at the last yaw.
    let bestU: Unit | null = null;
    let bestD2 = muzzleXZRange2;
    let bestUHittable: Unit | null = null;
    let bestD2Hittable = muzzleXZRange2;
    for (const u of units.units) {
      if (u.hp <= 0) continue;
      if (u.team !== 'enemy') continue;
      const dx = u.x - cxw, dz = u.z - czw;
      const d2 = dx * dx + dz * dz;
      if (d2 > muzzleXZRange2) continue;
      if (d2 < bestD2) { bestD2 = d2; bestU = u; }
      // Hittability scan: solve the proper ballistic launch direction so the
      // arc actually lands at the target instead of plowing flat into the
      // ground short of it. Slow projectiles like the turret shell drop a
      // lot before reaching even mid-range targets, so a flat aim-at-torso
      // gives a false negative on every shot — the round visibly falls
      // short of the target every time.
      const targetTY = u.y + Math.max(0.7, u.widthMeters * 0.6);
      const launchSpeed = Math.min(PROJECTILES[w.projectile].muzzleVelocity * w.velocityScale, launcherCap);
      const ballistic = solveBallisticDirection(cxw, muzzleY, czw, u.x, targetTY, u.z, launchSpeed, PROJECTILE_GRAVITY);
      const dirX = ballistic.x, dirY = ballistic.y, dirZ = ballistic.z;
      const boost = boostMeters > 0
        ? { meters: boostMeters, targetX: u.x, targetY: targetTY, targetZ: u.z }
        : undefined;
      const reachable = pmForScan
        ? projectileWillReach(pmForScan, w.projectile, cxw, muzzleY, czw, dirX, dirY, dirZ, w.velocityScale, launcherCap, u, boost, world)
        : true;
      if (reachable && d2 < bestD2Hittable) { bestD2Hittable = d2; bestUHittable = u; }
    }
    // Prefer a hittable target; fall back to the closest enemy in range.
    bestU = bestUHittable ?? bestU;
    if (!bestU) return;

    // Slew the visible turret toward the target.
    const tdx = bestU.x - cxw;
    const tdz = bestU.z - czw;
    const targetYaw = Math.atan2(-tdx, -tdz);
    const diff = wrapAngle(targetYaw - b.weaponTurretYaw);
    const step = w.aimSlewRadPerSec * dt;
    b.weaponTurretYaw += diff < -step ? -step : diff > step ? step : diff;

    const remaining = wrapAngle(targetYaw - b.weaponTurretYaw);
    if (Math.abs(remaining) > w.aimToleranceRad) return;
    if (b.weaponFireCooldown > 0) return;
    if (!this.projectiles) return;

    // Solve the launch direction as a real ballistic arc. With the slow
    // catalog projectiles a flat aim-at-torso shot drops well below the
    // target before it gets there; the proper arc clears the gap. The
    // solver returns a unit-length direction so we use it directly without
    // re-normalising.
    const targetTorsoY = bestU.y + Math.max(0.7, bestU.widthMeters * 0.6);
    const launchSpeed = Math.min(PROJECTILES[w.projectile].muzzleVelocity * w.velocityScale, b.spec.launcherMaxStrength ?? Infinity);
    const ballistic = solveBallisticDirection(cxw, muzzleY, czw, bestU.x, targetTorsoY, bestU.z, launchSpeed, PROJECTILE_GRAVITY);
    const dirX = ballistic.x;
    const dirY = ballistic.y;
    const dirZ = ballistic.z;

    // Building's "owner id" for the projectile — negative numbers can't
    // collide with any real unit id, so the friendly-skip logic in the
    // projectile manager is a no-op for building shots (which is what we
    // want; the building itself isn't a unit).
    const ownerId = -1000 - b.id;
    const muzzle = muzzleOrigin(cxw, muzzleY - 1.2, czw, dirX, dirY, dirZ, 0.5, 1.2);
    // Hittability gate — predict the trajectory before pulling the trigger
    // and bail when the predicted impact won't actually affect the target.
    // Stops a turret from shelling a hill the enemy is hiding behind, and
    // stops a silo from gambling missiles that will bury themselves into
    // the parapet. Cooldown is preserved on a no-fire so the building keeps
    // re-evaluating each tick.
    const pcfg = PROJECTILES[w.projectile];
    const boost = pcfg.boostMetersDefault && pcfg.boostMetersDefault > 0
      ? {
          meters: pcfg.boostMetersDefault,
          targetX: bestU.x,
          targetY: targetTorsoY,
          targetZ: bestU.z,
        }
      : undefined;
    if (!projectileWillReach(this.projectiles, w.projectile, muzzle.x, muzzle.y, muzzle.z, dirX, dirY, dirZ, w.velocityScale, b.spec.launcherMaxStrength ?? Infinity, bestU, boost, world)) {
      return;
    }
    this.projectiles.spawn(
      w.projectile,
      muzzle.x, muzzle.y, muzzle.z,
      dirX, dirY, dirZ,
      ownerId,
      w.velocityScale,
      b.spec.launcherMaxStrength ?? Infinity,
      boost,
    );
    b.weaponFireCooldown = w.fireInterval;

    if (this.onBuildingMuzzleFlash) {
      const pcfg = PROJECTILES[w.projectile];
      this.onBuildingMuzzleFlash(
        muzzle.x, muzzle.y, muzzle.z,
        w.muzzleFlashRadius, w.muzzleFlashSeconds,
        { r: pcfg.colorR, g: pcfg.colorG, b: pcfg.colorB },
      );
    }
  }

  /**
   * Anti-air firing pipeline. Each frame:
   *   1. Decay cooldown.
   *   2. If the magazine is empty, decay the reload timer instead of firing
   *      and slew the turret head down to a stowed pose so the building
   *      reads as offline. When the timer hits 0 the magazine refills.
   *   3. Pick the nearest in-range projectile NOT fired by an AA building.
   *   4. Solve a lead point — where the projectile will be when the flak
   *      shell arrives — and aim slightly below it so the upward-biased
   *      shrapnel cone goes off underneath the round.
   *   5. Slew the visible turret toward the lead point and fire when within
   *      the weapon's aim tolerance and the cooldown is ready. Each shot
   *      drains a round; emptying the magazine triggers the reload cycle.
   *
   * The actual interception (chance to disrupt the target round) is owned by
   * the projectile manager: when a flak shell detonates, any projectile
   * inside its blast gets a 90% disruption roll. This keeps the targeting
   * logic here purely about delivering the burst.
   */
  private tickAntiAir(b: Building, dt: number, units: UnitManager): void {
    if (b.weaponFireCooldown > 0) {
      b.weaponFireCooldown = Math.max(0, b.weaponFireCooldown - dt);
    }
    const wKind = b.spec.weapon!;
    const w = WEAPONS[wKind];
    const pm = this.projectiles;
    if (!pm) return;

    // Reload cycle. While the timer is positive the turret is offline: no
    // targeting, no firing, and the head pitches down toward the stowed pose
    // so the renderer reads "reloading" without any extra HUD plumbing.
    // AIM_PITCH_RAD_PER_SEC controls how quickly the head drops / rises;
    // STOWED_PITCH is how far down the barrel parks (~70° below horizontal).
    const STOWED_PITCH = -1.2;
    const AIM_PITCH_RAD_PER_SEC = 1.4;
    if (b.weaponReloadTimer > 0) {
      b.weaponReloadTimer = Math.max(0, b.weaponReloadTimer - dt);
      const pitchStep = AIM_PITCH_RAD_PER_SEC * dt;
      const pitchDiff = STOWED_PITCH - b.weaponTurretPitch;
      b.weaponTurretPitch +=
        pitchDiff < -pitchStep ? -pitchStep : pitchDiff > pitchStep ? pitchStep : pitchDiff;
      if (b.weaponReloadTimer === 0 && b.spec.weaponMagazineSize !== undefined) {
        b.weaponAmmo = b.spec.weaponMagazineSize;
      }
      return;
    }
    // Not reloading: ease the barrel back to level any time it sits below 0.
    if (b.weaponTurretPitch !== 0) {
      const pitchStep = AIM_PITCH_RAD_PER_SEC * dt;
      const pitchDiff = 0 - b.weaponTurretPitch;
      b.weaponTurretPitch +=
        pitchDiff < -pitchStep ? -pitchStep : pitchDiff > pitchStep ? pitchStep : pitchDiff;
    }
    const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const floorTopMeters = (b.floorY + 1) * VOXEL_SIZE;
    const muzzleY = floorTopMeters + (b.spec.weaponMuzzleHeight ?? 1.0);
    const range2 = w.rangeMeters * w.rangeMeters;
    const flakSpeed = Math.min(
      PROJECTILES[w.projectile].muzzleVelocity * w.velocityScale,
      b.spec.launcherMaxStrength ?? Infinity,
    );

    // Pick the closest live projectile inside the AA dome that the AA didn't
    // fire itself. Skipping the AA's own shells stops a turret from chasing
    // the shell it just lobbed.
    let bestP: Projectile | null = null;
    let bestD2 = range2;
    for (const p of pm.projectiles) {
      if (p.dead) continue;
      // Skip our own kind — AA never chases friendly flak shells.
      if (p.kind === 'flak_shell') continue;
      // Skip rounds owned by friendly units / buildings. Buildings carry a
      // negative owner id (we can't easily resolve their team here, but the
      // player owns every building today) so treat negative ids as friendly.
      // Positive ids are units; check the unit's team to decide.
      if (p.ownerId >= 0) {
        const owner = lookupUnit(units, p.ownerId);
        if (owner && owner.team !== 'enemy') continue;
      } else if (p.ownerId !== -1) {
        // -1 is anonymous (e.g. cluster submunition). Anything else negative
        // is a friendly building — skip.
        continue;
      }
      const dx = p.x - cxw, dy = p.y - muzzleY, dz = p.z - czw;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > range2) continue;
      // Prefer the round closest to the AA so we always engage the most
      // immediate threat.
      if (d2 < bestD2) { bestD2 = d2; bestP = p; }
    }
    if (!bestP) return;

    // Lead solve: time-of-flight ≈ distance / flak muzzle speed (ignoring drag
    // and gravity to keep the lead computation stable when the target is fast
    // and close). Predict where the target will be after that delay using its
    // current velocity + simple gravity falloff.
    const dxNow = bestP.x - cxw;
    const dyNow = bestP.y - muzzleY;
    const dzNow = bestP.z - czw;
    const distNow = Math.hypot(dxNow, dyNow, dzNow);
    const tof = Math.max(0.05, distNow / Math.max(20, flakSpeed));
    let leadX = bestP.x + bestP.vx * tof;
    let leadY = bestP.y + bestP.vy * tof - 0.5 * PROJECTILE_GRAVITY * tof * tof;
    let leadZ = bestP.z + bestP.vz * tof;
    // Aim slightly below the lead point so the upward-biased flak burst goes
    // off just under the round on its way through. ~1 m below puts the
    // explosion sphere centred where the cone has the best chance to hit.
    leadY = Math.max(0.5, leadY - 1.0);

    // Slew the visible turret toward the lead point.
    const tdx = leadX - cxw;
    const tdz = leadZ - czw;
    const targetYaw = Math.atan2(-tdx, -tdz);
    const diff = wrapAngle(targetYaw - b.weaponTurretYaw);
    const step = w.aimSlewRadPerSec * dt;
    b.weaponTurretYaw += diff < -step ? -step : diff > step ? step : diff;

    const remaining = wrapAngle(targetYaw - b.weaponTurretYaw);
    if (Math.abs(remaining) > w.aimToleranceRad) return;
    if (b.weaponFireCooldown > 0) return;

    // Fire toward the lead point at the chosen muzzle direction. AA turrets
    // are allowed to point sharply up — the flak shell's trajectory is what
    // we use, not the turret's slew.
    const ddx = leadX - cxw;
    const ddy = leadY - muzzleY;
    const ddz = leadZ - czw;
    const dl = Math.hypot(ddx, ddy, ddz) || 1;
    const dirX = ddx / dl;
    const dirY = ddy / dl;
    const dirZ = ddz / dl;
    const ownerId = -2000 - b.id;
    const muzzle = muzzleOrigin(cxw, muzzleY - 1.2, czw, dirX, dirY, dirZ, 0.5, 1.2);
    pm.spawn(
      w.projectile,
      muzzle.x, muzzle.y, muzzle.z,
      dirX, dirY, dirZ,
      ownerId,
      w.velocityScale,
      b.spec.launcherMaxStrength ?? Infinity,
    );
    b.weaponFireCooldown = w.fireInterval;
    if (b.spec.weaponMagazineSize !== undefined) {
      b.weaponAmmo = Math.max(0, b.weaponAmmo - 1);
      if (b.weaponAmmo === 0) {
        b.weaponReloadTimer = b.spec.weaponReloadSeconds ?? 0;
      }
    }

    if (this.onBuildingMuzzleFlash) {
      const pcfg = PROJECTILES[w.projectile];
      this.onBuildingMuzzleFlash(
        muzzle.x, muzzle.y, muzzle.z,
        w.muzzleFlashRadius, w.muzzleFlashSeconds,
        { r: pcfg.colorR, g: pcfg.colorG, b: pcfg.colorB },
      );
    }
  }

  /**
   * Per-frame farm tick. Crops grow on a 0..1 progress meter; ambient growth
   * is slow (so you see something happen even without a farmer), and an
   * assigned farmer who is actually standing in the field accelerates it ~4x.
   * On reaching 1, `cropReady` flips and growth pauses until a harvester
   * collects (which clears it back to 0).
   *
   * Liveness check is folded into this tick on a coarse interval so a farm
   * whose fence has been levelled goes inert.
   */
  private tickFarm(b: Building, dt: number, world: VoxelWorld, units: UnitManager): void {
    // Coarse liveness check, throttled to once per spec interval like other
    // buildings — counting voxels every frame is overkill.
    b.productionTimer -= dt;
    if (b.productionTimer <= 0) {
      b.productionTimer += b.spec.productionInterval;
      const alive = countLivingWalls(world, b);
      if (alive < b.wallVoxelsAtBuild * 0.25) {
        b.destroyed = true;
        return;
      }
    }
    if (b.cropReady) return;
    // Validate the assigned farmer still exists, is alive, and is at the farm
    // with the farm task. If any of those fails, drop the assignment so a new
    // worker can be tasked without a stale slot.
    let farmerActive = false;
    if (b.farmerId !== null) {
      const farmer = lookupUnit(units, b.farmerId);
      if (!farmer || farmer.hp <= 0) {
        b.farmerId = null;
      } else if (farmer.task.kind === 'farm' && farmer.task.buildingId === b.id) {
        // Farmer must be standing in the farm rectangle to count as tending.
        const wxStart = b.ox * NAV_CELL_VOXELS * VOXEL_SIZE;
        const wzStart = b.oz * NAV_CELL_VOXELS * VOXEL_SIZE;
        const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS * VOXEL_SIZE;
        const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS * VOXEL_SIZE;
        if (farmer.x >= wxStart && farmer.x < wxEnd && farmer.z >= wzStart && farmer.z < wzEnd) {
          farmerActive = true;
        }
      } else {
        // Worker quit the task (player overrode with a move/chop command).
        b.farmerId = null;
      }
    }
    // Validate harvester claim — clear it if the claimant is gone or no longer
    // headed here, so a new harvester can pick up where they left off.
    if (b.harvesterClaimId !== null) {
      const h = lookupUnit(units, b.harvesterClaimId);
      if (!h || h.hp <= 0 || (h.task.kind !== 'harvestFarm' || h.task.buildingId !== b.id)) {
        b.harvesterClaimId = null;
      }
    }
    // Growth: slow ambient rate without a farmer, ×4 with a tending farmer. The
    // numbers are tuned so farmer-tended fields ripen in ~productionInterval
    // seconds; ambient growth still gets there but takes 4× longer.
    const ambientRatePerSec = 0.25 / b.spec.productionInterval;
    const tendedRatePerSec = 1.0 / b.spec.productionInterval;
    const rate = farmerActive ? tendedRatePerSec : ambientRatePerSec;
    b.cropProgress = Math.min(1, b.cropProgress + rate * dt);
    if (b.cropProgress >= 1) {
      b.cropReady = true;
    }
  }

  /**
   * Called by tickWorkers when a harvester reaches a ripe farm. Drops the
   * crop into the player's food counter, resets the farm, and clears the
   * claim so the same field can ripen again.
   */
  collectFarm(b: Building, harvesterId: number): { foodGained: number } {
    if (!b.cropReady) return { foodGained: 0 };
    if (b.harvesterClaimId !== null && b.harvesterClaimId !== harvesterId) return { foodGained: 0 };
    const food = 5;
    b.cropReady = false;
    b.cropProgress = 0;
    b.harvesterClaimId = null;
    if (this.foodSink) this.foodSink(food, b);
    return { foodGained: food };
  }

  /**
   * Iterate ripe, unclaimed farms in ascending squared XZ distance from
   * (x, z). Used by the harvester scan to pick up the nearest available
   * field without each harvester running its own scan.
   */
  nearestReadyFarm(x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD2 = Infinity;
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'farm') continue;
      if (!b.cropReady) continue;
      if (b.harvesterClaimId !== null) continue;
      const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const dx = cxw - x, dz = czw - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

  /** Lookup helper — returns the building with the given id, or null. */
  byId(id: number): Building | null {
    for (const b of this.buildings) if (b.id === id) return b;
    return null;
  }

  /** Clear `selected` on every building. Used when the player picks a unit. */
  deselectAll(): void {
    for (const b of this.buildings) b.selected = false;
  }

  /** The single currently-selected building, or null when none/multiple. */
  getSelected(): Building | null {
    let found: Building | null = null;
    for (const b of this.buildings) {
      if (!b.selected || b.destroyed) continue;
      if (found) return null;
      found = b;
    }
    return found;
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

/** Find a unit by id without exposing UnitManager internals to the manager file. */
function lookupUnit(units: UnitManager, id: number): Unit | null {
  for (const u of units.units) if (u.id === id) return u;
  return null;
}

/**
 * Distance in meters from world point `(x, y, z)` to the building's footprint
 * AABB. The Y span covers floor → roof (plus 1 voxel of slack so a hit on the
 * uppermost roof voxel still reads as inside). Returns 0 when the point lies
 * inside the box. Used by `applyImpactDamage` to decide direct-hit vs splash.
 */
function aabbDistance(b: Building, x: number, y: number, z: number): number {
  const wxStart = b.ox * NAV_CELL_VOXELS * VOXEL_SIZE;
  const wzStart = b.oz * NAV_CELL_VOXELS * VOXEL_SIZE;
  const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS * VOXEL_SIZE;
  const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS * VOXEL_SIZE;
  const yFloor = b.floorY * VOXEL_SIZE;
  const yRoof = (b.floorY + b.spec.headroomVoxels + 1) * VOXEL_SIZE;
  const cx = Math.max(wxStart, Math.min(x, wxEnd));
  const cy = Math.max(yFloor, Math.min(y, yRoof));
  const cz = Math.max(wzStart, Math.min(z, wzEnd));
  return Math.hypot(x - cx, y - cy, z - cz);
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Predict whether a projectile fired from `(fx,fy,fz)` along `(dx,dy,dz)` will
 * actually affect `target` — either landing within the projectile's
 * `explosionRadiusMeters` of the target's torso (for explosives) or sweeping
 * through the target's body bounding sphere along the predicted line (for
 * direct-fire rounds). Used by buildings to avoid wasting shots on a target
 * tucked behind cover. Pure read of the manager's predictTrajectory.
 */
function projectileWillReach(
  pm: ProjectileManager,
  kind: import('./Projectiles').ProjectileKind,
  fx: number, fy: number, fz: number,
  dx: number, dy: number, dz: number,
  velocityScale: number,
  maxStrength: number,
  target: Unit,
  boost: { meters: number; targetX: number; targetY: number; targetZ: number } | undefined,
  world: VoxelWorld | null,
): boolean {
  const cfg = PROJECTILES[kind];
  // Target torso point — same offset the unit-ray-hit logic uses.
  const targetX = target.x;
  const targetY = target.y + Math.max(0.7, target.widthMeters * 0.6);
  const targetZ = target.z;
  const points = pm.predictTrajectory(
    kind,
    fx, fy, fz,
    dx, dy, dz,
    world,                // world raycast → trajectory ends at first wall
    0,
    96, 0.06,
    velocityScale, maxStrength,
    boost,
  );
  // For explosives, the warhead's blast covers a sphere — landing within the
  // explosion radius of the target counts as a hit.
  if (cfg.explosive) {
    const last = points[points.length - 1];
    if (!last) return false;
    const r = cfg.explosionRadiusMeters + (target.widthMeters * 0.55 + 0.35);
    const d = Math.hypot(last.x - targetX, last.y - targetY, last.z - targetZ);
    if (d <= r) return true;
    // Even if the final sample isn't at the target, check every sample —
    // a long rocket can pass directly over the target on its way past, and
    // we still want to count that as "blast clears the cover".
    for (const p of points) {
      const dd = Math.hypot(p.x - targetX, p.y - targetY, p.z - targetZ);
      if (dd <= r) return true;
    }
    return false;
  }
  // Direct-fire: check if any segment of the predicted line passes inside
  // the target's bounding sphere.
  const bodyR = target.widthMeters * 0.55 + 0.35;
  const bodyR2 = bodyR * bodyR;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
    const ssq = sx * sx + sy * sy + sz * sz;
    if (ssq < 1e-8) continue;
    const tx = targetX - a.x, ty = targetY - a.y, tz = targetZ - a.z;
    let t = (tx * sx + ty * sy + tz * sz) / ssq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = a.x + sx * t, cy = a.y + sy * t, cz = a.z + sz * t;
    const dxs = cx - targetX, dys = cy - targetY, dzs = cz - targetZ;
    if (dxs * dxs + dys * dys + dzs * dzs <= bodyR2) return true;
  }
  return false;
}
