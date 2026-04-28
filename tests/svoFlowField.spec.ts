import { describe, it, expect } from 'vitest';
import { SVOIndex } from '../src/path2/SVOIndex';
import { buildLeafFlowField, flowDirectionAt } from '../src/path2/FlowField';
import { UnitTraversal } from '../src/path2/SVOAnnotation';
import { findPath } from '../src/path2/AStar';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_STONE, M_BEDROCK } from '../src/voxel/Materials';

const SOLDIER: UnitTraversal = {
  radiusVoxels: 3, canDig: false, digCostMult: 0, requiresGround: true,
};
const FLYER: UnitTraversal = {
  radiusVoxels: 3, canDig: false, digCostMult: 0, requiresGround: false,
};

function flatWorld(): { idx: SVOIndex; floorY: number } {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
    }
  }
  const idx = new SVOIndex();
  idx.rebuildAll(v);
  return { idx, floorY: 32 };
}

describe('buildLeafFlowField', () => {
  it('produces an empty field when the goal is in solid for a non-digger', () => {
    const { idx } = flatWorld();
    const field = buildLeafFlowField(idx, { x: 100, y: 5, z: 100 }, SOLDIER);
    expect(field.goalKey).toBe(-1);
    expect(field.cost.size).toBe(0);
    expect(field.next.size).toBe(0);
  });

  it('assigns goal-leaf cost 0 and propagates increasing cost outward', () => {
    const { idx, floorY } = flatWorld();
    const field = buildLeafFlowField(idx, { x: 500, y: floorY, z: 500 }, SOLDIER);
    expect(field.goalKey).not.toBe(-1);
    expect(field.cost.get(field.goalKey)).toBe(0);
    expect(field.cost.size).toBeGreaterThan(1);

    // Probe two surface points; the farther one should have higher cost.
    const near = flowDirectionAt(idx, field, 510, floorY, 510);
    const far = flowDirectionAt(idx, field, 800, floorY, 800);
    expect(near.hasFlow).toBe(true);
    expect(far.hasFlow).toBe(true);
    expect(far.costToGoal).toBeGreaterThan(near.costToGoal);
  });

  it('respects maxExpansions budget', () => {
    const { idx, floorY } = flatWorld();
    const small = buildLeafFlowField(idx, { x: 500, y: floorY, z: 500 }, SOLDIER, {
      maxExpansions: 16,
    });
    const big = buildLeafFlowField(idx, { x: 500, y: floorY, z: 500 }, SOLDIER, {
      maxExpansions: 16_384,
    });
    expect(small.expanded).toBeLessThanOrEqual(16);
    expect(big.expanded).toBeGreaterThan(small.expanded);
    expect(big.cost.size).toBeGreaterThan(small.cost.size);
  });
});

describe('flowDirectionAt — many-units shared goal', () => {
  it('multiple distinct starts each get a finite-cost direction toward the goal', () => {
    const { idx, floorY } = flatWorld();
    const goal = { x: 500, y: floorY, z: 500 };
    const field = buildLeafFlowField(idx, goal, SOLDIER, { maxExpansions: 32_000 });
    expect(field.goalKey).not.toBe(-1);

    const starts = [
      { x: 100, y: floorY, z: 100 },
      { x: 100, y: floorY, z: 900 },
      { x: 900, y: floorY, z: 100 },
      { x: 900, y: floorY, z: 900 },
    ];
    for (const s of starts) {
      const dir = flowDirectionAt(idx, field, s.x, s.y, s.z);
      expect(dir.hasFlow).toBe(true);
      // Direction should at least roughly point toward the goal.
      const gx = goal.x - s.x, gz = goal.z - s.z;
      const dot = dir.dx * gx + dir.dz * gz;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('field cost agrees with A* on direction (cheaper-cost neighbor lies on the A* route)', () => {
    const { idx } = flatWorld();
    const goal = { x: 100, y: 100, z: 100 };
    // Use a flyer so the field covers the open air, not just surface leaves.
    const field = buildLeafFlowField(idx, goal, FLYER, { maxExpansions: 32_000 });
    expect(field.goalKey).not.toBe(-1);

    const start = { x: 600, y: 100, z: 600 };
    const ap = findPath(idx, { start, goal, unit: FLYER });
    expect(ap.reached).toBe(true);

    const dir = flowDirectionAt(idx, field, start.x, start.y, start.z);
    expect(dir.hasFlow).toBe(true);
    // The flow direction should be roughly aligned with the first A*
    // segment's direction (both head toward the goal). Tolerance is loose
    // because flow points to the next leaf center, A* points to its first
    // mid-waypoint.
    const aStep = ap.waypoints[1]!;
    const aDx = aStep.x - start.x, aDy = aStep.y - start.y, aDz = aStep.z - start.z;
    const aLen = Math.hypot(aDx, aDy, aDz);
    const cosTheta = (dir.dx * aDx + dir.dy * aDy + dir.dz * aDz) / (aLen);
    // Same general half-space.
    expect(cosTheta).toBeGreaterThan(0);
  });

  it('returns reachedGoal at the goal leaf', () => {
    const { idx, floorY } = flatWorld();
    const goal = { x: 500, y: floorY, z: 500 };
    const field = buildLeafFlowField(idx, goal, SOLDIER);
    const dir = flowDirectionAt(idx, field, goal.x, goal.y, goal.z);
    expect(dir.reachedGoal).toBe(true);
    expect(dir.hasFlow).toBe(true);
  });

  it('returns hasFlow=false for a leaf outside the build budget', () => {
    const { idx, floorY } = flatWorld();
    // Goal in one corner; tiny budget that can't reach the opposite corner.
    const field = buildLeafFlowField(idx, { x: 50, y: floorY, z: 50 }, SOLDIER, {
      maxExpansions: 4,
    });
    const dir = flowDirectionAt(idx, field, 950, floorY, 950);
    expect(dir.hasFlow).toBe(false);
  });

  it('handles an unreachable region (sealed in bedrock) by leaving it out of the field', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Bedrock cube around an air pocket; outside floor for a valid goal.
    for (let y = 0; y < 32; y++) {
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) v[worldIndex(x, y, z)] = M_BEDROCK;
      }
    }
    for (let y = 12; y < 20; y++) {
      for (let z = 12; z < 20; z++) {
        for (let x = 12; x < 20; x++) v[worldIndex(x, y, z)] = AIR;
      }
    }
    // External floor + air for a valid goal.
    for (let z = 100; z < 200; z++) {
      for (let x = 100; x < 200; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    const field = buildLeafFlowField(idx, { x: 150, y: 32, z: 150 }, SOLDIER);
    expect(field.goalKey).not.toBe(-1);
    // The sealed pocket interior should not appear in the field.
    const dir = flowDirectionAt(idx, field, 16, 16, 16);
    expect(dir.hasFlow).toBe(false);
  });
});
