import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_DIRT, M_GRASS, M_BEDROCK } from '../src/voxel/Materials';
import { ProjectileManager, PROJECTILES, PROJECTILE_GRAVITY } from '../src/sim/Projectiles';
import { UnitManager } from '../src/sim/Units';
import { tickWeapons } from '../src/sim/WeaponTick';
import { WEAPONS } from '../src/sim/Weapons';

/**
 * Build a flat dirt slab (with grass top) at a given Y so projectiles fired
 * horizontally from above eventually drop into it. Bedrock at y=0/1 stops
 * runaway downward integration.
 */
function buildSlabWorld(slabY: number): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < slabY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, slabY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('ProjectileManager — bullet drop physics', () => {
  it('a horizontally-fired projectile in vacuum drops by ~½ g·t²', () => {
    // Use a drag-free synthetic projectile (catalog values still pull in
    // some drag, so we model the underlying integrator directly to check
    // the gravity term is correct). We do this by spawning a 7.62mm and
    // running for 0.5s in OPEN AIR (no world geometry along the path), then
    // measuring vertical drop.
    const world = VoxelWorld.create(false); // empty world — no voxels block
    const pm = new ProjectileManager();
    // Fire horizontally along +X at high altitude.
    pm.spawn('bullet_7_62mm', 100, 100, 100, 1, 0, 0, /*owner*/ 1);
    const t = 0.5; // seconds
    const dt = 1 / 240; // small step for accuracy
    const steps = Math.round(t / dt);
    for (let i = 0; i < steps; i++) pm.tick(dt, world);
    expect(pm.projectiles).toHaveLength(1);
    const p = pm.projectiles[0]!;
    // y(t) = y0 + v0y*t - ½ g t² + drag-correction.
    // Initial vy=0, so drop = ½ g t² ≈ 1.226 m at t=0.5s; drag pulls a
    // tiny bit more out of the velocity over time but the dominant effect
    // is gravity. Allow ±0.4m slack for the drag/integrator.
    const expectedDrop = 0.5 * PROJECTILE_GRAVITY * t * t;
    const actualDrop = 100 - p.y;
    expect(actualDrop).toBeGreaterThan(expectedDrop * 0.85);
    expect(actualDrop).toBeLessThan(expectedDrop * 1.4);
  });

  it('a horizontally-fired bullet still has positive forward velocity after 1s', () => {
    const world = VoxelWorld.create(false);
    const pm = new ProjectileManager();
    pm.spawn('bullet_5_56mm', 100, 100, 100, 1, 0, 0, 1);
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) pm.tick(dt, world);
    // Projectile may have expired by maxLife. If still alive, vx should be
    // a meaningful fraction of the muzzle velocity since drag is gentle.
    if (pm.projectiles.length > 0) {
      const p = pm.projectiles[0]!;
      expect(p.vx).toBeGreaterThan(50);
    }
  });
});

