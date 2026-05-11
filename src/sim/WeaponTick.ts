import { Unit, UnitManager } from './Units';
import { WEAPONS, WeaponConfig, WeaponMount } from './Weapons';
import { ProjectileManager, PROJECTILES, muzzleOrigin, ProjectileKind } from './Projectiles';

/**
 * True when a same-team peer of `shooter` is on the line from the shooter's
 * muzzle to (tx, ty, tz). Used to gate the trigger so friendly fire is
 * impossible — a soldier won't shoot through another soldier on the way to
 * an enemy. We treat each peer as a body sphere matching the projectile
 * unit-hit test in `Game.unitRayHit`.
 */
function friendlyOnLineOfFire(shooter: Unit, tx: number, ty: number, tz: number, units: UnitManager): boolean {
  const sx = shooter.x;
  const sy = shooter.y + 1.2;
  const sz = shooter.z;
  const dx = tx - sx, dy = ty - sy, dz = tz - sz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-3) return false;
  const inv = 1 / dist;
  const dirX = dx * inv, dirY = dy * inv, dirZ = dz * inv;
  for (const o of units.units) {
    if (o.id === shooter.id) continue;
    if (o.hp <= 0) continue;
    if (o.team !== shooter.team) continue;
    // Body sphere — same conventions as Game.unitRayHit so the gate matches
    // what an actual round would clip on.
    const radius = o.widthMeters * 0.55 + 0.35;
    const cx = o.x;
    const cy = o.y + Math.max(0.7, o.widthMeters * 0.6);
    const cz = o.z;
    const ox = sx - cx, oy = sy - cy, oz = sz - cz;
    const b = ox * dirX + oy * dirY + oz * dirZ;
    const cTerm = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - cTerm;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    let t = -b - sq;
    if (t < 0) t = -b + sq;
    if (t < 0 || t > dist) continue;
    return true;
  }
  return false;
}

/**
 * Per-frame firing pipeline. Walks every armed unit and:
 *
 *   1. Decays cooldowns (`fireCooldown`, `burstShotTimer`).
 *   2. If the unit has a `firingTarget`:
 *      - Slews the AIMING part (hull or turret) toward the target heading at
 *        the weapon's slew rate. For 'turret' weapons the hull is left alone
 *        so movement and aiming are independent; for 'hull' weapons the
 *        unit's existing `turnRateRadPerSec` drives the body.
 *      - If alignment is within the weapon's `aimToleranceRad` AND the
 *        cooldown is 0, fires one shot (or kicks off a burst). The shot
 *        emerges from the muzzle along the *current* aim direction so a
 *        slightly-off-axis turret still makes physical sense.
 *      - Once the trigger pulls, `firingTarget` is cleared. Burst weapons
 *        keep emitting submunitions on `burstShotTimer` until the burst
 *        empties — that's what gives the machine gun its rattle.
 *   3. For 'turret' mounts with no firing target, the turret's yaw is
 *      relaxed back toward the hull heading so it doesn't sit at a stale
 *      angle forever — slow drift, won't fight an active aim.
 *
 * The function emits projectiles via the supplied `projectiles` manager and
 * notifies the caller of muzzle-flash events through `onMuzzleFlash`. The
 * caller (Game) plumbs flashes into the renderer so the visual matches the
 * sim 1:1.
 */
export interface WeaponTickHooks {
  onMuzzleFlash: (
    x: number, y: number, z: number,
    radiusMeters: number, lifeSeconds: number,
    color: { r: number; g: number; b: number },
  ) => void;
}

