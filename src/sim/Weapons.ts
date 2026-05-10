import { ProjectileKind } from './Projectiles';

/**
 * Weapon catalog. Each weapon links a launcher (held by a soldier or mounted
 * on a vehicle) to one ammunition type from the projectile catalog. The
 * `aimedBy` field tells the unit-firing logic *what* on the unit needs to
 * point at the target before the shot is allowed:
 *
 *   - 'hull'   — the unit's body heading must align with the firing vector.
 *                Soldiers carrying small arms work this way.
 *   - 'turret' — the unit has an independently-yawing turret (or rocket pod)
 *                that pivots to the firing vector while the hull keeps doing
 *                whatever the path tells it to. Tanks + rocket trucks. The
 *                shot only fires once the turret is within `aimToleranceRad`
 *                of the firing vector — explicitly the user-requested
 *                "tank turret faces target before it fires" behaviour.
 */
export type WeaponKind =
  | 'pistol'
  | 'rifle'
  | 'sniper'
  | 'machine_gun'
  | 'rpg_launcher'
  | 'mortar'
  | 'tank_cannon'
  | 'rocket_pod'
  | 'cluster_pod'
  | 'building_turret'
  | 'aa_turret'
  | 'aa_flak'
  | 'silo_launcher';

export type WeaponMount = 'hull' | 'turret';

export interface WeaponConfig {
  kind: WeaponKind;
  /** Display label for HUD readouts. */
  label: string;
  /** Projectile this weapon launches. */
  projectile: ProjectileKind;
  /** What part of the host unit must be aimed at the target before the shot fires. */
  aimedBy: WeaponMount;
  /**
   * Maximum allowed angular error between the aiming part and the firing
   * vector before the shot is allowed. Tighter for precision weapons (sniper)
   * and rockets; looser for spray-and-pray small arms.
   */
  aimToleranceRad: number;
  /**
   * Angular slew rate, radians per second, of the AIMING part. For 'turret'
   * mounts this is the turret's yaw rate (independent of the hull); for 'hull'
   * mounts the unit's existing `turnRateRadPerSec` is used and this is ignored.
   */
  aimSlewRadPerSec: number;
  /** Cooldown between shots, seconds. */
  fireInterval: number;
  /** Maximum effective engagement range in meters (just a soft cap, no enforcement here). */
  rangeMeters: number;
  /**
   * Cone half-angle of random spread applied to each shot's direction vector.
   * Snipers ~0; pistols and MGs are noticeably loose.
   */
  spreadRad: number;
  /**
   * For burst weapons: shots loosed per trigger pull. Each shot inside the
   * burst is queued at `burstInterval` apart; the next burst can fire after
   * `fireInterval`.
   */
  shotsPerBurst: number;
  burstInterval: number;
  /** Velocity multiplier on the projectile's muzzle velocity. */
  velocityScale: number;
  /**
   * Visual: muzzle flash radius in meters and life in seconds. Bigger / longer
   * for explosive launchers so the player sees a clear backblast on RPG and
   * tank-cannon shots.
   */
  muzzleFlashRadius: number;
  muzzleFlashSeconds: number;
}

