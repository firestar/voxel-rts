import { VoxelWorld } from '../voxel/VoxelWorld';
import { raycastVoxel, VoxelHit } from '../voxel/Raycast';
import { GRAVITY } from './gravity';
import { VOXEL_SIZE } from '../voxel/types';

/**
 * Real-world ammunition mapped onto RTS-friendly numbers. Calibers and masses are
 * close to the real round (9mm Para is 7.5 g, 7.62×51 NATO is ~9.5 g, .50 BMG is
 * ~42 g); muzzle velocities and warhead yields are tuned for the slice.
 *
 * Bullet flight uses the same `GRAVITY` constant the units use, so a horizontally
 * fired round drops `½·g·t²` over distance — sniper shots at long range need a
 * pinch of elevation, RPGs are a real arc.
 */
export type ProjectileKind =
  | 'bullet_9mm'
  | 'bullet_762'
  | 'bullet_127'
  | 'rocket_rpg'
  | 'rocket_cluster'
  | 'rocket_heavy'
  | 'submunition';

export type ProjectileFamily = 'bullet' | 'explosive' | 'cluster' | 'submunition';

export interface ProjectileSpec {
  caliberMm: number;
  /** Round mass in kg. Reference value — only matters for a future drag model. */
  massKg: number;
  /** Reference muzzle velocity in m/s. The weapon firing this round normally
   *  matches this, but a weapon may override it (rifle and machinegun share
   *  `bullet_762` but the MG sustains its rate at the same muzzle speed). */
  refMuzzleMS: number;
  family: ProjectileFamily;
  /** Sphere radius (meters) for the on-impact `damageSphere`. */
  impactRadiusMeters: number;
  /** Peak damage at the center of the impact sphere. */
  impactPeak: number;
  /** Maximum life in seconds (no-hit despawn). */
  maxLifeSec: number;
  /** Drag coefficient applied per second as exp(-drag·dt). 0 = no drag.
   *  We use a tiny value for bullets (real air drag is much higher but at RTS
   *  ranges the drop term dominates) and a larger value for rockets so a
   *  cluster-shell's submunitions slow into a satisfying rain. */
  dragPerSec: number;
  /** Cluster only: how many submunitions spawn on impact. */
  clusterChildren?: number;
  clusterChildKind?: ProjectileKind;
  /** Random outward speed kick (m/s) added to each submunition. */
  clusterSpreadMS?: number;
  /** Submunition: time before its damage arms (so they don't blow up inside the
   *  parent shell at the moment of separation). */
  armDelaySec?: number;
  /** Renderer hints. */
  color: number;
  sizeMeters: number;
}

export const PROJECTILES: Record<ProjectileKind, ProjectileSpec> = {
  // --- Bullets -------------------------------------------------------------
  bullet_9mm: {
    caliberMm: 9.0, massKg: 0.0075, refMuzzleMS: 370,
    family: 'bullet',
    impactRadiusMeters: 0.18, impactPeak: 35, maxLifeSec: 4.0,
    dragPerSec: 0.04,
    color: 0xffd866, sizeMeters: 0.06,
  },
  bullet_762: {
    caliberMm: 7.62, massKg: 0.0095, refMuzzleMS: 830,
    family: 'bullet',
    impactRadiusMeters: 0.25, impactPeak: 60, maxLifeSec: 4.0,
    dragPerSec: 0.03,
    color: 0xfff099, sizeMeters: 0.07,
  },
  bullet_127: {
    caliberMm: 12.7, massKg: 0.042, refMuzzleMS: 890,
    family: 'bullet',
    impactRadiusMeters: 0.45, impactPeak: 140, maxLifeSec: 5.0,
    dragPerSec: 0.02,
    color: 0xfff7c2, sizeMeters: 0.10,
  },

  // --- Soldier-launched explosive -----------------------------------------
  rocket_rpg: {
    caliberMm: 85.0, massKg: 2.25, refMuzzleMS: 250,
    family: 'explosive',
    impactRadiusMeters: 3.0, impactPeak: 90, maxLifeSec: 6.0,
    dragPerSec: 0.05,
    color: 0xff5533, sizeMeters: 0.28,
  },

  // --- Vehicle-launched cluster ------------------------------------------
  rocket_cluster: {
    caliberMm: 152.0, massKg: 18.0, refMuzzleMS: 150,
    family: 'cluster',
    // Cluster shell itself does a small detonation, then sprays children.
    impactRadiusMeters: 1.5, impactPeak: 40, maxLifeSec: 12.0,
    dragPerSec: 0.10,
    clusterChildren: 6,
    clusterChildKind: 'submunition',
    clusterSpreadMS: 14,
    color: 0xff8844, sizeMeters: 0.45,
  },

  // --- Vehicle-launched heavy HE rocket ----------------------------------
  rocket_heavy: {
    caliberMm: 220.0, massKg: 60.0, refMuzzleMS: 180,
    family: 'explosive',
    impactRadiusMeters: 5.0, impactPeak: 150, maxLifeSec: 12.0,
    dragPerSec: 0.08,
    color: 0xff3322, sizeMeters: 0.55,
  },

  // --- Cluster-spawned submunition ---------------------------------------
  submunition: {
    caliberMm: 40.0, massKg: 0.5, refMuzzleMS: 0,
    family: 'submunition',
    impactRadiusMeters: 1.2, impactPeak: 55, maxLifeSec: 5.0,
    dragPerSec: 0.06,
    armDelaySec: 0.15,
    color: 0xffaa44, sizeMeters: 0.18,
  },
};

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  /** Owner unit id. Currently informational — projectiles don't filter on it. */
  ownerUnitId: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Remaining time alive in seconds. */
  life: number;
  /** Submunitions arm after a small delay to avoid self-detonation at separation. */
  armed: boolean;
  /** Time since spawn, used for the arm delay. */
  age: number;
}

