/**
 * Weapon and projectile catalogs.
 *
 * `ProjectileSpec` describes a flying object — its mass, muzzle velocity, drag,
 * and what it does on impact (single-voxel hit, explosion, or mid-air cluster
 * burst). `WeaponSpec` describes a launcher — what projectile it fires, how
 * fast, with what spread, and what platforms it can mount on.
 *
 * Real-world ballistic numbers (bullet mass, muzzle velocity, calibre) are used
 * as the starting point so the relative behaviours feel right — a 9mm pistol
 * round drops noticeably over the engagement range, a 7.62mm sniper round
 * arrives almost flat, an RPG warhead arcs and explodes. Drag and gravity are
 * kept simple (quadratic drag + constant g) so the integration is cheap.
 */

export type ProjectileKind = 'bullet' | 'rocket' | 'cluster_rocket' | 'bomblet';

export interface ProjectileSpec {
  /** Stable id used as a key into `PROJECTILES`. */
  id: string;
  kind: ProjectileKind;
  /** Calibre / diameter in millimetres (real bullets and rocket bodies). */
  caliberMm: number;
  /** Mass in kilograms. Drives the drag term and "feel" of the round. */
  massKg: number;
  /** Muzzle / launch velocity in m/s. */
  muzzleVelocity: number;
  /**
   * Quadratic drag coefficient combined with mass: a_drag = -dragK * |v| * v.
   * Higher values bleed velocity faster. 0 disables drag entirely.
   *
   * For bullets we use a small but non-zero value so very long shots taper off;
   * rockets get a touch more so they don't go ballistic indefinitely.
   */
  dragK: number;
  /** Visual tracer / body colour (linear sRGB 0..1). */
  trailR: number; trailG: number; trailB: number;
  /** Length of the rendered streak in metres — bullets are short, rockets long. */
  trailLengthM: number;
  /**
   * Single-voxel impact damage (peakDamage fed to `damageSphere`) and the radius
   * of that hit in metres. Bullets tend to be tiny radius but high peak; rockets
   * usually rely on `explosionRadiusM` instead and leave these small.
   */
  impactRadiusM: number;
  impactPeak: number;
  /**
   * Explosion radius (metres) and peak damage on impact / fuse. 0 = no explosion
   * (plain bullets). Rockets and cluster bomblets carry warheads.
   */
  explosionRadiusM: number;
  explosionPeak: number;
  /**
   * Cluster munition: when the fuse expires, spawn `bombletCount` of these
   * children in a hemispherical spray. `bombletSpec` is the id of a child
   * `ProjectileSpec` (must exist in `PROJECTILES`). 0 = no cluster behaviour.
   */
  bombletCount: number;
  bombletSpec?: string;
  /**
   * Time in seconds after launch before the cluster fuse triggers. 0 means the
   * cluster only splits on impact. Mid-air cluster opens (>0) cover a wide area.
   */
  fuseTime: number;
  /** Hard timeout — projectile despawns past this age regardless. */
  maxLifeSeconds: number;
}

/**
 * Catalog of every projectile in the game. Keep ids stable — they are stored
 * in weapon specs and persisted on live projectiles. Numbers are tuned in
 * `tests/projectiles.spec.ts`.
 *
 * Standard bullet calibres reuse real military / civilian designations:
 *   - 9mm   — typical pistol round (9x19 Parabellum)
 *   - 5.56mm — assault rifle round (5.56x45 NATO)
 *   - 7.62mm — battle rifle / sniper / general-purpose machine gun (7.62x51 NATO)
 *
 * Rockets:
 *   - 40mm  — RPG warhead (shoulder-launched)
 *   - 220mm — cluster rocket (vehicle MLRS-style)
 *   - 60mm  — cluster bomblet (children of the 220mm cluster rocket)
 *   - 300mm — heavy rocket (vehicle-mounted, single big warhead)
 */
