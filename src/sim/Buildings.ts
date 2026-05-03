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
  | 'vehicle_depot'
  | 'farm'
  | 'storage'
  | 'power_plant'
  | 'refinery'
  | 'tech_lab'
  | 'turret'
  | 'silo'
  | 'hq';

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
   * Extra nav-cell columns reserved in the +X direction for the spawn pad.
   * These cells are validated by `checkFootprint` (same floor height, not
   * blocked, adequate headroom) so a building can never be placed where its
   * pad would be obstructed. 0 for non-producer buildings.
   */
  spawnPadCells: number;
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
  /**
   * Maximum distance in meters from this building within which other buildings
   * may be placed. Only meaningful for the HQ — all other specs leave this
   * undefined (no placement restriction).
   */
  buildRangeMeters?: number;
  /**
   * When true, the renderer draws a power line from this building to the
   * nearest live HQ. Used for power plants.
   */
  isEnergySource?: boolean;
  /**
   * Maximum number of supply trucks the HQ may have active simultaneously.
   * Only meaningful for HQ buildings.
   */
  maxTrucks?: number;
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
  // Infantry only — vehicles come out of the dedicated VEHICLE_DEPOT now so a
  // barracks reads as the personnel facility (soldier + worker bunks).
  produces: ['soldier', 'sniper', 'gunner', 'worker'],
  stamp: stampBarracks,
  spawnPadCells: 2,
};

/**
 * Vehicle depot — heavy assembly hangar for tanks, dozers, worms, tunnelers,
 * and rocket trucks. Larger footprint than a barracks (5x4) so the rolling
 * door fits at the front. Same metal/stone aesthetic but with a wide hangar
 * mouth; the renderer parks an in-progress chassis silhouette inside.
 */
export const VEHICLE_DEPOT: BuildingSpec = {
  kind: 'vehicle_depot',
  label: 'Vehicle Depot',
  cellsW: 5,
  cellsD: 4,
  headroomVoxels: 28, // 3.5 m clearance for tank turret
  wall: M_METAL,
  maxHp: 900,
  productionInterval: 9.0,
  produces: ['tank', 'dozer', 'tunneler', 'worm', 'rocket_truck'],
  stamp: stampVehicleDepot,
  spawnPadCells: 3,
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
  spawnPadCells: 0,
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
  spawnPadCells: 0,
};

export const POWER_PLANT: BuildingSpec = {
  kind: 'power_plant',
  label: 'Power Plant',
  // 4-cell footprint for the substation pad. A tall windmill on top makes the
  // building tower above neighbours rather than spread horizontally.
  cellsW: 4,
  cellsD: 4,
  headroomVoxels: 18, // 2.25 m machine room — tall windmill rises above
  wall: M_STONE,
  maxHp: 800,
  productionInterval: Infinity,
  produces: [],
  stamp: stampPowerPlant,
  spawnPadCells: 0,
  isEnergySource: true,
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
  spawnPadCells: 0,
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
  spawnPadCells: 0,
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
  spawnPadCells: 0,
};

/**
 * Anti-air missile launcher. Same chassis as the regular turret but its
 * weapon targets airborne projectiles instead of ground units. Fires a single
 * large slow interceptor missile (aa_missile) every 10 s — one shot per
 * engagement, no magazine cycle.
 *
 * Reuses `stampTurret` for the visible model (small stone emplacement). The
 * AA-specific behaviour is keyed off the spec's `weapon === 'aa_turret'`.
 */
export const AA_TURRET: BuildingSpec = {
  kind: 'turret',
  label: 'Anti-air Missile Launcher',
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
  spawnPadCells: 0,
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
  // Compact 3x3 footprint so the silo reads as a tight missile bunker rather
  // than a sprawling fortress; the missile cluster on top is rebalanced
  // around the smaller footprint in `stampSilo`.
  cellsW: 3,
  cellsD: 3,
  headroomVoxels: 32,           // ~4 m main hall + missile tubes above
  wall: M_STONE,
  maxHp: 1000,
  productionInterval: Infinity,
  produces: [],
  stamp: stampSilo,
  weapon: 'silo_launcher',
  launcherMaxStrength: 220,
  // Top of the missile cluster sits ~6 voxels above the parapet.
  weaponMuzzleHeight: (32 + 6) * VOXEL_SIZE,
  spawnPadCells: 0,
};

/**
 * Headquarters — the player's command center. Auto-placed near spawn; not in
 * the build menu. Defines the "build range" (nothing can be placed farther than
 * `buildRangeMeters` from any live HQ). Energy buildings draw power lines to it.
 */
export const HQ: BuildingSpec = {
  kind: 'hq',
  label: 'Headquarters',
  cellsW: 6,
  cellsD: 5,
  headroomVoxels: 12,
  wall: M_STONE,
  maxHp: 3000,
  productionInterval: Infinity,
  produces: [],
  stamp: stampHQ,
  spawnPadCells: 0,
  buildRangeMeters: 60,
  maxTrucks: 5,
};

/** All building specs in the order they appear on the build-mode hotkeys (1..N). */
export const ALL_BUILDINGS: BuildingSpec[] = [BARRACKS, VEHICLE_DEPOT, FARM, STORAGE, POWER_PLANT, REFINERY, TECH_LAB, TURRET, AA_TURRET, SILO];

