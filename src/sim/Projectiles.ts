import { VoxelWorld } from '../voxel/VoxelWorld';
import { raycastVoxel } from '../voxel/Raycast';
import { VOXEL_SIZE } from '../voxel/types';

/**
 * Projectile catalog. Each entry is one ammunition type with its real-world-ish
 * mass, muzzle velocity, drag, and damage profile. Velocities are deliberately
 * scaled down from real ballistics (typical small-arms muzzle is ~900 m/s) so
 * projectiles are visually trackable in flight — trace tests in
 * `tests/projectiles.spec.ts` cover the resulting drop arc against gravity.
 *
 * Bullet calibres are labelled by their standard mm size:
 *   9 mm    — pistol round
 *   5.56 mm — rifle / machine gun round
 *   7.62 mm — sniper / DMR round
 *
 * Explosive ordnance (rpg, heavy_rocket, cluster_rocket, tank_shell) adds a
 * `damageSphere` blast on impact; cluster rounds also spawn submunitions.
 */
export type ProjectileKind =
  | 'bullet_9mm'
  | 'bullet_5_56mm'
  | 'bullet_7_62mm'
  | 'rpg'
  | 'heavy_rocket'
  | 'cluster_rocket'
  | 'cluster_submunition'
  | 'tank_shell'
  | 'turret_shell'
  | 'flak_shell'
  | 'aa_missile'
  | 'silo_missile';

export interface ProjectileConfig {
  kind: ProjectileKind;
  /** Real-ish projectile mass in kilograms (small for bullets, big for rockets). */
  massKg: number;
  /**
   * Multiplier applied to the per-impact `damagePeak` when calling
   * `damageSphere` on the world. 1.0 means terrain damage matches the
   * unit-damage peak; lower values (e.g. 0.2 for the turret shell) keep the
   * round lethal to enemies while sparing the surrounding map. Defaults to 1
   * when omitted in the catalog.
   */
  terrainDamageScale?: number;
  /**
   * Optional vertical-boost phase. Used by the silo missile: launch climbs
   * straight up for `boostMetersDefault` before tipping over toward the
   * target with full ballistic flight. Carriers can override at spawn time.
   */
  boostMetersDefault?: number;
  /**
   * Initial speed in m/s, taken at the muzzle / launcher. Deliberately slow
   * (sub-200 m/s for bullets, sub-100 m/s for rockets) so the player can
   * actually see the trajectory; bullet drop becomes very visible at this
   * scale, which is exactly what the player wants to watch for.
   */
  muzzleVelocity: number;
  /**
   * Linear drag time-constant in inverse-seconds. Each tick the velocity is
   * scaled by `exp(-dragPerSecond * dt)`. Larger = bleed speed faster.
   */
  dragPerSecond: number;
  /**
   * Direct hit damage applied via `damageSphere` peak. Non-explosive bullets
   * use a small sphere; explosive ordnance uses `explosionRadiusMeters`.
   */
  hitDamage: number;
  /** Hit sphere radius in meters for non-explosive impacts (bullets pit a tiny crater). */
  hitRadiusMeters: number;
  /** True when the projectile detonates on impact instead of just pitting a voxel. */
  explosive: boolean;
  /** Explosion peak damage and radius (meters). Only meaningful when explosive=true. */
  explosionPeak: number;
  explosionRadiusMeters: number;
  /**
   * For cluster munitions: number of submunitions spawned at detonation. Each
   * submunition is a child projectile launched from the detonation point in a
   * cone of random downward-tilted directions.
   */
  clusterSubmunitions: number;
  /** Time-to-live in seconds. The projectile is removed even if it never hits anything. */
  maxLifeSeconds: number;
  /**
   * Fraction of `PROJECTILE_GRAVITY` applied to this projectile each tick.
   * Defaults to 1.0 (full gravity). Slow-moving rockets and missiles (those
   * whose muzzle velocity was reduced 4× for visual readability) use 0.25 so
   * they maintain roughly ¼ of their original max range despite the lower
   * muzzle speed — the lower gravity keeps the arc shape similar while the
   * slow motion gives the player time to watch the flight.
   */
  gravityScale?: number;
  /** RGB tint (0..1 each) used by the projectile renderer for tracers / rocket bodies. */
  colorR: number; colorG: number; colorB: number;
  /** Visual length and radius in meters. Bullets are slim; rockets are chunkier. */
  visualLengthMeters: number;
  visualRadiusMeters: number;
  /** Visual: when true, the projectile renders with a glowing trail behind it. */
  hasTrail: boolean;
}

/**
 * Tuned-for-gameplay catalog. Mass values are roughly real (a 9 mm round is
 * ~7.5 g, an RPG warhead is ~2.3 kg) but velocities are scaled so a bullet
 * drops visibly within its in-game range (the previous approach used real
 * ~900 m/s muzzles, which made every shot effectively a ray and obscured the
 * "have bullet drop" requirement).
 */
