import { describe, it, expect } from 'vitest';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z } from '../src/voxel/types';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from '../src/voxel/Materials';
import {
  CLUSTER_X, CLUSTER_Y, CLUSTER_Z, CLUSTER_COUNT,
  CLUSTERS_X, CLUSTERS_Y, CLUSTERS_Z, clusterOfCell,
} from '../src/path/ClusterGraph';
import { GRID_X, GRID_Y, GRID_Z } from '../src/path/Nav';

const SURFACE_VY = 64;

function buildLayeredWorld(world: VoxelWorld): void {
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, 0, z)] = M_BEDROCK;
      for (let y = 1; y < SURFACE_VY; y++) v[worldIndex(x, y, z)] = M_STONE;
      for (let y = SURFACE_VY; y < SURFACE_VY + 4; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, SURFACE_VY + 4, z)] = M_GRASS;
    }
  }
}

const SOLDIER = profileFromUnit({
  kind: 'soldier',
  footprintRadius: 1,
  heightVoxels: 14,
  canDig: false,
  requiresGround: true,
  maxStepVoxels: 6,
  slopePenalty: 0,
});

function isCellAdjacent(
  a: { cx: number; cy: number; cz: number },
  b: { cx: number; cy: number; cz: number },
): boolean {
  const dx = Math.abs(a.cx - b.cx);
  const dy = Math.abs(a.cy - b.cy);
  const dz = Math.abs(a.cz - b.cz);
  return dx <= 1 && dy <= 1 && dz <= 1 && (dx + dy + dz) > 0;
}

describe('cluster graph constants', () => {
  it('partitions the nav grid evenly', () => {
    expect(CLUSTERS_X * CLUSTER_X).toBe(GRID_X);
    expect(CLUSTERS_Y * CLUSTER_Y).toBe(GRID_Y);
    expect(CLUSTERS_Z * CLUSTER_Z).toBe(GRID_Z);
    expect(CLUSTER_COUNT).toBe(CLUSTERS_X * CLUSTERS_Y * CLUSTERS_Z);
  });

  it('clusterOfCell maps cells into correct clusters', () => {
    expect(clusterOfCell(0, 0, 0)).toBe(0);
    expect(clusterOfCell(CLUSTER_X - 1, 0, 0)).toBe(0);
    expect(clusterOfCell(CLUSTER_X, 0, 0)).toBe(1);
    expect(clusterOfCell(GRID_X - 1, GRID_Y - 1, GRID_Z - 1)).toBe(CLUSTER_COUNT - 1);
  });
});

describe('buildClusterGraph', () => {
  it('produces a non-empty graph with portal pairs across cluster faces', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    const graph = pf.buildClusterGraph('soldier')!;
    expect(graph).not.toBeNull();
    // Open ground → at least one component, many portals.
    expect(graph.componentCount).toBeGreaterThan(0);
    expect(graph.portals.length).toBeGreaterThan(0);
    // Every portal should have a partner across the face.
    for (const p of graph.portals) {
      expect(p.pair).toBeGreaterThanOrEqual(0);
      const partner = graph.portals[p.pair]!;
      expect(partner.pair).toBe(graph.portals.indexOf(p));
      // Cells differ by 1 in exactly one cardinal axis.
      const a = p.cell;
      const b = partner.cell;
      const ax = a % GRID_X;
      const at = (a / GRID_X) | 0;
      const az = at % GRID_Z;
      const ay = (at / GRID_Z) | 0;
      const bx = b % GRID_X;
      const bt = (b / GRID_X) | 0;
      const bz = bt % GRID_Z;
      const by = (bt / GRID_Z) | 0;
      const dx = Math.abs(ax - bx), dy = Math.abs(ay - by), dz = Math.abs(az - bz);
      expect(dx + dy + dz).toBe(1);
    }
  });

  it('every passable cell maps to a component, every impassable to -1', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    const graph = pf.buildClusterGraph('soldier')!;
    const grid = pf.getGrid('soldier')!;

    let sampledPassable = 0, sampledImpassable = 0;
    for (let i = 0; i < graph.componentOf.length; i += 137) {
      const passable = ((grid.passable[i >> 3]! >> (i & 7)) & 1) === 1;
      if (passable) {
        expect(graph.componentOf[i]).toBeGreaterThanOrEqual(0);
        sampledPassable++;
      } else {
        expect(graph.componentOf[i]).toBe(-1);
        sampledImpassable++;
      }
    }
    expect(sampledPassable).toBeGreaterThan(0);
    expect(sampledImpassable).toBeGreaterThan(0);
  });
});

