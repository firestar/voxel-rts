import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';
import { BARRACKS, FARM, BuildingManager, checkFootprint } from '../src/sim/Buildings';
import { UnitManager, UnitKind } from '../src/sim/Units';
import {
  ActionContext,
  BUILDING_ACTIONS, UNIT_ACTIONS,
  buildingActionsFor, unitActionsFor,
} from '../src/app/Actions';

function buildFlatWorld(surfaceY = 32): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

const NOOP_CTX: ActionContext = {
  enterBuildMode: () => {},
  enterPlantMode: () => {},
  cancelMode: () => {},
};

describe('Building selection state', () => {
  it('newly placed buildings start unselected with an empty train queue', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    expect(b.selected).toBe(false);
    expect(b.trainQueue).toEqual([]);
  });

  it('deselectAll clears `selected` on every building', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    b.selected = true;
    bm.deselectAll();
    expect(b.selected).toBe(false);
  });

  it('getSelected returns the lone selected building, or null if 0 or >1', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp1 = checkFootprint(world.buffers.voxels, nav, BARRACKS, 4, 4);
    const fp2 = checkFootprint(world.buffers.voxels, nav, FARM, 16, 16);
    const a = bm.place(world, BARRACKS, 4, 4, fp1.floorY);
    const b = bm.place(world, FARM, 16, 16, fp2.floorY);
    expect(bm.getSelected()).toBeNull();
    a.selected = true;
    expect(bm.getSelected()).toBe(a);
    b.selected = true;
    expect(bm.getSelected()).toBeNull();
  });
});

describe('Building "Train X" action queue', () => {
  it('barracks `train-soldier` action pushes onto trainQueue', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    const action = BUILDING_ACTIONS.find(a => a.id === 'train-soldier')!;
    expect(action.applicable(b)).toBe(true);
    action.run(b, NOOP_CTX);
    action.run(b, NOOP_CTX);
    expect(b.trainQueue).toEqual(['soldier', 'soldier']);
  });

  it('clear-queue empties the queue', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    b.trainQueue.push('tank', 'soldier');
    const clear = BUILDING_ACTIONS.find(a => a.id === 'clear-queue')!;
    clear.run(b, NOOP_CTX);
    expect(b.trainQueue).toEqual([]);
  });

  it('non-producing buildings hide every train action and the clear-queue action', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, FARM, 8, 8);
    const farm = bm.place(world, FARM, 8, 8, fp.floorY);
    const acts = buildingActionsFor(farm);
    expect(acts.length).toBe(0);
  });

  it('a queued train kind is consumed before the default cycle on the next production tick', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    const bm = new BuildingManager();
    const spawned: UnitKind[] = [];
    bm.spawner = (kind, x, y, z): null => {
      spawned.push(kind);
      // Spawn a real unit so the manager's bookkeeping stays consistent.
      um.spawn(kind, x, y, z);
      return null;
    };
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    // Queue a tank ahead of the default cycle (which would start with soldier).
    b.trainQueue.push('tank');
    // Advance enough seconds for two production ticks to fire — barracks
    // interval is 6 s so we step ~14 seconds to comfortably catch ticks 1+2.
    for (let i = 0; i < 140; i++) bm.tick(0.1, world, um);
    expect(spawned[0]).toBe('tank');
    // Subsequent ticks fall back to the default cycle (which starts at soldier).
    expect(spawned[1]).toBe('soldier');
  });
});

