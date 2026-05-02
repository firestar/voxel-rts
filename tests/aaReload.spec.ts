import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import { AA_TURRET, BuildingManager, checkFootprint } from '../src/sim/Buildings';
import { UnitManager } from '../src/sim/Units';
import { ProjectileManager } from '../src/sim/Projectiles';

/**
 * Coverage for the AA missile launcher.
 *
 * Setup notes:
 *   - We deliberately do NOT call `pm.tick()`. That keeps the synthetic
 *     enemy projectile parked in place so the AA stays focused on the same
 *     target every tick.
 *   - The enemy projectile is spawned with `ownerId = -1` (anonymous) which
 *     `tickAntiAir` accepts as engageable.
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
  // Anonymous owner (ownerId = -1) is accepted as engageable by tickAntiAir.
  pm.spawn('rpg', cxw + 30, muzzleY + 5, czw, 0, 0, 0, -1);
}

describe('AA missile launcher', () => {
  it('has no magazine — spec has no weaponMagazineSize or weaponReloadSeconds', () => {
    const { aa } = setupAA();
    expect(aa.spec.weaponMagazineSize).toBeUndefined();
    expect(aa.spec.weaponReloadSeconds).toBeUndefined();
    expect(aa.weaponReloadTimer).toBe(0);
  });

  it('fires an aa_missile (not a flak_shell) at an incoming enemy projectile', () => {
    const { world, bm, pm, um, aa } = setupAA();
    spawnEnemyTarget(pm, aa);
    // Run up to 3 s for slew + first shot.
    for (let i = 0; i < 60 * 3; i++) {
      bm.tick(1 / 60, world, um);
      // stop once the AA has fired so the missile is still live.
      const missiles = pm.projectiles.filter(p => p.kind === 'aa_missile');
      if (missiles.length > 0) break;
    }
    const missiles = pm.projectiles.filter(p => p.kind === 'aa_missile');
    expect(missiles.length).toBeGreaterThan(0);
    expect(pm.projectiles.filter(p => p.kind === 'flak_shell').length).toBe(0);
  });

  it('enters a 10 s cooldown after firing and does not shoot again until it expires', () => {
    const { world, bm, pm, um, aa } = setupAA();
    spawnEnemyTarget(pm, aa);
    // Let the first missile fire.
    for (let i = 0; i < 60 * 3; i++) {
      bm.tick(1 / 60, world, um);
      if (pm.projectiles.filter(p => p.kind === 'aa_missile').length > 0) break;
    }
    expect(pm.projectiles.filter(p => p.kind === 'aa_missile').length).toBeGreaterThan(0);
    // Cooldown should be active (~10 s remaining).
    expect(aa.weaponFireCooldown).toBeGreaterThan(5);

    // Clear the live aa_missiles so we can detect a new shot.
    const countBefore = pm.projectiles.filter(p => p.kind === 'aa_missile').length;
    // Tick 5 more seconds — still within cooldown, no new shot.
    for (let i = 0; i < 60 * 5; i++) bm.tick(1 / 60, world, um);
    expect(pm.projectiles.filter(p => p.kind === 'aa_missile').length).toBe(countBefore);
    expect(aa.weaponFireCooldown).toBeGreaterThan(0);
  });

  it('barrel does not stow (weaponReloadTimer stays 0) because there is no magazine', () => {
    const { world, bm, pm, um, aa } = setupAA();
    spawnEnemyTarget(pm, aa);
    // Run long enough for firing and cooldown to cycle.
    for (let i = 0; i < 60 * 15; i++) bm.tick(1 / 60, world, um);
    // No magazine means no reload timer should ever activate.
    expect(aa.weaponReloadTimer).toBe(0);
  });
});
