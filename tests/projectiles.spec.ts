import { describe, it, expect } from 'vitest';
import {
  PROJECTILES, ProjectileManager, aimBallistic, muzzleWorldPosition, PROJECTILE_GRAVITY,
} from '../src/sim/Projectiles';
import { WEAPONS, applySpread, makeWeaponState, defaultWeaponFor, tickWeapon } from '../src/sim/Weapons';
import { Unit } from '../src/sim/Units';

/**
 * The ballistic firing solution + projectile sim form the entire combat layer:
 * if the math here drifts, every weapon misses. These tests pin the contract
 * down so we can change the projectile catalogue without breaking aim.
 */

function makeStubUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 1, kind: 'soldier',
    footprintRadius: 1, widthMeters: 0.75,
    maxStepVoxels: 32, slopePenalty: 0.08,
    bodyHalfCells: 0, bodyRoughnessVoxels: 999,
    turnRateRadPerSec: 6, maxPitchRad: Math.PI / 2,
    heightVoxels: 14, canDig: false, requiresGround: true,
    x: 0, y: 0, z: 0,
    heading: 0, pitch: 0, roll: 0,
    speed: 4.5, speedDigging: 0,
    path: [],
    hp: 80, selected: false,
    carveCooldown: 0, distanceWalked: 0, lastTrackDistance: 0, blockedFrames: 0,
    vy: 0, massKg: 80, terminalFallSpeed: 28,
    cutterRadius: 0, cutterForward: 0, cutterHeight: 0,
    weaponState: null,
    segments: [],
    pathHistory: [],
    ...overrides,
  };
}

describe('PROJECTILES catalogue', () => {
  it('lists every standard NATO bullet caliber the request called for', () => {
    expect(PROJECTILES.bullet_9mm.caliberMm).toBe(9);
    expect(PROJECTILES.bullet_5_56mm.caliberMm).toBe(5.56);
    expect(PROJECTILES.bullet_7_62mm.caliberMm).toBe(7.62);
    expect(PROJECTILES.bullet_12_7mm.caliberMm).toBe(12.7);
  });

  it('orders bullet velocities so rifles are faster than pistols', () => {
    expect(PROJECTILES.bullet_5_56mm.muzzleVelocity).toBeGreaterThan(PROJECTILES.bullet_9mm.muzzleVelocity);
    expect(PROJECTILES.bullet_7_62mm.muzzleVelocity).toBeGreaterThan(PROJECTILES.bullet_9mm.muzzleVelocity);
    expect(PROJECTILES.bullet_12_7mm.muzzleVelocity).toBeGreaterThan(PROJECTILES.bullet_9mm.muzzleVelocity);
  });

  it('matches real-world bullet masses (g) to within tolerance', () => {
    expect(PROJECTILES.bullet_9mm.massKg).toBeCloseTo(0.008, 3);
    expect(PROJECTILES.bullet_5_56mm.massKg).toBeCloseTo(0.004, 3);
    expect(PROJECTILES.bullet_7_62mm.massKg).toBeCloseTo(0.0095, 3);
    // .50 BMG is the heaviest bullet the catalogue carries.
    expect(PROJECTILES.bullet_12_7mm.massKg).toBeGreaterThan(PROJECTILES.bullet_7_62mm.massKg);
  });

  it('rockets are heavier and slower than bullets', () => {
    expect(PROJECTILES.rocket_rpg.massKg).toBeGreaterThan(PROJECTILES.bullet_12_7mm.massKg);
    expect(PROJECTILES.rocket_heavy.massKg).toBeGreaterThan(PROJECTILES.rocket_rpg.massKg);
    expect(PROJECTILES.rocket_rpg.muzzleVelocity).toBeLessThan(PROJECTILES.bullet_9mm.muzzleVelocity);
  });

  it('cluster rocket dispenses bomblets that themselves explode', () => {
    const c = PROJECTILES.rocket_cluster;
    expect(c.category).toBe('cluster');
    expect(c.clusterCount).toBeGreaterThan(0);
    expect(c.clusterChild).toBe('cluster_bomblet');
    expect(PROJECTILES.cluster_bomblet.explodeRadiusMeters).toBeGreaterThan(0);
  });

  it('only explosives carry an AOE radius — bullets are pinpoint', () => {
    expect(PROJECTILES.bullet_9mm.explodeRadiusMeters).toBe(0);
    expect(PROJECTILES.bullet_5_56mm.explodeRadiusMeters).toBe(0);
    expect(PROJECTILES.bullet_7_62mm.explodeRadiusMeters).toBe(0);
    expect(PROJECTILES.rocket_rpg.explodeRadiusMeters).toBeGreaterThan(0);
    expect(PROJECTILES.rocket_heavy.explodeRadiusMeters).toBeGreaterThan(PROJECTILES.rocket_rpg.explodeRadiusMeters);
  });
});

