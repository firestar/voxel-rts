import { GRAVITY } from './gravity';
import { ProjectileKind, ProjectileManager } from './Projectiles';

/**
 * Weapons sit between a unit and its projectiles. Each weapon picks the projectile
 * kind, the muzzle speed (overrides the projectile's reference value when needed),
 * the time between shots, and the offset on the firing unit where the muzzle sits.
 *
 * Soldier-held weapons live at the rifle muzzle in the body model (right-hand,
 * forward of the chest). Vehicle-mounted weapons fire from the turret roof. The
 * unit's heading rotates `forward`/`right`; `up` is world-space.
 */
export type WeaponKind =
  | 'pistol'
  | 'rifle'
  | 'sniper'
  | 'machinegun'
  | 'rpg'
  | 'cluster_rocket'
  | 'heavy_rocket';

export interface WeaponSpec {
  kind: WeaponKind;
  projectile: ProjectileKind;
  /** Muzzle velocity in m/s. Overrides the projectile's reference value, so e.g.
   *  rifle and machinegun share `bullet_762` but the same muzzle speed. */
  muzzleVelocityMS: number;
  /** Seconds between consecutive shots. */
  fireInterval: number;
  /** Muzzle position in unit-local space. `forward` is along the unit's heading
   *  (positive = forward), `up` is world-Y, `right` is the unit's right-hand. */
  muzzleOffset: { forward: number; up: number; right: number };
  /** Maximum effective range in meters. The launch solver returns null beyond
   *  this range even if the round is technically able to fly that far — the
   *  Game layer can use it to gate "fire" commands. */
  maxRangeMeters: number;
  /** Display label, used by the UI / docs. */
  label: string;
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  // --- Soldier-held -------------------------------------------------------
  pistol: {
    kind: 'pistol',
    projectile: 'bullet_9mm',
    muzzleVelocityMS: 370,
    fireInterval: 0.40,
    muzzleOffset: { forward: 0.45, up: 0.85, right: 0.30 },
    maxRangeMeters: 40,
    label: '9mm pistol',
  },
  rifle: {
    kind: 'rifle',
    projectile: 'bullet_762',
    muzzleVelocityMS: 830,
    fireInterval: 0.35,
    muzzleOffset: { forward: 0.50, up: 0.85, right: 0.30 },
    maxRangeMeters: 200,
    label: '7.62mm rifle',
  },
  sniper: {
    kind: 'sniper',
    projectile: 'bullet_127',
    muzzleVelocityMS: 890,
    fireInterval: 1.50,
    muzzleOffset: { forward: 0.55, up: 0.85, right: 0.30 },
    maxRangeMeters: 350,
    label: '12.7mm anti-materiel rifle',
  },
  machinegun: {
    kind: 'machinegun',
    projectile: 'bullet_762',
    muzzleVelocityMS: 830,
    fireInterval: 0.08,
    muzzleOffset: { forward: 0.55, up: 0.80, right: 0.30 },
    maxRangeMeters: 220,
    label: '7.62mm GPMG',
  },
  rpg: {
    kind: 'rpg',
    projectile: 'rocket_rpg',
    muzzleVelocityMS: 250,
    fireInterval: 3.0,
    muzzleOffset: { forward: 0.55, up: 0.95, right: 0.25 },
    maxRangeMeters: 250,
    label: '85mm RPG',
  },

  // --- Vehicle-mounted ----------------------------------------------------
  cluster_rocket: {
    kind: 'cluster_rocket',
    projectile: 'rocket_cluster',
    muzzleVelocityMS: 150,
    fireInterval: 6.0,
    muzzleOffset: { forward: 1.10, up: 1.50, right: 0.0 },
    maxRangeMeters: 220,
    label: '152mm cluster rocket',
  },
  heavy_rocket: {
    kind: 'heavy_rocket',
    projectile: 'rocket_heavy',
    muzzleVelocityMS: 180,
    fireInterval: 8.0,
    muzzleOffset: { forward: 1.10, up: 1.55, right: 0.0 },
    maxRangeMeters: 300,
    label: '220mm heavy rocket',
  },
};

export interface LaunchVelocity {
  vx: number; vy: number; vz: number;
}

