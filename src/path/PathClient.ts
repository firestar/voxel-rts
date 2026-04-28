import { allocateNav, SurfaceNavBuffers, navIndex, NAV_CELL_METERS, NAV_W, NAV_H, navCenter } from './SurfaceNav';
import { AStarRequest } from './AStar';
import { allocateVolumeNav, VolumeNavBuffers, volumeCellCenter } from './VolumeNav';
import { AStar3DRequest } from './AStar3D';
import { VoxelWorld } from '../voxel/VoxelWorld';

import PathWorker from '../workers/path.worker?worker';

export interface PathResponse {
  cells: { cx: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

export interface VolumePathResponse {
  cells: { cx: number; cy: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

export class PathClient {
  readonly nav: SurfaceNavBuffers;
  readonly vnav: VolumeNavBuffers;
  private worker: Worker;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private nextReqId = 1;
  private pending = new Map<number, (r: PathResponse) => void>();
  private pendingVolume = new Map<number, (r: VolumePathResponse) => void>();
  private rebuildWaiters = new Map<number, () => void>();

  constructor(world: VoxelWorld) {
    const useShared = typeof SharedArrayBuffer !== 'undefined' && (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    this.nav = allocateNav(useShared);
    this.vnav = allocateVolumeNav(useShared);
    this.worker = new PathWorker();
    this.worker.onmessage = this.onMessage;
    this.worker.postMessage({
      kind: 'init',
      voxels: world.buffers.voxels,
      nav: this.nav,
      vnav: this.vnav,
    });
  }

  awaitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>(resolve => this.readyWaiters.push(resolve));
  }

  requestPath(req: AStarRequest): Promise<PathResponse> {
    const reqId = this.nextReqId++;
    return new Promise<PathResponse>((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage({ kind: 'path', reqId, req });
    });
  }

  requestVolumePath(req: AStar3DRequest): Promise<VolumePathResponse> {
    const reqId = this.nextReqId++;
    return new Promise<VolumePathResponse>((resolve) => {
      this.pendingVolume.set(reqId, resolve);
      this.worker.postMessage({ kind: 'volumePath', reqId, req });
    });
  }

  rebuildNav(): Promise<void> {
    const reqId = this.nextReqId++;
    return new Promise<void>((resolve) => {
      this.rebuildWaiters.set(reqId, resolve);
      this.worker.postMessage({ kind: 'rebuild', reqId });
    });
  }

  cellsToWaypoints(cells: { cx: number; cz: number }[]): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const c of cells) out.push(navCenter(this.nav, c.cx, c.cz));
    return out;
  }

  volumeCellsToWaypoints(cells: { cx: number; cy: number; cz: number }[]): { x: number; y: number; z: number }[] {
    return cells.map(c => volumeCellCenter(c.cx, c.cy, c.cz));
  }

  cellAt(wx: number, wz: number): { cx: number; cz: number; ok: boolean } {
    const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
    const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
    const i = navIndex(cx, cz);
    return { cx, cz, ok: !this.nav.blocked[i] };
  }

  /**
   * Stamp every nav cell within `obstacleRadiusMeters` of the world-space point
   * `(wx, wz)` into `out` (deduplicated). Used by `Game.routePath` to convert
   * each stationary peer into the obstacle list passed into the surface A*.
   *
   * Caller passes the Minkowski sum of the blocker's collision radius and the
   * requesting unit's radius so the planner routes around each peer with enough
   * clearance for the requester to actually fit, instead of brushing the very
   * edge of the blocker's body and then collision-stalling.
   */
  stampUnitObstacleCells(
    wx: number, wz: number,
    obstacleRadiusMeters: number,
    seen: Set<number>,
    out: number[],
  ): void {
    const r = obstacleRadiusMeters;
    const minCx = Math.max(0, Math.floor((wx - r) / NAV_CELL_METERS));
    const maxCx = Math.min(NAV_W - 1, Math.floor((wx + r) / NAV_CELL_METERS));
    const minCz = Math.max(0, Math.floor((wz - r) / NAV_CELL_METERS));
    const maxCz = Math.min(NAV_H - 1, Math.floor((wz + r) / NAV_CELL_METERS));
    // Cell-circle overlap: any cell whose closest point to (wx, wz) is within r
    // overlaps the obstacle disc. We compute that closest point by clamping the
    // obstacle position into the cell's [min, max] bounds on each axis.
    const r2 = r * r;
    for (let cz = minCz; cz <= maxCz; cz++) {
      const cellMinZ = cz * NAV_CELL_METERS;
      const cellMaxZ = cellMinZ + NAV_CELL_METERS;
      const dzClamped = wz < cellMinZ ? cellMinZ - wz : wz > cellMaxZ ? wz - cellMaxZ : 0;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const cellMinX = cx * NAV_CELL_METERS;
        const cellMaxX = cellMinX + NAV_CELL_METERS;
        const dxClamped = wx < cellMinX ? cellMinX - wx : wx > cellMaxX ? wx - cellMaxX : 0;
        if (dxClamped * dxClamped + dzClamped * dzClamped > r2) continue;
        const idx = navIndex(cx, cz);
        if (seen.has(idx)) continue;
        seen.add(idx);
        out.push(idx);
      }
    }
  }

  /**
   * Synchronous "first leg" of the eventual route — used to start the unit walking the
   * same frame the user clicks instead of waiting for the worker round-trip. Steps
   * along the line from `(sx, sz)` toward `(gx, gz)` in 1m increments, stopping at
   * the first cell that's blocked, requires too tall a step, or fails the headroom
   * check. Returns `null` if even the first step is impassable (caller falls back to
   * the worker's full result).
   *
   * This is intentionally cheaper than the post-A* smoother — no body-roughness fit,
   * no unit-obstacle stamping, no road bias. The unit only walks ~`maxCells` along
   * this line before the worker's full path arrives and replaces it; if our optimistic
   * leg turns out to be wrong (the real route bends the other way), the trim logic in
   * `Units.setPath` strips waypoints that are now behind the unit and the unit
   * follows the corrected route from where it ended up.
   */
  firstStepWaypoint(
    sx: number, sz: number,
    gx: number, gz: number,
    maxStepVoxels: number,
    headroomVoxels: number,
    maxCells = 6,
  ): { x: number; y: number; z: number } | null {
    const dx = gx - sx;
    const dz = gz - sz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < NAV_CELL_METERS * 0.5) return null;
    const stepMeters = NAV_CELL_METERS * 0.5; // half-cell oversample so we don't skip cells
    const steps = Math.min(maxCells * 2, Math.ceil(dist / stepMeters));
    const stepX = (dx / dist) * stepMeters;
    const stepZ = (dz / dist) * stepMeters;
    const startCx = Math.max(0, Math.min(NAV_W - 1, Math.floor(sx / NAV_CELL_METERS)));
    const startCz = Math.max(0, Math.min(NAV_H - 1, Math.floor(sz / NAV_CELL_METERS)));
    const startI = navIndex(startCx, startCz);
    let prevCx = startCx, prevCz = startCz;
    let prevTopY = this.nav.topY[startI]!;
    let lastGoodCx = startCx, lastGoodCz = startCz;
    let advanced = false;
    for (let i = 1; i <= steps; i++) {
      const px = sx + stepX * i;
      const pz = sz + stepZ * i;
      const cx = Math.floor(px / NAV_CELL_METERS);
      const cz = Math.floor(pz / NAV_CELL_METERS);
      if (cx < 0 || cz < 0 || cx >= NAV_W || cz >= NAV_H) break;
      if (cx === prevCx && cz === prevCz) continue;
      const idx = navIndex(cx, cz);
      if (this.nav.blocked[idx]) break;
      if (headroomVoxels > 0 && this.nav.headroom[idx]! < headroomVoxels) break;
      const topY = this.nav.topY[idx]!;
      const dy = topY > prevTopY ? topY - prevTopY : prevTopY - topY;
      if (dy > maxStepVoxels) break;
      lastGoodCx = cx; lastGoodCz = cz;
      advanced = true;
      prevCx = cx; prevCz = cz; prevTopY = topY;
    }
    if (!advanced) return null;
    return navCenter(this.nav, lastGoodCx, lastGoodCz);
  }