describe('WEAPONS catalogue', () => {
  it('machine guns fire 7.62 mm rifle bullets in bursts', () => {
    const mg = WEAPONS.machinegun;
    expect(mg.projectile).toBe('bullet_7_62mm');
    expect(mg.burstCount).toBeGreaterThan(1);
  });

  it('snipers use the .50 cal round and have the longest range', () => {
    const sniper = WEAPONS.sniper;
    expect(sniper.projectile).toBe('bullet_12_7mm');
    expect(sniper.rangeMeters).toBeGreaterThan(WEAPONS.rifle.rangeMeters);
    expect(sniper.rangeMeters).toBeGreaterThan(WEAPONS.pistol.rangeMeters);
  });

  it('vehicle-only platforms launch the cluster + heavy rockets', () => {
    expect(WEAPONS.cluster_launcher.projectile).toBe('rocket_cluster');
    expect(WEAPONS.heavy_rocket.projectile).toBe('rocket_heavy');
  });

  it('soldier loadout cycles through small arms; vehicles get the heavy mounts', () => {
    expect(defaultWeaponFor('tank', 0)).toBe('cluster_launcher');
    expect(defaultWeaponFor('tunneler', 0)).toBeNull();
    expect(defaultWeaponFor('worm', 0)).toBeNull();
    // First six soldiers get distinct loadouts.
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(defaultWeaponFor('soldier', i)!);
    expect(seen.size).toBe(6);
  });
});

describe('aimBallistic', () => {
  it('aims flat for a horizontal target at the same height', () => {
    const aim = aimBallistic(0, 0, 0,  100, 0, 0,  500);
    expect(aim).not.toBeNull();
    // Lower-arc solution should still tilt up slightly to compensate for drop.
    expect(aim!.dy).toBeGreaterThan(0);
    expect(aim!.dy).toBeLessThan(0.1);
    // Horizontal direction lines up with the +X target.
    expect(aim!.dx).toBeGreaterThan(0.99);
  });

  it('returns null when the target is genuinely beyond ballistic range', () => {
    // Slow (50 m/s) muzzle aimed 3 km away — max range = v²/g = 254 m,
    // so the discriminant goes negative and the helper returns null.
    const aim = aimBallistic(0, 0, 0,  3000, 0, 0,  50);
    expect(aim).toBeNull();
  });

  it('aiming at a higher target tilts the muzzle up', () => {
    const aim = aimBallistic(0, 0, 0,  100, 30, 0,  500);
    expect(aim).not.toBeNull();
    expect(aim!.dy).toBeGreaterThan(0.2);
  });

  it('a fired projectile actually lands near the target after sim integration', () => {
    // Fire a fast 5.56 round across a short, in-bounds arc. Drag is small at
    // this caliber/distance, so the closed-form aim should stay within ~1 m.
    // We integrate with a 1 ms step so the closest-pass sampling isn't aliased
    // by the projectile's high muzzle velocity.
    const v0 = PROJECTILES.bullet_5_56mm.muzzleVelocity;
    const muzzle = { x: 0, y: 5, z: 0 };
    const target = { x: 60, y: 5, z: 0 };
    const aim = aimBallistic(muzzle.x, muzzle.y, muzzle.z, target.x, target.y, target.z, v0);
    expect(aim).not.toBeNull();
    const mgr = new ProjectileManager();
    mgr.spawn('bullet_5_56mm',
      muzzle.x, muzzle.y, muzzle.z,
      aim!.dx * v0, aim!.dy * v0, aim!.dz * v0,
      -1);
    let minDist = Infinity;
    for (let step = 0; step < 1000; step++) {
      mgr.tick(0.001, null);
      const p = mgr.projectiles[0];
      if (!p) break;
      const d = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
      if (d < minDist) minDist = d;
    }
    expect(minDist).toBeLessThan(1.5);
  });
});

