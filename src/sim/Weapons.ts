import { ProjectileKind, PROJECTILES, ProjectileManager, aimBallistic, muzzleWorldPosition, PROJECTILE_GRAVITY } from './Projectiles';
import { Unit } from './Units';

/**
 * Weapon catalogue. Each weapon fires a specific `ProjectileKind` (defined in
 * Projectiles.ts) with its own cooldown, range, spread, and burst behaviour.
 *
 * Naming follows the in-game role rather than a real model number:
 *   pistol            — sidearm, low velocity, low range
 *   rifle             — standard 5.56 service rifle
 *   battle_rifle      — heavier 7.62 rifle
 *   sniper            — long-range 12.7 mm rifle
 *   machinegun        — high rate-of-fire 7.62 (rifle bullets, as requested)
 *   rpg               — soldier-portable rocket
 *   cluster_launcher  — vehicle platform, dispenses bomblets at impact
 *   heavy_rocket      — vehicle platform, single big HE rocket
 */

export type WeaponKind =
  | 'pistol'
  | 'rifle'
  | 'battle_rifle'
  | 'sniper'
  | 'machinegun'
  | 'rpg'
  | 'cluster_launcher'
  | 'heavy_rocket';

export interface WeaponSpec {
  kind: WeaponKind;
  projectile: ProjectileKind;
  /** Time between shots / bursts in seconds. */
  cooldownSeconds: number;
  /** Engagement range in metres. Beyond this the unit holds fire. */
  rangeMeters: number;
  /** Random spread cone half-angle in radians, applied to the aim direction. */
  spreadRad: number;
  /** Number of shots per trigger-pull (MGs fire bursts). */
  burstCount: number;
  /** Delay between shots within a burst in seconds. */
  burstShotInterval: number;
  /** Muzzle offset relative to unit's local frame: forward (toward -Z), up, right. */
  muzzle: { forward: number; up: number; right: number };
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  pistol: {
    kind: 'pistol', projectile: 'bullet_9mm',
    cooldownSeconds: 0.45, rangeMeters: 35,
    spreadRad: 0.030, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.45, up: 0.95, right: 0.30 },
  },
  rifle: {
    kind: 'rifle', projectile: 'bullet_5_56mm',
    cooldownSeconds: 0.18, rangeMeters: 90,
    spreadRad: 0.012, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.65, up: 0.85, right: 0.30 },
  },
  battle_rifle: {
    kind: 'battle_rifle', projectile: 'bullet_7_62mm',
    cooldownSeconds: 0.32, rangeMeters: 120,
    spreadRad: 0.010, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.70, up: 0.85, right: 0.30 },
  },
  sniper: {
    kind: 'sniper', projectile: 'bullet_12_7mm',
    cooldownSeconds: 1.4, rangeMeters: 220,
    spreadRad: 0.002, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.85, up: 0.85, right: 0.30 },
  },
  // Machine guns fire 7.62mm rifle bullets in 5-round bursts, per the spec.
  machinegun: {
    kind: 'machinegun', projectile: 'bullet_7_62mm',
    cooldownSeconds: 0.55, rangeMeters: 110,
    spreadRad: 0.025, burstCount: 5, burstShotInterval: 0.07,
    muzzle: { forward: 0.75, up: 0.80, right: 0.30 },
  },
  rpg: {
    kind: 'rpg', projectile: 'rocket_rpg',
    cooldownSeconds: 3.5, rangeMeters: 80,
    spreadRad: 0.020, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.80, up: 1.05, right: 0.30 },
  },
  // Vehicle platform: cluster rocket. Mounted high on a tank turret.
  cluster_launcher: {
    kind: 'cluster_launcher', projectile: 'rocket_cluster',
    cooldownSeconds: 6.0, rangeMeters: 180,
    spreadRad: 0.025, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.30, up: 1.80, right: 0.0 },
  },
  // Vehicle platform: single heavy rocket.
  heavy_rocket: {
    kind: 'heavy_rocket', projectile: 'rocket_heavy',
    cooldownSeconds: 4.5, rangeMeters: 220,
    spreadRad: 0.015, burstCount: 1, burstShotInterval: 0,
    muzzle: { forward: 0.30, up: 1.80, right: 0.0 },
  },
};

/**
 * Apply a small pseudo-random spread cone to a unit-vector aim direction. We
 * use a deterministic hash on (id, t) so the spread is stable enough across
 * frames to be testable but still feels organic.
 */
export function applySpread(
  ax: number, ay: number, az: number,
  spreadRad: number,
  rngHash: number,
): { x: number; y: number; z: number } {
  if (spreadRad <= 0) return { x: ax, y: ay, z: az };
  // Two independent pseudo-random offsets in [-1, +1].
  const r1 = ((Math.sin(rngHash * 12.9898) + 1) % 1) * 2 - 1;
  const r2 = ((Math.sin(rngHash * 78.233 + 4.0) + 1) % 1) * 2 - 1;
  // Build any orthonormal basis around (a). Pick a non-parallel helper, then
  // cross-product twice. Falls back to world-up only if forward is mostly Y.
  let hx = 0, hy = 1, hz = 0;
  if (Math.abs(ay) > 0.95) { hx = 1; hy = 0; hz = 0; }
  // right = a × help, up = right × a — both unit-length (a is already unit).
  let rxv = ay * hz - az * hy;
  let ryv = az * hx - ax * hz;
  let rzv = ax * hy - ay * hx;
  let rl = Math.hypot(rxv, ryv, rzv);
  if (rl < 1e-6) { rxv = 1; ryv = 0; rzv = 0; rl = 1; }
  rxv /= rl; ryv /= rl; rzv /= rl;
  const uxv = ryv * az - rzv * ay;
  const uyv = rzv * ax - rxv * az;
  const uzv = rxv * ay - ryv * ax;
  const ox = (rxv * r1 + uxv * r2) * spreadRad;
  const oy = (ryv * r1 + uyv * r2) * spreadRad;
  const oz = (rzv * r1 + uzv * r2) * spreadRad;
  const nx = ax + ox;
  const ny = ay + oy;
  const nz = az + oz;
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx * inv, y: ny * inv, z: nz * inv };
}

