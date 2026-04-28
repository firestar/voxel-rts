import { describe, it, expect } from 'vitest';
import { SVOIndex } from '../src/path2/SVOIndex';
import { findPath, PathRequest, PathResult } from '../src/path2/AStar';
import { UnitTraversal } from '../src/path2/SVOAnnotation';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import {
  WORLD_X, WORLD_Y, WORLD_Z, AIR,
} from '../src/voxel/types';
import { M_STONE, M_BEDROCK } from '../src/voxel/Materials';

const SOLDIER: UnitTraversal = {
  radiusVoxels: 3, canDig: false, digCostMult: 0, requiresGround: true,
};
const FLYER: UnitTraversal = {
  radiusVoxels: 3, canDig: false, digCostMult: 0, requiresGround: false,
};
const TUNNELER: UnitTraversal = {
  radiusVoxels: 3, canDig: true, digCostMult: 6, requiresGround: true,
};

/**
 * Build a flat-floor world: bedrock at y=0,1; stone at y=2..topSolidY; air above.
 * Returns the SVO index and the floor's air-Y level (one above the top solid).
 */
function flatWorld(topSolidY: number): { idx: SVOIndex; floorY: number } {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y <= topSolidY; y++) v[worldIndex(x, y, z)] = M_STONE;
    }
  }
  const idx = new SVOIndex();
  idx.rebuildAll(v);
  return { idx, floorY: topSolidY + 1 };
}

describe('findPath — trivial cases', () => {
  it('start == goal returns a same-leaf two-point path', () => {
    const { idx, floorY } = flatWorld(31);
    const req: PathRequest = {
      start: { x: 100, y: floorY, z: 100 },
      goal: { x: 100, y: floorY, z: 100 },
      unit: SOLDIER,
    };
    const r = findPath(idx, req);
    expect(r.reached).toBe(true);
    expect(r.waypoints.length).toBe(2);
    expect(r.expansions).toBe(0);
  });

  it('rejects when start is in solid for a non-digging unit', () => {
    const { idx } = flatWorld(31);
    const r = findPath(idx, {
      start: { x: 100, y: 5, z: 100 }, // inside stone
      goal: { x: 100, y: 40, z: 100 },
      unit: SOLDIER,
    });
    expect(r.reached).toBe(false);
  });

  it('rejects when goal is in solid for a non-digging unit', () => {
    const { idx, floorY } = flatWorld(31);
    const r = findPath(idx, {
      start: { x: 100, y: floorY, z: 100 },
      goal: { x: 100, y: 5, z: 100 }, // inside stone
      unit: SOLDIER,
    });
    expect(r.reached).toBe(false);
  });
});

describe('findPath — open-air long-distance', () => {
  it('soldier traverses a flat surface from one side of the world to the other', () => {
    const { idx, floorY } = flatWorld(31);
    const r = findPath(idx, {
      start: { x: 50,  y: floorY, z: 50 },
      goal:  { x: 950, y: floorY, z: 950 },
      unit: SOLDIER,
    });
    expect(r.reached).toBe(true);
    expect(r.waypoints.length).toBeGreaterThan(2);
    // Endpoints exact.
    expect(r.waypoints[0]).toEqual({ x: 50, y: floorY, z: 50 });
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: 950, y: floorY, z: 950 });
    // Hierarchy claim: traversing ~1300 voxels diagonally on a uniform
    // surface should be cheap because each surface leaf is large. Bound
    // tuned with margin — empirically lands well under 500.
    expect(r.expansions).toBeLessThan(2000);
  });

  it('flyer traverses open air without needing ground', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Bedrock floor only — the rest is open air.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) v[worldIndex(x, 0, z)] = M_BEDROCK;
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    const r = findPath(idx, {
      start: { x: 50,  y: 100, z: 50 },
      goal:  { x: 950, y: 100, z: 950 },
      unit: FLYER,
    });
    expect(r.reached).toBe(true);
    // Open-air flight in CHUNK-sized leaves. Bidirectional A* with a 3D
    // weighted-Euclidean heuristic fans both sides through the volume; the
    // cones overlap in the middle but each side still expands its full
    // half-cone before meeting. Empirically lands ~900.
    expect(r.expansions).toBeLessThan(2000);
  });

  it('soldier cannot fly — fails over open air with no ground', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) v[worldIndex(x, 0, z)] = M_BEDROCK;
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    // Start is in open air at y=100 — no solid below it within the same
    // air-leaf bottom (the bedrock at y=0 is far below). The leaf containing
    // y=100 has minWy somewhere ≥ 32, and the leaf below is more air, so the
    // soldier predicate rejects start.
    const r = findPath(idx, {
      start: { x: 100, y: 100, z: 100 },
      goal:  { x: 200, y: 100, z: 200 },
      unit: SOLDIER,
    });
    expect(r.reached).toBe(false);
  });
});

