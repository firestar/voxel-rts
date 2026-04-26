import { ProjectileSpec, projectileSpec } from './Weapons';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { raycastVoxel } from '../voxel/Raycast';
import { Unit } from './Units';
import { VOXEL_SIZE } from '../voxel/types';

/**
 * Acceleration of gravity applied to projectiles in m/s². The unit GRAVITY in
 * Units.ts is "snappy" (22) so the simulation feels weighty; for projectiles we
 * use the real-world value so the bullet-drop tables stay close to ballistic
 * tables and the math reads naturally in tests.
 */
export const PROJECTILE_GRAVITY = 9.81;

export interface Projectile {
  id: number;
  spec: ProjectileSpec;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  dead: boolean;
  /**
   * Id of the unit that fired this projectile. Used to skip self-hits — a
   * soldier that just fired shouldn't take damage from his own muzzle. -1 when
   * the projectile is a child (cluster bomblet) or otherwise ownerless.
   */
  ownerUnitId: number;
}

export interface ExplosionEvent {
  x: number; y: number; z: number;
  radiusMeters: number;
  peak: number;
  /** Material of the centre voxel before destruction, for debris colouring. */
  material: number;
  /** Number of voxels destroyed, for debris counts. */
  destroyedCount: number;
  /** True when this explosion was a cluster mid-air burst (no ground impact). */
  midAir: boolean;
}

/**
 * Sink for explosion side-effects (debris bursts, screenshake hooks, etc.).
 * The projectile manager already applies the voxel damage itself; this callback
 * is purely "something dramatic just happened at (x,y,z)".
 */
export type ExplosionSink = (e: ExplosionEvent) => void;

/**
 * Manages every flying projectile. Per-frame:
 *   1. Apply gravity + quadratic drag, integrate position via a sub-stepped
 *      ray segment so even fast bullets cannot tunnel through a thin wall.
 *   2. Test that segment against the voxel world (Amanatides & Woo raycast).
 *   3. Test that segment against unit bounding spheres (excluding the owner).
 *   4. On hit: apply damage, fire optional explosion + sink callback, mark dead.
 *   5. Cluster fuse: when age >= fuseTime, spawn `bombletCount` children in a
 *      hemispherical spray and kill the parent.
 *   6. Despawn projectiles past `maxLifeSeconds`.
 *
 * Live projectiles live in a flat array and are compacted in place at the end
 * of each tick. Dead entries are cheap to iterate over once and skip.
 */
export class ProjectileManager {
  projectiles: Projectile[] = [];
  /** Most recent unit that took a projectile hit, kept for tests/UI. */
  lastUnitHit: Unit | null = null;
  private nextId = 1;

  /**
   * Spawn a single projectile with the given spec, origin, and unit-vector
   * direction. The projectile starts at the muzzle velocity from the spec; if
   * the caller wants a different speed they can pass `speedOverride`.
   */
  spawn(
    specId: string,
    x: number, y: number, z: number,
    dirX: number, dirY: number, dirZ: number,
    ownerUnitId: number,
    speedOverride?: number,
  ): Projectile {
    const spec = projectileSpec(specId);
    const speed = speedOverride ?? spec.muzzleVelocity;
    const len = Math.hypot(dirX, dirY, dirZ) || 1;
    const inv = 1 / len;
    const p: Projectile = {
      id: this.nextId++,
      spec,
      x, y, z,
      vx: dirX * inv * speed,
      vy: dirY * inv * speed,
      vz: dirZ * inv * speed,
      age: 0,
      dead: false,
      ownerUnitId,
    };
    this.projectiles.push(p);
    return p;
  }

  /**
   * Advance every projectile by `dt` seconds. `units` is the live list (so we
   * can test hits against unit bounding spheres + apply hp damage); `world` is
   * the voxel world for ray collision and damage; `onExplosion` fires whenever
   * a projectile explodes (impact or fuse) so the caller can spawn debris and
   * ask for a nav rebuild.
   */
  tick(
    dt: number,
    world: VoxelWorld,
    units: Unit[],
    onExplosion: ExplosionSink,
  ): void {
    const sub = subSteps(dt);
    const subDt = dt / sub;
    for (const p of this.projectiles) {
      if (p.dead) continue;
      for (let s = 0; s < sub && !p.dead; s++) {
        this.step(p, subDt, world, units, onExplosion);
      }
    }
    // Compact: drop dead entries so the live list stays bounded.
    if (this.projectiles.some(p => p.dead)) {
      this.projectiles = this.projectiles.filter(p => !p.dead);
    }
  }