/** Resource cost to train each unit kind. Deducted when HQ dispatches a supply truck. */
export const UNIT_TRAIN_COST: Record<UnitKind, { food: number; metals: number; wood: number }> = {
  soldier:      { food: 40,  metals: 10,  wood: 10  },
  sniper:       { food: 50,  metals: 20,  wood: 15  },
  gunner:       { food: 60,  metals: 30,  wood: 0   },
  tank:         { food: 20,  metals: 80,  wood: 0   },
  tunneler:     { food: 20,  metals: 120, wood: 0   },
  worm:         { food: 20,  metals: 100, wood: 0   },
  worker:       { food: 30,  metals: 0,   wood: 10  },
  dozer:        { food: 20,  metals: 60,  wood: 0   },
  rocket_truck: { food: 20,  metals: 80,  wood: 0   },
  supply_truck: { food: 0,   metals: 0,   wood: 0   },
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
  /**
   * World-space position units walk to after spawning from this building.
   * Null means newly spawned units have no rally destination and just idle
   * at the door. Only meaningful for producer buildings (barracks, depot).
   */
  rallyPoint: { x: number; y: number; z: number } | null;
  /**
   * Stance assigned to units that reach the rally point. 'aggressive' makes
   * them auto-engage enemies in range; 'defensive' keeps them idle until
   * ordered. Defaults to 'aggressive'.
   */
  rallyStance: 'aggressive' | 'defensive';
  /**
   * Rolling counter used to spread successive spawns across pad cells so
   * units don't stack at the same world position. Incremented after each
   * spawn; wraps via modulo against the pad area.
   */
  spawnSlot: number;
  /**
   * Stockpile of harvested resources waiting for a truck to collect them.
   * Meaningful for storage buildings. Workers deposit here instead of directly
   * into the global resource pool; supply trucks then carry it to HQ.
   */
  stockpile: { metals: number; wood: number };
  /**
   * Minimum total stockpile (metals + wood) that must accumulate before this
   * storage building requests a pickup truck. Configurable per-building via the
   * selection panel slider. Default 50.
   */
  truckCallThreshold: number;
  /**
   * True when a supply truck is already on its way to this building (either
   * to pick up from a storage, or to deliver to a production building).
   * Prevents double-dispatching.
   */
  supplyInbound: boolean;
  /**
   * Set true when a supply truck delivers materials to a production building.
   * Cleared immediately after the building consumes it to spawn a unit.
   */
  supplyDelivered: boolean;
  /**
   * HQ-only: number of supply trucks currently dispatched (en route or
   * returning). Capped at `spec.maxTrucks`.
   */
  activeTrucks: number;
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
  const totalW = spec.cellsW + spec.spawnPadCells;
  if (ox < 0 || oz < 0 || ox + totalW > NAV_W || oz + spec.cellsD > NAV_H) {
    return { ok: false, reason: 'out of bounds', floorY: -1, ox, oz };
  }
  const i0 = navIndex(ox, oz);
  if (nav.blocked[i0]) return { ok: false, reason: 'no surface', floorY: -1, ox, oz };
  const baseY = nav.topY[i0]!;

  // Validate building footprint + pad cells together for floor evenness.
  for (let dz = 0; dz < spec.cellsD; dz++) {
    for (let dx = 0; dx < totalW; dx++) {
      const i = navIndex(ox + dx, oz + dz);
      if (nav.blocked[i]) return { ok: false, reason: 'blocked cell', floorY: baseY, ox, oz };
      const y = nav.topY[i]!;
      if (Math.abs(y - baseY) > FLAT_TOLERANCE_VOXELS) {
        return { ok: false, reason: 'uneven floor', floorY: baseY, ox, oz };
      }
    }
  }

  // Headroom: check above both building and pad cells (units need to walk out).
  const headroom = spec.headroomVoxels;
  for (let dz = 0; dz < spec.cellsD; dz++) {
    for (let dx = 0; dx < totalW; dx++) {
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
  // Garrison barracks: wood walls with a 4-voxel stone foundation, four corner
  // battle towers rising above the parapet, arched slot windows, covered porch,
  // and a flag pole over the rear corner.
  const spec = BARRACKS;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS; // +32
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS; // +32
  const yFloor = floorY + 1;
  const yRoof  = floorY + spec.headroomVoxels;

  // Wide door on +X face (4 voxels wide, 10 tall).
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;
  const doorYTop = yFloor + 10;

  let count = 0;

  // 1. Floor — packed earth path.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_PATH);
      count++;
    }
  }

  // 2. Perimeter walls (stone base 4 voxels, then wood).
  for (let y = yFloor + 1; y <= yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        const mat = (y - yFloor) <= 4 ? M_STONE : M_WOOD;
        world.set(x, y, z, mat);
        count++;
      }
    }
  }

  // 3. Roof — solid wood planking.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yRoof, z, M_WOOD);
      count++;
    }
  }

  // 4. Crenellated parapet: alternating merlons (2-high) and gaps around the
  //    roof perimeter, inset 1 voxel so the merlons sit on the wall top.
  for (let dy = 1; dy <= 3; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    // -Z and +Z parapet strips.
    for (let x = wxStart + 1; x < wxEnd - 1; x++) {
      // Merlon every 4 voxels, gap in between.
      const isMerlon = ((x - wxStart) % 4) < 2;
      if (dy <= 2 || isMerlon) {
        world.set(x, py, wzStart, M_STONE);      count++;
        world.set(x, py, wzEnd - 1, M_STONE);   count++;
      }
    }
    // -X and +X parapet strips.
    for (let z = wzStart + 1; z < wzEnd - 1; z++) {
      const isMerlon = ((z - wzStart) % 4) < 2;
      if (dy <= 2 || isMerlon) {
        world.set(wxStart, py, z, M_STONE);      count++;
      }
    }
  }

  // 5. Corner battle towers: 4×4 stone hollow columns rising 8 voxels above roof.
  const towerCorners: [number, number][] = [
    [wxStart - 2,    wzStart - 2],
    [wxEnd  - 2,    wzStart - 2],
    [wxStart - 2,    wzEnd  - 2],
    [wxEnd  - 2,    wzEnd  - 2],
  ];
  for (const [tcx, tcz] of towerCorners) {
    for (let y = yFloor + 1; y <= yRoof + 8; y++) {
      if (y >= WORLD_Y) break;
      for (let xo = 0; xo < 4; xo++) {
        for (let zo = 0; zo < 4; zo++) {
          const tx = tcx + xo, tz = tcz + zo;
          if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
          const onWall = xo === 0 || xo === 3 || zo === 0 || zo === 3;
          if (!onWall) continue;
          world.set(tx, y, tz, M_STONE);
          count++;
        }
      }
    }
    // Tower roof cap + small merlon.
    for (let xo = 0; xo < 4; xo++) {
      for (let zo = 0; zo < 4; zo++) {
        const tx = tcx + xo, tz = tcz + zo;
        if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
        const capY = yRoof + 9;
        if (capY < WORLD_Y) { world.set(tx, capY, tz, M_STONE); count++; }
      }
    }
  }

  // 6. Slot windows on -Z, +Z and -X faces — 2-wide, 4-tall, at mid-height.
  const winY0 = yFloor + 8;
  const winH  = 4;
  for (let wx = wxStart + 6; wx < wxEnd - 5; wx += 8) {
    for (let dy = 0; dy < winH; dy++) {
      const py = winY0 + dy;
      if (py >= yRoof) break;
      if (wx >= wxEnd - 1 || wx + 1 >= wxEnd - 1) continue;
      // -Z face
      world.set(wx, py, wzStart, AIR);      count--;
      world.set(wx + 1, py, wzStart, AIR);  count--;
      // +Z face
      world.set(wx, py, wzEnd - 1, AIR);    count--;
      world.set(wx + 1, py, wzEnd - 1, AIR); count--;
    }
  }
  // -X face windows.
  for (let wz = wzStart + 6; wz < wzEnd - 5; wz += 8) {
    for (let dy = 0; dy < winH; dy++) {
      const py = winY0 + dy;
      if (py >= yRoof) break;
      world.set(wxStart, py, wz, AIR);     count--;
      world.set(wxStart, py, wz + 1, AIR); count--;
    }
  }

  // 7. Entrance porch: 3-voxel-deep wood canopy above the door on +X face.
  const porchZ0 = doorWz0 - 1, porchZ1 = doorWz1 + 1;
  const porchTopY = yFloor + doorYTop + 1;
  if (porchTopY < WORLD_Y) {
    // Canopy slab.
    for (let pz = porchZ0; pz <= porchZ1; pz++) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      for (let dx = 0; dx < 4; dx++) {
        const px = wxEnd + dx;
        if (px >= WORLD_X) break;
        world.set(px, porchTopY, pz, M_WOOD);
        count++;
      }
    }
    // Two support posts at the outer edge.
    for (const pz of [porchZ0, porchZ1]) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      const px = wxEnd + 3;
      if (px >= WORLD_X) continue;
      for (let y = yFloor + 1; y <= porchTopY; y++) {
        if (y >= WORLD_Y) break;
        world.set(px, y, pz, M_WOOD);
        count++;
      }
    }
  }

  // 8. Flag pole — tall wood column at rear corner with a small metal banner.
  const poleX = wxEnd - 3;
  const poleZ = wzStart + 2;
  for (let dy = 1; dy <= 12; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    world.set(poleX, py, poleZ, M_WOOD);
    count++;
  }
  for (let i = 0; i < 4; i++) {
    const py = yRoof + 8 + i;
    if (py >= WORLD_Y) break;
    const flagX = poleX + 1 + (3 - i > 0 ? 3 - i : 0);
    if (flagX >= WORLD_X) break;
    world.set(flagX, py, poleZ, M_METAL);
    count++;
  }

  // 9. Spawn pad.
  const padX0 = wxEnd;
  const padX1 = padX0 + spec.spawnPadCells * NAV_CELL_VOXELS;
  for (let px = padX0; px < padX1; px++) {
    if (px >= WORLD_X) break;
    for (let pz = wzStart; pz < wzEnd; pz++) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      world.set(px, yFloor, pz, M_PATH);
    }
  }

  return count;
}

/**
 * Vehicle depot — wide industrial hangar with corrugated metal walls, a large
 * arched gable over the rolling door, lateral buttress ribs, a ridge lantern,
 * and a concrete apron in front.
 */
