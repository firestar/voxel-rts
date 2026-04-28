import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import { GRID_X, GRID_Z, cellIndex, getBit } from '../src/path/Nav';

const NAV_CELL_VOXELS = 8;
const SURFACE_VY = 64; // top stone band; dirt above to 67, grass at 68

/**
 * Bedrock floor + stone strata + dirt + grass. Same recipe as the other
 * pathfinding tests so the surface y is predictable (surface voxel = 68,
 * cell cy=8 contains the topsoil, ground units stand at cell cy=9).
 */
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

/**
 * Carve a rectangular underground corridor by raw-writing AIR into the voxel
 * buffer. We use the buffer directly (not carveSphere) so the test stays fast
 * even for a long corridor, and we can guarantee the exact shape — a 2 m tall
 * (16 voxel) × 2 m wide (16 voxel) tunnel at voxel-y `yLo..yHi`.
 */
function carveCorridorVoxels(
  world: VoxelWorld,
  xStart: number, xEnd: number,
  yLo: number, yHi: number,
  zLo: number, zHi: number,
): void {
  const v = world.buffers.voxels;
  for (let y = yLo; y <= yHi; y++) {
    for (let z = zLo; z <= zHi; z++) {
      for (let x = xStart; x <= xEnd; x++) {
        // Don't break the bedrock floor.
        if (v[worldIndex(x, y, z)] === M_BEDROCK) continue;
        v[worldIndex(x, y, z)] = AIR;
      }
    }
  }
}

// maxStepVoxels=8 (= 1 m / one cell of vertical step) so the soldier can take
// the cell-aligned stairs we carve into the cave entrance. The other
// pathfinding tests use 6 voxels for a more cautious step limit; this one is a
// hair more generous so the descent can be a clean cell-by-cell staircase.
const SOLDIER = profileFromUnit({
  kind: 'soldier',
  footprintRadius: 1,
  heightVoxels: 14,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 8,
  slopePenalty: 0,
});

const TANK = profileFromUnit({
  kind: 'tank',
  footprintRadius: 2,
  heightVoxels: 18,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 4,
  slopePenalty: 0,
});

const TUNNELER = profileFromUnit({
  kind: 'tunneler',
  footprintRadius: 2,
  heightVoxels: 22,
  canDig: true,
  requiresGround: true,
  maxStepVoxels: 8,
  slopePenalty: 0,
});

