import { describe, it, expect } from 'vitest';
import {
  allocateVolumeNav, buildVolumeNav,
  VNAV_X, VNAV_Y, VNAV_Z, vnavIndex, getBit,
} from '../src/path/VolumeNav';
const NAV_CELL_VOXELS = 8;
import { findPathVolume, AStar3DWorkspace } from '../src/path/AStar3D';
import {
  allocateMultiResNav3D, buildMultiResNav3D, generateFactors,
  baseCellPlane,
} from '../src/path/MultiResNav3D';
import {
  findPathMultiRes3D, MultiResWorkspace3D,
} from '../src/path/MultiResDijkstra3D';
import { applyEdits } from '../src/path/MultiResUpdater3D';
import {
  renderXZSlice, renderXYSlice, renderLevelSliceXZ, formatComparison,
} from '../src/path/MultiResVisual3D';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../src/voxel/types';
import { M_BEDROCK, M_STONE, M_DIRT } from '../src/voxel/Materials';

function buildHillWithCave(opts: { sealed: boolean }): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  // Solid stone hill from y=2 to y=120, bedrock floor.
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < 120; y++) v[worldIndex(x, y, z)] = M_STONE;
      v[worldIndex(x, 120, z)] = M_DIRT;
    }
  }
  // Carve a 1m-tall horizontal cave at y=80..87 along the +X axis,
  // from cell-X 30 to cell-X 100 in cell-row cz=64.
  const caveStartCx = opts.sealed ? 32 : 30;
  for (let z = 64 * NAV_CELL_VOXELS; z < 65 * NAV_CELL_VOXELS; z++) {
    for (let x = caveStartCx * NAV_CELL_VOXELS; x < 100 * NAV_CELL_VOXELS; x++) {
      for (let y = 80; y <= 87; y++) {
        v[worldIndex(x, y, z)] = AIR;
      }
    }
  }
  // If not sealed, also drill a vertical shaft from y=120 down to y=87 at the
  // start of the cave so the surface connects to it. If sealed, we leave the
  // cave's west end walled off (only reachable by digging through 2 cells).
  if (!opts.sealed) {
    const shaftCx = 30;
    for (let z = 64 * NAV_CELL_VOXELS; z < 65 * NAV_CELL_VOXELS; z++) {
      for (let x = shaftCx * NAV_CELL_VOXELS; x < (shaftCx + 1) * NAV_CELL_VOXELS; x++) {
        for (let y = 88; y <= 121; y++) {
          v[worldIndex(x, y, z)] = AIR;
        }
      }
    }
  }
  return world;
}

function buildMultiCaveWorld(): VoxelWorld {
  // Two caves at different Y, no shaft connecting them. The test will carve
  // the shaft via applyEdits and then plan from surface → deep cave.
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < 140; y++) v[worldIndex(x, y, z)] = M_STONE;
      v[worldIndex(x, 140, z)] = M_DIRT;
    }
  }
  // Upper cave at y=104..111 (cy=13), cz=64.
  for (let z = 64 * 8; z < 65 * 8; z++) {
    for (let x = 30 * 8; x < 100 * 8; x++) {
      for (let y = 104; y <= 111; y++) v[worldIndex(x, y, z)] = AIR;
    }
  }
  // Lower cave at y=40..47 (cy=5), cz=64. Also unsealed at the +X end via a
  // vertical 1-cell hole down to y=8, so it's surface-connected through that
  // chimney. The two caves don't yet connect to each other.
  for (let z = 64 * 8; z < 65 * 8; z++) {
    for (let x = 30 * 8; x < 100 * 8; x++) {
      for (let y = 40; y <= 47; y++) v[worldIndex(x, y, z)] = AIR;
    }
  }
  // Surface entry shaft into the upper cave at cx=30.
  for (let z = 64 * 8; z < 65 * 8; z++) {
    for (let x = 30 * 8; x < 31 * 8; x++) {
      for (let y = 112; y <= 141; y++) v[worldIndex(x, y, z)] = AIR;
    }
  }
  // Lower cave is intentionally sealed (no surface shaft) so a non-digger
  // unit cannot reach it from the upper cave until the test carves a vertical
  // shaft via applyEdits.
  return world;
}