describe('ProjectileManager — voxel collision', () => {
  it('a bullet fired into a wall stops on the wall and emits an impact', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Build a vertical 1-voxel-thick wall at x=120, spanning a few rows.
    for (let y = 50; y <= 80; y++) {
      for (let z = 90; z <= 110; z++) {
        v[worldIndex(120, y, z)] = M_DIRT;
      }
    }
    const pm = new ProjectileManager();
    // Fire horizontally along +X toward the wall.
    pm.spawn('bullet_5_56mm', 110 * 0.125, 70 * 0.125, 100 * 0.125, 1, 0, 0, 1);
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      pm.tick(dt, world);
      if (pm.pendingImpacts.length > 0) break;
    }
    expect(pm.pendingImpacts.length).toBe(1);
    const imp = pm.pendingImpacts[0]!;
    expect(imp.kind).toBe('bullet_5_56mm');
    // Impact should be near x = 120 voxels = 15.0 m along the wall face.
    expect(imp.x).toBeGreaterThan(14.0);
    expect(imp.x).toBeLessThan(16.0);
  });

  it('a tank shell impact actually destroys voxels via damageSphere', () => {
    const slabY = 80;
    const world = buildSlabWorld(slabY);
    const pm = new ProjectileManager();
    // Fire horizontally into a hill we'll add by stacking dirt 8 voxels tall
    // at x=200, z=200.
    const v = world.buffers.voxels;
    for (let y = slabY; y < slabY + 8; y++) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          v[worldIndex(200 + dx, y, 200 + dz)] = M_DIRT;
        }
      }
    }
    // Spawn the projectile a few meters in front of the hill, aimed at it.
    const start = { x: 23.0, y: (slabY + 4) * 0.125, z: 200 * 0.125 };
    const target = { x: 200 * 0.125, y: (slabY + 4) * 0.125, z: 200 * 0.125 };
    const dx = target.x - start.x, dy = target.y - start.y, dz = target.z - start.z;
    pm.spawn('tank_shell', start.x, start.y, start.z, dx, dy, dz, 1);
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      pm.tick(dt, world);
      if (pm.pendingImpacts.length > 0) {
        const imp = pm.pendingImpacts[0]!;
        // Drive damageSphere directly — same as Game does on impact.
        const r = world.damageSphere(imp.x / 0.125, imp.y / 0.125, imp.z / 0.125, imp.explosionRadiusMeters / 0.125, imp.damagePeak);
        expect(r.destroyed.length).toBeGreaterThan(0);
        return;
      }
    }
    throw new Error('projectile never hit the hill');
  });
});

describe('ProjectileManager — cluster rocket', () => {
  it('cluster_rocket emits an impact, ready for submunition spawn handling', () => {
    const slabY = 80;
    const world = buildSlabWorld(slabY);
    const pm = new ProjectileManager();
    // Lob the cluster rocket toward the slab.
    pm.spawn('cluster_rocket', 30, 12, 30, 0.6, -0.5, 0, 1);
    const dt = 1 / 60;
    let imp = null;
    for (let i = 0; i < 600; i++) {
      pm.tick(dt, world);
      if (pm.pendingImpacts.length > 0) { imp = pm.pendingImpacts[0]!; break; }
    }
    expect(imp).not.toBeNull();
    expect(imp!.explosive).toBe(true);
    // The catalog declares 8 submunitions; we don't spawn them here (Game
    // does), but the cluster_submunition entry must exist so Game can
    // dispatch them safely.
    const cfg = PROJECTILES['cluster_rocket'];
    expect(cfg.clusterSubmunitions).toBeGreaterThan(0);
    expect(PROJECTILES['cluster_submunition']).toBeDefined();
  });
});

describe('ProjectileManager — predictTrajectory', () => {
  it('predicted trajectory roughly matches the live tick path', () => {
    const world = VoxelWorld.create(false);
    const pm = new ProjectileManager();
    const start = { x: 50, y: 50, z: 50 };
    const dir = { x: 0.8, y: 0.4, z: 0.0 };
    const live = pm.spawn('rpg', start.x, start.y, start.z, dir.x, dir.y, dir.z, 1);
    const predicted = pm.predictTrajectory(
      'rpg', start.x, start.y, start.z, dir.x, dir.y, dir.z, world,
      0, 80, 0.05, 1,
    );
    expect(predicted.length).toBeGreaterThan(5);
    const dt = 0.05;
    // Step the live projectile along the same number of slices and compare
    // positions.
    for (let i = 1; i < Math.min(predicted.length, 30); i++) {
      pm.tick(dt, world);
      if (live.dead) break;
      const p = predicted[i]!;
      expect(Math.abs(live.x - p.x)).toBeLessThan(0.5);
      expect(Math.abs(live.y - p.y)).toBeLessThan(0.5);
      expect(Math.abs(live.z - p.z)).toBeLessThan(0.5);
    }
  });
});

