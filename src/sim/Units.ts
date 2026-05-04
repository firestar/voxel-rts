import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_METERS } from '../path/SurfaceNav';
import { VOXEL_SIZE, WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { digSpeedMultiplier, groundSpeedMultiplier, M_WOOD, M_LEAF, M_GRASS } from '../voxel/Materials';
import {
  worldToVolumeCell, getBit, vnavIndex, VolumeNavBuffers,
} from '../path/VolumeNav';
import {
  TUNNELER_CUTTER_RADIUS, TUNNELER_CUTTER_FORWARD, TUNNELER_CUTTER_HEIGHT,
  WORM_CUTTER_RADIUS, WORM_CUTTER_FORWARD, WORM_CUTTER_HEIGHT,
  WORM_SEGMENT_COUNT, WORM_SEGMENT_SPACING,
} from '../render/UnitModels';
import { WeaponKind, WEAPONS, defaultWeaponFor } from './Weapons';
import { ProjectileKind } from './Projectiles';

export type UnitKind = 'soldier' | 'sniper' | 'gunner' | 'tank' | 'tunneler' | 'worm' | 'worker' | 'dozer' | 'rocket_truck' | 'supply_truck';

/**
 * Which resource type a worker should prioritise when idle. 'auto' = current
 * default (ore > wood > buried ore scan). Other values restrict the worker to
 * a single resource category so the player can field dedicated roles.
 */
export type WorkerFocus = 'auto' | 'mine' | 'chop' | 'farm';

/** Every unit kind in spawn-order. Useful for iterating over the catalog. */
export const UNIT_KINDS: UnitKind[] = [
  'soldier', 'sniper', 'gunner', 'tank', 'tunneler', 'worm', 'worker', 'dozer', 'rocket_truck', 'supply_truck',
];

/**
 * Faction the unit belongs to. The player owns 'player' units; 'enemy' units are
 * spawned via the sandbox (E key) and can be shot at without friendly-fire
 * gating. Units only avoid hitting same-team peers along the firing line.
 */
export type Team = 'player' | 'enemy';

/**
 * Combat behaviour. `defensive` (default) sits and waits for orders — the
 * unit only fires when the player issues a firingTarget. `aggressive` lets
 * the unit auto-engage the nearest enemy in weapon range; if its predicted
 * trajectory is blocked it routes toward the target until the line clears.
 */
export type CombatStance = 'aggressive' | 'defensive';

/**
 * Worker task — what the per-frame `tickWorkers` automation should do for
 * this worker right now. The state machine lives in `Workers.ts`; this is
 * just the shape it stores on each Unit.
 */
export type WorkerTask =
  | { kind: 'idle' }
  /** Worker chopping a wood voxel at the given world meters. */
  | { kind: 'chop'; wx: number; wy: number; wz: number }
  /** Worker mining a metal-ore voxel at the given world meters. */
  | { kind: 'mine'; wx: number; wy: number; wz: number }
  /** Player-issued plant action; once at target xz, calls SaplingManager.plant. */
  | { kind: 'plant'; wx: number; wz: number }
  /** Carrying a full load back to the nearest storage building. */
  | { kind: 'deliver' }
  /** Player-assigned dedicated farmer — tends a specific farm building so its
   *  crop progress advances faster than the slow ambient growth rate. */
  | { kind: 'farm'; buildingId: number }
  /** Worker is collecting a ripe crop from a specific farm — auto-picked
   *  in `assignNextHarvestTask` when a `cropReady` farm is in range. */
  | { kind: 'harvestFarm'; buildingId: number }
  /** Supply truck en route to a storage building to pick up resources.
   *  payload: the portion of the stockpile this truck is reserved to carry. */
  | { kind: 'truck_fetch'; storageId: number; payload: { metals: number; wood: number } }
  /** Supply truck returning to HQ carrying harvested resources. */
  | { kind: 'truck_deliver_hq'; payload: { metals: number; wood: number } }
  /** Supply truck en route to a production building carrying unit-build materials. */
  | { kind: 'truck_resupply'; buildingId: number; payload: { food: number; metals: number; wood: number } }
  /** Supply truck returning to HQ after delivering a resupply load. */
  | { kind: 'truck_return' };

/** Downward acceleration in m/s². Slightly snappier than real-world 9.81 — units feel
 *  "weighty" without dragging out the fall arc. Per-unit terminal velocity then sets
 *  how hard each kind eventually falls. */
const GRAVITY = 22;

interface UnitConfig {
  footprintRadius: number;
  widthMeters: number;
  maxStepVoxels: number;
  slopePenalty: number;
  /**
   * Half-extent in nav cells of the unit's body footprint, used by the per-unit
   * "is this terrain even enough under me" check. 0 disables the check (single cell).
   */
  bodyHalfCells: number;
  /**
   * Max allowed (max topY - min topY) in voxels across the footprint cells. If the
   * spread exceeds this, the cell is too rough for this unit and the path search
   * rejects it. Set to a very large number to disable.
   */
  bodyRoughnessVoxels: number;
  /** How fast the unit can rotate around Y, in radians per second. */
  turnRateRadPerSec: number;
  /** Hard cap on visual + path-plan pitch angle, radians. Volume A* rejects edges that
   *  would require a steeper climb/dive, and applyPathOrientation clamps the rendered
   *  body pitch to this value so the model never tips past it. */
  maxPitchRad: number;
  /** Unit's vertical extent in voxels (head/turret/cab clearance). The surface path
   *  search rejects cells whose `headroom` (air above topY) is less than this — keeps
   *  units out of cells where their head would clip a tree canopy or overhang. */
  heightVoxels: number;
  canDig: boolean;
  requiresGround: boolean;
  speed: number;
  speedDigging: number;
  hp: number;
  /** Unit mass in kilograms. Drives terminal-velocity scaling (heavier units settle
   *  to a higher cap because they shed more drag per kilogram). Also useful as a
   *  general weight reference for any later "tank crushes a soldier" interactions. */
  massKg: number;
  /** Magnitude of the terminal vertical velocity in m/s. Stored positive; falling
   *  velocity is clamped at -terminalFallSpeed. */
  terminalFallSpeed: number;
  /** Outer radius of the unit's cutter face, meters. 0 for non-diggers. */
  cutterRadius: number;
  /** Forward offset of the cutter face from the unit's origin, meters. 0 for non-diggers. */
  cutterForward: number;
  /** Cutter centre height above the unit's feet, meters. 0 for non-diggers. */
  cutterHeight: number;
  /** Number of trailing body segments (only used for chain-bodied diggers like the worm). */
  segmentCount: number;
  /** Target spacing between adjacent body segments along the chain, meters. */
  segmentSpacing: number;
  /** Half-width of the dozer blade strip in meters (perpendicular to forward). 0 for non-dozers. */
  bladeHalfWidthMeters: number;
  /** Forward distance from the unit origin to the blade leading edge, meters. 0 for non-dozers. */
  bladeForwardMeters: number;
  /** Length of the levelling strip behind the blade leading edge, meters. 0 for non-dozers. */
  bladeDepthMeters: number;
  /** Maximum carried-spoil capacity in voxel units (1 voxel = 0.125³ m³). 0 for non-earthmovers. */
  spoilCapacityVoxels: number;
  /**
   * Cap on the muzzle velocity (m/s) this unit's launcher can produce. The
   * weapon catalog's muzzleVelocity * velocityScale is clamped to this on
   * every shot, so a soldier's shoulder-fired weapon can't reach the same
   * range as a tank's main gun even if you somehow gave them the same round.
   * Set to 0 for non-combatant kinds (workers, dozer, diggers).
   */
  launcherMaxStrength: number;
}

export function unitConfig(kind: UnitKind): UnitConfig {
  switch (kind) {
    case 'soldier':
      // Single-cell footprint, so the body-roughness check is a no-op for soldiers.
      // maxStepVoxels = 6 voxels (0.75 m, ~hip-height) between adjacent cells —
      // soldiers can step onto a low ledge but anything taller reads as a cliff
      // and the path search routes around it. Stops infantry from dropping off
      // multi-meter cliffs or scaling sheer faces. The corner-cut exemption for
      // agile units (footprintRadius <= 1) is unchanged.
      return {
        footprintRadius: 1, widthMeters: 0.75,
        maxStepVoxels: 6, slopePenalty: 0.18,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        turnRateRadPerSec: 6.0,                  // ~340°/s, snappy infantry turn
        maxPitchRad: Math.PI / 2,                // soldiers are flexible — no real pitch cap
        heightVoxels: 14,                        // ~1.75 m head clearance
        canDig: false, requiresGround: true,
        speed: 4.5, speedDigging: 0,
        hp: 80,
        massKg: 80,                              // a person in full kit
        terminalFallSpeed: 28,                   // skydiver-ish cap
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        // Shoulder-fired weapons: caps the 7.62/5.56/RPG/9 mm muzzle speeds so
        // a soldier's effective range is short enough that a tank or turret
        // outranges them every time.
        launcherMaxStrength: 80,
      };
    case 'sniper':
      // Light infantry — no armour plate, slower than a rifleman due to the
      // heavier rifle and spotting kit, but the high launcherMaxStrength lets
      // the sniper weapon fire at full catalogue velocity. Low HP rewards
      // careful positioning; the player must protect them from contact.
      return {
        footprintRadius: 1, widthMeters: 0.75,
        maxStepVoxels: 6, slopePenalty: 0.18,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        turnRateRadPerSec: 5.0,                  // slower to turn while aiming
        maxPitchRad: Math.PI / 2,
        heightVoxels: 14,
        canDig: false, requiresGround: true,
        speed: 3.8, speedDigging: 0,
        hp: 55,                                  // fragile — no armour
        massKg: 85,
        terminalFallSpeed: 28,
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        launcherMaxStrength: 130,                // high — sniper bullet travels at full speed
      };
    case 'gunner':
      // Heavy infantry carrying a belt-fed machine gun. Slower than a rifle
      // soldier due to the weapon weight, but significantly more durable and
      // pours out far more rounds per second. Strong against infantry swarms;
      // weaker against armoured vehicles that can take the hits.
      return {
        footprintRadius: 1, widthMeters: 0.80,
        maxStepVoxels: 6, slopePenalty: 0.22,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        turnRateRadPerSec: 4.5,                  // heavier weapon slows pivoting
        maxPitchRad: Math.PI / 2,
        heightVoxels: 14,
        canDig: false, requiresGround: true,
        speed: 3.0, speedDigging: 0,
        hp: 130,                                 // armoured vest + more mass
        massKg: 110,
        terminalFallSpeed: 30,
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        launcherMaxStrength: 100,
      };
    case 'tank':
      // Tanks are restricted to small hills only — anything past a gentle grade
      // forces a detour around it.
      //   maxStepVoxels = 3 voxels (0.375 m climb, ~21° slope).
      //   bodyRoughnessVoxels = 4 (0.5 m residual from the plane fit) — uniform
      //     small grades still pass, but ridges and rocky bumps are rejected.
      //   slopePenalty = 0.45 — A* strongly prefers flat routes even when the
      //     steeper edge is technically within climb cap.
      return {
        footprintRadius: 2, widthMeters: 2.4,
        maxStepVoxels: 3, slopePenalty: 0.45,
        bodyHalfCells: 1, bodyRoughnessVoxels: 4,
        turnRateRadPerSec: 1.4,                  // ~80°/s — tank pivots are slow
        maxPitchRad: Math.PI / 6,                // 30° — pitched body cap matches the climb cap
        heightVoxels: 18,                        // ~2.25 m turret + antenna clearance
        canDig: false, requiresGround: true,
        speed: 3.5, speedDigging: 0,
        hp: 600,
        massKg: 50_000,                          // ~50 t — main battle tank
        terminalFallSpeed: 45,                   // heavier shell, drags less per kg
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        // Tank cannon: high muzzle velocity, comfortably above the tank_shell
        // catalog speed so the cap doesn't bite normal play but does bound
        // any future "swap weapon onto a tank" experiments.
        launcherMaxStrength: 130,
      };
    case 'tunneler':
      // 5x5 cells (5 m x 5 m); 9 voxels (≈1.1 m) residual tolerance — generous because
      // the cutter levels its own bench as it goes.
      // Ground-locked like the tank: it can carve through anything but it can't levitate
      // through open air. Tunnels it digs leave a solid floor underneath, so this still
      // lets the unit walk along its own freshly-bored shafts.
      // maxStepVoxels = 14 voxels (1.75 m climb ≈ 60° slope) — wider machine than the
      // tank, but with the cutter pulling it up steep grades.
      return {
        footprintRadius: 2, widthMeters: 3.6,
        maxStepVoxels: 14, slopePenalty: 0.15,
        bodyHalfCells: 2, bodyRoughnessVoxels: 9,
        turnRateRadPerSec: 0.7,                  // ~40°/s — heavy machine pivots slowly
        maxPitchRad: 40 * Math.PI / 180,         // 40° — capped dig angle in either direction
        heightVoxels: 22,                        // ~2.75 m for the cab + exhaust stack
        canDig: true, requiresGround: true,
        speed: 1.6, speedDigging: 1.2,
        hp: 320,
        massKg: 150_000,                         // ~150 t — full TBM with cutter head
        terminalFallSpeed: 55,                   // dense + low drag per kg → falls hardest
        cutterRadius: TUNNELER_CUTTER_RADIUS,
        cutterForward: TUNNELER_CUTTER_FORWARD,
        cutterHeight: TUNNELER_CUTTER_HEIGHT,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        launcherMaxStrength: 0,
      };
    case 'worker':
      // Civilian worker. Single-cell footprint, soldier-class agility on
      // gentle hills (so they can scramble between an ore deposit and a depot
      // without getting stuck on shallow benches), but slower than a soldier
      // since they're carrying tools / payload. canDig stays false — workers
      // mine voxels via direct damageSphere calls in tickWorkers, not by
      // pathing through solid. maxStepVoxels matches the soldier so workers
      // can't trespass cliffs the rest of infantry can't.
      return {
        footprintRadius: 1, widthMeters: 0.65,
        maxStepVoxels: 6, slopePenalty: 0.20,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        turnRateRadPerSec: 5.0,
        maxPitchRad: Math.PI / 2,
        heightVoxels: 14,
        canDig: false, requiresGround: true,
        speed: 3.2, speedDigging: 0,
        hp: 60,
        massKg: 75,
        terminalFallSpeed: 28,
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        launcherMaxStrength: 0,
      };
    case 'worm':
      // Smaller, articulated tunneler. Head (the controlled body) carries a narrower
      // cutter than the TBM — ~1.7 m diameter shaft vs the tunneler's 3.4 m. Body
      // segments trail behind on a chain, each one settling under its own gravity to
      // the local ground (or tunnel floor underground). The chain is a visual /
      // collision-free trail; only the head participates in pathing and carving, so
      // routing reuses the existing tunneler volume-A* code path unchanged.
      return {
        footprintRadius: 1, widthMeters: 1.8,
        maxStepVoxels: 16, slopePenalty: 0.12,
        bodyHalfCells: 1, bodyRoughnessVoxels: 12,
        turnRateRadPerSec: 1.4,
        maxPitchRad: 55 * Math.PI / 180,         // worm is more flexible than the rigid TBM
        heightVoxels: 12,
        canDig: true, requiresGround: true,
        speed: 2.4, speedDigging: 1.6,           // faster + nimbler than the heavy TBM
        hp: 220,
        massKg: 60_000,                          // ~60 t over the whole chain
        terminalFallSpeed: 48,
        cutterRadius: WORM_CUTTER_RADIUS,
        cutterForward: WORM_CUTTER_FORWARD,
        cutterHeight: WORM_CUTTER_HEIGHT,
        segmentCount: WORM_SEGMENT_COUNT,
        segmentSpacing: WORM_SEGMENT_SPACING,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        launcherMaxStrength: 0,
      };
    case 'dozer':
      // Tracked bulldozer. Walks the surface like a tank, but each frame the strip
      // ahead of the blade is levelled to `levelTargetY`. Cut volume goes into the
      // unit's spoilLoad up to spoilCapacityVoxels; fill draws from the same load.
      // Excess (when the load saturates) is dropped behind the unit as a M_DIRT
      // spoil mound.
      //   Footprint mirrors the tank (2-cell radius, ~2.6 m wide chassis).
      //   Speed is somewhat slower than the tank — heavier vehicle pushing earth.
      return {
        footprintRadius: 2, widthMeters: 2.6,
        maxStepVoxels: 4, slopePenalty: 0.30,
        bodyHalfCells: 1, bodyRoughnessVoxels: 5,
        turnRateRadPerSec: 1.2,                  // ~70°/s
        maxPitchRad: Math.PI / 6,                // 30° — same chassis cap as tank
        heightVoxels: 16,                        // ~2 m
        canDig: false, requiresGround: true,
        speed: 2.8, speedDigging: 0,
        hp: 260,
        massKg: 40_000,                          // 40 t
        terminalFallSpeed: 42,
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        // Blade is wider than the chassis (1.6 m half-width = 3.2 m total) so the
        // levelled strip is a comfortable two-lane width. Depth covers the
        // expected per-frame travel (~5 cm at 60 fps + headroom) so the strip
        // overlaps cleanly between frames.
        bladeHalfWidthMeters: 1.6,
        bladeForwardMeters: 1.6,
        bladeDepthMeters: 0.6,
        // ~8 m³ of carried dirt at a 0.125 m voxel — comfortably more than a
        // single hill-flatten run produces, so the dozer rarely runs dry mid-job.
        spoilCapacityVoxels: 4096,
        launcherMaxStrength: 0,
      };
    case 'rocket_truck':
      // Rocket-launcher platform. Wheeled, can't dig, fairly nimble — carries
      // a yawing rocket pod on the deck. The
      // pod aims independently of the hull — the hull keeps doing path follow,
      // the pod swings around to face the firing target. Ammunition is
      // configured via the unit's `weapon` field (cluster_pod by default;
      // spawn opts can override to rocket_pod for a heavy single-warhead variant).
      return {
        footprintRadius: 2, widthMeters: 2.5,
        maxStepVoxels: 3, slopePenalty: 0.45,
        bodyHalfCells: 1, bodyRoughnessVoxels: 4,
        turnRateRadPerSec: 1.2,
        maxPitchRad: Math.PI / 6,
        heightVoxels: 18,
        canDig: false, requiresGround: true,
        speed: 3.6, speedDigging: 0,
        hp: 240,
        massKg: 28_000,
        terminalFallSpeed: 42,
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        // Rocket truck pod: rockets are heavy / slow, so the cap sits above
        // the catalog rocket muzzle speed but well below tank-cannon levels.
        launcherMaxStrength: 70,
      };
    case 'supply_truck':
      // Unarmed logistics flatbed. Lighter and faster than combat trucks —
      // its job is to shuttle resources between storage depots, the HQ, and
      // production buildings as fast as the road allows.
      return {
        footprintRadius: 2, widthMeters: 2.0,
        maxStepVoxels: 8, slopePenalty: 0.35,
        bodyHalfCells: 1, bodyRoughnessVoxels: 4,
        turnRateRadPerSec: 1.8,
        maxPitchRad: Math.PI / 6,
        heightVoxels: 14,
        canDig: false, requiresGround: true,
        speed: 5.0, speedDigging: 0,
        hp: 80,
        massKg: 10_000,
        terminalFallSpeed: 38,
        cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
        segmentCount: 0, segmentSpacing: 0,
        bladeHalfWidthMeters: 0, bladeForwardMeters: 0, bladeDepthMeters: 0,
        spoilCapacityVoxels: 0,
        launcherMaxStrength: 0,
      };
  }
}

export interface Unit {
  id: number;
  kind: UnitKind;
  footprintRadius: number;
  widthMeters: number;
  maxStepVoxels: number;
  slopePenalty: number;
  bodyHalfCells: number;
  bodyRoughnessVoxels: number;
  /** Max angular velocity in rad/s. */
  turnRateRadPerSec: number;
  /** Max climb / dive pitch in radians. */
  maxPitchRad: number;
  /** Vertical extent of the unit in voxels — used to gate cells with too-low headroom. */
  heightVoxels: number;
  canDig: boolean;
  requiresGround: boolean;
  x: number; y: number; z: number;
  heading: number;
  pitch: number; roll: number;
  speed: number;
  speedDigging: number;
  path: { x: number; y: number; z: number }[];
  hp: number;
  selected: boolean;
  carveCooldown: number;
  distanceWalked: number;
  lastTrackDistance: number;
  /** Frames the unit has been blocked by collision. We pause motion but don't drop
   *  the path — gravity / terrain edits may resolve the block. */
  blockedFrames: number;
  /**
   * Latched flag the harness reads each frame to know this unit wants its route
   * recomputed. Set when `blockedFrames` first crosses BLOCKED_REPATH_FRAMES so
   * a stationary peer that arrived after the path was planned can be routed
   * around. The harness consumes the flag (clears it) and issues a fresh path
   * request to the unit's current destination.
   */
  needsRepath: boolean;
  /** Vertical velocity in m/s. Negative = falling. Reset to 0 on landing. */
  vy: number;
  /** Mass in kg — see UnitConfig.massKg. */
  massKg: number;
  /** Magnitude of terminal fall velocity in m/s — see UnitConfig.terminalFallSpeed. */
  terminalFallSpeed: number;
  /** Cutter geometry. Zero for non-diggers. */
  cutterRadius: number;
  cutterForward: number;
  cutterHeight: number;
  /**
   * Worker's current automation task. 'idle' means tickWorkers will pick a
   * new task next frame (find nearest tree / ore). Non-workers always carry
   * { kind: 'idle' }.
   */
  task: WorkerTask;
  /**
   * What the worker is currently carrying. Capacity is enforced by the
   * automation tick (CARRY_CAP). Non-workers leave this at zero.
   */
  carrying: { wood: number; metals: number; food: number };
  /**
   * Seconds the worker has been on the current non-idle task without making
   * forward progress (no carry change, no path advance, no voxel chip).
   * Reset to 0 on any progress; when it crosses the stall threshold the
   * worker drops the task and releases any TaskBoard claim.
   */
  taskStallTimer: number;
  /** Seconds the unit has had an active path but made no measurable forward progress.
   *  When it crosses STUCK_TELEPORT_SECS the unit is nudged to a random clear nearby cell. */
  stuckTimer: number;
  /** Remaining cooldown before the next expensive voxel scan (findNearestExposed).
   *  Counts down only while the worker is idle; reset to SCAN_COOLDOWN_SECS after each scan. */
  workerScanCooldown: number;
  /** Remaining cooldown before the worker can post another routeWorker request.
   *  Prevents flooding the pathWorker queue with 60 identical requests per second
   *  while waiting for an async path to arrive. */
  workerRouteCooldown: number;
  /**
   * Cached previous progress signal — `path.length`, `carrying.wood`,
   * `carrying.metals`, and `miningTicks` packed into a single key. Used by
   * stall detection to tell when something tangible advanced.
   */
  taskProgressKey: number;
  /**
   * Incremented each frame a worker successfully deals damage to a metal
   * cluster. Included in the stall-detection key so the worker doesn't time
   * out between swing intervals.
   */
  miningTicks: number;
  /** Accumulated dt toward the next mine-swing against a cluster voxel. */
  mineSwingTimer: number;
  /** ID of the MetalCluster this worker has claimed a slot on, or -1 if none. */
  claimedClusterId: number;
  /** Index into cluster.workerSlots, or -1 when no slot is held. */
  claimedSlotIndex: number;
  /**
   * TaskBoard order id this worker has claimed, or 0 when none. Cleared on
   * task completion, on stall, and when the worker dies — `releaseDead`
   * sweeps both the unit list and the board through this id.
   */
  claimedOrderId: number;
  /**
   * Resource focus for this worker. Restricts which task types
   * `assignNextHarvestTask` will auto-pick. 'auto' = default priority order
   * (ore > wood > buried ore scan). Non-workers carry 'auto' but it has no
   * effect on them since they never enter the harvester state machine.
   */
  workerFocus: WorkerFocus;
  /**
   * Trailing body segments for chain-bodied diggers (worm). Empty for everyone else.
   * Element 0 is the segment closest to the head; each subsequent segment trails
   * further back. Each segment is placed at an exact arc-length offset along the
   * head's recorded breadcrumb trail (`pathHistory`), so every link follows the
   * exact same path the lead car took — no corner-cutting, no per-segment gravity.
   */
  segments: WormSegment[];
  /**
   * Breadcrumb trail of past head positions, ordered most-recent-first. A new entry
   * is unshifted whenever the head moves more than `PATH_HISTORY_STEP_MIN` from the
   * latest breadcrumb. Used by chain-bodied diggers to place each segment at an
   * exact cumulative distance behind the head — segments trace the head's actual
   * 3D path (including dive/climb in dug tunnels), not just the head's current
   * position.
   *
   * Pre-seeded at spawn time so segments have a valid trail from frame 0.
   * Empty for non-chain units (no need to allocate the buffer).
   */
  pathHistory: { x: number; y: number; z: number }[];
  /**
   * Earth-moving state.
   * `spoilLoad` — voxels currently carried (0..spoilCapacity).
   * `spoilCapacity` — max load.
   * `levelTargetY` — voxel-space Y the dozer levels every column it sweeps to.
   *   Set by Game.handleRelease from the click's voxel y; cleared on path drop.
   */
  spoilLoad: number;
  spoilCapacity: number;
  levelTargetY: number | null;
  /** Cached blade dimensions, copied from the config so the renderer + sim share them. */
  bladeHalfWidthMeters: number;
  bladeForwardMeters: number;
  bladeDepthMeters: number;
  /**
   * Weapon currently mounted on this unit, or null if the unit is unarmed
   * (workers, tunneler, dozer, worm). The default is filled from
   * `defaultWeaponFor(kind)` at spawn time and can be overridden via
   * `UnitManager.spawn` opts.
   */
  weapon: WeaponKind | null;
  /** Seconds until the weapon is ready to fire again. 0 = ready. */
  fireCooldown: number;
  /**
   * Pending firing job. Set by the player's RMB-release. The weapon-tick
   * (ticked by Game) slews the appropriate part (hull or turret) to face the
   * target, fires when the alignment is within `aimToleranceRad`, then
   * clears the field.
   */
  firingTarget: FiringTarget | null;
  /**
   * Independent turret yaw in world-space radians. Same convention as
   * `heading`: yaw=0 means turret forward = -Z. For non-turreted units the
   * value still tracks `heading` so callers can read it uniformly without
   * branching on kind.
   */
  turretYaw: number;
  /**
   * Active burst — when a weapon's `shotsPerBurst > 1`, the first trigger pull
   * sets `burstShotsRemaining` and `burstShotTimer`. Subsequent shots fire on
   * `burstInterval` until the burst empties.
   */
  burstShotsRemaining: number;
  burstShotTimer: number;
  /**
   * Faction this unit fights for. Defaults to 'player'; the sandbox 'E'
   * hotkey spawns 'enemy' units. Friendly-fire gating in the weapon tick
   * skips shots whose line of fire passes through a same-team body.
   */
  team: Team;
  /**
   * Cap on the actual muzzle velocity (m/s) this unit's launcher applies to
   * a fired projectile. Mirrors `UnitConfig.launcherMaxStrength`; copied at
   * spawn time so per-instance buffs/debuffs can mutate it later without
   * touching the catalog. Zero for unarmed units (the weapon tick already
   * skips them, but the field is still set for uniform read paths).
   */
  launcherMaxStrength: number;
  /**
   * Combat stance. Aggressive units auto-acquire enemies in range; defensive
   * units wait for the player to assign a firingTarget. Default is
   * 'defensive' so existing players' habits stay unchanged. Workers /
   * diggers / unarmed kinds carry the field but it has no effect on them.
   */
  stance: CombatStance;
  /**
   * Auto-engage retry timer. The aggressive-stance pipeline checks for a
   * target on this cadence (rather than every frame) so a unit whose nearest
   * enemy is unreachable doesn't hammer the predictor. Decremented in the
   * tick; set to a positive value when an attempt fails.
   */
  autoEngageCooldown: number;
  /**
   * Re-arm timer for the evasion pass. Set to a positive value the moment a
   * unit dives perpendicular out of an incoming projectile's path so it
   * doesn't keep juking every single frame; ticks down at real time. The
   * evade pass skips units whose timer is non-zero.
   */
  evadeCooldown: number;
}

/**
 * What the player has asked this unit to shoot at. World-space target xyz +
 * the projectile kind to launch (the weapon's catalog default unless an
 * upstream caller wants to override).
 */
export interface FiringTarget {
  x: number; y: number; z: number;
  /** Optional override for the projectile kind; defaults to the weapon's configured projectile. */
  projectileOverride?: ProjectileKind;
}

/** Minimum head movement between recorded breadcrumbs, meters. Smaller values
 *  give finer curve resolution at the cost of a longer history; 0.15 m keeps the
 *  buffer to ~60 entries even for the longest chain. */
const PATH_HISTORY_STEP_MIN = 0.15;

export interface WormSegment {
  x: number; y: number; z: number;
  vy: number;
  /** Heading + pitch derived from the link to the segment in front, for rendering. */
  heading: number;
  pitch: number;
}

export interface CarveRequest {
  kind: 'carve';
  /** Center of the carve volume in world meters. */
  x: number; y: number; z: number;
  /** Carve radius (perpendicular extent for cylinders, full radius for spheres) in meters. */
  radiusMeters: number;
  /**
   * Optional oriented-cylinder carve. When set, the carve volume is a cylinder centered at
   * (x, y, z), extending +/- `halfLengthMeters` along the unit-vector axis (axisX, Y, Z),
   * with `radiusMeters` perpendicular extent. When unset, the carve is a sphere of radius
   * `radiusMeters` centered at (x, y, z).
   */
  axisX?: number; axisY?: number; axisZ?: number;
  halfLengthMeters?: number;
  /**
   * Optional hard floor in world meters. Voxels below this Y are not damaged. The
   * tunneler uses this to cap its cutter at its own body bottom (u.y) so the
   * disc-shaped cylinder doesn't carve out the floor underneath.
   */
  floorMeters?: number;
  unit: Unit;
}

/**
 * Strip-level request emitted by the dozer once per surface tick. The handler iterates
 * voxel columns covered by the oriented rectangle and applies `editColumnToY` to each.
 *
 * Geometry: rectangle centered at (x, z) in world meters, with forward unit-vector
 * (fx, fz), half-length `halfDepthMeters` along forward, half-width `halfWidthMeters`
 * across forward. `targetVoxY` is the voxel-space Y the dozer is levelling to.
 */
export interface LevelRequest {
  kind: 'level';
  unit: Unit;
  x: number; z: number;
  fx: number; fz: number;
  halfDepthMeters: number;
  halfWidthMeters: number;
  targetVoxY: number;
}

/** Single-voxel grass-to-dirt trample emitted by surface units as they walk. */
export interface TrampleRequest {
  kind: 'trample';
  vx: number; vy: number; vz: number;
  unitKind: UnitKind;
}

export type WorldEditRequest = CarveRequest | LevelRequest | TrampleRequest;


export class UnitManager {
  units: Unit[] = [];
  private nextId = 1;

  spawn(
    kind: UnitKind,
    x: number, y: number, z: number,
    opts?: { weapon?: WeaponKind | null; team?: Team; stance?: CombatStance },
  ): Unit {
    const cfg = unitConfig(kind);
    const segments: WormSegment[] = [];
    for (let i = 0; i < cfg.segmentCount; i++) {
      // Initial layout: segments stretched out behind the head along +Z (heading = 0
      // points toward -Z so the chain trails to +Z). The first frame's tickWormChain
      // re-anchors them onto the pre-seeded path history.
      segments.push({
        x, y,
        z: z + (i + 1) * cfg.segmentSpacing,
        vy: 0,
        heading: 0,
        pitch: 0,
      });
    }
    // Pre-seed the head's path history with breadcrumbs extending back along +Z (the
    // initial trail direction), spaced PATH_HISTORY_STEP_MIN apart and covering more
    // than the full chain length. That way the very first tickWormChain call already
    // has a path to follow — no special case for "history shorter than chain".
    const pathHistory: { x: number; y: number; z: number }[] = [];
    if (cfg.segmentCount > 0) {
      const totalDist = (cfg.segmentCount + 1) * cfg.segmentSpacing + 1.0;
      const steps = Math.ceil(totalDist / PATH_HISTORY_STEP_MIN);
      for (let i = 1; i <= steps; i++) {
        pathHistory.push({ x, y, z: z + i * PATH_HISTORY_STEP_MIN });
      }
    }
    const u: Unit = {
      id: this.nextId++,
      kind,
      footprintRadius: cfg.footprintRadius,
      widthMeters: cfg.widthMeters,
      maxStepVoxels: cfg.maxStepVoxels,
      slopePenalty: cfg.slopePenalty,
      bodyHalfCells: cfg.bodyHalfCells,
      bodyRoughnessVoxels: cfg.bodyRoughnessVoxels,
      turnRateRadPerSec: cfg.turnRateRadPerSec,
      maxPitchRad: cfg.maxPitchRad,
      heightVoxels: cfg.heightVoxels,
      canDig: cfg.canDig,
      requiresGround: cfg.requiresGround,
      x, y, z,
      heading: 0,
      pitch: 0, roll: 0,
      speed: cfg.speed,
      speedDigging: cfg.speedDigging,
      path: [],
      hp: cfg.hp,
      selected: false,
      carveCooldown: 0,
      distanceWalked: 0,
      lastTrackDistance: 0,
      blockedFrames: 0,
      needsRepath: false,
      vy: 0,
      massKg: cfg.massKg,
      terminalFallSpeed: cfg.terminalFallSpeed,
      cutterRadius: cfg.cutterRadius,
      cutterForward: cfg.cutterForward,
      cutterHeight: cfg.cutterHeight,
      task: { kind: 'idle' },
      carrying: { wood: 0, metals: 0, food: 0 },
      taskStallTimer: 0,
      taskProgressKey: 0,
      miningTicks: 0,
      stuckTimer: 0,
      workerScanCooldown: Math.random() * 0.5,
      workerRouteCooldown: 0,
      mineSwingTimer: 0,
      claimedClusterId: -1,
      claimedSlotIndex: -1,
      claimedOrderId: 0,
      workerFocus: 'auto',
      segments,
      pathHistory,
      spoilLoad: 0,
      spoilCapacity: cfg.spoilCapacityVoxels,
      levelTargetY: null,
      bladeHalfWidthMeters: cfg.bladeHalfWidthMeters,
      bladeForwardMeters: cfg.bladeForwardMeters,
      bladeDepthMeters: cfg.bladeDepthMeters,
      // Default weapon by unit kind (rifle for soldier, cannon for tank, …);
      // explicit `opts.weapon` lets the caller swap it out, including passing
      // null to spawn the unit unarmed.
      weapon: opts?.weapon !== undefined ? opts.weapon : defaultWeaponFor(kind),
      fireCooldown: 0,
      firingTarget: null,
      turretYaw: 0,
      burstShotsRemaining: 0,
      burstShotTimer: 0,
      team: opts?.team ?? 'player',
      launcherMaxStrength: cfg.launcherMaxStrength,
      stance: opts?.stance ?? 'defensive',
      autoEngageCooldown: 0,
      evadeCooldown: 0,
    };
    this.units.push(u);
    return u;
  }

  setPath(unit: Unit, waypoints: { x: number; y: number; z: number }[]): void {
    if (waypoints.length === 0) {
      unit.path = [];
      unit.carveCooldown = 0;
      unit.blockedFrames = 0;
      unit.needsRepath = false;
      return;
    }
    let i = 0;
    if (unit.path.length > 0) {
      const fx = -Math.sin(unit.heading);
      const fz = -Math.cos(unit.heading);
      while (i < waypoints.length - 1) {
        const w = waypoints[i]!;
        const dx = w.x - unit.x;
        const dz = w.z - unit.z;
        const distSq = dx * dx + dz * dz;
        const ahead = dx * fx + dz * fz;
        if (distSq > 0.6 * 0.6 && ahead > -0.15) break;
        i++;
      }
    } else {
      const w = waypoints[0]!;
      const dx = w.x - unit.x;
      const dy = w.y - unit.y;
      const dz = w.z - unit.z;
      if (dx * dx + dy * dy + dz * dz < 0.5 * 0.5) i = 1;
    }
    if (i >= waypoints.length) i = waypoints.length - 1;
    unit.path = waypoints.slice(i);
    unit.carveCooldown = 0;
    unit.blockedFrames = 0;
    unit.needsRepath = false;
  }

  tick(
    dt: number,
    nav: SurfaceNavBuffers,
    vnav: VolumeNavBuffers,
    voxels: Uint8Array,
    worldEdit: (req: WorldEditRequest) => void,
  ): void {
    this.lastSurfaceNav = nav;
    this.lastVoxels = voxels;
    for (const u of this.units) {
      const underground = isUnderground(u, nav);
      // Tree shove — if a (non-digger) unit's centre lands inside a
      // treeBlocked nav cell (canopy/trunk), push it horizontally toward the
      // nearest passable neighbour each tick until it's clear and request a
      // fresh path. Without this, soldiers spawned under or jostled into a
      // tree wedge against the trunk forever.
      if (!u.canDig && !underground) this.pushOutOfTree(u, nav, dt);
      if (u.path.length === 0) {
        u.stuckTimer = 0;
        // Idle: surface-follow only when actually on the surface; underground tunnelers
        // (and any unit caught in a cave) just relax pitch/roll instead of snapping Y up.
        if (!underground) {
          sampleSurfaceFollow(u, nav, this.lastVoxels, dt);
        } else {
          relaxOrientation(u, dt);
        }
        // Dozer: stop levelling once the path completes.
        if (u.kind === 'dozer' && u.levelTargetY !== null) {
          u.levelTargetY = null;
        }
        continue;
      }
      const tgt = u.path[0]!;
      // Pick the surface tick whenever the unit is on the surface and the next waypoint
      // is also on the surface. The previous heuristic — "switch to volume motion if
      // |dy| > 0.3" — fired for every uphill step on natural hills (waypoints sit at
      // each cell's topY, so a 1 m hillside produces dy = 1 m). tickVolume's clear
      // branch then ran a volumePassable() check whose volume cell *contains* the
      // surface voxel, so it always read as solid → blockedFrames ticked up →
      // path cleared after 6 frames. The result was paths planned correctly but
      // canceled mid-stride on any climb.
      const tgtSurfaceY = surfaceWorldY(nav, tgt.x, tgt.z);
      const tgtTolerance = u.canDig ? 0.0 : 0.5;
      const tgtUnderground = tgt.y < tgtSurfaceY - tgtTolerance;
      const using3D = u.canDig || underground || tgtUnderground;
      const prevDist = u.distanceWalked;
      if (using3D) this.tickVolume(u, dt, nav, vnav, worldEdit);
      else this.tickSurface(u, dt, nav, worldEdit);

      if (u.distanceWalked - prevDist < 0.001) {
        u.stuckTimer += dt;
        if (u.stuckTimer >= STUCK_TELEPORT_SECS) {
          if (u.kind === 'worker') {
            this.tryUnstuck(u, nav);
          } else {
            // Non-worker units don't teleport — just request a reroute so the
            // harness can find a path around whatever is blocking them.
            u.needsRepath = true;
          }
          u.stuckTimer = 0;
        }
      } else {
        u.stuckTimer = 0;
      }
    }
    // Body-segment chain: runs after every unit has had its head step this frame, so
    // segments always trail the post-tick head position. Only worms (segmentCount > 0)
    // do anything here. Each tick we (a) update the head's breadcrumb trail, then
    // (b) place every segment at an exact arc-length offset along that trail.
    for (const u of this.units) {
      if (u.segments.length === 0) continue;
      recordPathBreadcrumb(u);
      tickWormChain(u);
    }

    this.separateOverlappingUnits(nav);
  }

  /**
   * Surface motion. The path search already enforces blocked + climb-step gating, and the
   * smoother only emits line segments whose adjacent topY deltas are within the unit's
   * climb limit (plus a small slack for fp >= 2). So we trust the path here — there's no
   * runtime "is this cell solid in the volume grid" check, because a surface unit's Y
   * always sits in a volume cell that contains the top voxel itself, which would always
   * read as solid. That false-positive is what was freezing soldiers and tanks.
   */
  private tickSurface(u: Unit, dt: number, nav: SurfaceNavBuffers, worldEdit: (req: WorldEditRequest) => void): void {
    const tgt = u.path[0]!;
    const dx = tgt.x - u.x;
    const dz = tgt.z - u.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) { sampleSurfaceFollow(u, nav, this.lastVoxels, dt); return; }

    // Slew the heading toward the path direction at the unit's turn rate. Until the unit
    // is roughly facing forward, forward speed is reduced (cosine of misalignment), so a
    // tank pivots in place before driving and a soldier sweeps around briskly.
    // Supply trucks and workers are non-combat wheeled/foot units that should never stop
    // for a turn — they move at full speed while slewing their heading.
    const targetHeading = Math.atan2(-dx, -dz);
    const angDiff = wrapAngle(targetHeading - u.heading);
    const turnStep = u.turnRateRadPerSec * dt;
    u.heading += clamp(angDiff, -turnStep, turnStep);

    const noAlignPenalty = u.kind === 'supply_truck' || u.kind === 'worker';
    const align = noAlignPenalty ? 1.0 : Math.max(0, Math.cos(Math.abs(angDiff)));
    // Surface material under the unit modulates speed — mud bogs vehicles down, paths
    // give a small bonus. Sample the cell-level top material; for soldiers this barely
    // matters but is consistent with the tank/tunneler.
    const cx0 = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
    const cz0 = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
    const groundMat = nav.material[navIndex(cx0, cz0)]!;
    const groundMult = groundSpeedMultiplier(groundMat);
    const step = u.speed * align * groundMult * dt;

    let nx = u.x, nz = u.z;
    let snap = false;
    if (step >= d) {
      nx = tgt.x; nz = tgt.z;
      snap = true;
    } else if (step > 0) {
      const inv = 1 / d;
      nx = u.x + dx * inv * step;
      nz = u.z + dz * inv * step;
    }
    // Moving-peer avoidance: laterally deflect both units when they are about
    // to overlap, so moving pairs steer around each other instead of phasing
    // through or stopping.
    ({ x: nx, z: nz } = this.applyMovingPeerLateralOffset(u, nx, nz));

    // Unit-vs-unit collision: if the next foothold overlaps a *stationary* unit,
    // hold position this frame. We first try to nudge the offending peer
    // perpendicular to our motion so it can shuffle off our line; the
    // existing repath / give-up timers stay as fallbacks if the sidestep
    // can't be placed (walls on both flanks, peer is busy with a task,
    // etc).
    let moved = 0;
    const blocker = this.findCollisionBlocker(u, nx, nz);
    if (blocker !== null) {
      this.tryNudgeAside(blocker, u, nav);
      u.blockedFrames++;
      // Latch the repath request the first frame we cross the threshold —
      // strict equality so we set the flag exactly once per stuck stretch.
      // The harness will clear it (and reset blockedFrames via setPath) when
      // a fresh route is in hand.
      if (u.blockedFrames === BLOCKED_REPATH_FRAMES) u.needsRepath = true;
      if (u.blockedFrames > BLOCKED_GIVE_UP_FRAMES) {
        // Retry: reset the counter and request a fresh route rather than giving up.
        u.blockedFrames = 0;
        u.needsRepath = true;
      }
    } else {
      u.x = nx; u.z = nz;
      moved = snap ? d : step;
      if (snap) u.path.shift();
      u.blockedFrames = 0;
    }
    sampleSurfaceFollow(u, nav, this.lastVoxels, dt);
    u.distanceWalked += moved;
    // Trample grass to dirt under the unit's feet as it walks.
    if (moved > 1e-4) {
      const tvx = Math.floor(u.x / VOXEL_SIZE);
      const tvy = Math.floor(u.y / VOXEL_SIZE) - 1;
      const tvz = Math.floor(u.z / VOXEL_SIZE);
      if (tvy >= 0 && this.lastVoxels[worldIndex(tvx, tvy, tvz)] === M_GRASS) {
        worldEdit({ kind: 'trample', vx: tvx, vy: tvy, vz: tvz, unitKind: u.kind });
      }
    }
    // Dozer: each frame the unit is moving, emit a level request covering the
    // strip ahead of the blade. The handler iterates voxel columns inside the
    // oriented rectangle and edits each to the unit's target Y. Levelling only
    // runs while the dozer is actually advancing — idle dozers don't grind.
    // If the path just emptied this tick, clear the dozer's level target so a
    // later unrelated move doesn't accidentally re-level using a stale Y.
    if (u.kind === 'dozer' && u.path.length === 0) {
      u.levelTargetY = null;
    }
    if (u.kind === 'dozer' && u.levelTargetY !== null && moved > 1e-4) {
      // Forward unit-vector matches the surface motion convention: heading 0
      // points toward -Z, so forward = (-sin h, -cos h).
      const fx = -Math.sin(u.heading);
      const fz = -Math.cos(u.heading);
      const halfDepth = u.bladeDepthMeters * 0.5;
      const centerX = u.x + fx * (u.bladeForwardMeters - halfDepth);
      const centerZ = u.z + fz * (u.bladeForwardMeters - halfDepth);
      worldEdit({
        kind: 'level',
        unit: u,
        x: centerX, z: centerZ,
        fx, fz,
        halfDepthMeters: halfDepth,
        halfWidthMeters: u.bladeHalfWidthMeters,
        targetVoxY: u.levelTargetY,
      });
    }
  }

  private tickVolume(
    u: Unit,
    dt: number,
    nav: SurfaceNavBuffers,
    vnav: VolumeNavBuffers,
    worldEdit: (req: WorldEditRequest) => void,
  ): void {
    const tgt = u.path[0]!;
    const dx = tgt.x - u.x;
    const dy = tgt.y - u.y;
    const dz = tgt.z - u.z;
    const d = Math.hypot(dx, dy, dz);

    const cell = worldToVolumeCell(tgt.x, tgt.y, tgt.z);
    const ci = vnavIndex(cell.cx, cell.cy, cell.cz);
    const stillSolid = getBit(vnav.solid, ci) === 1;

    if (stillSolid && u.canDig) {
      // Always carve at the blade — we're explicitly digging through solid here, so
      // bypass the surface engagement gate. Forward motion is gated below on the
      // cleared volume so the body never moves through unbroken voxels.
      this.maybeCarveAtCutter(u, dt, dx, dy, dz, d, worldEdit, true);
      // Per-material dig speed. Sample the live voxel sitting at (or just past) the
      // blade face — that's the material the cutter is currently chewing through. A
      // multiplier of 0.3 in stone vs 1.0 in dirt makes the tunneler feel like an
      // actual TBM rather than a uniform cell-eater. Air at the cutter (e.g. cutter
      // is poking into a chamber) reads as 1.0 so the unit can coast through.
      const inv = d > 1e-3 ? 1 / d : 0;
      const fx = dx * inv, fy = dy * inv, fz = dz * inv;
      const cutterMat = sampleCutterMaterial(this.lastVoxels, u, fx, fy, fz);
      const speedMult = digSpeedMultiplier(cutterMat);
      const step = u.speedDigging * speedMult * dt;
      const clearAhead = inv === 0
        ? true
        : voxelSlabClear(this.lastVoxels, u, u.x, u.y, u.z, fx, fy, fz, step);
      if (clearAhead && d > 0.001 && step > 0) {
        u.x += fx * step;
        u.y += fy * step;
        u.z += fz * step;
        u.distanceWalked += step;
      }
      // The cutter face is grinding into solid — that contact holds the unit, so any
      // residual fall velocity from a previous mid-air arc is killed here.
      u.vy = 0;
      applyPathOrientation(u, dx, dy, dz, dt);
      return;
    }

    // Voxel collision is intentionally off — we trust the planned path and
    // advance toward the waypoint regardless of whether the next cell happens
    // to be solid. We DO honour unit-vs-unit collision so a moving unit
    // doesn't walk through a parked one; if blocked, hold position this
    // frame and bail out of the path after a stall threshold.
    const step = u.speed * dt;
    let nextX: number, nextY: number, nextZ: number, snapping = false;
    if (d <= step) {
      nextX = tgt.x; nextY = tgt.y; nextZ = tgt.z;
      snapping = true;
    } else {
      const inv = 1 / d;
      nextX = u.x + dx * inv * step;
      nextY = u.y + dy * inv * step;
      nextZ = u.z + dz * inv * step;
    }
    ({ x: nextX, z: nextZ } = this.applyMovingPeerLateralOffset(u, nextX, nextZ));
    const volumeBlocker = this.findCollisionBlocker(u, nextX, nextZ);
    if (volumeBlocker !== null) {
      this.tryNudgeAside(volumeBlocker, u, nav);
      u.blockedFrames++;
      // Same one-shot latch as tickSurface — the harness sees the flag, asks
      // for a fresh route, and the resulting setPath() resets blockedFrames.
      if (u.blockedFrames === BLOCKED_REPATH_FRAMES) u.needsRepath = true;
      if (u.blockedFrames > BLOCKED_GIVE_UP_FRAMES) {
        u.blockedFrames = 0;
        u.needsRepath = true;
      }
    } else {
      u.x = nextX; u.y = nextY; u.z = nextZ;
      u.distanceWalked += snapping ? d : step;
      if (snapping) {
        u.path.shift();
        u.carveCooldown = 0;
      }
      u.blockedFrames = 0;
    }
    applyPathOrientation(u, dx, dy, dz, dt);
    // Vertical positioning. Three regimes:
    //   1. Above the local surface heading to a surface target — surface nav drives the
    //      snap (handles hills). We skip this when the destination is underground so a
    //      tunneler drilling downward isn't yanked back to the surface mid-dig.
    //   2. Underground in air with solid below (a tunnel floor) — snap to that floor so
    //      the tunneler walks the floor instead of floating at cell center.
    //   3. Underground in air with no solid within reach — leave the path Y alone (the
    //      unit is genuinely in the middle of an open volume, e.g. mid-jump into a cave).
    const tgtSurfaceY = surfaceWorldY(nav, tgt.x, tgt.z);
    const tgtTolerance = u.canDig ? 0.0 : 0.5;
    const tgtIsUnderground = tgt.y < tgtSurfaceY - tgtTolerance;
    if (!isUnderground(u, nav) && !tgtIsUnderground) {
      sampleSurfaceFollow(u, nav, this.lastVoxels, dt);
    } else {
      // Probe deep enough that a fast-falling unit (tunneler at terminal velocity)
      // still sees the floor it's about to hit this frame.
      const probeDepth = Math.max(3.0, -u.vy * dt + 1.0);
      const floorY = findFloorBelow(this.lastVoxels, u.x, u.y + 0.4, u.z, probeDepth);
      if (floorY !== null && floorY >= u.y) {
        // Floor is at or above feet — climb the step (e.g. up onto a tunnel ledge).
        u.y += (floorY - u.y) * Math.min(1, dt * 12);
        u.vy = 0;
      } else {
        // No floor under our feet within reach (or it's below us): accelerate downward
        // under gravity and clamp at the unit's terminal velocity. When a floor is
        // present below, land on it crisply.
        u.vy = Math.max(-u.terminalFallSpeed, u.vy - GRAVITY * dt);
        u.y += u.vy * dt;
        if (floorY !== null && u.y < floorY) {
          u.y = floorY;
          u.vy = 0;
        }
      }
    }
    this.maybeCarveAtCutter(u, dt, dx, dy, dz, d, worldEdit);
  }

  private maybeCarveAtCutter(
    u: Unit, _dt: number,
    dx: number, dy: number, dz: number, d: number,
    worldEdit: (req: WorldEditRequest) => void,
    forceCarve = false,
  ): void {
    if (!u.canDig) return;
    if (d < 1e-3) return;
    const inv = 1 / d;
    const fx = dx * inv, fy = dy * inv, fz = dz * inv;

    const VOXEL = 0.125;
    // Total cylinder depth = 2 * halfLength = 4 voxels along the forward axis.
    // Perpendicular extent = cutter radius + 3 voxels of clearance on every side.
    const halfLength = VOXEL * 2;                          // 4 voxels of total depth
    const radius = u.cutterRadius + VOXEL * 3;
    const centerForward = u.cutterForward + halfLength;
    const cutterX = u.x + fx * centerForward;
    const cutterY = u.y + u.cutterHeight + fy * centerForward;
    const cutterZ = u.z + fz * centerForward;

    // Engagement gate, only applied when the caller hasn't explicitly opted into carving.
    // Without this, a surface tunneler driving on flat ground would chew the grass with
    // its disc-shaped cutter (the disc dips below the ground because the cutter sits
    // 1.10 m above the feet but the disc has 1.83 m radius). The solid branch passes
    // forceCarve=true because we already know the destination cell is in solid material.
    if (!forceCarve) {
      const surfaceAtUnit = surfaceWorldY(this.lastSurfaceNav, u.x, u.z);
      const surfaceAtCutter = surfaceWorldY(this.lastSurfaceNav, cutterX, cutterZ);
      const unitUnderground = u.y < surfaceAtUnit - 0.4;
      const cutterInSolid = cutterY < surfaceAtCutter - 0.3;
      if (!unitUnderground && !cutterInSolid) return;
    }

    worldEdit({
      kind: 'carve',
      x: cutterX, y: cutterY, z: cutterZ,
      axisX: fx, axisY: fy, axisZ: fz,
      halfLengthMeters: halfLength,
      radiusMeters: radius,
      // Don't carve below the unit's body bottom — keeps the cutter from eating
      // the floor underneath the tunneler and dropping it into its own hole.
      // Exception: when the dig direction is downward, eating the floor is the
      // whole point, so drop the guard and let the cutter chew straight down.
      floorMeters: fy < 0 ? -Infinity : u.y,
      unit: u,
    });
  }

  /**
   * Returns the stationary peer whose body cylinder a hypothetical step from
   * `u` to (px, pz) would intrude on, or null when nothing is in the way.
   * Used by the surface + volume ticks to (a) decide whether to advance and
   * (b) target a sidestep nudge at whichever peer is actually blocking. The
   * collision rules:
   *
   *  - Only stationary peers (empty path) block — two moving units phase
   *    through each other so a column of marching units doesn't jam on
   *    minor desync between their per-frame steps.
   *  - If `u` is *already* overlapping a peer (e.g. multi-spawn stack at a
   *    barracks door), the step is allowed as long as it increases
   *    separation, so stuck units can shuffle apart instead of jamming
   *    forever.
   *  - Vertical separation > 2 m exempts the pair (one unit on a bridge,
   *    another walking under it).
   */
  private findCollisionBlocker(u: Unit, px: number, pz: number): Unit | null {
    const r1 = unitCollisionRadius(u);
    for (const other of this.units) {
      if (other === u) continue;
      if (other.hp <= 0) continue;
      if (other.path.length > 0) continue;
      if (Math.abs(other.y - u.y) > 2.0) continue;
      // Supply trucks clip through same-team units — they're automated and must
      // always make progress; friendly nudge-aside loops cause stuck routes.
      if (u.kind === 'supply_truck' && other.team === u.team) continue;
      const r2 = unitCollisionRadius(other);
      const minDist2 = (r1 + r2) * (r1 + r2);
      const ndx = other.x - px;
      const ndz = other.z - pz;
      const newD2 = ndx * ndx + ndz * ndz;
      if (newD2 >= minDist2) continue;
      const cdx = other.x - u.x;
      const cdz = other.z - u.z;
      const curD2 = cdx * cdx + cdz * cdz;
      if (curD2 < minDist2 && newD2 > curD2) continue; // already overlapping, separating
      return other;
    }
    return null;
  }

  /**
   * Push `blocker` one body-width perpendicular to `mover`'s travel direction so
   * the moving unit can pass on its next tick. The sidestep is implemented as a
   * one-waypoint path on the blocker — it then walks via the normal surface
   * tick, which means peer-vs-peer collision still applies if multiple units
   * are crowded together. Returns true when a sidestep was assigned.
   *
   * Skipped when the blocker is busy doing something the player would not want
   * silently abandoned: firing on a target, executing a worker task, or driving
   * a digger (tunneler/worm). Skipped when neither perpendicular cell is a
   * valid foothold for the blocker's kind (cliff, low headroom, etc.).
   */
  /**
   * When two moving units are about to overlap, deflect u's proposed step
   * laterally so both units steer around each other rather than phasing
   * through or stopping. The deflection is perpendicular to the separation
   * vector, capped to avoid visible jitter. Each unit applies this when its
   * own tick runs, so the net result is that they diverge to opposite sides.
   */
  private applyMovingPeerLateralOffset(u: Unit, nx: number, nz: number): { x: number; z: number } {
    const r1 = unitCollisionRadius(u);
    let ax = nx, az = nz;
    for (const other of this.units) {
      if (other === u || other.hp <= 0) continue;
      if (other.path.length === 0) continue; // only moving peers
      if (Math.abs(other.y - u.y) > 2.0) continue;
      // Supply trucks pass through same-team movers without deflection.
      if (u.kind === 'supply_truck' && other.team === u.team) continue;
      const r2 = unitCollisionRadius(other);
      const minDist = r1 + r2;
      const sdx = other.x - ax;
      const sdz = other.z - az;
      const dist2 = sdx * sdx + sdz * sdz;
      if (dist2 >= minDist * minDist) continue; // not overlapping at proposed position

      // Only push when this step makes us CLOSER than we are right now.
      // If the step is already moving us apart, the avoidance has done its
      // job — don't push again or we'll orbit each other.
      const curDx = other.x - u.x;
      const curDz = other.z - u.z;
      const curDist2 = curDx * curDx + curDz * curDz;
      if (dist2 >= curDist2) continue; // already separating — leave it alone

      const dist = Math.sqrt(dist2);
      if (dist < 1e-6) { ax += r1 * 0.3; continue; }
      // Perpendicular to the sep vector: (-sepZ, sepX).
      // Both units independently use this rule so they diverge to opposite sides.
      const sepX = sdx / dist;
      const sepZ = sdz / dist;
      const pushAmt = Math.min(0.15, minDist - dist + 0.05);
      ax += -sepZ * pushAmt;
      az +=  sepX * pushAmt;
    }
    return { x: ax, z: az };
  }

  private tryNudgeAside(blocker: Unit, mover: Unit, nav: SurfaceNavBuffers): boolean {
    if (blocker.path.length > 0) return false;
    if (blocker.firingTarget !== null) return false;
    if (blocker.task.kind !== 'idle') return false;
    if (blocker.canDig) return false;

    const tgt = mover.path[0];
    if (!tgt) return false;
    let dx = tgt.x - mover.x;
    let dz = tgt.z - mover.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1e-6) return false;
    const inv = 1 / Math.sqrt(d2);
    dx *= inv; dz *= inv;

    // Sidestep enough to clear the sum of body radii, plus slack so the
    // next-frame collision check sees daylight between the two cylinders.
    const dist = unitCollisionRadius(mover) + unitCollisionRadius(blocker) + 0.6;

    // Two perpendicular candidates. Prefer the side the blocker is already
    // biased toward so it doesn't have to cross the mover's line of travel.
    const offX = blocker.x - mover.x;
    const offZ = blocker.z - mover.z;
    const sideDot = offX * -dz + offZ * dx;
    const candidates: Array<{ x: number; z: number }> = sideDot >= 0
      ? [
          { x: blocker.x + -dz * dist, z: blocker.z +  dx * dist },
          { x: blocker.x +  dz * dist, z: blocker.z + -dx * dist },
        ]
      : [
          { x: blocker.x +  dz * dist, z: blocker.z + -dx * dist },
          { x: blocker.x + -dz * dist, z: blocker.z +  dx * dist },
        ];

    for (const c of candidates) {
      if (!sidestepCellOk(nav, blocker, c.x, c.z)) continue;
      const y = surfaceWorldY(nav, c.x, c.z);
      blocker.path = [{ x: c.x, y, z: c.z }];
      blocker.blockedFrames = 0;
      blocker.needsRepath = false;
      blocker.carveCooldown = 0;
      return true;
    }
    return false;
  }
  /**
   * Teleport a stuck unit to a random unblocked cell within ~2 body-radii. Tries
   * eight evenly-spaced angles starting from a random offset and picks the first
   * unoccupied, nav-passable position. Does nothing for diggers (they carve their
   * own way out). After the teleport the unit requests a fresh route from the new
   * position.
   */
  /**
   * Push a unit out of a tree-occupied nav cell. Trees are stamped as
   * standalone columns of M_WOOD / M_LEAF — when a unit's centre overlaps
   * one (spawn + jostle, terrain regen) the surface tick wedges them
   * against the trunk because every direction back into the cell is also
   * "in the tree". This loop:
   *   1. checks whether the unit's current nav cell has treeBlocked = 1;
   *   2. if so, walks to the nearest non-treeBlocked neighbour and pushes
   *      the unit's (x, z) toward that neighbour at ~3 m/s;
   *   3. flags needsRepath so the harness routes a fresh path now that the
   *      unit's start cell is no longer tree-locked.
   * No-op when the unit is already out of trees.
   */
  private pushOutOfTree(u: Unit, nav: SurfaceNavBuffers, dt: number): void {
    const cx = Math.floor(u.x / NAV_CELL_METERS);
    const cz = Math.floor(u.z / NAV_CELL_METERS);
    if (cx < 0 || cz < 0 || cx >= NAV_W || cz >= NAV_H) return;
    if (nav.treeBlocked[navIndex(cx, cz)] !== 1) return;
    // Find the nearest non-treeBlocked neighbour cell (BFS up to 4 cells).
    let bestDx = 0, bestDz = 0, bestD2 = Infinity;
    for (let radius = 1; radius <= 4 && bestD2 === Infinity; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
          const i = navIndex(nx, nz);
          if (nav.treeBlocked[i] !== 0) continue;
          if (nav.blocked[i] !== 0) continue;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; bestDx = dx; bestDz = dz; }
        }
      }
    }
    if (bestD2 === Infinity) return; // surrounded — nothing we can do
    // Direction from cell centre toward the nearest free cell.
    const dirX = bestDx === 0 ? 0 : Math.sign(bestDx);
    const dirZ = bestDz === 0 ? 0 : Math.sign(bestDz);
    const len = Math.hypot(dirX, dirZ) || 1;
    const speed = 3.0; // m/s — fast enough to escape in <1 s
    u.x += (dirX / len) * speed * dt;
    u.z += (dirZ / len) * speed * dt;
    u.needsRepath = true;
  }

  private tryUnstuck(u: Unit, nav: SurfaceNavBuffers): void {
    if (u.canDig) return;
    const r = Math.max(unitCollisionRadius(u) * 2.5, 1.2);
    const startAngle = Math.random() * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const angle = startAngle + i * (Math.PI * 2 / 8);
      const cx = u.x + Math.cos(angle) * r;
      const cz = u.z + Math.sin(angle) * r;
      if (!separatePosOk(nav, cx, cz)) continue;
      let blocked = false;
      for (const other of this.units) {
        if (other === u || other.hp <= 0) continue;
        if (Math.hypot(other.x - cx, other.z - cz) < unitCollisionRadius(u) + unitCollisionRadius(other)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      u.x = cx;
      u.z = cz;
      u.y = surfaceWorldY(nav, cx, cz);
      u.blockedFrames = 0;
      u.needsRepath = true;
      return;
    }
  }

  /**
   * Post-move separation pass. Any two units whose body cylinders overlap after
   * the tick are pushed apart along the horizontal separation vector. Each unit
   * moves half the penetration depth unless its side of the push lands in a
   * nav-blocked cell or outside world bounds — in that case the other unit
   * absorbs the full push. Surface units are kept above the terrain after the
   * move. Underground diggers skip the surface clamp (their Y is managed by the
   * volume tick).
   */
  private separateOverlappingUnits(nav: SurfaceNavBuffers): void {
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        if (b.hp <= 0) continue;
        if (Math.abs(a.y - b.y) > 2.0) continue;
        const ra = unitCollisionRadius(a);
        const rb = unitCollisionRadius(b);
        const minDist = ra + rb;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minDist * minDist) continue;

        const d = Math.sqrt(d2);
        const overlap = minDist - d;
        // Normalised separation vector from a toward b.
        let nx: number, nz: number;
        if (d < 1e-4) {
          // Coincident units: use a stable fallback direction derived from IDs.
          const angle = ((a.id * 2654435761) >>> 0) * (2 * Math.PI / 0x100000000);
          nx = Math.cos(angle); nz = Math.sin(angle);
        } else {
          nx = dx / d; nz = dz / d;
        }

        // Try to push each unit half the overlap; fall back to full push on the
        // other unit when a half-step lands in terrain.
        const half = overlap * 0.5;
        const aOk = separatePosOk(nav, a.x - nx * half, a.z - nz * half);
        const bOk = separatePosOk(nav, b.x + nx * half, b.z + nz * half);

        if (aOk && bOk) {
          a.x -= nx * half; a.z -= nz * half;
          b.x += nx * half; b.z += nz * half;
        } else if (aOk) {
          a.x -= nx * overlap; a.z -= nz * overlap;
        } else if (bOk) {
          b.x += nx * overlap; b.z += nz * overlap;
        }
        // Snap surface units to terrain so a push toward a rise doesn't bury
        // their feet. Diggers handle their own vertical positioning in tickVolume.
        if (aOk && !a.canDig) {
          const sy = surfaceWorldY(nav, a.x, a.z);
          if (a.y < sy) { a.y = sy; a.vy = 0; }
        }
        if (bOk && !b.canDig) {
          const sy = surfaceWorldY(nav, b.x, b.z);
          if (b.y < sy) { b.y = sy; b.vy = 0; }
        }
      }
    }
  }

  private lastSurfaceNav!: SurfaceNavBuffers;
  private lastVoxels!: Uint8Array;
}

