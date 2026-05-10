import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface Sapling {
  vx: number; vy: number; vz: number;
  ageSec: number; seed: number; marker: number[];
}

interface ServerStateShape {
  tick: number;
  voxelOverrides: Map<number, number>;
  voxelEdits: Array<{
    seq: number; sender: string;
    op: { kind: 'sphere'; x: number; y: number; z: number; radius: number; mat: number }
       | { kind: 'set'; ops: Array<{ x: number; y: number; z: number; mat: number }> };
  }>;
  voxelEditSeq: number;
  saplings: Sapling[];
  worldSeed: number;
  projectiles: Map<number, unknown>;
  projectilesByTag: Map<string, number>;
  entities: Map<number, unknown>;
  byTag: Map<string, number>;
  projectileImpactSeq: number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string };
  tick: (dt: number) => void;
  state: ServerStateShape;
};

const SERVER_WORLD_X = 3072;
const SERVER_WORLD_Z = 3072;
const M_GRASS = 1;
const M_WOOD = 4;
const M_LEAF = 5;

function voxelIdx(x: number, y: number, z: number): number {
  return (y * SERVER_WORLD_Z + z) * SERVER_WORLD_X + x;
}

function reset(): void {
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.saplings.length = 0;
  gs.state.tick = 0;
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.projectileImpactSeq = 0;
}

/** Drop a single grass voxel at (vx, vy, vz). The server's
 *  findSaplingGrassTop walks down from WORLD_Y-1 looking for the
 *  topmost non-air voxel; placing one grass voxel via overrides is
 *  enough — getVoxelMaterial returns AIR for everything else when
 *  the worldgen overlay isn't built (tests skip that path). */
function plantGrass(vx: number, vy: number, vz: number): void {
  gs.state.voxelOverrides.set(voxelIdx(vx, vy, vz), M_GRASS);
}

describe('server saplings', () => {
  beforeEach(reset);

  it('plant_sapling stamps a marker and registers the sapling', () => {
    plantGrass(800, 60, 800);
    const r = gs.applyCommand({
      type: 'plant_sapling',
      owner: 'forester',
      wx: 800.5, wz: 800.5,
      seed: 1234,
    });
    expect(r.ok).toBe(true);
    expect(gs.state.saplings.length).toBe(1);
    // Marker voxels: yStem=61, yStem+1=62 (wood), yStem+2=63 (leaf).
    expect(gs.state.voxelOverrides.get(voxelIdx(800, 61, 800))).toBe(M_WOOD);
    expect(gs.state.voxelOverrides.get(voxelIdx(800, 62, 800))).toBe(M_WOOD);
    expect(gs.state.voxelOverrides.get(voxelIdx(800, 63, 800))).toBe(M_LEAF);
    // The marker should have ridden out as a single voxel_edit set op.
    const last = gs.state.voxelEdits[gs.state.voxelEdits.length - 1]!;
    expect(last.sender).toBe('forester');
    expect(last.op.kind).toBe('set');
    if (last.op.kind === 'set') expect(last.op.ops.length).toBe(3);
  });

  it('rejects plants on non-grass surfaces', () => {
    // No grass anywhere — column is all air.
    const r = gs.applyCommand({
      type: 'plant_sapling',
      owner: 'forester',
      wx: 900.5, wz: 900.5,
      seed: 1,
    });
    expect(r.ok).toBe(false);
    expect(gs.state.saplings.length).toBe(0);
  });

  it('rejects plants within 1 voxel of an existing sapling', () => {
    plantGrass(1000, 60, 1000);
    plantGrass(1001, 60, 1000);
    const a = gs.applyCommand({ type: 'plant_sapling', owner: 'a', wx: 1000.5, wz: 1000.5, seed: 1 });
    expect(a.ok).toBe(true);
    const b = gs.applyCommand({ type: 'plant_sapling', owner: 'a', wx: 1001.5, wz: 1000.5, seed: 2 });
    expect(b.ok).toBe(false);
  });

  it('matures into a full tree after SAPLING_MATURE_SEC', () => {
    plantGrass(1200, 60, 1200);
    gs.applyCommand({
      type: 'plant_sapling',
      owner: 'forester',
      wx: 1200.5, wz: 1200.5,
      seed: 42,
    });
    expect(gs.state.saplings.length).toBe(1);
    const seqBefore = gs.state.voxelEditSeq;
    // Stride past 30 s in a few coarse ticks.
    for (let i = 0; i < 7; i++) gs.tick(5);
    expect(gs.state.saplings.length).toBe(0);
    // A maturation broadcast was emitted as a single 'set' op.
    expect(gs.state.voxelEditSeq).toBe(seqBefore + 1);
    const last = gs.state.voxelEdits[gs.state.voxelEdits.length - 1]!;
    expect(last.sender).toBe('server');
    expect(last.op.kind).toBe('set');
    if (last.op.kind === 'set') {
      // A real tree has many more writes than the 3-voxel marker.
      expect(last.op.ops.length).toBeGreaterThan(20);
      // Trunk writes are unconditional WOOD; the bottom of the trunk
      // sits at vy+1, so y >= 61 voxels above the seed should hold
      // wood somewhere.
      const woodWrites = last.op.ops.filter(w => w.mat === M_WOOD);
      const leafWrites = last.op.ops.filter(w => w.mat === M_LEAF);
      expect(woodWrites.length).toBeGreaterThan(0);
      expect(leafWrites.length).toBeGreaterThan(0);
    }
  });
});
