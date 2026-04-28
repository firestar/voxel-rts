import { describe, it, expect } from 'vitest';
import { SVOIndex } from '../src/path2/SVOIndex';
import { lineOfSight, smoothPath, Vec3 } from '../src/path2/LineOfSight';
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
const FLYER_BIG: UnitTraversal = {
  radiusVoxels: 14, canDig: false, digCostMult: 0, requiresGround: false,
};

function flatWorld(): SVOIndex {
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
  return idx;
}

describe('lineOfSight', () => {
  it('returns true for a same-point query', () => {
    const idx = flatWorld();
    const p: Vec3 = { x: 100, y: 50, z: 100 };
    expect(lineOfSight(idx, p, p, FLYER)).toBe(true);
  });

  it('returns true through open air across the world', () => {
    const idx = flatWorld();
    expect(lineOfSight(
      idx,
      { x: 50,  y: 100, z: 50 },
      { x: 950, y: 100, z: 950 },
      FLYER,
    )).toBe(true);
  });

  it('returns false when a stone wall blocks the segment', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Tall stone wall at x=200..207, z=100..900, y=32..160.
    for (let y = 32; y < 160; y++) {
      for (let z = 100; z < 900; z++) {
        for (let x = 200; x < 208; x++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    expect(lineOfSight(
      idx,
      { x: 100, y: 100, z: 500 },
      { x: 300, y: 100, z: 500 },
      FLYER,
    )).toBe(false);
  });

  it('returns false when the corridor is too narrow for the unit', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Solid stone block, then a thin air slot one voxel wide. Going along
    // the slot, a small flyer (radius 3) hits the size-1 air leaves which
    // have inscribedRadius 0 — fails the clearance gate.
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Carve a 1-voxel-wide slot.
    for (let x = 0; x < 64; x++) v[worldIndex(x, 32, 32)] = AIR;
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    expect(lineOfSight(
      idx,
      { x: 5,  y: 32, z: 32 },
      { x: 60, y: 32, z: 32 },
      FLYER,
    )).toBe(false);
  });

  it('big flyer fails LOS through a corridor sized for a soldier', () => {
    // A 4-voxel-tall horizontal slab of air through stone — fits soldier
    // (radius 3 needs leaf size ≥ 6) only if the SVO collapses the slab to a
    // size-≥8 leaf. Most likely the slab carves into size-4 leaves
    // (inscribedRadius 2), failing both. So we use a size-8 cavity for a
    // controllable bound.
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Open a corridor 8 voxels tall (y=24..31), 8 voxels wide (z=24..31),
    // running along x — gives air leaves of size 8 → inscribedRadius 4.
    for (let y = 24; y < 32; y++) {
      for (let z = 24; z < 32; z++) {
        for (let x = 0; x < 64; x++) v[worldIndex(x, y, z)] = AIR;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    // Tunneler-class flyer (radius 14) doesn't fit in size-8 air leaves.
    expect(lineOfSight(
      idx,
      { x: 5, y: 28, z: 28 }, { x: 60, y: 28, z: 28 },
      FLYER_BIG,
    )).toBe(false);
    // Soldier-class flyer (radius 3) fits.
    expect(lineOfSight(
      idx,
      { x: 5, y: 28, z: 28 }, { x: 60, y: 28, z: 28 },
      FLYER,
    )).toBe(true);
  });
});

describe('smoothPath', () => {
  it('preserves a 2-point path unchanged', () => {
    const idx = flatWorld();
    const wps: Vec3[] = [{ x: 10, y: 50, z: 10 }, { x: 20, y: 50, z: 20 }];
    const r = smoothPath(idx, wps, FLYER);
    expect(r).toEqual(wps);
  });

  it('collapses a zigzag path through open air to two endpoints', () => {
    const idx = flatWorld();
    const wps: Vec3[] = [
      { x: 100, y: 50, z: 100 },
      { x: 110, y: 50, z: 100 },
      { x: 120, y: 50, z: 100 },
      { x: 130, y: 50, z: 100 },
      { x: 200, y: 50, z: 100 },
    ];
    const r = smoothPath(idx, wps, FLYER);
    // All intermediate waypoints lie on the same straight line through open
    // air — should collapse to just the endpoints.
    expect(r.length).toBe(2);
    expect(r[0]).toEqual(wps[0]);
    expect(r[r.length - 1]).toEqual(wps[wps.length - 1]);
  });

  it('keeps necessary corner waypoints when a wall forces a detour', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Wall at z=200..207, x=300..700.
    for (let y = 32; y < 80; y++) {
      for (let z = 200; z < 208; z++) {
        for (let x = 300; x < 700; x++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    // Path from south to north — must dodge around the wall (left or right).
    const search = findPath(idx, {
      start: { x: 500, y: 32, z: 100 },
      goal:  { x: 500, y: 32, z: 300 },
      unit: SOLDIER,
    });
    expect(search.reached).toBe(true);
    const smoothed = smoothPath(idx, search.waypoints, SOLDIER);
    // Endpoints preserved exactly.
    expect(smoothed[0]).toEqual(search.waypoints[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(search.waypoints[search.waypoints.length - 1]);
    // Smoothed path is at most as long as the raw search path.
    expect(smoothed.length).toBeLessThanOrEqual(search.waypoints.length);
    // Did NOT over-collapse to a 2-point straight line through the wall —
    // some intermediate waypoint(s) must survive to route around it.
    expect(smoothed.length).toBeGreaterThan(2);
  });

  it('reduces the path length on average for an open-air search result', () => {
    const idx = flatWorld();
    const search = findPath(idx, {
      start: { x: 50,  y: 100, z: 50 },
      goal:  { x: 950, y: 100, z: 950 },
      unit: FLYER,
    });
    expect(search.reached).toBe(true);
    const smoothed = smoothPath(idx, search.waypoints, FLYER);
    // For a uniform open-air world the smoother should collapse to ~2 points.
    expect(smoothed.length).toBeLessThanOrEqual(4);
    expect(smoothed.length).toBeLessThanOrEqual(search.waypoints.length);
  });
});