/**
 * Closed-form ballistic launch solver under constant gravity, no drag.
 *
 * Given start (sx, sy, sz), target (tx, ty, tz), muzzle speed v, and gravity g,
 * find a velocity vector whose flight (subject to gravity only) passes through
 * the target. Two solutions exist — a low-angle (flat) and high-angle (lobbed)
 * trajectory. We return the low-angle by default (`preferLowAngle = true`)
 * because that's what bullets, RPGs, and direct-fire vehicle rockets want; the
 * caller can ask for the high-angle solution for indirect-fire artillery.
 *
 * Identity used:
 *   tan(θ) = (v² ± √(v⁴ − g(g·d² + 2·dy·v²))) / (g·d)
 * where d is the horizontal distance and dy is the elevation difference.
 *
 * Returns null when the target is out of range at this muzzle speed.
 */
export function computeLaunchVelocity(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  muzzleSpeed: number,
  gravity: number = GRAVITY,
  preferLowAngle = true,
): LaunchVelocity | null {
  const dxz = tx - sx;
  const dyz = tz - sz;
  const horiz = Math.hypot(dxz, dyz);
  const dy = ty - sy;
  const v = muzzleSpeed;
  const g = gravity;

  // Degenerate: target is directly above / below.
  if (horiz < 1e-4) {
    if (Math.abs(dy) > (v * v) / (2 * g)) return null;
    // Straight-up shot.
    return { vx: 0, vy: dy >= 0 ? v : -v, vz: 0 };
  }

  const v2 = v * v;
  const v4 = v2 * v2;
  const disc = v4 - g * (g * horiz * horiz + 2 * dy * v2);
  if (disc < 0) return null; // Out of range.
  const root = Math.sqrt(disc);
  const numHigh = v2 + root;
  const numLow = v2 - root;
  const denom = g * horiz;
  const tanLow = numLow / denom;
  const tanHigh = numHigh / denom;
  const tanTheta = preferLowAngle ? tanLow : tanHigh;

  // Decompose into components.
  const cosTheta = 1 / Math.sqrt(1 + tanTheta * tanTheta);
  const sinTheta = tanTheta * cosTheta;
  const horizSpeed = v * cosTheta;
  const vy = v * sinTheta;
  const invH = 1 / horiz;
  const vx = horizSpeed * dxz * invH;
  const vz = horizSpeed * dyz * invH;
  return { vx, vy, vz };
}

/**
 * Compute the world-space muzzle position for a unit holding the given weapon.
 * The unit's heading rotates the local `forward` and `right` axes; `up` is the
 * world Y-axis. Heading convention matches Units.ts: `heading = 0` faces -Z, so
 * forward = (-sin h, 0, -cos h), right = (cos h, 0, -sin h).
 */
export function muzzlePosition(
  unitX: number, unitY: number, unitZ: number, heading: number,
  weapon: WeaponSpec,
): { x: number; y: number; z: number } {
  const fx = -Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = -Math.sin(heading);
  const o = weapon.muzzleOffset;
  return {
    x: unitX + fx * o.forward + rx * o.right,
    y: unitY + o.up,
    z: unitZ + fz * o.forward + rz * o.right,
  };
}

/**
 * High-level fire: compute muzzle position, solve launch velocity, spawn the
 * projectile. Returns true on success, false if the target is out of range or
 * unreachable at the weapon's muzzle speed.
 *
 * The `weaponCooldown` check is the caller's responsibility — `fireAt` always
 * fires.
 */
export function fireAt(
  unit: { x: number; y: number; z: number; heading: number; id: number },
  weapon: WeaponSpec,
  tx: number, ty: number, tz: number,
  projectiles: ProjectileManager,
): boolean {
  const m = muzzlePosition(unit.x, unit.y, unit.z, unit.heading, weapon);
  const horiz = Math.hypot(tx - m.x, tz - m.z);
  if (horiz > weapon.maxRangeMeters) return false;
  const v = computeLaunchVelocity(m.x, m.y, m.z, tx, ty, tz, weapon.muzzleVelocityMS);
  if (!v) return false;
  projectiles.spawn(weapon.projectile, m.x, m.y, m.z, v.vx, v.vy, v.vz, unit.id);
  return true;
}