/**
 * Per-weapon firing state carried on a Unit. Tracks the recharge timer plus burst
 * progress so MGs spread their 5-round burst over a few hundred ms instead of
 * dumping the whole magazine in a single frame.
 */
export interface WeaponState {
  weapon: WeaponKind;
  /** Seconds until ready to fire again (or until next burst shot). */
  cooldown: number;
  /** Remaining shots in the current burst (0 = idle, ready to start a new burst). */
  burstShotsLeft: number;
  /** Optional engagement target in world coordinates. */
  fireTarget: { x: number; y: number; z: number } | null;
}

export function makeWeaponState(weapon: WeaponKind): WeaponState {
  return { weapon, cooldown: 0, burstShotsLeft: 0, fireTarget: null };
}

/** Default weapon for each unit kind — soldiers carry small arms, vehicles get heavy stuff. */
export function defaultWeaponFor(kind: 'soldier' | 'tank' | 'tunneler' | 'worm', soldierIdx: number): WeaponKind | null {
  if (kind === 'tank') return 'cluster_launcher';
  if (kind === 'tunneler' || kind === 'worm') return null;  // diggers don't fight
  // Spread soldier loadouts so a fresh barracks isn't all rifles. The cycle goes
  // rifle / battle rifle / MG / sniper / pistol / RPG, so each new soldier picks
  // up the next one and we get a varied squad without any explicit production rule.
  const cycle: WeaponKind[] = ['rifle', 'battle_rifle', 'machinegun', 'sniper', 'pistol', 'rpg'];
  return cycle[soldierIdx % cycle.length]!;
}

/**
 * Per-tick weapon update. Called from Game tick once per unit. Returns true when
 * a shot was actually fired this frame so the caller can play a sound / spawn a
 * muzzle flash if it wants.
 */
export function tickWeapon(
  unit: Unit,
  state: WeaponState,
  projectiles: ProjectileManager,
  dt: number,
): boolean {
  if (state.cooldown > 0) state.cooldown -= dt;
  if (!state.fireTarget) {
    state.burstShotsLeft = 0;
    return false;
  }
  const spec = WEAPONS[state.weapon];
  const muzzle = muzzleWorldPosition(unit, spec.muzzle.forward, spec.muzzle.up, spec.muzzle.right);
  const t = state.fireTarget;
  // Out-of-range — just hold fire (don't lose the target, the caller might walk us closer).
  const dist = Math.hypot(t.x - muzzle.x, t.y - muzzle.y, t.z - muzzle.z);
  if (dist > spec.rangeMeters) return false;

  if (state.cooldown > 0) return false;

  const projSpec = PROJECTILES[spec.projectile];
  // Solve elevation for the lower-arc trajectory; fall back to straight-line aim
  // when the target is genuinely out of ballistic reach (e.g. dy huge for v0).
  const aim = aimBallistic(
    muzzle.x, muzzle.y, muzzle.z,
    t.x, t.y, t.z,
    projSpec.muzzleVelocity,
    PROJECTILE_GRAVITY * projSpec.gravityScale,
  ) ?? unitVector(t.x - muzzle.x, t.y - muzzle.y, t.z - muzzle.z);

  // Hash the current frame's RNG seed off the unit + the burst index so spread
  // varies per shot within a burst.
  const burstIdx = spec.burstCount - state.burstShotsLeft;
  const seed = unit.id * 7919 + Math.floor(unit.distanceWalked * 100) + burstIdx * 131;
  const dir = applySpread(aim.dx, aim.dy, aim.dz, spec.spreadRad, seed);

  const v0 = projSpec.muzzleVelocity;
  projectiles.spawn(
    spec.projectile,
    muzzle.x, muzzle.y, muzzle.z,
    dir.x * v0, dir.y * v0, dir.z * v0,
    unit.id,
  );

  // Burst handling: first shot of a fresh trigger-pull seeds the burst counter.
  if (state.burstShotsLeft <= 0) state.burstShotsLeft = spec.burstCount;
  state.burstShotsLeft -= 1;
  if (state.burstShotsLeft > 0 && spec.burstShotInterval > 0) {
    state.cooldown = spec.burstShotInterval;
  } else {
    state.cooldown = spec.cooldownSeconds;
    state.burstShotsLeft = 0;
  }
  return true;
}

function unitVector(x: number, y: number, z: number): { dx: number; dy: number; dz: number } {
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return { dx: 0, dy: 1, dz: 0 };
  const inv = 1 / len;
  return { dx: x * inv, dy: y * inv, dz: z * inv };
}