describe('Bullet drop', () => {
  it('a horizontally fired round drops measurably over distance under gravity', () => {
    const mgr = new ProjectileManager();
    // World y runs to ~24 m; spawn at 18 m and step ~1 s — leaves room for the
    // ~5 m drop without tripping the out-of-bounds despawn.
    mgr.spawn('bullet_9mm', 0, 18, 0,  60, 0, 0,  -1);
    for (let i = 0; i < 60; i++) mgr.tick(1 / 60, null);
    const p = mgr.projectiles[0]!;
    // Expected drop ≈ 0.5 * g * t² ≈ 4.9 m at 1 s. Loose bound: at least 3.5 m.
    const dropped = 18 - p.y;
    expect(dropped).toBeGreaterThan(3.5);
    // Horizontal travel should be ~muzzle velocity * 1 s minus drag — at least 30 m.
    expect(p.x).toBeGreaterThan(30);
  });

  it('rockets with low gravityScale stay flatter than bullets over the same flight', () => {
    const bulletMgr = new ProjectileManager();
    const rocketMgr = new ProjectileManager();
    // Both fired at the same modest muzzle speed so the comparison is purely the
    // gravity multiplier (1.0 vs ~0.25). Spawn high enough to stay in bounds.
    bulletMgr.spawn('bullet_9mm', 0, 18, 0,  60, 0, 0,  -1);
    rocketMgr.spawn('rocket_rpg', 0, 18, 0,  60, 0, 0,  -1);
    for (let i = 0; i < 30; i++) {
      bulletMgr.tick(1 / 60, null);
      rocketMgr.tick(1 / 60, null);
    }
    const bDrop = 18 - bulletMgr.projectiles[0]!.y;
    const rDrop = 18 - rocketMgr.projectiles[0]!.y;
    expect(bDrop).toBeGreaterThan(rDrop);
  });
});

describe('ProjectileManager', () => {
  it('despawns projectiles after their fuse runs out', () => {
    const mgr = new ProjectileManager();
    // Spawn high enough that the bomblet stays in bounds for the full ~1.6 s
    // fuse. World y is ~24 m; gravity drop in 1.6 s ≈ 12.5 m, so y=20 leaves
    // headroom below 0.
    mgr.spawn('cluster_bomblet', 5, 22, 5,  0, 0, 0,  -1);
    let sawAirburst = false;
    for (let i = 0; i < 200; i++) {
      const events = mgr.tick(0.05, null);
      if (events.some(e => e.airburst)) sawAirburst = true;
      if (mgr.projectiles.length === 0) break;
    }
    expect(mgr.projectiles.length).toBe(0);
    expect(sawAirburst).toBe(true);
  });

  it('cluster spawn dispenses the configured number of submunitions', () => {
    const mgr = new ProjectileManager();
    const parent = mgr.spawn('rocket_cluster', 10, 5, 0,  0, 0, 0,  -1);
    mgr.projectiles.length = 0;  // pretend the parent already detonated
    mgr.spawnCluster(parent, 10, 5, 0);
    const spec = PROJECTILES.rocket_cluster;
    expect(mgr.projectiles.length).toBe(spec.clusterCount);
    // Every child should be the configured bomblet kind.
    for (const child of mgr.projectiles) {
      expect(child.kind).toBe(spec.clusterChild);
      // And every child should have been issued some velocity.
      const speed = Math.hypot(child.vx, child.vy, child.vz);
      expect(speed).toBeGreaterThan(0);
    }
  });

  it('damageUnitsInRadius scales damage with distance', () => {
    // Place the unit so the centre-of-mass offset (+0.5 m on Y) is included in
    // the distance — that's a real factor in the impl, so the test should match.
    const u = makeStubUnit({ x: 0, y: -0.5, z: 0, hp: 100 });
    const mgr = { units: [u] } as { units: Unit[] };
    ProjectileManager.damageUnitsInRadius(mgr as never, 1, 0, 0, 4, 80);
    // Distance after +0.5 chest-height offset: dx=1, dy=0, dz=0 → d=1.
    // Falloff = 1 - 1/4 = 0.75 → damage = 60. hp goes 100 → 40.
    expect(u.hp).toBeCloseTo(40, 5);
  });

  it('damageUnitsInRadius leaves units outside the radius untouched', () => {
    const u = makeStubUnit({ x: 10, y: 0, z: 0, hp: 100 });
    const mgr = { units: [u] } as { units: Unit[] };
    ProjectileManager.damageUnitsInRadius(mgr as never, 0, 0, 0, 4, 80);
    expect(u.hp).toBe(100);
  });
});

describe('muzzleWorldPosition', () => {
  it('places the muzzle ahead of the unit when heading is 0 (-Z forward)', () => {
    const u = makeStubUnit({ x: 5, y: 0, z: 5, heading: 0 });
    const m = muzzleWorldPosition(u, 0.5, 1.0, 0);
    expect(m.x).toBeCloseTo(5, 5);
    expect(m.y).toBeCloseTo(1.0, 5);
    // Forward = -Z, so muzzle is at z = 5 - 0.5 = 4.5.
    expect(m.z).toBeCloseTo(4.5, 5);
  });

  it('rotates with heading: heading = π/2 sends -Z forward to -X world', () => {
    const u = makeStubUnit({ x: 0, y: 0, z: 0, heading: Math.PI / 2 });
    const m = muzzleWorldPosition(u, 1.0, 0, 0);
    // sin(π/2)=1, cos(π/2)=0. forward world = (-sin h, ., -cos h) = (-1, ., 0).
    expect(m.x).toBeCloseTo(-1, 5);
    expect(m.z).toBeCloseTo(0, 5);
  });
});

