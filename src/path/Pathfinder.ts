/**
 * Top-level pathfinding facade.
 *
 * Owns the shared VolumeGrid plus one UnitGrid per registered unit kind.
 * Tracks dirty voxel chunks so subsequent rebuilds only touch cells that
 * actually changed. Exposes a small API that the sim/UI calls into:
 *
 *   - registerProfile(profile)            — first-time creation of a kind's grid.
 *   - rebuildAll(world)                   — full rebuild from scratch.
 *   - applyDamage(world, x0,z0,x1,z1, ymin, ymax) — incremental rebuild around a box.
 *   - findPath(profile, start, goal)      — A* (default) for that unit kind.
 *   - findPathAnyAngle(profile, ...)      — Theta* for agile single-cell units.
 *   - cellAt(wx, wy, wz)                  — meters → cell.
 *   - nearestPassable(profile, target)    — search outward from a goal until passable.
 */
import { VOXEL_SIZE, AIR } from '../voxel/types';
import { worldIndex, VoxelWorld } from '../voxel/VoxelWorld';
import { M_WOOD, M_LEAF } from '../voxel/Materials';
import {
  GRID_X, GRID_Y, GRID_Z, NAV_CELL_VOXELS, NAV_CELL_METERS,
  cellIndex, worldToCell, cellCenter,
} from './Nav';
import {
  VolumeGrid, allocateVolumeGrid, buildVolumeGrid, rebuildCell,
} from './VolumeGrid';
import {
  UnitProfile, UnitGrid, allocateUnitGrid, buildUnitGrid,
  refreshUnitGridBox, isPassable,
} from './UnitGrid';
import {
  AStarWorkspace, findPath as runFindPath, findPathThetaStar,
  PathResult, PathNode,
} from './AStar';
import { ClusterGraph, buildClusterGraph } from './ClusterGraph';
import { findPathHPA } from './HPAStar';
import {
  FlowField, FlowFieldCache, FlowFieldOptions,
} from './FlowField';

export interface PathRequest {
  start: PathNode;
  goal: PathNode;
  /** When true, run Theta* — only meaningful for footprintRadiusCells <= 1. */
  anyAngle?: boolean;
  maxExpansions?: number;
  heuristicWeight?: number;
}

export class Pathfinder {
  readonly volume: VolumeGrid;
  private readonly grids = new Map<string, UnitGrid>();
  private readonly ws = new AStarWorkspace();
  private voxels: Uint8Array | null = null;
  /** Per-kind cluster graph for HPA*. Built lazily on first request. */
  private readonly clusterGraphs = new Map<string, ClusterGraph>();
  /** Per-kind flow-field cache (LRU) for many-units-one-goal queries. */
  private readonly flowCaches = new Map<string, FlowFieldCache>();

  constructor(useShared = false) {
    this.volume = allocateVolumeGrid(useShared);
  }

  /** Wire up the world's voxel buffer. Required before any rebuild. */
  attach(world: VoxelWorld): void {
    this.voxels = world.buffers.voxels;
    buildVolumeGrid(this.voxels, this.volume);
    for (const grid of this.grids.values()) buildUnitGrid(this.volume, grid);
    this.clusterGraphs.clear();
    this.invalidateFlowFields();
  }

  /**
   * Register a unit profile and build (or rebuild) its grid. Idempotent — if
   * the kind is already registered the existing grid is rebuilt in place.
   */
  registerProfile(profile: UnitProfile, useShared = false): UnitGrid {
    let grid = this.grids.get(profile.kind);
    if (!grid) {
      grid = allocateUnitGrid(useShared, profile);
      this.grids.set(profile.kind, grid);
    } else {
      grid.profile = profile;
    }
    if (this.voxels) buildUnitGrid(this.volume, grid);
    this.clusterGraphs.delete(profile.kind);
    this.flowCaches.get(profile.kind)?.clear();
    return grid;
  }

  getGrid(kind: string): UnitGrid | undefined {
    return this.grids.get(kind);
  }

  hasProfile(kind: string): boolean {
    return this.grids.has(kind);
  }