/**
 * Body-cylinder radius used for unit-vs-unit collision. Slightly less than
 * `widthMeters * 0.5` so two units in adjacent formation slots can stand
 * shoulder to shoulder without the planner refusing to seat them.
 */
export function unitCollisionRadius(u: Unit): number {
  return Math.max(0.3, u.widthMeters * 0.45);
}

/** Frames a unit can be blocked by a peer before its path is dropped. */
const BLOCKED_GIVE_UP_FRAMES = 240;
/** Seconds with an active path but zero measurable movement before the unit is teleported to a clear nearby cell. */
const STUCK_TELEPORT_SECS = 2.0;
/**
 * Frames a unit must stay collision-blocked before it asks the harness to
 * recompute its route around the offending peer. Smaller than the give-up
 * timer so the unit retries pathing well before it abandons the move; the
 * give-up timer remains the absolute fallback if even the new route fails.
 */
export const BLOCKED_REPATH_FRAMES = 30;

/**
 * True when the unit is below the terrain surface.
 * Surface units get 0.5 m of tolerance so brief ledge-crossing doesn't trigger the
 * underground branch. Diggers (tunneler/worm) use a strict threshold of 0 — any
 * depth below the terrain counts as underground, preventing surface-follow from
 * yanking a freshly-submerged digger back up when it's only 1-3 voxels deep.
 */
