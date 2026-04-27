import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import { AA_TURRET, BuildingManager, checkFootprint } from '../src/sim/Buildings';
import { UnitManager } from '../src/sim/Units';
import { ProjectileManager } from '../src/sim/Projectiles';

/**
 * Coverage for the AA flak turret's magazine + reload cycle.
 *
 * Setup notes:
 *   - We deliberately do NOT call `pm.update()`. That keeps the synthetic
 *     enemy projectile parked in place and prevents flak shells from
 *     detonating, so the AA stays focused on the same target every tick
 *     while the magazine drains.
 *   - The enemy projectile is spawned with `ownerId = -1` (anonymous) which
 *     `tickAntiAir` accepts as engageable — same hook the existing intercept
 *     test uses to mark a round as enemy-aligned.
 */
function buildFlatWorld(surfaceY = 32): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

function setupAA(): {
  world: VoxelWorld;
  bm: BuildingManager;
  pm: ProjectileManager;
  um: UnitManager;
  aa: ReturnType<BuildingManager['place']>;
} {
  const world = buildFlatWorld();
  const nav = allocateNav(false);
  buildSurfaceNav(world.buffers.voxels, nav);
  const um = new UnitManager();
  const bm = new BuildingManager();
  const pm = new ProjectileManager();
  bm.projectiles = pm;
  const fp = checkFootprint(world.buffers.voxels, nav, AA_TURRET, 8, 8);
  const aa = bm.place(world, AA_TURRET, 8, 8, fp.floorY);
  return { world, bm, pm, um, aa };
}

function spawnEnemyTarget(
  pm: ProjectileManager,
  aa: ReturnType<BuildingManager['place']>,
): void {
  const cxw = (aa.ox + aa.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
  const czw = (aa.oz + aa.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
  const muzzleY = (aa.floorY + 1) * VOXEL_SIZE + (aa.spec.weaponMuzzleHeight ?? 1.0);
  // Anonymous owner (ownerId = -1) is the same path AA uses for cluster
  // submunitions and matches what the AA's targeting filter accepts.
  pm.spawn('rpg', cxw + 30, muzzleY + 5, czw, 0, 0, 0, -1);
}

describe('AA turret magazine + reload', () => {
  it('starts loaded with 12 rounds and not reloading', () => {
    const { aa } = setupAA();
    expect(aa.spec.weaponMagazineSize).toBe(12);
    expect(aa.spec.weaponReloadSeconds).toBe(30);
    expect(aa.weaponAmmo).toBe(12);
    expect(aa.weaponReloadTimer).toBe(0);
    expect(aa.weaponTurretPitch).toBe(0);
  });

  it('drains the magazine round-by-round and triggers a 30 s reload on empty', () => {
    const { world, bm, pm, um, aa } = setupAA();
    spawnEnemyTarget(pm, aa);
    let flakCountAtEmpty = 0;
    for (let i = 0; i < 60 * 12; i++) {
      bm.tick(1 / 60, world, um);
      if (aa.weaponAmmo === 0) {
        flakCountAtEmpty = pm.projectiles.filter(p => p.kind === 'flak_shell').length;
        break;
      }
    }
    expect(aa.weaponAmmo).toBe(0);
    expect(flakCountAtEmpty).toBe(12);
    // Reload timer is initialised to the full 30 s window on the very tick
    // the magazine empties (no further decay yet).
    expect(aa.weaponReloadTimer).toBe(30);
  });

  it('refuses to fire while reloading and refills the magazine when the timer expires', () => {
    const { world, bm, pm, um, aa } = setupAA();
    spawnEnemyTarget(pm, aa);
    // Drain the magazine.
    for (let i = 0; i < 60 * 12; i++) {
      bm.tick(1 / 60, world, um);
      if (aa.weaponAmmo === 0) break;
    }
    expect(aa.weaponAmmo).toBe(0);
    const flakAtEmpty = pm.projectiles.filter(p => p.kind === 'flak_shell').length;

    // Run for 29 seconds — turret is still reloading and must not fire.
    for (let i = 0; i < 60 * 29; i++) bm.tick(1 / 60, world, um);
    expect(aa.weaponReloadTimer).toBeGreaterThan(0);
    expect(aa.weaponReloadTimer).toBeLessThan(2);
    expect(aa.weaponAmmo).toBe(0);
    expect(pm.projectiles.filter(p => p.kind === 'flak_shell').length).toBe(flakAtEmpty);

    // Step one tick at a time until the reload timer crosses 0 — the
    // magazine refills on that exact tick, before any new shot can fire.
    for (let i = 0; i < 120; i++) {
      bm.tick(1 / 60, world, um);
      if (aa.weaponReloadTimer === 0) break;
    }
    expect(aa.weaponReloadTimer).toBe(0);
    expect(aa.weaponAmmo).toBe(12);
  });

  it('tilts the turret pitch down while reloading and recovers to level afterward', () => {
    const { world, bm, pm, um, aa } = setupAA();
    spawnEnemyTarget(pm, aa);
    for (let i = 0; i < 60 * 12; i++) {
      bm.tick(1 / 60, world, um);
      if (aa.weaponAmmo === 0) break;
    }
    expect(aa.weaponAmmo).toBe(0);
    // After ~2 s of reload the pitch should be close to the stowed pose
    // (negative, well below horizontal).
    for (let i = 0; i < 120; i++) bm.tick(1 / 60, world, um);
    expect(aa.weaponTurretPitch).toBeLessThan(-1.0);

    // Run out the reload + give the recovery slew a couple of seconds.
    for (let i = 0; i < 60 * 30; i++) bm.tick(1 / 60, world, um);
    expect(aa.weaponReloadTimer).toBe(0);
    expect(Math.abs(aa.weaponTurretPitch)).toBeLessThan(0.05);
  });
});