export function stampVehicleDepot(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = VEHICLE_DEPOT;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS; // +40
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS; // +32
  const yFloor = floorY + 1;
  const yRoof  = floorY + spec.headroomVoxels;

  // Wide hangar door — 8 voxels wide, 16 tall, centered on +X face.
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 4;
  const doorWz1 = doorWz0 + 7;
  const doorYTop = yFloor + 16;

  let count = 0;

  // 1. Concrete floor.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_STONE);
      count++;
    }
  }

  // 2. Perimeter walls — metal with stone corner anchor columns.
  for (let y = yFloor + 1; y <= yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        // Stone corner columns (2 voxels wide), metal everywhere else.
        const isCorner = (x <= wxStart + 1 || x >= wxEnd - 2) && (z <= wzStart + 1 || z >= wzEnd - 2);
        world.set(x, y, z, isCorner ? M_STONE : spec.wall);
        count++;
      }
    }
  }

  // 3. Corrugated metal roof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yRoof, z, M_METAL);
      count++;
    }
  }

  // 4. Lateral buttress ribs on -Z and +Z faces (every 8 voxels, 2-wide, full height).
  for (let rx = wxStart + 8; rx < wxEnd - 1; rx += 8) {
    for (let y = yFloor + 1; y <= yRoof; y++) {
      if (y >= WORLD_Y) break;
      // -Z face rib (protrudes 1 outward).
      const rz0 = wzStart - 1;
      if (rz0 >= 0) { world.set(rx, y, rz0, M_STONE); count++; }
      world.set(rx, y, wzStart, M_STONE); count++;
      // +Z face rib.
      const rz1 = wzEnd;
      if (rz1 < WORLD_Z) { world.set(rx, y, rz1, M_STONE); count++; }
      world.set(rx, y, wzEnd - 1, M_STONE); count++;
    }
  }

  // 5. Arched front gable over the door — stepped stone arch in the XZ plane
  //    on the +X face, sitting above the doorYTop.
  const archCz = (doorWz0 + doorWz1) >> 1;
  const archHalfW = (doorWz1 - doorWz0) / 2 + 1;
  for (let dy = 0; dy <= 6; dy++) {
    const py = yFloor + doorYTop + dy;
    if (py >= WORLD_Y) break;
    // Fill solid across the gable width minus how much the arch has progressed.
    const halfFilled = Math.max(0, archHalfW - dy);
    for (let zo = -Math.ceil(archHalfW); zo <= Math.ceil(archHalfW); zo++) {
      const pz = archCz + zo;
      if (pz < wzStart || pz >= wzEnd) continue;
      if (Math.abs(zo) <= halfFilled) {
        world.set(wxEnd - 1, py, pz, M_STONE);
        count++;
      }
    }
  }

  // 6. Ridge lantern — a narrow metal skylight tower along the roof centre.
  const ridgeMidX = (wxStart + wxEnd) >> 1;
  for (let x = ridgeMidX - 4; x <= ridgeMidX + 3; x++) {
    if (x <= wxStart || x >= wxEnd - 1) continue;
    for (let dy = 1; dy <= 5; dy++) {
      const py = yRoof + dy;
      if (py >= WORLD_Y) break;
      // Hollow lantern walls on Z sides.
      world.set(x, py, wzStart + 4, M_METAL);  count++;
      world.set(x, py, wzEnd  - 5, M_METAL);  count++;
    }
    // Cap.
    const capY = yRoof + 6;
    if (capY < WORLD_Y) { world.set(x, capY, wzStart + 4, M_METAL); count++; }
  }
  // Lantern Z columns.
  for (let z = wzStart + 4; z <= wzEnd - 5; z++) {
    for (let dy = 1; dy <= 5; dy++) {
      const py = yRoof + dy;
      if (py >= WORLD_Y) break;
      world.set(ridgeMidX - 4, py, z, M_METAL); count++;
      world.set(ridgeMidX + 3, py, z, M_METAL); count++;
    }
  }

  // 7. Exhaust vent stacks on the rear (-X) side.
  const ventZs = [wzStart + 8, wzEnd - 10];
  for (const vz of ventZs) {
    for (let dy = 1; dy <= 8; dy++) {
      const py = yRoof + dy;
      if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        const px = wxStart + 1 + xo;
        if (px >= WORLD_X) continue;
        world.set(px, py, vz, M_METAL); count++;
      }
    }
  }

  // 8. Spawn pad.
  const padX0 = wxEnd;
  const padX1 = padX0 + spec.spawnPadCells * NAV_CELL_VOXELS;
  for (let px = padX0; px < padX1; px++) {
    if (px >= WORLD_X) break;
    for (let pz = wzStart; pz < wzEnd; pz++) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      world.set(px, yFloor, pz, M_PATH);
    }
  }

  return count;
}

export function stampStorage(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  // Fortified storehouse: wood walls with stone corner towers, a flat roof
  // with crenels, a covered loading platform, and visible crate stacks on
  // the roof deck.
  const spec = STORAGE;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS; // +24
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS; // +24
  const yFloor = floorY + 1;
  const yRoof  = floorY + spec.headroomVoxels;

  // Entry door on +X face — 2 wide, 6 tall, centered.
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let count = 0;

  // 1. Wood floor.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_WOOD);
      count++;
    }
  }

  // 2. Perimeter walls (stone base 3 voxels, then wood).
  for (let y = yFloor + 1; y <= yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && (z === doorWz0 || z === doorWz1) && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, M_WOOD);
        count++;
      }
    }
  }

  // 3. Roof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yRoof, z, M_WOOD);
      count++;
    }
  }

  // 4. Corner towers — 3×3 stone hollow columns rising 5 voxels above roof.
  const towerCorners: [number, number][] = [
    [wxStart, wzStart], [wxEnd - 3, wzStart],
    [wxStart, wzEnd - 3], [wxEnd - 3, wzEnd - 3],
  ];
  for (const [tcx, tcz] of towerCorners) {
    for (let y = yRoof; y <= yRoof + 5; y++) {
      if (y >= WORLD_Y) break;
      for (let xo = 0; xo < 3; xo++) {
        for (let zo = 0; zo < 3; zo++) {
          const tx = tcx + xo, tz = tcz + zo;
          if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
          const onWall = xo === 0 || xo === 2 || zo === 0 || zo === 2;
          if (!onWall) continue;
          world.set(tx, y, tz, M_STONE);
          count++;
        }
      }
    }
    // Tower cap.
    for (let xo = 0; xo < 3; xo++) {
      for (let zo = 0; zo < 3; zo++) {
        const tx = tcx + xo, tz = tcz + zo;
        if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
        const capY = yRoof + 6;
        if (capY < WORLD_Y) { world.set(tx, capY, tz, M_STONE); count++; }
      }
    }
  }

  // 5. Covered loading platform in front of door.
  const platY = yFloor;
  for (let dx = 0; dx < 4; dx++) {
    const px = wxEnd + dx;
    if (px >= WORLD_X) break;
    for (let pz = doorWz0 - 1; pz <= doorWz1 + 1; pz++) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      world.set(px, platY, pz, M_PATH);
    }
  }
  // Platform roof.
  const platRoofY = yFloor + doorYTop;
  if (platRoofY < WORLD_Y) {
    for (let dx = 0; dx < 5; dx++) {
      const px = wxEnd + dx;
      if (px >= WORLD_X) break;
      for (let pz = doorWz0 - 1; pz <= doorWz1 + 1; pz++) {
        if (pz < 0 || pz >= WORLD_Z) continue;
        world.set(px, platRoofY, pz, M_WOOD);
        count++;
      }
    }
    // Platform roof posts.
    for (const pz of [doorWz0 - 1, doorWz1 + 1]) {
      const px = wxEnd + 4;
      if (px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
      for (let y = yFloor + 1; y < platRoofY; y++) {
        if (y >= WORLD_Y) break;
        world.set(px, y, pz, M_WOOD);
        count++;
      }
    }
  }

  // 6. Crate stacks on the roof — 2×2×3 wood piles at two diagonal positions.
  const cratePositions: [number, number][] = [
    [wxStart + 4, wzStart + 4],
    [wxEnd  - 8, wzEnd  - 8],
  ];
  for (const [bx, bz] of cratePositions) {
    for (let dy = 1; dy <= 3; dy++) {
      const py = yRoof + dy;
      if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        for (let zo = 0; zo < 2; zo++) {
          const tx = bx + xo, tz = bz + zo;
          if (tx >= WORLD_X || tz >= WORLD_Z) continue;
          world.set(tx, py, tz, M_WOOD);
          count++;
        }
      }
    }
  }

  return count;
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
 * Height of the windmill mast above the substation roof, in voxels. Exposed
 * so the renderer can mount the turbine head at the top without re-deriving
 * the geometry.
 */