function isUnderground(u: Unit, nav: SurfaceNavBuffers): boolean {
  const tolerance = u.canDig ? 0.0 : 0.5;
  return u.y < surfaceWorldY(nav, u.x, u.z) - tolerance;
}

function applyPathOrientation(u: Unit, dx: number, dy: number, dz: number, dt: number): void {
  const horiz = Math.hypot(dx, dz);
  if (horiz > 1e-4) {
    const targetHeading = Math.atan2(-dx, -dz);
    const angDiff = wrapAngle(targetHeading - u.heading);
    const turnStep = u.turnRateRadPerSec * dt;
    u.heading += clamp(angDiff, -turnStep, turnStep);
  }
  const rawPitch = Math.atan2(-dy, Math.max(horiz, 1e-4));
  // Cap pitch to the unit's limit so the body never tips past it — even if the path
  // happens to require a steeper local slope, the model stays at the cap and the
  // motion uses the un-clamped path Y under the hood.
  const targetPitch = clamp(rawPitch, -u.maxPitchRad, u.maxPitchRad);
  const k = Math.min(1, dt * 8);
  u.pitch += (targetPitch - u.pitch) * k;
  u.roll  += (0           - u.roll ) * k;
}

/**
 * Read the voxel at the cutter face — used to pick the per-material dig speed.
 *
 * We sample the voxel sitting at TUNNELER_CUTTER_FORWARD + 1 voxel ahead of the unit
 * along its current motion direction, at the cutter's vertical offset. That's the
 * voxel the cutter is actively grinding, so its material drives how fast we advance.
 * Out-of-bounds reads as AIR.
 */