export interface ProjectileImpact {
  projectile: Projectile;
  hit: VoxelHit | null;
  /** True when the impact came from `life <= 0`, not a voxel hit. */
  timedOut: boolean;
  /** World-space impact point (meters). For voxel hits this is the entry point. */
  x: number; y: number; z: number;
}

export class ProjectileManager {
  readonly projectiles: Projectile[] = [];
  private nextId = 1;

  spawn(
    kind: ProjectileKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    ownerUnitId: number,
  ): Projectile {
    const spec = PROJECTILES[kind];
    const p: Projectile = {
      id: this.nextId++,
      kind,
      ownerUnitId,
      x, y, z,
      vx, vy, vz,
      life: spec.maxLifeSec,
      armed: spec.armDelaySec === undefined,
      age: 0,
    };
    this.projectiles.push(p);
    return p;
  }

  /**
   * Step every projectile forward by `dt`, applying gravity + drag, raycasting against
   * the live voxel world for collision, and invoking `onImpact` the first time a
   * projectile hits something solid (or its life expires). Despawned projectiles are
   * removed from the pool in-place.
   *
   * `onImpact` is responsible for the actual damage: ProjectileManager is a pure
   * physics + lifetime owner; the Game wires the damage callback so it can also
   * spawn debris, request nav rebuilds, etc.
   */
  tick(
    dt: number,
    world: VoxelWorld,
    onImpact: (impact: ProjectileImpact) => void,
  ): void {
    const survivors: Projectile[] = [];
    for (const p of this.projectiles) {
      if (this.stepOne(p, dt, world, onImpact)) survivors.push(p);
    }
    this.projectiles.length = 0;
    for (const p of survivors) this.projectiles.push(p);
  }

  /**
   * Advance one projectile. Returns true if it should remain alive.
   *
   * Single per-frame integration: drag and gravity are applied once, then a
   * single ray cast checks the segment from the old position to the new one.
   * For RTS-scale frame times (~1/60 s) the within-frame arc due to gravity is
   * sub-voxel (½·g·dt² ≈ 3 mm at dt = 1/60), so cutting the segment into
   * many sub-rays would be wasted work. The raycast budget is extended by one
   * voxel beyond the per-frame travel — this is a known artifact of the
   * Amanatides & Woo step-then-break pattern in `raycastVoxel`, which can
   * skip the very last cell along a fixed-budget ray.
   */
  private stepOne(
    p: Projectile,
    dt: number,
    world: VoxelWorld,
    onImpact: (impact: ProjectileImpact) => void,
  ): boolean {
    const spec = PROJECTILES[p.kind];
    p.age += dt;
    if (!p.armed && spec.armDelaySec !== undefined && p.age >= spec.armDelaySec) {
      p.armed = true;
    }

    // Drag (exponential decay) then gravity. Real bullet drop comes from the
    // gravity term — at 830 m/s a 7.62 round drops ~30 cm over 200 m of
    // horizontal travel (½·g·t² with g=22 m/s² — see decisions.md).
    const drag = spec.dragPerSec > 0 ? Math.exp(-spec.dragPerSec * dt) : 1;
    p.vx *= drag;
    p.vy *= drag;
    p.vz *= drag;
    p.vy -= GRAVITY * dt;

    const stepX = p.vx * dt;
    const stepY = p.vy * dt;
    const stepZ = p.vz * dt;
    const stepLen = Math.hypot(stepX, stepY, stepZ);
    if (stepLen > 1e-6) {
      const inv = 1 / stepLen;
      const dirX = stepX * inv, dirY = stepY * inv, dirZ = stepZ * inv;
      // Probe one extra voxel past the per-frame distance so the raycast's
      // last-cell-skip artifact never causes us to tunnel through a wall.
      // Treat anything beyond `stepLen` as no-hit so the projectile only
      // flags an impact for collisions actually inside this frame's segment.
      const probeLen = stepLen + VOXEL_SIZE * 2;
      const hit = raycastVoxel(
        world,
        { x: p.x, y: p.y, z: p.z },
        { x: dirX, y: dirY, z: dirZ },
        probeLen,
      );
      if (hit && hit.tMeters <= stepLen + 1e-4 && p.armed) {
        const hx = p.x + dirX * hit.tMeters;
        const hy = p.y + dirY * hit.tMeters;
        const hz = p.z + dirZ * hit.tMeters;
        p.x = hx; p.y = hy; p.z = hz;
        onImpact({ projectile: p, hit, timedOut: false, x: hx, y: hy, z: hz });
        return false;
      }
      p.x += stepX;
      p.y += stepY;
      p.z += stepZ;
    }

    p.life -= dt;
    if (p.life <= 0) {
      onImpact({ projectile: p, hit: null, timedOut: true, x: p.x, y: p.y, z: p.z });
      return false;
    }
    return true;
  }
}