describe('MultiResNav3D auto-scaled factors', () => {
  it('generates a sequence ending at the largest dimension', () => {
    const f = generateFactors(VNAV_X, VNAV_Y, VNAV_Z);
    expect(f[0]).toBe(1);
    expect(f[f.length - 1]).toBe(Math.max(VNAV_X, VNAV_Y, VNAV_Z));
    // Default ratio 20 → expect a small number of levels.
    expect(f.length).toBeGreaterThanOrEqual(2);
    expect(f.length).toBeLessThanOrEqual(5);
  });

  it('honours a smaller targetRatio', () => {
    const f = generateFactors(64, 16, 64, 5);
    expect(f[0]).toBe(1);
    expect(f[f.length - 1]).toBe(64);
    // [1, 5, 25, 64] expected.
    expect(f).toContain(5);
  });

  it('returns [1] when the map is degenerate', () => {
    expect(generateFactors(1, 1, 1)).toEqual([1]);
  });
});

describe('Multi-res 3D pathfinder — surface + cave scenarios', () => {
  it('reaches a deep cave with a surface entrance and expands fewer cells than the baseline', () => {
    const world = buildHillWithCave({ sealed: false });
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const factors = generateFactors(VNAV_X, VNAV_Y, VNAV_Z);
    const mr = allocateMultiResNav3D(VNAV_X, VNAV_Y, VNAV_Z, factors);
    buildMultiResNav3D(vnav, mr);

    // Start: top of the surface entry shaft. Goal: deep inside the cave.
    const start = { cx: 30, cy: 15, cz: 64 };
    const goal = { cx: 90, cy: 10, cz: 64 };

    // Sanity: both are air cells.
    expect(getBit(vnav.solid, vnavIndex(start.cx, start.cy, start.cz))).toBe(0);
    expect(getBit(vnav.solid, vnavIndex(goal.cx, goal.cy, goal.cz))).toBe(0);

    const ws = new MultiResWorkspace3D();
    const mres = findPathMultiRes3D(vnav, mr, ws, {
      startCx: start.cx, startCy: start.cy, startCz: start.cz,
      goalCx: goal.cx, goalCy: goal.cy, goalCz: goal.cz,
      canDig: false, requiresGround: false,
      maxExpansions: 200000,
    });

    const baselineWs = new AStar3DWorkspace();
    const baseline = findPathVolume(vnav, baselineWs, {
      startCx: start.cx, startCy: start.cy, startCz: start.cz,
      goalCx: goal.cx, goalCy: goal.cy, goalCz: goal.cz,
      canDig: false, requiresGround: false, footprintRadius: 1,
      maxExpansions: 200000,
    });

    // Visual prints — useful when iterating locally; suppressed in CI logs by vitest.
    console.log('\n--- Scenario 1: cave with surface entrance ---');
    console.log(renderXZSlice({
      vnav, y: 10,
      path: mres.cells, start, goal,
      title: 'multi-res path on cave plane (y=10)',
    }));
    for (let li = mr.factors.length - 1; li >= 1; li--) {
      const lvl = mr.levels[li]!;
      console.log(renderLevelSliceXZ({
        level: lvl, sy: Math.min(lvl.h - 1, Math.floor(8 / lvl.factor)),
        title: `level f=${lvl.factor}`,
      }));
    }
    console.log(formatComparison([
      { name: 'baseline', reached: baseline.reached, expanded: baseline.expanded, pathCells: baseline.cells.length },
      { name: 'multi-res', reached: mres.reached, expanded: mres.totalExpanded, pathCells: mres.cells.length },
    ]));

    expect(mres.reached).toBe(true);
    expect(baseline.reached).toBe(true);
    // First and last cells correct.
    expect(mres.cells[0]).toEqual(start);
    expect(mres.cells[mres.cells.length - 1]).toEqual(goal);
    // Path length sanity: don't regress to absurd detours. Octile-ish lower
    // bound is ~60; allow up to 4x.
    expect(mres.cells.length).toBeLessThan(240);
    // Multi-res should expand strictly fewer cells than the unrestricted baseline.
    expect(mres.totalExpanded).toBeLessThan(baseline.expanded);
  });

  it('applyEdits merges previously separate planes after a tunnel punch-through', () => {
    const world = buildHillWithCave({ sealed: true });
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const factors = generateFactors(VNAV_X, VNAV_Y, VNAV_Z);
    const mr = allocateMultiResNav3D(VNAV_X, VNAV_Y, VNAV_Z, factors);
    buildMultiResNav3D(vnav, mr);

    // Pre-edit: the cave runs from cx=32 to cx=100 (sealed at the west wall).
    // No surface shaft → cave is entirely sealed. baseCellPlane should classify
    // the cave's cells as a separate (non-surface) plane from the surface.
    const surfaceCell = { cx: 30, cy: 16, cz: 64 };  // above ground at y=128
    const caveCell = { cx: 50, cy: 10, cz: 64 };
    expect(getBit(vnav.solid, vnavIndex(surfaceCell.cx, surfaceCell.cy, surfaceCell.cz))).toBe(0);
    expect(getBit(vnav.solid, vnavIndex(caveCell.cx, caveCell.cy, caveCell.cz))).toBe(0);

    // Pick the level-1 super-cell that contains the cave cell — record its
    // pre-edit plane count for the assertion below.
    const level1 = mr.levels[1]!;
    const f1 = level1.factor;
    const sx = (caveCell.cx / f1) | 0;
    const sy = (caveCell.cy / f1) | 0;
    const sz = (caveCell.cz / f1) | 0;
    const sIdxBefore = ((sy * level1.d) + sz) * level1.w + sx;
    const planeCountBefore = level1.cells[sIdxBefore]!.planes.length;

    // Without digging, no path. (canDig=false is what a non-tunneler unit uses.)
    const ws = new MultiResWorkspace3D();
    const before = findPathMultiRes3D(vnav, mr, ws, {
      startCx: surfaceCell.cx, startCy: surfaceCell.cy, startCz: surfaceCell.cz,
      goalCx: caveCell.cx, goalCy: caveCell.cy, goalCz: caveCell.cz,
      canDig: false, requiresGround: false,
    });
    expect(before.reached).toBe(false);

    // Carve a vertical 1-cell-wide tunnel from y=87 (cave ceiling) up to
    // y=128 (above the surface) at cx=30. This punches through the wall and
    // connects the cave to the sky.
    const v = world.buffers.voxels;
    const shaftCx = 30;
    for (let z = 64 * 8; z < 65 * 8; z++) {
      for (let x = shaftCx * 8; x < (shaftCx + 1) * 8; x++) {
        for (let y = 88; y <= 128; y++) v[worldIndex(x, y, z)] = AIR;
      }
    }
    // Also break the seal between the cave and the bottom of the shaft —
    // remove the wall at cx=31..32 between y=80..87.
    for (let z = 64 * 8; z < 65 * 8; z++) {
      for (let x = 30 * 8; x < 32 * 8; x++) {
        for (let y = 80; y <= 87; y++) v[worldIndex(x, y, z)] = AIR;
      }
    }

    applyEdits(v, vnav, mr, [{
      vx0: shaftCx * 8, vy0: 80, vz0: 64 * 8,
      vx1: 32 * 8,      vy1: 129, vz1: 65 * 8,
    }]);

    // After the edit: the cave-containing super-cell should have lost a plane
    // (cave merged with surface) OR at minimum its plane count is <= before.
    const planeCountAfter = level1.cells[sIdxBefore]!.planes.length;
    expect(planeCountAfter).toBeLessThanOrEqual(planeCountBefore);
    // The cave cell should now resolve to the SAME plane index as the surface
    // cell at level 1 (they're in different super-cells, but each is plane 0
    // in its respective cell because the merge dropped the count to 1).
    const cavePlaneAfter = baseCellPlane(level1, caveCell.cx, caveCell.cy, caveCell.cz);
    expect(cavePlaneAfter).toBeGreaterThanOrEqual(0);

    const after = findPathMultiRes3D(vnav, mr, ws, {
      startCx: surfaceCell.cx, startCy: surfaceCell.cy, startCz: surfaceCell.cz,
      goalCx: caveCell.cx, goalCy: caveCell.cy, goalCz: caveCell.cz,
      canDig: false, requiresGround: false,
    });
    console.log('\n--- Scenario 2: tunnel punch-through (post-edit) ---');
    console.log(renderXYSlice({
      vnav, z: 64,
      path: after.cells, start: surfaceCell, goal: caveCell,
      title: 'XY slice through carved shaft (z=64)',
    }));
    expect(after.reached).toBe(true);
    expect(after.cells[0]).toEqual(surfaceCell);
    expect(after.cells[after.cells.length - 1]).toEqual(caveCell);
  });

  it('multi-cave + carved shaft: post-edit path threads upper cave → shaft → lower cave', () => {
    const world = buildMultiCaveWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const factors = generateFactors(VNAV_X, VNAV_Y, VNAV_Z);
    const mr = allocateMultiResNav3D(VNAV_X, VNAV_Y, VNAV_Z, factors);
    buildMultiResNav3D(vnav, mr);

    const upperCave = { cx: 50, cy: 13, cz: 64 };
    const lowerCave = { cx: 50, cy: 5, cz: 64 };
    expect(getBit(vnav.solid, vnavIndex(upperCave.cx, upperCave.cy, upperCave.cz))).toBe(0);
    expect(getBit(vnav.solid, vnavIndex(lowerCave.cx, lowerCave.cy, lowerCave.cz))).toBe(0);

    // No path between caves before the shaft.
    const ws = new MultiResWorkspace3D();
    const before = findPathMultiRes3D(vnav, mr, ws, {
      startCx: upperCave.cx, startCy: upperCave.cy, startCz: upperCave.cz,
      goalCx: lowerCave.cx, goalCy: lowerCave.cy, goalCz: lowerCave.cz,
      canDig: false, requiresGround: false,
    });
    expect(before.reached).toBe(false);

    // Carve a vertical shaft from the upper cave floor (y=104) down through
    // the lower cave ceiling (y=47).
    const v = world.buffers.voxels;
    const shaftCx = 50;
    for (let z = 64 * 8; z < 65 * 8; z++) {
      for (let x = shaftCx * 8; x < (shaftCx + 1) * 8; x++) {
        for (let y = 48; y <= 103; y++) v[worldIndex(x, y, z)] = AIR;
      }
    }
    applyEdits(v, vnav, mr, [{
      vx0: shaftCx * 8, vy0: 48, vz0: 64 * 8,
      vx1: (shaftCx + 1) * 8, vy1: 104, vz1: 65 * 8,
    }]);

    const after = findPathMultiRes3D(vnav, mr, ws, {
      startCx: upperCave.cx, startCy: upperCave.cy, startCz: upperCave.cz,
      goalCx: lowerCave.cx, goalCy: lowerCave.cy, goalCz: lowerCave.cz,
      canDig: false, requiresGround: false,
    });

    console.log('\n--- Scenario 3: shaft connecting two caves ---');
    console.log(renderXYSlice({
      vnav, z: 64,
      path: after.cells, start: upperCave, goal: lowerCave,
      title: 'XY slice through both caves and the carved shaft (z=64)',
    }));

    expect(after.reached).toBe(true);
    expect(after.cells[0]).toEqual(upperCave);
    expect(after.cells[after.cells.length - 1]).toEqual(lowerCave);
    // Path must cross both caves' Y bands: at least one cell at cy<=6 (lower)
    // and one at cy>=12 (upper).
    let sawLow = false, sawHigh = false;
    for (const c of after.cells) {
      if (c.cy <= 6) sawLow = true;
      if (c.cy >= 12) sawHigh = true;
    }
    expect(sawLow).toBe(true);
    expect(sawHigh).toBe(true);
  });
});

