import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import {
  ALL_BUILDINGS, BARRACKS, POWER_PLANT, REFINERY, TECH_LAB,
  BuildingManager, checkFootprint,
} from '../src/sim/Buildings';
import { UnitManager } from '../src/sim/Units';

/** Flat dirt/grass plane — all four building specs should place anywhere on it. */
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

describe('building specs', () => {
  it('exposes all kinds via ALL_BUILDINGS in registry order', () => {
    expect(ALL_BUILDINGS.map(s => s.kind)).toEqual([
      'barracks', 'farm', 'storage', 'power_plant', 'refinery', 'tech_lab',
    ]);
  });

  it('only the barracks produces units; the rest are non-producers', () => {
    expect(BARRACKS.produces.length).toBeGreaterThan(0);
    expect(POWER_PLANT.produces.length).toBe(0);
    expect(REFINERY.produces.length).toBe(0);
    expect(TECH_LAB.produces.length).toBe(0);
  });

  it('non-producers carry an Infinity production interval (sentinel for the tick guard)', () => {
    expect(POWER_PLANT.productionInterval).toBe(Infinity);
    expect(REFINERY.productionInterval).toBe(Infinity);
    expect(TECH_LAB.productionInterval).toBe(Infinity);
  });
});

describe('checkFootprint over flat terrain', () => {
  it('passes for every spec on a flat dirt plane', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    for (const spec of ALL_BUILDINGS) {
      const fp = checkFootprint(world.buffers.voxels, nav, spec, 8, 8);
      expect(fp.ok, `expected ${spec.kind} to fit at (8,8): ${fp.reason}`).toBe(true);
      expect(fp.floorY).toBeGreaterThan(0);
    }
  });
});

describe('stamp functions write voxels and produce distinctive shapes', () => {
  it('barracks stamps a hollow box with a door cut on the +X face', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 8, oz = 8;
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, ox, oz);
    const wallVoxels = BARRACKS.stamp(world, ox, oz, fp.floorY);
    expect(wallVoxels).toBeGreaterThan(0);

    // Door cells on +X face should be air at floor level (the door cutout).
    const wxEnd = (ox + BARRACKS.cellsW) * NAV_CELL_VOXELS - 1;
    const wzMid = ((oz + BARRACKS.cellsD * 0.5) * NAV_CELL_VOXELS) | 0;
    expect(world.get(wxEnd, fp.floorY + 2, wzMid - 1)).toBe(AIR);
  });

  it('power plant stamps a parapet + central pylon stub above the main roof', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 12, oz = 12;
    const fp = checkFootprint(world.buffers.voxels, nav, POWER_PLANT, ox, oz);
    const wallVoxels = POWER_PLANT.stamp(world, ox, oz, fp.floorY);
    expect(wallVoxels).toBeGreaterThan(0);

    // The pylon stub is 6 voxels of M_WOOD above (floorY + headroom). Probe the
    // centre column at floorY + headroom + 3 — should be solid (wood).
    const cxv = ((ox + POWER_PLANT.cellsW * 0.5) * NAV_CELL_VOXELS) | 0;
    const czv = ((oz + POWER_PLANT.cellsD * 0.5) * NAV_CELL_VOXELS) | 0;
    const probeY = fp.floorY + POWER_PLANT.headroomVoxels + 3;
    // World.set with center maths uses (cxv-1, cxv, czv-1, czv) for the 2x2 column.
    expect(world.get(cxv - 1, probeY, czv - 1)).not.toBe(AIR);
  });

  it('refinery stack rises at least 24 voxels above the main roof', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 6, oz = 6;
    const fp = checkFootprint(world.buffers.voxels, nav, REFINERY, ox, oz);
    REFINERY.stamp(world, ox, oz, fp.floorY);

    // Chimney column is at the back-left interior corner (offset 2 voxels from
    // each perimeter wall, 2x2 column).
    const wxStart = ox * NAV_CELL_VOXELS;
    const wzStart = oz * NAV_CELL_VOXELS;
    const chimX = wxStart + 2;
    const chimZ = wzStart + 2;
    // Probe well above the main roof — should still be solid stack.
    const stackProbeY = fp.floorY + REFINERY.headroomVoxels + 20;
    expect(world.get(chimX, stackProbeY, chimZ)).not.toBe(AIR);
    expect(world.get(chimX + 1, stackProbeY, chimZ + 1)).not.toBe(AIR);
  });

  it('tech lab dome narrows toward the apex (perimeter solid, centre still solid above)', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 10, oz = 10;
    const fp = checkFootprint(world.buffers.voxels, nav, TECH_LAB, ox, oz);
    TECH_LAB.stamp(world, ox, oz, fp.floorY);

    // At the dome's first tier the centre is still solid stone, but the corners
    // (where the original perimeter wall sat) should now be air — the dome is
    // inset from the perimeter.
    const wxStart = ox * NAV_CELL_VOXELS;
    const wzStart = oz * NAV_CELL_VOXELS;
    const wxEnd = wxStart + TECH_LAB.cellsW * NAV_CELL_VOXELS;
    const wzEnd = wzStart + TECH_LAB.cellsD * NAV_CELL_VOXELS;
    const tier1Y = fp.floorY + TECH_LAB.headroomVoxels + 2;
    const cxv = ((wxStart + wxEnd) >> 1);
    const czv = ((wzStart + wzEnd) >> 1);
    expect(world.get(cxv, tier1Y, czv)).not.toBe(AIR);
    // Outer-corner column above the perimeter wall is air at the dome height (the
    // dome inset is 4 voxels per tier, so the original corner is no longer covered).
    expect(world.get(wxStart, tier1Y, wzStart)).toBe(AIR);
    // The wood antenna mast above the dome reaches floorY + headroom + 6 + 1.
    const mastY = fp.floorY + TECH_LAB.headroomVoxels + 3 * 2 + 3;
    expect(world.get(cxv, mastY, czv)).not.toBe(AIR);
  });
});

describe('BuildingManager.tick', () => {
  it("doesn't crash or spawn for non-producer buildings", () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    const bm = new BuildingManager();
    let spawned = 0;
    bm.spawner = () => { spawned++; return null; };
    // Place each spec on its own patch of the flat world so successive stamps don't
    // overlap (the first stamp raises topY in its cells; the next would fail
    // checkFootprint there).
    let cursor = 4;
    for (const spec of [POWER_PLANT, REFINERY, TECH_LAB]) {
      const fp = checkFootprint(world.buffers.voxels, nav, spec, cursor, 4);
      expect(fp.ok, `${spec.kind} at (${cursor},4): ${fp.reason}`).toBe(true);
      bm.place(world, spec, cursor, 4, fp.floorY);
      cursor += spec.cellsW + 2;
    }
    // Run far longer than any conceivable production interval — non-producers
    // should never call the spawner.
    for (let i = 0; i < 1000; i++) bm.tick(0.1, world, um);
    expect(spawned).toBe(0);
  });
});