export const POWER_PLANT_MAST_VOXELS = 30;

/**
 * Power plant: stone substation with chamfered corner buttresses, transformer
 * pods flanking the mast, and a tall lattice windmill mast in the centre.
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
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let wallCount = 0;

  // Floor: stone tiles.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_STONE);
      wallCount++;
    }
  }

  // Perimeter walls.
  for (let y = yFloor + 1; y <= yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && (z === doorWz0 || z === doorWz1) && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, spec.wall);
        wallCount++;
      }
    }
  }

  // Solid flat roof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yRoof, z, spec.wall);
      wallCount++;
    }
  }

  // Corner buttress pilasters — 2×2 stone blocks at each corner climbing
  // 4 voxels above the roof.
  const corners: [number, number][] = [
    [wxStart - 1, wzStart - 1], [wxEnd - 1, wzStart - 1],
    [wxStart - 1, wzEnd - 1],   [wxEnd - 1, wzEnd - 1],
  ];
  for (const [bcx, bcz] of corners) {
    for (let y = yFloor + 1; y <= yRoof + 4; y++) {
      if (y >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        for (let zo = 0; zo < 2; zo++) {
          const tx = bcx + xo, tz = bcz + zo;
          if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
          world.set(tx, y, tz, M_STONE);
          wallCount++;
        }
      }
    }
  }

  // Transformer pods flanking the mast on the roof (4 voxels tall, 4×4 footprint).
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;
  const podOffsets: [number, number][] = [
    [cxv - 10, czv - 3], [cxv + 8, czv - 3],
  ];
  for (const [px0, pz0] of podOffsets) {
    for (let dy = 1; dy <= 4; dy++) {
      const py = yRoof + dy;
      if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 4; xo++) {
        for (let zo = 0; zo < 4; zo++) {
          const tx = px0 + xo, tz = pz0 + zo;
          if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
          const onWall = xo === 0 || xo === 3 || zo === 0 || zo === 3 || dy === 4;
          if (!onWall) continue;
          world.set(tx, py, tz, M_METAL);
          wallCount++;
        }
      }
    }
    // Insulator post on top.
    const topY = yRoof + 5;
    if (topY < WORLD_Y) {
      world.set(px0 + 1, topY, pz0 + 1, M_STONE);
      world.set(px0 + 2, topY, pz0 + 2, M_STONE);
      wallCount += 2;
    }
  }

  // Mast — wider lattice base (4×4) for the first 6 voxels then 2×2 metal.
  const mastH = POWER_PLANT_MAST_VOXELS;
  for (let dy = 1; dy <= mastH; dy++) {
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    if (dy <= 6) {
      // Solid lattice base: 4×4 stone block tapering to 2×2 above.
      for (let xo = -2; xo <= 1; xo++) {
        for (let zo = -2; zo <= 1; zo++) {
          world.set(cxv + xo, py, czv + zo, M_STONE);
          wallCount++;
        }
      }
    } else {
      const mat = dy <= 10 ? M_STONE : M_METAL;
      for (let xo = -1; xo <= 0; xo++) {
        for (let zo = -1; zo <= 0; zo++) {
          world.set(cxv + xo, py, czv + zo, mat);
          wallCount++;
        }
      }
    }
  }
  // Stay cables (wood lattice bracing at 4 height bands).
  for (const dy of [8, 14, 20, 26]) {
    if (dy > mastH) break;
    const py = yRoof + dy;
    if (py >= WORLD_Y) break;
    world.set(cxv - 2, py, czv - 1, M_WOOD); wallCount++;
    world.set(cxv + 1, py, czv - 1, M_WOOD); wallCount++;
    world.set(cxv - 1, py, czv - 2, M_WOOD); wallCount++;
    world.set(cxv - 1, py, czv + 1, M_WOOD); wallCount++;
  }
  return wallCount;
}

/**
 * Metal refinery: a long processing hall with three tall chimneys, buttress ribs,
 * horizontal pipe runs on the roof, and a stepped loading hopper on the door face.
 * Footprint: 6W × 4D nav cells = 48 × 32 voxels, headroom 28.
 */
export function stampRefinery(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = REFINERY;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +48
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +32
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;
  const doorYTop = yFloor + 10;
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;

  let wallCount = 0;

  // Stone floor slab (2 voxels thick for weight).
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const py = yFloor - dy;
        if (py < 0) continue;
        world.set(x, py, z, M_STONE);
        wallCount++;
      }
    }
  }

  // Perimeter walls — lower 6 voxels stone, upper section metal cladding.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const onPerimeter = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (y === yRoof) {
          world.set(x, y, z, M_STONE);
          wallCount++;
        } else if (onPerimeter) {
          const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
          if (isDoor) { world.set(x, y, z, AIR); continue; }
          const mat = (y - yFloor) <= 8 ? M_STONE : M_METAL;
          world.set(x, y, z, mat);
          wallCount++;
        } else {
          world.set(x, y, z, AIR);
        }
      }
    }
  }

  // Buttress ribs — 2-voxel-wide stone columns projecting 2 voxels from the long
  // -Z and +Z walls at regular intervals, from floor to roof. Breaks the flat facade.
  const ribXPositions = [wxStart + 8, wxStart + 16, wxStart + 24, wxStart + 32, wxStart + 40];
  for (const ribX of ribXPositions) {
    if (ribX + 1 >= wxEnd) continue;
    for (let y = yFloor + 1; y <= yRoof; y++) {
      if (y >= WORLD_Y) break;
      // South rib (-Z face, protrudes toward -Z)
      world.set(ribX, y, wzStart - 1, M_STONE); wallCount++;
      world.set(ribX + 1, y, wzStart - 1, M_STONE); wallCount++;
      // North rib (+Z face, protrudes toward +Z)
      if (wzEnd < WORLD_Z) {
        world.set(ribX, y, wzEnd, M_STONE); wallCount++;
        world.set(ribX + 1, y, wzEnd, M_STONE); wallCount++;
      }
    }
    // Cap each rib at roof height
    for (let dy = 1; dy <= 2; dy++) {
      const py = yRoof + dy; if (py >= WORLD_Y) break;
      world.set(ribX, py, wzStart - 1, M_STONE); wallCount++;
      world.set(ribX + 1, py, wzStart - 1, M_STONE); wallCount++;
      if (wzEnd < WORLD_Z) {
        world.set(ribX, py, wzEnd, M_STONE); wallCount++;
        world.set(ribX + 1, py, wzEnd, M_STONE); wallCount++;
      }
    }
  }

  // Three chimneys — 2×2 stone columns rising 20 voxels above the roof.
  // Spaced across the -X half of the building.
  const chimPositions: [number, number][] = [
    [wxStart + 2, wzStart + 2],   // back-left corner stack
    [wxStart + 16, czv - 1],      // centre-left stack
    [wxStart + 30, czv - 1],      // centre-right stack
  ];
  const chimH = 20;
  const chimBaseY = yRoof + 1;
  for (const [cx, cz] of chimPositions) {
    for (let dy = 0; dy < chimH; dy++) {
      const py = chimBaseY + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        for (let zo = 0; zo < 2; zo++) {
          if (cx + xo >= WORLD_X || cz + zo >= WORLD_Z) continue;
          world.set(cx + xo, py, cz + zo, M_STONE);
          wallCount++;
        }
      }
    }
    // Metal chimney cap (top 2 voxels are metal)
    for (let dy = chimH - 2; dy < chimH; dy++) {
      const py = chimBaseY + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        for (let zo = 0; zo < 2; zo++) {
          if (cx + xo >= WORLD_X || cz + zo >= WORLD_Z) continue;
          world.set(cx + xo, py, cz + zo, M_METAL);
        }
      }
    }
  }

  // Roof pipe network — metal pipes connecting the chimney bases horizontally.
  const pipeY = yRoof + 1;
  if (pipeY < WORLD_Y) {
    // Main east-west spine along the centre.
    for (let x = chimPositions[0]![0] + 1; x < chimPositions[2]![0]; x++) {
      if (x >= WORLD_X) break;
      world.set(x, pipeY, czv, M_METAL); wallCount++;
    }
    // Spur from each chimney down to +X wall (collector header).
    for (const [cx] of chimPositions) {
      for (let x = cx + 2; x < wxEnd - 2; x++) {
        if (x >= WORLD_X) break;
        world.set(x, pipeY, czv - 1, M_METAL); wallCount++;
      }
    }
  }

  // Wide arched window strips — 3-tall × 2-wide cuts on each long wall at two heights.
  for (const winY of [yFloor + 10, yFloor + 18]) {
    if (winY + 2 >= yRoof) continue;
    for (let wx = wxStart + 6; wx < wxEnd - 5; wx += 10) {
      for (let dy = 0; dy < 3; dy++) {
        const py = winY + dy; if (py >= yRoof) break;
        if (wx >= wxStart && wx < WORLD_X) {
          world.set(wx, py, wzStart, AIR);
          world.set(wx + 1, py, wzStart, AIR);
        }
        if (wx >= wxStart && wx + 1 < WORLD_X && wzEnd - 1 < WORLD_Z) {
          world.set(wx, py, wzEnd - 1, AIR);
          world.set(wx + 1, py, wzEnd - 1, AIR);
        }
      }
    }
  }

  // Stepped loading hopper on the +X face — a 4-step stone staircase flanking the door.
  for (let s = 0; s < 4; s++) {
    const px = wxEnd + s; if (px >= WORLD_X) break;
    const stepH = 4 - s;
    for (let dy = 0; dy < stepH; dy++) {
      const py = yFloor + dy; if (py >= WORLD_Y) break;
      for (let z = wzStart + 2; z < doorWz0 - 1; z++) {
        if (z < 0 || z >= WORLD_Z) continue;
        world.set(px, py, z, M_STONE); wallCount++;
      }
      for (let z = doorWz1 + 2; z < wzEnd - 2; z++) {
        if (z < 0 || z >= WORLD_Z) continue;
        world.set(px, py, z, M_STONE); wallCount++;
      }
    }
  }

  return wallCount;
}

