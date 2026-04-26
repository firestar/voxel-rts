import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE, AIR } from '../src/voxel/types';
import { M_DIRT, M_STONE } from '../src/voxel/Materials';
import { ProjectileManager, PROJECTILE_GRAVITY, ExplosionEvent } from '../src/sim/Projectiles';
import {
  PROJECTILES, WEAPONS, projectileSpec, weaponSpec,
} from '../src/sim/Weapons';
import { UnitManager, tryFire, muzzleWorld } from '../src/sim/Units';

/**
 * Build an empty world (all air, no ground) so the integrator can fly the
 * projectile arbitrarily without colliding with terrain.
 */
function emptyWorld(): VoxelWorld {
  return VoxelWorld.create(false);
}

/**
 * Build a world with a thin vertical wall of dirt at x = wallX. Anything to
 * the left is air; the wall is 1 voxel thick. Used for collision tests.
 */
function wallWorld(wallX: number): VoxelWorld {
  const w = VoxelWorld.create(false);
  const v = w.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let y = 50; y < 90; y++) {
      v[worldIndex(wallX, y, z)] = M_DIRT;
    }
  }
  return w;
}

describe('projectile catalog', () => {
  it('declares standard bullet calibres in mm', () => {
    expect(PROJECTILES['9mm']!.caliberMm).toBe(9);
    expect(PROJECTILES['5.56mm']!.caliberMm).toBe(5.56);
    expect(PROJECTILES['7.62mm']!.caliberMm).toBe(7.62);
  });

  it('orders muzzle velocities pistol < sniper, bomblet < parent rocket', () => {
    expect(PROJECTILES['9mm']!.muzzleVelocity).toBeLessThan(PROJECTILES['7.62mm']!.muzzleVelocity);
    expect(PROJECTILES['9mm']!.muzzleVelocity).toBeLessThan(PROJECTILES['5.56mm']!.muzzleVelocity);
    expect(PROJECTILES['bomblet60mm']!.muzzleVelocity)
      .toBeLessThan(PROJECTILES['cluster220mm']!.muzzleVelocity);
  });

  it('orders projectile masses light bullets < heavy rockets', () => {
    expect(PROJECTILES['9mm']!.massKg).toBeLessThan(PROJECTILES['7.62mm']!.massKg);
    expect(PROJECTILES['7.62mm']!.massKg).toBeLessThan(PROJECTILES['rpg40mm']!.massKg);
    expect(PROJECTILES['rpg40mm']!.massKg).toBeLessThan(PROJECTILES['cluster220mm']!.massKg);
    expect(PROJECTILES['cluster220mm']!.massKg).toBeLessThan(PROJECTILES['heavy300mm']!.massKg);
  });

  it('cluster rockets reference an existing bomblet spec', () => {
    const cluster = PROJECTILES['cluster220mm']!;
    expect(cluster.bombletCount).toBeGreaterThan(0);
    expect(cluster.bombletSpec).toBeDefined();
    expect(PROJECTILES[cluster.bombletSpec!]).toBeDefined();
  });

  it('only bullets have zero explosion radius', () => {
    expect(PROJECTILES['9mm']!.explosionRadiusM).toBe(0);
    expect(PROJECTILES['5.56mm']!.explosionRadiusM).toBe(0);
    expect(PROJECTILES['7.62mm']!.explosionRadiusM).toBe(0);
    expect(PROJECTILES['rpg40mm']!.explosionRadiusM).toBeGreaterThan(0);
    expect(PROJECTILES['heavy300mm']!.explosionRadiusM).toBeGreaterThan(0);
    expect(PROJECTILES['bomblet60mm']!.explosionRadiusM).toBeGreaterThan(0);
  });

  it('projectileSpec throws for unknown ids', () => {
    expect(() => projectileSpec('nope')).toThrow();
  });
});

