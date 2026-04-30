/**
 * Cross-algorithm pathfinding benchmark on a large cave map.
 *
 * Builds the full 1024×192×1024 world with a layered surface, an underground
 * cave network (long corridor + side chambers + sloped entrance), and a
 * surface wall with a single off-centre gap. Then runs the four algorithms in
 * the codebase against the same set of queries and records timing, expansions,
 * cells visited, and path cost so we can compare them apples-to-apples.
 *
 * Algorithms covered:
 *   - A* (weighted, w=1.4 default)
 *   - A* admissible (w=1.0)
 *   - Theta* (any-angle, soldier-style single-cell footprint)
 *   - HPA* (cluster graph + abstract A* + per-segment refinement)
 *   - FlowField (Dijkstra rooted at the goal, walked via nextStep)
 */
import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import {
  GRID_X, GRID_Y, GRID_Z, NAV_CELL_VOXELS, cellIndex,
} from '../src/path/Nav';
import { buildFlowField, nextStep, FLOW_GOAL } from '../src/path/FlowField';
import { PathNode } from '../src/path/AStar';

const SURFACE_VY = 64;            // top of stone band
const SURFACE_TOP = SURFACE_VY + 4; // grass voxel y

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

function clearCell(world: VoxelWorld, cx: number, cy: number, cz: number): void {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return;
  const v = world.buffers.voxels;
  const xV0 = cx * NAV_CELL_VOXELS;
  const yV0 = cy * NAV_CELL_VOXELS;
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

/**
 * Build the cave network: a long corridor at cy=2..3 spanning most of the
 * map's x axis, branching chambers off it, a sloped staircase from the
 * surface down into the corridor, and a tall surface wall with a single gap.
 */
function buildCaveWorld(world: VoxelWorld): void {
  buildLayeredWorld(world);

  // Main corridor (cy=2..3 = standing+head for the soldier; floor cy=1 stays
  // solid stone). Runs from cx=10 to cx=120 along cz=63..65 (3 cells wide).
  for (let cx = 10; cx <= 120; cx++) {
    for (let cz = 63; cz <= 65; cz++) {
      clearCell(world, cx, 2, cz);
      clearCell(world, cx, 3, cz);
    }
  }

  // Side chambers at every 20 cells along the corridor.
  for (let baseX = 20; baseX <= 110; baseX += 20) {
    for (let dz = -8; dz <= 8; dz++) {
      const cz = 64 + dz;
      for (let dx = -1; dx <= 1; dx++) {
        clearCell(world, baseX + dx, 2, cz);
        clearCell(world, baseX + dx, 3, cz);
      }
    }
  }

  // Sloped entrance: cell-aligned stairs from cy=8 down to cy=2 at the west end.
  // Each stair drops 1 cell of standing-y; the soldier's max step is 8 voxels
  // = 1 cell, so this is the steepest descent it can take.
  const stairStandCys = [8, 7, 6, 5, 4, 3, 2];
  const stairXStart = 4;
  for (let k = 0; k < stairStandCys.length; k++) {
    const cx = stairXStart + k;
    const standCy = stairStandCys[k]!;
    for (let cz = 63; cz <= 65; cz++) {
      clearCell(world, cx, standCy, cz);
      clearCell(world, cx, standCy + 1, cz);
      clearCell(world, cx, standCy + 2, cz);
    }
  }
  // Connect the foot of the stairs to the corridor body.
  for (let cx = stairXStart + stairStandCys.length; cx <= 12; cx++) {
    for (let cz = 63; cz <= 65; cz++) {
      clearCell(world, cx, 2, cz);
      clearCell(world, cx, 3, cz);
    }
  }

  // Surface wall along cz=32, gap at cx=72 (off-centre so straight line is
  // not the optimal route).
  const v = world.buffers.voxels;
  const wallTop = SURFACE_TOP + 24;
  for (let cx = 0; cx < GRID_X; cx++) {
    if (Math.abs(cx - 72) <= 1) continue;
    const xV0 = cx * NAV_CELL_VOXELS;
    for (let z = 32 * NAV_CELL_VOXELS; z < 33 * NAV_CELL_VOXELS; z++) {
      for (let dx = 0; dx < NAV_CELL_VOXELS; dx++) {
        for (let y = SURFACE_TOP + 1; y <= wallTop; y++) {
          v[worldIndex(xV0 + dx, y, z)] = M_STONE;
        }
      }
    }
  }
}

const SOLDIER = profileFromUnit({
  kind: 'soldier',
  footprintRadius: 1,
  heightVoxels: 14,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 8,
  slopePenalty: 0,
});

interface QueryResult {
  algo: string;
  query: string;
  reached: boolean;
  cells: number;
  expanded: number;
  ms: number;
  cost: number;
}

/** True path cost in 26-connected octile metric, accepting Theta*'s non-adjacent waypoints. */
function pathCost(cells: PathNode[]): number {
  let total = 0;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]!;
    const b = cells[i]!;
    const dx = Math.abs(a.cx - b.cx);
    const dy = Math.abs(a.cy - b.cy);
    const dz = Math.abs(a.cz - b.cz);
    if (dx <= 1 && dy <= 1 && dz <= 1) {
      const dim = (dx ? 1 : 0) + (dy ? 1 : 0) + (dz ? 1 : 0);
      total += dim === 1 ? 1 : dim === 2 ? Math.SQRT2 : Math.sqrt(3);
    } else {
      // Theta* shortcut — straight-line Euclidean distance.
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return total;
}

/**
 * Run `fn` once to warm caches, then `samples` times measuring with
 * performance.now(). Returns the best (fastest) sample so JIT noise gets
 * filtered out.
 */
function bench<T extends { cells: PathNode[]; reached: boolean; expanded: number }>(
  samples: number,
  fn: () => T,
): { ms: number; result: T } {
  fn(); // warm
  let bestMs = Infinity;
  let last: T | null = null;
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    last = fn();
    const ms = performance.now() - t0;
    if (ms < bestMs) bestMs = ms;
  }
  return { ms: bestMs, result: last! };
}

