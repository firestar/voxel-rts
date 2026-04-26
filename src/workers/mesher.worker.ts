/// <reference lib="webworker" />
import { WORLD_X, WORLD_Y, WORLD_Z, CHUNK, chunkKey } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { MATERIALS } from '../voxel/Materials';

interface MeshRequest {
  voxels: Uint8Array;
  version: Int32Array;
  cx: number; cy: number; cz: number;
  reqId: number;
}

interface MeshResponse {
  reqId: number;
  cx: number; cy: number; cz: number;
  positions: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  version: number;
}

self.onmessage = (ev: MessageEvent<MeshRequest>) => {
  const out = mesh(ev.data);
  (self as unknown as Worker).postMessage(out, {
    transfer: [out.positions.buffer, out.colors.buffer, out.indices.buffer],
  });
};

function getVoxel(voxels: Uint8Array, x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return 0;
  return voxels[worldIndex(x, y, z)]!;
}

// Six face directions, each with: normal, the 2 in-plane axes (a1, a2), and the offset to the
// "outside" voxel from the meshed voxel's min corner.
//
// Corner index ∈ 0..3 is encoded as (b1, b2) where b1 = corner&1 (axis a1), b2 = (corner>>1)&1 (axis a2).
// Vertex world position = voxelMin + faceOriginOffset + b1*a1Unit + b2*a2Unit.
//
// AO occluders for each corner: three outside-layer voxels:
//   side1 at outsideVoxel + (b1?+1:-1)*a1
//   side2 at outsideVoxel + (b2?+1:-1)*a2
//   corner at outsideVoxel + (b1?+1:-1)*a1 + (b2?+1:-1)*a2
//
// outsideVoxel = the voxel adjacent across the face (already known to be air).

interface FaceDef {
  nx: number; ny: number; nz: number;        // outside neighbor offset
  a1x: number; a1y: number; a1z: number;     // tangent axis 1
  a2x: number; a2y: number; a2z: number;     // tangent axis 2
  ox: number; oy: number; oz: number;        // face origin offset from voxel min (one corner of the quad)
  flipWinding: boolean;                      // for back-faces
}

const FACES: FaceDef[] = [
  // +X: outside at +x; tangents +Y, +Z; origin at (1,0,0)
  { nx:  1, ny: 0, nz: 0, a1x: 0, a1y: 1, a1z: 0, a2x: 0, a2y: 0, a2z: 1, ox: 1, oy: 0, oz: 0, flipWinding: false },
  // -X: outside at -x; tangents +Z, +Y (swap so winding faces -X); origin at (0,0,1)... we instead use (a1=+Z, a2=+Y) and flipWinding=false
  { nx: -1, ny: 0, nz: 0, a1x: 0, a1y: 0, a1z: 1, a2x: 0, a2y: 1, a2z: 0, ox: 0, oy: 0, oz: 0, flipWinding: false },
  // +Y: outside at +y; tangents +X, +Z (so winding via right-hand rule faces +Y); origin (0,1,0)
  { nx: 0, ny:  1, nz: 0, a1x: 1, a1y: 0, a1z: 0, a2x: 0, a2y: 0, a2z: 1, ox: 0, oy: 1, oz: 0, flipWinding: true },
  // -Y: outside at -y; tangents +X, +Z; origin (0,0,0)
  { nx: 0, ny: -1, nz: 0, a1x: 1, a1y: 0, a1z: 0, a2x: 0, a2y: 0, a2z: 1, ox: 0, oy: 0, oz: 0, flipWinding: false },
  // +Z: outside at +z; tangents +Y, +X; origin (0,0,1).
  // With this (a1, a2) order the natural quad winding cross-products to -Z, so flip
  // it to put the outward normal back at +Z. Same fix for -Z below.
  { nx: 0, ny: 0, nz:  1, a1x: 0, a1y: 1, a1z: 0, a2x: 1, a2y: 0, a2z: 0, ox: 0, oy: 0, oz: 1, flipWinding: true },
  // -Z: outside at -z; tangents +X, +Y; origin (0,0,0)
  { nx: 0, ny: 0, nz: -1, a1x: 1, a1y: 0, a1z: 0, a2x: 0, a2y: 1, a2z: 0, ox: 0, oy: 0, oz: 0, flipWinding: true },
];

