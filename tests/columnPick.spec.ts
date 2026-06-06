import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT } from '../src/voxel/Materials';
import { raycastVoxel, pickColumnBelowCut } from '../src/voxel/Raycast';

/**
 * Y-cutoff "nearest visible Y" move pick (pickColumnBelowCut).
 *
 * When the player views an underground slice via the Y-cutoff and left-clicks
 * to move a unit, the destination should be the column DIRECTLY under the
 * cursor on that slice — not wherever the camera's angled ray exits the
 * terrain. We build a solid patch with a narrow vertical shaft punched down
 * under the cursor's plane-crossing XZ, then compare the column pick against a
 * plain angled raycast.
 */
describe('pickColumnBelowCut — Y-cutoff vertical move pick', () => {
  const planeY = 8;                              // cut plane, meters
  const maxVoxelY = Math.floor(planeY / VOXEL_SIZE); // 64 — voxels >= this read AIR
  // Camera ray: above the terrain, angled 45° down toward +X (dir.z = 0).
  const origin = { x: 13, y: 20, z: 25 };
  const inv2 = 1 / Math.sqrt(2);
  const dir = { x: inv2, y: -inv2, z: 0 };
  // Where the ray crosses the cut plane → the XZ the cursor points at.
  const t = (planeY - origin.y) / dir.y;
  const crossX = origin.x + dir.x * t;           // ≈ 25 m
  const crossZ = origin.z + dir.z * t;           // 25 m
  const vpx = Math.floor(crossX / VOXEL_SIZE);   // ≈ 200
  const vpz = Math.floor(crossZ / VOXEL_SIZE);   // 200

  function world(): VoxelWorld {
    const w = VoxelWorld.create(false);
    const v = w.buffers.voxels;
    // Solid dirt patch, top at voxel y=100.
    for (let x = vpx - 24; x <= vpx + 24; x++) {
      for (let z = vpz - 24; z <= vpz + 24; z++) {
        for (let y = 0; y <= 100; y++) v[worldIndex(x, y, z)] = M_DIRT;
      }
    }
    return w;
  }

  it('drills the vertical shaft under the cursor while the angled ray exits to the wall', () => {
    const w = world();
    const v = w.buffers.voxels;
    // Punch a narrow shaft (x in [vpx, vpx+1]) down to a floor at voxel y=40.
    for (let x = vpx; x <= vpx + 1; x++) {
      for (let z = vpz - 1; z <= vpz + 1; z++) {
        for (let y = 41; y <= 100; y++) v[worldIndex(x, y, z)] = 0; // AIR
      }
    }

    const col = pickColumnBelowCut(w, origin, dir, planeY, maxVoxelY);
    expect(col).not.toBeNull();
    // Lands at the cursor's XZ, on the shaft floor (the nearest visible surface
    // straight down from the click).
    expect(col!.x).toBe(vpx);
    expect(col!.z).toBe(vpz);
    expect(col!.y).toBe(40);

    // The plain angled raycast diverges: it threads out of the narrow shaft and
    // hits the solid wall — a shallower Y, offset in X — i.e. NOT under cursor.
    const angled = raycastVoxel(w, origin, dir, 400, maxVoxelY);
    expect(angled).not.toBeNull();
    expect(angled!.x).toBeGreaterThan(vpx);
    expect(angled!.y).toBeGreaterThan(col!.y);
  });

  it('finds the top visible layer when the column is solid (no shaft)', () => {
    const w = world(); // solid to voxel 100, cut at voxel 64
    const col = pickColumnBelowCut(w, origin, dir, planeY, maxVoxelY);
    expect(col).not.toBeNull();
    expect(col!.x).toBe(vpx);
    expect(col!.z).toBe(vpz);
    // Topmost voxel still visible under the cut is maxVoxelY - 1.
    expect(col!.y).toBe(maxVoxelY - 1);
  });

  it('returns null when the column under the cursor is empty (caller falls back)', () => {
    const w = VoxelWorld.create(false); // all air
    expect(pickColumnBelowCut(w, origin, dir, planeY, maxVoxelY)).toBeNull();
  });

  it('returns null when not looking down through the plane', () => {
    const w = world();
    const up = { x: inv2, y: inv2, z: 0 };        // looking upward
    expect(pickColumnBelowCut(w, origin, up, planeY, maxVoxelY)).toBeNull();
    const horizontal = { x: 1, y: 0, z: 0 };
    expect(pickColumnBelowCut(w, origin, horizontal, planeY, maxVoxelY)).toBeNull();
  });
});
