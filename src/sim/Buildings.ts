import { VoxelWorld } from '../voxel/VoxelWorld';
import { worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, MaterialId, VOXEL_SIZE } from '../voxel/types';
import { M_WOOD, M_FARM, M_STONE, M_PATH, M_DIRT_ROAD, M_METAL, M_FED_RED, M_FED_WHITE, M_FED_BLUE, M_BEDROCK } from '../voxel/Materials';
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
  | 'hq'
  | 'neighborhood';

/**
 * Faction the building belongs to. Mirrors the unit `Team` type — buildings
 * default to 'player'; the sandbox can place 'enemy' buildings for testing
 * the attack pipeline. Projectile damage is team-agnostic (any round that
 * lands inside / near the AABB hurts the building's HP).
 */
export type BuildingTeam = 'player' | 'enemy' | 'enemy2';

export interface BuildingSpec {
  kind: BuildingKind;
  /** Display name for HUD. */
  label: string;
  /** Footprint in nav cells (square or rectangular). */
  cellsW: number;
  cellsD: number;
  /** Required headroom in voxels above the floor. */
  headroomVoxels: number;
  /** Primary wall material — used for the structure-voxel snapshot. */
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
  stamp: (world: VoxelWorld, ox: number, oz: number, floorY: number, building?: Building) => number;
  /**
   * Extra nav-cell columns reserved in the +X direction for the spawn pad.
   * These cells are validated by `checkFootprint` (same floor height, not
   * blocked, adequate headroom) so a building can never be placed where its
   * pad would be obstructed. 0 for non-producer buildings.
   */
  spawnPadCells: number;
  /**
   * How many pad cells to skip before placing the first spawn slot. Wide
   * vehicle chassis have a `widthMeters/2` scan radius in `sampleSurfaceFollow`
   * that can reach into the building wall and snap the unit to the roof.
   * Setting this to 2 keeps even the widest units (tunneler 3.6 m) clear.
   */
  spawnPadSafeStart?: number;
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
  /**
   * Resource cost to bring a freshly-placed building online. Producer
   * buildings start in `pending` state and only flip to `enabled` once
   * trucks have delivered this many resources to the building's upgrade
   * stockpile. Defaults to a modest 30 metals + 30 wood when omitted; HQ
   * and storage have `enabledOnPlace = true` and never request an initial
   * upgrade.
   */
  upgradeCost?: { metals: number; wood: number };
  /**
   * When true the building is fully operational the moment it's placed —
   * skips the upgrade-pending state. Set on HQ + storage so the very first
   * base the player drops can already function.
   */
  enabledOnPlace?: boolean;
  /**
   * Wall-clock seconds the initial construction takes once the upgrade is
   * started. The visible voxel growth and the `enabled` flip both wait for
   * this timer to elapse, so the player gets a deliberate "factory rolling
   * up" feel rather than a building that pops complete the moment its
   * resources arrive. Default 30 s when omitted; see per-spec values for
   * the heavy-armour / weapons buildings.
   */
  constructionSeconds?: number;
}

export const BARRACKS: BuildingSpec = {
  kind: 'barracks',
  label: 'Barracks',
  cellsW: 4,
  cellsD: 4,
  headroomVoxels: 6, // 0.75 m — flat low-profile bunker silhouette
  wall: M_WOOD,
  maxHp: 600,
  // Was 6 s. Lowered to 1 s so 1-2 barracks can sustain the harness's
  // drought rule (-50/s every second without a new unit) on their
  // own. With one barracks per AI plus a per-AI worker queue, output
  // matches the floor without needing 3+ barracks per HQ.
  productionInterval: 1.0,
  // Personnel-only roster: every infantry kind (worker included) trains here
  // so the player has one obvious place for "people" production.
  produces: ['soldier', 'sniper', 'gunner', 'mortar_soldier', 'rocket_soldier', 'worker'],
  stamp: stampBarracks,
  spawnPadCells: 2,
  spawnPadSafeStart: 1, // skip cell 0 (overlaps barracks porch canopy)
  upgradeCost: { metals: 40, wood: 40 },
  // Tuned for the gradual voxel build: at this duration you can watch the
  // structure assemble row by row without waiting an uncomfortable beat
  // between issuing the order and being able to train units.
  constructionSeconds: 40,
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
  headroomVoxels: 6, // 0.75 m — low-profile depot silhouette
  wall: M_METAL,
  maxHp: 900,
  productionInterval: 9.0,
  // Every drivable chassis the player can field rolls out of here: tanks,
  // tunnelers, worms, dozers, rocket trucks, and the AA vehicle.
  produces: ['tank', 'dozer', 'tunneler', 'worm', 'rocket_truck', 'aa_vehicle'],
  stamp: stampVehicleDepot,
  spawnPadCells: 3,
  spawnPadSafeStart: 2, // skip cells 0-1 so wide chassis (tunneler 3.6 m) clear the east wall
  upgradeCost: { metals: 70, wood: 50 },
  constructionSeconds: 75,
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
  upgradeCost: { metals: 20, wood: 30 },
  constructionSeconds: 25,
};

/**
 * Neighborhood — a city block of 1-3 small houses around a single dirt
 * street. Each completed `expand_neighborhood` upgrade adds another house
 * to the lot and bumps the player's `popCap` by 5. Residents (civilians)
 * idle on the street and wander between neighborhood blocks.
 *
 * Footprint is a 6x6 nav-cell square. Houses are 2x2 cell blobs spread
 * across the lot; the street runs centre-line W→E so a civilian can walk
 * between the blocks without colliding with the buildings.
 */
export const NEIGHBORHOOD: BuildingSpec = {
  kind: 'neighborhood',
  label: 'Neighborhood',
  cellsW: 6,
  cellsD: 6,
  headroomVoxels: 12,
  wall: M_WOOD,
  maxHp: 350,
  productionInterval: 0,
  produces: [],
  stamp: stampNeighborhood,
  spawnPadCells: 0,
  upgradeCost: { metals: 30, wood: 60 },
  constructionSeconds: 35,
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
  enabledOnPlace: true, // resource hub: must work the moment it's dropped.
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
  upgradeCost: { metals: 50, wood: 30 },
  constructionSeconds: 35,
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
  upgradeCost: { metals: 80, wood: 40 },
  constructionSeconds: 60,
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
  upgradeCost: { metals: 60, wood: 60 },
  constructionSeconds: 50,
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
  upgradeCost: { metals: 50, wood: 30 },
  // Defensive turrets are commonly dropped under fire — quick to put up so
  // the player has tactical agency when a wave hits.
  constructionSeconds: 45,
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
  upgradeCost: { metals: 60, wood: 30 },
  constructionSeconds: 55,
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
  upgradeCost: { metals: 100, wood: 50 },
  // Heaviest building — long enough that committing to a silo is a real
  // decision but not so long the player loses the tempo of the engagement.
  constructionSeconds: 90,
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
  // maxHp is the DISPLAYED HP scale; actual death is governed by the
  // structural-voxel destruction threshold in BuildingManager.tick
  // (HQ collapses at 12 % voxel loss; see comment there). 3000 chosen
  // so the displayed bar steps in human-readable increments as the
  // structure takes hits, not because the bar drives death.
  maxHp: 3000,
  productionInterval: Infinity,
  produces: [],
  stamp: stampHQ,
  spawnPadCells: 0,
  buildRangeMeters: 60,
  maxTrucks: 5,
  enabledOnPlace: true,
  // Each HQ tier upgrade: +50 metals + 50 wood. Tier scaling lives on the
  // building instance (`tier` field), not the spec, so a single HQ can be
  // upgraded multiple times.
  upgradeCost: { metals: 50, wood: 50 },
};

/** All building specs in the order they appear on the build-mode hotkeys (1..N). */
export const ALL_BUILDINGS: BuildingSpec[] = [BARRACKS, VEHICLE_DEPOT, FARM, NEIGHBORHOOD, STORAGE, POWER_PLANT, REFINERY, TECH_LAB, TURRET, AA_TURRET, SILO];

// ---------------------------------------------------------------------------
// Upgrade options
// ---------------------------------------------------------------------------

/**
 * One discrete upgrade a player can buy at a building. Each option owns its
 * own cost (which scales by the current tier in that track), a portrait
 * spec for the action panel, and the effect that applies on completion.
 *
 * `applicable(b)` decides whether the option appears in the panel for this
 * particular building — for HQ this is gated on the building kind and lets
 * the player pick repeatedly; for non-HQ producers there is only the
 * one-shot `initial` option that flips the building from disabled to
 * enabled.
 */
export interface UpgradeOption {
  id: string;
  label: string;
  description: string;
  /** Base resource cost — multiplied by `(1 + tier * 0.75)` per existing tier. */
  baseCost: { metals: number; wood: number };
  /** Default keyboard shortcut for the action panel. */
  keyLabel: string;
  /** Portrait artwork — same SVG-glyph format as unit/building portraits. */
  portrait: { bg: string; fg: string; glyph: string };
  /**
   * Wall-clock seconds the upgrade takes once started. For `initial` this
   * is sourced from the spec instead so per-spec construction durations
   * apply to the build animation. HQ-track upgrades use the value here.
   */
  constructionSeconds?: number;
  applicable: (b: Building) => boolean;
  apply: (b: Building) => void;
}

/**
 * Catalog of upgrades. The action layer in `Actions.ts` filters this by
 * `applicable(b)` to decide which buttons to surface for the current
 * selection. `apply(b)` runs once the cost has been delivered; it should
 * mutate the building's persistent state (track counters, runtime caps)
 * without touching the upgrade flag plumbing — that stays in
 * `BuildingManager.tick`.
 */
export const UPGRADE_OPTIONS: UpgradeOption[] = [
  {
    id: 'initial',
    label: 'Construct',
    description: 'Bring this building online so it can start training units.',
    baseCost: { metals: 0, wood: 0 }, // overridden per-spec below
    keyLabel: 'B',
    portrait: { bg: '#5a4a2a', fg: '#e8c890',
      glyph: 'M6 26 V14 L16 6 L26 14 V26 Z M14 26 V18 H18 V26 Z' },
    // Only relevant for buildings that ship with `enabledOnPlace` falsy AND
    // a non-zero upgrade cost. HQ stays operational so this never fires for
    // it; it gets the per-track upgrades below.
    applicable: (b) => !b.spec.enabledOnPlace && b.spec.upgradeCost !== undefined && b.spec.kind !== 'hq',
    apply: (b) => {
      // Effect lives in the per-tick completion code — flipping
      // `upgradeState` to `enabled` and snapping HP to maxHp. The
      // function body is the place future per-spec hooks would land.
      void b;
    },
  },
  {
    id: 'range',
    label: 'Increase range',
    description: 'Extend the HQ build perimeter by 50 %.',
    baseCost: { metals: 50, wood: 50 },
    keyLabel: 'R',
    portrait: { bg: '#3a4a6a', fg: '#bcd8ff',
      // Crosshair-in-circle glyph so "range" reads at a glance.
      glyph: 'M16 4 V12 M16 20 V28 M4 16 H12 M20 16 H28 M16 8 a8 8 0 1 1 0 16 a8 8 0 1 1 0 -16 Z' },
    constructionSeconds: 60,
    applicable: (b) => b.spec.kind === 'hq',
    apply: (b) => { b.upgradeTracks.range = (b.upgradeTracks.range ?? 0) + 1; },
  },
  {
    id: 'trucks',
    label: 'Add 5 trucks',
    description: 'Raise the HQ supply-truck cap by 5.',
    baseCost: { metals: 60, wood: 30 },
    keyLabel: 'T',
    portrait: { bg: '#3a3a3a', fg: '#d8d8d8',
      glyph: 'M4 14 H18 V22 H4 Z M18 16 H26 V22 H18 Z M6 22 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M20 22 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0' },
    constructionSeconds: 60,
    applicable: (b) => b.spec.kind === 'hq',
    apply: (b) => { b.upgradeTracks.trucks = (b.upgradeTracks.trucks ?? 0) + 1; },
  },
  {
    // Neighborhood expansion — adds another house to the lot and raises
    // pop cap by 5. Capped at tier 3 (3 houses on the lot).
    id: 'expand',
    label: 'Expand neighborhood',
    description: 'Build another house and add +5 population cap.',
    baseCost: { metals: 25, wood: 50 },
    keyLabel: 'E',
    portrait: { bg: '#3a5a3a', fg: '#cfeac0',
      // Two side-by-side houses with a "+1" outline cue.
      glyph: 'M4 24 V14 L8 10 L12 14 V24 Z M14 24 V14 L18 10 L22 14 V24 Z M24 6 H28 M26 4 V8' },
    constructionSeconds: 40,
    applicable: (b) => b.spec.kind === 'neighborhood' && (b.upgradeTracks.expand ?? 0) < 2,
    apply: (b) => {
      b.upgradeTracks.expand = (b.upgradeTracks.expand ?? 0) + 1;
    },
  },
  {
    // Barracks bunkhouse upgrade — extra cots for soldiers and workers
    // billeted at this barracks. Each tier adds +10 pop cap on top of the
    // base 25 contributed by the barracks itself. Capped at +20 (two
    // upgrades), giving a single barracks a max housing of 45.
    id: 'barracks_expand',
    label: 'Add bunks',
    description: 'Expand the barracks to house +10 more soldiers / workers.',
    baseCost: { metals: 30, wood: 30 },
    keyLabel: 'H',
    portrait: { bg: '#5a4a2a', fg: '#e8c890',
      // Three stacked bunks + a "+" cue.
      glyph: 'M4 8 H22 V12 H4 Z M4 14 H22 V18 H4 Z M4 20 H22 V24 H4 Z M26 6 H30 M28 4 V8' },
    constructionSeconds: 35,
    applicable: (b) => b.spec.kind === 'barracks' && (b.upgradeTracks.barracks_expand ?? 0) < 2,
    apply: (b) => {
      b.upgradeTracks.barracks_expand = (b.upgradeTracks.barracks_expand ?? 0) + 1;
    },
  },
];

/** Lookup by id; returns null if the id is unknown. */
export function upgradeOptionById(id: string): UpgradeOption | null {
  return UPGRADE_OPTIONS.find(o => o.id === id) ?? null;
}

/** Return the upgrade options applicable to this building. */
export function upgradeOptionsFor(b: Building): UpgradeOption[] {
  return UPGRADE_OPTIONS.filter(o => o.applicable(b));
}