export const WEAPONS: Record<WeaponKind, WeaponConfig> = {
  pistol: {
    kind: 'pistol', label: '9 mm pistol',
    projectile: 'bullet_9mm', aimedBy: 'hull',
    aimToleranceRad: 0.10, aimSlewRadPerSec: 6.0,
    fireInterval: 0.45, rangeMeters: 35, spreadRad: 0.05,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.18, muzzleFlashSeconds: 0.06,
  },
  rifle: {
    kind: 'rifle', label: '5.56 mm rifle',
    projectile: 'bullet_5_56mm', aimedBy: 'hull',
    aimToleranceRad: 0.07, aimSlewRadPerSec: 6.0,
    fireInterval: 0.30, rangeMeters: 60, spreadRad: 0.025,
    shotsPerBurst: 3, burstInterval: 0.08,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.22, muzzleFlashSeconds: 0.06,
  },
  sniper: {
    kind: 'sniper', label: '7.62 mm sniper',
    projectile: 'bullet_7_62mm', aimedBy: 'hull',
    aimToleranceRad: 0.025, aimSlewRadPerSec: 3.0,
    fireInterval: 1.6, rangeMeters: 140, spreadRad: 0.004,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.28, muzzleFlashSeconds: 0.08,
  },
  machine_gun: {
    kind: 'machine_gun', label: '5.56 mm machine gun',
    projectile: 'bullet_5_56mm', aimedBy: 'hull',
    aimToleranceRad: 0.12, aimSlewRadPerSec: 5.0,
    fireInterval: 1.2, rangeMeters: 75, spreadRad: 0.05,
    shotsPerBurst: 8, burstInterval: 0.07,
    velocityScale: 0.95,
    muzzleFlashRadius: 0.26, muzzleFlashSeconds: 0.08,
  },
  rpg_launcher: {
    kind: 'rpg_launcher', label: 'RPG launcher',
    projectile: 'rpg', aimedBy: 'hull',
    aimToleranceRad: 0.03, aimSlewRadPerSec: 2.5,
    fireInterval: 4.0, rangeMeters: 70, spreadRad: 0.01,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.7, muzzleFlashSeconds: 0.20,
  },
  mortar: {
    // Indirect-fire infantry mortar. High arc, long cooldown, big terrain
    // dent. The mortar shell carries the same scale of explosive damage as
    // a tank shell but with the slow bouncing arc of the building turret —
    // perfect for digging into a fortified position from outside its line
    // of sight.
    kind: 'mortar', label: 'Light infantry mortar',
    projectile: 'mortar_shell', aimedBy: 'hull',
    aimToleranceRad: 0.05, aimSlewRadPerSec: 2.5,
    fireInterval: 5.5, rangeMeters: 110, spreadRad: 0.03,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.75, muzzleFlashSeconds: 0.18,
  },
  tank_cannon: {
    kind: 'tank_cannon', label: 'Tank cannon',
    // Turret aim — tank yaws its turret to the target while the hull keeps
    // moving along its path. Shot is gated on the turret being within
    // aimToleranceRad of the firing vector ("only fire when the turret has
    // faced the direction").
    projectile: 'tank_shell', aimedBy: 'turret',
    aimToleranceRad: 0.04, aimSlewRadPerSec: 1.2,
    fireInterval: 3.5, rangeMeters: 200, spreadRad: 0.006,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 1.1, muzzleFlashSeconds: 0.22,
  },
  rocket_pod: {
    kind: 'rocket_pod', label: 'Heavy rocket pod',
    projectile: 'heavy_rocket', aimedBy: 'turret',
    aimToleranceRad: 0.05, aimSlewRadPerSec: 1.0,
    fireInterval: 6.0, rangeMeters: 240, spreadRad: 0.02,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.9, muzzleFlashSeconds: 0.25,
  },
  cluster_pod: {
    kind: 'cluster_pod', label: 'Cluster rocket pod',
    projectile: 'cluster_rocket', aimedBy: 'turret',
    aimToleranceRad: 0.06, aimSlewRadPerSec: 1.0,
    fireInterval: 8.0, rangeMeters: 220, spreadRad: 0.03,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.9, muzzleFlashSeconds: 0.25,
  },
  /**
   * Building-mounted defensive turret. Auto-fires at the nearest enemy in
   * range; fires a turret_shell with a noticeable arc (gravity bites hard at
   * the slow projectile catalog). Aim is 'turret' so the visible head yaws to
   * the target while the building stays put.
   */
  building_turret: {
    kind: 'building_turret', label: 'Defensive turret',
    projectile: 'turret_shell', aimedBy: 'turret',
    aimToleranceRad: 0.05, aimSlewRadPerSec: 1.6,
    fireInterval: 2.5, rangeMeters: 90, spreadRad: 0.01,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.9, muzzleFlashSeconds: 0.20,
  },
  /**
   * AA missile launcher. Fires a single large slow interceptor missile at an
   * incoming enemy projectile. Long cooldown (10 s) — the missile is large
   * and its 4 m blast sphere is wide enough to intercept without requiring
   * perfect aim, but one shot per engagement means saturation attacks can
   * overwhelm a single launcher.
   */
  aa_turret: {
    kind: 'aa_turret', label: 'AA Missile Launcher',
    projectile: 'aa_missile', aimedBy: 'turret',
    aimToleranceRad: 0.25, aimSlewRadPerSec: 2.0,
    fireInterval: 10.0, rangeMeters: 150, spreadRad: 0.01,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 1.2, muzzleFlashSeconds: 0.30,
  },
  /**
   * Mobile AA flak gun. Faster cycle than the static AA missile (a vehicle
   * can reposition, so it leans on rate-of-fire rather than per-shot blast
   * to cover its column). Same interceptor projectile, slewed by a much
   * livelier turret so it keeps up with crossing rounds.
   */
  aa_flak: {
    kind: 'aa_flak', label: 'AA Flak Cannon',
    projectile: 'aa_missile', aimedBy: 'turret',
    aimToleranceRad: 0.18, aimSlewRadPerSec: 5.0,
    fireInterval: 2.0, rangeMeters: 110, spreadRad: 0.015,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 0.8, muzzleFlashSeconds: 0.12,
  },
  /**
   * Silo launcher. The heaviest weapon in the catalog — long cooldown, huge
   * blast, and a long range backed by the silo's high launcherMaxStrength. Aim
   * is 'turret' but the silo's "turret" is the missile cluster on top; the
   * model just picks an aim yaw without visible motion.
   */
  silo_launcher: {
    kind: 'silo_launcher', label: 'Heavy silo launcher',
    projectile: 'silo_missile', aimedBy: 'turret',
    aimToleranceRad: 0.10, aimSlewRadPerSec: 0.8,
    fireInterval: 14.0, rangeMeters: 320, spreadRad: 0.02,
    shotsPerBurst: 1, burstInterval: 0,
    velocityScale: 1.0,
    muzzleFlashRadius: 1.6, muzzleFlashSeconds: 0.40,
  },
};

/**
 * Default weapon for each unit kind that bears arms. Returns null for
 * non-combatant units (workers, tunneler, dozer, etc.). Spawn opts on
 * `UnitManager.spawn` can override this — e.g. a soldier can be spawned
 * with `weaponKind: 'sniper'` to swap rifle for sniper.
 */
export function defaultWeaponFor(kind: string): WeaponKind | null {
  switch (kind) {
    case 'soldier':         return 'rifle';
    case 'sniper':          return 'sniper';
    case 'gunner':          return 'machine_gun';
    case 'mortar_soldier':  return 'mortar';
    case 'rocket_soldier':  return 'rpg_launcher';
    case 'tank':            return 'tank_cannon';
    case 'rocket_truck':    return 'cluster_pod';
    case 'aa_vehicle':      return 'aa_flak';
    default:                return null;
  }
}