export function tickWeapons(
  dt: number,
  units: UnitManager,
  projectiles: ProjectileManager,
  hooks: WeaponTickHooks,
): void {
  for (const u of units.units) {
    if (u.weapon === null) {
      // Unarmed — keep turretYaw glued to the hull so any later weapon
      // assignment starts with the turret centred.
      u.turretYaw = u.heading;
      continue;
    }
    const w = WEAPONS[u.weapon];
    if (u.fireCooldown > 0) u.fireCooldown = Math.max(0, u.fireCooldown - dt);
    if (u.burstShotTimer > 0) u.burstShotTimer = Math.max(0, u.burstShotTimer - dt);

    if (u.firingTarget) {
      const tgt = u.firingTarget;
      const dx = tgt.x - u.x;
      const dz = tgt.z - u.z;
      // Convention matches the rest of the sim: heading=0 → forward = -Z, so
      // the heading that points at (dx,dz) is atan2(-dx, -dz).
      const targetYaw = Math.atan2(-dx, -dz);

      // Slew the appropriate part (hull or turret) toward the target heading.
      const slewed = slewToward(u, w, targetYaw, dt);
      if (slewed.aligned) {
        if (u.fireCooldown === 0) {
          // Friendly-fire gate: don't pull the trigger while a same-team peer
          // is between the muzzle and the target.
          if (!friendlyOnLineOfFire(u, tgt.x, tgt.y, tgt.z, units)) {
            fireShot(u, w, projectiles, hooks, tgt.projectileOverride);
            u.firingTarget = null;
            u.fireCooldown = w.fireInterval;
            if (w.shotsPerBurst > 1) {
              u.burstShotsRemaining = w.shotsPerBurst - 1;
              u.burstShotTimer = w.burstInterval;
            }
          } else {
            // Friendly blocking the lane. Drop the firingTarget so
            // auto-engage repicks a different target on the next tick
            // (or the same target after the friendly moves). Without
            // this clear, the unit holds fire indefinitely on a target
            // that's blocked behind an ally — caught by
            // FAILURE_NONCOMBAT_INVULN when the target is a non-combat
            // unit.
            u.firingTarget = null;
            u.autoEngageCooldown = Math.max(u.autoEngageCooldown, 0.3);
          }
        }
      }
    } else {
      // No firing target — but if a burst is in progress, keep emitting
      // follow-up rounds until it empties. The aim direction is whatever the
      // turret/hull currently points at, which is exactly what a burst-firing
      // weapon should do (track the last commanded direction).
      if (u.burstShotsRemaining > 0 && u.burstShotTimer === 0) {
        // Re-check friendly-fire on every burst follow-up — a peer can wander
        // into the cone between rounds. We aim straight along the current
        // hull/turret yaw to a far probe point.
        const yaw = w.aimedBy === 'turret' ? u.turretYaw : u.heading;
        const probeDx = -Math.sin(yaw) * w.rangeMeters;
        const probeDz = -Math.cos(yaw) * w.rangeMeters;
        const probeY = u.y + 1.2;
        if (!friendlyOnLineOfFire(u, u.x + probeDx, probeY, u.z + probeDz, units)) {
          fireShot(u, w, projectiles, hooks);
        }
        u.burstShotsRemaining--;
        if (u.burstShotsRemaining > 0) {
          u.burstShotTimer = w.burstInterval;
        }
      }
      // Idle turret relax. Only meaningful for 'turret' mounts; 'hull'
      // mounts already have turretYaw = heading.
      if (w.aimedBy === 'turret') {
        const k = Math.min(1, dt * 1.2);
        const diff = wrapAngle(u.heading - u.turretYaw);
        u.turretYaw += diff * k;
      } else {
        u.turretYaw = u.heading;
      }
    }
  }
}

/**
 * Slew the AIMING part of `u` toward `targetYaw`. Returns whether the part is
 * now within the weapon's `aimToleranceRad`. Hull mounts use the unit's
 * existing `turnRateRadPerSec`; turret mounts use the weapon's
 * `aimSlewRadPerSec`.
 *
 * For 'hull' weapons we *don't* zero forward speed during the rotation — the
 * unit can keep walking. The path-driven heading update inside `tickSurface`
 * also nudges heading toward the next waypoint, so a soldier ordered to move
 * AND fire ends up resolving heading toward whichever vector is closer to its
 * current heading. Good enough for now; precision aiming + dead stop can be
 * layered on later if it becomes a problem.
 */
