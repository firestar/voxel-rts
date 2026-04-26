import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT } from '../src/voxel/Materials';
import {
  TUNNELER_CUTTER_RADIUS,
  TUNNELER_CUTTER_FORWARD,
  TUNNELER_CUTTER_HEIGHT,
} from '../src/render/UnitModels';

/**
 * Black-box test for the cutter carve.
 *
 * We fill a rectangular slab of dirt centred on a known Y, then simulate the tunneler's
 * per-frame carve at advancing positions along +X. The carve cylinder is what `Game.handleCarve`
 * dispatches when CarveRequest.axisX is set, so we hit the same primitive the runtime uses.
 *
 * After driving the cutter all the way across the slab, no voxel within the swept disc
 * cross-section may remain solid — that's the "rows of uncut land" regression.
 */
describe('tunneler carve covers a continuous tube', () => {
  it('clears every voxel inside the cutter cross-section at every step', () => {
    const world = VoxelWorld.create(false);
    const voxels = world.buffers.voxels;

    // Fill a thick slab of dirt running along +X at a known Y/Z position.
    const startX = 100;
    const endX = 220; // 120 voxels = 15 m of forward dig
    const cy = 96;     // matches the surface-ish Y from worldgen defaults
    const cz = 200;
    // Slab dimensions: enough to surround the cutter on all sides
    const slabHalfY = 16;
    const slabHalfZ = 16;
    for (let x = startX; x <= endX; x++) {
      for (let y = cy - slabHalfY; y <= cy + slabHalfY; y++) {
        for (let z = cz - slabHalfZ; z <= cz + slabHalfZ; z++) {
          voxels[worldIndex(x, y, z)] = M_DIRT;
        }
      }
    }

    // The tunneler's "world" position in metres — feet at the cutter-height-below offset.
    // Forward direction is +X (axisX = 1).
    const fx = 1, fy = 0, fz = 0;
    const halfLength = VOXEL_SIZE * 2;             // 4 voxels deep total
    const radius = TUNNELER_CUTTER_RADIUS + VOXEL_SIZE * 3; // 3-voxel side clearance
    const centerForward = TUNNELER_CUTTER_FORWARD + halfLength;

    // The tunneler's feet Y in metres so the cutter centre lands at (cy + 0.5) voxels.
    // cutterY (m) = u.y + TUNNELER_CUTTER_HEIGHT  →  u.y = (cy + 0.5) * VOXEL_SIZE - HEIGHT.
    const uy = (cy + 0.5) * VOXEL_SIZE - TUNNELER_CUTTER_HEIGHT;
    const uz = (cz + 0.5) * VOXEL_SIZE;

    // Step the cutter in fine increments (well under the carve's 2-voxel depth) so no
    // single advance can outrun the carve.
    const stepM = 0.1; // 0.8 voxels — same order as the runtime per-frame advance
    const totalForwardM = (endX - startX) * VOXEL_SIZE; // metres
    const startUx = (startX + 0.5) * VOXEL_SIZE - TUNNELER_CUTTER_FORWARD;
    const endUx = startUx + totalForwardM;

    for (let ux = startUx; ux <= endUx + stepM; ux += stepM) {
      const cutterX = ux + fx * centerForward;
      const cutterY = uy + TUNNELER_CUTTER_HEIGHT + fy * centerForward;
      const cutterZ = uz + fz * centerForward;
      world.damageOrientedCylinder(
        cutterX / VOXEL_SIZE,
        cutterY / VOXEL_SIZE,
        cutterZ / VOXEL_SIZE,
        fx, fy, fz,
        halfLength / VOXEL_SIZE,
        radius / VOXEL_SIZE,
        250,
      );
    }

    // Audit a thin strip down the centre of the swept tunnel: every voxel within 60% of
    // the cutter radius perpendicular to motion must now be air. (60% of 1.825 m ≈ 1.1 m
    // — well inside the carved cross-section, so this excludes any sphere-edge fuzz.)
    const auditRadiusVoxels = (TUNNELER_CUTTER_RADIUS * 0.6) / VOXEL_SIZE;
    let solidsLeft = 0;
    let cleared = 0;
    for (let x = startX + 4; x <= endX - 4; x++) { // exclude the two caps
      for (let dy = -auditRadiusVoxels; dy <= auditRadiusVoxels; dy++) {
        for (let dz = -auditRadiusVoxels; dz <= auditRadiusVoxels; dz++) {
          if (dy * dy + dz * dz > auditRadiusVoxels * auditRadiusVoxels) continue;
          const y = cy + Math.round(dy);
          const z = cz + Math.round(dz);
          const idx = worldIndex(x, y, z);
          if (voxels[idx] === M_DIRT) solidsLeft++;
          else cleared++;
        }
      }
    }
    expect(solidsLeft).toBe(0);
    expect(cleared).toBeGreaterThan(0);
  });

  it('leaves voxels far outside the cutter radius alone', () => {
    const world = VoxelWorld.create(false);
    const voxels = world.buffers.voxels;
    // Fill a region with dirt that extends comfortably past the outer edge of the carve.
    const cy = 96, cz = 200;
    const carveRadiusVox = (TUNNELER_CUTTER_RADIUS + VOXEL_SIZE * 3) / VOXEL_SIZE;
    const farRadiusVox = Math.ceil(carveRadiusVox) + 4; // a few voxels past the outer edge
    for (let x = 100; x <= 200; x++) {
      for (let y = cy - farRadiusVox - 4; y <= cy + farRadiusVox + 4; y++) {
        for (let z = cz - farRadiusVox - 4; z <= cz + farRadiusVox + 4; z++) {
          voxels[worldIndex(x, y, z)] = M_DIRT;
        }
      }
    }

    // Run a single carve at the slab's centre.
    const cutterY = (cy + 0.5);
    const cutterZ = (cz + 0.5);
    const cutterX = 150;
    world.damageOrientedCylinder(
      cutterX, cutterY, cutterZ,
      1, 0, 0,
      (VOXEL_SIZE * 2) / VOXEL_SIZE,            // 4-voxel total depth
      carveRadiusVox,
      250,
    );

    // A voxel that is FAR perpendicular from the cutter axis must be untouched.
    const farY = cy + farRadiusVox;
    const farZ = cz;
    expect(voxels[worldIndex(cutterX, farY, farZ)]).toBe(M_DIRT);
  });
});

void WORLD_X; void WORLD_Y; void WORLD_Z;
