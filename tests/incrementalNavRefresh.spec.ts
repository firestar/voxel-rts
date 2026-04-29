import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import {
  allocateNav, buildSurfaceNav, refreshSurfaceNavBox,
  NAV_CELL_VOXELS, NAV_W, NAV_H, navIndex,
} from '../src/path/SurfaceNav';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';

const SURFACE_VY = 64;

/** Same shape as the helper in newPathBasics.spec.ts — flat layered terrain. */
function buildLayeredWorld(world: VoxelWorld): void {
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      for (let y = 1; y < SURFACE_VY; y++) v[worldIndex(x, y, z)] = M_STONE;
      for (let y = SURFACE_VY; y < SURFACE_VY + 4; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, SURFACE_VY + 4, z)] = M_GRASS;
    }
  }
}

/** Carve a sphere of voxels to AIR — emulates damageSphere without HP bookkeeping. */
function carveSphereVoxels(world: VoxelWorld, cx: number, cy: number, cz: number, r: number): void {
  const v = world.buffers.voxels;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const z0 = Math.max(0, Math.floor(cz - r));
  const x1 = Math.min(WORLD_X - 1, Math.ceil(cx + r));
  const y1 = Math.min(127, Math.ceil(cy + r));
  const z1 = Math.min(WORLD_Z - 1, Math.ceil(cz + r));
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (v[worldIndex(x, y, z)] === M_BEDROCK) continue;
        v[worldIndex(x, y, z)] = AIR;
      }
    }
  }
}

describe('incremental nav refresh after explosion', () => {
  it('refreshSurfaceNavBox matches a full buildSurfaceNav over the affected cells', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const incremental = allocateNav(false);
    const fullRef = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, incremental);
    buildSurfaceNav(world.buffers.voxels, fullRef);

    // Carve a 3 m crater near the world centre. Touches a handful of surface
    // cells; nothing else should differ.
    const craterCx = WORLD_X / 2;
    const craterCz = WORLD_Z / 2;
    const craterCy = SURFACE_VY + 4;
    const radius = 24; // voxels (3 m)
    carveSphereVoxels(world, craterCx, craterCy, craterCz, radius);

    // Apply the incremental refresh to one buffer and a full rebuild to the
    // other. The fields must agree everywhere.
    const cx0 = Math.floor((craterCx - radius) / NAV_CELL_VOXELS);
    const cz0 = Math.floor((craterCz - radius) / NAV_CELL_VOXELS);
    const cx1 = Math.floor((craterCx + radius) / NAV_CELL_VOXELS);
    const cz1 = Math.floor((craterCz + radius) / NAV_CELL_VOXELS);
    refreshSurfaceNavBox(world.buffers.voxels, incremental, cx0, cz0, cx1, cz1);
    buildSurfaceNav(world.buffers.voxels, fullRef);

    for (let cz = 0; cz < NAV_H; cz++) {
      for (let cx = 0; cx < NAV_W; cx++) {
        const i = navIndex(cx, cz);
        expect(incremental.topY[i]).toBe(fullRef.topY[i]);
        expect(incremental.material[i]).toBe(fullRef.material[i]);
        expect(incremental.blocked[i]).toBe(fullRef.blocked[i]);
        expect(incremental.headroom[i]).toBe(fullRef.headroom[i]);
        expect(incremental.slope[i]).toBe(fullRef.slope[i]);
        expect(incremental.flatness[i]).toBe(fullRef.flatness[i]);
        expect(incremental.road[i]).toBe(fullRef.road[i]);
        expect(incremental.treeBlocked[i]).toBe(fullRef.treeBlocked[i]);
      }
    }
  });

  it('Pathfinder.applyDamage matches a full rebuild over the affected cells', () => {
    const worldA = VoxelWorld.create(false);
    const worldB = VoxelWorld.create(false);
    buildLayeredWorld(worldA);
    buildLayeredWorld(worldB);

    const profile = profileFromUnit({
      kind: 'soldier',
      footprintRadius: 1,
      heightVoxels: 14,
      canDig: false,
      requiresGround: true,
      maxStepVoxels: 6,
      slopePenalty: 0,
    });
    const pfIncremental = new Pathfinder(false);
    const pfFull = new Pathfinder(false);
    pfIncremental.attach(worldA);
    pfFull.attach(worldB);
    pfIncremental.registerProfile(profile);
    pfFull.registerProfile(profile);

    // Carve identical craters in both worlds.
    const craterCx = WORLD_X / 2;
    const craterCz = WORLD_Z / 2;
    const craterCy = SURFACE_VY + 4;
    const radius = 24; // voxels (3 m)
    carveSphereVoxels(worldA, craterCx, craterCy, craterCz, radius);
    carveSphereVoxels(worldB, craterCx, craterCy, craterCz, radius);

    // World A: incremental. World B: full rebuild.
    const VOXEL_M = 0.125;
    const r = radius * VOXEL_M;
    const wx = craterCx * VOXEL_M, wy = craterCy * VOXEL_M, wz = craterCz * VOXEL_M;
    pfIncremental.applyDamage(wx - r, wy - r, wz - r, wx + r, wy + r, wz + r);
    pfFull.rebuildAll();

    // Volume + per-unit grid bytes must match exactly.
    const vA = pfIncremental.volume;
    const vB = pfFull.volume;
    expect(Array.from(vA.solid)).toEqual(Array.from(vB.solid));
    expect(Array.from(vA.bedrock)).toEqual(Array.from(vB.bedrock));
    expect(Array.from(vA.digCost)).toEqual(Array.from(vB.digCost));
    expect(Array.from(vA.topY)).toEqual(Array.from(vB.topY));

    const gA = pfIncremental.getGrid('soldier')!;
    const gB = pfFull.getGrid('soldier')!;
    expect(Array.from(gA.passable)).toEqual(Array.from(gB.passable));
  });
});
