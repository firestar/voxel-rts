import { describe, it, expect } from 'vitest';
import { UnitManager } from '../src/sim/Units';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_BEDROCK } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_METERS } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';

/**
 * Build a world with a vertical step at world-X = `boundaryCx * NAV_CELL_METERS`:
 * everything left of the boundary tops out at `lowTopY` voxels, everything right of
 * it at `highTopY` voxels. Bedrock at the bottom, dirt fill, grass on top.
 */
function buildStepWorld(boundaryCx: number, lowTopY: number, highTopY: number): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const NAV_CELL_VOXELS = 8;
  const boundaryVx = boundaryCx * NAV_CELL_VOXELS;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      const top = x < boundaryVx ? lowTopY : highTopY;
      for (let y = 2; y < top; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, top, z)] = M_GRASS;
    }
  }
  return world;
}

describe('surface-follow Y on tall steps', () => {
  it('soldier whose footprint straddles a 3 m step rests on the upper voxel, not buried inside it', () => {
    // Step = 24 voxels = 3 m. Larger than the old 1.5 m search range that
    // findFootprintTopVoxel used, but well inside the soldier's 32-voxel
    // (4 m) climb cap, so this is a position the path search would happily
    // place a soldier in. The bug used to snap the soldier's feet to a
    // voxel ~1.5 m below the actual ledge — drawn by the renderer as the
    // unit half-buried in the hillside.
    const boundaryCx = 50;
    const lowTopY = 32;
    const highTopY = 56;
    const world = buildStepWorld(boundaryCx, lowTopY, highTopY);
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    // Centre the soldier just inside the LOW cell so its center cell's
    // cellTop = lowTopY = 32. The footprint extends ±0.375 m (3 voxels)
    // and must reach into the HIGH cell at +X.
    const um = new UnitManager();
    const cxBoundaryM = boundaryCx * NAV_CELL_METERS; // 50.0 m
    const u = um.spawn(
      'soldier',
      cxBoundaryM - 0.05,
      (lowTopY + 1) * VOXEL_SIZE,
      60 * NAV_CELL_METERS,
    );

    // Idle (no path) → tick still runs sampleSurfaceFollow, which is the function
    // under test. Run for 1 s so the eased snap converges.
    for (let i = 0; i < 60; i++) {
      um.tick(1 / 60, nav, vnav, world.buffers.voxels, () => {});
    }

    // The unit's feet must sit at or above the top of the HIGH voxel column
    // its footprint touches (y = highTopY+1 voxels). Old code clamped Y to
    // ~lowTopY+13 voxels = (45)*0.125 = 5.625 m — well below the ledge.
    const expectedY = (highTopY + 1) * VOXEL_SIZE;
    expect(u.y).toBeCloseTo(expectedY, 2);
  });

  it('worker whose footprint straddles a 2.5 m step rests on the upper voxel', () => {
    // Workers have maxStepVoxels=24 (3 m), so a 20-voxel (2.5 m) step is in range.
    // Same regression as the soldier — the worker's halfWidth (0.325 m) is
    // narrower so the bug is borderline, but the principle is identical.
    const boundaryCx = 40;
    const lowTopY = 28;
    const highTopY = 48; // 20-voxel step = 2.5 m
    const world = buildStepWorld(boundaryCx, lowTopY, highTopY);
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const cxBoundaryM = boundaryCx * NAV_CELL_METERS;
    const u = um.spawn(
      'worker',
      cxBoundaryM - 0.05,
      (lowTopY + 1) * VOXEL_SIZE,
      50 * NAV_CELL_METERS,
    );

    for (let i = 0; i < 60; i++) {
      um.tick(1 / 60, nav, vnav, world.buffers.voxels, () => {});
    }

    const expectedY = (highTopY + 1) * VOXEL_SIZE;
    expect(u.y).toBeCloseTo(expectedY, 2);
  });

  it('tank whose wide footprint straddles a step rests on top of the highest voxel under any tread', () => {
    // Tank's bodyHalfCells=1 + bodyRoughnessVoxels=5 means the path search
    // would never put it on a true 5-voxel step at the cell boundary — but
    // the half-width (1.2 m = 9.6 voxels) reaches into adjacent cells, so
    // the search still has to scan a meaningful range. We use a 4-voxel
    // (0.5 m) step which is exactly the tank's max climb.
    const boundaryCx = 45;
    const lowTopY = 36;
    const highTopY = 40; // 4-voxel step = 0.5 m, the tank's exact climb cap
    const world = buildStepWorld(boundaryCx, lowTopY, highTopY);
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const cxBoundaryM = boundaryCx * NAV_CELL_METERS;
    const u = um.spawn(
      'tank',
      cxBoundaryM - 0.05,
      (lowTopY + 1) * VOXEL_SIZE,
      55 * NAV_CELL_METERS,
    );

    for (let i = 0; i < 60; i++) {
      um.tick(1 / 60, nav, vnav, world.buffers.voxels, () => {});
    }

    const expectedY = (highTopY + 1) * VOXEL_SIZE;
    expect(u.y).toBeCloseTo(expectedY, 2);
  });

  it('on a steep slope the rendered pitch is clamped to the unit\'s maxPitchRad cap', () => {
    // Tank maxPitchRad = π/6 ≈ 30°. The slope kernel reads cells cx±1 (2 m apart),
    // so a 32-voxel = 4 m step gives atan(4/2) ≈ 63°, well past the tank's 30° cap.
    // Without the clamp the renderer drew the body past its hull articulation.
    const boundaryCx = 45;
    const lowTopY = 32;
    const highTopY = 64; // 32-voxel step = 4 m, ~63° apparent slope
    const world = buildStepWorld(boundaryCx, lowTopY, highTopY);
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    const um = new UnitManager();
    const cxBoundaryM = boundaryCx * NAV_CELL_METERS;
    // Sit the tank ON the boundary cell so the slope kernel reads the LOW
    // cell at cx-1 and the HIGH cell at cx+1 — full 4 m drop across 2 m.
    const u = um.spawn(
      'tank',
      cxBoundaryM + NAV_CELL_METERS * 0.5,
      (highTopY + 1) * VOXEL_SIZE,
      55 * NAV_CELL_METERS,
    );
    u.heading = -Math.PI / 2; // forward = +X, putting the slope along the chassis nose

    for (let i = 0; i < 60; i++) {
      um.tick(1 / 60, nav, vnav, world.buffers.voxels, () => {});
    }

    expect(Math.abs(u.pitch)).toBeLessThanOrEqual(u.maxPitchRad + 1e-6);
    expect(Math.abs(u.roll)).toBeLessThanOrEqual(u.maxPitchRad + 1e-6);
  });
});
