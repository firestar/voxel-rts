import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_DIRT, M_GRASS, M_STONE } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import { TURRET, BuildingManager, checkFootprint } from '../src/sim/Buildings';
import { UnitManager } from '../src/sim/Units';
import { ProjectileManager } from '../src/sim/Projectiles';
import { UNIT_ACTIONS } from '../src/app/Actions';

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

describe('Turret hittability gate', () => {
  it('does not fire when a tall stone wall blocks the trajectory to the target', () => {
    const world = buildFlatWorld();
    const v = world.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    const bm = new BuildingManager();
    const pm = new ProjectileManager();
    bm.projectiles = pm;
    const fp = checkFootprint(world.buffers.voxels, nav, TURRET, 8, 8);
    const t = bm.place(world, TURRET, 8, 8, fp.floorY);
    // Place an enemy 30 m away in +X. Then build a stout stone wall midway
    // between the turret and the target — taller than the turret-shell arc
    // so the trajectory can't clear it. The wall sits 1 voxel = 0.125 m
    // wide so a tank shell won't blow through one frame of it.
    const cxw = (t.ox + t.spec.cellsW * 0.5) * NAV_CELL_VOXELS * 0.125;
    const czw = (t.oz + t.spec.cellsD * 0.5) * NAV_CELL_VOXELS * 0.125;
    um.spawn('soldier', cxw + 30, (fp.floorY + 1) * 0.125, czw, { team: 'enemy' });
    // Build a wall column between turret and target. Origin in voxels.
    const wallVx = Math.floor((cxw + 12) / 0.125);
    for (let dx = 0; dx < 6; dx++) {
      for (let dy = 0; dy < 60; dy++) {
        for (let dz = -8; dz <= 8; dz++) {
          v[worldIndex(wallVx + dx, fp.floorY + 1 + dy, Math.floor(czw / 0.125) + dz)] = M_STONE;
        }
      }
    }
    // Re-index nav since we modified terrain.
    buildSurfaceNav(world.buffers.voxels, nav);
    // Run far past the slew + cooldown. Without the gate, the turret would
    // happily lob shells into the wall.
    for (let i = 0; i < 600; i++) bm.tick(1 / 60, world, um);
    expect(pm.projectiles.length).toBe(0);
  });
});

describe('Unit combat stance', () => {
  it('newly spawned units default to defensive', () => {
    const um = new UnitManager();
    const u = um.spawn('soldier', 0, 1, 0);
    expect(u.stance).toBe('defensive');
  });

  it('Stance: Aggressive action sets stance="aggressive" on armed units only', () => {
    const um = new UnitManager();
    const sol = um.spawn('soldier', 0, 1, 0);
    const worker = um.spawn('worker', 0, 1, 0);
    const aggressive = UNIT_ACTIONS.find(a => a.id === 'stance-aggressive')!;
    expect(aggressive.applicable(sol)).toBe(true);
    expect(aggressive.applicable(worker)).toBe(false);
    aggressive.run([sol], { enterBuildMode: () => {}, enterPlantMode: () => {}, cancelMode: () => {}, enterWaypointMode: () => {} });
    expect(sol.stance).toBe('aggressive');
  });

  it('Stance: Defensive clears any pending firing target', () => {
    const um = new UnitManager();
    const sol = um.spawn('soldier', 0, 1, 0);
    sol.stance = 'aggressive';
    sol.firingTarget = { x: 10, y: 1, z: 0 };
    const def = UNIT_ACTIONS.find(a => a.id === 'stance-defensive')!;
    def.run([sol], { enterBuildMode: () => {}, enterPlantMode: () => {}, cancelMode: () => {}, enterWaypointMode: () => {} });
    expect(sol.stance).toBe('defensive');
    expect(sol.firingTarget).toBeNull();
  });
});