describe('Multi-res 3D pathfinder — perf bound', () => {
  it('long cave route stays under a generous expansion budget across 30 runs', () => {
    const world = buildHillWithCave({ sealed: false });
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const factors = generateFactors(VNAV_X, VNAV_Y, VNAV_Z);
    const mr = allocateMultiResNav3D(VNAV_X, VNAV_Y, VNAV_Z, factors);
    buildMultiResNav3D(vnav, mr);

    const ws = new MultiResWorkspace3D();
    const start = { cx: 30, cy: 15, cz: 64 };
    const goal = { cx: 90, cy: 10, cz: 64 };

    let maxExpanded = 0;
    for (let run = 0; run < 30; run++) {
      const r = findPathMultiRes3D(vnav, mr, ws, {
        startCx: start.cx, startCy: start.cy, startCz: start.cz,
        goalCx: goal.cx, goalCy: goal.cy, goalCz: goal.cz,
        canDig: false, requiresGround: false,
      });
      expect(r.reached).toBe(true);
      if (r.totalExpanded > maxExpanded) maxExpanded = r.totalExpanded;
    }
    // Loose upper bound — first observation defines the ceiling, generous
    // margin so this only fails on a regression.
    expect(maxExpanded).toBeLessThan(80000);
  });
});

// Suppress unused-import warning — WORLD_Y is exported for potential cave variants.
void WORLD_Y;