function sampleCutterMaterial(
  voxels: Uint8Array,
  u: Unit,
  fx: number, fy: number, fz: number,
): number {
  const aheadM = u.cutterForward + 0.125; // 1 voxel past the blade face
  const wx = u.x + fx * aheadM;
  const wy = u.y + u.cutterHeight + fy * aheadM;
  const wz = u.z + fz * aheadM;
  const vx = Math.floor(wx / VOXEL_SIZE);
  const vy = Math.floor(wy / VOXEL_SIZE);
  const vz = Math.floor(wz / VOXEL_SIZE);
  if (vx < 0 || vy < 0 || vz < 0 || vx >= WORLD_X || vy >= WORLD_Y || vz >= WORLD_Z) return AIR;
  return voxels[worldIndex(vx, vy, vz)]!;
}

/**
 * Walk the voxel column at (wx, wz) downward from wy until a solid voxel is found.
 * Returns the world-space Y of that voxel's top face, or null if no solid was hit
 * within `maxDownM` meters (or we walked off the world).
 *
 * Used to snap an underground tunneler onto the floor of whatever tunnel it's in,
 * instead of floating at the cell-center Y the path waypoints carry.
 */
function findFloorBelow(
  voxels: Uint8Array,
  wx: number, wy: number, wz: number,
  maxDownM: number,
): number | null {
  const vx = Math.floor(wx / VOXEL_SIZE);
  const vz = Math.floor(wz / VOXEL_SIZE);
  if (vx < 0 || vx >= WORLD_X || vz < 0 || vz >= WORLD_Z) return null;
  const vyStart = Math.floor(wy / VOXEL_SIZE);
  const maxDown = Math.ceil(maxDownM / VOXEL_SIZE);
  for (let dy = 0; dy <= maxDown; dy++) {
    const vy = vyStart - dy;
    if (vy < 0) return null;
    if (voxels[worldIndex(vx, vy, vz)] !== AIR) {
      return (vy + 1) * VOXEL_SIZE; // top of this solid voxel, meters
    }
  }
  return null;
}

