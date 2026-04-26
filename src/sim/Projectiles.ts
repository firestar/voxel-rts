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
  | 'tank_shell';

export interface ProjectileConfig {
  kind: ProjectileKind;
  /** Real-ish projectile mass in kilograms (small for bullets, big for rockets). */
  massKg: number;
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
    muzzleVelocity: 90,
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
    muzzleVelocity: 130,
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
    muzzleVelocity: 160,
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
    muzzleVelocity: 55,
    dragPerSecond: 0.08,
    hitDamage: 60, hitRadiusMeters: 0.4,
    explosive: true, explosionPeak: 180, explosionRadiusMeters: 2.4,
    clusterSubmunitions: 0,
    maxLifeSeconds: 5.0,
    colorR: 1.00, colorG: 0.45, colorB: 0.20,
    visualLengthMeters: 0.7, visualRadiusMeters: 0.09,
    hasTrail: true,
  },
  heavy_rocket: {
    kind: 'heavy_rocket',
    massKg: 65,
    muzzleVelocity: 70,
    dragPerSecond: 0.05,
    hitDamage: 80, hitRadiusMeters: 0.5,
    explosive: true, explosionPeak: 220, explosionRadiusMeters: 4.0,
    clusterSubmunitions: 0,
    maxLifeSeconds: 8.0,
    colorR: 1.00, colorG: 0.55, colorB: 0.28,
    visualLengthMeters: 1.4, visualRadiusMeters: 0.18,
    hasTrail: true,
  },
  cluster_rocket: {
    kind: 'cluster_rocket',
    massKg: 80,
    muzzleVelocity: 65,
    dragPerSecond: 0.06,
    hitDamage: 30, hitRadiusMeters: 0.4,
    explosive: true, explosionPeak: 100, explosionRadiusMeters: 1.6,
    clusterSubmunitions: 8,
    maxLifeSeconds: 8.0,
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
    muzzleVelocity: 30,
    dragPerSecond: 0.10,
    hitDamage: 30, hitRadiusMeters: 0.3,
    explosive: true, explosionPeak: 90, explosionRadiusMeters: 1.4,
    clusterSubmunitions: 0,
    maxLifeSeconds: 4.0,
    colorR: 1.00, colorG: 0.70, colorB: 0.30,
    visualLengthMeters: 0.5, visualRadiusMeters: 0.08,
    hasTrail: true,
  },
  tank_shell: {
    kind: 'tank_shell',
    massKg: 18,
    muzzleVelocity: 180,
    dragPerSecond: 0.03,
    hitDamage: 80, hitRadiusMeters: 0.5,
    explosive: true, explosionPeak: 240, explosionRadiusMeters: 2.8,
    clusterSubmunitions: 0,
    maxLifeSeconds: 4.0,
    colorR: 1.00, colorG: 0.80, colorB: 0.45,
    visualLengthMeters: 0.55, visualRadiusMeters: 0.07,
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
}

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

/** Standard gravity used for ballistic integration — matches Units.ts so unit + projectile drop look consistent. */
export const PROJECTILE_GRAVITY = 9.81;

export class ProjectileManager {
  readonly projectiles: Projectile[] = [];
  /** Impacts that occurred this tick — drained by Game after each `tick`. */
  readonly pendingImpacts: ProjectileImpact[] = [];
  private nextId = 1;

  /**
   * Launch a projectile from `(x,y,z)` along the unit-vector `(dx,dy,dz)` at the
   * configured muzzle velocity. `velocityScale` lets a weapon dial the speed
   * (e.g. a sub-charge load) without editing the projectile catalog.
   */
  spawn(
    kind: ProjectileKind,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    ownerId: number,
    velocityScale = 1,
  ): Projectile {
    const cfg = PROJECTILES[kind];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const speed = cfg.muzzleVelocity * velocityScale;
    const p: Projectile = {
      id: this.nextId++,
      kind,
      x, y, z,
      vx: (dx / dl) * speed,
      vy: (dy / dl) * speed,
      vz: (dz / dl) * speed,
      dragPerSecond: cfg.dragPerSecond,
      massKg: cfg.massKg,
      age: 0,
      maxLifeSeconds: cfg.maxLifeSeconds,
      ownerId,
      dead: false,
    };
    this.projectiles.push(p);
    return p;
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
      // Cache previous position so we can ray-cast the swept segment.
      const px = p.x, py = p.y, pz = p.z;

      // Gravity is applied to vertical velocity; horizontal components only see drag.
      p.vy -= PROJECTILE_GRAVITY * dt;
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
    // Sweep dead.
    let w = 0;
    for (let r = 0; r < this.projectiles.length; r++) {
      const p = this.projectiles[r]!;
      if (!p.dead) this.projectiles[w++] = p;
    }
    this.projectiles.length = w;
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
  ): { x: number; y: number; z: number }[] {
    const cfg = PROJECTILES[kind];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const speed = cfg.muzzleVelocity * velocityScale;
    let vx = (dx / dl) * speed;
    let vy = (dy / dl) * speed;
    let vz = (dz / dl) * speed;
    const drag = cfg.dragPerSecond;
    const out: { x: number; y: number; z: number }[] = [{ x, y, z }];
    let cx = x, cy = y, cz = z;
    for (let i = 0; i < samples; i++) {
      vy -= PROJECTILE_GRAVITY * sampleDt;
      const dragScale = Math.exp(-drag * sampleDt);
      vx *= dragScale; vy *= dragScale; vz *= dragScale;
      const sx = vx * sampleDt, sy = vy * sampleDt, sz = vz * sampleDt;
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