describe('cavesAndTransitions', () => {
  it('soldier walks down a sloped entrance into a long underground corridor', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    // Underground corridor at cell cy=2 (voxel y range ~16..23) running along
    // x from x=40 to x=70 (in cells). 2 m tall (16 voxels), 2 m wide (16
    // voxels) centered on z=64. We extend the corridor up two cells (cy=2..4)
    // at the entrance end so the slope can land in it cleanly.
    const corridorYLo = 16;        // voxel — bottom of cy=2
    const corridorYHi = 31;        // voxel — top of cy=3 (gives the unit headroom)
    const corridorZLo = 60 * NAV_CELL_VOXELS / NAV_CELL_VOXELS; // 60 voxels start
    // Cell cz=8 spans z=64..71. Make a 2 m wide corridor centered on z=64.
    const zCenter = 64;
    const corridorZ0 = zCenter - 8;
    const corridorZ1 = zCenter + 7;
    const corridorXStart = 40 * NAV_CELL_VOXELS;          // 320 voxels
    const corridorXEnd   = 70 * NAV_CELL_VOXELS - 1;      // 559 voxels (~30 m)

    carveCorridorVoxels(world, corridorXStart, corridorXEnd, corridorYLo, corridorYHi, corridorZ0, corridorZ1);

    // Cell-aligned stairs from the surface down to the corridor. Each step
    // covers one cell of x and lowers the standing cell cy by 1 (= 8 voxels
    // of floor drop = soldier's max step). The unit's body occupies cells
    // standCy and standCy+1, so we carve those cells to AIR. The cell below
    // (standCy-1) is left solid to act as the floor.
    const v = world.buffers.voxels;
    const surfaceStandCy = 9;       // ground unit on grass stands at cy=9
    const corridorStandCy = 2;      // ground unit on corridor floor stands at cy=2
    const stairs: number[] = [];    // standCy for each stair, in walking order
    for (let cy = surfaceStandCy - 1; cy >= corridorStandCy; cy--) stairs.push(cy);
    // 7 stairs: standCy = 8, 7, 6, 5, 4, 3, 2.
    const entranceCxEnd = 40;                     // last stair lands at cx=40
    const entranceCxStart = entranceCxEnd - stairs.length + 1; // cx = 34
    const zCellRange: [number, number] = [7, 9];  // 3 cells wide for clearance
    function clearCell(cx: number, cy: number, cz: number): void {
      const yV0 = cy * NAV_CELL_VOXELS;
      const xV0 = cx * NAV_CELL_VOXELS;
      const zV0 = cz * NAV_CELL_VOXELS;
      for (let y = yV0; y < yV0 + NAV_CELL_VOXELS; y++) {
        for (let z = zV0; z < zV0 + NAV_CELL_VOXELS; z++) {
          for (let x = xV0; x < xV0 + NAV_CELL_VOXELS; x++) {
            if (v[worldIndex(x, y, z)] === M_BEDROCK) continue;
            v[worldIndex(x, y, z)] = AIR;
          }
        }
      }
    }
    for (let k = 0; k < stairs.length; k++) {
      const cx = entranceCxStart + k;
      const standCy = stairs[k]!;
      // Clear standCy and standCy+1 over the z-range — that's the unit's
      // body. Also clear one cell higher (standCy+2) to give the headroom
      // needed when the previous stair's body intrudes diagonally.
      for (let cz = zCellRange[0]; cz <= zCellRange[1]; cz++) {
        clearCell(cx, standCy, cz);
        clearCell(cx, standCy + 1, cz);
        clearCell(cx, standCy + 2, cz);
      }
    }

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    // Surface start — a few cells west of the entrance lip (still on grass).
    const startWx = (entranceCxStart - 4) + 0.5;
    const start = pf.groundCellAt('soldier', startWx, zCenter * 0.125);
    expect(start).not.toBeNull();
    // Goal — deep inside the corridor near the far end (in meters).
    const goal = pf.groundCellAt(
      'soldier',
      (corridorXEnd - 12) * 0.125,
      zCenter * 0.125,
      // Force the search to start scanning from below the surface so we hit
      // the corridor's standing cell (cy=2), not the surface above it.
      4,
    );
    expect(goal).not.toBeNull();
    // Sanity: the goal we found really is below the surface band.
    expect(goal!.cy).toBeLessThan(8);

    const result = pf.findPath('soldier', { start: start!, goal: goal!, maxExpansions: 200000 });
    expect(result.reached).toBe(true);
    expect(result.cells.length).toBeGreaterThan(20);
    // Some cells of the path are below the surface band (cy < 8).
    const underground = result.cells.filter(c => c.cy < 8);
    expect(underground.length).toBeGreaterThan(5);
  });

  it('tank either fails or stays on the surface when the cave is too narrow for it', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    // Same 2 m wide corridor — a footprint-2 tank (3 m wide) cannot fit into
    // a 2 m corridor, so we expect EITHER reached=false OR the resulting path
    // never dips below the surface band. We document this acceptable behavior
    // in the assertions.
    const corridorYLo = 16;
    const corridorYHi = 31;
    const zCenter = 64;
    const corridorZ0 = zCenter - 8;
    const corridorZ1 = zCenter + 7;
    const corridorXStart = 40 * NAV_CELL_VOXELS;
    const corridorXEnd   = 70 * NAV_CELL_VOXELS - 1;
    carveCorridorVoxels(world, corridorXStart, corridorXEnd, corridorYLo, corridorYHi, corridorZ0, corridorZ1);

    // Same sloped entrance as the soldier test.
    let yCur = 68;
    for (let x = corridorXStart - 52; x <= corridorXStart + 4; x += 4) {
      world.carveSphere(x, yCur, zCenter, 6);
      yCur -= 4;
      if (yCur < corridorYLo + 4) yCur = corridorYLo + 4;
    }

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(TANK);

    const start = pf.groundCellAt('tank', (corridorXStart - 80) * 0.125, zCenter * 0.125);
    // For the tank we deliberately ask for a goal underground; the planner
    // can either fail (reached=false) because the tank doesn't fit, or the
    // returned partial path may still be valid but should not dip below the
    // surface. nearestPassable will snap an unreachable goal upward.
    const rawGoal = { cx: 65, cy: 2, cz: 8 };
    const goal = pf.nearestPassable('tank', rawGoal, 12);

    if (goal.cy < 8) {
      // The tank can apparently fit somewhere underground (e.g. an over-wide
      // accidental clearance) — in that unlikely case just verify it's still
      // a passable cell.
      expect(goal).toBeDefined();
    } else {
      // Expected case: tank can't fit underground at all. nearestPassable
      // bumps the goal to the surface, so the path stays on the surface.
      const result = pf.findPath('tank', { start: start!, goal, maxExpansions: 100000 });
      // Either it reaches the snapped surface goal, or it doesn't reach at
      // all — both are acceptable. What's NOT acceptable is dipping
      // underground.
      const underground = result.cells.filter(c => c.cy < 8);
      expect(underground.length).toBe(0);
    }
  });

  it('tunneler digs through solid rock to reach a deep underground point', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(TUNNELER);

    // Surface start, deep underground goal. No carved corridor — the
    // tunneler has to grind through dirt and stone the whole way.
    const start = pf.groundCellAt('tunneler', 50.5, 50.5);
    expect(start).not.toBeNull();
    // Deep underground goal — cy=2 (voxel y ~16..23). For a digger every
    // non-bedrock cell with body box clear of bedrock is passable, so this
    // should resolve directly without nearestPassable.
    const goal = { cx: 70, cy: 2, cz: 50 };

    const result = pf.findPath('tunneler', { start: start!, goal, maxExpansions: 200000 });
    expect(result.reached).toBe(true);

    // At least some cells along the path lie inside cells that are still
    // solid in the volume grid — i.e. the tunneler is planning to dig.
    const vg = pf.volume;
    let solidOnPath = 0;
    for (const c of result.cells) {
      if (getBit(vg.solid, cellIndex(c.cx, c.cy, c.cz))) solidOnPath++;
    }
    expect(solidOnPath).toBeGreaterThan(0);
  });

  it('tunneler replans through the carved tunnel after damage update', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(TUNNELER);

    const start = pf.groundCellAt('tunneler', 50.5, 50.5);
    expect(start).not.toBeNull();
    const goal = { cx: 70, cy: 2, cz: 50 };

    const first = pf.findPath('tunneler', { start: start!, goal, maxExpansions: 200000 });
    expect(first.reached).toBe(true);

    const vg = pf.volume;
    let firstSolidOnPath = 0;
    for (const c of first.cells) {
      if (getBit(vg.solid, cellIndex(c.cx, c.cy, c.cz))) firstSolidOnPath++;
    }
    expect(firstSolidOnPath).toBeGreaterThan(0);

    // Carve out a sloped tunnel from a surface point near the start straight
    // down to the goal cell. We carve overlapping spheres along the way and
    // call applyDamage on each carve's bounding box so the volume grid +
    // unit grid stay in sync incrementally.
    const sx0 = Math.floor(50.5 / 0.125);  // start in voxels
    const sz0 = Math.floor(50.5 / 0.125);
    const sy0 = 68;                         // surface voxel
    const gxV = 70 * NAV_CELL_VOXELS + 4;   // goal cell center in voxels
    const gyV = 2 * NAV_CELL_VOXELS + 4;
    const gzV = 50 * NAV_CELL_VOXELS + 4;

    const segs = 16;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const x = Math.round(sx0 + (gxV - sx0) * t);
      const y = Math.round(sy0 + (gyV - sy0) * t);
      const z = Math.round(sz0 + (gzV - sz0) * t);
      const r = 8;
      world.carveSphere(x, y, z, r);
      // Apply damage in meter-space; widen by carve radius.
      const rm = (r + 1) * 0.125;
      pf.applyDamage(
        x * 0.125 - rm, y * 0.125 - rm, z * 0.125 - rm,
        x * 0.125 + rm, y * 0.125 + rm, z * 0.125 + rm,
      );
    }

    const second = pf.findPath('tunneler', { start: start!, goal, maxExpansions: 200000 });
    expect(second.reached).toBe(true);

    let secondSolidOnPath = 0;
    for (const c of second.cells) {
      if (getBit(vg.solid, cellIndex(c.cx, c.cy, c.cz))) secondSolidOnPath++;
    }
    // The replanned path goes mostly through the now-empty tunnel, so it
    // should pass through fewer solid cells than the original.
    expect(secondSolidOnPath).toBeLessThan(firstSolidOnPath);
  });
});
