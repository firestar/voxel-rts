import { CHUNK, AIR, MaterialId } from '../voxel/types';

/**
 * Sparse Voxel Octree, scoped to a single CHUNK (32³ voxels).
 *
 * Each chunk gets its own octree. Uniform sub-regions collapse into a single
 * leaf — solid bedrock and open air, which dominate a typical voxel world,
 * become one node each. The "sparse" in the name refers to that collapse.
 *
 * Layout: struct-of-arrays, packed. A node is a row in {tag, material,
 * childrenBase, level}. MIXED nodes have 8 contiguous children at
 * `childrenBase`; leaves have `childrenBase = -1`. The 8 children of a MIXED
 * node are always allocated as a contiguous run, so child traversal is a
 * single base + octant index — no per-child pointer chase.
 *
 * Octant encoding: `ox + oy*2 + oz*4`, where (ox, oy, oz) ∈ {0, 1}³ select
 * the high or low half of each axis. This matches the build's recursion order
 * so children are stored in lexicographic (Z, Y, X) octant order.
 *
 * Why per-chunk rather than one octree for the whole world: a 1024×192×1024
 * world is non-cubic (depth would be wasted on the Y axis), and voxel edits
 * already mark chunks dirty (`VoxelWorld.markDirty`). Rebuilding one chunk's
 * SVO on edit reuses the existing dirty bit; a global octree would need its
 * own change tracking.
 */

export const SVO_LEAF_AIR = 0 as const;
export const SVO_LEAF_SOLID = 1 as const;
export const SVO_MIXED = 2 as const;

export type SVOTag = typeof SVO_LEAF_AIR | typeof SVO_LEAF_SOLID | typeof SVO_MIXED;

// CHUNK = 32 → log2(32) = 5 levels of mixed nodes between root and voxel-sized leaf.
export const SVO_MAX_DEPTH = Math.log2(CHUNK) | 0;

const INITIAL_NODE_CAPACITY = 64;

export interface ChunkSVO {
  /** Per-node tag: SVO_LEAF_AIR | SVO_LEAF_SOLID | SVO_MIXED. */
  tag: Uint8Array;
  /** For SVO_LEAF_SOLID, the uniform material id. AIR leaves and MIXED nodes store 0. */
  material: Uint8Array;
  /**
   * For SVO_MIXED, the index of the first of 8 contiguous children.
   * For leaves, -1. Stored as Int32 so the -1 sentinel works without unsigned wraparound.
   */
  childrenBase: Int32Array;
  /** Tree depth. 0 at root (covers full chunk), SVO_MAX_DEPTH at single-voxel leaves. */
  level: Uint8Array;
  /** Number of slots in use; < capacity. Root is always at index 0. */
  count: number;
  /** Allocated length of the parallel arrays. */
  capacity: number;
}

export function allocateChunkSVO(): ChunkSVO {
  return {
    tag: new Uint8Array(INITIAL_NODE_CAPACITY),
    material: new Uint8Array(INITIAL_NODE_CAPACITY),
    childrenBase: new Int32Array(INITIAL_NODE_CAPACITY),
    level: new Uint8Array(INITIAL_NODE_CAPACITY),
    count: 0,
    capacity: INITIAL_NODE_CAPACITY,
  };
}

function ensureCapacity(svo: ChunkSVO, need: number): void {
  if (svo.capacity >= need) return;
  let cap = svo.capacity;
  while (cap < need) cap *= 2;
  const tag = new Uint8Array(cap);
  const material = new Uint8Array(cap);
  const childrenBase = new Int32Array(cap);
  const level = new Uint8Array(cap);
  tag.set(svo.tag);
  material.set(svo.material);
  childrenBase.set(svo.childrenBase);
  level.set(svo.level);
  svo.tag = tag;
  svo.material = material;
  svo.childrenBase = childrenBase;
  svo.level = level;
  svo.capacity = cap;
}

function alloc8Children(svo: ChunkSVO): number {
  ensureCapacity(svo, svo.count + 8);
  const base = svo.count;
  svo.count += 8;
  return base;
}

/**
 * Build (or rebuild) an SVO from the world voxel buffer for the chunk at
 * (chunkX, chunkY, chunkZ). The chunk's world-space origin is at
 * (chunkX * CHUNK, chunkY * CHUNK, chunkZ * CHUNK).
 *
 * `worldX`, `worldY`, `worldZ` are the dimensions of the underlying voxel
 * array (so the index function matches `worldIndex` from VoxelWorld).
 *
 * The SVO is rebuilt from scratch — `count` is reset to 0. Capacity is reused
 * (and grown if needed).
 */
export function buildChunkSVO(
  svo: ChunkSVO,
  voxels: Uint8Array,
  chunkX: number, chunkY: number, chunkZ: number,
  worldX: number, worldZ: number,
): void {
  svo.count = 1; // reserve root at index 0; children allocated as we recurse
  buildNode(
    svo, voxels,
    worldX, worldZ,
    chunkX * CHUNK, chunkY * CHUNK, chunkZ * CHUNK,
    CHUNK,
    0, // level
    0, // node index
  );
}