/**
 * Probe a thin slab of voxels right past the cutter face. Returns true when every sample
 * is air, i.e. the carve has actually opened the volume the body would advance into.
 *
 * `(fx, fy, fz)` is the unit-vector forward direction; `step` is how far the unit wants to
 * move this frame. We sample a 4x4 grid of voxels in the plane perpendicular to forward,
 * sized to the cutter, located at `TUNNELER_CUTTER_FORWARD + step / 2` in front of the
 * unit's origin so the slab covers the volume between the blade face and where the body
 * would be after the move.
 */
function voxelSlabClear(
  voxels: Uint8Array,
  u: Unit,
  ux: number, uy: number, uz: number,
  fx: number, fy: number, fz: number,
  step: number,
): boolean {
  // Build any unit vector orthogonal to forward in the horizontal plane, then a third
  // perpendicular to both. Together they span the disc we want to sample.
  let rx = -fz, ry = 0, rz = fx;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
  rx /= rl; ry /= rl; rz /= rl;
  // up = forward × right
  const ux2 = fy * rz - fz * ry;
  const uy2 = fz * rx - fx * rz;
  const uz2 = fx * ry - fy * rx;

  const aheadDist = u.cutterForward + step * 0.5;
  const cx = ux + fx * aheadDist;
  const cy = uy + u.cutterHeight + fy * aheadDist;
  const cz = uz + fz * aheadDist;
  // Sample a 4x4 grid covering the cutter cross-section (radius + 1 voxel margin).
  const SAMPLES = 4;
  const r = u.cutterRadius + VOXEL_SIZE;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / (SAMPLES - 1)) * 2 - 1; // -1..+1
    for (let j = 0; j < SAMPLES; j++) {
      const b = (j / (SAMPLES - 1)) * 2 - 1;
      // Inside the cutter disc only.
      if (a * a + b * b > 1) continue;
      const px = cx + (rx * a + ux2 * b) * r;
      const py = cy + (ry * a + uy2 * b) * r;
      const pz = cz + (rz * a + uz2 * b) * r;
      const vx = Math.floor(px / VOXEL_SIZE);
      const vy = Math.floor(py / VOXEL_SIZE);
      const vz = Math.floor(pz / VOXEL_SIZE);
      if (vx < 0 || vy < 0 || vz < 0 || vx >= WORLD_X || vy >= WORLD_Y || vz >= WORLD_Z) continue;
      if (voxels[worldIndex(vx, vy, vz)] !== AIR) return false;
    }
  }
  return true;
}