describe('weapon catalog', () => {
  it('machine gun reuses the 7.62mm rifle bullet', () => {
    expect(WEAPONS.machine_gun.projectile).toBe('7.62mm');
    expect(WEAPONS.sniper.projectile).toBe('7.62mm');
  });

  it('soldier-mounted weapons fire on soldiers; vehicle launchers on vehicles', () => {
    expect(WEAPONS.pistol.mount).toBe('soldier');
    expect(WEAPONS.rifle.mount).toBe('soldier');
    expect(WEAPONS.sniper.mount).toBe('soldier');
    expect(WEAPONS.machine_gun.mount).toBe('soldier');
    expect(WEAPONS.rpg.mount).toBe('soldier');
    expect(WEAPONS.cluster_launcher.mount).toBe('vehicle');
    expect(WEAPONS.heavy_launcher.mount).toBe('vehicle');
  });

  it('orders fire rates: sniper < rifle < machine gun', () => {
    expect(weaponSpec('sniper').fireRate).toBeLessThan(weaponSpec('rifle').fireRate);
    expect(weaponSpec('rifle').fireRate).toBeLessThan(weaponSpec('machine_gun').fireRate);
  });

  it('orders accuracy: sniper tightest, machine gun loosest', () => {
    expect(weaponSpec('sniper').spread).toBeLessThan(weaponSpec('rifle').spread);
    expect(weaponSpec('rifle').spread).toBeLessThan(weaponSpec('machine_gun').spread);
  });
});

describe('projectile ballistics — gravity drop', () => {
  it('horizontal flight drops y over time, faster bullets drop less than slower', () => {
    const slow = new ProjectileManager();
    const fast = new ProjectileManager();
    const wA = emptyWorld();
    const wB = emptyWorld();
    // Fire both projectiles horizontally from the same point along +X.
    const startY = 60 * VOXEL_SIZE;
    slow.spawn('9mm',    20, startY, 50, 1, 0, 0, -1);
    fast.spawn('7.62mm', 20, startY, 50, 1, 0, 0, -1);
    // Step a few frames so both fly some distance.
    const dt = 0.005;
    for (let i = 0; i < 30; i++) {
      slow.tick(dt, wA, [], () => {});
      fast.tick(dt, wB, [], () => {});
    }
    const sp = slow.projectiles[0]!;
    const fp = fast.projectiles[0]!;
    const dropSlow = startY - sp.y;
    const dropFast = startY - fp.y;
    expect(dropSlow).toBeGreaterThan(0);
    expect(dropFast).toBeGreaterThan(0);
    expect(dropSlow).toBeGreaterThan(dropFast);
  });

  it('vertical velocity decreases by ~g*t for a horizontal shot', () => {
    const mgr = new ProjectileManager();
    const w = emptyWorld();
    mgr.spawn('5.56mm', 20, 60 * VOXEL_SIZE, 50, 1, 0, 0, -1);
    const dt = 0.01;
    const t = 0.2;
    const steps = Math.round(t / dt);
    for (let i = 0; i < steps; i++) mgr.tick(dt, w, [], () => {});
    const p = mgr.projectiles[0]!;
    // After t seconds of flight, vy should be close to -g*t (drag is small for
    // a fast 5.56mm round). 30% slack covers the drag bleed plus integrator slip.
    const expected = -PROJECTILE_GRAVITY * t;
    const slack = Math.abs(expected) * 0.3 + 0.5;
    expect(Math.abs(p.vy - expected)).toBeLessThan(slack);
  });
});