  /**
   * Re-evaluate every cell whose voxel column might have changed inside the
   * given world-meter AABB. The box is widened by one cell on each side so
   * neighbour-dependent passability (footprint overlap, ground-below check)
   * settles correctly.
   */
  applyDamage(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): void {
    if (!this.voxels) return;
    const c0 = worldToCell(minX, minY, minZ);
    const c1 = worldToCell(maxX, maxY, maxZ);
    const x0 = Math.max(0, c0.cx - 1);
    const y0 = Math.max(0, c0.cy - 1);
    const z0 = Math.max(0, c0.cz - 1);
    const x1 = Math.min(GRID_X - 1, c1.cx + 1);
    const y1 = Math.min(GRID_Y - 1, c1.cy + 1);
    const z1 = Math.min(GRID_Z - 1, c1.cz + 1);
    // Refresh the volume cells in the dirty box.
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          rebuildCell(this.voxels, this.volume, cx, cy, cz);
        }
      }
    }
    // Each unit grid then walks its expanded box once. Previously we built a
    // per-cell dirty list and re-evaluated every cell's neighborhood — for a
    // clustered edit (typical: 3³ to 5³ cells from a single building damage
    // event) the overlapping neighborhoods redid the same cells O(box-size)
    // times. Coalescing into one sweep cuts the cost back down to the
    // expanded-box volume.
    for (const grid of this.grids.values()) {
      refreshUnitGridBox(this.volume, grid, x0, y0, z0, x1, y1, z1);
    }
    // Cluster graph + flow field caches were built against the previous
    // passability bitmap. Drop them so the next HPA* / flow-field call
    // rebuilds against the updated grid. Plain A* is unaffected.
    if (this.clusterGraphs.size > 0) this.clusterGraphs.clear();
    if (this.flowCaches.size > 0) this.invalidateFlowFields();
  }

  /**
   * Force a full re-derivation of every unit grid from the current volume
   * grid. Cheap-ish — only revisits the bitmaps, not the voxel buffer.
   */
  rebuildAllUnitGrids(): void {
    for (const grid of this.grids.values()) buildUnitGrid(this.volume, grid);
  }

  /** Full rebuild from scratch — volume and every unit grid. */
  rebuildAll(): void {
    if (!this.voxels) return;
    buildVolumeGrid(this.voxels, this.volume);
    for (const grid of this.grids.values()) buildUnitGrid(this.volume, grid);
    this.clusterGraphs.clear();
    this.invalidateFlowFields();
  }

  findPath(kind: string, req: PathRequest): PathResult {
    const grid = this.grids.get(kind);
    if (!grid) return { cells: [], reached: false, expanded: 0 };
    const opts = {
      maxExpansions: req.maxExpansions,
      heuristicWeight: req.heuristicWeight,
      volume: this.volume,
    };
    return req.anyAngle && grid.profile.footprintRadiusCells <= 1
      ? findPathThetaStar(grid, req.start, req.goal, this.ws, opts)
      : runFindPath(grid, req.start, req.goal, this.ws, opts);
  }

  /**
   * Build (or rebuild) the HPA* cluster graph for this kind. Idempotent;
   * subsequent calls overwrite the cached graph. Call after `attach()` or
   * after large `applyDamage()` events that may have invalidated the
   * existing portal layout.
   */
  buildClusterGraph(kind: string): ClusterGraph | null {
    const grid = this.grids.get(kind);
    if (!grid) return null;
    const graph = buildClusterGraph(grid);
    this.clusterGraphs.set(kind, graph);
    // Flow fields are tied to the unit grid passability — rebuilding the
    // cluster graph implies the field cache is also stale.
    this.flowCaches.get(kind)?.clear();
    return graph;
  }

  getClusterGraph(kind: string): ClusterGraph | undefined {
    return this.clusterGraphs.get(kind);
  }

  /**
   * Long-range HPA* search. If no cluster graph has been built for this kind,
   * one is built lazily on the first call. Falls through to plain A* when the
   * start and goal already share a cluster component.
   */
  findPathHPA(kind: string, req: PathRequest): PathResult {
    const grid = this.grids.get(kind);
    if (!grid) return { cells: [], reached: false, expanded: 0 };
    let graph = this.clusterGraphs.get(kind);
    if (!graph) graph = this.buildClusterGraph(kind)!;
    return findPathHPA(grid, graph, req.start, req.goal, this.ws, {
      maxExpansionsPerSegment: req.maxExpansions,
      heuristicWeight: req.heuristicWeight,
      volume: this.volume,
    });
  }

  /**
   * Look up (or build) a flow field rooted at `goal` for this unit kind.
   * The returned field is owned by the per-kind cache; treat it as read-only
   * and don't hold the reference across `applyDamage()`/`buildClusterGraph()`
   * calls without re-fetching.
   */
  getFlowField(
    kind: string,
    goal: PathNode,
    opts?: FlowFieldOptions,
  ): FlowField | null {
    const grid = this.grids.get(kind);
    if (!grid) return null;
    let cache = this.flowCaches.get(kind);
    if (!cache) {
      cache = new FlowFieldCache();
      this.flowCaches.set(kind, cache);
    }
    return cache.get(grid, goal, opts);
  }

  /** Drop all cached flow fields for a kind (or all kinds). */
  invalidateFlowFields(kind?: string): void {
    if (kind) this.flowCaches.get(kind)?.clear();
    else for (const c of this.flowCaches.values()) c.clear();
  }

  /**
   * Spiral outward from a 3D cell looking for a passable cell for this unit
   * kind. Returns the original cell when nothing is found within `maxRing`
   * steps (caller handles the failure).
   */
  nearestPassable(kind: string, c: PathNode, maxRing = 4): PathNode {
    const grid = this.grids.get(kind);
    if (!grid) return c;
    if (isPassable(grid, c.cx, c.cy, c.cz)) return c;
    for (let r = 1; r <= maxRing; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r && Math.abs(dz) !== r) continue;
            const nx = c.cx + dx, ny = c.cy + dy, nz = c.cz + dz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= GRID_X || ny >= GRID_Y || nz >= GRID_Z) continue;
            if (isPassable(grid, nx, ny, nz)) return { cx: nx, cy: ny, cz: nz };
          }
        }
      }
    }
    return c;
  }

  /**
   * Walk the voxel column at (wx, wz) from the top down to find the highest
   * cell where the unit can stand. Used to convert a 2D click target into a
   * surface y for ground units. Trees (wood / leaf) are skipped so the unit
   * stands on the ground under the canopy, not on top of it.
   *
   * Returns null if no surface fits the unit's body anywhere in the column.
   */
  groundCellAt(kind: string, wx: number, wz: number, ceilingMeters?: number): PathNode | null {
    const grid = this.grids.get(kind);
    if (!grid || !this.voxels) return null;
    const cx = Math.max(0, Math.min(GRID_X - 1, Math.floor(wx / NAV_CELL_METERS)));
    const cz = Math.max(0, Math.min(GRID_Z - 1, Math.floor(wz / NAV_CELL_METERS)));
    const ceilCy = ceilingMeters !== undefined
      ? Math.min(GRID_Y - 1, Math.max(0, Math.floor(ceilingMeters / NAV_CELL_METERS)))
      : GRID_Y - 1;
    for (let cy = ceilCy; cy >= 0; cy--) {
      if (isPassable(grid, cx, cy, cz)) return { cx, cy, cz };
    }
    return null;
  }

  cellAt(wx: number, wy: number, wz: number): PathNode {
    return worldToCell(wx, wy, wz);
  }

  pathToWaypoints(path: PathNode[]): { x: number; y: number; z: number }[] {
    return path.map(c => cellCenter(c.cx, c.cy, c.cz));
  }
}

/**
 * Convenience: derive a UnitProfile from a unit-kind config. Done here rather
 * than in the sim so the sim doesn't have to import nav constants — this
 * mapping is the single source of truth for "how does the path planner see
 * this unit kind".
 */
export interface UnitProfileSource {
  kind: string;
  footprintRadius: number;
  heightVoxels: number;
  canDig: boolean;
  requiresGround: boolean;
  maxStepVoxels: number;
  slopePenalty: number;
}

export function profileFromUnit(src: UnitProfileSource): UnitProfile {
  return {
    kind: src.kind,
    footprintRadiusCells: Math.max(1, src.footprintRadius),
    heightCells: Math.max(1, Math.ceil(src.heightVoxels / NAV_CELL_VOXELS)),
    canDig: src.canDig,
    requiresGround: src.requiresGround,
    maxStepVoxels: src.maxStepVoxels,
    slopePenalty: src.slopePenalty,
  };
}

export { GRID_X, GRID_Y, GRID_Z, NAV_CELL_VOXELS, NAV_CELL_METERS, cellIndex, worldToCell, cellCenter };
