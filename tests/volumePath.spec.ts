import { describe, it, expect } from 'vitest';
import { allocateVolumeNav, buildVolumeNav, VNAV_Y } from '../src/path/VolumeNav';
import { findPathVolume, AStar3DWorkspace } from '../src/path/AStar3D';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_STONE, M_BEDROCK } from '../src/voxel/Materials';

/**
 * The volume nav grid uses 1m cells (8 voxels per side). With WORLD_Y=192 voxels that
 * gives VNAV_Y = 24 cell-layers. So all volume cy coordinates in tests must be < 24.
 */
function buildSolidWorld(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  // Bedrock at y=0,1; stone everywhere else up through cell-layer 14 (voxel y < 120).
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < 120; y++) v[worldIndex(x, y, z)] = M_STONE;
    }
  }
  return world;
}

describe('volume A*', () => {
  it('refuses solid stone for non-diggers; lets diggers through', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const ws = new AStar3DWorkspace();

    // Both start and goal are inside solid stone (cy in 1..14).
    const startCx = 30, startCy = 8, startCz = 30;
    const goalCx = 35, goalCy = 8, goalCz = 30;

    const tankReq = {
      startCx, startCy, startCz,
      goalCx, goalCy, goalCz,
      canDig: false, requiresGround: false, footprintRadius: 1,
    };
    const tankR = findPathVolume(vnav, ws, tankReq);
    expect(tankR.reached).toBe(false); // can't punch through stone

    const tunR = findPathVolume(vnav, ws, { ...tankReq, canDig: true });
    expect(tunR.reached).toBe(true);
    expect(tunR.cells.length).toBeGreaterThan(0);
    // First cell == start, last == goal.
    expect(tunR.cells[0]).toEqual({ cx: startCx, cy: startCy, cz: startCz });
    const last = tunR.cells[tunR.cells.length - 1]!;
    expect(last).toEqual({ cx: goalCx, cy: goalCy, cz: goalCz });
  });

  it('routes through air cells for non-diggers', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const ws = new AStar3DWorkspace();

    // cy 16+ are entirely above the stone fill — pure air.
    const r = findPathVolume(vnav, ws, {
      startCx: 30, startCy: 16, startCz: 30,
      goalCx: 35,  goalCy: 16, goalCz: 30,
      canDig: false, requiresGround: false, footprintRadius: 1,
    });
    expect(r.reached).toBe(true);
  });

  it('rejects pure-vertical edges when maxPitchRad is set below 90°', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const ws = new AStar3DWorkspace();

    // Tunneler asked to dig straight up: start and goal share XZ. With maxPitchRad=π/4
    // every NB26 edge with horizontal=0 is rejected, so the path can't be a stack of
    // pure-vertical cells. The result is either unreachable (only pure-vertical works)
    // or a path with ALL stepping edges having horizontal motion.
    const r = findPathVolume(vnav, ws, {
      startCx: 40, startCy: 4, startCz: 40,
      goalCx:  40, goalCy: 14, goalCz: 40,
      canDig: true, requiresGround: false, footprintRadius: 1,
      maxPitchRad: Math.PI / 4,
    });
    for (let i = 1; i < r.cells.length; i++) {
      const a = r.cells[i - 1]!;
      const b = r.cells[i]!;
      const dy = Math.abs(b.cy - a.cy);
      const horiz = Math.hypot(b.cx - a.cx, b.cz - a.cz);
      if (dy > 0) expect(horiz).toBeGreaterThan(0);
    }
  });

  it('with no maxPitchRad set, vertical climbs ARE allowed', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    const ws = new AStar3DWorkspace();

    const r = findPathVolume(vnav, ws, {
      startCx: 40, startCy: 4, startCz: 40,
      goalCx:  40, goalCy: 12, goalCz: 40,
      canDig: true, requiresGround: false, footprintRadius: 1,
    });
    expect(r.reached).toBe(true);
    expect(r.cells.length).toBeGreaterThanOrEqual(8); // 8 cells of vertical climb
  });
});

/**
 * Regression test for the tunneler's straight-line shortcut. Game.tunnelerCanGoStraight
 * is the gate; we replicate its logic locally to verify the rule on a clean world.
 */
function tunnelerStraightOk(
  vnav: ReturnType<typeof allocateVolumeNav>,
  start: { x: number; y: number; z: number },
  goal: { x: number; y: number; z: number },
  maxPitchRad: number,
): boolean {
  const dx = goal.x - start.x, dy = goal.y - start.y, dz = goal.z - start.z;
  const horiz = Math.hypot(dx, dz);
  const pitch = horiz < 1e-4 ? Math.PI / 2 : Math.atan2(Math.abs(dy), horiz);
  if (pitch > maxPitchRad) return false;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-3) return true;
  const steps = Math.max(1, Math.ceil(dist));
  let lastIdx = -1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sx = start.x + dx * t;
    const sy = start.y + dy * t;
    const sz = start.z + dz * t;
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    const cz = Math.floor(sz);
    const idx = (cy * 96 + cz) * 96 + cx; // VNAV_X/Z = 96 — must match VolumeNav.ts
    if (idx === lastIdx) continue;
    lastIdx = idx;
    const bit = (vnav.bedrock[idx >> 3]! >> (idx & 7)) & 1;
    if (bit) return false;
  }
  return true;
}

describe('tunneler straight-line shortcut', () => {
  it('horizontal direct path through stone is valid', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    expect(tunnelerStraightOk(vnav, { x: 30, y: 8, z: 30 }, { x: 50, y: 8, z: 30 }, Math.PI / 4)).toBe(true);
  });

  it('rejects a steeper-than-max-pitch line', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    // start and goal share xz, only y differs — vertical line, infinite pitch
    expect(tunnelerStraightOk(vnav, { x: 30, y: 8, z: 30 }, { x: 30, y: 18, z: 30 }, Math.PI / 4)).toBe(false);
  });

  it('rejects a line crossing a bedrock cell', () => {
    const world = buildSolidWorld();
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(world.buffers.voxels, vnav);
    // bedrock layer is at cy=0 (voxels y=0,1). A line from cy=2 to cy=2 stays clear
    // even crossing solid stone (canDig handles that). A line that dips through cy=0
    // should be rejected because of the bedrock bit.
    expect(tunnelerStraightOk(vnav, { x: 10, y: 2.5, z: 10 }, { x: 30, y: 0.5, z: 30 }, Math.PI / 2)).toBe(false);
  });
});

void VNAV_Y;
