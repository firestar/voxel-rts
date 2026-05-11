import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import {
  BARRACKS, FARM, POWER_PLANT, SILO,
  BuildingManager, checkFootprint,
} from '../src/sim/Buildings';
import { ProjectileManager, PROJECTILES } from '../src/sim/Projectiles';

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

/**
 * Synthesise a projectile impact straight from a catalog kind. Mirrors the
 * shape `ProjectileManager.emitImpact` produces so we can exercise
 * `applyImpactDamage` without running a full ballistic tick.
 */
function makeImpact(
  kind: keyof typeof PROJECTILES,
  x: number, y: number, z: number,
): import('../src/sim/Projectiles').ProjectileImpact {
  const cfg = PROJECTILES[kind];
  return {
    kind: cfg.kind,
    hitDamage: cfg.hitDamage,
    x, y, z,
    explosive: cfg.explosive,
    explosionRadiusMeters: cfg.explosionRadiusMeters,
    damagePeak: cfg.explosive ? cfg.explosionPeak : cfg.hitDamage,
    hitRadiusMeters: cfg.hitRadiusMeters,
    directHitUnitId: -1,
    terrainDamageScale: cfg.terrainDamageScale ?? 1,
    ownerId: -1,
  };
}

/** Shorthand: world-space centre of a placed building's footprint. */
function buildingCenter(b: { ox: number; oz: number; floorY: number; spec: { cellsW: number; cellsD: number; headroomVoxels: number } }): { x: number; y: number; z: number } {
  return {
    x: (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE,
    y: (b.floorY + b.spec.headroomVoxels * 0.5) * VOXEL_SIZE,
    z: (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE,
  };
}

describe('Building HP — defaults', () => {
  it('every spec carries a positive maxHp', () => {
    for (const spec of [BARRACKS, FARM, POWER_PLANT, SILO]) {
      expect(spec.maxHp, `${spec.kind} maxHp`).toBeGreaterThan(0);
    }
  });

  it('place() initialises hp to maxHp and team defaults to player', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    expect(b.maxHp).toBe(BARRACKS.maxHp);
    expect(b.hp).toBe(BARRACKS.maxHp);
    expect(b.team).toBe('player');
    expect(b.destroyed).toBe(false);
  });

  it('place() honours an explicit team option (sandbox enemy buildings)', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY, { team: 'enemy' });
    expect(b.team).toBe('enemy');
  });
});