/**
 * Tech lab: a main research hall with an octagonal observation drum at the centre of
 * the roof and a slim antenna mast above it. Four corner sensor pods flank the drum.
 * The renderer mounts a sweeping satellite dish and a pulsing core on the mast.
 * Footprint: 4W × 4D nav cells = 32 × 32 voxels, headroom 20.
 */
export function stampTechLab(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = TECH_LAB;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +32
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +32
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;
  const doorYTop = yFloor + 8;
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;

  let wallCount = 0;

  // Raised stone plinth — 2-voxel-tall foundation slab wider than the hall by 1 voxel.
  for (let z = wzStart - 1; z <= wzEnd; z++) {
    for (let x = wxStart - 1; x <= wxEnd; x++) {
      if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const py = yFloor - dy; if (py < 0) continue;
        world.set(x, py, z, M_STONE); wallCount++;
      }
    }
  }

  // Main hall — stone base 6v, metal upper cladding, solid roof slab.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const onPerimeter = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (y === yRoof) {
          world.set(x, y, z, M_STONE); wallCount++;
        } else if (onPerimeter) {
          const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
          if (isDoor) { world.set(x, y, z, AIR); continue; }
          const mat = (y - yFloor) <= 6 ? M_STONE : M_METAL;
          world.set(x, y, z, mat); wallCount++;
        } else {
          world.set(x, y, z, AIR);
        }
      }
    }
  }

  // Tall arched windows — 2-wide × 8-tall on each face (-X, +X, -Z, +Z), centred.
  const archH = 8;
  const archY0 = yFloor + 7;
  // -X face
  for (let dy = 0; dy < archH; dy++) {
    const py = archY0 + dy; if (py >= yRoof) break;
    world.set(wxStart, py, czv - 1, AIR);
    world.set(wxStart, py, czv, AIR);
  }
  // +X face (skip over door columns)
  for (let dy = 0; dy < archH; dy++) {
    const py = archY0 + dy; if (py >= yRoof) break;
    world.set(wxEnd - 1, py, czv - 5, AIR);
    world.set(wxEnd - 1, py, czv - 4, AIR);
  }
  // -Z face
  for (let dy = 0; dy < archH; dy++) {
    const py = archY0 + dy; if (py >= yRoof) break;
    world.set(cxv - 1, py, wzStart, AIR);
    world.set(cxv, py, wzStart, AIR);
  }
  // +Z face
  for (let dy = 0; dy < archH; dy++) {
    const py = archY0 + dy; if (py >= yRoof) break;
    world.set(cxv - 1, py, wzEnd - 1, AIR);
    world.set(cxv, py, wzEnd - 1, AIR);
  }

  // Octagonal drum — sits centred on the roof, 10-voxel radius, 6 voxels tall.
  // We approximate an octagon by cutting the 4 corners of a 20×20 bounding square.
  const drumR = 9;
  const drumH = 6;
  const drumBaseY = yRoof + 1;
  for (let dy = 0; dy < drumH; dy++) {
    const py = drumBaseY + dy; if (py >= WORLD_Y) break;
    for (let dz = -drumR; dz <= drumR; dz++) {
      for (let dx = -drumR; dx <= drumR; dx++) {
        const ax = Math.abs(dx); const az = Math.abs(dz);
        // Octagonal mask: cut corners where dx+dz > drumR*1.4
        if (ax + az > Math.round(drumR * 1.4)) continue;
        const px = cxv + dx; const pz = czv + dz;
        if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
        world.set(px, py, pz, M_STONE); wallCount++;
      }
    }
  }
  // Drum cap ring (one solid ring on top of drum).
  for (let dz = -(drumR - 1); dz <= drumR - 1; dz++) {
    for (let dx = -(drumR - 1); dx <= drumR - 1; dx++) {
      const ax = Math.abs(dx); const az = Math.abs(dz);
      if (ax + az > Math.round(drumR * 1.35)) continue;
      const px = cxv + dx; const pz = czv + dz;
      if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
      const capY = drumBaseY + drumH; if (capY >= WORLD_Y) continue;
      world.set(px, capY, pz, M_STONE); wallCount++;
    }
  }

  // Corner sensor pods — 3×3 metal cubes at each corner of the roof.
  const podCorners: [number, number][] = [
    [wxStart + 1, wzStart + 1],
    [wxEnd - 4, wzStart + 1],
    [wxStart + 1, wzEnd - 4],
    [wxEnd - 4, wzEnd - 4],
  ];
  const podH = 4;
  for (const [px0, pz0] of podCorners) {
    for (let dy = 0; dy <= podH; dy++) {
      const py = yRoof + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 3; xo++) {
        for (let zo = 0; zo < 3; zo++) {
          const px = px0 + xo; const pz = pz0 + zo;
          if (px >= WORLD_X || pz >= WORLD_Z) continue;
          if (dy === podH || xo === 0 || xo === 2 || zo === 0 || zo === 2) {
            world.set(px, py, pz, M_METAL); wallCount++;
          }
        }
      }
    }
  }

  // Antenna mast — 2-voxel-wide metal base then single-voxel wood column.
  const mastBaseY = drumBaseY + drumH + 1;
  for (let dy = 0; dy < 4; dy++) {
    const py = mastBaseY + dy; if (py >= WORLD_Y) break;
    for (let xo = 0; xo < 2; xo++) {
      for (let zo = 0; zo < 2; zo++) {
        world.set(cxv + xo - 1, py, czv + zo - 1, M_METAL); wallCount++;
      }
    }
  }
  const mastTopBase = mastBaseY + 4;
  for (let dy = 0; dy < 8; dy++) {
    const py = mastTopBase + dy; if (py >= WORLD_Y) break;
    world.set(cxv, py, czv, M_WOOD); wallCount++;
  }

  return wallCount;
}

/**
 * Defensive turret emplacement: a sunken octagonal fighting position with a raised
 * stone parapet, corner armour plates, and a heavy pintle pedestal at the centre.
 * The renderer mounts the rotating cannon head on top of the pedestal.
 * Footprint: 2W × 2D nav cells = 16 × 16 voxels, headroom 12.
 */