export const PROJECTILES: Record<ProjectileKind, ProjectileConfig> = {
  bullet_9mm: {
    kind: 'bullet_9mm',
    massKg: 0.0075,
    muzzleVelocity: 55,
    dragPerSecond: 0.10,
    hitDamage: 18, hitRadiusMeters: 0.12,
    explosive: false, explosionPeak: 0, explosionRadiusMeters: 0,
    clusterSubmunitions: 0,
    maxLifeSeconds: 2.5,
    colorR: 1.00, colorG: 0.85, colorB: 0.40,
    visualLengthMeters: 0.18, visualRadiusMeters: 0.025,
    hasTrail: false,
  },
  bullet_5_56mm: {
    kind: 'bullet_5_56mm',
    massKg: 0.004,
    muzzleVelocity: 75,
    dragPerSecond: 0.06,
    hitDamage: 28, hitRadiusMeters: 0.15,
    explosive: false, explosionPeak: 0, explosionRadiusMeters: 0,
    clusterSubmunitions: 0,
    maxLifeSeconds: 3.0,
    colorR: 1.00, colorG: 0.92, colorB: 0.55,
    visualLengthMeters: 0.22, visualRadiusMeters: 0.02,
    hasTrail: true,
  },
  bullet_7_62mm: {
    kind: 'bullet_7_62mm',
    massKg: 0.0095,
    muzzleVelocity: 95,
    dragPerSecond: 0.04,
    hitDamage: 55, hitRadiusMeters: 0.20,
    explosive: false, explosionPeak: 0, explosionRadiusMeters: 0,
    clusterSubmunitions: 0,
    maxLifeSeconds: 4.0,
    colorR: 1.00, colorG: 0.88, colorB: 0.50,
    visualLengthMeters: 0.28, visualRadiusMeters: 0.024,
    hasTrail: true,
  },
  rpg: {
    kind: 'rpg',
    massKg: 2.25,
    muzzleVelocity: 45,
    dragPerSecond: 0.08,
    hitDamage: 60, hitRadiusMeters: 0.4,
    explosive: true, explosionPeak: 180, explosionRadiusMeters: 2.4,
    terrainDamageScale: 0.17,
    clusterSubmunitions: 0,
    maxLifeSeconds: 5.0,
    colorR: 1.00, colorG: 0.45, colorB: 0.20,
    visualLengthMeters: 0.7, visualRadiusMeters: 0.09,
    hasTrail: true,
  },
  heavy_rocket: {
    kind: 'heavy_rocket',
    massKg: 65,
    muzzleVelocity: 12.5,
    dragPerSecond: 0.05,
    hitDamage: 80, hitRadiusMeters: 0.5,
    explosive: true, explosionPeak: 220, explosionRadiusMeters: 4.0,
    terrainDamageScale: 0.17,
    clusterSubmunitions: 0,
    maxLifeSeconds: 32.0,
    gravityScale: 0.25,
    colorR: 1.00, colorG: 0.55, colorB: 0.28,
    visualLengthMeters: 1.4, visualRadiusMeters: 0.18,
    hasTrail: true,
  },
  cluster_rocket: {
    kind: 'cluster_rocket',
    massKg: 80,
    muzzleVelocity: 12,
    dragPerSecond: 0.06,
    hitDamage: 30, hitRadiusMeters: 0.4,
    explosive: true, explosionPeak: 100, explosionRadiusMeters: 1.6,
    terrainDamageScale: 0.17,
    clusterSubmunitions: 8,
    maxLifeSeconds: 32.0,
    gravityScale: 0.25,
    colorR: 1.00, colorG: 0.65, colorB: 0.30,
    visualLengthMeters: 1.2, visualRadiusMeters: 0.16,
    hasTrail: true,
  },
  /**
   * Submunition spawned by `cluster_rocket` at detonation. Each one is a
   * smaller HE round that scatters from the burst point with a random
   * downward-tilted velocity, lands a moment later, and detonates on its
   * own. Small radius but several at once carpets a footprint.
   */
  cluster_submunition: {
    kind: 'cluster_submunition',
    massKg: 6,
    muzzleVelocity: 5.5,
    dragPerSecond: 0.10,
    hitDamage: 30, hitRadiusMeters: 0.3,
    explosive: true, explosionPeak: 90, explosionRadiusMeters: 1.4,
    terrainDamageScale: 0.17,
    clusterSubmunitions: 0,
    maxLifeSeconds: 16.0,
    gravityScale: 0.25,
    colorR: 1.00, colorG: 0.70, colorB: 0.30,
    visualLengthMeters: 0.5, visualRadiusMeters: 0.08,
    hasTrail: true,
  },
  tank_shell: {
    kind: 'tank_shell',
    massKg: 18,
    muzzleVelocity: 27.5,
    dragPerSecond: 0.03,
    hitDamage: 80, hitRadiusMeters: 0.5,
    explosive: true, explosionPeak: 240, explosionRadiusMeters: 2.8,
    terrainDamageScale: 0.17,
    clusterSubmunitions: 0,
    maxLifeSeconds: 4.0,
    colorR: 1.00, colorG: 0.80, colorB: 0.45,
    visualLengthMeters: 0.55, visualRadiusMeters: 0.07,
    hasTrail: true,
  },
  /**
   * Building-turret round — heavier than a tank shell but with a smaller blast.
   * Designed for the static defensive turret: lobs in a pronounced arc thanks
   * to its sub-tank-shell muzzle velocity.
   */
  turret_shell: {
    kind: 'turret_shell',
    massKg: 14,
    muzzleVelocity: 23.75,
    dragPerSecond: 0.04,
    hitDamage: 70, hitRadiusMeters: 0.45,
    explosive: true, explosionPeak: 200, explosionRadiusMeters: 2.4,
    // Defensive turrets are positioned among friendly buildings — letting
    // them carve craters at full peak chews up the base wall every salvo.
    // Scale the terrain damage to a fifth of the unit damage so the round
    // still stings enemies but spares the surrounding voxel structure.
    terrainDamageScale: 0.033,
    clusterSubmunitions: 0,
    maxLifeSeconds: 5.0,
    colorR: 0.95, colorG: 0.75, colorB: 0.40,
    visualLengthMeters: 0.55, visualRadiusMeters: 0.07,
    hasTrail: true,
  },
  /**
   * Flak shell — the AA turret's payload. Fast off the muzzle, light drag, low
   * direct damage; on detonation it sprays an upward-biased cone of shrapnel
   * that disrupts any enemy projectile inside `explosionRadiusMeters`. The
   * disruption itself is handled by the anti-air intercept logic in the
   * projectile manager (so the shell is just the carrier — its blast against
   * units is small).
   */
  flak_shell: {
    kind: 'flak_shell',
    massKg: 4,
    muzzleVelocity: 95,
    dragPerSecond: 0.04,
    hitDamage: 12, hitRadiusMeters: 0.25,
    explosive: true, explosionPeak: 60, explosionRadiusMeters: 4.0,
    // Defensive shell, fired near our own buildings — keep terrain damage low
    // so a busy AA salvo doesn't grind craters into the base.
    terrainDamageScale: 0.008,
    clusterSubmunitions: 0,
    maxLifeSeconds: 4.0,
    colorR: 1.00, colorG: 0.95, colorB: 0.55,
    visualLengthMeters: 0.45, visualRadiusMeters: 0.06,
    hasTrail: true,
  },
  /**
   * Silo missile — the heaviest in the catalog. Slow off the launch rails but
   * carries a punishing warhead with a wide blast. The silo's high
   * launcherMaxStrength lets the missile reach across the map; with the
   * doubled gravity it visibly arcs hundreds of meters before terminal dive.
   */
  silo_missile: {
    kind: 'silo_missile',
    massKg: 350,
    muzzleVelocity: 22.5,
    dragPerSecond: 0.025,
    // Damage tuned down from a previous high-peak revision: silos are still
    // the heaviest single shot on the map, but a hit is no longer instant
    // map deletion. Both direct and explosion damage are scaled together.
    hitDamage: 47, hitRadiusMeters: 0.7,
    explosive: true, explosionPeak: 127, explosionRadiusMeters: 6.0,
    terrainDamageScale: 0.17,
    // Vertical liftoff: the silo cluster fires straight up for 10 m before
    // tipping over toward the target. Reads visually as a launch silo, and
    // gives nearby friendlies a beat to clear the muzzle wash.
    boostMetersDefault: 10,
    clusterSubmunitions: 0,
    maxLifeSeconds: 72.0,
    gravityScale: 0.25,
    colorR: 1.00, colorG: 0.40, colorB: 0.20,
    visualLengthMeters: 2.4, visualRadiusMeters: 0.32,
    hasTrail: true,
  },
  /**
   * AA interceptor missile — replaces the flak shell. A single large guided
   * missile that flies slowly toward an incoming rocket or shell and detonates
   * with the same burst radius as the old flak shell. One shot every 10 s;
   * the slow muzzle velocity (¼ of the old flak) means the lead computation
   * must account for a longer time-of-flight but the large explosion sphere
   * still covers the intercept window.
   */
  aa_missile: {
    kind: 'aa_missile',
    massKg: 45,
    muzzleVelocity: 23.75,
    dragPerSecond: 0.04,
    hitDamage: 12, hitRadiusMeters: 0.25,
    explosive: true, explosionPeak: 60, explosionRadiusMeters: 4.0,
    terrainDamageScale: 0.008,
    clusterSubmunitions: 0,
    maxLifeSeconds: 16.0,
    gravityScale: 0.25,
    colorR: 0.40, colorG: 0.80, colorB: 1.00,
    visualLengthMeters: 1.8, visualRadiusMeters: 0.20,
    hasTrail: true,
  },
};

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Cached drag time-constant from the config; per-frame velocity is scaled by exp(-drag*dt). */
  dragPerSecond: number;
  /** Cached projectile mass — exposed for test/diagnostic purposes. */
  massKg: number;
  /** Seconds since spawn. */
  age: number;
  /** Cached config field so the tick doesn't re-look it up each frame. */
  maxLifeSeconds: number;
  /** Owner unit id, used to skip self-hit at spawn. -1 for anonymous (e.g. submunitions). */
  ownerId: number;
  /** Set true the moment a collision is resolved or the projectile expires; the manager
   *  sweeps these out at the end of each tick. */
  dead: boolean;
  /**
   * Vertical-boost flight phase. While > 0, the projectile climbs straight up
   * at `BOOST_ASCEND_SPEED` instead of running ballistic physics. When the
   * meter counter reaches 0, the velocity is recomputed toward
   * (boostTargetX/Y/Z) at `postBoostSpeed` and normal physics resumes. Used
   * by silo missiles to fire vertical first then arc.
   */
  boostMetersRemaining: number;
  boostTargetX: number;
  boostTargetY: number;
  boostTargetZ: number;
  postBoostSpeed: number;
  /**
   * Sampled trajectory captured at spawn time — the predicted full flight
   * path from the muzzle until the projectile hits voxel geometry, drops
   * below the world floor, or runs out of `maxLifeSeconds`. Used by the
   * `ProjectileArcPool` renderer so the dashed arc the player sees on screen
   * stays visible from spawn through impact instead of shrinking each frame
   * as a re-prediction would.
   *
   * Empty until `attachPredictedArc` is called by the manager — the spawn
   * site (Game / WeaponTick) wires the world reference at fire time so the
   * arc reflects real terrain. When empty, the renderer falls back to the
   * live-state predict.
   */
  arcPoints: { x: number; y: number; z: number }[];
}