describe('Building HP — applyImpactDamage', () => {
  it('a direct bullet impact inside the AABB takes hitDamage off the building', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    const c = buildingCenter(b);
    bm.applyImpactDamage(makeImpact('bullet_5_56mm', c.x, c.y, c.z));
    expect(b.hp).toBe(BARRACKS.maxHp - PROJECTILES.bullet_5_56mm.hitDamage);
    expect(b.destroyed).toBe(false);
  });

  it('a non-explosive round whose impact lies outside the AABB does no HP damage', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    const c = buildingCenter(b);
    // 50 m off to the side — well past any spec footprint.
    bm.applyImpactDamage(makeImpact('bullet_5_56mm', c.x + 50, c.y, c.z));
    expect(b.hp).toBe(BARRACKS.maxHp);
  });

  it('an explosive blast inside the AABB takes both hitDamage and the full explosion peak', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, POWER_PLANT, 8, 8);
    const b = bm.place(world, POWER_PLANT, 8, 8, fp.floorY);
    const c = buildingCenter(b);
    const cfg = PROJECTILES.tank_shell;
    bm.applyImpactDamage(makeImpact('tank_shell', c.x, c.y, c.z));
    // Direct hit (dist=0) → hitDamage + full explosionPeak (falloff = 1).
    expect(b.hp).toBe(POWER_PLANT.maxHp - cfg.hitDamage - cfg.explosionPeak);
  });

  it('explosive splash falls off linearly with distance from the AABB', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    const cfg = PROJECTILES.tank_shell;
    // Drop the burst at the +X face plus half the explosion radius outward,
    // at floor height. The AABB distance is exactly explosionRadius/2 so the
    // falloff is 0.5; non-explosive direct-hit damage is 0 (dist > 0).
    const wxEnd = (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const cy = (b.floorY + b.spec.headroomVoxels * 0.5) * VOXEL_SIZE;
    const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    bm.applyImpactDamage(makeImpact('tank_shell', wxEnd + cfg.explosionRadiusMeters / 2, cy, cz));
    const expectedSplash = cfg.explosionPeak * 0.5;
    expect(b.hp).toBeCloseTo(BARRACKS.maxHp - expectedSplash, 5);
    expect(b.destroyed).toBe(false);
  });

  it('an explosion outside the explosion radius does not damage the building', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    const cfg = PROJECTILES.tank_shell;
    const wxEnd = (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const cy = (b.floorY + b.spec.headroomVoxels * 0.5) * VOXEL_SIZE;
    const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    // Two radii away — well outside the blast.
    bm.applyImpactDamage(makeImpact('tank_shell', wxEnd + cfg.explosionRadiusMeters * 2, cy, cz));
    expect(b.hp).toBe(BARRACKS.maxHp);
  });

  it('repeated impacts drain HP and flip destroyed when it reaches zero', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 8, 8);
    const b = bm.place(world, FARM, 8, 8, fp.floorY);
    const c = buildingCenter(b);
    // Farm has 200 HP; a tank shell direct-hit deals hitDamage + explosionPeak,
    // which alone is enough to level it. One impact should be plenty.
    bm.applyImpactDamage(makeImpact('tank_shell', c.x, c.y, c.z));
    expect(b.hp).toBe(0);
    expect(b.destroyed).toBe(true);
  });

  it('a destroyed building takes no further damage on subsequent impacts', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 8, 8);
    const b = bm.place(world, FARM, 8, 8, fp.floorY);
    const c = buildingCenter(b);
    // First shot levels it.
    bm.applyImpactDamage(makeImpact('tank_shell', c.x, c.y, c.z));
    expect(b.destroyed).toBe(true);
    expect(b.hp).toBe(0);
    // Re-aim the same shot — no further mutation.
    bm.applyImpactDamage(makeImpact('tank_shell', c.x, c.y, c.z));
    expect(b.hp).toBe(0);
  });

  it('damage is team-agnostic — a player projectile hurts a player building (and vice versa)', () => {
    // applyImpactDamage doesn't read impact owner / team. We verify the
    // contract directly: an enemy building and a player building both bleed
    // HP from the same impact at their centres.
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp1 = checkFootprint(world.buffers.voxels, nav, BARRACKS, 4, 4);
    const player = bm.place(world, BARRACKS, 4, 4, fp1.floorY);
    const fp2 = checkFootprint(world.buffers.voxels, nav, BARRACKS, 20, 20);
    const enemy = bm.place(world, BARRACKS, 20, 20, fp2.floorY, { team: 'enemy' });
    const cP = buildingCenter(player);
    const cE = buildingCenter(enemy);
    bm.applyImpactDamage(makeImpact('bullet_5_56mm', cP.x, cP.y, cP.z));
    bm.applyImpactDamage(makeImpact('bullet_5_56mm', cE.x, cE.y, cE.z));
    expect(player.hp).toBe(BARRACKS.maxHp - PROJECTILES.bullet_5_56mm.hitDamage);
    expect(enemy.hp).toBe(BARRACKS.maxHp - PROJECTILES.bullet_5_56mm.hitDamage);
  });
});

describe('Building HP — end-to-end via ProjectileManager', () => {
  it('a fired bullet that lands inside a building drains HP via the impact pipeline', () => {
    // No voxel world (empty) — the round flies free until it lands at the
    // building centre, mirroring the path Game would take when applying
    // applyImpactDamage to each pendingImpact.
    const world = VoxelWorld.create(false);
    // Place a building anywhere — the world voxels under it don't matter for
    // this test since we're only checking HP bookkeeping. We can't use
    // checkFootprint without nav, so call stamp manually at floorY=0.
    const bm = new BuildingManager();
    const b = bm.place(world, BARRACKS, 4, 4, 0);
    const c = buildingCenter(b);
    const pm = new ProjectileManager();
    // Fire a bullet straight at the building centre from a few meters away.
    const muzzleX = c.x - 3;
    const dir = { x: 1, y: 0, z: 0 };
    pm.spawn('bullet_5_56mm', muzzleX, c.y, c.z, dir.x, dir.y, dir.z, -1);
    // Tick until impact fires; the empty world has no terrain blocking the
    // round, but the building stamp added voxels in our path so the
    // raycastVoxel collision will fire.
    let imp = null;
    for (let i = 0; i < 600 && imp === null; i++) {
      pm.tick(1 / 240, world);
      if (pm.pendingImpacts.length > 0) imp = pm.pendingImpacts[0]!;
    }
    expect(imp, 'bullet must impact the building voxels').not.toBeNull();
    bm.applyImpactDamage(imp!);
    expect(b.hp).toBeLessThan(BARRACKS.maxHp);
  });
});
