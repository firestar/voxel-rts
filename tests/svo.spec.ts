import { describe, it, expect } from 'vitest';
import {
  allocateChunkSVO, buildChunkSVO, querySVO, forEachLeaf,
  SVO_LEAF_AIR, SVO_LEAF_SOLID, SVO_MIXED, SVO_MAX_DEPTH,
} from '../src/path2/SVO';
import { SVOIndex } from '../src/path2/SVOIndex';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import {
  WORLD_X, WORLD_Y, WORLD_Z, CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, AIR,
} from '../src/voxel/types';
import { M_BEDROCK, M_STONE, M_DIRT } from '../src/voxel/Materials';

describe('ChunkSVO build + query', () => {
  it('collapses an all-air chunk to a single leaf', () => {
    const world = VoxelWorld.create(false);
    // World defaults to all zero (AIR). Build SVO for chunk (0,0,0).
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, world.buffers.voxels, 0, 0, 0, WORLD_X, WORLD_Z);
    expect(svo.count).toBe(1);
    expect(svo.tag[0]).toBe(SVO_LEAF_AIR);
    expect(svo.material[0]).toBe(AIR);
    expect(svo.level[0]).toBe(0);
    expect(svo.childrenBase[0]).toBe(-1);
  });

  it('collapses a uniformly-stone chunk to a single solid leaf', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, v, 0, 0, 0, WORLD_X, WORLD_Z);
    expect(svo.count).toBe(1);
    expect(svo.tag[0]).toBe(SVO_LEAF_SOLID);
    expect(svo.material[0]).toBe(M_STONE);
  });

  it('splits when materials differ and resolves queries to the right material', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Bottom half stone, top half air. Forces a split at the root only;
    // each half should still collapse to a single leaf.
    for (let y = 0; y < CHUNK / 2; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, v, 0, 0, 0, WORLD_X, WORLD_Z);

    // Root + 8 children (each itself uniform) = 9 nodes.
    expect(svo.count).toBe(9);
    expect(svo.tag[0]).toBe(SVO_MIXED);

    // Probe corner voxels: bottom corners stone, top corners air.
    expect(querySVO(svo, 0, 0, 0).material).toBe(M_STONE);
    expect(querySVO(svo, CHUNK - 1, 0, CHUNK - 1).material).toBe(M_STONE);
    expect(querySVO(svo, 0, CHUNK - 1, 0).material).toBe(AIR);
    expect(querySVO(svo, CHUNK - 1, CHUNK - 1, CHUNK - 1).material).toBe(AIR);

    // Bottom-half leaves should resolve at level 1 (size = CHUNK/2),
    // not drill all the way down.
    const probe = querySVO(svo, CHUNK / 4, CHUNK / 4, CHUNK / 4);
    expect(probe.size).toBe(CHUNK / 2);
    expect(probe.level).toBe(1);
  });

  it('drills down to single-voxel granularity for a checkerboard', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Every-voxel-different is a worst case — no region above level 5
    // can collapse, so every leaf must be voxel-sized.
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const parity = (x + y + z) & 1;
          v[worldIndex(x, y, z)] = parity ? M_STONE : AIR;
        }
      }
    }
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, v, 0, 0, 0, WORLD_X, WORLD_Z);

    // Spot-check: a few cells should round-trip.
    for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [5, 7, 11], [31, 31, 31]]) {
      const expected = ((x! + y! + z!) & 1) ? M_STONE : AIR;
      expect(querySVO(svo, x!, y!, z!).material).toBe(expected);
    }

    // Every leaf must be a single voxel; the tree is fully dense.
    forEachLeaf(svo, (_lx, _ly, _lz, size, _tag, _mat, _idx) => {
      expect(size).toBe(1);
    });
  });

  it('uniform query resolves at level 0 with size = CHUNK', () => {
    const world = VoxelWorld.create(false);
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, world.buffers.voxels, 0, 0, 0, WORLD_X, WORLD_Z);
    const r = querySVO(svo, CHUNK / 2, CHUNK / 2, CHUNK / 2);
    expect(r.level).toBe(0);
    expect(r.size).toBe(CHUNK);
  });

  it('SVO_MAX_DEPTH matches log2(CHUNK)', () => {
    expect(1 << SVO_MAX_DEPTH).toBe(CHUNK);
  });
});

