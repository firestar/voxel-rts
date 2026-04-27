import { describe, it, expect } from 'vitest';
import { allocateVolumeNav, buildVolumeNav, VNAV_X, VNAV_Y, vnavIndex, getBit } from '../src/path/VolumeNav';
import { findPathVolume, AStar3DWorkspace } from '../src/path/AStar3D';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_BEDROCK, M_STONE, M_DIRT } from '../src/voxel/Materials';

/**
 * A solid-stone hill with a horizontal air tunnel cutting through it. Every
 * column above the tunnel stays solid so the surface nav still reads as
 * blocked overhead, but the volume nav has a clean air channel through the
 * stone with a stone floor and ceiling.
 *
 * Tunnel: y in [80, 87] (8 voxels, one volume cell tall). Floor below at
 * y=79 (stone). Stone everywhere else up to y=120.
 */
function buildTunnelWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < 120; y++) v[worldIndex(x, y, z)] = M_STONE;
      v[worldIndex(x, 120, z)] = M_DIRT;
    }
  }
  // Carve a horizontal tunnel: a 1m-wide air channel along the +X axis from
  // x=20 to x=80 at the cell-row z=64 (cell coords) and y around the cell
  // layer cy=10 (voxel y 80..87). Walking floor sits at voxel y=79.
  for (let z = 64 * 8; z < 65 * 8; z++) {
    for (let x = 20 * 8; x < 80 * 8; x++) {
      for (let y = 80; y <= 87; y++) {
        v[worldIndex(x, y, z)] = 0; // AIR
      }
    }
  }
  return world;
}

describe('tunnel pathing for non-digger units', () => {
  it('a non-digger walking through an existing tunnel finds an air-cell path', () => {
    const world = buildTunnelWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const ws = new AStar3DWorkspace();

    // Sanity: the tunnel cells are air and have a solid floor underneath.
    const tunnelCy = 10; // voxel y 80..87
    expect(getBit(vnav.solid, vnavIndex(40, tunnelCy, 64))).toBe(0);
    expect(getBit(vnav.solid, vnavIndex(40, tunnelCy - 1, 64))).toBe(1);

    // A non-digger soldier routes from one end of the tunnel to the other.
    const r = findPathVolume(vnav, ws, {
      startCx: 22, startCy: tunnelCy, startCz: 64,
      goalCx: 78, goalCy: tunnelCy, goalCz: 64,
      canDig: false, requiresGround: true, footprintRadius: 1,
    });
    expect(r.reached).toBe(true);
    expect(r.cells.length).toBeGreaterThan(0);
    // Every cell on the path must sit in the tunnel cell-row (cz=64) and
    // not punch into a solid voxel.
    for (const c of r.cells) {
      expect(getBit(vnav.solid, vnavIndex(c.cx, c.cy, c.cz))).toBe(0);
    }
  });

  it('without a tunnel, a non-digger can\'t cross a solid stone hill', () => {
    const world = buildTunnelWorld();
    const v = world.buffers.voxels;
    // Re-fill the tunnel so the route is now blocked stone.
    for (let z = 64 * 8; z < 65 * 8; z++) {
      for (let x = 20 * 8; x < 80 * 8; x++) {
        for (let y = 80; y <= 87; y++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(v, vnav);
    const ws = new AStar3DWorkspace();
    const r = findPathVolume(vnav, ws, {
      startCx: 22, startCy: 10, startCz: 64,
      goalCx: 78, goalCy: 10, goalCz: 64,
      canDig: false, requiresGround: true, footprintRadius: 1,
    });
    // Non-digger refuses to enter any solid cell, so the path search should
    // not find a route — start and goal are inside solid stone now.
    expect(r.reached).toBe(false);
  });
});

void VNAV_X;
void VNAV_Y;
