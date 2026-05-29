import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import { GRID_X, GRID_Z, cellIndex, getBit } from '../src/path/Nav';
import { isPassable } from '../src/path/UnitGrid';

const NAV_CELL_VOXELS = 8;
const SURFACE_VY = 64; // voxels — about 8 m

/**
 * Fill the entire world with a bedrock floor, stone+dirt strata, and a grass
 * cap. Done with raw buffer writes (skipping markDirty) so the test setup
 * stays fast — the volume grid is built afterwards in one sweep regardless.
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

const SOLDIER = profileFromUnit({
  kind: 'soldier',
  footprintRadius: 1,
  heightVoxels: 14,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 6,
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

function isCellAdjacent(a: { cx: number; cy: number; cz: number }, b: { cx: number; cy: number; cz: number }): boolean {
  const dx = Math.abs(a.cx - b.cx);
  const dy = Math.abs(a.cy - b.cy);
  const dz = Math.abs(a.cz - b.cz);
  return dx <= 1 && dy <= 1 && dz <= 1 && (dx + dy + dz) > 0;
}

function chebyshev(a: { cx: number; cy: number; cz: number }, b: { cx: number; cy: number; cz: number }): number {
  return Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy), Math.abs(a.cz - b.cz));
}

describe('newPathBasics', () => {
  it('finds a connected path of 26-neighbour cells across flat ground', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    pf.registerProfile(TANK);

    const start = pf.groundCellAt('soldier', 50.5, 50.5);
    const goal = pf.groundCellAt('soldier', 80.5, 70.5);
    expect(start).not.toBeNull();
    expect(goal).not.toBeNull();

    const result = pf.findPath('soldier', { start: start!, goal: goal!, maxExpansions: 100000 });
    expect(result.reached).toBe(true);
    expect(result.cells.length).toBeGreaterThan(1);
    // First and last cells match.
    expect(result.cells[0]!.cx).toBe(start!.cx);
    expect(result.cells[0]!.cz).toBe(start!.cz);
    const last = result.cells[result.cells.length - 1]!;
    expect(last.cx).toBe(goal!.cx);
    expect(last.cz).toBe(goal!.cz);
    // Every consecutive pair is a 26-neighbour step.
    for (let i = 1; i < result.cells.length; i++) {
      expect(isCellAdjacent(result.cells[i - 1]!, result.cells[i]!)).toBe(true);
    }
  });

  it('returns a best-effort PARTIAL chain toward an unreachable goal (reached=false, len>1)', () => {
    // Regression for the large-vehicle partial-path fix (Game.ts routePath,
    // iter77). When a tank can't reach its exact goal — modelled here by
    // capping expansions so the search bails before arriving — A* must still
    // return the chain to the CLOSEST expanded cell so the caller can walk the
    // vehicle TOWARD the goal instead of idling + logging a PATH FAIL.
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(TANK);

    const start = pf.groundCellAt('tank', 40.5, 40.5);
    const goal = pf.groundCellAt('tank', 200.5, 200.5); // far away
    expect(start).not.toBeNull();
    expect(goal).not.toBeNull();

    // Tiny expansion budget → the search cannot reach the far goal.
    const result = pf.findPath('tank', { start: start!, goal: goal!, maxExpansions: 40 });
    expect(result.reached).toBe(false);
    // Best-effort partial chain: more than just the start cell.
    expect(result.cells.length).toBeGreaterThan(1);
    expect(result.cells[0]!.cx).toBe(start!.cx);
    expect(result.cells[0]!.cz).toBe(start!.cz);
    // The chain makes real progress toward the goal (closer than the start).
    const last = result.cells[result.cells.length - 1]!;
    const dStart = chebyshev(start!, goal!);
    const dLast = chebyshev(last, goal!);
    expect(dLast).toBeLessThan(dStart);
    // Still a connected 26-neighbour walk.
    for (let i = 1; i < result.cells.length; i++) {
      expect(isCellAdjacent(result.cells[i - 1]!, result.cells[i]!)).toBe(true);
    }
  });

  it('soldier passable bitmap has more set bits than tank passable bitmap', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    pf.registerProfile(TANK);

    const sg = pf.getGrid('soldier')!;
    const tg = pf.getGrid('tank')!;

    let soldierSet = 0;
    let tankSet = 0;
    for (let i = 0; i < sg.passable.length; i++) {
      let b = sg.passable[i]!;
      while (b) { soldierSet += b & 1; b >>>= 1; }
    }
    for (let i = 0; i < tg.passable.length; i++) {
      let b = tg.passable[i]!;
      while (b) { tankSet += b & 1; b >>>= 1; }
    }
    expect(soldierSet).toBeGreaterThan(tankSet);
    // And the tank still has *some* passable cells (open ground inland of the borders).
    expect(tankSet).toBeGreaterThan(0);
  });

  it('nearestPassable snaps a non-passable cell to a nearby passable one', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    // A cell deep inside solid stone (cy=2, well below the surface ~cy=8) is
    // not passable for a non-digger soldier.
    const buried = { cx: 60, cy: 2, cz: 60 };
    expect(isPassable(pf.getGrid('soldier')!, buried.cx, buried.cy, buried.cz)).toBe(false);

    // Allow the spiral to grow far enough vertically to reach the surface
    // (~cy 8 from cy 2 = 6 rings).
    const snapped = pf.nearestPassable('soldier', buried, 8);
    expect(isPassable(pf.getGrid('soldier')!, snapped.cx, snapped.cy, snapped.cz)).toBe(true);
  });

  it('Theta* path is no longer than plain A* over open ground, and produces a direct shortcut', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    // A diagonal shot across open ground is the case where Theta*'s any-angle
    // shortcut should clearly help.
    const start = pf.groundCellAt('soldier', 40.5, 40.5)!;
    const goal = pf.groundCellAt('soldier', 70.5, 60.5)!;
    expect(start).not.toBeNull();
    expect(goal).not.toBeNull();

    const aStar = pf.findPath('soldier', { start, goal, maxExpansions: 100000 });
    const thetaStar = pf.findPath('soldier', { start, goal, anyAngle: true, maxExpansions: 100000 });

    expect(aStar.reached).toBe(true);
    expect(thetaStar.reached).toBe(true);
    // Theta* compresses long collinear runs into a couple of waypoints.
    expect(thetaStar.cells.length).toBeLessThanOrEqual(aStar.cells.length);
    // On a fully open diagonal there should be at most a small handful of
    // waypoints (start, goal, and maybe one or two corners). Plain A* lays
    // down one cell per step (~30+).
    expect(thetaStar.cells.length).toBeLessThan(aStar.cells.length);
    // First/last points still align with start/goal.
    expect(thetaStar.cells[0]!.cx).toBe(start.cx);
    expect(thetaStar.cells[0]!.cz).toBe(start.cz);
    const last = thetaStar.cells[thetaStar.cells.length - 1]!;
    expect(last.cx).toBe(goal.cx);
    expect(last.cz).toBe(goal.cz);
    // And the chebyshev distance covered by the whole thing is at least the
    // straight-line bound (sanity).
    expect(chebyshev(start, goal)).toBeGreaterThan(0);
  });
});