/** Shortest signed angle in (-π, π]. */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Idle underground / aerial: ease pitch & roll to neutral so the unit doesn't sit askew. */
function relaxOrientation(u: Unit, dt: number): void {
  // Pitch eases noticeably faster than before (was dt*4) so when a tunneler reaches its
  // destination it stops nose-down within a fraction of a second instead of holding the
  // last dig pitch for ~1 s. Roll eases at the original rate.
  const kPitch = Math.min(1, dt * 10);
  const kRoll  = Math.min(1, dt * 4);
  u.pitch += (0 - u.pitch) * kPitch;
  u.roll  += (0 - u.roll)  * kRoll;
}

/**
 * Per-cell footing check used by tryNudgeAside. The blocker is going to walk
 * one short hop — we don't run a full A* for it, so we just gate on the
 * properties that the path search would otherwise reject:
 *
 *  - In-bounds and unblocked nav cell (no tree, building, cliff column).
 *  - Enough air over the topY for the unit's height.
 *  - Climb between the blocker's current cell and the candidate cell stays
 *    within its maxStepVoxels so a tank doesn't sidestep off a ledge.
 */
/**
 * Quick nav check for the separation pass: the candidate position must be in
 * bounds and not in a hard-blocked nav cell (wall, tree, etc.). We don't gate
 * on headroom or climb-step here — the separation push is small and the full
 * terrain snap runs immediately after.
 */