describe('Weapon firing — turret slew + cooldown', () => {
  it('a tank fires only after its turret has slewed onto the target', () => {
    const um = new UnitManager();
    const tank = um.spawn('tank', 0, 1, 0);
    // Spawn a target 50 m to the side so the turret has a non-trivial yaw.
    tank.heading = 0;        // hull facing -Z
    tank.turretYaw = 0;      // turret too
    tank.firingTarget = { x: 50, y: 1, z: 0 };
    const pm = new ProjectileManager();
    const flashes: number[] = [];
    const hooks = {
      onMuzzleFlash: (): void => { flashes.push(1); },
    };
    // Step in 16 ms ticks. First few ticks: turret slewing, no shot. Once
    // aligned and cooldown=0, exactly one shot fires.
    let firstShotTick = -1;
    for (let i = 0; i < 600; i++) {
      tickWeapons(1 / 60, um, pm, hooks);
      if (pm.projectiles.length > 0 && firstShotTick < 0) {
        firstShotTick = i;
        break;
      }
    }
    expect(firstShotTick).toBeGreaterThan(0); // not on the first tick
    // Turret should be aimed at the target (≈ +X direction, yaw = -π/2).
    const wcfg = WEAPONS['tank_cannon'];
    const targetYaw = Math.atan2(-50, 0);
    const diff = wrapAngle(targetYaw - tank.turretYaw);
    expect(Math.abs(diff)).toBeLessThan(wcfg.aimToleranceRad + 0.01);
    expect(flashes.length).toBe(1);
    expect(pm.projectiles[0]!.kind).toBe('tank_shell');
  });

  it('a soldier with a rifle fires multiple bullets per trigger pull (burst)', () => {
    const um = new UnitManager();
    const sol = um.spawn('soldier', 0, 1, 0);
    sol.firingTarget = { x: 30, y: 1, z: 0 };
    const pm = new ProjectileManager();
    let flashes = 0;
    const hooks = { onMuzzleFlash: (): void => { flashes++; } };
    // Step long enough for the burst to play out.
    for (let i = 0; i < 600; i++) tickWeapons(1 / 60, um, pm, hooks);
    const wcfg = WEAPONS['rifle'];
    expect(flashes).toBe(wcfg.shotsPerBurst);
    expect(pm.projectiles.length).toBe(wcfg.shotsPerBurst);
  });

  it('an unarmed unit (worker) ignores firingTarget completely', () => {
    const um = new UnitManager();
    const w = um.spawn('worker', 0, 1, 0);
    expect(w.weapon).toBeNull();
    // Setting firingTarget on an unarmed unit should be a no-op.
    w.firingTarget = { x: 10, y: 1, z: 0 };
    const pm = new ProjectileManager();
    const hooks = { onMuzzleFlash: (): void => {} };
    for (let i = 0; i < 60; i++) tickWeapons(1 / 60, um, pm, hooks);
    expect(pm.projectiles.length).toBe(0);
  });

  it('turret weapons slew the turret independently of the hull heading', () => {
    const um = new UnitManager();
    const t = um.spawn('tank', 0, 1, 0);
    t.heading = 0;
    t.turretYaw = 0;
    t.firingTarget = { x: 0, y: 1, z: 50 }; // behind the hull (+Z)
    const pm = new ProjectileManager();
    const hooks = { onMuzzleFlash: (): void => {} };
    // After a few ticks the turret should start swinging — but the hull
    // heading should NOT change.
    for (let i = 0; i < 8; i++) tickWeapons(1 / 60, um, pm, hooks);
    expect(t.heading).toBe(0); // hull untouched
    expect(Math.abs(t.turretYaw)).toBeGreaterThan(0); // turret swung
  });

  it('soldier (hull-aimed) rotates the hull to face the target', () => {
    const um = new UnitManager();
    const s = um.spawn('soldier', 0, 1, 0);
    s.heading = 0;
    s.firingTarget = { x: 0, y: 1, z: 50 }; // behind, so hull must turn ~π
    const pm = new ProjectileManager();
    const hooks = { onMuzzleFlash: (): void => {} };
    for (let i = 0; i < 4; i++) tickWeapons(1 / 60, um, pm, hooks);
    expect(Math.abs(s.heading)).toBeGreaterThan(0); // hull is rotating
    // Turret yaw on hull-mounted weapons should track the heading.
    expect(s.turretYaw).toBeCloseTo(s.heading, 5);
  });
});

