import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR, VOXEL_SIZE } from '../src/voxel/types';
import { M_DIRT, M_GRASS, M_BEDROCK } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav } from '../src/path/VolumeNav';
import { UnitManager, LevelRequest } from '../src/sim/Units';

/**
 * Helper: build a flat dirt slab + grass cap at slabY (voxel space). All other voxels
 * are AIR (above) or bedrock (y=0,1) so columns terminate cleanly when scanning down.
 */
function buildSlabWorld(slabY: number): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      v[worldIndex(x, 1, z)] = M_BEDROCK;
      for (let y = 2; y < slabY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, slabY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('VoxelWorld.editColumnToY', () => {
  it('cuts voxels above target and fills air below target up to the first solid', () => {
    const slabY = 80;
    const world = buildSlabWorld(slabY);
    const v = world.buffers.voxels;
    // Hill column: 3 voxels of dirt above slabY at (100, 100).
    for (let dy = 1; dy <= 3; dy++) v[worldIndex(100, slabY + dy, 100)] = M_DIRT;
    // Pit column: scoop two voxels out of the slab top at (101, 100).
    v[worldIndex(101, slabY, 100)] = AIR;
    v[worldIndex(101, slabY - 1, 100)] = AIR;

    const r1 = world.editColumnToY(100, 100, slabY, M_DIRT);
    const r2 = world.editColumnToY(101, 100, slabY, M_DIRT);

    expect(r1.cut).toBe(3);
    expect(r1.filled).toBe(0);
    expect(r2.cut).toBe(0);
    expect(r2.filled).toBe(2);
    // Hill is gone.
    for (let dy = 1; dy <= 3; dy++) {
      expect(v[worldIndex(100, slabY + dy, 100)]).toBe(AIR);
    }
    // Pit is filled with M_DIRT (the existing grass cap was AIR, so it's overwritten with dirt).
    expect(v[worldIndex(101, slabY, 100)]).toBe(M_DIRT);
    expect(v[worldIndex(101, slabY - 1, 100)]).toBe(M_DIRT);
  });

  it('preserves bedrock when cutting above target', () => {
    const world = VoxelWorld.create(false);
    const v = world.buffers.voxels;
    v[worldIndex(50, 5, 50)] = M_BEDROCK;
    v[worldIndex(50, 6, 50)] = M_DIRT;
    const r = world.editColumnToY(50, 50, 4, M_DIRT);
    expect(r.cut).toBe(1);
    expect(v[worldIndex(50, 5, 50)]).toBe(M_BEDROCK);
    expect(v[worldIndex(50, 6, 50)]).toBe(AIR);
  });

  it('fills nothing when target is already at the column top', () => {
    const slabY = 50;
    const world = buildSlabWorld(slabY);
    const r = world.editColumnToY(100, 100, slabY, M_DIRT);
    expect(r.cut).toBe(0);
    expect(r.filled).toBe(0);
  });
});

describe('Dozer levelling integration', () => {
  it('a moving dozer with levelTargetY emits LevelRequests that flatten its strip', () => {
    const slabY = 80;
    const world = buildSlabWorld(slabY);
    const voxels = world.buffers.voxels;

    // Build a 4-voxel-tall hill in a 16x16 voxel patch in front of the dozer.
    const hillOriginX = 200;
    const hillOriginZ = 200;
    const hillExtent = 16;
    for (let dz = 0; dz < hillExtent; dz++) {
      for (let dx = 0; dx < hillExtent; dx++) {
        for (let dy = 1; dy <= 4; dy++) {
          voxels[worldIndex(hillOriginX + dx, slabY + dy, hillOriginZ + dz)] = M_DIRT;
        }
      }
    }

    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    // Place the dozer just before the hill, facing -Z (default heading 0).
    const startVx = hillOriginX + 8;        // middle of the hill in X
    const startVz = hillOriginZ + hillExtent + 12;  // start a bit past the hill on +Z
    const u = um.spawn(
      'dozer',
      (startVx + 0.5) * VOXEL_SIZE,
      (slabY + 1) * VOXEL_SIZE,
      (startVz + 0.5) * VOXEL_SIZE,
    );
    // Target: same X/Z as start but well past the hill. Forward = -Z so the
    // dozer drives toward smaller Z.
    const goalVz = hillOriginZ - 12;
    um.setPath(u, [{
      x: (startVx + 0.5) * VOXEL_SIZE,
      y: (slabY + 1) * VOXEL_SIZE,
      z: (goalVz + 0.5) * VOXEL_SIZE,
    }]);
    // Click target voxel y is the slab top voxel itself — every voxel STRICTLY
    // above that y becomes AIR; the slab cap stays put.
    u.levelTargetY = slabY;

    // Drive the dozer. Each tick we capture LevelRequests and apply them by
    // walking voxel columns inside the rectangle, just like Game.handleLevel.
    let totalLevelRequests = 0;
    let totalCut = 0;
    let totalFilled = 0;
    const dt = 1 / 60;
    for (let frame = 0; frame < 600; frame++) {
      um.tick(dt, nav, vnav, voxels, (req) => {
        if (req.kind !== 'level') return;
        totalLevelRequests++;
        const r = applyLevel(world, req);
        totalCut += r.cut;
        totalFilled += r.filled;
      });
      if (u.path.length === 0) break;
    }

    // Sanity: the dozer actually emitted level requests while moving.
    expect(totalLevelRequests).toBeGreaterThan(20);
    // Sanity: it did real cutting (the hill was 4*16*16 = 1024 voxels of dirt
    // above target — every voxel the strip swept through should have been cut).
    expect(totalCut).toBeGreaterThan(100);

    // Audit: every voxel of the original hill that lies within ±1 m of the
    // dozer's centerline should now be AIR. The strip is 1.6 m half-width =
    // 12.8 voxels; sample a slightly conservative 8 voxels each side of the
    // line so we don't fight blade-edge fuzz.
    const auditHalf = 8;
    let solidsLeft = 0;
    for (let dz = 0; dz < hillExtent; dz++) {
      for (let ddx = -auditHalf; ddx <= auditHalf; ddx++) {
        const vx = startVx + ddx;
        const vz = hillOriginZ + dz;
        for (let dy = 1; dy <= 4; dy++) {
          if (voxels[worldIndex(vx, slabY + dy, vz)] === M_DIRT) solidsLeft++;
        }
      }
    }
    expect(solidsLeft).toBe(0);

    // Spoil-load is bounded. (Without overflow handling here, the load just
    // saturates at capacity — overflow drop happens in Game.handleLevel.)
    expect(u.spoilLoad).toBeLessThanOrEqual(u.spoilCapacity);
    expect(u.spoilLoad).toBeGreaterThanOrEqual(0);

    // After the path completes, levelTargetY is cleared so the unit doesn't
    // keep grinding when re-issued an unrelated command.
    expect(u.levelTargetY).toBeNull();

    void totalFilled;
  });

  it('does not emit a LevelRequest when standing idle', () => {
    const slabY = 60;
    const world = buildSlabWorld(slabY);
    const voxels = world.buffers.voxels;

    const nav = allocateNav(false);
    buildSurfaceNav(voxels, nav);
    const vnav = allocateVolumeNav(false);
    buildVolumeNav(voxels, vnav);

    const um = new UnitManager();
    um.spawn('dozer', 50 * VOXEL_SIZE, (slabY + 1) * VOXEL_SIZE, 50 * VOXEL_SIZE);

    let levelCount = 0;
    for (let i = 0; i < 30; i++) {
      um.tick(1 / 60, nav, vnav, voxels, (req) => {
        if (req.kind === 'level') levelCount++;
      });
    }
    expect(levelCount).toBe(0);
  });
});

/**
 * Mirror of Game.handleLevel — walks the rectangle column-by-column and edits each.
 * Returns the cut/fill totals so the test can assert.
 */
function applyLevel(world: VoxelWorld, req: LevelRequest): { cut: number; filled: number } {
  const rx = -req.fz, rz = req.fx;
  const SAMPLE = VOXEL_SIZE * 0.5;
  const sampledCols = new Set<number>();
  let cutTotal = 0, filledTotal = 0;
  for (let a = -req.halfDepthMeters; a <= req.halfDepthMeters; a += SAMPLE) {
    for (let b = -req.halfWidthMeters; b <= req.halfWidthMeters; b += SAMPLE) {
      const wx = req.x + req.fx * a + rx * b;
      const wz = req.z + req.fz * a + rz * b;
      const vx = Math.floor(wx / VOXEL_SIZE);
      const vz = Math.floor(wz / VOXEL_SIZE);
      const key = vz * 100000 + vx;
      if (sampledCols.has(key)) continue;
      sampledCols.add(key);
      const r = world.editColumnToY(vx, vz, req.targetVoxY, M_DIRT);
      cutTotal += r.cut;
      filledTotal += r.filled;
    }
  }
  return { cut: cutTotal, filled: filledTotal };
}