export const PROJECTILES: Record<string, ProjectileSpec> = {
  '9mm': {
    id: '9mm',
    kind: 'bullet',
    caliberMm: 9,
    massKg: 0.0075,
    muzzleVelocity: 370,
    dragK: 0.0008,
    trailR: 1.0, trailG: 0.85, trailB: 0.40,
    trailLengthM: 0.6,
    impactRadiusM: 0.10,
    impactPeak: 35,
    explosionRadiusM: 0,
    explosionPeak: 0,
    bombletCount: 0,
    fuseTime: 0,
    maxLifeSeconds: 2.0,
  },
  '5.56mm': {
    id: '5.56mm',
    kind: 'bullet',
    caliberMm: 5.56,
    massKg: 0.004,
    muzzleVelocity: 940,
    dragK: 0.00035,
    trailR: 1.0, trailG: 0.95, trailB: 0.55,
    trailLengthM: 1.2,
    impactRadiusM: 0.10,
    impactPeak: 28,
    explosionRadiusM: 0,
    explosionPeak: 0,
    bombletCount: 0,
    fuseTime: 0,
    maxLifeSeconds: 2.0,
  },
  '7.62mm': {
    id: '7.62mm',
    kind: 'bullet',
    caliberMm: 7.62,
    massKg: 0.0095,
    muzzleVelocity: 830,
    dragK: 0.00045,
    trailR: 1.0, trailG: 0.80, trailB: 0.30,
    trailLengthM: 1.4,
    impactRadiusM: 0.13,
    impactPeak: 55,
    explosionRadiusM: 0,
    explosionPeak: 0,
    bombletCount: 0,
    fuseTime: 0,
    maxLifeSeconds: 3.0,
  },
  rpg40mm: {
    id: 'rpg40mm',
    kind: 'rocket',
    caliberMm: 40,
    massKg: 2.6,
    muzzleVelocity: 115,
    dragK: 0.002,
    trailR: 1.0, trailG: 0.55, trailB: 0.20,
    trailLengthM: 2.5,
    impactRadiusM: 0.20,
    impactPeak: 60,
    explosionRadiusM: 2.4,
    explosionPeak: 200,
    bombletCount: 0,
    fuseTime: 0,
    maxLifeSeconds: 6.0,
  },
  cluster220mm: {
    id: 'cluster220mm',
    kind: 'cluster_rocket',
    caliberMm: 220,
    massKg: 38,
    muzzleVelocity: 180,
    dragK: 0.0009,
    trailR: 1.0, trailG: 0.40, trailB: 0.20,
    trailLengthM: 4.0,
    impactRadiusM: 0.20,
    impactPeak: 30,
    explosionRadiusM: 1.6,
    explosionPeak: 90,
    bombletCount: 9,
    bombletSpec: 'bomblet60mm',
    fuseTime: 1.6,
    maxLifeSeconds: 8.0,
  },
  bomblet60mm: {
    id: 'bomblet60mm',
    kind: 'bomblet',
    caliberMm: 60,
    massKg: 1.2,
    muzzleVelocity: 25,
    dragK: 0.0025,
    trailR: 1.0, trailG: 0.65, trailB: 0.35,
    trailLengthM: 1.2,
    impactRadiusM: 0.15,
    impactPeak: 30,
    explosionRadiusM: 1.6,
    explosionPeak: 90,
    bombletCount: 0,
    fuseTime: 0,
    maxLifeSeconds: 5.0,
  },
  heavy300mm: {
    id: 'heavy300mm',
    kind: 'rocket',
    caliberMm: 300,
    massKg: 95,
    muzzleVelocity: 220,
    dragK: 0.0006,
    trailR: 1.0, trailG: 0.30, trailB: 0.10,
    trailLengthM: 6.0,
    impactRadiusM: 0.30,
    impactPeak: 80,
    explosionRadiusM: 4.5,
    explosionPeak: 320,
    bombletCount: 0,
    fuseTime: 0,
    maxLifeSeconds: 10.0,
  },
};