describe('Unit actions', () => {
  it('Stop clears path, firing target, and burst state', () => {
    const um = new UnitManager();
    const u = um.spawn('soldier', 0, 1, 0);
    u.path = [{ x: 5, y: 1, z: 5 }];
    u.firingTarget = { x: 10, y: 1, z: 0 };
    u.burstShotsRemaining = 2;
    u.burstShotTimer = 0.05;
    const stop = UNIT_ACTIONS.find(a => a.id === 'stop')!;
    stop.run([u], NOOP_CTX);
    expect(u.path).toEqual([]);
    expect(u.firingTarget).toBeNull();
    expect(u.burstShotsRemaining).toBe(0);
    expect(u.burstShotTimer).toBe(0);
  });

  it('Cancel task only applies to workers / dozers / haulers', () => {
    const um = new UnitManager();
    const w = um.spawn('worker', 0, 1, 0);
    const d = um.spawn('dozer', 0, 1, 0);
    const h = um.spawn('hauler', 0, 1, 0);
    const sol = um.spawn('soldier', 0, 1, 0);
    const cancel = UNIT_ACTIONS.find(a => a.id === 'cancel-task')!;
    expect(cancel.applicable(w)).toBe(true);
    expect(cancel.applicable(d)).toBe(true);
    expect(cancel.applicable(h)).toBe(true);
    expect(cancel.applicable(sol)).toBe(false);
    w.task = { kind: 'chop', wx: 1, wy: 1, wz: 1 };
    d.levelTargetY = 30;
    h.haulerJob = { vx: 5, vz: 5, mode: 'load' };
    cancel.run([w, d, h], NOOP_CTX);
    expect(w.task.kind).toBe('idle');
    expect(d.levelTargetY).toBeNull();
    expect(h.haulerJob).toBeNull();
  });

  it('Plant action only applies to harvester workers and calls enterPlantMode', () => {
    const um = new UnitManager();
    const harv = um.spawn('worker', 0, 1, 0, { workerRole: 'harvester' });
    const tx = um.spawn('worker', 0, 1, 0, { workerRole: 'transporter' });
    const sol = um.spawn('soldier', 0, 1, 0);
    const plant = UNIT_ACTIONS.find(a => a.id === 'plant')!;
    expect(plant.applicable(harv)).toBe(true);
    expect(plant.applicable(tx)).toBe(false);
    expect(plant.applicable(sol)).toBe(false);
    let entered = false;
    plant.run([harv], { ...NOOP_CTX, enterPlantMode: () => { entered = true; } });
    expect(entered).toBe(true);
  });

  it('Hold fire only shows for armed units and clears their firingTarget', () => {
    const um = new UnitManager();
    const sol = um.spawn('soldier', 0, 1, 0);
    const worker = um.spawn('worker', 0, 1, 0);
    const holdFire = UNIT_ACTIONS.find(a => a.id === 'hold-fire')!;
    expect(holdFire.applicable(sol)).toBe(true);
    expect(holdFire.applicable(worker)).toBe(false);
    sol.firingTarget = { x: 1, y: 1, z: 1 };
    holdFire.run([sol], NOOP_CTX);
    expect(sol.firingTarget).toBeNull();
  });

  it('unitActionsFor returns only actions that match at least one unit', () => {
    const um = new UnitManager();
    const sol = um.spawn('soldier', 0, 1, 0);
    const acts = unitActionsFor([sol]);
    const ids = acts.map(a => a.id);
    expect(ids).toContain('stop');
    expect(ids).toContain('hold-fire');
    expect(ids).not.toContain('cancel-task'); // soldier doesn't have tasks
    expect(ids).not.toContain('plant');       // soldier isn't a harvester
  });

  it('unit action keys are unique within a single applicable selection', () => {
    // The dispatcher fires every action whose key matches `pressed`. If two
    // applicable actions for the same selection ever shared a key, both
    // would fire on a single keypress — almost certainly a bug. We don't
    // currently have a mixed harvester+armed case; the explicit guard
    // catches it if we ever add overlapping bindings.
    const um = new UnitManager();
    const harv = um.spawn('worker', 0, 1, 0, { workerRole: 'harvester' });
    const acts = unitActionsFor([harv]);
    const keys = acts.map(a => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('building action keys are unique for any single building', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const bm = new BuildingManager();
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, 8, 8);
    const b = bm.place(world, BARRACKS, 8, 8, fp.floorY);
    const acts = buildingActionsFor(b);
    const keys = acts.map(a => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