describe('SVOIndex world-level integration', () => {
  it('sparsifies a typical hill-and-cave world far below the voxel count', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Bedrock floor, stone hill to y=120, dirt cap, air above.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        v[worldIndex(x, 1, z)] = M_BEDROCK;
        for (let y = 2; y < 120; y++) v[worldIndex(x, y, z)] = M_STONE;
        v[worldIndex(x, 120, z)] = M_DIRT;
      }
    }
    // Small horizontal cave so the geometry isn't trivially layered.
    for (let z = 500; z < 520; z++) {
      for (let x = 200; x < 800; x++) {
        for (let y = 80; y < 88; y++) {
          v[worldIndex(x, y, z)] = AIR;
        }
      }
    }

    const idx = new SVOIndex();
    idx.rebuildAll(v);

    const total = idx.totalNodes();
    const voxelCount = WORLD_X * WORLD_Y * WORLD_Z;
    // Sparse claim: a layered world with a one-voxel-thick dirt cap (worst case
    // for octree collapse — any thin axis-aligned slab forces deep splits) plus
    // a cave should still cost less than ~3% of the raw voxel count.
    // Empirically lands around 1.7%.
    expect(total).toBeLessThan(voxelCount / 30);
    // And it must be at least one node per chunk (each chunk has a root).
    expect(total).toBeGreaterThanOrEqual(CHUNKS_X * CHUNKS_Y * CHUNKS_Z);
  });

  it('world-space queries return the same material as the voxel buffer', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 60; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    // Sample a deterministic spread of cells across the world.
    const samples: [number, number, number][] = [
      [0, 0, 0], [WORLD_X - 1, 0, WORLD_Z - 1],
      [10, 30, 10], [500, 59, 500], [500, 60, 500], [500, 100, 500],
      [WORLD_X - 1, WORLD_Y - 1, WORLD_Z - 1],
    ];
    for (const [x, y, z] of samples) {
      const expected = v[worldIndex(x, y, z)]!;
      const got = idx.queryWorld(x, y, z);
      expect(got).not.toBeNull();
      expect(got!.material).toBe(expected);
    }
  });

  it('queryWorld returns null for out-of-bounds coordinates', () => {
    const idx = new SVOIndex();
    idx.rebuildAll(VoxelWorld.create(false).buffers.voxels);
    expect(idx.queryWorld(-1, 0, 0)).toBeNull();
    expect(idx.queryWorld(0, -1, 0)).toBeNull();
    expect(idx.queryWorld(0, 0, -1)).toBeNull();
    expect(idx.queryWorld(WORLD_X, 0, 0)).toBeNull();
    expect(idx.queryWorld(0, WORLD_Y, 0)).toBeNull();
    expect(idx.queryWorld(0, 0, WORLD_Z)).toBeNull();
  });

  it('rebuildDirty re-octrees only chunks whose dirty bit is set, and clears the bits', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Start from a uniformly-stone world so every chunk's SVO is a single leaf.
    v.fill(M_STONE);

    const idx = new SVOIndex();
    idx.rebuildAll(v);
    const initialNodes = idx.totalNodes();
    // CHUNK_COUNT = 6144; one node each.
    expect(initialNodes).toBe(CHUNKS_X * CHUNKS_Y * CHUNKS_Z);

    // Edit one voxel inside chunk (5, 2, 7). VoxelWorld.set marks it dirty.
    const ex = 5 * CHUNK + 4;
    const ey = 2 * CHUNK + 4;
    const ez = 7 * CHUNK + 4;
    world.set(ex, ey, ez, AIR);

    const rebuilt = idx.rebuildDirty(v, world.buffers.dirty);
    // The edit is on the chunk interior (lx=lz=4, ly=4) so only the owning
    // chunk's dirty bit was set.
    expect(rebuilt).toBe(1);

    // After rebuild, the edited chunk is no longer uniform; its SVO must
    // have grown.
    expect(idx.totalNodes()).toBeGreaterThan(initialNodes);

    // The query at the edited cell must now report AIR.
    expect(idx.queryWorld(ex, ey, ez)!.material).toBe(AIR);

    // Dirty bits must be cleared so the next rebuild is a no-op.
    expect(idx.rebuildDirty(v, world.buffers.dirty)).toBe(0);
  });

  it('rebuildDirty re-rebuilds a face-adjacent chunk when an edit lies on the chunk boundary', () => {
    // Sanity check on VoxelWorld.markDirty's neighbor-touch behavior — we rely
    // on it for SVO consistency, so a regression there must surface here.
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    v.fill(M_STONE);
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    // Edit the voxel at the +X face of chunk (3,2,3): lx = CHUNK-1 means the
    // local coord lands on the high-x boundary, so VoxelWorld.markDirty also
    // marks chunk (4,2,3). Two chunks rebuild.
    world.set(4 * CHUNK - 1, 2 * CHUNK + 1, 3 * CHUNK + 1, AIR);
    expect(idx.rebuildDirty(v, world.buffers.dirty)).toBe(2);

    // Mirror case: lx=0 of chunk (4,2,3) marks (3,2,3) too.
    world.set(4 * CHUNK, 2 * CHUNK + 1, 3 * CHUNK + 1, AIR);
    expect(idx.rebuildDirty(v, world.buffers.dirty)).toBe(2);
  });

  it('after a damaging edit, rebuildDirty surfaces the new geometry through queryWorld', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Floor of stone + bedrock so damageSphere has destructible material.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        v[worldIndex(x, 0, z)] = M_BEDROCK;
        for (let y = 1; y < 40; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    expect(idx.queryWorld(100, 20, 100)!.material).toBe(M_STONE);

    // Big enough explosion to overpower stone hp in one shot.
    world.damageSphere(100, 20, 100, 4, 999);
    idx.rebuildDirty(v, world.buffers.dirty);

    // The center cell must now be AIR; some cells just outside the sphere
    // must still be stone.
    expect(idx.queryWorld(100, 20, 100)!.material).toBe(AIR);
    expect(idx.queryWorld(120, 20, 120)!.material).toBe(M_STONE);
  });
});