/**
 * Vertical-ascent speed used during the boost phase. Constant across all
 * boosted munitions for now — the only consumer is the silo missile, but
 * pulling it out as a named constant keeps the predict / tick branches
 * obviously matched.
 */
export const BOOST_ASCEND_SPEED = 30;

/**
 * Detonation event yielded by the projectile tick. The Game wires this to the
 * voxel `damageSphere` machinery so the existing crater + debris pipeline
 * still does the heavy lifting.
 */
export interface ProjectileImpact {
  kind: ProjectileKind;
  /** Direct-hit damage from the catalog — what a unit takes when the projectile
   *  actually struck it (independent of any explosion that follows). */
  hitDamage: number;
  /** World-space impact point in meters. */
  x: number; y: number; z: number;
  /** True when this was an explosive detonation (vs a bullet pit). */
  explosive: boolean;
  /** For explosions: sphere damage radius in meters. */
  explosionRadiusMeters: number;
  /** Damage peak (used by both explosive and non-explosive impacts). */
  damagePeak: number;
  /** Hit radius for non-explosive bullets, meters (matches damageSphere call). */
  hitRadiusMeters: number;
  /** Unit id directly hit by the projectile, or -1 when the impact landed on
   *  voxel geometry / expired in flight. The Game uses this to apply direct
   *  projectile damage on top of any explosive splash. */
  directHitUnitId: number;
  /** Multiplier from the projectile config; applied to the world `damageSphere`
   *  peak so a round can hurt enemies more than it hurts the map (e.g. turret
   *  shells). Defaults to 1 when the catalog entry omits the field. */
  terrainDamageScale: number;
}