function slewToward(u: Unit, w: WeaponConfig, targetYaw: number, dt: number): { aligned: boolean } {
  const mount: WeaponMount = w.aimedBy;
  if (mount === 'hull') {
    const diff = wrapAngle(targetYaw - u.heading);
    const step = u.turnRateRadPerSec * dt;
    u.heading += clamp(diff, -step, step);
    u.turretYaw = u.heading;
    const remaining = wrapAngle(targetYaw - u.heading);
    return { aligned: Math.abs(remaining) <= w.aimToleranceRad };
  }
  // Turret mount.
  const diff = wrapAngle(targetYaw - u.turretYaw);
  const step = w.aimSlewRadPerSec * dt;
  u.turretYaw += clamp(diff, -step, step);
  const remaining = wrapAngle(targetYaw - u.turretYaw);
  return { aligned: Math.abs(remaining) <= w.aimToleranceRad };
}

/**
 * Spawn one projectile from the unit's muzzle. Uses the AIMING part's yaw
 * (turret for vehicles, hull for soldiers) as the fire direction. The
 * vertical component is derived from the firing target altitude relative to
 * the muzzle so a tank shell aimed at an elevated cliff ends up tilted
 * upward at launch.
 */
function fireShot(
  u: Unit,
  w: WeaponConfig,
  projectiles: ProjectileManager,
  hooks: WeaponTickHooks,
  projectileOverride?: ProjectileKind,
): void {
  const yaw = w.aimedBy === 'turret' ? u.turretYaw : u.heading;
  // Fire direction in XZ from the aim yaw (heading=0 → forward=-Z).
  const fxz = -Math.sin(yaw);
  const fzz = -Math.cos(yaw);
  // Pitch: aim toward the firing target's altitude relative to the muzzle so
  // angled shots land where the player aimed. We re-read the firing target
  // here because burst follow-ups don't carry a target — fall back to the
  // current aim heading when none is set (flat fire).
  let pitchY = 0;
  if (u.firingTarget) {
    const dx = u.firingTarget.x - u.x;
    const dy = u.firingTarget.y - (u.y + 1.2);
    const dz = u.firingTarget.z - u.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz > 1e-3) pitchY = dy / horiz;
  }
  // Spread: random cone-cap deviation around the aim vector.
  const spread = w.spreadRad;
  const sxRand = (Math.random() - 0.5) * 2 * spread;
  const syRand = (Math.random() - 0.5) * 2 * spread;
  // Build initial direction = forward + yaw-perp * sxRand + up * syRand, then
  // normalise. Yaw-perp ≈ rotate forward 90° around Y.
  const perpX = -fzz, perpZ = fxz;
  let dirX = fxz + perpX * sxRand;
  let dirZ = fzz + perpZ * sxRand;
  let dirY = pitchY + syRand;
  const dl = Math.hypot(dirX, dirY, dirZ) || 1;
  dirX /= dl; dirY /= dl; dirZ /= dl;

  const muzzle = muzzleOrigin(u.x, u.y, u.z, dirX, dirY, dirZ, 1.4, 1.2);
  const kind = projectileOverride ?? w.projectile;
  // Each unit's launcher caps the actual muzzle speed via launcherMaxStrength
  // — a soldier with a 7.62 sniper still throws the round noticeably slower
  // than the same round fired from a tank's launcher rating.
  projectiles.spawn(
    kind,
    muzzle.x, muzzle.y, muzzle.z,
    dirX, dirY, dirZ,
    u.id,
    w.velocityScale,
    u.launcherMaxStrength,
  );
  const pcfg = PROJECTILES[kind];
  hooks.onMuzzleFlash(
    muzzle.x, muzzle.y, muzzle.z,
    w.muzzleFlashRadius, w.muzzleFlashSeconds,
    { r: pcfg.colorR, g: pcfg.colorG, b: pcfg.colorB },
  );
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