/** Resource cost to train each unit kind. Deducted when HQ dispatches a supply truck. */
export const UNIT_TRAIN_COST: Record<UnitKind, { food: number; metals: number; wood: number }> = {
  soldier:        { food: 40,  metals: 10,  wood: 10  },
  sniper:         { food: 50,  metals: 20,  wood: 15  },
  gunner:         { food: 60,  metals: 30,  wood: 0   },
  mortar_soldier: { food: 60,  metals: 35,  wood: 5   },
  rocket_soldier: { food: 60,  metals: 40,  wood: 0   },
  tank:           { food: 20,  metals: 80,  wood: 0   },
  tunneler:       { food: 20,  metals: 120, wood: 0   },
  worm:           { food: 20,  metals: 100, wood: 0   },
  worker:         { food: 30,  metals: 0,   wood: 10  },
  dozer:          { food: 20,  metals: 60,  wood: 0   },
  rocket_truck:   { food: 20,  metals: 80,  wood: 0   },
  aa_vehicle:     { food: 20,  metals: 90,  wood: 0   },
  supply_truck:   { food: 0,   metals: 0,   wood: 0   },
  // Civilians are auto-spawned by neighborhoods, not built from a UI.
  // The cost stays at 0 so the resupply / dispatch code paths skip them
  // cleanly when filtered.
  civilian:       { food: 0,   metals: 0,   wood: 0   },
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
  /**
   * Baseline structural voxel count, captured at completion of the
   * initial build. The runtime HP fraction is derived from it and the
   * current `countAliveStructureVoxels` reading: a building stands while
   * at most 30 % of its structural voxels have been chewed away. Zero
   * while the building hasn't finished its initial upgrade (HP stays at
   * 0 then).
   */
  healthRefVoxels: number;
  /**
   * World indices of every structural voxel snapshotted at construction
   * completion. Excludes ground/road/path infrastructure so the HP curve
   * only reacts when the actual buildings (walls, roofs, foundations,
   * scaffolding) are damaged — destroying the dirt road that runs
   * through a neighborhood lot does not chip away at its hp.
   *
   * Null while the building is still pending its initial upgrade; size
   * matches `healthRefVoxels` once populated.
   */
  structureVoxelIdx: Uint32Array | null;
  /**
   * World-space (meters) aim point for projectiles targeting this building.
   * Set to the centroid of the structural voxels at construction
   * completion so aim lands on actual buildings even when the lot center
   * is air or road (e.g. a neighborhood's central street). Falls back to
   * the geometric lot centre while the building hasn't been stamped yet.
   */
  aimWX: number;
  aimWY: number;
  aimWZ: number;
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
  /** Farm-only: kept on the building for backwards compatibility but unused
   *  under the single-cycle harvest scheme. Always 0. */
  harvestMilestone: number;
  /** Farm-only: true once cropProgress hits 1.0; cleared by collectFarm,
   *  which also resets cropProgress to 0 to start a new cycle. */
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
  stockpile: { metals: number; wood: number; food: number };
  /**
   * Minimum total stockpile (metals + wood + food) that must accumulate before
   * this storage building requests a pickup truck. Default 50.
   */
  truckCallThreshold: number;
  /**
   * Storage-only: true when a pickup truck is already on its way to fetch
   * from this building. Prevents double-dispatching.
   */
  supplyInbound: boolean;
  /**
   * Storage-only legacy flag kept for compat; production buildings now use
   * `suppliedUnits` / `inboundResupplyTrucks` instead.
   */
  supplyDelivered: boolean;
  /**
   * Production-only: number of queued units whose resources HAVE arrived and
   * are sitting in the building, waiting for the production timer to expire.
   * Each successful spawn decrements this. The production tick refuses to
   * count down `productionTimer` while this is 0 — units never start
   * building without resources on hand.
   */
  suppliedUnits: number;
  /**
   * Production-only: number of resupply trucks currently en route to this
   * building. Combined with `suppliedUnits` and `trainQueue.length` to
   * decide how many MORE trucks the dispatcher should send. Decremented on
   * delivery (success → suppliedUnits++) or combat-kill (resources refunded).
   */
  inboundResupplyTrucks: number;
  /**
   * HQ-only: number of supply trucks currently dispatched (en route or
   * returning). Capped at `spec.maxTrucks`.
   */
  activeTrucks: number;
  /**
   * Lifecycle stage. `enabled` = fully operational. `pending` = needs an
   * upgrade run; trucks are dispatching resources to the building's
   * `upgradeStockpile` and the building doesn't accept training orders.
   * `cancelled` = the player aborted the upgrade; in-flight trucks turn
   * around with their cargo and any resources already dropped sit in the
   * stockpile waiting for a recovery truck to ferry them back to HQ.
   * Buildings stay `cancelled` after recovery completes so the player can
   * re-arm a fresh upgrade whenever they like.
   */
  upgradeState: 'enabled' | 'pending' | 'cancelled';
  /** Resources delivered toward the next upgrade. Compared against the spec
   *  (or HQ tier-scaled) cost; on completion this is reset and the
   *  building flips to `enabled` (or HQ.tier increments). */
  upgradeStockpile: { metals: number; wood: number };
  /** Trucks currently en route delivering resources to `upgradeStockpile`. */
  inboundUpgradeTrucks: number;
  /**
   * Legacy combined tier counter — kept for save/log compatibility but
   * superseded by the per-track `upgradeTracks` map. Reads at the count of
   * the highest individual track so old call sites still get a sane "how
   * upgraded is this" number.
   */
  tier: number;
  /**
   * Per-track upgrade counters. Each call to "Increase X" finishes by
   * bumping `upgradeTracks[X]` so the matching effect formula (build range
   * scaling, max-trucks add, etc.) reads the right tier. Non-HQ buildings
   * use the single `initial` track to model the build-it-once flow.
   */
  upgradeTracks: Record<string, number>;
  /**
   * Which upgrade option the building is currently accepting deliveries
   * for. `null` when no upgrade is in progress; the truck dispatcher only
   * sends loads to buildings whose `upgradeState === 'pending'` AND have
   * a non-null `activeUpgradeId`.
   */
  activeUpgradeId: string | null;
  /**
   * Per-voxel build queue. Captured at place time by walking the building's
   * AABB right after the spec's stamp wrote its voxels: every non-AIR voxel
   * inside the AABB lands in `buildVoxels` (linear world index) +
   * `buildMaterials` (the material to restore). The whole footprint is
   * then carved to AIR so the building starts visually empty. Each tick
   * during pending, the upgrade tick advances `buildIndex` through this
   * queue at a rate proportional to combined progress, re-writing one
   * voxel of the original structure per step. Buildings placed with
   * `enabledOnPlace` skip the queue and start fully stamped.
   */
  buildVoxels: Uint32Array | null;
  buildMaterials: Uint8Array | null;
  /**
   * Pre-stamp material for each queued voxel — kept so a cancel can walk
   * the already-stamped portion of the queue and revert each voxel to
   * what was there before the upgrade started. Lined up index-for-index
   * with `buildVoxels` / `buildMaterials`.
   */
  buildBeforeMaterials: Uint8Array | null;
  /** Number of queue entries already stamped back into the world. */
  buildIndex: number;
  /**
   * World-voxel indices of the cancel-time "temp pile" — a visible cluster
   * of M_METAL + M_WOOD voxels stamped on the lot when an upgrade is
   * cancelled with resources still on site. Clears automatically once a
   * recovery truck drains `upgradeStockpile`. Null when no pile exists.
   */
  tempPileVoxels: Uint32Array | null;
  /**
   * Wall-clock seconds remaining on the current upgrade. Counts down each
   * tick while `upgradeState === 'pending'`; the visible voxel growth and
   * the eventual `enabled` flip read this so a vehicle depot takes ~2 min
   * to assemble even when its resource trucks arrive in the first tick.
   * Zero when no upgrade is active.
   */
  constructionTimer: number;
  /** Total seconds the active construction was budgeted for (denominator
   *  for the time-progress fraction). */
  constructionTotal: number;
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
  /**
   * Existing buildings to test against. When provided, the proposed footprint
   * (and its spawn pad) is rejected if it overlaps any live building's
   * footprint. Caller passes `this.buildings.buildings`. Optional so the
   * existing tests that don't construct a manager keep working.
   */
  existing?: readonly Building[],
  /**
   * Voxel-y override for underground placement. When provided, the surface
   * nav is bypassed and the function validates the footprint at this y
   * level: every cell's column must have a solid floor at exactly this y,
   * and `headroomVoxels` of carve-able material (anything that isn't
   * bedrock) above. Returned `floorY` is this override.
   *
   * Surface placement (the default) still uses nav.topY for each cell and
   * the original flatness / headroom-against-air checks.
   */
  floorOverride?: number,
): FootprintHit {
  const totalW = spec.cellsW + spec.spawnPadCells;
  if (ox < 0 || oz < 0 || ox + totalW > NAV_W || oz + spec.cellsD > NAV_H) {
    return { ok: false, reason: 'out of bounds', floorY: -1, ox, oz };
  }

  // Reject if any live building's footprint overlaps the proposed footprint
  // or spawn-pad columns.
  if (existing && existing.length > 0) {
    const ox1 = ox + totalW;
    const oz1 = oz + spec.cellsD;
    for (const b of existing) {
      if (b.destroyed) continue;
      const bx0 = b.ox;
      const bz0 = b.oz;
      const bx1 = b.ox + b.spec.cellsW + b.spec.spawnPadCells;
      const bz1 = b.oz + b.spec.cellsD;
      if (ox < bx1 && ox1 > bx0 && oz < bz1 && oz1 > bz0) {
        return { ok: false, reason: 'overlaps existing building', floorY: -1, ox, oz };
      }
    }
  }

  // Underground placement: the player picked a voxel y under the Y-cutoff
  // and wants a building stamped at that level. The stamp itself writes the
  // floor / walls / roof voxels regardless of what's there, so we only need
  // to gate on (a) the y is in world bounds and (b) the building's roof
  // wouldn't clip a bedrock layer (the indestructible layer at y=0..1).
  if (floorOverride !== undefined) {
    const baseY = floorOverride;
    if (baseY < 0 || baseY + spec.headroomVoxels >= WORLD_Y) {
      return { ok: false, reason: 'out of world y bounds', floorY: baseY, ox, oz };
    }
    // Look across the building's columns: if ANY cell has bedrock anywhere
    // in [baseY+1, baseY+headroom] (the volume the stamp will carve) reject;
    // bedrock can't be replaced by stamp materials.
    for (let dz = 0; dz < spec.cellsD; dz++) {
      for (let dx = 0; dx < totalW; dx++) {
        const wxMid = (ox + dx) * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        const wzMid = (oz + dz) * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        for (let h = 1; h <= spec.headroomVoxels; h++) {
          const yy = baseY + h;
          if (yy >= WORLD_Y) break;
          if (voxels[worldIndex(wxMid, yy, wzMid)] === M_BEDROCK) {
            return { ok: false, reason: 'bedrock in carve zone', floorY: baseY, ox, oz };
          }
        }
      }
    }
    return { ok: true, floorY: baseY, ox, oz };
  }

  // Surface placement: standard nav-driven flatness + headroom check.
  const i0 = navIndex(ox, oz);
  if (nav.blocked[i0]) return { ok: false, reason: 'no surface', floorY: -1, ox, oz };
  const baseY = nav.topY[i0]!;

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
/**
 * Snapshot the AABB, run the spec's stamp for the target tier, and capture
 * every voxel that CHANGED into a per-building build queue (sorted bottom-
 * up with a deterministic per-row shuffle). Each captured voxel is then
 * restored to its pre-stamp value so the building visually rolls back to
 * the previous structural state; the upgrade tick then advances the queue
 * to re-write the captured voxels one by one.
 *
 * Diff-based capture means a tier-up only animates the NEW voxels —
 * existing tier-1 walls don't get torn down and re-built when the player
 * orders an expansion.
 */
function captureAndCarveBuildQueue(world: VoxelWorld, b: Building): void {
  const wxStart = b.ox * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + b.spec.cellsW * NAV_CELL_VOXELS;
  const wzStart = b.oz * NAV_CELL_VOXELS;
  const wzEnd   = wzStart + b.spec.cellsD * NAV_CELL_VOXELS;
  const yMin = b.floorY + 1;
  const yMax = b.floorY + b.spec.headroomVoxels;
  const voxels = world.buffers.voxels;
  const cw = wxEnd - wxStart;
  const cd = wzEnd - wzStart;
  const ch = yMax - yMin + 1;
  // Snapshot the AABB before the stamp so we can diff after.
  const before = new Uint8Array(cw * cd * ch);
  for (let oy = 0; oy < ch; oy++) {
    const y = yMin + oy;
    if (y < 0 || y >= WORLD_Y) continue;
    for (let oz2 = 0; oz2 < cd; oz2++) {
      const z = wzStart + oz2;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let ox2 = 0; ox2 < cw; ox2++) {
        const x = wxStart + ox2;
        if (x < 0 || x >= WORLD_X) continue;
        before[(oy * cd + oz2) * cw + ox2] = voxels[worldIndex(x, y, z)]!;
      }
    }
  }
  // Run the spec stamp at the target tier (the stamp may consult `b` for
  // tier / track info).
  b.spec.stamp(world, b.ox, b.oz, b.floorY, b);
  // Two passes: count diff, then build typed arrays sized exactly.
  let count = 0;
  for (let oy = 0; oy < ch; oy++) {
    const y = yMin + oy;
    if (y < 0 || y >= WORLD_Y) continue;
    for (let oz2 = 0; oz2 < cd; oz2++) {
      const z = wzStart + oz2;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let ox2 = 0; ox2 < cw; ox2++) {
        const x = wxStart + ox2;
        if (x < 0 || x >= WORLD_X) continue;
        const beforeMat = before[(oy * cd + oz2) * cw + ox2]!;
        const afterMat  = voxels[worldIndex(x, y, z)]!;
        if (afterMat !== beforeMat) count++;
      }
    }
  }
  if (count === 0) {
    b.buildVoxels = new Uint32Array(0);
    b.buildMaterials = new Uint8Array(0);
    b.buildBeforeMaterials = new Uint8Array(0);
    b.buildIndex = 0;
    return;
  }
  const idxArr = new Uint32Array(count);
  const matArr = new Uint8Array(count);
  const beforeArr = new Uint8Array(count);
  let cursor = 0;
  // Deterministic per-voxel ordering — building id mixed in so multiple
  // simultaneous builds don't all sprinkle in the same pattern.
  const seed = (b.id * 0x9E3779B1) >>> 0;
  const hashOrder = (x: number, y: number, z: number): number => {
    let h = seed;
    h = ((h ^ x) * 0x85EBCA6B) >>> 0;
    h = ((h ^ (y * 0x100)) * 0xC2B2AE35) >>> 0;
    h = ((h ^ z) * 0x27D4EB2F) >>> 0;
    return h >>> 0;
  };
  // Walk Y rows ascending; within each row build a sub-list, sort by hash,
  // append. The result: queue is Y-asc with random row-internal order so
  // the build looks like blocks sprinkling in row by row.
  const rowEntries: { idx: number; mat: number; before: number; ord: number }[] = [];
  for (let oy = 0; oy < ch; oy++) {
    const y = yMin + oy;
    if (y < 0 || y >= WORLD_Y) continue;
    rowEntries.length = 0;
    for (let oz2 = 0; oz2 < cd; oz2++) {
      const z = wzStart + oz2;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let ox2 = 0; ox2 < cw; ox2++) {
        const x = wxStart + ox2;
        if (x < 0 || x >= WORLD_X) continue;
        const beforeMat = before[(oy * cd + oz2) * cw + ox2]!;
        const idx = worldIndex(x, y, z);
        const afterMat  = voxels[idx]!;
        if (afterMat === beforeMat) continue;
        rowEntries.push({ idx, mat: afterMat, before: beforeMat, ord: hashOrder(x, y, z) });
      }
    }
    rowEntries.sort((a, b2) => a.ord - b2.ord);
    for (const e of rowEntries) {
      idxArr[cursor] = e.idx;
      matArr[cursor] = e.mat;
      beforeArr[cursor] = e.before;
      cursor++;
    }
  }
  b.buildVoxels = idxArr;
  b.buildMaterials = matArr;
  b.buildBeforeMaterials = beforeArr;
  b.buildIndex = 0;
  // Restore each captured voxel to its pre-stamp value. The queue advance
  // then re-writes the post-stamp value one at a time — this is what the
  // player sees as "the new houses sprinkle in".
  for (let oy = 0; oy < ch; oy++) {
    const y = yMin + oy;
    if (y < 0 || y >= WORLD_Y) continue;
    for (let oz2 = 0; oz2 < cd; oz2++) {
      const z = wzStart + oz2;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let ox2 = 0; ox2 < cw; ox2++) {
        const x = wxStart + ox2;
        if (x < 0 || x >= WORLD_X) continue;
        const beforeMat = before[(oy * cd + oz2) * cw + ox2]!;
        const idx = worldIndex(x, y, z);
        if (voxels[idx]! !== beforeMat) {
          world.set(x, y, z, beforeMat);
        }
      }
    }
  }
}

/**
 * Stamp a visible "temp pile" of resource voxels at the building's lot
 * centre, holding whatever's currently in `upgradeStockpile`. Used after a
 * cancel so the player can SEE the resources sitting on site before a
 * recovery truck arrives. The pile is a small column — metals on the -X
 * side of centre, wood on the +X side — capped at PILE_MAX_VOXELS so a
 * massive cancelled silo upgrade doesn't sprawl across the map.
 *
 * No-op when there's nothing to stockpile or a pile is already standing.
 */
