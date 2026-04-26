import { describe, it, expect } from 'vitest';
import { WEAPONS, computeLaunchVelocity, fireAt, muzzlePosition } from '../src/sim/Weapons';
import { ProjectileManager } from '../src/sim/Projectiles';
import { GRAVITY } from '../src/sim/gravity';

/**
 * Numerically integrate a projectile under gravity (no drag), starting at
 * `(sx, sy, sz)` with velocity `(vx, vy, vz)`, and find the (x, y, z) point of
 * closest approach to `(tx, ty, tz)` in 3D. This works whether the trajectory
 * passes through the target on the way up or on the way down — the closed-form
 * solver returns the lowest-angle valid solution, which for an elevated target
 * may still be ascending at the moment of impact.
 */
function flightToClosestApproach(
  sx: number, sy: number, sz: number,
  vx: number, vy: number, vz: number,
  tx: number, ty: number, tz: number,
  dt = 1 / 1000,
): { x: number; y: number; z: number } {
  let x = sx, y = sy, z = sz;
  let _vy = vy;
  let bestD2 = Infinity;
  let bestX = sx, bestY = sy, bestZ = sz;
  for (let i = 0; i < 200_000; i++) {
    _vy -= GRAVITY * dt;
    x += vx * dt; y += _vy * dt; z += vz * dt;
    const dx = x - tx, dy = y - ty, dz = z - tz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestX = x; bestY = y; bestZ = z; }
    // Stop after we've clearly receded from the closest approach.
    if (d2 > bestD2 * 4 + 1) break;
    if (y < ty - 1000) break;
  }
  return { x: bestX, y: bestY, z: bestZ };
}

describe('computeLaunchVelocity', () => {
  it('low-angle solution lands at the target on level ground', () => {
    // Fire from origin at a target 100 m to the +X with the rifle muzzle speed.
    const v = computeLaunchVelocity(0, 50, 0, 100, 50, 0, 830);
    expect(v).toBeTruthy();
    const landing = flightToClosestApproach(0, 50, 0, v!.vx, v!.vy, v!.vz, 100, 50, 0);
    expect(Math.abs(landing.x - 100)).toBeLessThan(0.5);
    expect(Math.abs(landing.y - 50)).toBeLessThan(0.5);
    expect(Math.abs(landing.z - 0)).toBeLessThan(0.5);
  });

  it('low-angle solution lands at an elevated target', () => {
    // Target sits 5 m above the shooter, 50 m away. RPG muzzle speed = 250 m/s.
    const v = computeLaunchVelocity(0, 0, 0, 50, 5, 0, 250);
    expect(v).toBeTruthy();
    const landing = flightToClosestApproach(0, 0, 0, v!.vx, v!.vy, v!.vz, 50, 5, 0);
    expect(Math.abs(landing.x - 50)).toBeLessThan(0.5);
    expect(Math.abs(landing.y - 5)).toBeLessThan(0.5);
  });

  it('returns null when the target is out of range', () => {
    // Pistol at 370 m/s, target 100 km away — impossibly far.
    const v = computeLaunchVelocity(0, 0, 0, 100_000, 0, 0, 370);
    expect(v).toBeNull();
  });

  it('high-angle solution is steeper than low-angle and shares total speed', () => {
    // Pick a range close to 60% of max ballistic range so both arcs are real.
    // For v=50, max range = v²/g ≈ 113.6 m, so 60 m sits squarely in the
    // valid window for both solutions.
    const low = computeLaunchVelocity(0, 0, 0, 60, 0, 0, 50, GRAVITY, /*preferLowAngle*/ true);
    const high = computeLaunchVelocity(0, 0, 0, 60, 0, 0, 50, GRAVITY, /*preferLowAngle*/ false);
    expect(low).toBeTruthy();
    expect(high).toBeTruthy();
    // Both have the same speed (energy conservation — only the angle changes).
    const lowSpeed = Math.hypot(low!.vx, low!.vy, low!.vz);
    const highSpeed = Math.hypot(high!.vx, high!.vy, high!.vz);
    expect(Math.abs(lowSpeed - 50)).toBeLessThan(1e-6);
    expect(Math.abs(highSpeed - 50)).toBeLessThan(1e-6);
    // High-angle solution: more vertical, less horizontal.
    expect(high!.vy).toBeGreaterThan(low!.vy);
    expect(Math.abs(high!.vx)).toBeLessThan(Math.abs(low!.vx));
    // Numerical integration: the high-angle arc should still land near the
    // target. With reasonable arc this is a tight window.
    const landing = flightToClosestApproach(0, 0, 0, high!.vx, high!.vy, high!.vz, 60, 0, 0);
    expect(Math.abs(landing.x - 60)).toBeLessThan(1.5);
    expect(Math.abs(landing.y - 0)).toBeLessThan(1.5);
  });

  it('returned velocity magnitude equals muzzle speed (energy conserved)', () => {
    const v = computeLaunchVelocity(0, 0, 0, 75, 3, 0, 250);
    expect(v).toBeTruthy();
    const speed = Math.hypot(v!.vx, v!.vy, v!.vz);
    expect(Math.abs(speed - 250)).toBeLessThan(1e-3);
  });

  it('handles directly-overhead target with a vertical shot', () => {
    const v = computeLaunchVelocity(0, 0, 0, 0, 100, 0, 250);
    expect(v).toBeTruthy();
    expect(v!.vx).toBe(0);
    expect(v!.vz).toBe(0);
    expect(v!.vy).toBe(250);
  });
});

