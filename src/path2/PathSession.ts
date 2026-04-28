import { SVOIndex } from './SVOIndex';
import { findPath, PathRequest, PathResult } from './AStar';
import { smoothPath, lineOfSight, Vec3 } from './LineOfSight';
import { buildLeafFlowField, flowDirectionAt, FlowFieldOptions, LeafFlowField, FlowDirection } from './FlowField';
import { UnitTraversal } from './SVOAnnotation';

/**
 * High-level facade for the new pathfinder.
 *
 * Owns one {@link SVOIndex} and exposes the compositions consumers actually
 * want: `route` (search + smooth), `directionTo` (flow field), `canSeeLine`
 * (LOS check), plus the underlying primitives for advanced use.
 *
 * Lifecycle:
 *   - Construct once with a `Uint8Array` voxel buffer (typically
 *     `world.buffers.voxels`).
 *   - Call `rebuildAll()` after world generation, or `rebuildDirty(dirty)`
 *     after voxel edits — same dirty buffer the meshing system uses.
 *   - Call `route()` per unit-and-destination, or build a flow field once
 *     per shared-goal squad and read `directionTo` on every tick.
 */
export class PathSession {
  readonly index: SVOIndex;
  readonly voxels: Uint8Array;

  constructor(voxels: Uint8Array) {
    this.voxels = voxels;
    this.index = new SVOIndex();
  }

  /** Build SVOs and annotations for every chunk. Call after world generation. */
  rebuildAll(): void {
    this.index.rebuildAll(this.voxels);
  }

  /**
   * Re-octree every chunk whose dirty byte is non-zero in `dirty`. Bits are
   * cleared as chunks rebuild, so callers can pass the same buffer the
   * meshing system uses (each system clears its own copy in lockstep with
   * its own consumption).
   */
  rebuildDirty(dirty: Uint8Array): number {
    return this.index.rebuildDirty(this.voxels, dirty);
  }

  /**
   * Route a unit from start to goal, returning a smoothed waypoint list.
   * The compose order is search → smooth: A* produces leaf-center waypoints,
   * then the LOS smoother collapses any-angle shortcuts.
   *
   * `reached` is true iff a passable corridor exists; `expansions` is the
   * raw search cost (unsmoothed).
   */
  route(req: PathRequest): RouteResult {
    const search = findPath(this.index, req);
    if (!search.reached) {
      return { reached: false, waypoints: [], expansions: search.expansions, smoothedFrom: 0 };
    }
    const smoothed = smoothPath(this.index, search.waypoints, req.unit);
    return {
      reached: true,
      waypoints: smoothed,
      expansions: search.expansions,
      smoothedFrom: search.waypoints.length,
    };
  }

  /**
   * Build a flow field rooted at `goal` for `unit`. Hand the result back to
   * `directionTo` for per-unit steering. Cost is independent of unit count
   * once the field is built.
   */
  buildFlow(goal: Vec3, unit: UnitTraversal, options?: FlowFieldOptions): LeafFlowField {
    return buildLeafFlowField(this.index, goal, unit, options);
  }

  directionTo(field: LeafFlowField, wx: number, wy: number, wz: number): FlowDirection {
    return flowDirectionAt(this.index, field, wx, wy, wz);
  }

  /**
   * True iff a unit can move in a straight line from `from` to `to` without
   * crossing a solid leaf or a leaf too narrow for its body. For ground-
   * locked units, every sampled leaf along the segment must also be
   * grounded.
   */
  canSeeLine(from: Vec3, to: Vec3, unit: UnitTraversal): boolean {
    return lineOfSight(this.index, from, to, unit);
  }
}

export interface RouteResult {
  reached: boolean;
  /** Smoothed leaf-center waypoints from start to goal. */
  waypoints: Vec3[];
  /** Total leaves popped during search (before smoothing). */
  expansions: number;
  /** Length of the raw search waypoints before the LOS smoother collapsed them. */
  smoothedFrom: number;
}

export type { PathRequest, PathResult } from './AStar';
export type { UnitTraversal } from './SVOAnnotation';
export type { Vec3 } from './LineOfSight';
export type { LeafFlowField, FlowFieldOptions, FlowDirection } from './FlowField';
