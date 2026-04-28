import { describe, it, expect } from 'vitest';
import { PathSession } from '../src/path2/PathSession';
import { UnitTraversal } from '../src/path2/SVOAnnotation';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_STONE, M_BEDROCK } from '../src/voxel/Materials';

const SOLDIER: UnitTraversal = {
  radiusVoxels: 3, canDig: false, digCostMult: 0, requiresGround: true,
};

function flatWorld(): { session: PathSession; world: VoxelWorld; floorY: number } {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
    }
  }
  const session = new PathSession(v);
  session.rebuildAll();
  return { session, world, floorY: 32 };
}

describe('PathSession — end-to-end', () => {
  it('route() returns a smoothed path through open terrain', () => {
    const { session, floorY } = flatWorld();
    const r = session.route({
      start: { x: 100, y: floorY, z: 100 },
      goal:  { x: 400, y: floorY, z: 100 },
      unit: SOLDIER,
    });
    expect(r.reached).toBe(true);
    // Smoothed length should be ≤ raw search length.
    expect(r.waypoints.length).toBeLessThanOrEqual(r.smoothedFrom);
    // Endpoints preserved.
    expect(r.waypoints[0]).toEqual({ x: 100, y: floorY, z: 100 });
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: 400, y: floorY, z: 100 });
  });

  it('route() reports unreached when goal is impassable', () => {
    const { session, floorY } = flatWorld();
    const r = session.route({
      start: { x: 100, y: floorY, z: 100 },
      goal:  { x: 100, y: 5, z: 100 }, // inside stone
      unit: SOLDIER,
    });
    expect(r.reached).toBe(false);
    expect(r.waypoints.length).toBe(0);
  });

  it('rebuildDirty surfaces edits — a freshly-carved cavity becomes traversable', () => {
    // Sealed bedrock pocket; even tunneler can't reach. Then we replace the
    // bedrock with diggable stone and rebuild dirty chunks; tunneler should
    // now reach the pocket.
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) v[worldIndex(x, y, z)] = M_BEDROCK;
      }
    }
    for (let y = 24; y < 32; y++) {
      for (let z = 24; z < 32; z++) {
        for (let x = 24; x < 32; x++) v[worldIndex(x, y, z)] = AIR;
      }
    }
    // External floor for a valid start.
    for (let z = 100; z < 200; z++) {
      for (let x = 100; x < 200; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const session = new PathSession(v);
    session.rebuildAll();

    const TUNNELER = { ...SOLDIER, canDig: true, digCostMult: 6, requiresGround: false };
    const before = session.route({
      start: { x: 150, y: 32, z: 150 },
      goal:  { x: 28, y: 28, z: 28 },
      unit: TUNNELER,
      maxExpansions: 100_000,
    });
    expect(before.reached).toBe(false);

    // Convert all the bedrock around the pocket to stone. Use world.set so
    // each edit marks the chunk dirty.
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) {
          if (v[worldIndex(x, y, z)] === M_BEDROCK) {
            world.set(x, y, z, M_STONE);
          }
        }
      }
    }
    expect(session.rebuildDirty(world.buffers.dirty)).toBeGreaterThan(0);

    const after = session.route({
      start: { x: 150, y: 32, z: 150 },
      goal:  { x: 28, y: 28, z: 28 },
      unit: TUNNELER,
      maxExpansions: 200_000,
    });
    expect(after.reached).toBe(true);
  });

  it('flow field + directionTo: 4 starts converge toward one goal', () => {
    const { session, floorY } = flatWorld();
    const goal = { x: 500, y: floorY, z: 500 };
    const field = session.buildFlow(goal, SOLDIER, { maxExpansions: 32_000 });
    const starts = [
      { x: 100, y: floorY, z: 100 },
      { x: 100, y: floorY, z: 900 },
      { x: 900, y: floorY, z: 100 },
      { x: 900, y: floorY, z: 900 },
    ];
    for (const s of starts) {
      const dir = session.directionTo(field, s.x, s.y, s.z);
      expect(dir.hasFlow).toBe(true);
      // Direction roughly points at the goal.
      const gx = goal.x - s.x, gz = goal.z - s.z;
      expect(dir.dx * gx + dir.dz * gz).toBeGreaterThan(0);
    }
  });

  it('canSeeLine wraps lineOfSight', () => {
    const { session, floorY } = flatWorld();
    const a = { x: 100, y: floorY, z: 100 };
    const b = { x: 200, y: floorY, z: 100 };
    expect(session.canSeeLine(a, b, SOLDIER)).toBe(true);
  });
});