export type WeaponId =
  | 'pistol'
  | 'rifle'
  | 'sniper'
  | 'machine_gun'
  | 'rpg'
  | 'cluster_launcher'
  | 'heavy_launcher';

export type WeaponMount = 'soldier' | 'vehicle';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  /** Id into `PROJECTILES`. */
  projectile: string;
  /** Rounds per second. Machine guns use a high value here. */
  fireRate: number;
  /**
   * Standard deviation of the muzzle direction in radians. 0 = perfectly
   * accurate, larger = wider cone. Sniper is tightest; machine gun is loosest.
   */
  spread: number;
  /** Maximum effective engagement range in metres. */
  rangeM: number;
  /** Soldier-held vs vehicle-mounted. Drives where the muzzle is. */
  mount: WeaponMount;
  /**
   * Muzzle position relative to the unit origin. `forward` is along the unit's
   * heading (negative Z in model space), `up` is body-local +Y, and `right` is
   * the right-hand offset (positive = unit's right side). Only used for spawn
   * placement / the visible muzzle flash; the trajectory is still gravity +
   * drag from the spawn point.
   */
  muzzleForward: number;
  muzzleUp: number;
  muzzleRight: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    projectile: '9mm',
    fireRate: 3.5,
    spread: 0.04,
    rangeM: 35,
    mount: 'soldier',
    muzzleForward: 0.45,
    muzzleUp: 0.85,
    muzzleRight: 0.30,
  },
  rifle: {
    id: 'rifle',
    name: 'Assault Rifle',
    projectile: '5.56mm',
    fireRate: 8.0,
    spread: 0.025,
    rangeM: 60,
    mount: 'soldier',
    muzzleForward: 0.65,
    muzzleUp: 0.85,
    muzzleRight: 0.30,
  },
  sniper: {
    id: 'sniper',
    name: 'Sniper Rifle',
    projectile: '7.62mm',
    fireRate: 0.7,
    spread: 0.004,
    rangeM: 110,
    mount: 'soldier',
    muzzleForward: 0.80,
    muzzleUp: 0.85,
    muzzleRight: 0.30,
  },
  machine_gun: {
    id: 'machine_gun',
    name: 'Machine Gun',
    projectile: '7.62mm',
    fireRate: 13.0,
    spread: 0.05,
    rangeM: 70,
    mount: 'soldier',
    muzzleForward: 0.75,
    muzzleUp: 0.85,
    muzzleRight: 0.30,
  },
  rpg: {
    id: 'rpg',
    name: 'RPG Launcher',
    projectile: 'rpg40mm',
    fireRate: 0.5,
    spread: 0.02,
    rangeM: 60,
    mount: 'soldier',
    muzzleForward: 0.85,
    muzzleUp: 1.05,
    muzzleRight: 0.20,
  },
  cluster_launcher: {
    id: 'cluster_launcher',
    name: 'Cluster Rocket Launcher',
    projectile: 'cluster220mm',
    fireRate: 0.4,
    spread: 0.04,
    rangeM: 90,
    mount: 'vehicle',
    muzzleForward: 1.20,
    muzzleUp: 1.80,
    muzzleRight: 0.0,
  },
  heavy_launcher: {
    id: 'heavy_launcher',
    name: 'Heavy Rocket Launcher',
    projectile: 'heavy300mm',
    fireRate: 0.2,
    spread: 0.025,
    rangeM: 130,
    mount: 'vehicle',
    muzzleForward: 1.40,
    muzzleUp: 2.10,
    muzzleRight: 0.0,
  },
};

/** Convenience — get a projectile spec by id, throwing if unknown. */
export function projectileSpec(id: string): ProjectileSpec {
  const spec = PROJECTILES[id];
  if (!spec) throw new Error(`Unknown projectile spec: ${id}`);
  return spec;
}

/** Convenience — get a weapon spec by id, throwing if unknown. */
export function weaponSpec(id: WeaponId): WeaponSpec {
  const spec = WEAPONS[id];
  if (!spec) throw new Error(`Unknown weapon: ${id}`);
  return spec;
}
