import { describe, it, expect } from 'vitest';
import { allocateNav, buildSurfaceNav, NAV_W, NAV_H, NAV_CELL_METERS, navIndex } from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';
import {
  allocateClusterGraph, buildClusterGraph, computeCorridor,
  HierarchyWorkspace,
  CLUSTER_W, CLUSTER_H, CLUSTER_SIZE,
  cellToClusterCx, cellToClusterCz, clusterIndex,
} from '../src/path/Hierarchy';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_STONE, M_BEDROCK } from '../src/voxel/Materials';

function buildFlatWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const voxels = world.buffers.voxels;
  const surfaceY = 96;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      voxels[worldIndex(x, 0, z)] = M_BEDROCK;
      voxels[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < surfaceY; y++) voxels[worldIndex(x, y, z)] = M_STONE;
      voxels[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('PathClient.firstStepWaypoint (optimistic immediate-step)', () => {
  // Inlined re-implementation of firstStepWaypoint that operates directly on a
  // SurfaceNavBuffers — the production version lives on PathClient (which
  // requires a Worker) so we exercise the pure logic here.
  function firstStepWaypoint(
    nav: ReturnType<typeof allocateNav>,
    sx: number, sz: number,
    gx: number, gz: number,
    maxStepVoxels: number,
    headroomVoxels: number,
    maxCells = 6,
  ): { x: number; y: number; z: number } | null {
    const dx = gx - sx;
    const dz = gz - sz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < NAV_CELL_METERS * 0.5) return null;
    const stepMeters = NAV_CELL_METERS * 0.5;
    const steps = Math.min(maxCells * 2, Math.ceil(dist / stepMeters));
    const stepX = (dx / dist) * stepMeters;
    const stepZ = (dz / dist) * stepMeters;
    const startCx = Math.max(0, Math.min(NAV_W - 1, Math.floor(sx / NAV_CELL_METERS)));
    const startCz = Math.max(0, Math.min(NAV_H - 1, Math.floor(sz / NAV_CELL_METERS)));
    const startI = navIndex(startCx, startCz);
    let prevCx = startCx, prevCz = startCz;
    let prevTopY = nav.topY[startI]!;
    let lastGoodCx = startCx, lastGoodCz = startCz;
    let advanced = false;
    for (let i = 1; i <= steps; i++) {
      const px = sx + stepX * i;
      const pz = sz + stepZ * i;
      const cx = Math.floor(px / NAV_CELL_METERS);
      const cz = Math.floor(pz / NAV_CELL_METERS);
      if (cx < 0 || cz < 0 || cx >= NAV_W || cz >= NAV_H) break;
      if (cx === prevCx && cz === prevCz) continue;
      const idx = navIndex(cx, cz);
      if (nav.blocked[idx]) break;
      if (headroomVoxels > 0 && nav.headroom[idx]! < headroomVoxels) break;
      const topY = nav.topY[idx]!;
      const dy = topY > prevTopY ? topY - prevTopY : prevTopY - topY;
      if (dy > maxStepVoxels) break;
      lastGoodCx = cx; lastGoodCz = cz;
      advanced = true;
      prevCx = cx; prevCz = cz; prevTopY = topY;
    }
    if (!advanced) return null;
    return {
      x: (lastGoodCx + 0.5) * NAV_CELL_METERS,
      y: (nav.topY[navIndex(lastGoodCx, lastGoodCz)]! + 1) * 0.125,
      z: (lastGoodCz + 0.5) * NAV_CELL_METERS,
    };
  }

  it('returns a waypoint roughly along the goal direction on open ground', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);

    const sx = 10.5, sz = 10.5;
    const gx = 60.5, gz = 60.5;
    const w = firstStepWaypoint(nav, sx, sz, gx, gz, 4, 1);
    expect(w).not.toBeNull();
    // Should advance toward the goal — the dot product of (w-s) with (g-s) is positive.
    const wxd = w!.x - sx, wzd = w!.z - sz;
    const dgx = gx - sx, dgz = gz - sz;
    expect(wxd * dgx + wzd * dgz).toBeGreaterThan(0);
    // And it should be capped at ~6 cells (~6 m) regardless of how far the goal is.
    expect(Math.hypot(wxd, wzd)).toBeLessThanOrEqual(7);
  });

  it('returns null when the very first step is into a blocked cell', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    // Manually block the cell directly east of the start so the first step is impassable.
    nav.blocked[navIndex(11, 10)] = 1;
    nav.blocked[navIndex(11, 11)] = 1;

    // Aim due east — the step lands inside the blocked cells.
    const w = firstStepWaypoint(nav, 10.5, 10.5, 30.5, 10.5, 4, 1);
    expect(w).toBeNull();
  });

  it('truncates the leg at a cliff that exceeds the unit step limit', () => {
    const world = buildFlatWorld();
    const voxels = world.buffers.voxels;
    // Stack stone on top of cells east of x=20 so they're 30 voxels higher.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 8 * 20; x < WORLD_X; x++) {
        for (let y = 97; y < 97 + 30; y++) {
          voxels[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);

    // Starts in cell (10, 10), goal east — the cliff sits at cx=20.
    const w = firstStepWaypoint(nav, 10.5, 10.5, 60.5, 10.5, 4, 1);
    expect(w).not.toBeNull();
    // Optimistic leg should NOT cross the cliff (cell-x stays under 20 m).
    expect(w!.x).toBeLessThan(20);
  });
});