  private step(
    p: Projectile,
    dt: number,
    world: VoxelWorld,
    units: Unit[],
    onExplosion: ExplosionSink,
  ): void {
    p.age += dt;
    if (p.age >= p.spec.maxLifeSeconds) { p.dead = true; return; }

    // Quadratic drag: a = -dragK * |v| * v. Drag coefficient is folded into a
    // single number per spec so we don't need cross-section / Cd / mass split.
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const dragMag = p.spec.dragK * speed;
    p.vx -= p.vx * dragMag * dt;
    p.vy -= p.vy * dragMag * dt;
    p.vz -= p.vz * dragMag * dt;
    p.vy -= PROJECTILE_GRAVITY * dt;

    // Cluster fuse: parent rocket bursts open mid-air after `fuseTime`. Children
    // are spawned in a spray oriented around the parent's velocity vector.
    if (p.spec.bombletCount > 0 && p.age >= p.spec.fuseTime) {
      this.detonateCluster(p, onExplosion);
      p.dead = true;
      return;
    }

    // Integrate over the sub-step. We then ray-march that segment so we don't
    // tunnel through thin walls even when the projectile is going fast.
    const dx = p.vx * dt;
    const dy = p.vy * dt;
    const dz = p.vz * dt;
    const segLen = Math.hypot(dx, dy, dz);
    if (segLen < 1e-6) return;

    // Voxel hit?
    const dirX = dx / segLen, dirY = dy / segLen, dirZ = dz / segLen;
    const hit = raycastVoxel(world, { x: p.x, y: p.y, z: p.z }, { x: dirX, y: dirY, z: dirZ }, segLen);
    let unitHit: { unit: Unit; t: number } | null = null;
    for (const u of units) {
      if (u.id === p.ownerUnitId) continue;
      const sphere = unitHitRadius(u);
      const t = raySphereIntersect(p.x, p.y, p.z, dirX, dirY, dirZ, u.x, u.y + sphere.cy, u.z, sphere.r);
      if (t === null || t > segLen) continue;
      if (unitHit === null || t < unitHit.t) unitHit = { unit: u, t };
    }

    // Whichever happens first along the segment wins. Voxel hit is in metres,
    // so direct comparison.
    if (unitHit && (!hit || unitHit.t <= hit.tMeters)) {
      const hx = p.x + dirX * unitHit.t;
      const hy = p.y + dirY * unitHit.t;
      const hz = p.z + dirZ * unitHit.t;
      this.handleUnitImpact(p, unitHit.unit, hx, hy, hz, world, onExplosion);
      return;
    }
    if (hit) {
      const hx = p.x + dirX * hit.tMeters;
      const hy = p.y + dirY * hit.tMeters;
      const hz = p.z + dirZ * hit.tMeters;
      this.handleVoxelImpact(p, world, hx, hy, hz, onExplosion);
      return;
    }

    p.x += dx; p.y += dy; p.z += dz;
  }

  private handleVoxelImpact(
    p: Projectile,
    world: VoxelWorld,
    hx: number, hy: number, hz: number,
    onExplosion: ExplosionSink,
  ): void {
    const cx = hx / VOXEL_SIZE, cy = hy / VOXEL_SIZE, cz = hz / VOXEL_SIZE;
    let material = 0;
    let destroyedCount = 0;
    if (p.spec.impactPeak > 0 && p.spec.impactRadiusM > 0) {
      const r = p.spec.impactRadiusM / VOXEL_SIZE;
      const res = world.damageSphere(cx, cy, cz, r, p.spec.impactPeak);
      destroyedCount += res.destroyed.length;
      if (res.destroyed.length > 0) {
        material = res.destroyed[Math.floor(res.destroyed.length / 2)]!.material;
      }
    }
    if (p.spec.explosionRadiusM > 0 && p.spec.explosionPeak > 0) {
      const r = p.spec.explosionRadiusM / VOXEL_SIZE;
      const res = world.damageSphere(cx, cy, cz, r, p.spec.explosionPeak);
      destroyedCount += res.destroyed.length;
      if (material === 0 && res.destroyed.length > 0) {
        material = res.destroyed[Math.floor(res.destroyed.length / 2)]!.material;
      }
      onExplosion({
        x: hx, y: hy, z: hz,
        radiusMeters: p.spec.explosionRadiusM,
        peak: p.spec.explosionPeak,
        material,
        destroyedCount,
        midAir: false,
      });
    }
    if (p.spec.bombletCount > 0) {
      this.detonateCluster(p, onExplosion);
    }
    p.dead = true;
  }