function aoScore(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
}

function mesh(req: MeshRequest): MeshResponse {
  const { voxels, version, cx, cy, cz, reqId } = req;
  const x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vbase = 0;

  for (let ly = 0; ly < CHUNK; ly++) {
    const wy = y0 + ly;
    for (let lz = 0; lz < CHUNK; lz++) {
      const wz = z0 + lz;
      for (let lx = 0; lx < CHUNK; lx++) {
        const wx = x0 + lx;
        const m = getVoxel(voxels, wx, wy, wz);
        if (m === 0) continue;
        const mat = MATERIALS[m]!;
        const r = mat.r, g = mat.g, b = mat.b;

        for (let f = 0; f < 6; f++) {
          const fd = FACES[f]!;
          if (getVoxel(voxels, wx + fd.nx, wy + fd.ny, wz + fd.nz) !== 0) continue;

          // Outside voxel coords (used as base for AO sampling).
          const ox = wx + fd.nx, oy = wy + fd.ny, oz = wz + fd.nz;

          // Compute 4 corners: (b1, b2) ∈ {0,1}^2.
          const aoArr = [0, 0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const b1 = c & 1;
            const b2 = (c >> 1) & 1;
            const s1 = b1 ? 1 : -1;
            const s2 = b2 ? 1 : -1;
            const px = wx + fd.ox + b1 * fd.a1x + b2 * fd.a2x;
            const py = wy + fd.oy + b1 * fd.a1y + b2 * fd.a2y;
            const pz = wz + fd.oz + b1 * fd.a1z + b2 * fd.a2z;

            const sd1 = getVoxel(voxels, ox + s1 * fd.a1x, oy + s1 * fd.a1y, oz + s1 * fd.a1z) !== 0;
            const sd2 = getVoxel(voxels, ox + s2 * fd.a2x, oy + s2 * fd.a2y, oz + s2 * fd.a2z) !== 0;
            const cor = getVoxel(
              voxels,
              ox + s1 * fd.a1x + s2 * fd.a2x,
              oy + s1 * fd.a1y + s2 * fd.a2y,
              oz + s1 * fd.a1z + s2 * fd.a2z,
            ) !== 0;
            const a = aoScore(sd1, sd2, cor); // 0..3
            aoArr[c] = a;
            const aoByte = 90 + a * 55; // 90, 145, 200, 255
            positions.push(px, py, pz);
            colors.push(r, g, b, aoByte);
          }

          // Quad corners ordered as (0,1,3,2) → forms a CCW quad around the face.
          // Indices: 0,1,3 then 0,3,2 (or flipped). Choose diagonal that minimizes AO anisotropy.
          const a00 = aoArr[0]!, a10 = aoArr[1]!, a01 = aoArr[2]!, a11 = aoArr[3]!;
          const flipDiagonal = (a00 + a11) < (a10 + a01);
          const i0 = vbase + 0, i1 = vbase + 1, i2 = vbase + 3, i3 = vbase + 2;
          // i0=B00, i1=B10, i2=B11, i3=B01
          if (fd.flipWinding) {
            if (flipDiagonal) {
              indices.push(i0, i2, i1,  i0, i3, i2);
            } else {
              indices.push(i0, i3, i1,  i1, i3, i2);
            }
          } else {
            if (flipDiagonal) {
              indices.push(i0, i1, i2,  i0, i2, i3);
            } else {
              indices.push(i1, i2, i3,  i1, i3, i0);
            }
          }
          vbase += 4;
        }
      }
    }
  }

  return {
    reqId,
    cx, cy, cz,
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    indices: new Uint32Array(indices),
    version: Atomics.load(version, chunkKey(cx, cy, cz)),
  };
}

export {};