describe('pathfinding benchmark on large cave map', () => {
  it('runs A*, Theta*, HPA*, and FlowField across a query battery and reports metrics', () => {
    const world = VoxelWorld.create(false);
    buildCaveWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    // ---- Pre-build the HPA cluster graph and time it separately. ----
    const t0 = performance.now();
    pf.buildClusterGraph('soldier');
    const clusterBuildMs = performance.now() - t0;

    // ---- Query battery. ----
    const queries: { name: string; start: PathNode; goal: PathNode }[] = [];
    {
      // Long surface diagonal corner-to-corner.
      const start = pf.groundCellAt('soldier', 5.5, 5.5)!;
      const goal = pf.groundCellAt('soldier', 122.5, 122.5)!;
      queries.push({ name: 'longDiag', start, goal });
    }
    {
      // Surface route forced through the wall gap (off-centre).
      const start = pf.groundCellAt('soldier', 20.5, 20.5)!;
      const goal = pf.groundCellAt('soldier', 110.5, 60.5)!;
      queries.push({ name: 'wallGap', start, goal });
    }
    {
      // Surface entrance at the west end → far end of the underground corridor.
      const start = pf.groundCellAt('soldier', 5.5, 64.5)!;
      const rawGoal = { cx: 119, cy: 2, cz: 64 };
      const goal = pf.nearestPassable('soldier', rawGoal, 6);
      queries.push({ name: 'caveTraverse', start, goal });
    }
    {
      // Mid-corridor → surface (cave climb back out).
      const rawStart = { cx: 60, cy: 2, cz: 64 };
      const start = pf.nearestPassable('soldier', rawStart, 6);
      const goal = pf.groundCellAt('soldier', 5.5, 5.5)!;
      queries.push({ name: 'caveExit', start, goal });
    }
    {
      // Short hop — both endpoints near each other, exercises in-cluster fall-through.
      const start = pf.groundCellAt('soldier', 50.5, 50.5)!;
      const goal = pf.groundCellAt('soldier', 58.5, 56.5)!;
      queries.push({ name: 'shortHop', start, goal });
    }

    const results: QueryResult[] = [];
    const samples = 3;

    for (const q of queries) {
      // A* (default weighted, w=1.4)
      {
        const { ms, result } = bench(samples, () =>
          pf.findPath('soldier', { start: q.start, goal: q.goal, maxExpansions: 200000 }),
        );
        results.push({
          algo: 'A* (w=1.4)', query: q.name,
          reached: result.reached, cells: result.cells.length,
          expanded: result.expanded, ms, cost: pathCost(result.cells),
        });
      }
      // A* admissible (w=1.0)
      {
        const { ms, result } = bench(samples, () =>
          pf.findPath('soldier', { start: q.start, goal: q.goal, heuristicWeight: 1.0, maxExpansions: 200000 }),
        );
        results.push({
          algo: 'A* (w=1.0)', query: q.name,
          reached: result.reached, cells: result.cells.length,
          expanded: result.expanded, ms, cost: pathCost(result.cells),
        });
      }
      // Theta*
      {
        const { ms, result } = bench(samples, () =>
          pf.findPath('soldier', { start: q.start, goal: q.goal, anyAngle: true, maxExpansions: 200000 }),
        );
        results.push({
          algo: 'Theta*', query: q.name,
          reached: result.reached, cells: result.cells.length,
          expanded: result.expanded, ms, cost: pathCost(result.cells),
        });
      }
      // HPA* with the default per-segment cap (8192).
      {
        const { ms, result } = bench(samples, () =>
          pf.findPathHPA('soldier', { start: q.start, goal: q.goal }),
        );
        results.push({
          algo: 'HPA*', query: q.name,
          reached: result.reached, cells: result.cells.length,
          expanded: result.expanded, ms, cost: pathCost(result.cells),
        });
      }
      // HPA* with a generous per-segment refinement cap. Surfaces whether the
      // 8192 default is the constraint or if the cluster graph is genuinely
      // missing the connection.
      {
        const { ms, result } = bench(samples, () =>
          pf.findPathHPA('soldier', { start: q.start, goal: q.goal, maxExpansions: 200000 }),
        );
        results.push({
          algo: 'HPA*+budget', query: q.name,
          reached: result.reached, cells: result.cells.length,
          expanded: result.expanded, ms, cost: pathCost(result.cells),
        });
      }
      // FlowField — build field at goal once, walk start → goal via nextStep.
      // The "expanded" cells we record is the count the field covered (cells
      // with finite cost). Walk time is included in `ms`.
      {
        const grid = pf.getGrid('soldier')!;
        const { ms, result } = bench(samples, () => {
          const field = buildFlowField(grid, q.goal);
          const cells: PathNode[] = [{ ...q.start }];
          let cx = q.start.cx, cy = q.start.cy, cz = q.start.cz;
          let safety = 50000;
          let reached = false;
          while (safety-- > 0) {
            if (field.dir[cellIndex(cx, cy, cz)] === FLOW_GOAL) { reached = true; break; }
            const next = nextStep(field, cx, cy, cz);
            if (!next) break;
            cells.push(next);
            cx = next.cx; cy = next.cy; cz = next.cz;
          }
          let covered = 0;
          for (let i = 0; i < field.cost.length; i++) {
            if (field.cost[i]! < Infinity) covered++;
          }
          return { cells, reached, expanded: covered };
        });
        results.push({
          algo: 'FlowField', query: q.name,
          reached: result.reached, cells: result.cells.length,
          expanded: result.expanded, ms, cost: pathCost(result.cells),
        });
      }
    }

    // ---- Print analysis tables. ----
    /* eslint-disable no-console */
    console.log(`\n[bench] HPA* cluster graph build (one-time): ${clusterBuildMs.toFixed(1)} ms`);
    console.log('\n[bench] Per-query metrics (best of 3 samples):\n');
    const header =
      'query'.padEnd(15) +
      'algo'.padEnd(13) +
      'reached'.padStart(8) +
      'cells'.padStart(8) +
      'expanded'.padStart(10) +
      'ms'.padStart(10) +
      'cost'.padStart(10);
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of results) {
      console.log(
        r.query.padEnd(15) +
        r.algo.padEnd(13) +
        String(r.reached).padStart(8) +
        String(r.cells).padStart(8) +
        String(r.expanded).padStart(10) +
        r.ms.toFixed(2).padStart(10) +
        r.cost.toFixed(2).padStart(10),
      );
    }
    /* eslint-enable no-console */

    // Per-algorithm reach summary.
    const algos = Array.from(new Set(results.map(r => r.algo)));
    /* eslint-disable no-console */
    console.log('\n[bench] Per-algorithm reached count:');
    for (const a of algos) {
      const rs = results.filter(r => r.algo === a);
      const ok = rs.filter(r => r.reached).length;
      console.log(`  ${a.padEnd(13)} ${ok}/${rs.length}`);
    }
    /* eslint-enable no-console */

    // Sanity: A*, Theta*, and FlowField are complete (given enough budget) so
    // they must reach every query. HPA* is an approximation — its abstract
    // search + per-segment refinement budget can leave a query unreached on
    // pathological cluster-boundary geometry, so we record but don't fail.
    const completeAlgos = new Set(['A* (w=1.4)', 'A* (w=1.0)', 'Theta*', 'FlowField']);
    for (const r of results) {
      if (completeAlgos.has(r.algo)) {
        expect(r.reached, `${r.algo} failed to reach goal for ${r.query}`).toBe(true);
        expect(r.cells, `${r.algo} returned empty path for ${r.query}`).toBeGreaterThan(1);
      }
    }
    // Every query must be reachable by at least one algorithm — otherwise the
    // test setup is broken (start/goal aren't actually connected).
    for (const q of queries) {
      const anyReached = results.some(r => r.query === q.name && r.reached);
      expect(anyReached, `no algorithm reached ${q.name}`).toBe(true);
    }
  }, 180_000);

  it('flow field amortizes cost across many starts converging on a single goal', () => {
    const world = VoxelWorld.create(false);
    buildCaveWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const grid = pf.getGrid('soldier')!;
    const goal = pf.groundCellAt('soldier', 64.5, 64.5)!;

    // Spread N starts across the surface (skipping the wall row to keep paths
    // routable without the gap blocking everything).
    const starts: PathNode[] = [];
    for (let i = 0; i < 64; i++) {
      const wx = 4 + ((i * 13) % 116) + 0.5;
      const wz = 4 + ((i * 7) % 24) + 0.5;
      const s = pf.groundCellAt('soldier', wx, wz);
      if (s) starts.push(s);
    }

    // FlowField path: build once, derive each path by walking nextStep.
    const tFFBuild = performance.now();
    const field = buildFlowField(grid, goal);
    const ffBuildMs = performance.now() - tFFBuild;

    const tFFWalk = performance.now();
    let ffReached = 0;
    let ffStepsTotal = 0;
    for (const s of starts) {
      let cx = s.cx, cy = s.cy, cz = s.cz;
      let steps = 0;
      let safety = 50000;
      while (safety-- > 0) {
        if (field.dir[cellIndex(cx, cy, cz)] === FLOW_GOAL) { ffReached++; break; }
        const next = nextStep(field, cx, cy, cz);
        if (!next) break;
        cx = next.cx; cy = next.cy; cz = next.cz;
        steps++;
      }
      ffStepsTotal += steps;
    }
    const ffWalkMs = performance.now() - tFFWalk;

    // A* path: N independent searches.
    const tA = performance.now();
    let aReached = 0;
    let aStepsTotal = 0;
    let aExpandedTotal = 0;
    for (const s of starts) {
      const r = pf.findPath('soldier', { start: s, goal, maxExpansions: 200000 });
      if (r.reached) aReached++;
      aStepsTotal += r.cells.length;
      aExpandedTotal += r.expanded;
    }
    const aMs = performance.now() - tA;

    // HPA* path: pre-build cluster graph then N searches.
    const tHpaBuild = performance.now();
    pf.buildClusterGraph('soldier');
    const hpaBuildMs = performance.now() - tHpaBuild;
    const tH = performance.now();
    let hReached = 0;
    let hStepsTotal = 0;
    let hExpandedTotal = 0;
    for (const s of starts) {
      const r = pf.findPathHPA('soldier', { start: s, goal });
      if (r.reached) hReached++;
      hStepsTotal += r.cells.length;
      hExpandedTotal += r.expanded;
    }
    const hMs = performance.now() - tH;

    /* eslint-disable no-console */
    console.log(`\n[bench] N=${starts.length} starts → 1 goal:\n`);
    console.log(`  FlowField: build=${ffBuildMs.toFixed(1)}ms walk=${ffWalkMs.toFixed(1)}ms total=${(ffBuildMs + ffWalkMs).toFixed(1)}ms reached=${ffReached}/${starts.length} steps=${ffStepsTotal}`);
    console.log(`  A* (per-start): total=${aMs.toFixed(1)}ms reached=${aReached}/${starts.length} expanded=${aExpandedTotal} cells=${aStepsTotal}`);
    console.log(`  HPA*: build=${hpaBuildMs.toFixed(1)}ms search=${hMs.toFixed(1)}ms total=${(hpaBuildMs + hMs).toFixed(1)}ms reached=${hReached}/${starts.length} expanded=${hExpandedTotal} cells=${hStepsTotal}`);
    /* eslint-enable no-console */

    expect(ffReached).toBeGreaterThanOrEqual(Math.floor(starts.length * 0.9));
    expect(aReached).toBeGreaterThanOrEqual(Math.floor(starts.length * 0.9));
    expect(hReached).toBeGreaterThanOrEqual(Math.floor(starts.length * 0.9));
  }, 180_000);
});