function separatePosOk(nav: SurfaceNavBuffers, wx: number, wz: number): boolean {
  const cx = Math.floor(wx / NAV_CELL_METERS);
  const cz = Math.floor(wz / NAV_CELL_METERS);
  if (cx < 0 || cz < 0 || cx >= NAV_W || cz >= NAV_H) return false;
  return nav.blocked[navIndex(cx, cz)] === 0;
}

function sidestepCellOk(nav: SurfaceNavBuffers, u: Unit, wx: number, wz: number): boolean {
  const cx = Math.floor(wx / NAV_CELL_METERS);
  const cz = Math.floor(wz / NAV_CELL_METERS);
  if (cx < 0 || cz < 0 || cx >= NAV_W || cz >= NAV_H) return false;
  const i = navIndex(cx, cz);
  if (nav.blocked[i]) return false;
  if (nav.headroom[i]! < u.heightVoxels) return false;
  const fromCx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
  const fromCz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
  const fromTop = nav.topY[navIndex(fromCx, fromCz)]!;
  const toTop = nav.topY[i]!;
  if (fromTop < 0 || toTop < 0) return false;
  if (Math.abs(toTop - fromTop) > u.maxStepVoxels) return false;
  return true;
}

function surfaceWorldY(nav: SurfaceNavBuffers, wx: number, wz: number): number {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
  const top = nav.topY[navIndex(cx, cz)]!;
  return top < 0 ? 0 : (top + 1) * VOXEL_SIZE;
}

