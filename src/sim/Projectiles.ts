import { VOXEL_SIZE, WORLD_X, WORLD_Y, WORLD_Z } from '../voxel/types';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { raycastVoxel } from '../voxel/Raycast';
import { Unit, UnitManager } from './Units';

/**
 * Ballistic projectiles. Each projectile is a point mass with mass, drag, and a
 * payload it deposits at the impact point.
 *
 *   Bullets    — small, very fast, deal damage to a single voxel column on impact.
 *   Explosives — RPGs and rockets; carve a sphere of voxels and damage nearby units.
 *   Cluster    — same as explosive but also dispenses N child projectiles from the
 *                impact point, each detonating after their own short fuse.
 *
 * Bullet calibers and muzzle velocities follow real-world figures (9mm pistol,
 * 5.56 / 7.62 NATO rifle, 12.7mm sniper). Rocket figures are rough — RPG-7
 * sustainer ~115 m/s, a 122 mm Grad rocket ~700 m/s; we underclock the latter
 * to keep the sim observable on small voxel maps.
 *
 * Gravity drop is real: any projectile whose `gravityScale > 0` accelerates
 * downward at GRAVITY * scale. Bullets keep scale ≈ 1 so the standard "drop a
 * few cm at 100 m" behaviour shows up; rockets keep scale low (motor still
 * burning) so they fly straight enough to be useful at this scale.
 */

export const PROJECTILE_GRAVITY = 9.81;

/** Calibers expressed in mm so the catalogue lines up with real ammunition. */
export type BulletCaliberMm =
  | 9      // pistol
  | 5.56   // rifle / MG
  | 7.62   // rifle / MG (heavier)
  | 12.7;  // sniper (.50 BMG)

export type ProjectileKind =
  | 'bullet_9mm'
  | 'bullet_5_56mm'
  | 'bullet_7_62mm'
  | 'bullet_12_7mm'
  | 'rocket_rpg'
  | 'rocket_heavy'
  | 'rocket_cluster'
  | 'cluster_bomblet';

export interface ProjectileSpec {
  kind: ProjectileKind;
  /** Bullet vs explosive vs cluster — determines impact behaviour. */
  category: 'bullet' | 'explosive' | 'cluster';
  /** Projectile mass in kilograms. Bullets fractions of a kg; rockets several kg. */
  massKg: number;
  /** Initial muzzle velocity in m/s. Real-world figures for bullets; sub-real for rockets. */
  muzzleVelocity: number;
  /** Caliber in millimetres. Used for visual scaling and as documentation. */
  caliberMm: number;
  /** Linear drag coefficient (1/s). Velocity decays at v -= dragCoef * v * dt. 0 disables drag. */
  dragCoef: number;
  /** Gravity multiplier — 1 = full real gravity. Rockets keep this low so they fly flat. */
  gravityScale: number;
  /** Lifetime in seconds before self-destruct. */
  lifeSeconds: number;
  /** Sphere radius in metres for the impact carve. 0 = pinpoint hit (single voxel column). */
  explodeRadiusMeters: number;
  /** Peak voxel damage at the centre of the impact sphere (or the single-voxel hit). */
  peakDamage: number;
  /** Damage dealt to units inside `explodeRadiusMeters`, scaled by 1 - dist/radius. */
  unitDamage: number;
  /** Cluster only: spawn this many submunitions at impact. */
  clusterCount?: number;
  clusterChild?: ProjectileKind;
  /** Initial speed of cluster submunitions, m/s. */
  clusterEjectSpeed?: number;
  /** Visual radius in metres (used by the projectile renderer). */
  visualRadiusMeters: number;
  /** RGB tint in 0..1 for the projectile and its tracer. */
  color: { r: number; g: number; b: number };
}

const BULLET_DRAG = 0.10;       // bullets bleed velocity gradually
const ROCKET_DRAG = 0.02;       // rockets keep their speed under sustainer thrust

