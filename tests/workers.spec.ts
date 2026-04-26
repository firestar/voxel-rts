import { describe, it, expect, beforeEach } from 'vitest';
import { UnitManager } from '../src/sim/Units';
import { Resources } from '../src/sim/Resources';
import { PileManager } from '../src/sim/Piles';
import { SaplingManager } from '../src/sim/Saplings';
import { BuildingManager, STORAGE, checkFootprint } from '../src/sim/Buildings';
import { tickWorkers, WORKER_CARRY_CAP } from '../src/sim/Workers';
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
  piles: PileManager;
  saplings: SaplingManager;
  resources: Resources;
  routeCalls: number;
}

function makeDeps(): Deps {
  const world = buildGrassPlane();
  return {
    units: new UnitManager(),
    world,
    buildings: new BuildingManager(),
    piles: new PileManager(),
    saplings: new SaplingManager(),
    resources: new Resources(),
    routeCalls: 0,
  };
}

function tick(deps: Deps, dt: number): void {
  tickWorkers(dt, {
    units: deps.units,
    world: deps.world,
    buildings: deps.buildings,
    piles: deps.piles,
    saplings: deps.saplings,
    resources: deps.resources,
    routeWorker: (): void => { deps.routeCalls++; },
    onVoxelEdit: (): void => {},
  });
}

describe('harvester worker — chop tree', () => {
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
    const w = deps.units.spawn(
      'worker',
      (baseX + 0.5) * VOXEL_SIZE,
      (SURFACE_Y + 1) * VOXEL_SIZE,
      (baseZ + 0.5) * VOXEL_SIZE,
      { workerRole: 'harvester' },
    );
    // Pre-set the chop task pointed at the lowest wood voxel so the auto-
    // scanner doesn't pick something far away (testing the action, not the
    // search). The voxel is 1 voxel above the worker's feet.
    w.task = {
      kind: 'chop',
      wx: (baseX + 0.5) * VOXEL_SIZE,
      wy: (targetY + 0.5) * VOXEL_SIZE,
      wz: (baseZ + 0.5) * VOXEL_SIZE,
    };

    // Tick a couple of seconds in 100 ms steps. With WORK_DPS=60, hp 60 wood
    // breaks in ~1 s, so 2 s is plenty for at least one voxel.
    for (let i = 0; i < 25; i++) tick(deps, 0.1);

    expect(w.carrying.wood).toBeGreaterThan(0);
    // Lowest wood voxel should be air now.
    expect(deps.world.get(baseX, targetY, baseZ)).toBe(AIR);
  });
});

describe('harvester worker — mine metal', () => {
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
      { workerRole: 'harvester' },
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

describe('harvester worker — drops pile when full', () => {
  it('drops a pile and clears carrying once total >= cap', () => {
    const deps = makeDeps();
    const w = deps.units.spawn('worker', 50, 4, 50, { workerRole: 'harvester' });
    w.carrying.wood = WORKER_CARRY_CAP; // already at cap
    tick(deps, 0.1);
    expect(deps.piles.piles.length).toBe(1);
    expect(deps.piles.piles[0]!.wood).toBe(WORKER_CARRY_CAP);
    expect(w.carrying.wood).toBe(0);
    expect(w.task.kind).toBe('idle');
  });
});

describe('transporter worker — picks up pile and delivers to storage', () => {
  it('pile drops to zero and resources counter rises after delivery', () => {
    const deps = makeDeps();
    const nav = allocateNav(false);
    buildSurfaceNav(deps.world.buffers.voxels, nav);
    // Place a storage at known coords and a pile within reach of where we
    // teleport the transporter. Ticks happen in lockstep without routing —
    // the test bypasses pathing by keeping the transporter close enough each
    // step that INTERACT_REACH_M (1.6 m) is satisfied.
    const fp = checkFootprint(deps.world.buffers.voxels, nav, STORAGE, 40, 40);
    expect(fp.ok).toBe(true);
    deps.buildings.place(deps.world, STORAGE, fp.ox, fp.oz, fp.floorY);

    const pile = deps.piles.drop(50, (SURFACE_Y + 1) * VOXEL_SIZE, 50, 3, 2);

    const t = deps.units.spawn(
      'worker',
      pile.x, pile.y, pile.z,
      { workerRole: 'transporter' },
    );

    // First tick: transporter empty + at the pile → claims and picks up.
    tick(deps, 0.1);
    expect(t.carrying.wood + t.carrying.metals).toBeGreaterThan(0);
    expect(deps.piles.piles.length).toBe(0);

    // Second tick (still at pile spot): task is now 'deliver'; routeWorker
    // is called once because we're not at storage yet. Move the transporter
    // to the storage door and tick again — they should drop off.
    const door = deps.buildings.buildings[0]!;
    const dpos = { x: (door.ox + door.spec.cellsW) * 1.0 + 1 * VOXEL_SIZE, y: (door.floorY + 1) * VOXEL_SIZE, z: (door.oz + door.spec.cellsD * 0.5) };
    void dpos; // not used directly — we use nearestStorage to get the door
    const storage = deps.buildings.buildings[0]!;
    // doorWorldPos lives in Buildings — re-use the helper indirectly through
    // nearestStorage to confirm position calculation; then teleport.
    const nearest = deps.buildings.nearestStorage(t.x, t.z)!;
    expect(nearest.id).toBe(storage.id);
    // Compute the door directly off the building rect.
    const wxEnd = (storage.ox + storage.spec.cellsW) * 8; // NAV_CELL_VOXELS=8
    const wzMid = (storage.oz + storage.spec.cellsD * 0.5) * 8;
    t.x = (wxEnd + 1) * VOXEL_SIZE;
    t.y = (storage.floorY + 1) * VOXEL_SIZE;
    t.z = wzMid * VOXEL_SIZE;

    tick(deps, 0.1);
    expect(t.carrying.wood).toBe(0);
    expect(t.carrying.metals).toBe(0);
    expect(deps.resources.wood).toBe(3);
    expect(deps.resources.metals).toBe(2);
  });
});