describe('Projectile catalog sanity', () => {
  it('every catalog entry declares a positive mass and muzzle velocity', () => {
    for (const k of Object.keys(PROJECTILES)) {
      const cfg = PROJECTILES[k as keyof typeof PROJECTILES];
      expect(cfg.massKg).toBeGreaterThan(0);
      expect(cfg.muzzleVelocity).toBeGreaterThan(0);
      expect(cfg.maxLifeSeconds).toBeGreaterThan(0);
    }
  });

  it('explosive rounds have non-zero explosion radius', () => {
    for (const k of Object.keys(PROJECTILES)) {
      const cfg = PROJECTILES[k as keyof typeof PROJECTILES];
      if (cfg.explosive) {
        expect(cfg.explosionRadiusMeters).toBeGreaterThan(0);
        expect(cfg.explosionPeak).toBeGreaterThan(0);
      }
    }
  });

  it('every weapon references a valid projectile entry', () => {
    for (const k of Object.keys(WEAPONS)) {
      const w = WEAPONS[k as keyof typeof WEAPONS];
      expect(PROJECTILES[w.projectile]).toBeDefined();
    }
  });

  it('machine gun uses 5.56 mm rifle ammunition', () => {
    expect(WEAPONS.machine_gun.projectile).toBe('bullet_5_56mm');
    expect(WEAPONS.rifle.projectile).toBe('bullet_5_56mm');
  });
});

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

void AIR;

describe('WeaponTick — friendly-fire gating', () => {
  it('holds the trigger when a same-team peer is on the line of fire', () => {
    const world = VoxelWorld.create(false); // no terrain blocking the shot
    const um = new UnitManager();
    const shooter = um.spawn('soldier', 100, 100, 100);
    // Friendly directly between shooter and target (at +X 5m).
    um.spawn('soldier', 105, 100, 100);
    // Order shooter to fire at +X 20m — lane is blocked by the friendly.
    shooter.firingTarget = { x: 120, y: 100, z: 100 };

    const pm = new ProjectileManager();
    const flashes: number[] = [];
    // Run a few seconds — plenty of time for the rifle's 0.3s cooldown to
    // expire repeatedly. With friendly fire on, no shot should fire.
    for (let i = 0; i < 240; i++) {
      tickWeapons(1 / 60, um, pm, {
        onMuzzleFlash: (): void => { flashes.push(0); },
      });
    }
    expect(pm.projectiles.length).toBe(0);
    expect(flashes.length).toBe(0);
    // The firingTarget should still be queued — the shooter is waiting for
    // the lane to clear, not silently giving up.
    expect(shooter.firingTarget).not.toBeNull();
  });

  it('still fires when only an enemy-team unit is in the line of fire', () => {
    const world = VoxelWorld.create(false);
    const um = new UnitManager();
    const shooter = um.spawn('soldier', 100, 100, 100);
    // Enemy directly between — friendly-fire gate should NOT block this.
    um.spawn('soldier', 105, 100, 100, { team: 'enemy' });
    shooter.firingTarget = { x: 120, y: 100, z: 100 };

    const pm = new ProjectileManager();
    // Seed the heading so the shooter is already aligned (skip slew time).
    shooter.heading = Math.atan2(-(120 - 100), -(100 - 100));
    for (let i = 0; i < 60; i++) {
      tickWeapons(1 / 60, um, pm, { onMuzzleFlash: (): void => {} });
    }
    expect(pm.projectiles.length).toBeGreaterThan(0);
  });
});