function spawnUpgradeStockpilePile(world: VoxelWorld, b: Building): void {
  if (b.tempPileVoxels) return;
  const totalRes = b.upgradeStockpile.metals + b.upgradeStockpile.wood;
  if (totalRes <= 0) return;
  // Voxels per resource: 1 voxel per 5 resources, capped per side so a
  // huge cancel doesn't blanket the lot. 12 voxels per side = a 2×2×3
  // pile for each material.
  const PILE_MAX_VOXELS = 12;
  const metalVox = Math.min(PILE_MAX_VOXELS, Math.ceil(b.upgradeStockpile.metals / 5));
  const woodVox  = Math.min(PILE_MAX_VOXELS, Math.ceil(b.upgradeStockpile.wood   / 5));
  const cx = (b.ox * NAV_CELL_VOXELS) + (b.spec.cellsW * NAV_CELL_VOXELS >> 1);
  const cz = (b.oz * NAV_CELL_VOXELS) + (b.spec.cellsD * NAV_CELL_VOXELS >> 1);
  const yFloor = b.floorY + 1;
  const indices: number[] = [];
  // Metal column on the -X side: a 2×2 base stacked into a small tower.
  for (let n = 0; n < metalVox; n++) {
    const layer = Math.floor(n / 4);
    const slot = n % 4;
    const dx = -3 + (slot & 1);
    const dz = -1 + ((slot >> 1) & 1);
    const x = cx + dx, y = yFloor + layer, z = cz + dz;
    if (x < 0 || x >= WORLD_X || y >= WORLD_Y || z < 0 || z >= WORLD_Z) continue;
    world.set(x, y, z, M_METAL);
    indices.push(worldIndex(x, y, z));
  }
  // Wood column on the +X side, mirrored layout.
  for (let n = 0; n < woodVox; n++) {
    const layer = Math.floor(n / 4);
    const slot = n % 4;
    const dx = 2 + (slot & 1);
    const dz = -1 + ((slot >> 1) & 1);
    const x = cx + dx, y = yFloor + layer, z = cz + dz;
    if (x < 0 || x >= WORLD_X || y >= WORLD_Y || z < 0 || z >= WORLD_Z) continue;
    world.set(x, y, z, M_WOOD);
    indices.push(worldIndex(x, y, z));
  }
  b.tempPileVoxels = new Uint32Array(indices);
}

/**
 * Carve every voxel of the temp pile back to AIR. Called once the
 * recovery truck has drained `upgradeStockpile` so the pile visibly
 * disappears with the cargo.
 */
function clearUpgradeStockpilePile(world: VoxelWorld, b: Building): void {
  if (!b.tempPileVoxels) return;
  const idxArr = b.tempPileVoxels;
  for (let i = 0; i < idxArr.length; i++) {
    const idx = idxArr[i]!;
    const x = idx % WORLD_X;
    const tmp = (idx - x) / WORLD_X;
    const z = tmp % WORLD_Z;
    const y = (tmp - z) / WORLD_Z;
    world.set(x, y, z, AIR);
  }
  b.tempPileVoxels = null;
}

/**
 * Roll the already-stamped portion of the queue back to its pre-upgrade
 * state. Called from the cancel action so the player gets a clean revert
 * instead of a half-built shell that lingers in the world. Voxels still
 * queued (`>= buildIndex`) are already at their pre-stamp value so we
 * leave them alone.
 */
export function rollbackBuildQueue(world: VoxelWorld, b: Building): void {
  if (!b.buildVoxels || !b.buildBeforeMaterials) return;
  const idxArr = b.buildVoxels;
  const beforeArr = b.buildBeforeMaterials;
  const stamped = b.buildIndex;
  for (let i = 0; i < stamped; i++) {
    const idx = idxArr[i]!;
    const beforeMat = beforeArr[i]!;
    const x = idx % WORLD_X;
    const tmp = (idx - x) / WORLD_X;
    const z = tmp % WORLD_Z;
    const y = (tmp - z) / WORLD_Z;
    world.set(x, y, z, beforeMat);
  }
}

/**
 * Stamp the next batch of queued build voxels back into the world. Called
 * each tick during pending state with `targetIndex` derived from combined
 * time × resource progress. Idempotent: when `targetIndex` ≤ current,
 * nothing happens.
 */
function advanceBuildQueue(world: VoxelWorld, b: Building, targetIndex: number): void {
  if (!b.buildVoxels || !b.buildMaterials) return;
  const total = b.buildVoxels.length;
  if (targetIndex > total) targetIndex = total;
  if (targetIndex <= b.buildIndex) return;
  const idxArr = b.buildVoxels;
  const matArr = b.buildMaterials;
  for (let i = b.buildIndex; i < targetIndex; i++) {
    const idx = idxArr[i]!;
    const mat = matArr[i]!;
    const x = idx % WORLD_X;
    const tmp = (idx - x) / WORLD_X;
    const z = tmp % WORLD_Z;
    const y = (tmp - z) / WORLD_Z;
    world.set(x, y, z, mat);
  }
  b.buildIndex = targetIndex;
}

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

/**
 * Barracks — long bunker with a wood A-frame pitched roof running along Z,
 * two rooftop ventilation chimneys, and a tall flag pole flying a banner at
 * the front corner. The pitched ridge is the shape that uniquely identifies
 * this building from the RTS camera (no other building has a sloped roof).
 * Drill yard outside the +X door uses M_PATH with M_DIRT_ROAD lane stripes.
 */
export function stampBarracks(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = BARRACKS;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS; // +32
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS; // +32
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;        // top of building (= floor + 6)

  // Door on +X face — 4 wide; only as tall as the building (5 voxels of wall +
  // 1 voxel cap means the doorway pierces the entire vertical extent).
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;

  let count = 0;

  // 1. Floor — packed earth.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_PATH); count++;
    }
  }

  // 2. Perimeter walls — stone base 3v, wood above. Pierce the door slot.
  for (let y = yFloor + 1; y < yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, (y - yFloor) <= 2 ? M_STONE : M_WOOD); count++;
      }
    }
  }

  // 3. Flat wood roof at yRoof (the cap). With headroom=6 the entire silhouette
  // is 6 voxels tall, so no chimneys / pitched roof / flag pole / battle towers
  // — just a low wood-clad bunker.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yRoof, z, M_WOOD); count++;
    }
  }

  // 4. Federation banner on the +X face — a 4-wide × 3-tall stripe band built
  // INTO the wall just left of the door. Within the 6-voxel building height
  // budget so the silhouette stays flat.
  if (yFloor + 3 < yRoof) {
    const bannerStripes = [M_FED_RED, M_FED_WHITE, M_FED_BLUE];
    for (let by = 0; by < 3; by++) {
      const stripe = bannerStripes[by]!;
      const py = yFloor + 1 + by;
      for (let zo = 0; zo < 4; zo++) {
        const pz = doorWz0 - 5 + zo;
        if (pz < wzStart + 1 || pz >= doorWz0) continue;
        const px = wxEnd - 1;
        if (px >= WORLD_X) continue;
        world.set(px, py, pz, stripe); count++;
      }
    }
  }

  // 5. Drill yard outside +X face — paved with M_PATH, with M_DIRT_ROAD lane
  // stripes every 4 voxels along Z. Spans the whole spawn-pad area.
  const padX0 = wxEnd;
  const padX1 = padX0 + spec.spawnPadCells * NAV_CELL_VOXELS;
  for (let px = padX0; px < padX1; px++) {
    if (px >= WORLD_X) break;
    for (let pz = wzStart; pz < wzEnd; pz++) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      const stripe = ((pz - wzStart) % 4) === 0;
      world.set(px, yFloor, pz, stripe ? M_DIRT_ROAD : M_PATH);
    }
  }

  return count;
}

/**
 * Vehicle depot — low-profile metal hangar with a flat roof, painted parking
 * bays on the floor inside, and a fuel pump (well below the building's roof
 * height) just outside the door. With headroom = 6 voxels the entire depot
 * silhouette fits in 6 voxels of vertical extent.
 */
export function stampVehicleDepot(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = VEHICLE_DEPOT;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS; // +40
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS; // +32
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;
  const czv     = (wzStart + wzEnd) >> 1;

  // Rolling door — full wall height (5 voxels tall), 10 wide on +X face.
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 5;
  const doorWz1 = doorWz0 + 9;

  let count = 0;

  // 1. Concrete floor.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_STONE); count++;
    }
  }

  // 2. Perimeter walls — metal with stone corner anchors. Pierce the door.
  for (let y = yFloor + 1; y < yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        const isCorner = (x <= wxStart + 1 || x >= wxEnd - 2) && (z <= wzStart + 1 || z >= wzEnd - 2);
        world.set(x, y, z, isCorner ? M_STONE : spec.wall); count++;
      }
    }
  }

  // 3. Flat metal roof at yRoof. No arch, no skylight, no exhaust stacks —
  // the 6-voxel silhouette budget rules them out.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yRoof, z, M_METAL); count++;
    }
  }

  // 4. Federation stripe band painted across the +X wall, beside the door.
  if (yFloor + 3 < yRoof) {
    const bannerStripes = [M_FED_RED, M_FED_WHITE, M_FED_BLUE];
    for (let by = 0; by < 3; by++) {
      const stripe = bannerStripes[by]!;
      const py = yFloor + 1 + by;
      const px = wxEnd - 1;
      if (px >= WORLD_X) continue;
      for (let zo = 0; zo < 4; zo++) {
        const pz = doorWz0 - 5 + zo;
        if (pz < wzStart + 1 || pz >= doorWz0) continue;
        world.set(px, py, pz, stripe); count++;
      }
    }
  }

  // 5. Vehicle bay markings on the floor — three M_DIRT_ROAD strips running
  // -X/+X across the building so each parking lane reads from above.
  for (const bayZ of [wzStart + 6, czv, wzEnd - 7]) {
    for (let x = wxStart + 4; x < wxEnd - 4; x++) {
      if (x >= WORLD_X || bayZ >= WORLD_Z) continue;
      world.set(x, yFloor, bayZ, M_DIRT_ROAD);
    }
  }

  // 9. Spawn pad apron.
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
 * Storage — open-plan supply yard. Stone perimeter (low, no roof) makes the
 * stockpile inside visible from the RTS camera: a 3×3 grid of crate stacks
 * filling the floor. Loading docks open on all four faces with a wooden
 * canopy on +X (the truck approach). Reads as "warehouse with stuff inside"
 * from any angle.
 */
export function stampStorage(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = STORAGE;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS; // +24
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS; // +24
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;
  // Walls only rise 6 voxels (low stockyard fence + corner posts).
  const wallTop = yFloor + 6;

  // Door slots — 2 wide on each face, centered.
  const doorZc0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorZc1 = doorZc0 + 1;
  const doorXc0 = ((wxStart + wxEnd) >> 1) - 1;
  const doorXc1 = doorXc0 + 1;
  const doorYTop = yFloor + 5;

  const isDoor = (x: number, z: number, y: number): boolean => {
    if (y >= doorYTop) return false;
    if (x === wxEnd - 1 && (z === doorZc0 || z === doorZc1)) return true;
    if (x === wxStart   && (z === doorZc0 || z === doorZc1)) return true;
    if (z === wzEnd - 1 && (x === doorXc0 || x === doorXc1)) return true;
    if (z === wzStart   && (x === doorXc0 || x === doorXc1)) return true;
    return false;
  };

  let count = 0;

  // Hard-stone floor.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_PATH); count++;
    }
  }

  // Low wooden perimeter wall (6 voxels tall, not a roof).
  for (let y = yFloor + 1; y <= wallTop; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        if (isDoor(x, z, y)) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, M_WOOD); count++;
      }
    }
  }

  // Wooden corner posts — 2×2 timber columns rising the full headroom. Wood
  // (not stone) so the building reads as a wooden warehouse from any angle.
  const cornerPositions: [number, number][] = [
    [wxStart, wzStart], [wxEnd - 2, wzStart],
    [wxStart, wzEnd - 2], [wxEnd - 2, wzEnd - 2],
  ];
  for (const [tcx, tcz] of cornerPositions) {
    for (let y = yFloor + 1; y <= yRoof; y++) {
      if (y >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) {
        for (let zo = 0; zo < 2; zo++) {
          const tx = tcx + xo, tz = tcz + zo;
          if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
          world.set(tx, y, tz, M_WOOD); count++;
        }
      }
    }
    // Stone cap — flat slab one voxel above the post (only the wider footprint
    // overhang reads as a "shed roof eave"; the corner column itself stays wood).
    if (yRoof + 1 < WORLD_Y) {
      for (let xo = -1; xo < 3; xo++) {
        for (let zo = -1; zo < 3; zo++) {
          const tx = tcx + xo, tz = tcz + zo;
          if (tx < wxStart || tx >= wxEnd) continue;
          if (tz < wzStart || tz >= wzEnd) continue;
          world.set(tx, yRoof + 1, tz, M_STONE); count++;
        }
      }
    }
  }

  // Visible crate piles — 3×3 grid spanning the interior, offset to leave
  // aisles in front of each face's door.
  const crateGridX = [wxStart + 5, wxStart + 11, wxStart + 17];
  const crateGridZ = [wzStart + 5, wzStart + 11, wzStart + 17];
  for (const cx of crateGridX) {
    for (const cz of crateGridZ) {
      // Skip the centre stack so the floor isn't fully covered (truck walks through).
      const isCenter = cx === wxStart + 11 && cz === wzStart + 11;
      const stackH = isCenter ? 2 : 4;
      for (let dy = 1; dy <= stackH; dy++) {
        const py = yFloor + dy; if (py >= WORLD_Y) break;
        for (let xo = 0; xo < 3; xo++) {
          for (let zo = 0; zo < 3; zo++) {
            const tx = cx + xo, tz = cz + zo;
            if (tx >= wxEnd - 1 || tz >= wzEnd - 1) continue;
            // Hollow shell to read as crates not a solid wall.
            const onSurface = xo === 0 || xo === 2 || zo === 0 || zo === 2 || dy === stackH;
            if (!onSurface) continue;
            world.set(tx, py, tz, M_WOOD); count++;
          }
        }
      }
    }
  }

  // Loading dock on +X face — concrete apron + canopy with two posts.
  for (let dx = 0; dx < 4; dx++) {
    const px = wxEnd + dx;
    if (px >= WORLD_X) break;
    for (let pz = doorZc0 - 1; pz <= doorZc1 + 1; pz++) {
      if (pz < 0 || pz >= WORLD_Z) continue;
      world.set(px, yFloor, pz, M_PATH);
    }
  }
  const canopyY = doorYTop;
  if (canopyY < WORLD_Y) {
    for (let dx = 0; dx < 5; dx++) {
      const px = wxEnd + dx;
      if (px >= WORLD_X) break;
      for (let pz = doorZc0 - 1; pz <= doorZc1 + 1; pz++) {
        if (pz < 0 || pz >= WORLD_Z) continue;
        // Federation-striped canopy: red on outer Z, white middle, blue inner.
        const stripe = (pz === doorZc0 - 1 || pz === doorZc1 + 1)
          ? M_FED_RED
          : (pz === doorZc0 || pz === doorZc1)
          ? M_FED_WHITE
          : M_FED_BLUE;
        world.set(px, canopyY, pz, stripe); count++;
      }
    }
    for (const pz of [doorZc0 - 1, doorZc1 + 1]) {
      const px = wxEnd + 4;
      if (px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
      for (let y = yFloor + 1; y < canopyY; y++) {
        if (y >= WORLD_Y) break;
        world.set(px, y, pz, M_WOOD); count++;
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
/**
 * Farm — open cropland that units can walk on. Every interior voxel is
 * planted M_FARM so the renderer's corn + wheat stalks cover the whole
 * square; the fence is a single-voxel-tall wood rail on the perimeter
 * (low enough to step over). A scarecrow at the centre adds a recognisable
 * silhouette from the RTS camera.
 *
 * Farms aren't masked as buildings (Game.applyBuildingFootprintMask skips
 * them), so workers and trucks can cross the field freely.
 */
export function stampFarm(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = FARM;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yField  = floorY + 1;
  const cxv     = (wxStart + wxEnd) >> 1;
  const czv     = (wzStart + wzEnd) >> 1;

  let count = 0;

  // Whole interior is cropland; perimeter is a packed-dirt bund (M_DIRT_ROAD)
  // with a single-voxel wood top rail acting as the fence. Stalks render on
  // top of every M_FARM voxel so the field reads as fully planted.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      if (onPerim) {
        world.set(x, yField, z, M_DIRT_ROAD); count++;
        if (yField + 1 < WORLD_Y) {
          // Posts + rails pattern for the fence — skip every other voxel.
          const skip = (((x - wxStart) + (z - wzStart)) & 1) === 1;
          if (!skip) { world.set(x, yField + 1, z, spec.wall); count++; }
        }
      } else {
        world.set(x, yField, z, M_FARM);
      }
    }
  }

  // Scarecrow at field centre — wood pole + cross-arm + M_FARM straw head.
  if (yField + 4 < WORLD_Y) {
    world.set(cxv, yField + 1, czv, M_WOOD); count++;
    world.set(cxv, yField + 2, czv, M_WOOD); count++;
    world.set(cxv, yField + 3, czv, M_WOOD); count++;
    world.set(cxv - 1, yField + 3, czv, M_WOOD); count++;
    world.set(cxv + 1, yField + 3, czv, M_WOOD); count++;
    world.set(cxv, yField + 4, czv, M_FARM);
  }

  // Gate gap on +X face: clear two voxels of the fence so units can enter
  // the field. (The fence top rail is the only thing in their way.)
  const gateZ = czv;
  if (yField + 1 < WORLD_Y) {
    world.set(wxEnd - 1, yField + 1, gateZ, AIR);
    world.set(wxEnd - 1, yField + 1, gateZ + 1, AIR);
  }

  return count;
}

/**
 * Resolve the neighborhood's target tier (1..3). On `initial` we always
 * stamp tier 1 (one house). During an in-progress `expand` the target is
 * the post-completion tier, so we look at the existing track count + 1.
 * After completion `apply()` has already incremented the track, so we
 * just read it directly.
 */
function neighborhoodTargetTier(b: Building | undefined): number {
  if (!b) return 1;
  const expandTrack = b.upgradeTracks?.expand ?? 0;
  if (b.activeUpgradeId === 'initial') return 1;
  if (b.activeUpgradeId === 'expand') return Math.min(3, expandTrack + 1 + 1);
  // No active upgrade — display the tier we've actually completed.
  return Math.min(3, 1 + expandTrack);
}

/**
 * Stamp a neighborhood (tier 1..3) into the world. The 6×6 lot is split
 * by a single dirt road running east-west across its centre, with 1, 2,
 * or 3 small wood-and-stone houses arranged in fixed quadrants depending
 * on tier. Each house is a 2×2 cell stub with a flat roof; the
 * arrangement is the same across tiers (just more houses revealed) so
 * subsequent expansions visually fill in around the original block.
 */
export function stampNeighborhood(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
  building?: Building,
): number {
  const spec = NEIGHBORHOOD;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const tier = neighborhoodTargetTier(building);
  const yFloor = floorY + 1;
  let count = 0;
  // Street lane: middle 2 rows of voxels, full width — laid as packed
  // dirt-road. Acts both as the visual road and as a clear walkway for
  // civilians wandering between houses.
  const streetZ0 = (wzStart + wzEnd) >> 1;
  const streetZ1 = streetZ0 + 1;
  for (let z = streetZ0; z <= streetZ1; z++) {
    if (z >= WORLD_Z) break;
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X) continue;
      world.set(x, yFloor, z, M_DIRT_ROAD);
      count++;
    }
  }
  // Decide which house slots to stamp. Layout is fixed: slot 0 NW, slot 1
  // NE, slot 2 SW. Slots stay vacant until their tier comes online so
  // expansions visibly fill in around the original house.
  const slotsByTier = [
    [], // tier 0 — never reached
    [{ qx: 0, qz: 0 }],                                              // tier 1 — NW only
    [{ qx: 0, qz: 0 }, { qx: 1, qz: 0 }],                             // tier 2 — NW + NE
    [{ qx: 0, qz: 0 }, { qx: 1, qz: 0 }, { qx: 0, qz: 1 }],           // tier 3 — NW + NE + SW
  ];
  const slots = slotsByTier[tier] ?? slotsByTier[1]!;
  // House dims: 12 voxels wide (1.5 nav cells) — narrower than the slot
  // width so adjacent houses (NW / NE) leave a visible 8-voxel alley
  // between them. Z-depth is similar so the north and south rows have
  // matching breathing room around the street.
  const houseW = 12;
  const houseD = 12;
  const sideMargin = 8;   // voxels from the lot edge to the first house
  const innerGap = 8;     // voxels of grass between the two houses on the same row
  for (const slot of slots) {
    const isNorth = slot.qz === 0;
    // Z range: 4-voxel buffer between the house and the street so the
    // dirt road reads as separate from the building wall.
    const zBuffer = 4;
    const houseWzStart = isNorth
      ? wzStart + sideMargin
      : streetZ1 + 1 + zBuffer;
    const houseWzEnd = houseWzStart + houseD;
    // X range: NW = side margin + houseW; NE = NW end + innerGap +
    // houseW. Symmetric around the lot centre when both slots are present.
    const houseWxStart = slot.qx === 0
      ? wxStart + sideMargin
      : wxStart + sideMargin + houseW + innerGap;
    const houseWxEnd = houseWxStart + houseW;
    count += stampNeighborhoodHouse(
      world, houseWxStart, Math.min(wxEnd, houseWxEnd),
      Math.max(wzStart, houseWzStart), Math.min(wzEnd, houseWzEnd),
      yFloor, spec,
    );
  }
  return count;
}