/**
 * Optional callback supplied to `ProjectileManager.tick`. Given the swept
 * segment of a single projectile's frame motion, returns the closest unit
 * the segment intersects (skipping the projectile's owner) along with the
 * distance along the segment, or null if the segment misses every unit.
 */
export type UnitHitTest = (
  fromX: number, fromY: number, fromZ: number,
  dirX: number, dirY: number, dirZ: number,
  maxDist: number,
  ownerId: number,
) => { tMeters: number; unitId: number } | null;

/**
 * Gravity used for ballistic integration. Pumped to roughly 2× real-world
 * gravity so projectiles arc more visibly over the deliberately-slow muzzle
 * velocities in this catalog — players see a clear lob, not a flat ray. The
 * value is decoupled from the unit-physics gravity in `Units.ts` so we can
 * tune projectile arcs without making units feel different to drive.
 */
export const PROJECTILE_GRAVITY = 18.0;

/**
 * Solve the ballistic-arc launch direction needed to hit (toX, toY, toZ) from
 * (fromX, fromY, fromZ) with the given launch `speed` against constant
 * downward `gravity`. Returns the unit-length launch direction; chooses the
 * lower (flatter) of the two valid elevation angles so the missile arches
 * but doesn't lob nearly straight up.
 *
 * If the target is out of range (no real solution), returns a direct-line
 * unit vector — the projectile will fall short, and any hittability gate
 * upstream will catch the unreachable case via predictTrajectory.
 *
 * Used by boosted projectiles (silo) at the moment they exit the boost
 * phase: from the apex altitude, the missile arches toward the target.
 */
export function solveBallisticDirection(
  fromX: number, fromY: number, fromZ: number,
  toX: number, toY: number, toZ: number,
  speed: number,
  gravity: number,
): { x: number; y: number; z: number } {
  const dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-3) {
    const sgn = dy >= 0 ? 1 : -1;
    return { x: 0, y: sgn, z: 0 };
  }
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * horiz * horiz + 2 * dy * v2);
  if (disc < 0) {
    const dl = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / dl, y: dy / dl, z: dz / dl };
  }
  const tanLow = (v2 - Math.sqrt(disc)) / (gravity * horiz);
  const fx = dx / horiz, fz = dz / horiz;
  const dirLen = Math.sqrt(1 + tanLow * tanLow);
  return {
    x: fx / dirLen,
    y: tanLow / dirLen,
    z: fz / dirLen,
  };
}