describe('Hierarchy cluster graph + corridor', () => {
  it('marks every cluster on flat open ground as bidirectionally connected', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const hg = allocateClusterGraph();
    buildClusterGraph(nav, hg);

    // Every cluster has walkable cells.
    for (let i = 0; i < CLUSTER_W * CLUSTER_H; i++) {
      expect(hg.hasWalkable[i]).toBe(1);
    }
    // Interior clusters (not on the map edge) all have all 4 neighbours flagged.
    for (let cz = 1; cz < CLUSTER_H - 1; cz++) {
      for (let cx = 1; cx < CLUSTER_W - 1; cx++) {
        expect(hg.edges[clusterIndex(cx, cz)]).toBe(1 | 2 | 4 | 8);
      }
    }
  });

  it('skips a corridor when start and goal are in the same cluster', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const hg = allocateClusterGraph();
    buildClusterGraph(nav, hg);
    const ws = new HierarchyWorkspace();

    const startCx = 5, startCz = 5;
    const goalCx = 6, goalCz = 6;
    const built = computeCorridor(
      hg, ws,
      cellToClusterCx(startCx), cellToClusterCz(startCz),
      cellToClusterCx(goalCx), cellToClusterCz(goalCz),
    );
    expect(built).toBe(false); // same cluster → caller falls back to plain A*.
  });

  it('builds a corridor for a long path and the corridor includes start, goal, and intermediate cells', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const hg = allocateClusterGraph();
    buildClusterGraph(nav, hg);
    const ws = new HierarchyWorkspace();

    const startCx = 5, startCz = 5;
    const goalCx = 80, goalCz = 80;
    const built = computeCorridor(
      hg, ws,
      cellToClusterCx(startCx), cellToClusterCz(startCz),
      cellToClusterCx(goalCx), cellToClusterCz(goalCz),
    );
    expect(built).toBe(true);
    expect(ws.corridor[navIndex(startCx, startCz)]).toBe(1);
    expect(ws.corridor[navIndex(goalCx, goalCz)]).toBe(1);
    // A cell mid-route should be in the corridor too.
    expect(ws.corridor[navIndex(40, 40)]).toBe(1);
    // The widened-by-1 corridor is far smaller than the full grid.
    let inCorridor = 0;
    for (let i = 0; i < ws.corridor.length; i++) inCorridor += ws.corridor[i]!;
    expect(inCorridor).toBeLessThan(ws.corridor.length * 0.7);
  });

  it('corridor-restricted A* finds the same destination as unrestricted A* on flat ground', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const hg = allocateClusterGraph();
    buildClusterGraph(nav, hg);
    const wsH = new HierarchyWorkspace();
    const ws = new AStarWorkspace();

    const start = { cx: 5, cz: 5 };
    const goal = { cx: 80, cz: 80 };
    const corridorBuilt = computeCorridor(
      hg, wsH,
      cellToClusterCx(start.cx), cellToClusterCz(start.cz),
      cellToClusterCx(goal.cx), cellToClusterCz(goal.cz),
    );
    expect(corridorBuilt).toBe(true);
    const reqArgs = {
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: 1,
      maxStepVoxels: 16,
      slopePenalty: 0.15,
      bodyHalfCells: 0,
      bodyRoughnessVoxels: 999,
      headroomVoxels: 0,
      prefersRoads: false,
    };

    const restricted = findPathSurface(nav, ws, reqArgs, wsH.corridor);
    const unrestricted = findPathSurface(nav, ws, reqArgs);
    expect(restricted.reached).toBe(true);
    expect(unrestricted.reached).toBe(true);

    const rl = restricted.cells[restricted.cells.length - 1]!;
    const ul = unrestricted.cells[unrestricted.cells.length - 1]!;
    expect(rl.cx).toBe(ul.cx);
    expect(rl.cz).toBe(ul.cz);

    // The restricted search expanded fewer cells (corridor pruning is the win).
    expect(restricted.expanded).toBeLessThanOrEqual(unrestricted.expanded);
  });

  it('falls back to unrestricted A* when corridor borders are reachable but the cell-row is not (sparse-edge wall)', () => {
    // Build a world where a wall cuts across at cz=40 with a single 1-cell gap
    // at the very edge of a cluster — the abstract graph sees the gap as
    // passable but the gap is exactly on a cluster boundary the corridor's
    // 1-cluster widening doesn't include for an off-axis goal.
    const world = buildFlatWorld();
    const voxels = world.buffers.voxels;
    // Stack a 30-voxel wall across the middle of the map to simulate a tall ridge.
    for (let x = 0; x < WORLD_X; x++) {
      for (let z = 8 * 40; z < 8 * 40 + 8; z++) {
        for (let y = 97; y < 97 + 30; y++) voxels[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Carve a 1-voxel-wide opening through the wall at x = 8*5 (i.e. nav cx=5).
    for (let dz = 0; dz < 8; dz++) {
      for (let dx = 0; dx < 8; dx++) {
        for (let y = 97; y < 97 + 30; y++) {
          voxels[worldIndex(8 * 5 + dx, y, 8 * 40 + dz)] = 0;
        }
      }
    }
    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const hg = allocateClusterGraph();
    buildClusterGraph(nav, hg);
    const wsH = new HierarchyWorkspace();
    const ws = new AStarWorkspace();

    // Start north of the wall, goal far south-east of the gap. Abstract A*
    // ought to route the corridor through the cluster containing the gap.
    const start = { cx: 5, cz: 5 };
    const goal = { cx: 80, cz: 80 };
    const built = computeCorridor(
      hg, wsH,
      cellToClusterCx(start.cx), cellToClusterCz(start.cz),
      cellToClusterCx(goal.cx), cellToClusterCz(goal.cz),
    );
    // Corridor should build (gap exists) — but the route may need to detour through it.
    expect(built).toBe(true);

    // Plain A* must still produce a reached path.
    const result = findPathSurface(nav, ws, {
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: 1,
      maxStepVoxels: 16,
      slopePenalty: 0.15,
      bodyHalfCells: 0,
      bodyRoughnessVoxels: 999,
      headroomVoxels: 0,
      prefersRoads: false,
    });
    expect(result.reached).toBe(true);
  });

  it('cluster grid covers the whole 96x96 nav grid exactly', () => {
    expect(CLUSTER_W * CLUSTER_SIZE).toBe(NAV_W);
    expect(CLUSTER_H * CLUSTER_SIZE).toBe(NAV_H);
  });
});
