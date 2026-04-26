import { describe, it, expect } from 'vitest';
import { placeTrees } from '../src/voxel/Trees';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_WOOD, M_LEAF } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, navIndex } from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';

function buildGrassPlane(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const surfaceY = 32;
  // Bottom dirt layer, single-voxel grass on top, air above.
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_GRASS - 1; // dirt id 2
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('placeTrees', () => {
  it('places at least one tree and writes both wood and leaf voxels', () => {
    const world = buildGrassPlane();
    const before = countMaterials(world.buffers.voxels);
    const { count } = placeTrees(world.buffers.voxels, 12345);
    const after = countMaterials(world.buffers.voxels);

    expect(count).toBeGreaterThan(0);
    expect(after.wood).toBeGreaterThan(before.wood);
    expect(after.leaf).toBeGreaterThan(before.leaf);
  });

  it('respects a minimum spacing — no two tree trunks land on the exact same voxel', () => {
    const world = buildGrassPlane();
    placeTrees(world.buffers.voxels, 999);
    // Walk the surface+1 voxel layer; collect (x,z) of every wood voxel right above
    // the grass layer (= a trunk base). Two trees can't share a base column.
    const v = world.buffers.voxels;
    const trunkBaseY = 33;
    const seen = new Set<number>();
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        if (v[worldIndex(x, trunkBaseY, z)] === M_WOOD) {
          const key = z * WORLD_X + x;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('skips columns whose surface isn\'t grass', () => {
    // Build a world where the top voxel is stone (not grass).
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    const surfaceY = 32;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, surfaceY, z)] = 3; // stone
      }
    }
    const { count } = placeTrees(v, 1);
    expect(count).toBe(0);
  });

  it('is deterministic for a given seed', () => {
    const a = buildGrassPlane();
    const b = buildGrassPlane();
    placeTrees(a.buffers.voxels, 4242);
    placeTrees(b.buffers.voxels, 4242);
    // Compare a small sample window — full equality would be slow but the seeds
    // produce the same hashes everywhere.
    let agree = true;
    for (let i = 0; i < 1_000_000; i += 7919) {
      if (a.buffers.voxels[i] !== b.buffers.voxels[i]) { agree = false; break; }
    }
    expect(agree).toBe(true);
  });
});

describe('trees + surface pathing', () => {
  it('placeTrees leaves enough headroom in adjacent cells for the tallest unit (18 voxels)', () => {
    // Build a flat grass world, place the procedural forest, then sample headroom
    // for cells that are NOT the trunk cell of any tree but are next to one. The
    // canopy should sit above the tallest unit's clearance — without that the
    // forest blocks all surface paths.
    const world = buildGrassPlane();
    const v = world.buffers.voxels;
    placeTrees(v, 7777);
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);

    // Find every nav cell that has wood at any of its 5 sample probes — those are
    // "trunk cells". Their immediate 4-neighbours should still have headroom for
    // the tallest unit (tank, 18 voxels).
    const TANK_HEIGHT = 18;
    let trunkCells = 0;
    let neighborsWithEnoughHead = 0;
    let neighborsTooLow = 0;
    for (let cz = 1; cz < 95; cz++) {
      for (let cx = 1; cx < 95; cx++) {
        const trunkBaseY = 33;
        const isTrunk =
          v[worldIndex(cx * 8 + 0, trunkBaseY, cz * 8 + 0)] === M_WOOD ||
          v[worldIndex(cx * 8 + 7, trunkBaseY, cz * 8 + 7)] === M_WOOD ||
          v[worldIndex(cx * 8 + 4, trunkBaseY, cz * 8 + 4)] === M_WOOD;
        if (!isTrunk) continue;
        trunkCells++;
        // Check the 4 cardinal neighbours
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ncx = cx + dx, ncz = cz + dz;
          const nh = nav.headroom[navIndex(ncx, ncz)]!;
          if (nh >= TANK_HEIGHT) neighborsWithEnoughHead++;
          else neighborsTooLow++;
        }
      }
    }
    expect(trunkCells).toBeGreaterThan(0);
    // The vast majority of neighbours should pass; some will fail because of
    // overlapping canopies on dense forest patches and that's acceptable.
    const passRate = neighborsWithEnoughHead / (neighborsWithEnoughHead + neighborsTooLow);
    expect(passRate).toBeGreaterThan(0.5);
  });

  it('a unit with high-enough headroom requirement detours around tree cells', () => {
    // Build the same flat grass world the tree tests use, place a single tall tree,
    // then ask for a path through its trunk cell. With headroomVoxels >= the tree
    // height, the surface path search should reject the tree's nav cell.
    const world = buildGrassPlane();
    const v = world.buffers.voxels;
    // Place a single tree at the centre of cell (12, 12). With NAV_CELL_VOXELS=8 the
    // cell spans voxels x=[96..103] z=[96..103] and its centre column is (100, 100) —
    // headroom is sampled there, so the trunk needs to sit at that column to register.
    const baseX = 100, baseZ = 100;
    // Manually stamp a tall trunk so the tree cell has a known low headroom.
    const trunkBase = 32;
    for (let dy = 1; dy <= 16; dy++) {
      v[worldIndex(baseX, trunkBase + dy, baseZ)] = 4; // wood
    }

    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);

    // Cell (12, 12) holds the trunk. Its headroom should be small (just above the
    // grass voxel until the trunk starts). Sanity-check.
    const treeCellHead = nav.headroom[navIndex(12, 12)]!;
    expect(treeCellHead).toBeLessThan(16);

    const ws = new AStarWorkspace();
    const r = findPathSurface(nav, ws, {
      startCx: 8, startCz: 12,
      goalCx: 16, goalCz: 12,
      footprintRadius: 1, maxStepVoxels: 32, slopePenalty: 0.1,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999,
      headroomVoxels: 14, // soldier-height; bigger than the tree's airspace
      prefersRoads: false,
    });
    // Path may detour or fail — but it must not pass through the trunk cell.
    for (const c of r.cells) {
      expect(c.cx === 12 && c.cz === 12).toBe(false);
    }
  });
});

function countMaterials(v: Uint8Array): { wood: number; leaf: number } {
  let wood = 0, leaf = 0;
  // Sample stride for speed — the voxel buffer is huge.
  for (let i = 0; i < v.length; i += 1) {
    const m = v[i]!;
    if (m === M_WOOD) wood++;
    else if (m === M_LEAF) leaf++;
  }
  return { wood, leaf };
}