export class ProjectileManager {
  readonly projectiles: Projectile[] = [];
  /** Impacts that occurred this tick — drained by Game after each `tick`. */
  readonly pendingImpacts: ProjectileImpact[] = [];
  private nextId = 1;
  /**
   * World ref used when `spawn` should automatically pre-compute the visible
   * trajectory arc. Wired by Game on init; tests that don't care about the
   * renderer can leave it unset and the projectile's `arcPoints` stays empty
   * (the live tick is unaffected).
   */
  worldForPrediction: VoxelWorld | null = null;

  /**
   * Launch a projectile from `(x,y,z)` along the unit-vector `(dx,dy,dz)` at the
   * configured muzzle velocity. `velocityScale` lets a weapon dial the speed
   * (e.g. a sub-charge load) without editing the projectile catalog. When
   * `maxStrength` is supplied, it caps the resulting muzzle velocity in m/s —
   * each launcher (soldier, tank, turret building, silo, …) carries its own
   * max-strength rating so a 7.62 mm round fired from a soldier doesn't fly
   * the same distance as the same round fired from a battleship cannon.
   */
  spawn(
    kind: ProjectileKind,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    ownerId: number,
    velocityScale = 1,
    maxStrength = Infinity,
    /**
     * Optional vertical-boost phase. When present, the projectile spawns
     * climbing straight up (`vy = BOOST_ASCEND_SPEED`) for `meters` of
     * altitude, ignoring the supplied direction; on completion its velocity
     * is recomputed toward `target` at the same launch speed used for a
     * direct shot. The silo missile uses this to fire vertical first.
     */
    boost?: { meters: number; targetX: number; targetY: number; targetZ: number },
  ): Projectile {
    const cfg = PROJECTILES[kind];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const speed = Math.min(cfg.muzzleVelocity * velocityScale, maxStrength);
    // Direct-flight initial velocity. Overwritten below for boosted shots.
    let vx = (dx / dl) * speed;
    let vy = (dy / dl) * speed;
    let vz = (dz / dl) * speed;
    let boostMetersRemaining = 0;
    let boostTargetX = 0, boostTargetY = 0, boostTargetZ = 0;
    if (boost && boost.meters > 0) {
      vx = 0;
      vy = BOOST_ASCEND_SPEED;
      vz = 0;
      boostMetersRemaining = boost.meters;
      boostTargetX = boost.targetX;
      boostTargetY = boost.targetY;
      boostTargetZ = boost.targetZ;
    }
    const p: Projectile = {
      id: this.nextId++,
      kind,
      x, y, z,
      vx, vy, vz,
      dragPerSecond: cfg.dragPerSecond,
      massKg: cfg.massKg,
      age: 0,
      maxLifeSeconds: cfg.maxLifeSeconds,
      ownerId,
      dead: false,
      boostMetersRemaining,
      boostTargetX, boostTargetY, boostTargetZ,
      postBoostSpeed: speed,
      arcPoints: [],
    };
    this.projectiles.push(p);
    if (this.worldForPrediction) this.attachPredictedArc(p, this.worldForPrediction);
    return p;
  }

  /**
   * Compute and cache the projectile's predicted full flight arc (from the
   * spawn position, with the spawn velocity, until impact / floor / max
   * life). Stored on the projectile so the renderer can draw a dashed line
   * that stays put as the projectile flies, instead of recomputing the
   * remaining flight every frame (which makes the visible arc shrink).
   *
   * Safe to call on a freshly-spawned projectile that still carries its
   * launch velocity. Pure read of the world.
   */
  attachPredictedArc(p: Projectile, world: VoxelWorld | null): void {
    p.arcPoints = this.predictRemaining(p, world, 0, 96, 0.06);
  }

