import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld } from '../src/voxel/VoxelWorld';
import { isPassable } from '../src/path/UnitGrid';
import { getBit, cellIndex } from '../src/path/Nav';
import { buildSandboxWorld, SandboxPoint } from '../src/voxel/SandboxWorld';
import type { PathNode } from '../src/path/AStar';

// Unit profiles mirror cavesAndTransitions.spec.ts so behaviour is comparable.
const SOLDIER = profileFromUnit({
  kind: 'soldier', footprintRadius: 1, heightVoxels: 14,
  canDig: false, requiresGround: true, maxStepVoxels: 8, slopePenalty: 0,
});
const TANK = profileFromUnit({
  kind: 'tank', footprintRadius: 2, heightVoxels: 18,
  canDig: false, requiresGround: true, maxStepVoxels: 4, slopePenalty: 0,
});
const TUNNELER = profileFromUnit({
  kind: 'tunneler', footprintRadius: 2, heightVoxels: 22,
  canDig: true, requiresGround: true, maxStepVoxels: 8, slopePenalty: 0,
});

const SURFACE_BAND_CY = 8; // cells with cy < 8 are underground

function cell(p: SandboxPoint): PathNode {
  return { cx: p.cx, cy: p.cy, cz: p.cz };
}

/** Every cell of a non-digger path must be a legally occupiable cell. */
function assertPathPassable(pf: Pathfinder, kind: string, cells: PathNode[]): void {
  const grid = pf.getGrid(kind)!;
  for (const c of cells) {
    expect(isPassable(grid, c.cx, c.cy, c.cz)).toBe(true);
  }
}

/** Adjacent waypoints must be 26-connected (single grid step apart). */
function assertContiguous(cells: PathNode[]): void {
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]!, b = cells[i]!;
    const dx = Math.abs(a.cx - b.cx), dy = Math.abs(a.cy - b.cy), dz = Math.abs(a.cz - b.cz);
    expect(Math.max(dx, dy, dz)).toBeLessThanOrEqual(1);
  }
}

