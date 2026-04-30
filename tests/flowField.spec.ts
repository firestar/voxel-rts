import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import { GRID_X, GRID_Z, cellIndex } from '../src/path/Nav';
import { FLOW_GOAL, FLOW_NONE, nextStep, buildFlowField } from '../src/path/FlowField';

const SURFACE_VY = 64;

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

describe('buildFlowField', () => {
  it('marks the goal cell with FLOW_GOAL and decreases monotonically along nextStep', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const goal = pf.groundCellAt('soldier', 64.5, 64.5)!;
    const grid = pf.getGrid('soldier')!;
    const field = buildFlowField(grid, goal);

    const goalIdx = cellIndex(goal.cx, goal.cy, goal.cz);
    expect(field.dir[goalIdx]).toBe(FLOW_GOAL);
    expect(field.cost[goalIdx]).toBe(0);

    // Pick a far cell, walk by nextStep, expect strict descent in cost
    // and arrival at the goal in a bounded number of steps.
    const start = pf.groundCellAt('soldier', 30.5, 80.5)!;
    let cx = start.cx, cy = start.cy, cz = start.cz;
    let prevCost = field.cost[cellIndex(cx, cy, cz)]!;
    expect(prevCost).toBeLessThan(Infinity);

    let safety = 200;
    while (safety-- > 0) {
      const here = cellIndex(cx, cy, cz);
      if (field.dir[here] === FLOW_GOAL) break;
      const next = nextStep(field, cx, cy, cz);
      expect(next).not.toBeNull();
      const nextCost = field.cost[cellIndex(next!.cx, next!.cy, next!.cz)]!;
      expect(nextCost).toBeLessThan(prevCost);
      prevCost = nextCost;
      cx = next!.cx; cy = next!.cy; cz = next!.cz;
    }
    // Should have reached the goal.
    expect(cellIndex(cx, cy, cz)).toBe(goalIdx);
  });

  it('returns FLOW_NONE for cells the goal cannot reach (other side of a wall)', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);
    // Tall wall splitting the map at x = 64.
    const v = world.buffers.voxels;
    const surfTop = SURFACE_VY + 4;
    const wallTop = surfTop + 32;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let dx = 0; dx < 8; dx++) {
        const x = 64 * 8 + dx;
        for (let y = surfTop + 1; y <= wallTop; y++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const goal = pf.groundCellAt('soldier', 30.5, 30.5)!;
    const blocked = pf.groundCellAt('soldier', 100.5, 30.5)!;
    const grid = pf.getGrid('soldier')!;
    const field = buildFlowField(grid, goal);
    const blockedIdx = cellIndex(blocked.cx, blocked.cy, blocked.cz);
    expect(field.dir[blockedIdx]).toBe(FLOW_NONE);
    expect(field.cost[blockedIdx]).toBe(Infinity);
  });

  it('cache returns the same object for repeated requests with the same goal', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const goal = pf.groundCellAt('soldier', 50.5, 50.5)!;
    const a = pf.getFlowField('soldier', goal);
    const b = pf.getFlowField('soldier', goal);
    expect(a).toBe(b);
  });

  it('invalidates cached fields after applyDamage', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const goal = pf.groundCellAt('soldier', 50.5, 50.5)!;
    const before = pf.getFlowField('soldier', goal);
    expect(before).not.toBeNull();

    // A small applyDamage in another part of the map should still drop the
    // cached fields (they are tied to the unit-grid bitmap as a whole).
    pf.applyDamage(80, 60, 80, 88, 80, 88);
    const after = pf.getFlowField('soldier', goal);
    expect(after).not.toBe(before);
  });
});