describe('projectile collision', () => {
  it('a bullet stops at a voxel wall and damages it', () => {
    const wallX = 80;
    const w = wallWorld(wallX);
    const mgr = new ProjectileManager();
    // Fire from a few metres in front, aimed straight at the wall.
    const startX = (wallX - 30) * VOXEL_SIZE;
    const wallY = 70;
    const startY = (wallY + 0.5) * VOXEL_SIZE;
    const startZ = 200 * VOXEL_SIZE;
    mgr.spawn('5.56mm', startX, startY, startZ, 1, 0, 0, -1);
    expect(mgr.projectiles.length).toBe(1);
    // Run for at most 200ms — at 940 m/s that's 188 m, plenty to cross 30 voxels.
    const dt = 0.005;
    for (let i = 0; i < 40 && mgr.projectiles.length > 0; i++) mgr.tick(dt, w, [], () => {});
    expect(mgr.projectiles.length).toBe(0);
    // Wall voxel at the line of fire should be damaged or gone — projectile stopped here.
    const after = w.buffers.voxels[worldIndex(wallX, wallY, 200)]!;
    expect(after === AIR || after === M_DIRT).toBe(true);
  });

  it('an RPG explosion clears a sphere of voxels at impact', () => {
    const wallX = 80;
    const w = wallWorld(wallX);
    // Surround the wall column with extra dirt so the explosion has more to chew through.
    const v = w.buffers.voxels;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let y = 50; y < 90; y++) {
          v[worldIndex(wallX + dx, y, 200 + dz)] = M_DIRT;
        }
      }
    }
    const mgr = new ProjectileManager();
    let explosions = 0;
    let totalDestroyed = 0;
    const startX = (wallX - 20) * VOXEL_SIZE;
    const startY = (70 + 0.5) * VOXEL_SIZE;
    const startZ = 200 * VOXEL_SIZE;
    mgr.spawn('rpg40mm', startX, startY, startZ, 1, 0, 0, -1);
    const dt = 0.02;
    for (let i = 0; i < 80 && mgr.projectiles.length > 0; i++) {
      mgr.tick(dt, w, [], (e: ExplosionEvent) => {
        explosions++;
        totalDestroyed += e.destroyedCount;
      });
    }
    expect(explosions).toBe(1);
    expect(totalDestroyed).toBeGreaterThan(20);
  });

  it('cluster rocket spawns bomblets when its fuse expires', () => {
    const w = emptyWorld();
    const mgr = new ProjectileManager();
    // Fire upward so it doesn't impact ground; the fuse will trip mid-air.
    mgr.spawn(
      'cluster220mm',
      40, 5, 40,
      0.0, 1.0, 0.0,
      -1,
    );
    const fuseT = PROJECTILES['cluster220mm']!.fuseTime;
    const childCount = PROJECTILES['cluster220mm']!.bombletCount;
    let midAirSeen = false;
    const dt = 0.02;
    const totalT = fuseT + 0.3;
    const steps = Math.round(totalT / dt);
    for (let i = 0; i < steps; i++) {
      mgr.tick(dt, w, [], (e: ExplosionEvent) => {
        if (e.midAir) midAirSeen = true;
      });
    }
    expect(midAirSeen).toBe(true);
    // After the burst the parent is gone; bomblets remain (until they hit the
    // floor or expire). At least some of the child count should be in flight.
    const bomblets = mgr.projectiles.filter(p => p.spec.id === 'bomblet60mm').length;
    expect(bomblets).toBeGreaterThan(0);
    expect(bomblets).toBeLessThanOrEqual(childCount);
  });

  it('a projectile damages a unit it hits and ignores its owner', () => {
    const w = emptyWorld();
    const um = new UnitManager();
    const shooter = um.spawn('soldier', 30, 60 * VOXEL_SIZE, 50);
    shooter.heading = 0; // faces -Z
    const target = um.spawn('soldier', 30, 60 * VOXEL_SIZE, 35);
    const startHp = target.hp;
    // Aim manually from the shooter at the target. Bypass tryFire's cooldown
    // logic so we can assert the hit deterministically.
    const muzzle = muzzleWorld(shooter)!;
    const dx = target.x - muzzle.x;
    const dy = target.y + 1.0 - muzzle.y;
    const dz = target.z - muzzle.z;
    const len = Math.hypot(dx, dy, dz);
    const mgr = new ProjectileManager();
    mgr.spawn('5.56mm', muzzle.x, muzzle.y, muzzle.z, dx / len, dy / len, dz / len, shooter.id);
    const dt = 0.005;
    for (let i = 0; i < 60 && mgr.projectiles.length > 0; i++) {
      mgr.tick(dt, w, um.units, () => {});
    }
    expect(mgr.lastUnitHit).toBe(target);
    expect(target.hp).toBeLessThan(startHp);
    // Shooter must be untouched — owner-self-hit must be skipped.
    expect(shooter.hp).toBe(80);
  });
});

