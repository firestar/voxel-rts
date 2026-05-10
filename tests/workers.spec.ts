import { describe, it, expect, beforeEach } from 'vitest';
import { UnitManager } from '../src/sim/Units';
import { Resources } from '../src/sim/Resources';
import { SaplingManager } from '../src/sim/Saplings';
import { BuildingManager, STORAGE, checkFootprint } from '../src/sim/Buildings';
import { tickWorkers, WORKER_CARRY_CAP } from '../src/sim/Workers';
import { WorkerTaskBoard } from '../src/sim/WorkerTasks';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE, AIR } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_WOOD, M_METAL } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';

const SURFACE_Y = 32;

function buildGrassPlane(): VoxelWorld {
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

interface Deps {
  units: UnitManager;
  world: VoxelWorld;
  buildings: BuildingManager;
  saplings: SaplingManager;
  resources: Resources;
  taskBoard: WorkerTaskBoard;
  routeCalls: number;
}

function makeDeps(): Deps {
  const world = buildGrassPlane();
  return {
    units: new UnitManager(),
    world,
    buildings: new BuildingManager(),
    saplings: new SaplingManager(),
    resources: new Resources(),
    taskBoard: new WorkerTaskBoard(),
    routeCalls: 0,
  };
}

function tick(deps: Deps, dt: number): void {
  tickWorkers(dt, {
    units: deps.units,
    world: deps.world,
    buildings: deps.buildings,
    saplings: deps.saplings,
    resources: deps.resources,
    taskBoard: deps.taskBoard,
    routeWorker: (): void => { deps.routeCalls++; },
    onVoxelEdit: (): void => {},
  });
}

describe('worker — chop tree', () => {
  let deps: Deps;
  beforeEach(() => { deps = makeDeps(); });

  it('damages and destroys a wood voxel placed in reach, accumulates carry', () => {
    // Stamp a 4-voxel wood column at (100, 33..36, 100). Worker stands at
    // (100, 33, 100) so the closest wood voxel is right above its feet.
    const baseX = 100, baseZ = 100;
    for (let dy = 1; dy <= 4; dy++) {
      deps.world.set(baseX, SURFACE_Y + dy, baseZ, M_WOOD);
    }
    const targetY = SURFACE_Y + 1;
    const topY = SURFACE_Y + 4;
    const w = deps.units.spawn(
      'worker',
      (baseX + 0.5) * VOXEL_SIZE,
      (SURFACE_Y + 1) * VOXEL_SIZE,
      (baseZ + 0.5) * VOXEL_SIZE,
    );
    // Pre-set the chop task pointed at the lowest wood voxel so the auto-
    // scanner doesn't pick something far away. Per-tick retargeting will
    // walk up the trunk to chop top-down within reach.
    w.task = {
      kind: 'chop',
      wx: (baseX + 0.5) * VOXEL_SIZE,
      wy: (targetY + 0.5) * VOXEL_SIZE,
      wz: (baseZ + 0.5) * VOXEL_SIZE,
    };

    // Tick 2 s in 100 ms steps. With WORK_DPS=60 and hp 60 per wood voxel,
    // that's enough to fell at least the topmost voxel.
    for (let i = 0; i < 20; i++) tick(deps, 0.1);

    expect(w.carrying.wood).toBeGreaterThan(0);
    // Choppers fell trees top-down, so the topmost voxel should be air first.
    expect(deps.world.get(baseX, topY, baseZ)).toBe(AIR);
  });
});

describe('worker — mine metal', () => {
  it('damages an exposed metal voxel and accumulates carry.metals', () => {
    const deps = makeDeps();
    const baseX = 200, baseZ = 200;
    // Place a single metal voxel above the surface (exposed on all sides).
    deps.world.set(baseX, SURFACE_Y + 1, baseZ, M_METAL);
    const w = deps.units.spawn(
      'worker',
      (baseX + 0.5) * VOXEL_SIZE,
      (SURFACE_Y + 1) * VOXEL_SIZE,
      (baseZ + 0.5) * VOXEL_SIZE,
    );
    w.task = {
      kind: 'mine',
      wx: (baseX + 0.5) * VOXEL_SIZE,
      wy: (SURFACE_Y + 1.5) * VOXEL_SIZE,
      wz: (baseZ + 0.5) * VOXEL_SIZE,
    };
    for (let i = 0; i < 25; i++) tick(deps, 0.1);
    expect(w.carrying.metals).toBeGreaterThan(0);
  });


});

describe('worker — switches to deliver when full', () => {
  it('switches task to deliver and keeps the carry buffer once total >= cap', () => {
    const deps = makeDeps();
    const w = deps.units.spawn('worker', 50, 4, 50);
    w.carrying.wood = WORKER_CARRY_CAP; // already at cap
    tick(deps, 0.1);
    expect(w.task.kind).toBe('deliver');
    expect(w.carrying.wood).toBe(WORKER_CARRY_CAP);
  });
});

describe('worker — delivers carried resources to storage', () => {
  it('drops carry into resources counter when in range of a storage door', () => {
    const deps = makeDeps();
    const nav = allocateNav(false);
    buildSurfaceNav(deps.world.buffers.voxels, nav);
    // Place a storage at known coords. The worker starts the test in
    // 'deliver' state so the tick logic walks it to the storage door.
    const fp = checkFootprint(deps.world.buffers.voxels, nav, STORAGE, 40, 40);
    expect(fp.ok).toBe(true);
    deps.buildings.place(deps.world, STORAGE, fp.ox, fp.oz, fp.floorY);
    const storage = deps.buildings.buildings[0]!;

    const w = deps.units.spawn('worker', 50, 4, 50);
    w.carrying.wood = 3;
    w.carrying.metals = 2;
    w.task = { kind: 'deliver' };

    // Teleport the worker to the storage door so the in-range branch fires
    // immediately rather than depending on path follow. Door rendezvous is
    // 4 voxels (0.5 m) past the wall.
    const wxEnd = (storage.ox + storage.spec.cellsW) * 8; // NAV_CELL_VOXELS=8
    const wzMid = (storage.oz + storage.spec.cellsD * 0.5) * 8;
    w.x = (wxEnd + 4) * VOXEL_SIZE; // matches doorWorldPos gap (4 voxels)
    w.y = (storage.floorY + 1) * VOXEL_SIZE;
    w.z = wzMid * VOXEL_SIZE;

    tick(deps, 0.1);
    expect(w.carrying.wood).toBe(0);
    expect(w.carrying.metals).toBe(0);
    // Workers now deposit into storage.stockpile (trucks carry it to HQ).
    expect(storage.stockpile.wood).toBe(3);
    expect(storage.stockpile.metals).toBe(2);
    // Global resources unchanged until a truck delivers from storage → HQ.
    expect(deps.resources.wood).toBe(0);
    expect(deps.resources.metals).toBe(0);
  });
});