describe('sandboxPathfinding', () => {
  describe('surface routing around obstacles', () => {
    it('soldier weaves from start to goal past mesa, gate and boulders', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { cave: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(SOLDIER);

      const start = pf.nearestPassable('soldier', cell(lm.surfaceStart));
      const goal = pf.nearestPassable('soldier', cell(lm.surfaceGoal));
      const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });

      expect(res.reached).toBe(true);
      assertPathPassable(pf, 'soldier', res.cells);
      assertContiguous(res.cells);
      // It can't be a straight line — the lane is blocked, so the route is at
      // least as long as the x-gap and stays on the surface.
      expect(res.cells.length).toBeGreaterThanOrEqual(80);
      expect(res.cells.every(c => c.cy >= SURFACE_BAND_CY)).toBe(true);
    });

    it('tank (3 m) still finds a surface route through the gaps', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { cave: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(TANK);

      const start = pf.nearestPassable('tank', cell(lm.surfaceStart));
      const goal = pf.nearestPassable('tank', cell(lm.surfaceGoal));
      const res = pf.findPath('tank', { start, goal, maxExpansions: 200000 });

      expect(res.reached).toBe(true);
      assertPathPassable(pf, 'tank', res.cells);
    });
  });

  describe('surface to cave transition', () => {
    it('soldier descends the staircase into the chamber', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { obstacles: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(SOLDIER);

      const start = pf.nearestPassable('soldier', cell(lm.caveMouth));
      const goal = pf.nearestPassable('soldier', cell(lm.chamberCenter));
      expect(goal.cy).toBeLessThan(SURFACE_BAND_CY); // goal really is underground

      const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });
      expect(res.reached).toBe(true);
      assertPathPassable(pf, 'soldier', res.cells);
      assertContiguous(res.cells);
      const underground = res.cells.filter(c => c.cy < SURFACE_BAND_CY);
      expect(underground.length).toBeGreaterThan(5);
    });

    it('tank cannot squeeze into the 2 m corridor', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { obstacles: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(TANK);

      const start = pf.nearestPassable('tank', cell(lm.caveMouth));
      const goal = pf.nearestPassable('tank', cell(lm.chamberCenter));
      const res = pf.findPath('tank', { start, goal, maxExpansions: 200000 });

      // The deep chamber is itself wide enough for a tank, so the goal cell is
      // passable — but the only way in is the 2 m corridor, which a 3 m tank
      // can't traverse. So it must NOT reach the goal, and must never descend
      // to corridor/chamber depth (cy <= 4). Nosing one cell onto the wide
      // entrance landing (cy 5..7) is fine and expected.
      expect(res.reached).toBe(false);
      const deep = res.cells.filter(c => c.cy <= 4);
      expect(deep.length).toBe(0);
    });
  });

  describe('cave traversal', () => {
    it('soldier walks the corridor to the side-branch end', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { obstacles: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(SOLDIER);

      const start = pf.nearestPassable('soldier', cell(lm.corridorStart));
      const goal = pf.nearestPassable('soldier', cell(lm.branchEnd));
      const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });

      expect(res.reached).toBe(true);
      assertPathPassable(pf, 'soldier', res.cells);
      assertContiguous(res.cells);
      // The whole route stays underground.
      expect(res.cells.every(c => c.cy < SURFACE_BAND_CY)).toBe(true);
    });
  });

  describe('digging', () => {
    it('tunneler carves through solid rock to a buried target', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { obstacles: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(TUNNELER);

      const start = pf.nearestPassable('tunneler', cell(lm.corridorStart));
      const goal = cell(lm.tunnelerTarget); // buried in stone; passable for diggers
      const res = pf.findPath('tunneler', { start, goal, maxExpansions: 200000 });

      expect(res.reached).toBe(true);
      const vg = pf.volume;
      const solidOnPath = res.cells.filter(c => getBit(vg.solid, cellIndex(c.cx, c.cy, c.cz)) === 1).length;
      expect(solidOnPath).toBeGreaterThan(0); // it is actually digging
    });
  });

  describe('cave-mouth Y resolution (characterization)', () => {
    // Characterizes a footgun behind cave-mouth stalls: an UNCONSTRAINED
    // groundCellAt returns the intact grass surface even when there's standable
    // cave air below it, so anything snapping a descending unit to "highest
    // standable cell" yanks it back to the surface. A ceiling-capped scan tied
    // to the unit's target standing level finds the cave floor instead. This
    // documents the mechanism any surface→cave Y fix must respect; it is NOT
    // asserting a sim-side fix is wired up yet.
    const NAV_CELL_METERS = 1.0;

    it('a ceiling-capped column scan finds the corridor floor, not the surface above it', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { obstacles: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(SOLDIER);

      // Mid-corridor XZ — underground air at cy2..3, but grass surface intact above.
      const wx = lm.chamberCenter.x - 10; // ~cx66, still inside the main corridor span
      const wz = lm.corridorStart.z;      // cz64

      // Naive (unconstrained) snap grabs the surface cell — this is the bug.
      const naive = pf.groundCellAt('soldier', wx, wz);
      expect(naive).not.toBeNull();
      expect(naive!.cy).toBeGreaterThanOrEqual(SURFACE_BAND_CY);

      // Ceiling-capped snap (preferCy = corridor stand level 2) finds the
      // corridor floor underground — this is the fix.
      const capped = pf.groundCellAt('soldier', wx, wz, (2 + 1.5) * NAV_CELL_METERS);
      expect(capped).not.toBeNull();
      expect(capped!.cy).toBeLessThan(SURFACE_BAND_CY);
    });
  });

  describe('perf breakdown', () => {
    it('reports where nav setup time goes', () => {
      const t0 = performance.now();
      const world = VoxelWorld.create(false);
      const tCreate = performance.now();
      const lm = buildSandboxWorld(world, {});
      const tTerrain = performance.now();
      const pf = new Pathfinder(false);
      pf.attach(world); // builds the full-world VolumeGrid (no unit grids yet)
      const tVolume = performance.now();
      pf.registerProfile(SOLDIER); // derives one per-unit UnitGrid
      const tUnit = performance.now();
      const start = pf.nearestPassable('soldier', cell(lm.surfaceStart));
      const goal = pf.nearestPassable('soldier', cell(lm.surfaceGoal));
      const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });
      const tSearch = performance.now();
      // eslint-disable-next-line no-console
      console.log('[navperf] ' + JSON.stringify({
        createMs: +(tCreate - t0).toFixed(1),
        terrainMs: +(tTerrain - tCreate).toFixed(1),
        volumeGridMs: +(tVolume - tTerrain).toFixed(1),
        unitGridMs: +(tUnit - tVolume).toFixed(1),
        searchMs: +(tSearch - tUnit).toFixed(1),
        expanded: res.expanded,
      }));
      expect(res.reached).toBe(true);
    });
  });

  describe('perf guard', () => {
    it('a long surface path stays within a sane expansion budget', () => {
      const world = VoxelWorld.create(false);
      const lm = buildSandboxWorld(world, { cave: false });
      const pf = new Pathfinder(false);
      pf.attach(world);
      pf.registerProfile(SOLDIER);

      const start = pf.nearestPassable('soldier', cell(lm.surfaceStart));
      const goal = pf.nearestPassable('soldier', cell(lm.surfaceGoal));
      const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });

      expect(res.reached).toBe(true);
      // Regression tripwire: an ~80 m surface hop should not explode the open
      // set. Generous bound — tighten once a real budget is established.
      expect(res.expanded).toBeLessThan(150000);
    });
  });
});