export function stampTurret(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = TURRET;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +16
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +16
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;

  let wallCount = 0;

  // Concentric stone foundation — 2-voxel-tall slab covering the full footprint.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const py = yFloor - dy; if (py < 0) continue;
        world.set(x, py, z, M_STONE); wallCount++;
      }
    }
  }

  // Octagonal parapet walls — approximate octagon by masking corners of the 16×16
  // bounding square. Walls are 3 voxels thick and rise from yFloor+1 to yRoof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      const dx = Math.min(x - wxStart, wxEnd - 1 - x);
      const dz = Math.min(z - wzStart, wzEnd - 1 - z);
      const minDim = Math.min(dx, dz);
      // Cut octagonal corners: where both dx and dz are both < 2, skip (corner cut).
      if (dx < 2 && dz < 2) continue;
      const onWall = minDim < 3; // 3-voxel-thick wall ring
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (onWall) {
          world.set(x, y, z, M_STONE); wallCount++;
        } else {
          world.set(x, y, z, AIR);
        }
      }
    }
  }

  // Parapet crenellations — alternate merlons every 2 voxels along the outer ring.
  const parapetY = yRoof + 1;
  if (parapetY < WORLD_Y) {
    for (let x = wxStart; x < wxEnd; x++) {
      for (let z = wzStart; z < wzEnd; z++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const dx = Math.min(x - wxStart, wxEnd - 1 - x);
        const dz = Math.min(z - wzStart, wzEnd - 1 - z);
        if (dx < 2 && dz < 2) continue; // skip octagonal corners
        const onOuterRing = dx === 0 || dz === 0;
        if (!onOuterRing) continue;
        // Merlon every 2 voxels along the ring.
        const pos = (x - wxStart) + (z - wzStart);
        if (pos % 2 === 0) {
          world.set(x, parapetY, z, M_STONE); wallCount++;
        }
      }
    }
  }

  // Sandbag row (dirt-road) at the base of the inner wall face — adds visual texture.
  const sandbagY = yFloor + 1;
  if (sandbagY <= yRoof) {
    for (let x = wxStart + 2; x < wxEnd - 2; x++) {
      for (let z = wzStart + 2; z < wzEnd - 2; z++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const dx = Math.min(x - wxStart, wxEnd - 1 - x);
        const dz = Math.min(z - wzStart, wzEnd - 1 - z);
        if (dx === 2 || dz === 2) {
          world.set(x, sandbagY, z, M_DIRT_ROAD);
        }
      }
    }
  }

  // Pedestal — a stout 4×4 metal column rising from the floor to above the parapet.
  const pedBaseY = yFloor + 1;
  const pedTopY = yRoof + 5;
  for (let y = pedBaseY; y <= pedTopY; y++) {
    if (y >= WORLD_Y) break;
    for (let xo = -2; xo <= 1; xo++) {
      for (let zo = -2; zo <= 1; zo++) {
        const px = cxv + xo; const pz = czv + zo;
        if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
        world.set(px, y, pz, M_METAL); wallCount++;
      }
    }
  }

  return wallCount;
}

/**
 * Heavy silo launcher: a thick-walled bunker fortress with angled corner bastions,
 * a reinforced blast door, and five missile tubes arranged in an X pattern on the
 * hardened roof. The whole structure reads as a heavy military fortification.
 * Footprint: 3W × 3D nav cells = 24 × 24 voxels, headroom 32.
 */
export function stampSilo(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = SILO;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +24
  const wzEnd = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +24
  const yFloor = floorY + 1;
  const yRoof = floorY + spec.headroomVoxels;
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;
  const doorYTop = yFloor + 8;
  const cxv = (wxStart + wxEnd) >> 1;
  const czv = (wzStart + wzEnd) >> 1;

  let wallCount = 0;

  // 4-voxel-thick stone perimeter walls (heavy fortification) + solid roof.
  const wallThick = 4;
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      // Floor slab.
      if (yFloor < WORLD_Y) { world.set(x, yFloor, z, M_STONE); wallCount++; }
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        const dx = Math.min(x - wxStart, wxEnd - 1 - x);
        const dz = Math.min(z - wzStart, wzEnd - 1 - z);
        const inWall = dx < wallThick || dz < wallThick;
        if (y === yRoof) {
          world.set(x, y, z, M_STONE); wallCount++;
        } else if (inWall) {
          const isDoor = x >= wxEnd - wallThick && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
          if (isDoor) { world.set(x, y, z, AIR); continue; }
          world.set(x, y, z, M_STONE); wallCount++;
        } else {
          world.set(x, y, z, AIR);
        }
      }
    }
  }

  // Diagonal corner bastions — 4×4 stone wedge blocks at each corner, angled to
  // deflect blasts. They protrude 3 voxels beyond the building footprint.
  const bastionOffsets: [number, number, number, number][] = [
    // [startX, startZ, dirX, dirZ]
    [wxStart, wzStart, -1, -1],
    [wxEnd - 4, wzStart, +1, -1],
    [wxStart, wzEnd - 4, -1, +1],
    [wxEnd - 4, wzEnd - 4, +1, +1],
  ];
  for (const [bx, bz, dx, dz] of bastionOffsets) {
    for (let step = 0; step < 3; step++) {
      const shrink = step;
      const x0 = bx + (dx < 0 ? dx * (step + 1) : shrink);
      const x1 = bx + 4 + (dx > 0 ? dx * (step + 1) : -shrink);
      const z0 = bz + (dz < 0 ? dz * (step + 1) : shrink);
      const z1 = bz + 4 + (dz > 0 ? dz * (step + 1) : -shrink);
      const maxY = yRoof - step * 4;
      for (let y = yFloor; y <= maxY; y++) {
        if (y >= WORLD_Y) break;
        for (let xv = x0; xv < x1; xv++) {
          for (let zv = z0; zv < z1; zv++) {
            if (xv < 0 || xv >= WORLD_X || zv < 0 || zv >= WORLD_Z) continue;
            world.set(xv, y, zv, M_STONE); wallCount++;
          }
        }
      }
    }
  }

  // Blast-door lintel — a 2-voxel-thick metal arch above the door opening.
  for (let dy = doorYTop; dy <= doorYTop + 3; dy++) {
    const py = yFloor + dy; if (py >= WORLD_Y || py > yRoof) break;
    for (let z = doorWz0; z <= doorWz1; z++) {
      if (z < 0 || z >= WORLD_Z) continue;
      world.set(wxEnd - 1, py, z, M_METAL); wallCount++;
      world.set(wxEnd - 2, py, z, M_METAL); wallCount++;
    }
  }

  // Parapet walkway — 3-voxel-tall solid ring inset 2 voxels from the outer face.
  for (let dy = 1; dy <= 3; dy++) {
    const py = yRoof + dy; if (py >= WORLD_Y) break;
    for (let z = wzStart + 2; z < wzEnd - 2; z++) {
      for (let x = wxStart + 2; x < wxEnd - 2; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const dx = Math.min(x - (wxStart + 2), (wxEnd - 3) - x);
        const dz = Math.min(z - (wzStart + 2), (wzEnd - 3) - z);
        if (dx === 0 || dz === 0) {
          world.set(x, py, z, M_STONE); wallCount++;
        }
      }
    }
  }

  // Missile tubes — 5 in an X pattern on the roof (4 corners + centre).
  // Each tube is a 2×2 metal column, 10 voxels tall with a metal nosecone cap.
  const tubeBaseY = yRoof + 4;
  const tubeH = 10;
  const tubePositions: [number, number][] = [
    [cxv - 1, czv - 1],       // centre
    [cxv - 6, czv - 6],       // NW quad
    [cxv + 4, czv - 6],       // NE quad
    [cxv - 6, czv + 4],       // SW quad
    [cxv + 4, czv + 4],       // SE quad
  ];
  for (const [tx, tz] of tubePositions) {
    for (let dy = 0; dy < tubeH; dy++) {
      const py = tubeBaseY + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        for (let zo = 0; zo < 2; zo++) {
          const px = tx + xo; const pz = tz + zo;
          if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
          world.set(px, py, pz, M_METAL); wallCount++;
        }
      }
    }
    // Reinforcing collar band at mid-height.
    const bandY = tubeBaseY + (tubeH >> 1); if (bandY < WORLD_Y) {
      world.set(tx - 1, bandY, tz, M_STONE);
      world.set(tx + 2, bandY, tz, M_STONE);
      world.set(tx, bandY, tz - 1, M_STONE);
      world.set(tx, bandY, tz + 2, M_STONE);
      wallCount += 4;
    }
  }

  return wallCount;
}