/** Single 2x2-cell house — flat-roofed wood box with a stone foundation strip. */
function stampNeighborhoodHouse(
  world: VoxelWorld,
  wxStart: number, wxEnd: number,
  wzStart: number, wzEnd: number,
  yFloor: number, spec: BuildingSpec,
): number {
  let count = 0;
  if (wxEnd <= wxStart || wzEnd <= wzStart) return count;
  // House is 1.0 m tall foundation + 0.875 m walls + 1 voxel roof = 9 voxels.
  // Keep tower-height under the spec headroom (12) so two-story expansions
  // can stack later without breaching the building's headroom envelope.
  const yRoof = Math.min(yFloor + 8, yFloor + spec.headroomVoxels);
  for (let z = wzStart; z < wzEnd; z++) {
    if (z >= WORLD_Z) continue;
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X) continue;
      const onPerimeter = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      // Floor + raised stone foundation around the perimeter.
      world.set(x, yFloor, z, onPerimeter ? M_STONE : M_WOOD); count++;
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (y === yRoof) {
          world.set(x, y, z, spec.wall); count++;
        } else if (onPerimeter) {
          world.set(x, y, z, spec.wall); count++;
        }
      }
    }
  }
  return count;
}

/**
 * Height of the windmill mast above the substation roof, in voxels. Exposed
 * so the renderer can mount the turbine head at the top without re-deriving
 * the geometry.
 */
export const POWER_PLANT_MAST_VOXELS = 30;

/**
 * Power plant — substation pad with a tall central wind-turbine mast and four
 * lattice power pylons rising at the corners outside the building footprint.
 * The four corner pylons + central mast give a top-down silhouette of a five-
 * point cross that no other building can match. The renderer mounts the
 * turbine head on the mast (POWER_PLANT_MAST_VOXELS above the roof) and
 * scatters solar panels at yRoof+1 around the mast.
 */
export function stampPowerPlant(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = POWER_PLANT;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS;
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;
  const cxv     = (wxStart + wxEnd) >> 1;
  const czv     = (wzStart + wzEnd) >> 1;

  const doorWz0 = ((wzStart + wzEnd) >> 1) - 1;
  const doorWz1 = doorWz0 + 1;
  const doorYTop = yFloor + 6;

  let count = 0;

  // 1. Stone floor + perimeter wall + roof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      world.set(x, yFloor, z, M_STONE); count++;
      world.set(x, yRoof,  z, spec.wall); count++;
    }
  }
  for (let y = yFloor + 1; y < yRoof; y++) {
    if (y >= WORLD_Y) break;
    for (let z = wzStart; z < wzEnd; z++) {
      for (let x = wxStart; x < wxEnd; x++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
        if (!onPerim) continue;
        const isDoor = x === wxEnd - 1 && (z === doorWz0 || z === doorWz1) && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, spec.wall); count++;
      }
    }
  }

  // 2. Central mast — wide stone foundation tapering to a slim metal lattice.
  // Total height above the roof is POWER_PLANT_MAST_VOXELS so the renderer's
  // turbine head lines up with the mast top.
  const mastH = POWER_PLANT_MAST_VOXELS;
  for (let dy = 1; dy <= mastH; dy++) {
    const py = yRoof + dy; if (py >= WORLD_Y) break;
    if (dy <= 4) {
      // 4×4 stone base.
      for (let xo = -2; xo <= 1; xo++) {
        for (let zo = -2; zo <= 1; zo++) {
          world.set(cxv + xo, py, czv + zo, M_STONE); count++;
        }
      }
    } else if (dy <= 10) {
      // 2×2 stone column.
      for (let xo = -1; xo <= 0; xo++) {
        for (let zo = -1; zo <= 0; zo++) {
          world.set(cxv + xo, py, czv + zo, M_STONE); count++;
        }
      }
    } else {
      // 2×2 metal column up to the turbine head.
      for (let xo = -1; xo <= 0; xo++) {
        for (let zo = -1; zo <= 0; zo++) {
          world.set(cxv + xo, py, czv + zo, M_METAL); count++;
        }
      }
    }
  }
  // Lattice cross-bracing at three bands so the mast reads as a frame.
  for (const dy of [8, 14, 20, 26]) {
    if (dy > mastH) break;
    const py = yRoof + dy; if (py >= WORLD_Y) break;
    world.set(cxv - 2, py, czv - 1, M_WOOD); count++;
    world.set(cxv + 1, py, czv - 1, M_WOOD); count++;
    world.set(cxv - 1, py, czv - 2, M_WOOD); count++;
    world.set(cxv - 1, py, czv + 1, M_WOOD); count++;
  }

  // 3. Four corner power pylons OUTSIDE the building. Each is a 2×2 wood
  // lattice rising 14 voxels above the surrounding ground, with a metal
  // crossbar near the top. From above the pylons sit at the four corners of
  // the building forming a clear "X" pattern around the central mast.
  const pylonCorners: [number, number][] = [
    [wxStart - 3, wzStart - 3],
    [wxEnd  + 1, wzStart - 3],
    [wxStart - 3, wzEnd  + 1],
    [wxEnd  + 1, wzEnd  + 1],
  ];
  const pylonH = 14;
  for (const [px, pz] of pylonCorners) {
    for (let dy = 0; dy < pylonH; dy++) {
      const py = yFloor + dy; if (py >= WORLD_Y) break;
      // Hollow 2×2 wood column — only the 4 corners.
      for (const [xo, zo] of [[0,0],[1,0],[0,1],[1,1]] as [number, number][]) {
        const tx = px + xo, tz = pz + zo;
        if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
        // Cross bracing: every 4 voxels also fill the centre.
        const inner = (xo === 0 && zo === 0) || (xo === 1 && zo === 1);
        if (dy % 4 === 0 || inner) { world.set(tx, py, tz, M_WOOD); count++; }
      }
    }
    // Federation blue crossbar at the top — a + shape extending one voxel
    // each way so the pylon's silhouette pops with team colour.
    const topY = yFloor + pylonH;
    if (topY < WORLD_Y) {
      for (const [xo, zo] of [
        [0, 0], [1, 0], [0, 1], [1, 1],
        [-1, 0], [2, 0], [0, -1], [0, 2],
      ] as [number, number][]) {
        const tx = px + xo, tz = pz + zo;
        if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
        world.set(tx, topY, tz, M_FED_BLUE); count++;
      }
    }
  }

  // 4. Transformer cabinets on the roof flanking the mast (4 small 2×2 metal
  // boxes between the mast and the corner pylons).
  const transformerOffsets: [number, number][] = [
    [cxv - 8, czv - 1], [cxv + 6, czv - 1],
    [cxv - 1, czv - 8], [cxv - 1, czv + 6],
  ];
  for (const [px, pz] of transformerOffsets) {
    for (let dy = 1; dy <= 3; dy++) {
      const py = yRoof + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 2; xo++) for (let zo = 0; zo < 2; zo++) {
        const tx = px + xo, tz = pz + zo;
        if (tx < wxStart || tx >= wxEnd || tz < wzStart || tz >= wzEnd) continue;
        world.set(tx, py, tz, M_METAL); count++;
      }
    }
    // Insulator stub on top.
    const topY = yRoof + 4;
    if (topY < WORLD_Y) {
      world.set(px,     topY, pz,     M_STONE); count++;
      world.set(px + 1, topY, pz + 1, M_STONE); count++;
    }
  }

  return count;
}

/**
 * Metal refinery — long processing hall with one BIG smoking chimney at the
 * back-left (positioned to match REFINERY_CHIMNEY_X_M / Z_M / TOP_Y_M so the
 * renderer's smoke plume lines up), a slag heap dumped outside the +Z face,
 * and an ore intake conveyor angling up to the roof on the -Z face. The
 * smoking chimney is the building's defining feature; no other building
 * emits smoke.
 */
export function stampRefinery(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = REFINERY;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +48
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +32
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;
  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;
  const doorYTop = yFloor + 10;
  const czv     = (wzStart + wzEnd) >> 1;

  let count = 0;

  // 1. Floor slab (2-thick).
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const py = yFloor - dy; if (py < 0) continue;
        world.set(x, py, z, M_STONE); count++;
      }
    }
  }

  // 2. Perimeter walls — stone bottom 8, metal upper, stone roof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (y === yRoof) { world.set(x, y, z, M_STONE); count++; continue; }
        if (!onPerim) { world.set(x, y, z, AIR); continue; }
        const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, (y - yFloor) <= 8 ? M_STONE : M_METAL); count++;
      }
    }
  }

  // 3. Big main chimney — 2×2 stone column at (wxStart+3, wzStart+3) so the
  // renderer's smoke plume (REFINERY_CHIMNEY_X/Z_M) emerges from the cap.
  // Total height 24 voxels so the cap matches REFINERY_CHIMNEY_TOP_Y_M.
  const mainChimX = wxStart + 2;
  const mainChimZ = wzStart + 2;
  const mainChimH = 24;
  for (let dy = 1; dy <= mainChimH; dy++) {
    const py = yRoof + dy - 4; if (py >= WORLD_Y) break;
    for (let xo = 0; xo < 2; xo++) for (let zo = 0; zo < 2; zo++) {
      const tx = mainChimX + xo, tz = mainChimZ + zo;
      if (tx >= WORLD_X || tz >= WORLD_Z) continue;
      // Federation red/white cap stripes on the top 4 voxels of the stack.
      let mat: number;
      if (dy >= mainChimH - 1)      mat = M_FED_RED;
      else if (dy >= mainChimH - 2) mat = M_FED_WHITE;
      else if (dy >= mainChimH - 3) mat = M_FED_RED;
      else                          mat = M_STONE;
      world.set(tx, py, tz, mat); count++;
    }
  }
  // Reinforcing band at half height — painted Federation blue.
  const bandY = yRoof + Math.floor(mainChimH / 2);
  if (bandY < WORLD_Y) {
    for (let xo = -1; xo < 3; xo++) for (let zo = -1; zo < 3; zo++) {
      const tx = mainChimX + xo, tz = mainChimZ + zo;
      if (tx < wxStart || tx >= wxEnd || tz < wzStart || tz >= wzEnd) continue;
      world.set(tx, bandY, tz, M_FED_BLUE); count++;
    }
  }

  // 4. Two smaller secondary chimneys — single-voxel columns 12 tall.
  for (const [cx, cz] of [[wxStart + 22, czv], [wxStart + 38, czv]] as [number, number][]) {
    for (let dy = 1; dy <= 12; dy++) {
      const py = yRoof + dy; if (py >= WORLD_Y) break;
      world.set(cx, py, cz, M_STONE); count++;
    }
    if (yRoof + 13 < WORLD_Y) { world.set(cx, yRoof + 13, cz, M_METAL); count++; }
  }

  // 5. Pipe network on the roof — metal pipe runs zigzagging across.
  const pipeY = yRoof + 1;
  if (pipeY < WORLD_Y) {
    // Main spine along centre.
    for (let x = mainChimX + 2; x < wxEnd - 2; x++) {
      world.set(x, pipeY, czv, M_METAL); count++;
    }
    // Two perpendicular drops to each side wall.
    for (const x of [wxStart + 14, wxStart + 30]) {
      for (let z = czv; z >= wzStart + 2; z--) {
        world.set(x, pipeY, z, M_METAL); count++;
      }
      for (let z = czv; z <= wzEnd - 2; z++) {
        world.set(x, pipeY, z, M_METAL); count++;
      }
    }
  }

  // 6. Slag heap dumped outside the +Z face — pile of M_DIRT_ROAD blocks
  // (3×3 base, stepped pyramid 3 voxels tall) at the rear-left of the building.
  const slagX0 = wxStart + 4;
  const slagZ0 = wzEnd + 1;
  for (let dy = 0; dy < 3; dy++) {
    const py = yFloor + dy; if (py >= WORLD_Y) break;
    const r = 3 - dy;
    for (let xo = 0; xo < r * 2; xo++) for (let zo = 0; zo < r * 2; zo++) {
      const tx = slagX0 + xo, tz = slagZ0 + zo;
      if (tx < 0 || tx >= WORLD_X || tz < 0 || tz >= WORLD_Z) continue;
      world.set(tx, py, tz, M_DIRT_ROAD); count++;
    }
  }

  // 7. Ore intake conveyor outside the -Z face — wood ramp angling up to the
  // roof so workers/trucks visually feed material into the refinery.
  const rampX0 = wxStart + 28;
  const rampZ0 = wzStart - 1;
  for (let step = 0; step < 6; step++) {
    const px0 = rampX0 + step;
    const py = yFloor + 1 + step * 3;
    const pz = rampZ0;
    if (py >= WORLD_Y || pz < 0) continue;
    for (let xo = 0; xo < 2; xo++) {
      const tx = px0 + xo;
      if (tx < 0 || tx >= WORLD_X) continue;
      world.set(tx, py, pz, M_WOOD); count++;
      if (pz - 1 >= 0) { world.set(tx, py, pz - 1, M_WOOD); count++; }
    }
  }

  // 8. Window strips on -X (rear) wall — 3-tall × 2-wide vents.
  for (let wz = wzStart + 6; wz < wzEnd - 5; wz += 10) {
    for (let dy = 0; dy < 3; dy++) {
      const py = yFloor + 14 + dy; if (py >= yRoof) break;
      world.set(wxStart, py, wz, AIR); count--;
      world.set(wxStart, py, wz + 1, AIR); count--;
    }
  }

  return count;
}