export const PROJECTILES: Record<ProjectileKind, ProjectileSpec> = {
  // 9 mm Parabellum pistol round.
  bullet_9mm: {
    kind: 'bullet_9mm', category: 'bullet',
    massKg: 0.008, muzzleVelocity: 360, caliberMm: 9,
    dragCoef: BULLET_DRAG, gravityScale: 1.0,
    lifeSeconds: 3.0,
    explodeRadiusMeters: 0, peakDamage: 30, unitDamage: 18,
    visualRadiusMeters: 0.04,
    color: { r: 1.0, g: 0.85, b: 0.40 },
  },
  // 5.56x45mm NATO rifle round.
  bullet_5_56mm: {
    kind: 'bullet_5_56mm', category: 'bullet',
    massKg: 0.004, muzzleVelocity: 940, caliberMm: 5.56,
    dragCoef: BULLET_DRAG, gravityScale: 1.0,
    lifeSeconds: 3.0,
    explodeRadiusMeters: 0, peakDamage: 35, unitDamage: 22,
    visualRadiusMeters: 0.035,
    color: { r: 1.0, g: 0.80, b: 0.30 },
  },
  // 7.62x51mm NATO — used by battle rifles and most general-purpose MGs.
  bullet_7_62mm: {
    kind: 'bullet_7_62mm', category: 'bullet',
    massKg: 0.0095, muzzleVelocity: 850, caliberMm: 7.62,
    dragCoef: BULLET_DRAG, gravityScale: 1.0,
    lifeSeconds: 3.5,
    explodeRadiusMeters: 0, peakDamage: 50, unitDamage: 32,
    visualRadiusMeters: 0.045,
    color: { r: 1.0, g: 0.75, b: 0.25 },
  },
  // 12.7x99mm (.50 BMG) — anti-materiel sniper round.
  bullet_12_7mm: {
    kind: 'bullet_12_7mm', category: 'bullet',
    massKg: 0.042, muzzleVelocity: 890, caliberMm: 12.7,
    dragCoef: BULLET_DRAG * 0.7, gravityScale: 1.0,
    lifeSeconds: 5.0,
    explodeRadiusMeters: 0.4, peakDamage: 110, unitDamage: 80,
    visualRadiusMeters: 0.06,
    color: { r: 1.0, g: 0.65, b: 0.20 },
  },
  // RPG-7 style rocket — soldier-launched HEAT.
  rocket_rpg: {
    kind: 'rocket_rpg', category: 'explosive',
    massKg: 2.4, muzzleVelocity: 115, caliberMm: 85,
    dragCoef: ROCKET_DRAG, gravityScale: 0.25,
    lifeSeconds: 6.0,
    explodeRadiusMeters: 2.2, peakDamage: 180, unitDamage: 120,
    visualRadiusMeters: 0.18,
    color: { r: 0.30, g: 0.30, b: 0.34 },
  },
  // Vehicle-platform heavy rocket (122 mm Grad-style HE).
  rocket_heavy: {
    kind: 'rocket_heavy', category: 'explosive',
    massKg: 18, muzzleVelocity: 220, caliberMm: 122,
    dragCoef: ROCKET_DRAG, gravityScale: 0.4,
    lifeSeconds: 8.0,
    explodeRadiusMeters: 4.0, peakDamage: 240, unitDamage: 180,
    visualRadiusMeters: 0.32,
    color: { r: 0.35, g: 0.20, b: 0.18 },
  },
  // Vehicle-platform cluster rocket — explodes mid/on impact then dispenses bomblets.
  rocket_cluster: {
    kind: 'rocket_cluster', category: 'cluster',
    massKg: 25, muzzleVelocity: 250, caliberMm: 220,
    dragCoef: ROCKET_DRAG, gravityScale: 0.4,
    lifeSeconds: 8.0,
    explodeRadiusMeters: 1.8, peakDamage: 90, unitDamage: 60,
    clusterCount: 9, clusterChild: 'cluster_bomblet', clusterEjectSpeed: 8,
    visualRadiusMeters: 0.40,
    color: { r: 0.45, g: 0.40, b: 0.25 },
  },
  // Submunitions dispensed by the cluster rocket. Smaller, short-fused HE.
  cluster_bomblet: {
    kind: 'cluster_bomblet', category: 'explosive',
    massKg: 0.8, muzzleVelocity: 8, caliberMm: 40,
    dragCoef: 0.05, gravityScale: 1.0,
    lifeSeconds: 1.6,
    explodeRadiusMeters: 1.2, peakDamage: 80, unitDamage: 45,
    visualRadiusMeters: 0.08,
    color: { r: 0.85, g: 0.70, b: 0.20 },
  },
};

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  /** World position in metres. */
  x: number; y: number; z: number;
  /** Velocity in m/s. */
  vx: number; vy: number; vz: number;
  /** Seconds remaining before self-destruct. */
  life: number;
  /** Unit id of the firer; suppresses self-impacts on the launching unit. */
  ownerId: number;
  /** True after a detonation event has been emitted (kept around 1 frame for renderer). */
  dead: boolean;
}