  /**
   * Advance every live projectile by `dt` seconds. Each step:
   *   1. Apply gravity (vy -= g*dt) and exponential drag (v *= exp(-drag*dt)).
   *   2. Cast a voxel ray from the previous position to the next position; if it
   *      hits a non-air voxel within the step length, snap the projectile to the
   *      hit point and emit a `ProjectileImpact`.
   *   3. Otherwise advance position and bump age. Expire when age > maxLife.
   *
   * The ray version of step 2 is what stops fast projectiles from tunneling
   * through thin walls — even a 200 m/s tank shell can cover several meters
   * per frame at 60 fps and would otherwise teleport past a 1-voxel barrier.
   *
   * Cluster submunitions are NOT spawned here — the caller (Game) inspects
   * `pendingImpacts` after the tick and dispatches submunitions itself, since
   * spawning them needs access to the projectile catalog and the world (for
   * detonation handling), which the manager intentionally doesn't own.
   */
  tick(dt: number, world: VoxelWorld, unitHitTest?: UnitHitTest): void {
    this.pendingImpacts.length = 0;
    for (const p of this.projectiles) {
      if (p.dead) continue;

      // Vertical-boost phase: pure ascent at BOOST_ASCEND_SPEED, no gravity
      // / drag, until the meter counter is consumed. Once exhausted we
      // reseed velocity toward the stored boostTarget at postBoostSpeed and
      // fall through to normal physics on the next tick.
      if (p.boostMetersRemaining > 0) {
        const ds = BOOST_ASCEND_SPEED * dt;
        const consumed = Math.min(p.boostMetersRemaining, ds);
        p.y += consumed;
        p.boostMetersRemaining -= consumed;
        p.vx = 0; p.vy = BOOST_ASCEND_SPEED; p.vz = 0;
        if (p.boostMetersRemaining <= 0) {
          // Ballistic-arc solve: aim for the chosen target point with the
          // launch speed and current gravity. Lobs over distance instead of
          // diving directly at the target like a flat-fire round, which is
          // why the silo missile reads as a real artillery shot.
          const gScaleBoost = PROJECTILES[p.kind].gravityScale ?? 1;
          const dir = solveBallisticDirection(
            p.x, p.y, p.z,
            p.boostTargetX, p.boostTargetY, p.boostTargetZ,
            p.postBoostSpeed,
            PROJECTILE_GRAVITY * gScaleBoost,
          );
          p.vx = dir.x * p.postBoostSpeed;
          p.vy = dir.y * p.postBoostSpeed;
          p.vz = dir.z * p.postBoostSpeed;
        }
        p.age += dt;
        if (p.age >= p.maxLifeSeconds) {
          if (PROJECTILES[p.kind].explosive) this.emitImpact(p);
          p.dead = true;
        }
        continue;
      }

      // Cache previous position so we can ray-cast the swept segment.
      const px = p.x, py = p.y, pz = p.z;

      // Gravity is applied to vertical velocity; horizontal components only see drag.
      const gScale = PROJECTILES[p.kind].gravityScale ?? 1;
      p.vy -= PROJECTILE_GRAVITY * gScale * dt;
      const dragScale = Math.exp(-p.dragPerSecond * dt);
      p.vx *= dragScale;
      p.vy *= dragScale;
      p.vz *= dragScale;

      const stepX = p.vx * dt;
      const stepY = p.vy * dt;
      const stepZ = p.vz * dt;
      const stepLen = Math.hypot(stepX, stepY, stepZ);

      let hit = false;
      if (stepLen > 1e-5) {
        const idx = 1 / stepLen;
        const dirX = stepX * idx, dirY = stepY * idx, dirZ = stepZ * idx;
        const voxelHit = raycastVoxel(
          world,
          { x: px, y: py, z: pz },
          { x: dirX, y: dirY, z: dirZ },
          stepLen,
        );
        const unitHit = unitHitTest
          ? unitHitTest(px, py, pz, dirX, dirY, dirZ, stepLen, p.ownerId)
          : null;
        // Pick whichever obstacle the projectile reaches first along the swept
        // segment. Ties (very rare) fall to the unit since a body is the more
        // satisfying impact point.
        let useUnit = false;
        let hitT = -1;
        if (voxelHit && unitHit) {
          if (unitHit.tMeters <= voxelHit.tMeters) { useUnit = true; hitT = unitHit.tMeters; }
          else { hitT = voxelHit.tMeters; }
        } else if (unitHit) {
          useUnit = true;
          hitT = unitHit.tMeters;
        } else if (voxelHit) {
          hitT = voxelHit.tMeters;
        }
        if (hitT >= 0) {
          p.x = px + dirX * hitT;
          p.y = py + dirY * hitT;
          p.z = pz + dirZ * hitT;
          this.emitImpact(p, useUnit && unitHit ? unitHit.unitId : -1);
          p.dead = true;
          hit = true;
        }
      }

      if (!hit) {
        p.x = px + stepX;
        p.y = py + stepY;
        p.z = pz + stepZ;
        p.age += dt;
        // Expired in flight: emit an impact at the current position so the
        // visual chain (debris / explosion rings) still triggers, then mark
        // dead. Non-explosive expirations just disappear quietly.
        if (p.age >= p.maxLifeSeconds) {
          const cfg = PROJECTILES[p.kind];
          if (cfg.explosive) this.emitImpact(p);
          p.dead = true;
        }
        // Underground / out-of-world clamp — once below y=0 a projectile is
        // gone. We still emit a detonation for explosive rounds at the
        // surface plane so a shell that overshoots into bedrock doesn't
        // simply vanish without a crater.
        if (p.y < 0) {
          if (PROJECTILES[p.kind].explosive) {
            p.y = 0;
            this.emitImpact(p);
          }
          p.dead = true;
        }
      }
    }
    // Anti-air intercept pass. Each aa_missile impact emitted this tick
    // disrupts any other live projectile inside its blast radius. The total
    // chance of disruption is 90%; the outcome rolls between three flavors:
    //
    //   - silent kill (fall from the sky)
    //   - off-course divert (random horizontal perturbation, lose lift)
    //   - blow up where hit (immediate detonation; explosive rounds emit
    //     an impact at their current position)
    //
    // Non-AA-missile impacts pass through unchanged.
    for (const imp of this.pendingImpacts) {
      if (imp.kind !== 'aa_missile') continue;
      this.applyAaIntercept(imp.x, imp.y, imp.z, imp.explosionRadiusMeters);
    }
    // Sweep dead.
    let w = 0;
    for (let r = 0; r < this.projectiles.length; r++) {
      const p = this.projectiles[r]!;
      if (!p.dead) this.projectiles[w++] = p;
    }
    this.projectiles.length = w;
  }