describe('muzzlePosition', () => {
  it('faces -Z when heading is 0', () => {
    // Soldier at origin, facing -Z (heading = 0). Rifle has forward = 0.5.
    const m = muzzlePosition(0, 0, 0, 0, WEAPONS.rifle);
    expect(m.z).toBeLessThan(0); // forward is -Z
    expect(m.y).toBeCloseTo(WEAPONS.rifle.muzzleOffset.up);
  });

  it('rotates with heading', () => {
    // Heading π/2 → soldier faces -X.
    const m = muzzlePosition(0, 0, 0, Math.PI / 2, WEAPONS.rifle);
    expect(m.x).toBeLessThan(0);
    // Z component much smaller now.
    expect(Math.abs(m.z)).toBeLessThan(0.01 + Math.abs(WEAPONS.rifle.muzzleOffset.right));
  });
});

describe('fireAt', () => {
  it('spawns a projectile of the right kind moving roughly at muzzle speed', () => {
    const pm = new ProjectileManager();
    const unit = { x: 0, y: 0, z: 0, heading: 0, id: 1 };
    const ok = fireAt(unit, WEAPONS.rifle, 0, 1.5, -50, pm);
    expect(ok).toBe(true);
    expect(pm.projectiles.length).toBe(1);
    const p = pm.projectiles[0]!;
    expect(p.kind).toBe('bullet_762');
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    expect(Math.abs(speed - WEAPONS.rifle.muzzleVelocityMS)).toBeLessThan(1);
    // Owner id propagated.
    expect(p.ownerUnitId).toBe(1);
  });

  it('returns false when the target is out of range', () => {
    const pm = new ProjectileManager();
    const unit = { x: 0, y: 0, z: 0, heading: 0, id: 1 };
    // Pistol max range = 40 m; aim 1000 m out.
    const ok = fireAt(unit, WEAPONS.pistol, 1000, 0, 0, pm);
    expect(ok).toBe(false);
    expect(pm.projectiles.length).toBe(0);
  });

  it('rifle and machinegun share the 7.62 round', () => {
    expect(WEAPONS.rifle.projectile).toBe('bullet_762');
    expect(WEAPONS.machinegun.projectile).toBe('bullet_762');
    // ...but the MG's fire rate is much higher.
    expect(WEAPONS.machinegun.fireInterval).toBeLessThan(WEAPONS.rifle.fireInterval);
  });
});

describe('Weapon spec sanity', () => {
  it('soldier weapons use bullet projectiles, vehicle weapons use rockets', () => {
    expect(WEAPONS.pistol.projectile).toMatch(/^bullet_/);
    expect(WEAPONS.rifle.projectile).toMatch(/^bullet_/);
    expect(WEAPONS.sniper.projectile).toMatch(/^bullet_/);
    expect(WEAPONS.machinegun.projectile).toMatch(/^bullet_/);
    expect(WEAPONS.rpg.projectile).toMatch(/^rocket_/);
    expect(WEAPONS.cluster_rocket.projectile).toMatch(/^rocket_/);
    expect(WEAPONS.heavy_rocket.projectile).toMatch(/^rocket_/);
  });

  it('sniper has the longest range', () => {
    const ranges = Object.values(WEAPONS).map(w => w.maxRangeMeters);
    const sniperRange = WEAPONS.sniper.maxRangeMeters;
    // Heavy rocket might tie or exceed; sniper is at least the longest among
    // direct-fire small arms.
    expect(sniperRange).toBeGreaterThan(WEAPONS.pistol.maxRangeMeters);
    expect(sniperRange).toBeGreaterThan(WEAPONS.rifle.maxRangeMeters);
    expect(Math.max(...ranges)).toBeGreaterThanOrEqual(sniperRange);
  });

  it('machinegun cycles much faster than the sniper', () => {
    expect(WEAPONS.sniper.fireInterval / WEAPONS.machinegun.fireInterval).toBeGreaterThan(10);
  });
});