/**
 * Tech lab: a main research hall with an octagonal observation drum at the centre of
 * the roof and a slim antenna mast above it. Four corner sensor pods flank the drum.
 * The renderer mounts a sweeping satellite dish and a pulsing core on the mast.
 * Footprint: 4W × 4D nav cells = 32 × 32 voxels, headroom 20.
 */
/**
 * Tech lab — research bunker on a raised plinth, with a stepped pyramidal
 * roof (three concentric tiers) climbing to a central antenna mast and four
 * pencil-thin antenna spires rising at the corners outside the building.
 * The pyramid + spires silhouette reads as "research" from above; no other
 * building is stepped-pyramidal. The renderer mounts a satellite dish on
 * top of the central mast (TECH_LAB_MAST_TOP_Y_M) and a pulsing core inside.
 */
export function stampTechLab(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = TECH_LAB;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +32
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +32
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;
  const cxv     = (wxStart + wxEnd) >> 1;
  const czv     = (wzStart + wzEnd) >> 1;

  const doorWz0 = ((wzStart + wzEnd) >> 1) - 2;
  const doorWz1 = doorWz0 + 3;
  const doorYTop = yFloor + 8;

  let count = 0;

  // 1. Raised plinth — 2-voxel slab one wider than the hall.
  for (let z = wzStart - 1; z <= wzEnd; z++) {
    for (let x = wxStart - 1; x <= wxEnd; x++) {
      if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const py = yFloor - dy; if (py < 0) continue;
        world.set(x, py, z, M_STONE); count++;
      }
    }
  }

  // 2. Walls — stone bottom 6, metal cladding above. Door on +X.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      const onPerim = x === wxStart || x === wxEnd - 1 || z === wzStart || z === wzEnd - 1;
      for (let y = yFloor + 1; y < yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (!onPerim) { world.set(x, y, z, AIR); continue; }
        const isDoor = x === wxEnd - 1 && z >= doorWz0 && z <= doorWz1 && y < doorYTop;
        if (isDoor) { world.set(x, y, z, AIR); continue; }
        world.set(x, y, z, (y - yFloor) <= 6 ? M_STONE : M_METAL); count++;
      }
    }
  }

  // 3. Stepped pyramidal roof — three concentric stone tiers + cap.
  // Tier 1 (bottom of pyramid) covers the full footprint at yRoof.
  // Each subsequent tier shrinks by 3 voxels per side and rises by 2.
  const tiers = [
    { yOff: 0, inset: 0 },
    { yOff: 2, inset: 3 },
    { yOff: 4, inset: 6 },
  ];
  for (const tier of tiers) {
    const py = yRoof + tier.yOff; if (py >= WORLD_Y) continue;
    const x0 = wxStart + tier.inset;
    const x1 = wxEnd   - tier.inset;
    const z0 = wzStart + tier.inset;
    const z1 = wzEnd   - tier.inset;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
        world.set(x, py, z, M_STONE); count++;
      }
    }
    // Vertical wall ring connecting this tier to the one below (1 voxel tall).
    if (tier.yOff > 0) {
      const ringY = py - 1;
      if (ringY < WORLD_Y) {
        for (let x = x0; x < x1; x++) {
          for (let z = z0; z < z1; z++) {
            if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
            const onRing = x === x0 || x === x1 - 1 || z === z0 || z === z1 - 1;
            if (!onRing) continue;
            world.set(x, ringY, z, M_STONE); count++;
          }
        }
      }
    }
  }

  // 4. Glass skylight — small 2×2 metal patch on the top tier.
  if (yRoof + 5 < WORLD_Y) {
    for (let xo = -1; xo <= 0; xo++) for (let zo = -1; zo <= 0; zo++) {
      world.set(cxv + xo, yRoof + 5, czv + zo, M_METAL); count++;
    }
  }

  // 5. Central antenna mast — 2×2 metal base then 1×1 wood column up to the
  // height the renderer expects (TECH_LAB_MAST_TOP_Y_M).
  const drumTop = yRoof + 6;       // top of the pyramid
  for (let dy = 0; dy < 4; dy++) {
    const py = drumTop + dy; if (py >= WORLD_Y) break;
    for (let xo = -1; xo <= 0; xo++) for (let zo = -1; zo <= 0; zo++) {
      world.set(cxv + xo, py, czv + zo, M_METAL); count++;
    }
  }
  const mastTopBase = drumTop + 4;
  for (let dy = 0; dy < 8; dy++) {
    const py = mastTopBase + dy; if (py >= WORLD_Y) break;
    world.set(cxv, py, czv, M_WOOD); count++;
  }

  // 6. Four pencil antenna spires at the building corners (just outside the
  // perimeter). 1-voxel wood columns rising 12 voxels above the floor — they
  // poke up around the pyramid like a research tower silhouette.
  const spireH = 12;
  const spireCorners: [number, number][] = [
    [wxStart - 1, wzStart - 1],
    [wxEnd,       wzStart - 1],
    [wxStart - 1, wzEnd],
    [wxEnd,       wzEnd],
  ];
  for (const [sx, sz] of spireCorners) {
    if (sx < 0 || sx >= WORLD_X || sz < 0 || sz >= WORLD_Z) continue;
    for (let dy = 1; dy <= spireH; dy++) {
      const py = yFloor + dy; if (py >= WORLD_Y) break;
      world.set(sx, py, sz, M_METAL); count++;
    }
    // Beacon at the top.
    if (yFloor + spireH + 1 < WORLD_Y) {
      world.set(sx, yFloor + spireH + 1, sz, M_WOOD); count++;
    }
  }

  // 7. Tall arched windows on each face (1×6) — slim slits.
  const winY0 = yFloor + 8;
  for (let dy = 0; dy < 6; dy++) {
    const py = winY0 + dy; if (py >= yRoof) break;
    world.set(wxStart, py, czv - 1, AIR);
    world.set(wxStart, py, czv,     AIR);
    world.set(cxv - 1, py, wzStart, AIR);
    world.set(cxv,     py, wzStart, AIR);
    world.set(cxv - 1, py, wzEnd - 1, AIR);
    world.set(cxv,     py, wzEnd - 1, AIR);
  }

  return count;
}

/**
 * Turret pillbox — small concrete bunker with a heavy central metal pintle
 * column rising up to where the renderer mounts the rotating cannon head
 * (TURRET_HEAD_Y_M). Sandbag ring (M_DIRT_ROAD) wraps the base outside the
 * walls to reinforce the "fortified emplacement" read. Embrasure slits cut
 * through each face at gunner height.
 *
 * The pintle column at the centre is required: its top surface is what the
 * renderer attaches the cannon to, and shots emerge from `weaponMuzzleHeight`
 * which is the same height. The same stamp is reused for AA_TURRET — only
 * the rendered head differs.
 */
