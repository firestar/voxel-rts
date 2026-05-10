import { describe, it, expect } from 'vitest';
import { CHUNK, CHUNK_VOL, localIndex, WORLD_X, WORLD_Z } from '../src/voxel/types';
import { worldIndex } from '../src/voxel/VoxelWorld';
import { WorldChunkClient } from '../src/net/WorldChunkClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wg = require('../worldgen.cjs') as {
  columnMaterials: (x: number, z: number, seed: number) => Uint8Array;
  WORLD_X: number; WORLD_Y: number; WORLD_Z: number;
};

const SEED = 1337;

/** Build a chunk-local voxel buffer (CHUNK^3 bytes) for chunk (cx, cy, cz)
 *  by sampling `columnMaterials` at every (x, z). Mirrors what
 *  `game-server.cjs:generateChunkBaseline` does for the heightmap
 *  pass — sufficient for a decoding-layer round-trip test. */
function buildChunkFromHeightmap(cx: number, cy: number, cz: number, seed: number): Uint8Array {
  const buf = new Uint8Array(CHUNK_VOL);
  const baseX = cx * CHUNK;
  const baseY = cy * CHUNK;
  const baseZ = cz * CHUNK;
  for (let lz = 0; lz < CHUNK; lz++) {
    const z = baseZ + lz;
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = baseX + lx;
      const column = wg.columnMaterials(x, z, seed);
      for (let ly = 0; ly < CHUNK; ly++) {
        const y = baseY + ly;
        buf[localIndex(lx, ly, lz)] = column[y]!;
      }
    }
  }
  return buf;
}

describe('WorldChunkClient.diffAgainstWorld', () => {
  it('reports null when the chunk matches the world buffer', () => {
    const cx = 48, cy = 3, cz = 48;
    const chunkBuf = buildChunkFromHeightmap(cx, cy, cz, SEED);
    // Build a sparse world buffer just covering this chunk's voxels.
    // Allocating the full WORLD_X*WORLD_Y*WORLD_Z (1.5 GB) would OOM
    // the test runner, so we hand `diffAgainstWorld` a typed-array
    // backed proxy that maps `worldIndex(x, y, z)` reads to chunkBuf.
    const baseX = cx * CHUNK, baseY = cy * CHUNK, baseZ = cz * CHUNK;
    const worldVoxels = new Proxy(new Uint8Array(0), {
      get(_t, prop) {
        const idx = Number(prop);
        if (!Number.isInteger(idx)) return Reflect.get(_t, prop);
        // Decode worldIndex back to (x, y, z); only valid inside the chunk.
        const x = idx % WORLD_X;
        const xz = (idx - x) / WORLD_X;
        const z = xz % WORLD_Z;
        const y = (xz - z) / WORLD_Z;
        const lx = x - baseX, ly = y - baseY, lz = z - baseZ;
        if (lx < 0 || lx >= CHUNK || ly < 0 || ly >= CHUNK || lz < 0 || lz >= CHUNK) return 0;
        return chunkBuf[localIndex(lx, ly, lz)];
      },
    }) as unknown as Uint8Array;
    const diff = WorldChunkClient.diffAgainstWorld(
      { cx, cy, cz, voxels: chunkBuf, worldSeed: SEED, voxelEditSeq: 0 },
      worldVoxels,
    );
    expect(diff).toBeNull();
  });

  it('pinpoints the first differing voxel', () => {
    const cx = 48, cy = 3, cz = 48;
    const chunkBuf = buildChunkFromHeightmap(cx, cy, cz, SEED);
    const baseX = cx * CHUNK, baseY = cy * CHUNK, baseZ = cz * CHUNK;
    // Same proxy as above, but flip ONE voxel so the diff has something to find.
    const targetLx = 5, targetLy = 7, targetLz = 11;
    const targetIdx = worldIndex(baseX + targetLx, baseY + targetLy, baseZ + targetLz);
    const flipped = chunkBuf[localIndex(targetLx, targetLy, targetLz)]! ^ 0xff;
    const worldVoxels = new Proxy(new Uint8Array(0), {
      get(_t, prop) {
        const idx = Number(prop);
        if (!Number.isInteger(idx)) return Reflect.get(_t, prop);
        if (idx === targetIdx) return flipped;
        const x = idx % WORLD_X;
        const xz = (idx - x) / WORLD_X;
        const z = xz % WORLD_Z;
        const y = (xz - z) / WORLD_Z;
        const lx = x - baseX, ly = y - baseY, lz = z - baseZ;
        if (lx < 0 || lx >= CHUNK || ly < 0 || ly >= CHUNK || lz < 0 || lz >= CHUNK) return 0;
        return chunkBuf[localIndex(lx, ly, lz)];
      },
    }) as unknown as Uint8Array;
    const diff = WorldChunkClient.diffAgainstWorld(
      { cx, cy, cz, voxels: chunkBuf, worldSeed: SEED, voxelEditSeq: 0 },
      worldVoxels,
    );
    expect(diff).not.toBeNull();
    expect(diff!.lx).toBe(targetLx);
    expect(diff!.ly).toBe(targetLy);
    expect(diff!.lz).toBe(targetLz);
    expect(diff!.expected).toBe(flipped);
    expect(diff!.got).toBe(chunkBuf[localIndex(targetLx, targetLy, targetLz)]);
  });
});