  /**
   * Apply the AA intercept rolls against all live (non-flak, non-AA-owned)
   * projectiles inside `(x,y,z)`'s `radiusMeters` sphere. 90% disruption
   * total; outcomes split evenly across silent kill, off-course divert, and
   * detonate-where-hit.
   *
   * Pulled out as a method (rather than inlined into `tick`) so tests can
   * deterministically exercise the intercept logic by passing a fixed
   * (x,y,z,r). The randomness is local — the caller seeds a Math.random()
   * roll per affected projectile.
   */
  applyAaIntercept(x: number, y: number, z: number, radiusMeters: number): number {
    const r2 = radiusMeters * radiusMeters;
    let affected = 0;
    for (const q of this.projectiles) {
      if (q.dead) continue;
      if (q.kind === 'aa_missile') continue;
      const dxq = q.x - x, dyq = q.y - y, dzq = q.z - z;
      if (dxq * dxq + dyq * dyq + dzq * dzq > r2) continue;
      affected++;
      const roll = Math.random();
      // 0..0.30 silent kill; 0.30..0.60 divert; 0.60..0.90 detonate; 0.90+ miss.
      if (roll < 0.30) {
        q.dead = true;
      } else if (roll < 0.60) {
        // Divert: rotate the velocity by a sharp random yaw and shed half the
        // lift so the round veers off and falls.
        const speed = Math.hypot(q.vx, q.vy, q.vz) || 1;
        const yawJitter = (Math.random() - 0.5) * 1.6;
        const cosA = Math.cos(yawJitter), sinA = Math.sin(yawJitter);
        const nvx = q.vx * cosA - q.vz * sinA;
        const nvz = q.vx * sinA + q.vz * cosA;
        q.vx = nvx;
        q.vz = nvz;
        q.vy = Math.min(q.vy, 0) - speed * 0.15;
        // Boosted rounds (silo missile mid-ascent) lose their boost so
        // gravity takes them.
        q.boostMetersRemaining = 0;
      } else if (roll < 0.90) {
        // Detonate-where-hit: explosive rounds emit their impact at the
        // current position; non-explosives just die. Either way the round
        // is gone.
        const cfg = PROJECTILES[q.kind];
        if (cfg.explosive) this.emitImpact(q);
        q.dead = true;
      }
      // else: 10% miss — projectile flies on undisturbed.
    }
    return affected;
  }

  /**
   * Predict a projectile's flight path with the same physics the live tick
   * uses. Used by `TrajectoryPreview` so the dashed arc on screen matches
   * what an actual fired round will do. Returns world-space points sampled
   * at fixed `sampleDt` intervals; sampling stops when the ray hits voxel
   * geometry, the projectile drops below `floorY`, or `samples` is reached.
   *
   * Pure function — does not touch the live projectile list, so it's safe
   * to call every frame from the renderer.
   */
  predictTrajectory(
    kind: ProjectileKind,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    world: VoxelWorld | null,
    floorY = 0,
    samples = 80,
    sampleDt = 0.06,
    velocityScale = 1,
    maxStrength = Infinity,
    /**
     * Mirror of `spawn`'s `boost` parameter: when present, the prediction
     * starts with a vertical-ascent phase (samples step up at
     * `BOOST_ASCEND_SPEED` ignoring gravity / drag) for `meters`, then
     * tips over toward `target` at the spawn speed.
     */
    boost?: { meters: number; targetX: number; targetY: number; targetZ: number },
  ): { x: number; y: number; z: number }[] {
    const cfg = PROJECTILES[kind];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const speed = Math.min(cfg.muzzleVelocity * velocityScale, maxStrength);
    let vx = (dx / dl) * speed;
    let vy = (dy / dl) * speed;
    let vz = (dz / dl) * speed;
    let boostRemaining = 0;
    let bTx = 0, bTy = 0, bTz = 0;
    if (boost && boost.meters > 0) {
      vx = 0; vy = BOOST_ASCEND_SPEED; vz = 0;
      boostRemaining = boost.meters;
      bTx = boost.targetX; bTy = boost.targetY; bTz = boost.targetZ;
    }
    const drag = cfg.dragPerSecond;
    const grav = PROJECTILE_GRAVITY * (cfg.gravityScale ?? 1);
    const out: { x: number; y: number; z: number }[] = [{ x, y, z }];
    let cx = x, cy = y, cz = z;
    for (let i = 0; i < samples; i++) {
      let sx: number, sy: number, sz: number;
      if (boostRemaining > 0) {
        const ds = BOOST_ASCEND_SPEED * sampleDt;
        const consumed = Math.min(boostRemaining, ds);
        sx = 0; sy = consumed; sz = 0;
        boostRemaining -= consumed;
        if (boostRemaining <= 0) {
          const px = cx + sx, py = cy + sy, pz = cz + sz;
          const dir = solveBallisticDirection(
            px, py, pz,
            bTx, bTy, bTz,
            speed,
            grav,
          );
          vx = dir.x * speed;
          vy = dir.y * speed;
          vz = dir.z * speed;
        }
      } else {
        vy -= grav * sampleDt;
        const dragScale = Math.exp(-drag * sampleDt);
        vx *= dragScale; vy *= dragScale; vz *= dragScale;
        sx = vx * sampleDt; sy = vy * sampleDt; sz = vz * sampleDt;
      }
      const sl = Math.hypot(sx, sy, sz);
      if (world && sl > 1e-5) {
        const idx = 1 / sl;
        const hit = raycastVoxel(
          world,
          { x: cx, y: cy, z: cz },
          { x: sx * idx, y: sy * idx, z: sz * idx },
          sl,
        );
        if (hit) {
          out.push({
            x: cx + sx * idx * hit.tMeters,
            y: cy + sy * idx * hit.tMeters,
            z: cz + sz * idx * hit.tMeters,
          });
          break;
        }
      }
      cx += sx; cy += sy; cz += sz;
      if (cy < floorY) {
        out.push({ x: cx, y: floorY, z: cz });
        break;
      }
      out.push({ x: cx, y: cy, z: cz });
    }
    return out;
  }