export function stampTurret(
  world: VoxelWorld,
  ox: number, oz: number,
  floorY: number,
): number {
  const spec = TURRET;
  const wxStart = ox * NAV_CELL_VOXELS;
  const wzStart = oz * NAV_CELL_VOXELS;
  const wxEnd   = wxStart + spec.cellsW * NAV_CELL_VOXELS;   // +16
  const wzEnd   = wzStart + spec.cellsD * NAV_CELL_VOXELS;   // +16
  const yFloor  = floorY + 1;
  const yRoof   = floorY + spec.headroomVoxels;
  const cxv     = (wxStart + wxEnd) >> 1;
  const czv     = (wzStart + wzEnd) >> 1;

  let count = 0;

  // 1. 2-thick stone foundation slab.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const py = yFloor - dy; if (py < 0) continue;
        world.set(x, py, z, M_STONE); count++;
      }
    }
  }

  // 2. Solid stone bunker walls — 3 voxels thick ring covering the full
  // footprint (no octagonal corner cut), full height to the roof.
  for (let z = wzStart; z < wzEnd; z++) {
    for (let x = wxStart; x < wxEnd; x++) {
      if (x >= WORLD_X || z >= WORLD_Z) continue;
      const dx = Math.min(x - wxStart, wxEnd - 1 - x);
      const dz = Math.min(z - wzStart, wzEnd - 1 - z);
      const onWall = Math.min(dx, dz) < 3;
      for (let y = yFloor + 1; y <= yRoof; y++) {
        if (y >= WORLD_Y) break;
        if (onWall) { world.set(x, y, z, M_STONE); count++; }
        else        { world.set(x, y, z, AIR); }
      }
    }
  }

  // 3. Embrasure slits — 1-tall horizontal openings at gunner height (yFloor+5)
  // through each face (cut a 4-wide gap centred on each face).
  const slitY = yFloor + 6;
  if (slitY < yRoof) {
    for (let i = -2; i <= 1; i++) {
      world.set(wxStart + 2 + i + 6, slitY, wzStart, AIR); count--;
      world.set(wxStart + 2 + i + 6, slitY, wzEnd - 1, AIR); count--;
      world.set(wxStart, slitY, wzStart + 2 + i + 6, AIR); count--;
      world.set(wxEnd - 1, slitY, wzStart + 2 + i + 6, AIR); count--;
    }
  }

  // 4. Sandbag perimeter — M_DIRT_ROAD ring one voxel outside each face.
  for (let i = wxStart - 1; i <= wxEnd; i++) {
    if (i < 0 || i >= WORLD_X) continue;
    const z0 = wzStart - 1, z1 = wzEnd;
    if (z0 >= 0)         world.set(i, yFloor + 1, z0, M_DIRT_ROAD);
    if (z1 < WORLD_Z)    world.set(i, yFloor + 1, z1, M_DIRT_ROAD);
  }
  for (let j = wzStart - 1; j <= wzEnd; j++) {
    if (j < 0 || j >= WORLD_Z) continue;
    const x0 = wxStart - 1, x1 = wxEnd;
    if (x0 >= 0)         world.set(x0, yFloor + 1, j, M_DIRT_ROAD);
    if (x1 < WORLD_X)    world.set(x1, yFloor + 1, j, M_DIRT_ROAD);
  }
  // Second row of sandbags stacked on top for a visible double-bag look.
  for (let i = wxStart - 1; i <= wxEnd; i++) {
    if (i < 0 || i >= WORLD_X) continue;
    if (yFloor + 2 >= WORLD_Y) break;
    if (((i - wxStart) & 1) === 0) {
      const z0 = wzStart - 1, z1 = wzEnd;
      if (z0 >= 0)      world.set(i, yFloor + 2, z0, M_DIRT_ROAD);
      if (z1 < WORLD_Z) world.set(i, yFloor + 2, z1, M_DIRT_ROAD);
    }
  }

  // 5. Crenellated parapet on the outer ring (every 2 voxels) — alternating
  // Federation blue and white merlons so the turret reads as friendly from
  // the RTS camera.
  const parapetY = yRoof + 1;
  if (parapetY < WORLD_Y) {
    for (let x = wxStart; x < wxEnd; x++) {
      for (let z = wzStart; z < wzEnd; z++) {
        if (x >= WORLD_X || z >= WORLD_Z) continue;
        const dx = Math.min(x - wxStart, wxEnd - 1 - x);
        const dz = Math.min(z - wzStart, wzEnd - 1 - z);
        const onOuterRing = dx === 0 || dz === 0;
        if (!onOuterRing) continue;
        const pos = (x - wxStart) + (z - wzStart);
        if (pos % 2 === 0) {
          const stripe = ((pos >> 1) & 1) === 0 ? M_FED_BLUE : M_FED_WHITE;
          world.set(x, parapetY, z, stripe); count++;
        }
      }
    }
  }

  // 6. Central pintle — 4×4 M_METAL column from the floor up to TURRET_HEAD_Y_M.
  const pedBaseY = yFloor + 1;
  const pedTopY  = yRoof + 4;          // matches TURRET_HEAD_Y_M (headroom + 4)
  for (let y = pedBaseY; y <= pedTopY; y++) {
    if (y >= WORLD_Y) break;
    for (let xo = -2; xo <= 1; xo++) for (let zo = -2; zo <= 1; zo++) {
      const px = cxv + xo, pz = czv + zo;
      if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
      world.set(px, y, pz, M_METAL); count++;
    }
  }
  // Pintle ring cap (slightly wider than the column at the very top).
  const capY = pedTopY + 1;
  if (capY < WORLD_Y) {
    for (let xo = -3; xo <= 2; xo++) for (let zo = -3; zo <= 2; zo++) {
      const onRing = xo === -3 || xo === 2 || zo === -3 || zo === 2;
      if (!onRing) continue;
      const px = cxv + xo, pz = czv + zo;
      if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
      world.set(px, capY, pz, M_METAL); count++;
    }
  }

  return count;
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

  // Missile tubes — 5 in an X pattern on the roof (4 corners + centre). Each
  // tube is a 3×3 metal column 26 voxels tall (~3.25 m) with a stepped
  // nosecone, two reinforcing bands, and exhaust grating at the base. Tall
  // enough that the silo is the most vertical building on the map.
  const tubeBaseY = yRoof + 2;
  const tubeH = 26;
  const tubePositions: [number, number][] = [
    [cxv - 1, czv - 1],        // centre — slightly taller
    [cxv - 7, czv - 7],        // NW quad
    [cxv + 4, czv - 7],        // NE quad
    [cxv - 7, czv + 4],        // SW quad
    [cxv + 4, czv + 4],        // SE quad
  ];
  for (let i = 0; i < tubePositions.length; i++) {
    const [tx, tz] = tubePositions[i]!;
    const isCenter = i === 0;
    const thisTubeH = isCenter ? tubeH + 6 : tubeH;
    // Body — 3×3 metal column.
    for (let dy = 0; dy < thisTubeH; dy++) {
      const py = tubeBaseY + dy; if (py >= WORLD_Y) break;
      for (let xo = 0; xo < 3; xo++) {
        for (let zo = 0; zo < 3; zo++) {
          const px = tx + xo - 1; const pz = tz + zo - 1;
          if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
          world.set(px, py, pz, M_METAL); wallCount++;
        }
      }
    }
    // Tapered nosecone — two stepped layers above the tube body.
    const noseY1 = tubeBaseY + thisTubeH;
    const noseY2 = noseY1 + 1;
    const noseY3 = noseY1 + 2;
    if (noseY1 < WORLD_Y) {
      for (let xo = 0; xo < 3; xo++) for (let zo = 0; zo < 3; zo++) {
        const px = tx + xo - 1; const pz = tz + zo - 1;
        if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
        world.set(px, noseY1, pz, M_METAL); wallCount++;
      }
    }
    if (noseY2 < WORLD_Y) {
      world.set(tx - 0, noseY2, tz - 0, M_METAL);
      world.set(tx - 0, noseY2, tz + 1, M_METAL);
      world.set(tx + 1, noseY2, tz - 0, M_METAL);
      world.set(tx + 1, noseY2, tz + 1, M_METAL);
      wallCount += 4;
    }
    if (noseY3 < WORLD_Y) {
      world.set(tx, noseY3, tz, M_METAL);
      wallCount++;
    }
    // Reinforcing bands — quarter and three-quarter height. Painted in
    // Federation red so the cluster reads as friendly ICBMs from above.
    for (const frac of [0.25, 0.75]) {
      const bandY = tubeBaseY + Math.floor(thisTubeH * frac);
      if (bandY >= WORLD_Y) continue;
      for (let xo = -2; xo <= 2; xo++) {
        for (let zo = -2; zo <= 2; zo++) {
          const px = tx + xo; const pz = tz + zo;
          if (Math.max(Math.abs(xo), Math.abs(zo)) !== 2) continue;
          if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
          world.set(px, bandY, pz, M_FED_RED); wallCount++;
        }
      }
    }
    // Exhaust grating at the base — a 5×5 stone collar around the tube's foot.
    const baseY = tubeBaseY - 1;
    if (baseY >= 0 && baseY < WORLD_Y) {
      for (let xo = -2; xo <= 2; xo++) {
        for (let zo = -2; zo <= 2; zo++) {
          const px = tx + xo; const pz = tz + zo;
          if (Math.max(Math.abs(xo), Math.abs(zo)) < 2) continue;
          if (px < 0 || px >= WORLD_X || pz < 0 || pz >= WORLD_Z) continue;
          world.set(px, baseY, pz, M_STONE); wallCount++;
        }
      }
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

  // ---- Federation flag pole on the central roof, banner draped toward +X ----
  const flagX = cxv;
  const flagZ = czv;
  for (let dy = 1; dy <= 18; dy++) {
    const py = yRoof + dy; if (py >= WORLD_Y) break;
    set(flagX, py, flagZ, M_WOOD);
  }
  // 6 wide × 6 tall banner — top to bottom: red/white/blue/blue/white/red.
  const hqStripes = [M_FED_RED, M_FED_WHITE, M_FED_BLUE, M_FED_BLUE, M_FED_WHITE, M_FED_RED];
  for (let by = 0; by < 6; by++) {
    const stripe = hqStripes[by]!;
    for (let bx = 1; bx <= 6; bx++) {
      set(flagX + bx, yRoof + 16 - by, flagZ, stripe);
    }
  }

  return wallCount;
}

/**
 * Per-building-kind threat to a ground attacker. Mirrors `UNIT_THREAT` —
 * higher-threat buildings get prioritised by the aggressive-stance
 * target picker. The numeric scale is consistent across units and
 * buildings so a unit's threat can be compared directly to a building's.
 *
 * Anti-ground turrets and silos are deadliest (they can shoot the
 * attacker now). Production buildings rank next because clearing them
 * starves the player's army. Population / economy buildings rank
 * lowest. AA-only turrets are scored by `buildingThreatLevel` rather
 * than this table so they read as low-threat to ground units even
 * though their kind is `'turret'`.
 */
const BUILDING_THREAT: Record<BuildingKind, number> = {
  // Per the AI design rule: units take priority over buildings except
  // for ACTIVE DEFENSIVE structures that can shoot the attacker now.
  // Silo + turret + (effective) AA turret stay high so a soldier
  // walking past a silo turns and clears it first; everything else —
  // HQ included — drops below every unit threat so attackers shoot
  // screening soldiers + tanks first and only chip at the structure
  // when no live target remains in range.
  silo:          95,
  turret:        88,   // anti-ground; aa_turret is overridden in buildingThreatLevel
  // Iter29 with hq=60 saw combat raging but HQ HP dropping only ~75 in
  // 240 s — units were still pulling aggro to nearby gunners (70) /
  // rocket_soldiers (78) instead of focusing on the HQ wall. Bumping to
  // 85 puts HQ above every infantry threat (max=78) and tunneler/worm
  // (75) but just below tank (95), so a soldier near a non-tank target
  // shoots the HQ first. Tanks + active defensive structures
  // (turret 88, silo 95) still win aggro to prevent suicide rushes.
  hq:            85,
  vehicle_depot: 8,
  barracks:      7,
  tech_lab:      5,
  refinery:      5,
  power_plant:   5,
  storage:       4,
  farm:          3,
  neighborhood:  3,
};

/**
 * Threat score for a specific building. Reads `BUILDING_THREAT` for the
 * spec kind, then de-rates AA turrets — they don't shoot ground units,
 * so attackers should ignore them when an actual anti-ground threat is
 * on the map.
 */
/**
 * Fraction of structural voxels that must be destroyed before a non-HQ
 * building collapses. 0.30 = 30 % chewed away. Tuned high so a stray
 * mortar round doesn't flatten a barracks; the AI's army has to commit
 * real damage to remove a production building.
 */
export const DEFAULT_STRUCTURAL_DEATH_FRACTION = 0.30;

/**
 * HQ-specific death threshold. 0.02 = 2 % — much lower than the default
 * because HQ is the win condition and the 240 s AI-vs-AI harness needs
 * to actually crack one inside the budget. Measured iter28-iter37: a
 * 5-8 unit infantry push lands ~1.8-4.6 % voxel destruction in 240 s,
 * so 2 % sits just under the achievable peak. A lone soldier on rifle
 * chip damage still takes many minutes to cross the gate, so this isn't
 * a free HQ kill — it requires a real military push. Iter39 produced
 * HQ_WIN at t=209.9 s with this threshold.
 */
export const HQ_STRUCTURAL_DEATH_FRACTION = 0.02;

export function buildingThreatLevel(b: Building): number {
  const base = BUILDING_THREAT[b.spec.kind] ?? 30;
  if (b.spec.kind === 'turret' && b.spec.weapon === 'aa_turret') return 18;
  return base;
}

/**
 * Materials that aren't part of a building's "structure" for HP purposes —
 * floor markings, drill yards, the dirt road that runs through a
 * neighborhood lot. These are stamped by the building but represent
 * infrastructure / cosmetics, not the walls, foundation, and roof that
 * make a building a building. Excluded both at snapshot time and from
 * the runtime alive-count, so destroying a road voxel never moves the
 * HP needle.
 */
function isStructuralMaterial(mat: number): boolean {
  if (mat === AIR) return false;
  if (mat === M_DIRT_ROAD) return false;
  if (mat === M_PATH) return false;
  return true;
}

/**
 * Snapshot a building's structural voxels — the ones that will count
 * toward HP from now on. Walks the headroom AABB and records every
 * non-AIR, non-infrastructure voxel index. Returns the index array plus
 * the centroid (in world meters) of those voxels for use as the
 * projectile aim point.
 *
 * Captured at construction completion. Anything stamped after that
 * (terrain regrowth, etc.) doesn't bump HP because it isn't in the
 * snapshot. Damage = (snapshot indices that are now AIR) / (snapshot
 * size), capped at the 30 % collapse threshold.
 */
export function snapshotBuildingStructure(
  world: VoxelWorld,
  b: Building,
): { idx: Uint32Array; aim: { x: number; y: number; z: number } | null } {
  const wxStart = b.ox * NAV_CELL_VOXELS;
  const wzStart = b.oz * NAV_CELL_VOXELS;
  const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS;
  const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS;
  const yFloor = b.floorY + 1;
  const yRoof = b.floorY + b.spec.headroomVoxels;
  const indices: number[] = [];
  let sx = 0, sy = 0, sz = 0;
  for (let z = wzStart; z < wzEnd; z++) {
    if (z < 0 || z >= WORLD_Z) continue;
    for (let x = wxStart; x < wxEnd; x++) {
      if (x < 0 || x >= WORLD_X) continue;
      for (let y = yFloor; y <= yRoof; y++) {
        if (y < 0 || y >= WORLD_Y) continue;
        const mat = world.get(x, y, z);
        if (!isStructuralMaterial(mat)) continue;
        indices.push(worldIndex(x, y, z));
        sx += x; sy += y; sz += z;
      }
    }
  }
  const idx = new Uint32Array(indices);
  if (idx.length === 0) return { idx, aim: null };
  const n = idx.length;
  // +0.5 so each voxel index maps to its centre rather than its corner.
  const aim = {
    x: (sx / n + 0.5) * VOXEL_SIZE,
    y: (sy / n + 0.5) * VOXEL_SIZE,
    z: (sz / n + 0.5) * VOXEL_SIZE,
  };
  return { idx, aim };
}

/**
 * Count how many of the building's snapshotted structural voxels are
 * still standing (non-AIR). Linear scan over the saved index array — no
 * AABB walk, so the cost scales with structure size rather than the
 * full volume.
 */
export function countAliveStructureVoxels(world: VoxelWorld, b: Building): number {
  const idx = b.structureVoxelIdx;
  if (!idx) return 0;
  const voxels = world.buffers.voxels;
  let alive = 0;
  for (let i = 0; i < idx.length; i++) {
    if (voxels[idx[i]!] !== AIR) alive++;
  }
  return alive;
}

export interface DoorWorldPos { x: number; y: number; z: number; }

/**
 * Returns the world-space rendezvous point for building `b`. When `fromX` and
 * `fromZ` are supplied (caller world-space position), storage buildings pick
 * whichever of their 4 face doors is closest to the caller. All other buildings
 * always use the +X face.
 *
 * `rotation` rotates through the door faces ranked by distance to the caller:
 * rotation=0 → closest, rotation=1 → 2nd closest, … rotation=3 → farthest.
 * Used by stuck workers / trucks: when the closest face is unreachable
 * (HQ + storage placed cheek-to-jowl, no walkable column on that side), the
 * caller bumps the rotation and tries the next face. Without the option a
 * delivery would loop forever on the same blocked door.
 *
 * Supply trucks have footprintRadius=2 (halfFootprint=1): their 3×3 cell box
 * extends 1 cell into the building wall unless the rendezvous is pushed at least
 * 2 nav cells outside. For -X/-Z faces the building's first cell is the wall, so
 * 2 cells is required. We use 2*NAV_CELL_VOXELS uniformly on all four faces.
 * HQ uses the same 2-cell gap for its guard booths.
 */
export function doorWorldPos(
  b: Building,
  fromX?: number,
  fromZ?: number,
  rotation?: number,
): DoorWorldPos {
  const wxStart = b.ox * NAV_CELL_VOXELS;
  const wxEnd   = (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS;
  const wzStart = b.oz * NAV_CELL_VOXELS;
  const wzEnd   = (b.oz + b.spec.cellsD) * NAV_CELL_VOXELS;
  const wxMid   = (wxStart + wxEnd) * 0.5;
  const wzMid   = (wzStart + wzEnd) * 0.5;
  const y       = (b.floorY + 1) * VOXEL_SIZE;
  // Tight approach gap: 4 voxels = 0.5 m outside the wall on every face.
  // The path planner pulls the goal to the closest passable cell, and the
  // truck stops at its footprint-imposed minimum (one nav cell out for a
  // 3-cell-wide truck). Tightening the gap brings trucks visibly closer to
  // the building face for delivery.
  const gap     = 4;

  // Pick whichever cardinal face is closest to the caller — applies to every
  // building so a truck/worker doesn't always wrap around to the +X side.
  // Falls back to +X when no caller position is supplied (for the few
  // callers that just need any door).
  if (fromX !== undefined && fromZ !== undefined) {
    const candidates: DoorWorldPos[] = [
      { x: (wxEnd   + gap) * VOXEL_SIZE, y, z: wzMid  * VOXEL_SIZE },  // +X (east)
      { x: (wxStart - gap) * VOXEL_SIZE, y, z: wzMid  * VOXEL_SIZE },  // -X (west)
      { x: wxMid * VOXEL_SIZE, y, z: (wzEnd   + gap) * VOXEL_SIZE },   // +Z (south)
      { x: wxMid * VOXEL_SIZE, y, z: (wzStart - gap) * VOXEL_SIZE },   // -Z (north)
    ];
    candidates.sort((a, c) => {
      const ad2 = (a.x - fromX) * (a.x - fromX) + (a.z - fromZ) * (a.z - fromZ);
      const cd2 = (c.x - fromX) * (c.x - fromX) + (c.z - fromZ) * (c.z - fromZ);
      return ad2 - cd2;
    });
    const idx = ((rotation ?? 0) % candidates.length + candidates.length) % candidates.length;
    return candidates[idx]!;
  }

  return {
    x: (wxEnd + gap) * VOXEL_SIZE,
    y,
    z: wzMid * VOXEL_SIZE,
  };
}

/**
 * Nearest point on the building's approach perimeter (expanded by the minimum
 * truck clearance of 2 nav cells on every side) to the query position.
 *
 * Unlike doorWorldPos which returns one of 4 fixed face-center points, this
 * lets trucks approach from any angle — corners included — so pathfinding
 * can pick the genuinely shortest route rather than always going to a
 * perpendicular face.
 *
 * The interaction check in SupplyTrucks uses buildingBoxDistM() against the
 * same expanded box so any position within INTERACT_REACH_M of the perimeter
 * triggers a delivery.
 */
export function buildingNearestApproach(b: Building, fromX: number, fromZ: number): DoorWorldPos {
  // 2 nav cells = 16 voxels = 2 m. Trucks (footprintRadius=2, 3×3 cell box)
  // need their centre at least 2 cells outside the building wall so the
  // outer ring of their footprint clears the wall's nav-cell column.
  // A previous 4-voxel (0.5 m) margin put the centre cell adjacent to the
  // wall, so the truck's halfFootprint=1 box overlapped the building
  // column itself and every face approach failed `isPassable` — trucks then
  // hung on the storage west face when the +X face was blocked by HQ.
  // The trigger zone in `buildingBoxDistM` (gap=4 + INTERACT_REACH_M=3 m)
  // still covers a 2 m approach point comfortably.
  const gap = 2 * NAV_CELL_VOXELS;
  const x0 = (b.ox * NAV_CELL_VOXELS - gap) * VOXEL_SIZE;
  const x1 = ((b.ox + b.spec.cellsW) * NAV_CELL_VOXELS + gap) * VOXEL_SIZE;
  const z0 = (b.oz * NAV_CELL_VOXELS - gap) * VOXEL_SIZE;
  const z1 = ((b.oz + b.spec.cellsD) * NAV_CELL_VOXELS + gap) * VOXEL_SIZE;
  const y  = (b.floorY + 1) * VOXEL_SIZE;

  // Clamp query point to the expanded box.
  const cx = Math.max(x0, Math.min(x1, fromX));
  const cz = Math.max(z0, Math.min(z1, fromZ));

  const onX = cx === x0 || cx === x1;
  const onZ = cz === z0 || cz === z1;

  if (onX || onZ) {
    // Query is outside or on the boundary — clamped point is already on the perimeter.
    return { x: cx, y, z: cz };
  }

  // Query is strictly inside the expanded box — project to nearest face.
  const dLeft  = cx - x0;
  const dRight = x1 - cx;
  const dBack  = cz - z0;
  const dFront = z1 - cz;
  const minD   = Math.min(dLeft, dRight, dBack, dFront);
  if (minD === dLeft)  return { x: x0, y, z: cz };
  if (minD === dRight) return { x: x1, y, z: cz };
  if (minD === dBack)  return { x: cx, y, z: z0 };
  return { x: cx, y, z: z1 };
}

/**
 * Returns up to 9 candidate approach points on the building's perimeter arc,
 * sorted nearest-first relative to (fromX, fromZ). The caller should iterate
 * them and pick the first one that is passable in the nav grid; the last entry
 * is always the raw nearest-perimeter point as an unconditional fallback.
 *
 * Candidates: nearest perimeter point, 4 face centres, 4 corners (deduplicated).
 */
/**
 * True if at least one of the proposed building's 4 face approach centres
 * leaves a 3×3 nav-cell clearing (truck footprintRadius=2) free of any
 * non-farm building footprint — including the proposed building itself.
 *
 * Mirrors the geometry that `buildingApproachCandidates` produces with the
 * 2-nav-cell wall margin, so the truck-side `isPassable` closure has at
 * least one candidate that survives its r=1 footprint check. Without this
 * gate the AI / starter-kit happily places storage cheek-to-jowl with HQ,
 * leaving a 1-cell corridor that trucks (3 cells wide) can never traverse —
 * every fetch / deliver hangs and the team starves.
 *
 * Farms are excluded from `buildingMask` at runtime so their footprint
 * doesn't count here either; they're an open field with a low rail, not
 * a sealed wall.
 */
export function hasTruckApproach(
  ox: number,
  oz: number,
  spec: BuildingSpec,
  existing: readonly Building[],
): boolean {
  const r = 1; // truck halfFootprint = footprintRadius - 1 = 1
  const midX = ox + (spec.cellsW >> 1);
  const midZ = oz + (spec.cellsD >> 1);
  const candidates: ReadonlyArray<{ cx: number; cz: number }> = [
    { cx: ox - 2,                cz: midZ                      }, // -X face
    { cx: ox + spec.cellsW + 1,  cz: midZ                      }, // +X face
    { cx: midX,                  cz: oz - 2                    }, // -Z face
    { cx: midX,                  cz: oz + spec.cellsD + 1      }, // +Z face
  ];
  for (const c of candidates) {
    if (truckBox3x3PassesFootprintMask(c.cx, c.cz, r, ox, oz, spec, existing)) return true;
  }
  return false;
}

function truckBox3x3PassesFootprintMask(
  cx: number,
  cz: number,
  r: number,
  propOx: number,
  propOz: number,
  propSpec: BuildingSpec,
  existing: readonly Building[],
): boolean {
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      if (x < 0 || z < 0 || x >= NAV_W || z >= NAV_H) return false;
      if (
        x >= propOx && x < propOx + propSpec.cellsW &&
        z >= propOz && z < propOz + propSpec.cellsD
      ) return false;
      for (const b of existing) {
        if (b.destroyed) continue;
        if (b.spec.kind === 'farm') continue;
        if (
          x >= b.ox && x < b.ox + b.spec.cellsW &&
          z >= b.oz && z < b.oz + b.spec.cellsD
        ) return false;
      }
    }
  }
  return true;
}