function buildNode(
  svo: ChunkSVO,
  voxels: Uint8Array,
  worldX: number, worldZ: number,
  baseX: number, baseY: number, baseZ: number,
  size: number,
  level: number,
  myIdx: number,
): void {
  // Sample the corner voxel and check whether the whole region matches it.
  // Early-exit on the first mismatch keeps the typical case (mostly-uniform
  // regions of solid ground or open air) close to O(1) per node.
  const m0 = voxels[(baseY * worldZ + baseZ) * worldX + baseX]!;
  let uniform = true;
  scan: for (let dy = 0; dy < size; dy++) {
    const yi = baseY + dy;
    for (let dz = 0; dz < size; dz++) {
      const zi = baseZ + dz;
      const rowBase = (yi * worldZ + zi) * worldX + baseX;
      for (let dx = 0; dx < size; dx++) {
        if (voxels[rowBase + dx] !== m0) {
          uniform = false;
          break scan;
        }
      }
    }
  }

  svo.level[myIdx] = level;
  if (uniform) {
    svo.tag[myIdx] = m0 === AIR ? SVO_LEAF_AIR : SVO_LEAF_SOLID;
    svo.material[myIdx] = m0;
    svo.childrenBase[myIdx] = -1;
    return;
  }

  // Mixed: reserve 8 contiguous child slots, then recurse into each.
  // We must call alloc8Children BEFORE recursing — the recursion may
  // allocate grandchildren, and grandchildren must be appended after our
  // immediate children's slots, not interleaved. The contiguous-children
  // invariant is what lets querySVO use base + octant indexing.
  const childBase = alloc8Children(svo);
  svo.tag[myIdx] = SVO_MIXED;
  svo.material[myIdx] = 0;
  svo.childrenBase[myIdx] = childBase;

  const half = size >> 1;
  for (let oz = 0; oz < 2; oz++) {
    for (let oy = 0; oy < 2; oy++) {
      for (let ox = 0; ox < 2; ox++) {
        const octant = ox + (oy << 1) + (oz << 2);
        buildNode(
          svo, voxels, worldX, worldZ,
          baseX + ox * half, baseY + oy * half, baseZ + oz * half,
          half,
          level + 1,
          childBase + octant,
        );
      }
    }
  }
}

export interface SVOLookup {
  /** SVO_LEAF_AIR or SVO_LEAF_SOLID — query always resolves to a leaf. */
  tag: number;
  /** Material id; 0 for AIR. */
  material: MaterialId;
  /** Tree depth at which the lookup resolved. 0 = whole chunk uniform; SVO_MAX_DEPTH = single voxel. */
  level: number;
  /** Edge length in voxels of the leaf the query landed in (a power of 2). */
  size: number;
  /** Internal node index of the leaf, for callers that need to attach side data (clearance, etc.). */
  nodeIdx: number;
}

/**
 * Look up the leaf at chunk-local coordinates (lx, ly, lz) ∈ [0, CHUNK).
 *
 * Walks the octree from the root, choosing the octant containing the query
 * point at each level. Returns the leaf's tag, material, depth, and edge
 * size. The node index is returned so future side-data arrays (clearance,
 * face-connectivity bits, etc.) can attach by parallel indexing.
 */
export function querySVO(svo: ChunkSVO, lx: number, ly: number, lz: number): SVOLookup {
  let i = 0;
  let size = CHUNK;
  let cx = lx, cy = ly, cz = lz;
  while (svo.tag[i]! === SVO_MIXED) {
    const half = size >> 1;
    const ox = cx >= half ? 1 : 0;
    const oy = cy >= half ? 1 : 0;
    const oz = cz >= half ? 1 : 0;
    i = svo.childrenBase[i]! + ox + (oy << 1) + (oz << 2);
    if (ox) cx -= half;
    if (oy) cy -= half;
    if (oz) cz -= half;
    size = half;
  }
  return {
    tag: svo.tag[i]!,
    material: svo.material[i]!,
    level: svo.level[i]!,
    size,
    nodeIdx: i,
  };
}

/**
 * Iterate every leaf in the SVO, depth-first. Useful for building higher-level
 * structures (clearance fields, face-adjacency graphs) and for tests.
 *
 * The visitor receives chunk-local coords of the leaf's min corner, its size
 * in voxels, the node's tag/material, and its index.
 */
export function forEachLeaf(
  svo: ChunkSVO,
  visit: (lx: number, ly: number, lz: number, size: number, tag: number, material: number, nodeIdx: number) => void,
): void {
  walkLeaves(svo, 0, 0, 0, 0, CHUNK, visit);
}

function walkLeaves(
  svo: ChunkSVO,
  i: number,
  lx: number, ly: number, lz: number,
  size: number,
  visit: (lx: number, ly: number, lz: number, size: number, tag: number, material: number, nodeIdx: number) => void,
): void {
  const tag = svo.tag[i]!;
  if (tag !== SVO_MIXED) {
    visit(lx, ly, lz, size, tag, svo.material[i]!, i);
    return;
  }
  const childBase = svo.childrenBase[i]!;
  const half = size >> 1;
  for (let oz = 0; oz < 2; oz++) {
    for (let oy = 0; oy < 2; oy++) {
      for (let ox = 0; ox < 2; ox++) {
        const octant = ox + (oy << 1) + (oz << 2);
        walkLeaves(
          svo, childBase + octant,
          lx + ox * half, ly + oy * half, lz + oz * half,
          half,
          visit,
        );
      }
    }
  }
}
