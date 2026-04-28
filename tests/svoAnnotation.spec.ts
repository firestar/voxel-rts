import { describe, it, expect } from 'vitest';
import {
  allocateChunkSVO, buildChunkSVO, querySVO,
  SVO_LEAF_AIR, SVO_LEAF_SOLID,
} from '../src/path2/SVO';
import {
  allocateChunkSVOAnnotation, annotateChunkSVO,
  leafCost, UnitTraversal,
} from '../src/path2/SVOAnnotation';
import { SVOIndex } from '../src/path2/SVOIndex';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import {
  WORLD_X, WORLD_Z, CHUNK, AIR,
} from '../src/voxel/types';
import { M_BEDROCK, M_STONE, M_DIRT } from '../src/voxel/Materials';

const SOLDIER: UnitTraversal = { radiusVoxels: 3, canDig: false, digCostMult: 0 };
const TANK: UnitTraversal = { radiusVoxels: 10, canDig: false, digCostMult: 0 };
const TUNNELER: UnitTraversal = { radiusVoxels: 14, canDig: true, digCostMult: 8 };

describe('annotateChunkSVO', () => {
  it('inscribed radius for an all-air chunk equals CHUNK / 2', () => {
    const world = VoxelWorld.create(false);
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, world.buffers.voxels, 0, 0, 0, WORLD_X, WORLD_Z);
    const ann = allocateChunkSVOAnnotation();
    annotateChunkSVO(svo, ann);
    expect(svo.tag[0]).toBe(SVO_LEAF_AIR);
    expect(ann.inscribedRadius[0]).toBe(CHUNK / 2);
    expect(ann.diggable[0]).toBe(0);
  });

  it('inscribed radius is 0 for solid leaves; diggable matches material hp', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // First chunk uniformly stone (hp=120 → diggable).
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    const stoneSvo = allocateChunkSVO();
    buildChunkSVO(stoneSvo, v, 0, 0, 0, WORLD_X, WORLD_Z);
    const stoneAnn = allocateChunkSVOAnnotation();
    annotateChunkSVO(stoneSvo, stoneAnn);
    expect(stoneSvo.tag[0]).toBe(SVO_LEAF_SOLID);
    expect(stoneAnn.inscribedRadius[0]).toBe(0);
    expect(stoneAnn.diggable[0]).toBe(1);

    // Adjacent chunk uniformly bedrock (hp=0 → indestructible).
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = CHUNK; x < 2 * CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_BEDROCK;
        }
      }
    }
    const bedrockSvo = allocateChunkSVO();
    buildChunkSVO(bedrockSvo, v, 1, 0, 0, WORLD_X, WORLD_Z);
    const bedrockAnn = allocateChunkSVOAnnotation();
    annotateChunkSVO(bedrockSvo, bedrockAnn);
    expect(bedrockSvo.tag[0]).toBe(SVO_LEAF_SOLID);
    expect(bedrockAnn.diggable[0]).toBe(0);
  });

  it('inscribed radius decreases with leaf depth (smaller leaves admit smaller units)', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Bottom half stone, top half air → root splits, two children. Then drill
    // further by adding a single AIR voxel at (1,1,1) inside the bottom half;
    // that forces the bottom half to split all the way down to a 1-voxel leaf.
    for (let y = 0; y < CHUNK / 2; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    v[worldIndex(1, 1, 1)] = AIR;

    const svo = allocateChunkSVO();
    buildChunkSVO(svo, v, 0, 0, 0, WORLD_X, WORLD_Z);
    const ann = allocateChunkSVOAnnotation();
    annotateChunkSVO(svo, ann);

    // The deep AIR leaf at (1,1,1) is a single voxel → radius rounds to 0,
    // so even a soldier (radius 3) is rejected.
    const deep = querySVO(svo, 1, 1, 1);
    expect(deep.tag).toBe(SVO_LEAF_AIR);
    expect(deep.size).toBe(1);
    expect(ann.inscribedRadius[deep.nodeIdx]).toBe(0);

    // The top-half air leaf is half the chunk → radius CHUNK/4, plenty for
    // any of our units.
    const top = querySVO(svo, 0, CHUNK - 1, 0);
    expect(top.tag).toBe(SVO_LEAF_AIR);
    expect(top.size).toBe(CHUNK / 2);
    expect(ann.inscribedRadius[top.nodeIdx]).toBe(CHUNK / 4);
  });
});