export function stampHQ(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  // 6×5 nav cells = 48 wide (X) × 40 deep (Z)
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + HQ.cellsW * NAV_CELL_VOXELS; // +48
  const wzEnd   = wzStart + HQ.cellsD * NAV_CELL_VOXELS; // +40
  const yFloor  = floorY + 1;
  // Main lower building rises 12 voxels (matches headroomVoxels).
  const yRoof   = yFloor + HQ.headroomVoxels; // main roof slab
  const cxv     = (wxStart + wxEnd) >> 1;     // X centre
  const czv     = (wzStart + wzEnd) >> 1;     // Z centre

  let wallCount = 0;

  const set = (x: number, y: number, z: number, m: number): void => {
    if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z || y < 0 || y >= WORLD_Y) return;
    world.set(x, y, z, m); wallCount++;
  };

  // ---- Floor slab ----
  for (let z = wzStart; z < wzEnd; z++)
    for (let x = wxStart; x < wxEnd; x++)
      set(x, yFloor, z, M_STONE);

  // ---- Main lower shell (3-voxel-thick stone walls, open interior) ----
  // East (+X) entrance: 12-voxel-wide opening centred on Z, 10 voxels tall.
  const doorZ0 = czv - 6; const doorZ1 = czv + 6;
  const doorTop = yFloor + 10;

  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const dx = Math.min(x - wxStart, wxEnd - 1 - x);
      const dz = Math.min(z - wzStart, wzEnd - 1 - z);
      const inWall = dx < 3 || dz < 3;
      if (!inWall) continue;

      for (let y = yFloor + 1; y <= yRoof; y++) {
        // East wall door gap.
        const isEastFace = x >= wxEnd - 3;
        if (isEastFace && z >= doorZ0 && z <= doorZ1 && y < doorTop) continue;

        // North / south wall window slots (3 per side: left/center/right sections).
        const isNS = z < wzStart + 3 || z >= wzEnd - 3;
        if (isNS) {
          const inWindow = (x >= wxStart + 6 && x <= wxStart + 10 ||
                            x >= cxv - 2    && x <= cxv + 2      ||
                            x >= wxEnd - 11 && x <= wxEnd - 7)
                        && y >= yFloor + 3 && y <= yFloor + 7;
          if (inWindow) continue;
        }

        if (y === yRoof) set(x, y, z, M_STONE);
        else             set(x, y, z, M_STONE);
      }
    }
  }

  // ---- Blast-door lintel (metal cap above entrance) ----
  for (let z = doorZ0; z <= doorZ1; z++) {
    for (let dy = 0; dy < 3; dy++) {
      const py = doorTop + dy; if (py > yRoof) break;
      set(wxEnd - 1, py, z, M_METAL);
      set(wxEnd - 2, py, z, M_METAL);
    }
  }

  // ---- Crenellated parapet on main roof ----
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const dx = Math.min(x - wxStart, wxEnd - 1 - x);
      const dz = Math.min(z - wzStart, wzEnd - 1 - z);
      if (dx >= 2 && dz >= 2) continue; // not on edge
      // Alternating merlons (3 high) and crenels (1 high): period of 5.
      const pos = (x + z) % 5;
      const merlon = pos < 3;
      const topDy = merlon ? 3 : 1;
      for (let dy = 1; dy <= topDy; dy++) set(x, yRoof + dy, z, M_STONE);
    }
  }

  // ---- Four corner watchtowers (8×8 each, 8 voxels above main roof) ----
  const wtW = 8;
  const wtH = 8;
  const wtCorners: [number, number][] = [
    [wxStart, wzStart],
    [wxEnd - wtW, wzStart],
    [wxStart, wzEnd - wtW],
    [wxEnd - wtW, wzEnd - wtW],
  ];
  const wtBase = yRoof + 1; const wtTop = wtBase + wtH;

  for (const [tx, tz] of wtCorners) {
    for (let z = tz; z < tz + wtW; z++) {
      for (let x = tx; x < tx + wtW; x++) {
        const dx = Math.min(x - tx, tx + wtW - 1 - x);
        const dz = Math.min(z - tz, tz + wtW - 1 - z);
        const inWall = dx < 2 || dz < 2;
        if (!inWall) continue;
        for (let y = wtBase; y <= wtTop; y++) set(x, y, z, M_STONE);
      }
    }
    // Battlement cap on watchtower roof.
    const wxC = tx + wtW; const wzC = tz + wtW;
    for (let z = tz; z < wzC; z++) {
      for (let x = tx; x < wxC; x++) {
        const dx = Math.min(x - tx, wxC - 1 - x);
        const dz = Math.min(z - tz, wzC - 1 - z);
        if (dx >= 2 && dz >= 2) continue;
        // Solid stone top on watchtowers (no crenels — they're circular).
        set(x, wtTop + 1, z, M_STONE);
      }
    }
  }

  // ---- Diagonal blast-wall fins at each corner (staircase pattern) ----
  // 4 steps outward diagonally, each step 1 shorter in height.
  const fins: [number, number, number, number][] = [
    [wxStart + 2, wzStart + 2, -1, -1],
    [wxEnd - 3, wzStart + 2, +1, -1],
    [wxStart + 2, wzEnd - 3, -1, +1],
    [wxEnd - 3, wzEnd - 3, +1, +1],
  ];
  for (const [bx, bz, dx, dz] of fins) {
    for (let step = 0; step < 4; step++) {
      const px = bx + dx * (step + 1);
      const pz = bz + dz * (step + 1);
      const topY = yRoof - step * 3;
      for (let y = yFloor; y <= topY; y++) set(px, y, pz, M_STONE);
    }
  }

  // ---- Central raised command block (on main roof, 26×18, 6 tall) ----
  const cmdX0 = cxv - 13; const cmdX1 = cxv + 13;
  const cmdZ0 = czv - 9;  const cmdZ1 = czv + 9;
  const cmdBase = yRoof + 1; const cmdTop = cmdBase + 6;

  for (let z = cmdZ0; z < cmdZ1; z++) {
    for (let x = cmdX0; x < cmdX1; x++) {
      const dx = Math.min(x - cmdX0, cmdX1 - 1 - x);
      const dz = Math.min(z - cmdZ0, cmdZ1 - 1 - z);
      const inWall = dx < 2 || dz < 2;

      for (let y = cmdBase; y <= cmdTop; y++) {
        if (y === cmdTop) { set(x, y, z, M_STONE); continue; }
        if (!inWall) continue;

        // Window slots on north/south faces of command block.
        const isNS = z < cmdZ0 + 2 || z >= cmdZ1 - 2;
        if (isNS) {
          const inWin = x >= cxv - 4 && x <= cxv + 4 && y >= cmdBase + 2 && y <= cmdBase + 4;
          if (inWin) continue;
        }
        set(x, y, z, M_STONE);
      }
    }
  }

  // ---- Antenna towers: 2×2 metal pillars from watchtower roof up ----
  const antH = 18;
  for (const [tx, tz] of wtCorners) {
    const ax = tx + 3; const az = tz + 3; // 2×2 centred in 8×8 tower
    for (let dy = 1; dy <= antH; dy++) {
      const py = wtTop + 1 + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++)
        for (let zo = 0; zo < 2; zo++)
          set(ax + xo, py, az + zo, M_METAL);
    }
  }

  // ---- Central dish mount pad: 4×4 metal on top of command block ----
  for (let z = czv - 2; z < czv + 2; z++)
    for (let x = cxv - 2; x < cxv + 2; x++)
      set(x, cmdTop + 1, z, M_METAL);

  // ---- Side dish pads: 4×4 metal on north/south ends of command block ----
  for (const sdz of [cmdZ0 + 1, cmdZ1 - 5]) {
    for (let z = sdz; z < sdz + 4; z++)
      for (let x = cxv - 2; x < cxv + 2; x++)
        set(x, cmdTop + 1, z, M_METAL);
  }

  // ---- Guard booths flanking the entrance (east face, outside footprint) ----
  for (const gz of [doorZ0 - 4, doorZ1 + 1]) {
    for (let dy = 1; dy <= 8; dy++) {
      const py = yFloor + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 4; xo++) set(wxEnd + xo, py, gz, M_STONE);
      for (let zo = 0; zo < 4; zo++) set(wxEnd, py, gz + zo, M_STONE);
      for (let zo = 0; zo < 4; zo++) set(wxEnd + 3, py, gz + zo, M_STONE);
    }
    // Guard booth roof.
    for (let xo = 0; xo < 4; xo++)
      for (let zo = 0; zo < 4; zo++) set(wxEnd + xo, yFloor + 8, gz + zo, M_STONE);
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