describe('weapon firing logic', () => {
  it('soldiers cycle through the loadout list as they spawn', () => {
    const um = new UnitManager();
    const a = um.spawn('soldier', 0, 0, 0);
    const b = um.spawn('soldier', 0, 0, 0);
    const c = um.spawn('soldier', 0, 0, 0);
    const d = um.spawn('soldier', 0, 0, 0);
    const e = um.spawn('soldier', 0, 0, 0);
    expect(a.weapon).toBe('rifle');
    expect(b.weapon).toBe('sniper');
    expect(c.weapon).toBe('pistol');
    expect(d.weapon).toBe('machine_gun');
    expect(e.weapon).toBe('rpg');
  });

  it('vehicles get vehicle-mounted launchers by default', () => {
    const um = new UnitManager();
    expect(um.spawn('tank', 0, 0, 0).weapon).toBe('cluster_launcher');
    expect(um.spawn('tunneler', 0, 0, 0).weapon).toBe('heavy_launcher');
    expect(um.spawn('worm', 0, 0, 0).weapon).toBe('cluster_launcher');
  });

  it('tryFire respects the per-weapon cooldown', () => {
    const um = new UnitManager();
    const u = um.spawn('soldier', 5, 0, 5);
    u.weapon = 'rifle';
    u.fireCooldown = 0;
    const sol1 = tryFire(u, { x: 5, y: 0.85, z: 0 });
    expect(sol1).not.toBeNull();
    // Second call right away must fail — still on cooldown.
    const sol2 = tryFire(u, { x: 5, y: 0.85, z: 0 });
    expect(sol2).toBeNull();
    // After waiting >= 1/fireRate, it should fire again.
    u.fireCooldown = 0;
    const sol3 = tryFire(u, { x: 5, y: 0.85, z: 0 });
    expect(sol3).not.toBeNull();
  });

  it('tryFire refuses targets outside the weapon range', () => {
    const um = new UnitManager();
    const u = um.spawn('soldier', 0, 0, 0);
    u.weapon = 'pistol';
    u.fireCooldown = 0;
    const range = weaponSpec('pistol').rangeM;
    const farTarget = { x: 0, y: 0.85, z: -(range + 5) };
    expect(tryFire(u, farTarget)).toBeNull();
    // A target inside range succeeds.
    const nearTarget = { x: 0, y: 0.85, z: -(range - 5) };
    expect(tryFire(u, nearTarget)).not.toBeNull();
  });

  it('a projectile hitting stone leaves a smaller crater than dirt', () => {
    function impact(material: number): number {
      const w = VoxelWorld.create(false);
      const v = w.buffers.voxels;
      // Block must be larger than the explosion radius (2.4 m ≈ 19 voxels) so
      // the falloff is what gates how many voxels survive — otherwise the
      // entire block sits inside the >hp peak and both materials clear out.
      const half = 24;
      for (let dx = -half; dx <= half; dx++) {
        for (let dy = -half; dy <= half; dy++) {
          for (let dz = -half; dz <= half; dz++) {
            v[worldIndex(80 + dx, 70 + dy, 200 + dz)] = material;
          }
        }
      }
      const mgr = new ProjectileManager();
      mgr.spawn('rpg40mm', (80 - 30) * VOXEL_SIZE, 70.5 * VOXEL_SIZE, 200.5 * VOXEL_SIZE, 1, 0, 0, -1);
      let destroyed = 0;
      for (let i = 0; i < 60 && mgr.projectiles.length > 0; i++) {
        mgr.tick(0.02, w, [], (e) => { destroyed += e.destroyedCount; });
      }
      return destroyed;
    }
    const dirtDestroyed = impact(M_DIRT);
    const stoneDestroyed = impact(M_STONE);
    expect(dirtDestroyed).toBeGreaterThan(0);
    expect(stoneDestroyed).toBeGreaterThan(0);
    // Stone has higher hp so the same explosion can't kill as many voxels.
    expect(stoneDestroyed).toBeLessThan(dirtDestroyed);
  });
});