describe('applySpread', () => {
  it('returns the input direction when spread is zero', () => {
    const out = applySpread(1, 0, 0, 0, 12345);
    expect(out.x).toBeCloseTo(1, 5);
    expect(out.y).toBeCloseTo(0, 5);
    expect(out.z).toBeCloseTo(0, 5);
  });

  it('keeps the result on the unit sphere', () => {
    const out = applySpread(0.7071, 0, 0.7071, 0.05, 9876);
    const len = Math.hypot(out.x, out.y, out.z);
    expect(len).toBeCloseTo(1, 5);
  });

  it('produces results within roughly the spread cone', () => {
    // Angle between input and output should be on the order of spreadRad * O(1).
    const inDir = { x: 1, y: 0, z: 0 };
    let maxDeviation = 0;
    for (let i = 0; i < 50; i++) {
      const out = applySpread(inDir.x, inDir.y, inDir.z, 0.05, i * 12345);
      const dot = inDir.x * out.x + inDir.y * out.y + inDir.z * out.z;
      maxDeviation = Math.max(maxDeviation, Math.acos(Math.min(1, dot)));
    }
    // Allow 4× the spread half-angle as a generous upper bound (spread is sampled
    // uniformly in a square then re-normalised, which can push the corner ~√2 × spread).
    expect(maxDeviation).toBeLessThan(0.05 * 4);
  });
});

describe('tickWeapon', () => {
  it('does nothing without a fire target', () => {
    const u = makeStubUnit({ weaponState: makeWeaponState('rifle') });
    const mgr = new ProjectileManager();
    const fired = tickWeapon(u, u.weaponState!, mgr, 0.016);
    expect(fired).toBe(false);
    expect(mgr.projectiles.length).toBe(0);
  });

  it('fires a projectile when target is in range and cooldown is ready', () => {
    const u = makeStubUnit({ weaponState: makeWeaponState('rifle'), x: 0, y: 0, z: 0 });
    u.weaponState!.fireTarget = { x: 20, y: 1, z: 0 };
    const mgr = new ProjectileManager();
    const fired = tickWeapon(u, u.weaponState!, mgr, 0.016);
    expect(fired).toBe(true);
    expect(mgr.projectiles.length).toBe(1);
    expect(mgr.projectiles[0]!.kind).toBe('bullet_5_56mm');
    // Owner id propagates so the projectile can suppress self-impacts.
    expect(mgr.projectiles[0]!.ownerId).toBe(u.id);
  });

  it('respects cooldown — second shot blocked until timer expires', () => {
    const u = makeStubUnit({ weaponState: makeWeaponState('sniper') });
    u.weaponState!.fireTarget = { x: 30, y: 0, z: 0 };
    const mgr = new ProjectileManager();
    tickWeapon(u, u.weaponState!, mgr, 0.016);
    tickWeapon(u, u.weaponState!, mgr, 0.016);
    expect(mgr.projectiles.length).toBe(1);
  });

  it('machine gun bursts spawn multiple rounds in quick succession', () => {
    const u = makeStubUnit({ weaponState: makeWeaponState('machinegun') });
    u.weaponState!.fireTarget = { x: 40, y: 0, z: 0 };
    const mgr = new ProjectileManager();
    // Tick repeatedly with the burst-shot interval (0.07 s) — should spit out
    // the entire 5-round burst, then go silent until the long cooldown ends.
    for (let i = 0; i < 30; i++) tickWeapon(u, u.weaponState!, mgr, 0.07);
    expect(mgr.projectiles.length).toBeGreaterThanOrEqual(WEAPONS.machinegun.burstCount);
  });

  it('out-of-range targets are not engaged', () => {
    const u = makeStubUnit({ weaponState: makeWeaponState('pistol'), x: 0, y: 0, z: 0 });
    // Pistol range = 35 m; target at 200 m must not fire.
    u.weaponState!.fireTarget = { x: 200, y: 0, z: 0 };
    const mgr = new ProjectileManager();
    tickWeapon(u, u.weaponState!, mgr, 0.05);
    expect(mgr.projectiles.length).toBe(0);
  });
});

describe('Constants', () => {
  it('PROJECTILE_GRAVITY matches earth gravity', () => {
    expect(PROJECTILE_GRAVITY).toBeCloseTo(9.81, 2);
  });
});