/**
 * Ballistic firing-solution: muzzle position `m`, target `t`, muzzle speed `v0`,
 * gravity `g`. Returns a unit-vector aiming direction whose elevation gives the
 * lower-arc trajectory that lands on the target, or `null` if the target is
 * out of range. When out of range the caller can fall back to firing flat.
 *
 * Convention: y is up. Range is the horizontal distance √((tx-mx)² + (tz-mz)²).
 */
export function aimBallistic(
  mx: number, my: number, mz: number,
  tx: number, ty: number, tz: number,
  v0: number,
  g: number = PROJECTILE_GRAVITY,
): { dx: number; dy: number; dz: number } | null {
  const dx = tx - mx;
  const dz = tz - mz;
  const dy = ty - my;
  const range = Math.hypot(dx, dz);
  if (range < 1e-4) {
    // Straight up/down — no horizontal solution.
    const sign = dy >= 0 ? 1 : -1;
    return { dx: 0, dy: sign, dz: 0 };
  }
  const v2 = v0 * v0;
  const v4 = v2 * v2;
  const disc = v4 - g * (g * range * range + 2 * dy * v2);
  if (disc < 0) return null;
  // Lower arc has the smaller tan(θ) = (v² − √disc) / (g · range).
  const tanTheta = (v2 - Math.sqrt(disc)) / (g * range);
  // Aim direction: horizontal unit vector in xz, plus vertical component tan(θ).
  const inv = 1 / range;
  const ax = dx * inv;
  const az = dz * inv;
  const ay = tanTheta;
  const len = Math.hypot(ax, ay, az);
  return { dx: ax / len, dy: ay / len, dz: az / len };
}

/**
 * Result emitted by the projectile manager when one detonates. The Game wires this
 * to actual voxel carving + unit-damage so the manager itself stays world-agnostic
 * and easy to test.
 */
export interface DetonationEvent {
  kind: ProjectileKind;
  /** Impact position in metres. */
  x: number; y: number; z: number;
  /** Surface normal of the voxel that was hit (zero vector when self-destructing in air). */
  nx: number; ny: number; nz: number;
  /** True when this came from a fuse timeout in mid-air rather than a voxel impact. */
  airburst: boolean;
}

export class ProjectileManager {
  projectiles: Projectile[] = [];
  private nextId = 1;

  /** Spawn a projectile with explicit position + velocity. */
  spawn(
    kind: ProjectileKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    ownerId: number,
  ): Projectile {
    const spec = PROJECTILES[kind];
    const p: Projectile = {
      id: this.nextId++,
      kind, x, y, z, vx, vy, vz,
      life: spec.lifeSeconds,
      ownerId,
      dead: false,
    };
    this.projectiles.push(p);
    return p;
  }

  /**
   * Spawn `count` cluster submunitions at the impact point with velocities scattered
   * over the upper hemisphere.
   */
  spawnCluster(parent: Projectile, x: number, y: number, z: number): void {
    const spec = PROJECTILES[parent.kind];
    if (!spec.clusterChild || !spec.clusterCount) return;
    const ejectV = spec.clusterEjectSpeed ?? 6;
    for (let i = 0; i < spec.clusterCount; i++) {
      // Even-ish distribution across an upper hemisphere using deterministic golden-angle.
      const u = (i + 0.5) / spec.clusterCount;             // 0..1
      const phi = u * Math.PI * 0.5;                       // 0..π/2 from horizontal
      const theta = i * 2.39996;                           // golden angle in rad
      const cosPhi = Math.cos(phi);
      const dirX = cosPhi * Math.cos(theta);
      const dirY = Math.sin(phi);
      const dirZ = cosPhi * Math.sin(theta);
      this.spawn(
        spec.clusterChild,
        x, y, z,
        dirX * ejectV, dirY * ejectV, dirZ * ejectV,
        parent.ownerId,
      );
    }
  }