  /**
   * Predict the remaining flight path of a live projectile from its current
   * state, including any boost phase still in progress. Used by the in-flight
   * arc renderer so the dashed line tracks the same physics the live tick
   * applies. Pure read of the projectile — no mutation.
   */
  predictRemaining(
    p: Projectile,
    world: VoxelWorld | null,
    floorY = 0,
    samples = 80,
    sampleDt = 0.06,
  ): { x: number; y: number; z: number }[] {
    const cfg = PROJECTILES[p.kind];
    let vx = p.vx, vy = p.vy, vz = p.vz;
    let boostRemaining = p.boostMetersRemaining;
    const drag = cfg.dragPerSecond;
    const grav = PROJECTILE_GRAVITY * (cfg.gravityScale ?? 1);
    const out: { x: number; y: number; z: number }[] = [{ x: p.x, y: p.y, z: p.z }];
    let cx = p.x, cy = p.y, cz = p.z;
    for (let i = 0; i < samples; i++) {
      let sx: number, sy: number, sz: number;
      if (boostRemaining > 0) {
        const ds = BOOST_ASCEND_SPEED * sampleDt;
        const consumed = Math.min(boostRemaining, ds);
        sx = 0; sy = consumed; sz = 0;
        boostRemaining -= consumed;
        if (boostRemaining <= 0) {
          const px = cx + sx, py = cy + sy, pz = cz + sz;
          const dir = solveBallisticDirection(
            px, py, pz,
            p.boostTargetX, p.boostTargetY, p.boostTargetZ,
            p.postBoostSpeed,
            grav,
          );
          vx = dir.x * p.postBoostSpeed;
          vy = dir.y * p.postBoostSpeed;
          vz = dir.z * p.postBoostSpeed;
        }
      } else {
        vy -= grav * sampleDt;
        const dragScale = Math.exp(-drag * sampleDt);
        vx *= dragScale; vy *= dragScale; vz *= dragScale;
        sx = vx * sampleDt; sy = vy * sampleDt; sz = vz * sampleDt;
      }
      const sl = Math.hypot(sx, sy, sz);
      if (world && sl > 1e-5) {
        const idx = 1 / sl;
        const hit = raycastVoxel(
          world,
          { x: cx, y: cy, z: cz },
          { x: sx * idx, y: sy * idx, z: sz * idx },
          sl,
        );
        if (hit) {
          out.push({
            x: cx + sx * idx * hit.tMeters,
            y: cy + sy * idx * hit.tMeters,
            z: cz + sz * idx * hit.tMeters,
          });
          break;
        }
      }
      cx += sx; cy += sy; cz += sz;
      if (cy < floorY) {
        out.push({ x: cx, y: floorY, z: cz });
        break;
      }
      out.push({ x: cx, y: cy, z: cz });
    }
    return out;
  }

  private emitImpact(p: Projectile, directHitUnitId = -1): void {
    const cfg = PROJECTILES[p.kind];
    this.pendingImpacts.push({
      kind: p.kind,
      hitDamage: cfg.hitDamage,
      x: p.x, y: p.y, z: p.z,
      explosive: cfg.explosive,
      explosionRadiusMeters: cfg.explosionRadiusMeters,
      damagePeak: cfg.explosive ? cfg.explosionPeak : cfg.hitDamage,
      hitRadiusMeters: cfg.hitRadiusMeters,
      directHitUnitId,
      terrainDamageScale: cfg.terrainDamageScale ?? 1,
    });
  }
}

/**
 * Convenience: world-space "feet of unit" → "muzzle origin" offset for the
 * given weapon direction. Bullets / shells emerge slightly above and ahead
 * of the unit's origin so they don't immediately collide with the unit's
 * own voxel column. Independent of unit kind for now (fixed offset works
 * fine since we skip self-collision via owner id anyway).
 */
export function muzzleOrigin(
  unitX: number, unitY: number, unitZ: number,
  dirX: number, dirY: number, dirZ: number,
  forwardOffset = 1.4,
  heightOffset = 1.2,
): { x: number; y: number; z: number } {
  const len = Math.hypot(dirX, dirY, dirZ) || 1;
  const fx = dirX / len, fy = dirY / len, fz = dirZ / len;
  return {
    x: unitX + fx * forwardOffset,
    y: unitY + heightOffset + fy * forwardOffset * 0.5,
    z: unitZ + fz * forwardOffset,
  };
}

export { VOXEL_SIZE };