  private handleUnitImpact(
    p: Projectile,
    target: Unit,
    hx: number, hy: number, hz: number,
    world: VoxelWorld,
    onExplosion: ExplosionSink,
  ): void {
    target.hp = Math.max(0, target.hp - p.spec.impactPeak);
    this.lastUnitHit = target;
    if (p.spec.explosionRadiusM > 0 && p.spec.explosionPeak > 0) {
      const cx = hx / VOXEL_SIZE, cy = hy / VOXEL_SIZE, cz = hz / VOXEL_SIZE;
      const r = p.spec.explosionRadiusM / VOXEL_SIZE;
      const res = world.damageSphere(cx, cy, cz, r, p.spec.explosionPeak);
      const material = res.destroyed.length > 0
        ? res.destroyed[Math.floor(res.destroyed.length / 2)]!.material
        : 0;
      onExplosion({
        x: hx, y: hy, z: hz,
        radiusMeters: p.spec.explosionRadiusM,
        peak: p.spec.explosionPeak,
        material,
        destroyedCount: res.destroyed.length,
        midAir: false,
      });
    }
    if (p.spec.bombletCount > 0) {
      this.detonateCluster(p, onExplosion);
    }
    p.dead = true;
  }

  /**
   * Mid-air or contact cluster opening. `bombletCount` child projectiles are
   * spawned around the parent's velocity vector with a randomised hemispherical
   * spread, each carrying its own warhead via the bomblet spec.
   */
  private detonateCluster(p: Projectile, onExplosion: ExplosionSink): void {
    const childId = p.spec.bombletSpec;
    if (!childId) return;
    const child = projectileSpec(childId);
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    // Forward = parent velocity; if the parent was at rest pick straight down.
    let fx = speed > 1e-3 ? p.vx / speed : 0;
    let fy = speed > 1e-3 ? p.vy / speed : -1;
    let fz = speed > 1e-3 ? p.vz / speed : 0;
    // Build a right + up basis perpendicular to forward.
    let rx = -fz, ry = 0, rz = fx;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;

    onExplosion({
      x: p.x, y: p.y, z: p.z,
      radiusMeters: 0.1,
      peak: 0,
      material: 0,
      destroyedCount: 0,
      midAir: true,
    });

    for (let i = 0; i < p.spec.bombletCount; i++) {
      // Spread cone of ±35° around the forward direction.
      const cone = 0.6;
      const a = (i / p.spec.bombletCount) * Math.PI * 2;
      const radial = cone * (0.4 + 0.6 * Math.random());
      const dirX = fx + (rx * Math.cos(a) + ux * Math.sin(a)) * radial;
      const dirY = fy + (ry * Math.cos(a) + uy * Math.sin(a)) * radial;
      const dirZ = fz + (rz * Math.cos(a) + uz * Math.sin(a)) * radial;
      const cp: Projectile = {
        id: this.nextId++,
        spec: child,
        x: p.x, y: p.y, z: p.z,
        vx: 0, vy: 0, vz: 0,
        age: 0, dead: false,
        ownerUnitId: -1,
      };
      const dl = Math.hypot(dirX, dirY, dirZ) || 1;
      cp.vx = (dirX / dl) * child.muzzleVelocity;
      cp.vy = (dirY / dl) * child.muzzleVelocity;
      cp.vz = (dirZ / dl) * child.muzzleVelocity;
      this.projectiles.push(cp);
    }
  }

  /** Drop everything (used by tests + restart). */
  clear(): void {
    this.projectiles.length = 0;
  }
}

/**
 * Choose how many sub-steps to take this frame so a projectile cannot move more
 * than ~1 m per sub-step. The voxel raycast handles arbitrary segment lengths,
 * but unit-collision is per-segment closest approach and gets less stable as
 * the segment grows past a unit's footprint.
 */
function subSteps(_dt: number): number {
  return 2;
}

interface UnitHitSphere { r: number; cy: number; }

/**
 * Bounding sphere used for projectile-vs-unit hit tests. `cy` is the height of
 * the sphere centre above the unit's feet (its `y`); `r` is the sphere radius.
 * Tuned so a soldier is roughly torso+head, a tank/tunneler is a wider hull.
 */
export function unitHitRadius(u: Unit): UnitHitSphere {
  switch (u.kind) {
    case 'soldier':  return { r: 0.55, cy: 0.95 };
    case 'tank':     return { r: 1.40, cy: 1.10 };
    case 'tunneler': return { r: 1.80, cy: 1.30 };
    case 'worm':     return { r: 1.05, cy: 0.70 };
  }
}

/**
 * Standard ray vs sphere closed-form intersect. Returns the smallest positive
 * t (metres along the ray) where the ray enters the sphere, or null if it
 * misses. Caller checks t against the segment length itself.
 */
function raySphereIntersect(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  r: number,
): number | null {
  const ex = ox - cx, ey = oy - cy, ez = oz - cz;
  // Ray dir is unit-length so a = 1.
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = -b - sq;
  if (t1 >= 0) return t1;
  const t2 = -b + sq;
  if (t2 >= 0) return t2;
  return null;
}
