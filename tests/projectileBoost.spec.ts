import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_DIRT } from '../src/voxel/Materials';
import { ProjectileManager, PROJECTILES, BOOST_ASCEND_SPEED } from '../src/sim/Projectiles';

function buildFlatWorld(surfaceY = 8): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
    }
  }
  return world;
}

describe('Silo missile boost phase', () => {
  it('ascends vertical for the configured boost meters before tipping over', () => {
    const world = buildFlatWorld(2);
    const pm = new ProjectileManager();
    // Spawn one silo missile from a known origin with a target 80 m away.
    const startX = 100, startY = 5, startZ = 100;
    const targetX = 180, targetY = 1, targetZ = 100;
    const cfg = PROJECTILES.silo_missile;
    expect(cfg.boostMetersDefault).toBeGreaterThan(0);
    const p = pm.spawn(
      'silo_missile',
      startX, startY, startZ,
      // Direction passed in is irrelevant during boost; it's recomputed at the
      // end of the boost phase to point at the target.
      1, 0, 0,
      -1, 1, Infinity,
      { meters: cfg.boostMetersDefault!, targetX, targetY, targetZ },
    );
    expect(p.boostMetersRemaining).toBeCloseTo(cfg.boostMetersDefault!);
    // Initial velocity is pure vertical (no horizontal drift).
    expect(p.vx).toBeCloseTo(0);
    expect(p.vz).toBeCloseTo(0);
    expect(p.vy).toBeCloseTo(BOOST_ASCEND_SPEED);
    // Step long enough to consume the boost (10 m / 30 m/s ≈ 0.34 s).
    for (let i = 0; i < 30; i++) pm.tick(1 / 60, world);
    // After boost the missile must have horizontal velocity toward target.
    const ahead = pm.projectiles[0];
    expect(ahead, 'missile must still be live after boost').toBeDefined();
    expect(Math.hypot(ahead!.vx, ahead!.vz)).toBeGreaterThan(20);
    // It must have peaked near the configured boost altitude. The arc then
    // dives toward the lower target, so after ~0.17 s of post-boost flight
    // the missile sits a couple metres below the apex — verify it cleared
    // most of the boost climb before tipping over.
    expect(ahead!.y).toBeGreaterThan(startY + cfg.boostMetersDefault! - 4);
  });
});

describe('Projectile terrain damage scale', () => {
  it('turret_shell carries a fractional terrainDamageScale (5x reduction)', () => {
    expect(PROJECTILES.turret_shell.terrainDamageScale).toBeDefined();
    expect(PROJECTILES.turret_shell.terrainDamageScale!).toBeLessThan(0.5);
  });

  it('silo missile damage was scaled down by ~3x relative to legacy values', () => {
    // The pre-change values were hitDamage 140 / explosionPeak 380. The
    // current catalog values must be roughly a third — bound them so any
    // future tuning still respects the user's "3x decrease" intent.
    expect(PROJECTILES.silo_missile.hitDamage).toBeLessThanOrEqual(60);
    expect(PROJECTILES.silo_missile.explosionPeak).toBeLessThanOrEqual(150);
  });

  it('emitted impacts surface terrainDamageScale from the catalog', () => {
    const world = buildFlatWorld(4);
    const pm = new ProjectileManager();
    // Spawn a turret shell so close to a wall that the very next step impacts.
    const v = world.buffers.voxels;
    // Stand a wall at x=110 to interrupt the shell.
    for (let y = 5; y < 12; y++) {
      for (let z = 100; z < 105; z++) {
        v[worldIndex(110, y, z)] = M_DIRT;
      }
    }
    pm.spawn(
      'turret_shell',
      105, 7, 102,
      1, 0, 0,
      -1, 1, Infinity,
    );
    for (let i = 0; i < 60; i++) {
      pm.tick(1 / 60, world);
      if (pm.pendingImpacts.length > 0) break;
    }
    expect(pm.pendingImpacts.length).toBeGreaterThan(0);
    expect(pm.pendingImpacts[0]!.terrainDamageScale).toBeCloseTo(0.033);
  });
});
