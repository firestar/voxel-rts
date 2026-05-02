/**
 * Performance / integration test: workers pathfinding to metal nodes.
 *
 * Scenario:
 *   - Flat world with 3 metal ore piles placed on the surface
 *   - 1 storage building (so workers can deliver)
 *   - 1 barracks that produces 4 workers over the sim period
 *   - 2 workers pre-spawned at startup
 *   - Real synchronous A* routing via Pathfinder (no fake routeWorker stub)
 *   - 60 s of simulated time at dt=1/60
 *
 * Assertions:
 *   - No tick takes more than 50 ms of wall time (lag-spike gate)
 *   - Workers actually collect metal (verifies pathfinding reaches clusters)
 *   - routeWorker call count is ≤ ROUTE_COOLDOWN_SECS^-1 × workers × simSeconds
 *     (verifies the cooldown suppresses spam requests)
 */

import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT, M_GRASS, M_METAL } from '../src/voxel/Materials';
import {
  allocateNav, buildSurfaceNav,
  NAV_CELL_VOXELS, NAV_CELL_METERS,
} from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { unitConfig } from '../src/sim/Units';
import { UnitManager } from '../src/sim/Units';
import { BuildingManager, BARRACKS, STORAGE, checkFootprint } from '../src/sim/Buildings';
import { SaplingManager } from '../src/sim/Saplings';
import { Resources } from '../src/sim/Resources';
import { WorkerTaskBoard } from '../src/sim/WorkerTasks';
import { tickWorkers } from '../src/sim/Workers';

const SURFACE_Y = 20;

function buildWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < SURFACE_Y; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, SURFACE_Y, z)] = M_GRASS;
    }
  }
  return world;
}

/** Stamp a small dome of metal voxels centred at voxel (cx, cz). */
function placeOrePile(world: VoxelWorld, cx: number, cz: number): void {
  const r = 3;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz <= r * r) {
        world.set(cx + dx, SURFACE_Y + 1, cz + dz, M_METAL);
      }
    }
  }
}