  /**
   * Advance all live projectiles by `dt`. For each one we:
   *   1. Apply linear drag and gravity to velocity.
   *   2. Cast from old position to new position through the voxel grid.
   *   3. If we hit a voxel, emit a detonation at that voxel face.
   *   4. Otherwise step position; if life expires, emit an airburst detonation.
   *
   * Detonations are returned to the caller so it can carve voxels / damage units.
   * Dead projectiles are removed from the list at the end of the tick.
   */
  tick(dt: number, world: VoxelWorld | null): DetonationEvent[] {
    const events: DetonationEvent[] = [];
    for (const p of this.projectiles) {
      if (p.dead) continue;
      const spec = PROJECTILES[p.kind];

      // Drag (linear) + gravity (downward).
      const dragK = Math.exp(-spec.dragCoef * dt);
      p.vx *= dragK;
      p.vy *= dragK;
      p.vz *= dragK;
      p.vy -= PROJECTILE_GRAVITY * spec.gravityScale * dt;

      const sx = p.x, sy = p.y, sz = p.z;
      const dx = p.vx * dt;
      const dy = p.vy * dt;
      const dz = p.vz * dt;
      const dist = Math.hypot(dx, dy, dz);

      // Voxel hit-test along the segment.
      let hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number; tMeters: number } | null = null;
      if (world && dist > 0) {
        const inv = 1 / dist;
        const dirX = dx * inv;
        const dirY = dy * inv;
        const dirZ = dz * inv;
        const r = raycastVoxel(world, { x: sx, y: sy, z: sz }, { x: dirX, y: dirY, z: dirZ }, dist);
        if (r) hit = r;
      }

      if (hit) {
        // Detonate at the hit point — back off one voxel so the sphere/centre carve sits
        // half inside the target voxel rather than entirely outside it.
        const inv = 1 / Math.max(1e-6, dist);
        const tx = sx + dx * inv * hit.tMeters;
        const ty = sy + dy * inv * hit.tMeters;
        const tz = sz + dz * inv * hit.tMeters;
        p.x = tx; p.y = ty; p.z = tz;
        p.dead = true;
        events.push({
          kind: p.kind,
          x: tx, y: ty, z: tz,
          nx: hit.nx, ny: hit.ny, nz: hit.nz,
          airburst: false,
        });
        continue;
      }

      p.x = sx + dx;
      p.y = sy + dy;
      p.z = sz + dz;
      p.life -= dt;

      // Out-of-bounds: just kill silently (no detonation, projectile fell off the world).
      if (
        p.x < 0 || p.y < 0 || p.z < 0 ||
        p.x >= WORLD_X * VOXEL_SIZE ||
        p.y >= WORLD_Y * VOXEL_SIZE ||
        p.z >= WORLD_Z * VOXEL_SIZE
      ) {
        p.dead = true;
        continue;
      }

      if (p.life <= 0) {
        p.dead = true;
        events.push({
          kind: p.kind,
          x: p.x, y: p.y, z: p.z,
          nx: 0, ny: 1, nz: 0,
          airburst: true,
        });
      }
    }
    // Compact the list — drop everything tagged dead.
    if (events.length > 0 || this.projectiles.some(p => p.dead)) {
      this.projectiles = this.projectiles.filter(p => !p.dead);
    }
    return events;
  }

  /**
   * Apply explosion damage to units within the projectile's blast radius. Falls off
   * linearly with distance. Returns the number of units that took damage.
   */
  static damageUnitsInRadius(
    units: UnitManager,
    x: number, y: number, z: number,
    radiusMeters: number,
    peakDamage: number,
  ): number {
    if (radiusMeters <= 0 || peakDamage <= 0) return 0;
    let hit = 0;
    const r2 = radiusMeters * radiusMeters;
    for (const u of units.units) {
      const dx = u.x - x;
      const dy = u.y + 0.5 - y;
      const dz = u.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const fall = 1 - Math.sqrt(d2) / radiusMeters;
      const dmg = peakDamage * fall;
      u.hp -= dmg;
      hit++;
    }
    return hit;
  }
}

/**
 * Helper: given a unit and a target world position, work out the muzzle position in
 * world space using the unit's heading and the weapon's local-frame muzzle offset.
 *
 *   forward = -Z in unit-local coords (matches the rest of the rendering convention).
 *   right   = +X in unit-local coords.
 *   up      = +Y in unit-local coords.
 *
 * The unit's pitch is intentionally NOT applied — soldiers/vehicles aim by rotating
 * just the gun, not the whole chassis.
 */
export function muzzleWorldPosition(
  unit: Unit,
  forwardM: number, upM: number, rightM: number,
): { x: number; y: number; z: number } {
  const ch = Math.cos(unit.heading);
  const sh = Math.sin(unit.heading);
  // Local +X (right) → world (cos h, 0, -sin h); local -Z (forward) → world (-sin h, 0, -cos h).
  const fx = -sh, fz = -ch;
  const rx =  ch, rz = -sh;
  return {
    x: unit.x + fx * forwardM + rx * rightM,
    y: unit.y + upM,
    z: unit.z + fz * forwardM + rz * rightM,
  };
}