describe('findPathHPA', () => {
  it('matches plain A* on connectivity for a long open-ground query', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const start = pf.groundCellAt('soldier', 10.5, 10.5)!;
    const goal = pf.groundCellAt('soldier', 110.5, 110.5)!;
    expect(start).not.toBeNull();
    expect(goal).not.toBeNull();

    const plain = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });
    const hpa = pf.findPathHPA('soldier', { start, goal });

    expect(plain.reached).toBe(true);
    expect(hpa.reached).toBe(true);
    // First and last cells line up.
    expect(hpa.cells[0]!.cx).toBe(start.cx);
    expect(hpa.cells[0]!.cz).toBe(start.cz);
    const last = hpa.cells[hpa.cells.length - 1]!;
    expect(last.cx).toBe(goal.cx);
    expect(last.cz).toBe(goal.cz);
    // HPA path is a sequence of 26-neighbour steps after refinement.
    for (let i = 1; i < hpa.cells.length; i++) {
      expect(isCellAdjacent(hpa.cells[i - 1]!, hpa.cells[i]!)).toBe(true);
    }
    // HPA path length should be within ~30% of plain A* for open ground.
    const plainLen = plain.cells.length;
    expect(hpa.cells.length).toBeLessThanOrEqual(Math.ceil(plainLen * 1.3));
  });

  it('returns reached=false when no connection exists between start and goal', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);
    // Wall the world in half along the entire z axis at x = 64 (one cell wide).
    const v = world.buffers.voxels;
    const surfTop = SURFACE_VY + 4;
    const wallTop = surfTop + 32; // tall enough that no soldier can step over.
    for (let z = 0; z < WORLD_Z; z++) {
      for (let dx = 0; dx < 8; dx++) {
        const x = 64 * 8 + dx;
        for (let y = surfTop + 1; y <= wallTop; y++) {
          v[worldIndex(x, y, z)] = M_STONE;
        }
      }
    }

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);
    const graph = pf.buildClusterGraph('soldier')!;

    // The cluster graph should now have at least two components separated by
    // the wall — verified via different component ids on each side at the
    // same y level.
    const left = pf.groundCellAt('soldier', 30.5, 30.5)!;
    const right = pf.groundCellAt('soldier', 100.5, 30.5)!;
    const li = (left.cy * GRID_Z + left.cz) * GRID_X + left.cx;
    const ri = (right.cy * GRID_Z + right.cz) * GRID_X + right.cx;
    // Different connected components → no abstract path.
    expect(graph.componentOf[li]).not.toBe(graph.componentOf[ri]);

    const result = pf.findPathHPA('soldier', { start: left, goal: right });
    expect(result.reached).toBe(false);
  });

  it('falls through to plain A* when start and goal share a cluster component', () => {
    const world = VoxelWorld.create(false);
    buildLayeredWorld(world);

    const pf = new Pathfinder(false);
    pf.attach(world);
    pf.registerProfile(SOLDIER);

    const start = pf.groundCellAt('soldier', 8.5, 8.5)!;
    const goal = pf.groundCellAt('soldier', 12.5, 12.5)!;
    const result = pf.findPathHPA('soldier', { start, goal });
    expect(result.reached).toBe(true);
    // Fallthrough means we get the optimal plain-A* result, ie. ~chebyshev
    // distance + 1 cells.
    expect(result.cells.length).toBeLessThanOrEqual(8);
  });
});