/**
 * Find the highest top voxel anywhere under the unit's footprint at (wx, wz). We
 * scan the live voxel column at a small grid of points spanning ±halfWidth, walking
 * downward from a search ceiling sourced from the surface nav's cell-level topY.
 *
 * Returning the MAX over the footprint is what stops a wide chassis from clipping
 * into voxels that are taller than the cell-average — the unit is placed on top
 * of the highest voxel under any tread/foot, never inside one. (The path search
 * already guaranteed the cells are climb-feasible.)
 *
 * `searchRangeVoxels` MUST be at least the unit's `maxStepVoxels` plus a small
 * margin: a footprint sample sitting in a neighbour cell can be that much taller
 * than the centre cell's `cellTop`. With too small a window the search starts
 * INSIDE the neighbour's solid column and records that as the "top", parking the
 * unit's feet a few voxels below the actual surface — the half-buried look you
 * see when a soldier climbs a steep step. Soldiers (`maxStepVoxels = 32`) are the
 * worst offender; workers (24) and worms (16) hit it too.
 *
 * Returns null if no solid voxel is found in the search range.
 */
function findFootprintTopVoxel(
  voxels: Uint8Array,
  nav: SurfaceNavBuffers,
  wx: number, wz: number,
  halfWidthM: number,
  searchRangeVoxels: number,
): number | null {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
  const cellTop = nav.topY[navIndex(cx, cz)]!;
  if (cellTop < 0) return null;
  // Sample a small grid covering the footprint. 3x3 is enough — the path search
  // already verified roughness over a wider radius for vehicles.
  const SAMPLES: number = 3;
  const startY = Math.min(cellTop + searchRangeVoxels, WORLD_Y - 1);
  const endY = Math.max(0, cellTop - searchRangeVoxels);
  let best = -1;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const t = SAMPLES === 1 ? 0 : (i / (SAMPLES - 1)) * 2 - 1; // -1..+1
      const u = SAMPLES === 1 ? 0 : (j / (SAMPLES - 1)) * 2 - 1;
      const sx = wx + t * halfWidthM;
      const sz = wz + u * halfWidthM;
      const vx = Math.floor(sx / VOXEL_SIZE);
      const vz = Math.floor(sz / VOXEL_SIZE);
      if (vx < 0 || vz < 0 || vx >= WORLD_X || vz >= WORLD_Z) continue;
      // Walk down from the ceiling looking for the first WALKABLE voxel. Tree
      // voxels (wood / leaf) are skipped — units stand on the ground under
      // canopies, not on top of the canopy. Without this skip, a footprint
      // sample landing in a tree column made the unit hover at the canopy top.
      const top = Math.min(startY, WORLD_Y - 1);
      for (let y = top; y >= endY; y--) {
        const m = voxels[worldIndex(vx, y, vz)];
        if (m === AIR || m === M_WOOD || m === M_LEAF) continue;
        if (y > best) best = y;
        break;
      }
    }
  }
  return best >= 0 ? best : null;
}

function sampleSurfaceFollow(u: Unit, nav: SurfaceNavBuffers, voxels: Uint8Array, dt: number): void {
  // Use the live voxel column under the unit's footprint to find the actual highest
  // top voxel — not the cell-average topY (which can leave a wide chassis clipping
  // into a higher voxel inside the same cell). The path search already proved the
  // cells are climb-feasible, so we trust it and just keep the unit visually on
  // top of the terrain.
  const halfWidthM = u.widthMeters * 0.5;
  // The search must reach at least one full climb-step above the cell-centre topY,
  // because A* let the unit straddle a cell boundary where the neighbour cell can be
  // up to maxStepVoxels taller. We also bake in a generous fixed floor (36 voxels =
  // 4.5 m) so the snap still works when a unit ends up on terrain the path search
  // wouldn't have routed it onto — explosion knockback, hand-spawned units, edits
  // that lift the ground after the path was committed. Without it, soldiers
  // crossing a tall step had their feet snapped into the dirt a couple voxels
  // below the actual ledge, which the renderer drew as the unit half-buried in
  // the hillside.
  const searchRange = Math.max(36, u.maxStepVoxels + 4);
  const topVoxel = findFootprintTopVoxel(voxels, nav, u.x, u.z, halfWidthM, searchRange);
  if (topVoxel === null) return;
  const targetY = (topVoxel + 1) * VOXEL_SIZE;
  // Climb is fast (the unit was already gated by maxStepVoxels at path time so we trust
  // the path here). Falling uses real gravity so the unit accelerates downward
  // off a ledge or out of mid-air, with a terminal-velocity cap, and lands
  // crisply on the surface (vy reset to 0). Both directions sit on top of the
  // walkable topY — never below — so the unit's feet are always on solid ground.
  const dyDesired = targetY - u.y;
  if (dyDesired >= 0) {
    // Climbing or already at floor: snap up, kill any residual fall velocity.
    u.y += dyDesired * Math.min(1, dt * 12);
    u.vy = 0;
  } else {
    u.vy = Math.max(-u.terminalFallSpeed, u.vy - GRAVITY * dt);
    u.y += u.vy * dt;
    if (u.y <= targetY) {
      u.y = targetY;
      u.vy = 0;
    }
  }

  // Pitch + roll come from the cell-level slope still — they only need to be
  // accurate enough to tilt the model, not collision-correct.
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
  const xm1 = nav.topY[navIndex(Math.max(0, cx - 1), cz)]!;
  const xp1 = nav.topY[navIndex(Math.min(NAV_W - 1, cx + 1), cz)]!;
  const zm1 = nav.topY[navIndex(cx, Math.max(0, cz - 1))]!;
  const zp1 = nav.topY[navIndex(cx, Math.min(NAV_H - 1, cz + 1))]!;
  const dydx = ((xp1 - xm1) * VOXEL_SIZE) / (2 * NAV_CELL_METERS);
  const dydz = ((zp1 - zm1) * VOXEL_SIZE) / (2 * NAV_CELL_METERS);

  const ch = Math.cos(u.heading), sh = Math.sin(u.heading);
  const slopeForward = dydx * sh + dydz * ch;
  const slopeRight   = dydx * ch - dydz * sh;
  // Same convention as applyPathOrientation: rendered pitch is clamped to the
  // unit's maxPitchRad cap so a tank parked on a steep cliff face doesn't tilt
  // past 30°. Roll is clamped to the same magnitude so a unit straddling a
  // sharp side-slope also stays within its hull's articulation.
  const rawPitch = Math.atan(-slopeForward);
  const rawRoll  = Math.atan(slopeRight);
  const targetPitch = clamp(rawPitch, -u.maxPitchRad, u.maxPitchRad);
  const targetRoll  = clamp(rawRoll,  -u.maxPitchRad, u.maxPitchRad);
  const k = Math.min(1, dt * 8);
  u.pitch += (targetPitch - u.pitch) * k;
  u.roll  += (targetRoll  - u.roll)  * k;
}

/**
 * Append the current head position to the breadcrumb trail when it has moved more
 * than `PATH_HISTORY_STEP_MIN` from the most recent breadcrumb. Older breadcrumbs
 * past the chain's reach are trimmed off so the buffer stays bounded.
 */
function recordPathBreadcrumb(u: Unit): void {
  const history = u.pathHistory;
  const head = history[0];
  if (!head) {
    history.push({ x: u.x, y: u.y, z: u.z });
  } else {
    const dx = u.x - head.x, dy = u.y - head.y, dz = u.z - head.z;
    if (dx * dx + dy * dy + dz * dz > PATH_HISTORY_STEP_MIN * PATH_HISTORY_STEP_MIN) {
      history.unshift({ x: u.x, y: u.y, z: u.z });
    }
  }

  // Trim: drop any breadcrumbs older than the chain length plus a buffer. We need
  // enough trail to cover (segmentCount + 1) * spacing of arc-length backward; a
  // small extra margin avoids re-trimming on every frame.
  const maxDist = (u.segments.length + 1) * WORM_SEGMENT_SPACING + 2.0;
  let accum = 0;
  let prevX = u.x, prevY = u.y, prevZ = u.z;
  for (let i = 0; i < history.length; i++) {
    const cur = history[i]!;
    accum += Math.hypot(cur.x - prevX, cur.y - prevY, cur.z - prevZ);
    if (accum > maxDist) {
      history.length = i + 1;
      return;
    }
    prevX = cur.x; prevY = cur.y; prevZ = cur.z;
  }
}

/**
 * Worm body chain — exact-path follower. Each segment is placed at the point along
 * the head's recorded breadcrumb trail that is exactly `(i + 1) * spacing` of arc
 * length behind the current head. Linear interpolation between adjacent breadcrumbs
 * gives sub-step accuracy on curves, so segments trace the same dive/climb/turn
 * profile the head executed — no corner-cutting, no per-segment gravity drift.
 *
 * The chain still doesn't carve, doesn't take part in pathing, and doesn't block
 * anything; it's purely visual / cosmetic body geometry following the head's wake.
 */
function tickWormChain(u: Unit): void {
  const spacing = WORM_SEGMENT_SPACING;
  const segments = u.segments;
  const history = u.pathHistory;

  let segIdx = 0;
  let target = spacing;            // arc-length to segment[0] from head
  let accum = 0;
  let prevX = u.x, prevY = u.y, prevZ = u.z;

  for (let i = 0; i < history.length && segIdx < segments.length; i++) {
    const cur = history[i]!;
    const dx = cur.x - prevX, dy = cur.y - prevY, dz = cur.z - prevZ;
    const segLen = Math.hypot(dx, dy, dz);
    while (segIdx < segments.length && segLen > 1e-6 && accum + segLen >= target) {
      const t = (target - accum) / segLen;
      const seg = segments[segIdx]!;
      const newX = prevX + dx * t;
      const newY = prevY + dy * t;
      const newZ = prevZ + dz * t;
      // Heading + pitch from the local tangent: vector from this segment toward its
      // leader (the previous link on the chain, or the head for segment 0). Matches
      // the heading convention used by tickSurface (heading = 0 → forward = -Z).
      const linkDx = prevX - newX;
      const linkDy = prevY - newY;
      const linkDz = prevZ - newZ;
      const linkH = Math.hypot(linkDx, linkDz);
      if (linkH > 1e-4) {
        seg.heading = Math.atan2(-linkDx, -linkDz);
      }
      seg.pitch = clamp(
        Math.atan2(linkDy, Math.max(linkH, 1e-4)),
        -u.maxPitchRad, u.maxPitchRad,
      );
      seg.x = newX; seg.y = newY; seg.z = newZ;
      seg.vy = 0;
      segIdx++;
      target = (segIdx + 1) * spacing;
    }
    accum += segLen;
    prevX = cur.x; prevY = cur.y; prevZ = cur.z;
  }
  // History too short to cover the whole chain (only happens if a unit is
  // teleported and the buffer hasn't refilled yet). Anchor any leftover segments
  // at the tail of what we do have, so they don't fly off to stale positions.
  while (segIdx < segments.length) {
    const seg = segments[segIdx]!;
    seg.x = prevX; seg.y = prevY; seg.z = prevZ;
    seg.vy = 0;
    segIdx++;
  }
}