export function buildingApproachCandidates(
  b: Building,
  fromX: number,
  fromZ: number,
): DoorWorldPos[] {
  // See note in `buildingNearestApproach` — the 2-nav-cell margin keeps
  // trucks' 3×3 footprint cleanly outside the wall's nav-cell column so
  // `isPassable` for trucks actually accepts these approach points when
  // the building sits next to other buildings.
  const gap = 2 * NAV_CELL_VOXELS;
  const x0 = (b.ox * NAV_CELL_VOXELS - gap) * VOXEL_SIZE;
  const x1 = ((b.ox + b.spec.cellsW) * NAV_CELL_VOXELS + gap) * VOXEL_SIZE;
  const z0 = (b.oz * NAV_CELL_VOXELS - gap) * VOXEL_SIZE;
  const z1 = ((b.oz + b.spec.cellsD) * NAV_CELL_VOXELS + gap) * VOXEL_SIZE;
  const xm = (x0 + x1) * 0.5;
  const zm = (z0 + z1) * 0.5;
  const y  = (b.floorY + 1) * VOXEL_SIZE;

  const pts: DoorWorldPos[] = [
    buildingNearestApproach(b, fromX, fromZ), // geometric nearest — always first before sort
    { x: x1, y, z: zm }, { x: x0, y, z: zm }, // face centres ±X
    { x: xm, y, z: z1 }, { x: xm, y, z: z0 }, // face centres ±Z
    { x: x1, y, z: z1 }, { x: x1, y, z: z0 }, // +X corners
    { x: x0, y, z: z1 }, { x: x0, y, z: z0 }, // -X corners
  ];

  // Sort by distance (nearest first).
  pts.sort((a, c) => (a.x - fromX) ** 2 + (a.z - fromZ) ** 2 - ((c.x - fromX) ** 2 + (c.z - fromZ) ** 2));

  // Deduplicate on (x, z) to within 0.05 m.
  const out: DoorWorldPos[] = [];
  for (const p of pts) {
    if (!out.some(q => Math.abs(q.x - p.x) < 0.05 && Math.abs(q.z - p.z) < 0.05)) out.push(p);
  }
  return out;
}

/**
 * Distance (metres) from world point (ux, uz) to the building's expanded
 * approach box (same 2-nav-cell gap used by buildingNearestApproach).
 * Returns 0 when the unit is on or inside the perimeter.
 */