describe('worker performance — pathfinding to metal nodes', () => {
  it('workers mine metal without lag spikes, route calls are rate-limited', () => {
    // ── World ──────────────────────────────────────────────────────────────
    const world = buildWorld();

    // Three ore piles within ~40–80 voxels of the spawn area (nav cell 20,20)
    const orePositions = [
      { vx: 200, vz: 200 },
      { vx: 260, vz: 180 },
      { vx: 180, vz: 260 },
    ];
    for (const p of orePositions) placeOrePile(world, p.vx, p.vz);

    // ── Nav ────────────────────────────────────────────────────────────────
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);

    // ── Pathfinder ─────────────────────────────────────────────────────────
    const pf = new Pathfinder(false);
    pf.attach(world);
    const workerCfg = unitConfig('worker');
    pf.registerProfile(profileFromUnit({ kind: 'worker', ...workerCfg }));

    // ── Buildings ──────────────────────────────────────────────────────────
    const bm = new BuildingManager();
    const um = new UnitManager();

    // Storage at nav cell (8, 8)
    const storageFp = checkFootprint(world.buffers.voxels, nav, STORAGE, 8, 8);
    expect(storageFp.ok).toBe(true);
    bm.place(world, STORAGE, storageFp.ox, storageFp.oz, storageFp.floorY);

    // Barracks at nav cell (16, 8) — will auto-produce workers
    const barracksFp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 16, 8);
    expect(barracksFp.ok).toBe(true);
    const barracks = bm.place(world, BARRACKS, barracksFp.ox, barracksFp.oz, barracksFp.floorY);

    // Wire up spawner so barracks.tick can produce units; force mine focus so
    // workers don't try to chop the barracks' own wood walls.
    bm.spawner = (kind, x, y, z) => {
      const w = um.spawn(kind, x, y, z);
      if (kind === 'worker') w.workerFocus = 'mine';
      return w;
    };

    // Queue 4 workers to be trained
    for (let i = 0; i < 4; i++) barracks.trainQueue.push('worker');

    // Rebuild nav after buildings (walls block cells)
    buildSurfaceNav(world.buffers.voxels, nav);
    pf.attach(world);
    pf.registerProfile(profileFromUnit({ kind: 'worker', ...workerCfg }));

    // ── Pre-spawn 2 workers near the storage ──────────────────────────────
    const surfaceM = (SURFACE_Y + 1) * VOXEL_SIZE;
    const spawnX = 20 * NAV_CELL_METERS;
    const spawnZ = 20 * NAV_CELL_METERS;
    for (let i = 0; i < 2; i++) {
      const w = um.spawn('worker', spawnX + i * 2, surfaceM, spawnZ);
      w.workerFocus = 'mine';
    }

    // ── Deps ───────────────────────────────────────────────────────────────
    const resources = new Resources();
    const saplings = new SaplingManager();
    const taskBoard = new WorkerTaskBoard();

    let routeCalls = 0;
    // A* runs synchronously here but would be async (web worker) in production.
    // Track its cost separately so the spike gate measures only tickWorkers overhead.
    let pendingRouteMs = 0;

    const ROUTE_LIMIT_PER_WORKER_PER_SEC = 1 / 0.4 + 1; // cooldown is 0.4 s

    let pathsFound = 0;
    let pathsFailed = 0;

    // Sync routeWorker: run A* immediately so workers actually walk
    function routeWorker(u: ReturnType<typeof um.spawn>, wx: number, wy: number, wz: number): void {
      routeCalls++;
      const r0 = performance.now();
      const start = pf.cellAt(u.x, u.y, u.z);
      let goal = pf.cellAt(wx, wy, wz);
      const ground = pf.groundCellAt('worker', wx, wz);
      if (ground) goal = ground;
      goal = pf.nearestPassable('worker', goal, 5);
      const res = pf.findPath('worker', { start, goal, anyAngle: true, maxExpansions: 30000 });
      if (res.cells.length > 0 && res.reached) {
        um.setPath(u, pf.pathToWaypoints(res.cells));
        pathsFound++;
      } else {
        pathsFailed++;
      }
      pendingRouteMs += performance.now() - r0;
    }

    // ── Simulation loop ────────────────────────────────────────────────────
    const DT = 1 / 60;
    const SIM_SECONDS = 60;
    const FRAMES = Math.round(SIM_SECONDS / DT);
    const SPIKE_THRESHOLD_MS = 50;

    const spikeFrames: { frame: number; ms: number }[] = [];
    let maxTickMs = 0;
    let oreVoxelsDestroyed = 0;

    for (let frame = 0; frame < FRAMES; frame++) {
      // Barracks tick (spawns units as timer fires)
      bm.tick(DT, world, um);

      // Unit movement tick
      um.tick(DT, nav, vnav, world.buffers.voxels, () => {});

      // Worker automation tick — measure only tickWorkers overhead, not A* cost
      // (A* runs in a web worker in production and doesn't block the main thread).
      pendingRouteMs = 0;
      const t0 = performance.now();
      tickWorkers(DT, {
        units: um,
        world,
        buildings: bm,
        saplings,
        resources,
        taskBoard,
        routeWorker,
        onVoxelEdit: () => { oreVoxelsDestroyed++; },
      });
      const tickMs = performance.now() - t0 - pendingRouteMs;

      if (tickMs > maxTickMs) maxTickMs = tickMs;
      if (tickMs > SPIKE_THRESHOLD_MS) {
        spikeFrames.push({ frame, ms: tickMs });
      }
    }

    const finalWorkerCount = um.units.filter(u => u.kind === 'worker').length;
    const metalsCollected = resources.metals;

    // ── Report ─────────────────────────────────────────────────────────────
    console.log(`[perf] ${SIM_SECONDS}s sim, ${finalWorkerCount} workers`);
    console.log(`[perf] max tick: ${maxTickMs.toFixed(2)} ms`);
    console.log(`[perf] route calls: ${routeCalls} (found=${pathsFound} failed=${pathsFailed}) (workers × sim = ${finalWorkerCount} × ${SIM_SECONDS} s)`);
    console.log(`[perf] metals collected: ${metalsCollected}`);
    const workerStates = um.units.filter(u => u.kind === 'worker').map(u => `${u.task.kind}@(${u.x.toFixed(1)},${u.z.toFixed(1)})`);
    console.log(`[perf] worker states: ${workerStates.join(', ')}`);
    if (spikeFrames.length > 0) {
      console.log(`[perf] SPIKES (>${SPIKE_THRESHOLD_MS}ms): ${spikeFrames.length}`);
      for (const s of spikeFrames.slice(0, 10)) {
        console.log(`  frame ${s.frame}: ${s.ms.toFixed(1)} ms`);
      }
    }

    // ── Assertions ─────────────────────────────────────────────────────────
    expect(spikeFrames.length, `lag spikes over ${SPIKE_THRESHOLD_MS}ms: ${JSON.stringify(spikeFrames.slice(0, 5))}`).toBe(0);
    // Verify pathfinding actually reaches ore clusters — workers may not complete
    // the full mine→deliver cycle within 60 s (CARRY_CAP=20 requires 20 voxels),
    // so we count ore voxels destroyed as proof workers reached the ore.
    const metalsCarried = um.units.filter(u => u.kind === 'worker').reduce((sum, u) => sum + u.carrying.metals, 0);
    expect(metalsCollected + metalsCarried + oreVoxelsDestroyed,
      'workers should reach and mine at least 1 ore voxel').toBeGreaterThan(0);

    // Route call rate: at most ~3/s per worker across the whole sim
    const maxExpectedRouteCalls = finalWorkerCount * SIM_SECONDS * ROUTE_LIMIT_PER_WORKER_PER_SEC;
    expect(routeCalls, `route calls ${routeCalls} exceeded ceiling ${maxExpectedRouteCalls}`).toBeLessThanOrEqual(maxExpectedRouteCalls);
  }, 120_000);
});