describe('leafCost predicate', () => {
  it('grants a soldier passage through a half-chunk air leaf', () => {
    const world = VoxelWorld.create(false);
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, world.buffers.voxels, 0, 0, 0, WORLD_X, WORLD_Z);
    const ann = allocateChunkSVOAnnotation();
    annotateChunkSVO(svo, ann);
    const r = leafCost(svo, ann, 0, SOLDIER);
    expect(r.canEnter).toBe(true);
    expect(r.costMult).toBe(1);
  });

  it('rejects a tunneler from a leaf too narrow for its radius', () => {
    // Build a chunk where the bottom-front-left octant is one solid stone
    // voxel surrounded by air — forces splits down to size 8 in places. We
    // just need any air leaf smaller than 28 voxels (tunneler radius 14).
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    v[worldIndex(0, 0, 0)] = M_STONE;
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, v, 0, 0, 0, WORLD_X, WORLD_Z);
    const ann = allocateChunkSVOAnnotation();
    annotateChunkSVO(svo, ann);

    // The leaf adjacent to the stone voxel should be sized < CHUNK and so
    // its inscribed radius < CHUNK/2 = 16 — still admits a soldier (3) and a
    // tank (10) but not a tunneler (14)?
    // Actually with a single stone voxel at the corner the smallest containing
    // octant cascades down to size 1. Sibling air leaves are at level 5
    // (size 1, radius 0). Let's just probe the leaf at (1, 1, 1): adjacent
    // to the stone voxel, should be a size-1 air leaf.
    const adj = querySVO(svo, 1, 1, 1);
    expect(adj.tag).toBe(SVO_LEAF_AIR);
    expect(adj.size).toBe(1);
    expect(leafCost(svo, ann, adj.nodeIdx, SOLDIER).canEnter).toBe(false);
    expect(leafCost(svo, ann, adj.nodeIdx, TUNNELER).canEnter).toBe(false);
  });

  it('lets a tunneler enter diggable solid at digCostMult; blocks non-digging units', () => {
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
    const ann = allocateChunkSVOAnnotation();
    annotateChunkSVO(svo, ann);
    expect(svo.tag[0]).toBe(SVO_LEAF_SOLID);

    expect(leafCost(svo, ann, 0, SOLDIER)).toEqual({ canEnter: false, costMult: 0 });
    expect(leafCost(svo, ann, 0, TANK)).toEqual({ canEnter: false, costMult: 0 });
    expect(leafCost(svo, ann, 0, TUNNELER)).toEqual({ canEnter: true, costMult: TUNNELER.digCostMult });
  });

  it('blocks even a tunneler from indestructible solid', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_BEDROCK;
        }
      }
    }
    const svo = allocateChunkSVO();
    buildChunkSVO(svo, v, 0, 0, 0, WORLD_X, WORLD_Z);
    const ann = allocateChunkSVOAnnotation();
    annotateChunkSVO(svo, ann);
    expect(leafCost(svo, ann, 0, TUNNELER).canEnter).toBe(false);
  });
});

describe('SVOIndex annotation lifecycle', () => {
  it('traversalAt resolves through chunked annotations', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        for (let y = 0; y < 60; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);

    // Underground point in stone — only tunneler passes.
    const under = { x: 100, y: 30, z: 100 };
    expect(idx.traversalAt(under.x, under.y, under.z, SOLDIER).canEnter).toBe(false);
    expect(idx.traversalAt(under.x, under.y, under.z, TUNNELER).canEnter).toBe(true);

    // Above-ground point in air — soldier and tank pass; tunneler fits a
    // CHUNK-sized air leaf (radius 16 ≥ 14).
    const above = { x: 100, y: 150, z: 100 };
    expect(idx.traversalAt(above.x, above.y, above.z, SOLDIER).canEnter).toBe(true);
    expect(idx.traversalAt(above.x, above.y, above.z, TANK).canEnter).toBe(true);
    expect(idx.traversalAt(above.x, above.y, above.z, TUNNELER).canEnter).toBe(true);
  });

  it('annotations stay consistent after rebuildDirty surfaces a damaged chunk', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        for (let y = 0; y < 40; y++) v[worldIndex(x, y, z)] = M_STONE;
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    expect(idx.traversalAt(100, 20, 100, SOLDIER).canEnter).toBe(false);

    // Carve a soldier-sized cavity. damageSphere radius 8 voxels with massive
    // damage should clear out a sphere big enough to admit a soldier of
    // radius 3 — but the SVO leaves carved from a sphere are typically small
    // (size 1 to 8), so we expect soldier passage at the *center* only if a
    // leaf at least size 8 (radius 4) materialises there. Probe at a few
    // points to make the test robust to leaf alignment.
    world.damageSphere(100, 20, 100, 8, 9999);
    expect(idx.rebuildDirty(v, world.buffers.dirty)).toBeGreaterThan(0);

    // Center of the sphere is air post-carve.
    const lookup = idx.queryWorld(100, 20, 100);
    expect(lookup).not.toBeNull();
    expect(lookup!.material).toBe(AIR);
    // Outside the sphere, still stone — tunneler-only.
    expect(idx.traversalAt(150, 20, 150, SOLDIER).canEnter).toBe(false);
    expect(idx.traversalAt(150, 20, 150, TUNNELER).canEnter).toBe(true);
  });

  it('changing material after edit updates diggable in lockstep', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    // Start with bedrock — indestructible.
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          v[worldIndex(x, y, z)] = M_BEDROCK;
        }
      }
    }
    const idx = new SVOIndex();
    idx.rebuildAll(v);
    expect(idx.traversalAt(5, 5, 5, TUNNELER).canEnter).toBe(false);

    // Replace the chunk with dirt (diggable). Manual write, then mark dirty.
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          world.set(x, y, z, M_DIRT);
        }
      }
    }
    idx.rebuildDirty(v, world.buffers.dirty);
    const after = idx.traversalAt(5, 5, 5, TUNNELER);
    expect(after.canEnter).toBe(true);
    expect(after.costMult).toBe(TUNNELER.digCostMult);
  });
});