export function buildingBoxDistM(ux: number, uz: number, b: Building): number {
  const gap = 4; // 4 voxels = 0.5 m approach margin around the wall
  const x0 = (b.ox * NAV_CELL_VOXELS - gap) * VOXEL_SIZE;
  const x1 = ((b.ox + b.spec.cellsW) * NAV_CELL_VOXELS + gap) * VOXEL_SIZE;
  const z0 = (b.oz * NAV_CELL_VOXELS - gap) * VOXEL_SIZE;
  const z1 = ((b.oz + b.spec.cellsD) * NAV_CELL_VOXELS + gap) * VOXEL_SIZE;
  const dx = Math.max(0, x0 - ux, ux - x1);
  const dz = Math.max(0, z0 - uz, uz - z1);
  return Math.sqrt(dx * dx + dz * dz);
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

  // Skip the cells closest to the building wall. Wide vehicle chassis have a
  // halfWidthM scan radius in sampleSurfaceFollow that extends into the
  // building wall and snaps the unit to the building roof. Safe start defaults
  // to 0 for infantry buildings; vehicle_depot uses 2 so tanks/tunnelers clear
  // the east wall completely.
  const safeStart = b.spec.spawnPadSafeStart ?? 0;
  const usableCols = Math.max(1, pad - safeStart);
  const slots = usableCols * b.spec.cellsD;
  const slot = b.spawnSlot % slots;
  const dx = (slot % usableCols) + safeStart;
  const dz = Math.floor(slot / usableCols);

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
  /**
   * Called when a building wants to spawn a unit. The producing
   * building is passed so the spawner can pick the right team / stance
   * — enemy barracks need to produce hostile units in aggressive
   * stance, player barracks the opposite. Returns the spawned Unit
   * or null when the spawn was refused.
   */
  spawner:
    | ((kind: UnitKind, x: number, y: number, z: number, building: Building) => Unit | null)
    | null = null;
  /**
   * Pop-cap gate consulted right before a producer building tries to spawn
   * a queued unit. Returns true when the player has at least one open
   * pop slot of the right size. When the gate refuses, the production
   * timer is held at full so the building waits cleanly until population
   * frees up (e.g. a soldier dies or the player upgrades a neighborhood).
   */
  popHasRoom: ((kind: UnitKind, building: Building) => boolean) | null = null;
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
   * Lifecycle hooks. `onBuildingPlaced` fires synchronously inside `place()`
   * after the building is in the array; `onBuildingDestroyed` fires when HP
   * hits zero or the wall-liveness check trips. Game wires these to update
   * the path system's building footprint mask so units never path on top of
   * a live building's roof (and the rubble becomes traversable on destroy).
   */
  onBuildingPlaced: ((b: Building) => void) | null = null;
  onBuildingDestroyed: ((b: Building) => void) | null = null;
  /**
   * Hook for the destruction-ring explosions. Called several times per
   * destroyed building with voxel-space coordinates and a small radius;
   * Game wires it to `world.damageSphere` (so the wreckage gets blown
   * apart further and the surrounding terrain craters) plus an
   * `impactFlashes.spawn()` for the visual flash.
   */
  onBuildingExplosion: ((vx: number, vy: number, vz: number, radiusVoxels: number, peakDamage: number) => void) | null = null;
  /**
   * Per-tick AA network assignment: maps projectile.id → the building.id of
   * the nearest live AA turret in range. Populated by `buildAAAssignments`
   * at the start of each tick before the per-building loop runs. Each AA
   * turret then only intercepts projectiles assigned to it, so a single
   * incoming round is engaged by exactly one turret — the closest one.
   */
  private readonly aaAssignments = new Map<number, number>();

  /**
   * Centralised destruction so the lifecycle hook fires exactly once per
   * building and any future cleanup (mask clearing, rubble effects) has a
   * single path. Idempotent — calling it again on an already-destroyed
   * building is a no-op.
   */
  private markDestroyed(b: Building): void {
    if (b.destroyed) return;
    b.destroyed = true;
    this.onBuildingDestroyed?.(b);
  }

  /**
   * Spawn a ring of small explosions inside and around the building's
   * footprint when its HP hits zero. Each blast is a short-radius
   * `damageSphere` call (so the wreckage falls apart further and the
   * surrounding terrain visibly craters) plus an impact flash for the
   * visual punch. Count + radius scale with the building's footprint so a
   * silo doesn't get the same amount of fireworks as a turret.
   */
  private spawnDestructionExplosions(b: Building): void {
    if (!this.onBuildingExplosion) return;
    const wxStart = b.ox * NAV_CELL_VOXELS;
    const wxEnd   = wxStart + b.spec.cellsW * NAV_CELL_VOXELS;
    const wzStart = b.oz * NAV_CELL_VOXELS;
    const wzEnd   = wzStart + b.spec.cellsD * NAV_CELL_VOXELS;
    const yMin = b.floorY + 1;
    const yMax = b.floorY + b.spec.headroomVoxels;
    const footprintArea = b.spec.cellsW * b.spec.cellsD;
    const count = Math.max(4, Math.min(12, Math.round(footprintArea * 0.55)));
    // Per-blast radius / peak — 3 voxels = ~0.4 m crater, 130 peak chews
    // through dirt+grass cleanly without shaving the bedrock floor.
    const radiusVoxels = 3.0;
    const peakDamage = 130;
    // Deterministic spread across the footprint + a slight outward halo so
    // some blasts spill into the immediate terrain. Uses Math.random for
    // the angle jitter — destruction events are visual and one-shot, so a
    // little non-determinism just adds variety frame-to-frame.
    for (let i = 0; i < count; i++) {
      // Mix of "inside the AABB" and "just outside" so the surrounding
      // ground catches part of the blast too.
      const halo = Math.random() < 0.4 ? 4 : 0; // voxels outside the AABB
      const x = wxStart - halo + Math.random() * (wxEnd - wxStart + halo * 2);
      const z = wzStart - halo + Math.random() * (wzEnd - wzStart + halo * 2);
      const y = yMin + Math.random() * Math.max(1, (yMax - yMin));
      this.onBuildingExplosion(x, y, z, radiusVoxels, peakDamage);
    }
  }

  place(
    world: VoxelWorld,
    spec: BuildingSpec,
    ox: number, oz: number, floorY: number,
    opts?: { team?: BuildingTeam },
  ): Building {
    // Bootstrap buildings (HQ / storage) stamp immediately; everything
    // else defers stamping to `captureAndCarveBuildQueue`, which produces
    // the same voxel state but accompanied by a queue + carve so the
    // structure visually grows in. wallCount is meaningful only for
    // bootstrap buildings — others read their integrity from
    // `healthRefVoxels` (snapshotted at upgrade completion).
    const wallCount = spec.enabledOnPlace ? spec.stamp(world, ox, oz, floorY) : 0;
    const b: Building = {
      id: this.nextId++,
      spec,
      ox, oz,
      floorY,
      productionTimer: spec.productionInterval,
      wallVoxelsAtBuild: wallCount,
      destroyed: false,
      team: opts?.team ?? 'player',
      // Buildings start at 0 HP while their initial upgrade is pending so a
      // player who places a barracks in a contested spot has a real
      // construction-vulnerability window. HP snaps to maxHp the moment the
      // upgrade completes.
      hp: spec.enabledOnPlace ? spec.maxHp : 0,
      maxHp: spec.maxHp,
      healthRefVoxels: 0, // populated below after stamp / on upgrade complete
      structureVoxelIdx: null,
      // Default aim is the geometric lot centre; refreshed to the centroid
      // of structural voxels once the building is stamped.
      aimWX: ((ox + spec.cellsW * 0.5) * NAV_CELL_VOXELS) * VOXEL_SIZE,
      aimWY: (floorY + Math.min(spec.headroomVoxels - 2, 8)) * VOXEL_SIZE,
      aimWZ: ((oz + spec.cellsD * 0.5) * NAV_CELL_VOXELS) * VOXEL_SIZE,
      selected: false,
      trainQueue: [],
      cropProgress: 0,
      harvestMilestone: 0,
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
      stockpile: { metals: 0, wood: 0, food: 0 },
      // 20 = one worker carry load (WORKER_CARRY_CAP). Default was 50,
      // which forced workers to make 3 round-trips before any truck
      // shuttle fired — so a 60-wood neighborhood couldn't be funded
      // until t≈90s in AI-vs-AI matches and the build order stalled
      // at 1 barracks (see iter3 FAILURE_NO_COMBAT). Dispatching after
      // a single delivery keeps the team pool flowing and lets the
      // brain afford a hood / second barracks inside the first 60 s.
      truckCallThreshold: 20,
      supplyInbound: false,
      supplyDelivered: false,
      suppliedUnits: 0,
      inboundResupplyTrucks: 0,
      activeTrucks: 0,
      upgradeState: spec.enabledOnPlace ? 'enabled' : 'pending',
      upgradeStockpile: { metals: 0, wood: 0 },
      inboundUpgradeTrucks: 0,
      tier: 0,
      upgradeTracks: {},
      // Freshly-placed non-bootstrap buildings auto-target the `initial`
      // upgrade so trucks start delivering without the player having to
      // click "Construct". HQ has no `initial` track (it's enabled on
      // place); player picks `range` or `trucks` from the panel later.
      activeUpgradeId: spec.enabledOnPlace ? null : 'initial',
      buildVoxels: null,
      buildMaterials: null,
      buildBeforeMaterials: null,
      buildIndex: 0,
      tempPileVoxels: null,
      constructionTimer: 0,
      constructionTotal: 0,
    };
    if (!spec.enabledOnPlace) {
      // Initial-build timer comes from the spec — barracks 60 s, depot
      // 120 s, etc. Stored on the instance so a future restart can read
      // the original budget for percentage math.
      const seconds = spec.constructionSeconds ?? 30;
      b.constructionTimer = seconds;
      b.constructionTotal = seconds;
    }
    this.buildings.push(b);
    // Voxel-by-voxel build animation: snapshot every voxel the spec stamp
    // wrote into a per-building queue, sorted bottom-up with a deterministic
    // shuffle within each row, then carve them all to AIR. The upgrade tick
    // restores them one batch at a time so the structure visibly assembles.
    // Buildings placed with `enabledOnPlace` skip this step and stay fully
    // stamped.
    if (spec.enabledOnPlace) {
      // Bootstrap building (HQ / storage) — structure already stamped,
      // snapshot its voxels so HP can be derived from them immediately
      // after generation.
      const snap = snapshotBuildingStructure(world, b);
      b.structureVoxelIdx = snap.idx;
      b.healthRefVoxels = snap.idx.length;
      if (snap.aim) { b.aimWX = snap.aim.x; b.aimWY = snap.aim.y; b.aimWZ = snap.aim.z; }
    }
    // Non-bootstrap buildings: queue capture is deferred to the first tick
    // where `state === 'pending'` and no queue exists yet. The same lazy
    // path also handles tier-up upgrades, so the place flow does nothing
    // more for those.
    this.onBuildingPlaced?.(b);
    return b;
  }

  /**
   * Cost to deliver the building's currently-active upgrade. For the
   * one-shot `initial` upgrade we use `spec.upgradeCost` directly; for
   * keyed HQ upgrades the option's `baseCost` is scaled by the existing
   * tier in that track. Returns null when no upgrade is active.
   */
  upgradeCostFor(b: Building): { metals: number; wood: number } | null {
    if (!b.activeUpgradeId) return null;
    if (b.activeUpgradeId === 'initial') {
      const base = b.spec.upgradeCost;
      if (!base) return null;
      return { metals: base.metals, wood: base.wood };
    }
    const opt = upgradeOptionById(b.activeUpgradeId);
    if (!opt) return null;
    const tier = b.upgradeTracks[opt.id] ?? 0;
    const scale = 1 + tier * 0.75;
    return {
      metals: Math.round(opt.baseCost.metals * scale),
      wood:   Math.round(opt.baseCost.wood   * scale),
    };
  }

  /** Effective `maxTrucks` after applying the truck-upgrade track. */
  hqMaxTrucks(b: Building): number {
    const base = b.spec.maxTrucks ?? 5;
    const tier = b.upgradeTracks.trucks ?? 0;
    return base + tier * 5;
  }

  /** Effective build range for an HQ after applying the range-upgrade track. */
  hqBuildRange(b: Building): number {
    const base = b.spec.buildRangeMeters ?? 0;
    const tier = b.upgradeTracks.range ?? 0;
    return base * (1 + tier * 0.5);
  }

  /**
   * Seconds the building's currently-active upgrade is supposed to take.
   * For `initial` we read the spec; for HQ-track upgrades we read the
   * option's own `constructionSeconds`. Defaults to 30 s when neither has
   * a value defined.
   */
  constructionSecondsFor(b: Building): number {
    if (!b.activeUpgradeId) return 0;
    if (b.activeUpgradeId === 'initial') return b.spec.constructionSeconds ?? 30;
    const opt = upgradeOptionById(b.activeUpgradeId);
    return opt?.constructionSeconds ?? 30;
  }

  /**
   * Building HP is now derived from voxel destruction (perimeter wall
   * count), so this method is intentionally a no-op for buildings — the
   * projectile's `damageSphere` already chews voxels in parallel and the
   * per-tick `recomputeHpFromWalls` step picks up the result. Kept around
   * (and accepting `_impact`) so projectile dispatch can still call into
   * it without branching, in case future damage types want to skip the
   * voxel pipeline (e.g. an EMP that takes a building offline without
   * touching its walls).
   */
  applyImpactDamage(_impact: ProjectileImpact): void {
    // No-op. See doc comment above.
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
    // Buildings flagged for true deletion this tick (not just `destroyed`).
    // Currently only initial-cancel + pile-cleared buildings end up here.
    const buildingsToRemove: number[] = [];
    for (const b of this.buildings) {
      if (b.destroyed) continue;

      // HP from voxel survival: the building's snapshotted structural
      // voxels are the source of truth. We tolerate up to 30 % of them
      // being chewed away before the structure collapses — anything
      // destroyed beyond that flips `destroyed` and triggers a ring of
      // small explosions for visual impact + secondary terrain damage.
      // Skip pending buildings; they intentionally sit at hp = 0 until
      // construction finishes.
      if (b.upgradeState === 'enabled' && b.healthRefVoxels > 0) {
        const alive = countAliveStructureVoxels(world, b);
        const destroyedVoxels = Math.max(0, b.healthRefVoxels - alive);
        const fraction = b.spec.kind === 'hq'
          ? HQ_STRUCTURAL_DEATH_FRACTION
          : DEFAULT_STRUCTURAL_DEATH_FRACTION;
        const threshold = b.healthRefVoxels * fraction;
        const integrity = threshold > 0 ? Math.max(0, (threshold - destroyedVoxels) / threshold) : 0;
        b.hp = integrity * b.maxHp;
        if (integrity <= 0) {
          this.spawnDestructionExplosions(b);
          this.markDestroyed(b);
          continue;
        }
      }

      // Upgrade completion — check every tick: when the building's stockpile
      // of dropped resources meets the cost for its next tier, flip it to
      // enabled (or, for HQ, increment its tier). Resources sit in the
      // building during pending or paused states; once consumed they zero out.
      // Cancelled with a pending queue still on hand → roll the
      // already-stamped portion back to its pre-upgrade material so the
      // building visually reverts. Then drop the queue. Any leftover
      // resources sit in the upgradeStockpile and the recovery
      // dispatcher (started elsewhere) will ferry them home.
      if (b.upgradeState === 'cancelled' && b.buildVoxels) {
        rollbackBuildQueue(world, b);
        b.buildVoxels = null;
        b.buildMaterials = null;
        b.buildBeforeMaterials = null;
        b.buildIndex = 0;
      }
      // Cancel-time temp pile: spawn a visible cluster of resource voxels
      // on the lot once the rollback is done so the player can see what's
      // sitting on the ground. Clear the pile when a recovery truck has
      // drained the stockpile.
      if (b.upgradeState === 'cancelled') {
        const stash = b.upgradeStockpile.metals + b.upgradeStockpile.wood;
        if (stash > 0 && !b.tempPileVoxels) spawnUpgradeStockpilePile(world, b);
        else if (stash <= 0 && b.tempPileVoxels) clearUpgradeStockpilePile(world, b);
        // If this was a cancelled INITIAL build (never completed once —
        // `healthRefVoxels === 0`) and the recovery truck has drained the
        // pile, delete the building entirely. The lot is back to terrain
        // and the player can drop a fresh footprint anywhere.
        if (b.healthRefVoxels === 0 && stash <= 0 && !b.tempPileVoxels) {
          this.markDestroyed(b);
          buildingsToRemove.push(b.id);
          continue;
        }
      }
      // Any other transition out of cancelled (initial == 'enabled' from a
      // re-armed upgrade, etc.) should also drop the pile so the lot is
      // clean for the new build.
      if (b.upgradeState !== 'cancelled' && b.tempPileVoxels) {
        clearUpgradeStockpilePile(world, b);
      }

      if (b.upgradeState === 'pending') {
        // Lazy queue capture — runs on the first tick of any pending
        // upgrade (initial build OR a tier-up). Snapshots the AABB,
        // re-stamps at the target tier, and carves the diff so only the
        // new voxels animate in.
        if (!b.buildVoxels) {
          captureAndCarveBuildQueue(world, b);
        }
        const cost = this.upgradeCostFor(b);
        // Tick the wall-clock construction timer down regardless of resource
        // status. Time is one of two gates on completion (alongside
        // resources delivered) so a freshly-placed building sits at low
        // phases until both gates relax.
        if (b.constructionTimer > 0) {
          b.constructionTimer = Math.max(0, b.constructionTimer - dt);
        }
        if (cost) {
          // Voxel-by-voxel growth — combine time progress and resource
          // progress so the slowest of the two paces the visible build.
          // For a barracks placed in a base that already has 100m+wood in
          // the global pool, trucks deliver in seconds but the 60 s timer
          // still gates the structure so the player sees a deliberate
          // assembly animation. The advance step is a tiny linear walk
          // across the queue (a few voxels per frame for a 60-second
          // construction).
          const total = cost.metals + cost.wood;
          const onSite = Math.min(b.upgradeStockpile.metals, cost.metals)
                       + Math.min(b.upgradeStockpile.wood,   cost.wood);
          const resProgress = total > 0 ? onSite / total : 1;
          const timeProgress = b.constructionTotal > 0
            ? 1 - b.constructionTimer / b.constructionTotal : 1;
          const progress = Math.min(resProgress, timeProgress);
          if (b.buildVoxels) {
            const target = Math.floor(progress * b.buildVoxels.length);
            if (target > b.buildIndex) advanceBuildQueue(world, b, target);
          }
        }
        const timeReady = b.constructionTotal === 0 || b.constructionTimer <= 0;
        if (cost && timeReady && b.upgradeStockpile.metals >= cost.metals && b.upgradeStockpile.wood >= cost.wood) {
          b.upgradeStockpile.metals -= cost.metals;
          b.upgradeStockpile.wood   -= cost.wood;
          // Apply the option-specific effect, then bump the legacy `tier`
          // counter to whatever the highest individual track is now.
          if (b.activeUpgradeId) {
            const opt = upgradeOptionById(b.activeUpgradeId);
            opt?.apply(b);
            // `initial` is a one-shot that just enables the building —
            // doesn't accumulate as its own track in the HUD-visible sense.
            // Other upgrades populate `upgradeTracks` via their `apply`.
          }
          let maxTier = 0;
          for (const v of Object.values(b.upgradeTracks)) maxTier = Math.max(maxTier, v);
          b.tier = maxTier;
          // Final phase: re-stamp without carving so the building reads at
          // its full volume. HP snaps to maxHp now that the structure is
          // complete; during pending it sat at 0 to model the construction-
          // vulnerability window.
          // Flush any remaining queue entries so a building that finished
          // ahead of its time budget still ends up structurally complete.
          // Then drop the queue — it's no longer needed once enabled.
          if (b.buildVoxels) advanceBuildQueue(world, b, b.buildVoxels.length);
          b.spec.stamp(world, b.ox, b.oz, b.floorY);
          b.buildVoxels = null;
          b.buildMaterials = null;
          b.buildBeforeMaterials = null;
          b.buildIndex = 0;
          // Snapshot perimeter walls now that the structure is complete —
          // this is the baseline the runtime HP fraction is derived from.
          // For HQ tier upgrades the walls were already there; we re-snap
          // to pick up any walls that were carved out and rebuilt.
          const snap = snapshotBuildingStructure(world, b);
          b.structureVoxelIdx = snap.idx;
          b.healthRefVoxels = snap.idx.length;
          if (snap.aim) { b.aimWX = snap.aim.x; b.aimWY = snap.aim.y; b.aimWZ = snap.aim.z; }
          b.hp = b.maxHp;
          b.upgradeState = 'enabled';
          b.activeUpgradeId = null;
          b.constructionTimer = 0;
          b.constructionTotal = 0;
        }
      }

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
        // Pending farms don't grow crops yet — the field is being
        // stamped voxel by voxel and there's no soil for the worker
        // to tend. Tick crop progress only once the build completes
        // and the farm flips to 'enabled'.
        if (b.upgradeState !== 'enabled') continue;
        this.tickFarm(b, dt, world, units);
        continue;
      }

      // Storage has no timer; non-producers (power plant / refinery / tech lab,
      // turret, silo) carry an Infinity interval so the spawn loop never fires
      // for them.
      if (b.spec.kind === 'storage' || b.spec.productionInterval <= 0 || !isFinite(b.spec.productionInterval)) continue;
      // Disabled until upgraded — flush any queue so the building doesn't
      // accumulate orders while it can't act, and hold the timer. HQ stays
      // operational during its own (re-)upgrade so an in-progress tier-up
      // doesn't paralyse the rest of the base.
      if (b.upgradeState !== 'enabled' && b.spec.kind !== 'hq') {
        if (b.trainQueue.length > 0) b.trainQueue.length = 0;
        b.productionTimer = b.spec.productionInterval;
        continue;
      }
      // Producer buildings (barracks) only train units the player has
      // explicitly queued. With nothing queued, the timer is held at the full
      // interval so a freshly-queued kind still takes the configured time to
      // come out — but the building never auto-spawns a default cycle.
      if (b.spec.produces.length > 0 && b.trainQueue.length === 0) {
        b.productionTimer = b.spec.productionInterval;
        continue;
      }
      // With an HQ alive, building of a unit only starts after the resources
      // for that unit have arrived (suppliedUnits > 0). Until then, the
      // timer is held at full interval — production literally hasn't begun.
      // Without an HQ the logistics system is offline so production runs
      // free as before.
      if (hasLiveHQ && b.suppliedUnits <= 0) {
        b.productionTimer = b.spec.productionInterval;
        continue;
      }
      b.productionTimer -= dt;
      if (b.productionTimer > 0) continue;

      // Pop gate: if the queued unit wouldn't fit in the team's
      // population cap, freeze the production at 99% complete so the
      // unit is visibly "almost done" and resumes the instant the cap
      // frees up. Resetting to a full interval would force the player
      // (or AI) to redo the wait, which the user explicitly called out
      // as the wrong behaviour.
      const headKind = b.trainQueue[0];
      if (headKind && this.popHasRoom && !this.popHasRoom(headKind, b)) {
        b.productionTimer = b.spec.productionInterval * 0.01;
        continue;
      }

      b.productionTimer += b.spec.productionInterval;
      if (hasLiveHQ) b.suppliedUnits = Math.max(0, b.suppliedUnits - 1);

      // Liveness check: handled centrally at the top of the per-building
      // loop now (HP derived from `countAliveStructureVoxels`). No
      // per-section re-check here.

      // Barracks: spawn the next queued unit at the door. We've already
      // gated on `trainQueue.length > 0` above, so the queue can't be empty
      // here for a producer building.
      if (b.spec.produces.length > 0 && this.spawner && b.trainQueue.length > 0) {
        const pos = padSpawnPos(b);
        b.spawnSlot++;
        const kind = b.trainQueue.shift()!;
        const spawned = this.spawner(kind, pos.x, pos.y, pos.z, b);
        if (spawned) this.afterSpawn?.(spawned, b);
      }
    }
    // Splice out any building flagged for true deletion this tick. Done
    // after iteration so we don't mutate the array mid-loop. Each removal
    // already had `markDestroyed` called inside the loop body so the
    // building footprint mask has been cleared.
    if (buildingsToRemove.length > 0) {
      const removeSet = new Set(buildingsToRemove);
      for (let i = this.buildings.length - 1; i >= 0; i--) {
        if (removeSet.has(this.buildings[i]!.id)) this.buildings.splice(i, 1);
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
   * Per-frame farm tick. Crops grow on a 0..1 progress meter that PAUSES at
   * every 20 % barrier (0.2, 0.4, 0.6, 0.8) until a farmer steps onto the
   * field. Each farmer visit advances `harvestMilestone` by one and growth
   * resumes toward the next barrier. After the fourth advance (milestone == 4)
   * growth runs to 1.0 unimpeded; at 100 % `cropReady` flips and the crop
   * waits for a harvester. The farmer's role is "milestone unlock", not
   * yield boost — there's no tend-acceleration any more.
   *
   * Liveness check is folded into this tick on a coarse interval so a farm
   * whose fence has been levelled goes inert.
   */
  private tickFarm(b: Building, dt: number, world: VoxelWorld, units: UnitManager): void {
    void world;
    // Liveness is handled at the top of the per-building tick loop now;
    // farms just advance their crop progress here.
    b.productionTimer -= dt;
    if (b.productionTimer <= 0) {
      b.productionTimer += b.spec.productionInterval;
    }
    // Already ripe — wait for a harvester. collectFarm resets state.
    if (b.cropReady) return;

    // Detect a FARM-FOCUSED worker physically present in the farm box.
    // Miners / choppers / auto workers walking through don't count — only a
    // worker dedicated to farming advances the milestone. The farmer-id
    // channel is preserved for the renderer / UI so the visiting farmer
    // shows as the farm's tender.
    const wxStart = b.ox * NAV_CELL_VOXELS * VOXEL_SIZE;
    const wzStart = b.oz * NAV_CELL_VOXELS * VOXEL_SIZE;
    const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS * VOXEL_SIZE;
    const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS * VOXEL_SIZE;
    let farmerOnFarm = false;
    for (const u of units.units) {
      if (u.hp <= 0) continue;
      if (u.kind !== 'worker') continue;
      // Per game rule: only farm-focused workers can advance crop
      // milestones. Auto / mine / chop workers walking through the
      // plot are NOT farmers.
      if (u.workerFocus !== 'farm') continue;
      if (u.x < wxStart || u.x >= wxEnd) continue;
      if (u.z < wzStart || u.z >= wzEnd) continue;
      farmerOnFarm = true;
      b.farmerId = u.id;
      break;
    }
    if (!farmerOnFarm && b.farmerId !== null) {
      // Stale farmer reference: clear so the UI doesn't show a phantom owner.
      const farmer = lookupUnit(units, b.farmerId);
      if (!farmer || farmer.hp <= 0) b.farmerId = null;
    }

    // Up to 4 milestones (one per 20 %); after the 4th, growth runs to 1.0.
    const maxMilestones = 4;
    const nextMilestone = (b.harvestMilestone + 1) * 0.2;
    const atMilestone = b.harvestMilestone < maxMilestones && b.cropProgress >= nextMilestone;

    if (atMilestone) {
      // Paused — only advance when a farmer's actually on the plot.
      if (farmerOnFarm) {
        b.harvestMilestone++;
      }
      return;
    }

    // Between milestones (or past the last one) — grow at ambient rate. Clamp
    // the per-tick advance to the upcoming milestone so a large dt doesn't
    // skip over the pause band; the tick after this one will see
    // cropProgress == nextMilestone, flag atMilestone, and stall until a
    // farmer arrives.
    const ratePerSec = 1.0 / b.spec.productionInterval;
    const cap = b.harvestMilestone < maxMilestones ? nextMilestone : 1.0;
    let next = b.cropProgress + ratePerSec * dt;
    if (next > cap) next = cap;
    b.cropProgress = Math.min(1, next);
    if (b.cropProgress >= 1 && b.harvestMilestone >= maxMilestones) {
      b.cropReady = true;
    }
  }

  /**
   * Called by tickWorkers when a harvester reaches a ripe farm. Drops the
   * crop into the player's food counter, resets the farm to 0% so a fresh
   * growth cycle starts, and clears the claim so the same field can ripen
   * again.
   */
  collectFarm(b: Building, harvesterId: number): { foodGained: number } {
    if (!b.cropReady) return { foodGained: 0 };
    if (b.harvesterClaimId !== null && b.harvesterClaimId !== harvesterId) return { foodGained: 0 };
    // Bumped from 25 → 60 so the food economy actually keeps pace with
    // the harness's 1-unit/sec drought rule. With 2 farms producing
    // ~60 food per ~20 s cycle = ~6 food/s, the AI can sustain 1
    // soldier (40 food) every 7 s comfortably without running the
    // food bank dry between rounds of training.
    const food = 60;
    b.cropReady = false;
    b.cropProgress = 0;
    b.harvestMilestone = 0;
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
  nearestHQ(x: number, z: number, team?: BuildingTeam): Building | null {
    let best: Building | null = null;
    let bestD2 = Infinity;
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'hq') continue;
      if (team !== undefined && b.team !== team) continue;
      const dpos = doorWorldPos(b);
      const dx = dpos.x - x, dz = dpos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

  nearestStorage(x: number, z: number, team?: BuildingTeam): Building | null {
    let best: Building | null = null;
    let bestD2 = Infinity;
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'storage') continue;
      if (team !== undefined && b.team !== team) continue;
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