/**
 * World-space spawn position for a unit produced by building `b`. Distributes
 * successive spawns across the pad cells (in +X beyond the building wall) so
 * units don't all appear at the same point. The slot is advanced by the caller
 * after each use.
 */
export function padSpawnPos(b: Building): DoorWorldPos {
  const pad = b.spec.spawnPadCells;
  if (pad <= 0) return doorWorldPos(b);

  const slots = pad * b.spec.cellsD;
  const slot = b.spawnSlot % slots;
  const dx = slot % pad;            // 0..pad-1
  const dz = Math.floor(slot / pad); // 0..cellsD-1

  // Place the unit at the centre of the chosen pad cell.
  const cellX = b.ox + b.spec.cellsW + dx;
  const cellZ = b.oz + dz;
  return {
    x: (cellX * NAV_CELL_VOXELS + NAV_CELL_VOXELS / 2) * VOXEL_SIZE,
    y: (b.floorY + 1) * VOXEL_SIZE,
    z: (cellZ * NAV_CELL_VOXELS + NAV_CELL_VOXELS / 2) * VOXEL_SIZE,
  };
}

export class BuildingManager {
  buildings: Building[] = [];
  private nextId = 1;
  /** Called when a building wants to spawn a unit. Returns true if accepted. */
  spawner: ((kind: UnitKind, x: number, y: number, z: number) => Unit | null) | null = null;
  /** Called immediately after a unit spawns, with the new unit and the producing building. */
  afterSpawn: ((unit: Unit, building: Building) => void) | null = null;
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
  /**
   * Per-tick AA network assignment: maps projectile.id → the building.id of
   * the nearest live AA turret in range. Populated by `buildAAAssignments`
   * at the start of each tick before the per-building loop runs. Each AA
   * turret then only intercepts projectiles assigned to it, so a single
   * incoming round is engaged by exactly one turret — the closest one.
   */
  private readonly aaAssignments = new Map<number, number>();

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
      rallyPoint: null,
      rallyStance: 'aggressive',
      spawnSlot: 0,
      stockpile: { metals: 0, wood: 0 },
      truckCallThreshold: 50,
      supplyInbound: false,
      supplyDelivered: false,
      activeTrucks: 0,
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

  /**
   * Build the per-tick AA network assignment table.
   *
   * For every enemy projectile that is inside the range of at least one live
   * (non-reloading) AA turret, find the turret closest to that projectile and
   * mark it as the sole interceptor.  This is called once per tick before the
   * per-building loop so each `tickAntiAir` call can cheaply check whether it
   * owns a given threat instead of firing redundantly at the same round.
   */
  private buildAAAssignments(units: UnitManager): void {
    this.aaAssignments.clear();
    const pm = this.projectiles;
    if (!pm) return;

    // Collect live, non-reloading AA turrets and cache their world positions.
    type AAEntry = { b: Building; cxw: number; czw: number; muzzleY: number; range2: number };
    const aaTurrets: AAEntry[] = [];
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (b.spec.weapon !== 'aa_turret') continue;
      if (b.weaponReloadTimer > 0) continue;
      const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const floorTopMeters = (b.floorY + 1) * VOXEL_SIZE;
      const muzzleY = floorTopMeters + (b.spec.weaponMuzzleHeight ?? 1.0);
      const range = WEAPONS[b.spec.weapon].rangeMeters;
      aaTurrets.push({ b, cxw, czw, muzzleY, range2: range * range });
    }
    if (aaTurrets.length === 0) return;

    // For each incoming enemy projectile, assign it to the nearest AA in range.
    for (const p of pm.projectiles) {
      if (p.dead) continue;
      if (p.kind === 'aa_missile') continue;
      // Friendly-fire check (mirrors tickAntiAir).
      if (p.ownerId >= 0) {
        const owner = lookupUnit(units, p.ownerId);
        if (owner && owner.team !== 'enemy') continue;
      } else if (p.ownerId !== -1) {
        continue; // negative non-(-1) = friendly building
      }

      let nearestAA: Building | null = null;
      let nearestD2 = Infinity;
      for (const { b, cxw, czw, muzzleY, range2 } of aaTurrets) {
        const dx = p.x - cxw, dy = p.y - muzzleY, dz = p.z - czw;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > range2) continue;
        if (d2 < nearestD2) { nearestD2 = d2; nearestAA = b; }
      }
      if (nearestAA) this.aaAssignments.set(p.id, nearestAA.id);
    }
  }

  tick(dt: number, world: VoxelWorld, units: UnitManager): void {
    this.buildAAAssignments(units);
    // Supply trucks only gate production when a live HQ is present. Without
    // one the logistics system is offline and buildings produce freely, so the
    // base doesn't freeze if the HQ is destroyed or missing in tests.
    const hasLiveHQ = this.buildings.some(b => !b.destroyed && b.spec.kind === 'hq');
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

      // Timer has fired. When an HQ is present, wait for a supply truck
      // delivery before spawning. Without an HQ the logistics system is offline
      // and production runs free.
      if (hasLiveHQ && !b.supplyDelivered) continue;

      b.productionTimer += b.spec.productionInterval;
      if (hasLiveHQ) b.supplyDelivered = false;

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
        const pos = padSpawnPos(b);
        b.spawnSlot++;
        const kind = b.trainQueue.shift()!;
        const spawned = this.spawner(kind, pos.x, pos.y, pos.z);
        if (spawned) this.afterSpawn?.(spawned, b);
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
      const projGrav = PROJECTILE_GRAVITY * (PROJECTILES[w.projectile].gravityScale ?? 1);
      const ballistic = solveBallisticDirection(cxw, muzzleY, czw, u.x, targetTY, u.z, launchSpeed, projGrav);
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
    const projGravFire = PROJECTILE_GRAVITY * (PROJECTILES[w.projectile].gravityScale ?? 1);
    const ballistic = solveBallisticDirection(cxw, muzzleY, czw, bestU.x, targetTorsoY, bestU.z, launchSpeed, projGravFire);
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

    // Pick the highest-priority assigned projectile. The AA network assignment
    // (built once per tick in `buildAAAssignments`) guarantees that each
    // incoming round is owned by exactly one turret — the nearest one in
    // range. Turrets only fire at their assigned rounds, so multiple AAs
    // never waste ammo on the same target.
    let bestP: Projectile | null = null;
    let bestD2 = range2;
    for (const p of pm.projectiles) {
      if (p.dead) continue;
      if (p.kind === 'aa_missile') continue;
      // Only engage rounds assigned to this turret by the network.
      if (this.aaAssignments.get(p.id) !== b.id) continue;
      const dx = p.x - cxw, dy = p.y - muzzleY, dz = p.z - czw;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > range2) continue;
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
    const targetGrav = PROJECTILE_GRAVITY * (PROJECTILES[bestP.kind].gravityScale ?? 1);
    let leadX = bestP.x + bestP.vx * tof;
    let leadY = bestP.y + bestP.vy * tof - 0.5 * targetGrav * tof * tof;
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
  nearestHQ(x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD2 = Infinity;
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'hq') continue;
      const dpos = doorWorldPos(b);
      const dx = dpos.x - x, dz = dpos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

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