  /**
   * Like cellAt, but if the requested cell is blocked, expands outward in concentric
   * rings up to `maxRing` cells away looking for the nearest walkable cell. Returns
   * that cell's coords with ok=true. Useful for resolving ambiguous user clicks that
   * land on a blocked-but-near-walkable spot — without it, the path search returns
   * empty and the unit refuses to move.
   */
  nearestWalkable(wx: number, wz: number, maxRing = 4): { cx: number; cz: number; ok: boolean } {
    const c = this.cellAt(wx, wz);
    if (c.ok) return c;
    for (let r = 1; r <= maxRing; r++) {
      // Walk the ring at radius r in cell distance (Chebyshev), check each cell.
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // ring perimeter only
          const nx = c.cx + dx, nz = c.cz + dz;
          if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
          if (!this.nav.blocked[navIndex(nx, nz)]) {
            return { cx: nx, cz: nz, ok: true };
          }
        }
      }
    }
    return c; // give up — caller will see ok=false and skip the move
  }

  dispose(): void {
    this.worker.terminate();
  }

  private onMessage = (ev: MessageEvent): void => {
    const msg = ev.data;
    if (msg.kind === 'ready') {
      this.ready = true;
      const ws = this.readyWaiters.slice();
      this.readyWaiters.length = 0;
      for (const w of ws) w();
      return;
    }
    if (msg.kind === 'path') {
      const cb = this.pending.get(msg.reqId);
      if (cb) {
        this.pending.delete(msg.reqId);
        cb({ cells: msg.cells, reached: msg.reached, expanded: msg.expanded });
      }
      return;
    }
    if (msg.kind === 'volumePath') {
      const cb = this.pendingVolume.get(msg.reqId);
      if (cb) {
        this.pendingVolume.delete(msg.reqId);
        cb({ cells: msg.cells, reached: msg.reached, expanded: msg.expanded });
      }
      return;
    }
    if (msg.kind === 'rebuild') {
      const cb = this.rebuildWaiters.get(msg.reqId);
      if (cb) {
        this.rebuildWaiters.delete(msg.reqId);
        cb();
      }
    }
  };
}