describe('findPath — obstacles', () => {
  it('routes a soldier around a vertical stone wall', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Floor.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        v[worldIndex(x, 1, z)] = M_BEDROCK;
        for (let y = 2; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    // Wall: a slab of stone at z=200..207 (8 voxels thick), x=300..700,
    // y=32..160 (above floor, below sky), with a gap at x=300..700 around z=205.
    // Actually just block z=200..207 entirely so the wall fully separates south
    // (z<200) from north (z>207) over a 400-voxel x range, leaving paths
    // around it (x<300 or x>700).
    for (let z = 200; z < 208; z++) {
      for (let x = 300; x < 700; x++) {
        for (let y = 32; y < 80; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    const r = findPath(idx, {
      start: { x: 500, y: 32, z: 100 }, // south of wall
      goal:  { x: 500, y: 32, z: 300 }, // north of wall
      unit: SOLDIER,
    });
    expect(r.reached).toBe(true);
    // Path must dodge around — straight-line distance is 200, but the wall
    // forces a detour; total path length > straight.
    let pathLen = 0;
    for (let i = 1; i < r.waypoints.length; i++) {
      const a = r.waypoints[i - 1]!, b = r.waypoints[i]!;
      pathLen += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
    expect(pathLen).toBeGreaterThan(200);
  });

  it('returns failure when the goal is sealed inside indestructible stone', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Box of bedrock around a small air pocket — non-digger can't reach it.
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) {
          v[worldIndex(x, y, z)] = M_BEDROCK;
        }
      }
    }
    // Carve an air pocket in the middle.
    for (let y = 24; y < 32; y++) {
      for (let z = 24; z < 32; z++) {
        for (let x = 24; x < 32; x++) {
          v[worldIndex(x, y, z)] = AIR;
        }
      }
    }
    // External floor + air to give a valid start.
    for (let z = 100; z < 200; z++) {
      for (let x = 100; x < 200; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 32; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    const r = findPath(idx, {
      start: { x: 150, y: 32, z: 150 }, // outside pocket, on stone surface
      goal:  { x: 28,  y: 28, z: 28 },  // inside pocket
      unit: SOLDIER, // can't dig
    });
    expect(r.reached).toBe(false);
    // Bounded effort even on failure.
    expect(r.expansions).toBeLessThan(10_000);
  });
});

describe('findPath — digging', () => {
  it('tunneler digs through diggable stone to reach a sealed pocket', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Stone block (diggable) with an air pocket inside, plus an outer surface
    // to start on.
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    for (let y = 24; y < 32; y++) {
      for (let z = 24; z < 32; z++) {
        for (let x = 24; x < 32; x++) {
          v[worldIndex(x, y, z)] = AIR;
        }
      }
    }
    // Bedrock floor below.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) v[worldIndex(x, 0, z)] = M_BEDROCK;
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    // Tunneler starts inside the stone at the surface (it can re-emerge).
    // Realistically we'd start above — but the test point is that with
    // canDig=true, the search routes through diggable solid.
    const r = findPath(idx, {
      start: { x: 5,  y: 32, z: 5 },  // inside the stone — but ground requirement…
      goal:  { x: 28, y: 28, z: 28 },
      unit: { ...TUNNELER, requiresGround: false }, // simplify by relaxing ground
      maxExpansions: 200_000,
    });
    expect(r.reached).toBe(true);
  });
});

describe('findPath — expansion cap', () => {
  it('returns failure when the cap is exhausted', () => {
    const { idx, floorY } = flatWorld(31);
    const r: PathResult = findPath(idx, {
      start: { x: 50,  y: floorY, z: 50 },
      goal:  { x: 950, y: floorY, z: 950 },
      unit: SOLDIER,
      maxExpansions: 5,
    });
    expect(r.reached).toBe(false);
    expect(r.expansions).toBeLessThanOrEqual(5);
  });
});
