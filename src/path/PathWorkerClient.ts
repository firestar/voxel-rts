/**
 * Async client around `path.worker.ts`. Wraps the postMessage protocol behind
 * a small Promise-based API the Game can call.
 *
 * Two modes:
 *
 *   - With SharedArrayBuffer: the worker shares the volume + per-kind unit
 *     grid bitmaps with the main thread (zero-copy). Findpath and damage
 *     rebuilds run on the worker; the main thread keeps a `Pathfinder`
 *     instance for sync helpers (`cellAt`, `nearestPassable`, `groundCellAt`)
 *     that read the same SAB-backed bitmaps.
 *
 *   - Without SAB (no cross-origin-isolated context): the worker can't share
 *     buffers, so we don't spawn one — every async call routes back to the
 *     local Pathfinder synchronously. Same observable API, no off-thread win.
 *
 * The single worker processes messages serially, so an `applyDamage` queued
 * before a `findPath` is guaranteed to finish first (the find sees the
 * post-damage grid). On the main thread, sync helpers may briefly observe a
 * pre-rebuild grid during the window between `applyDamage` enqueue and
 * worker completion — the bitmap is updated byte-by-byte and stale reads
 * return cells that are still consistent (just not yet refreshed).
 */
import { Pathfinder, PathRequest } from './Pathfinder';
import { UnitProfile } from './UnitGrid';

export interface PathRouteResult {
  /** World-space waypoints from start to goal (inclusive). */
  waypoints: { x: number; y: number; z: number }[];
  reached: boolean;
  expanded: number;
}

interface PendingResolver {
  resolve: (value: unknown) => void;
}

export class PathWorkerClient {
  private worker: Worker | null = null;
  private nextReqId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private readonly initPromise: Promise<void>;

  constructor(
    private readonly pathfinder: Pathfinder,
    private readonly voxels: Uint8Array,
    profiles: UnitProfile[],
    useWorker: boolean,
  ) {
    if (!useWorker) {
      this.initPromise = Promise.resolve();
      return;
    }
    this.worker = new Worker(new URL('../workers/path.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent): void => this.handleMessage(ev);

    const profilePayload = profiles.map(profile => {
      const grid = pathfinder.getGrid(profile.kind);
      if (!grid) throw new Error(`PathWorkerClient: profile '${profile.kind}' missing from pathfinder`);
      return { profile, passable: grid.passable };
    });

    this.initPromise = new Promise<void>(resolve => {
      const reqId = 0;
      this.pending.set(reqId, { resolve: () => resolve() });
      this.worker!.postMessage({
        type: 'init',
        voxels,
        volume: pathfinder.volume,
        profiles: profilePayload,
      });
    });
  }

  /** True when work is actually running on a worker thread. */
  get hasWorker(): boolean {
    return this.worker !== null;
  }

  /** Resolves once the worker has accepted the initial buffer wiring. */
  ready(): Promise<void> {
    return this.initPromise;
  }

  async findPath(kind: string, req: PathRequest): Promise<PathRouteResult> {
    if (!this.worker) {
      const res = this.pathfinder.findPath(kind, req);
      const waypoints = res.cells.length ? this.pathfinder.pathToWaypoints(res.cells) : [];
      return { waypoints, reached: res.reached, expanded: res.expanded };
    }
    await this.initPromise;
    const reqId = this.nextReqId++;
    return new Promise<PathRouteResult>(resolve => {
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void });
      this.worker!.postMessage({
        type: 'findPath',
        reqId,
        kind,
        start: req.start,
        goal: req.goal,
        anyAngle: req.anyAngle === true,
        maxExpansions: req.maxExpansions,
        heuristicWeight: req.heuristicWeight,
      });
    });
  }

  async applyDamage(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): Promise<void> {
    if (!this.worker) {
      this.pathfinder.applyDamage(minX, minY, minZ, maxX, maxY, maxZ);
      return;
    }
    await this.initPromise;
    const reqId = this.nextReqId++;
    return new Promise<void>(resolve => {
      this.pending.set(reqId, { resolve: () => resolve() });
      this.worker!.postMessage({
        type: 'applyDamage', reqId,
        minX, minY, minZ, maxX, maxY, maxZ,
      });
    });
  }

  async rebuildAll(): Promise<void> {
    if (!this.worker) {
      this.pathfinder.rebuildAll();
      return;
    }
    await this.initPromise;
    const reqId = this.nextReqId++;
    return new Promise<void>(resolve => {
      this.pending.set(reqId, { resolve: () => resolve() });
      this.worker!.postMessage({ type: 'rebuildAll', reqId });
    });
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
  }

  private handleMessage(ev: MessageEvent): void {
    const data = ev.data as { type: string; reqId: number } & Record<string, unknown>;
    const reqId = data.reqId;
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    if (data.type === 'findPath') {
      pending.resolve({
        waypoints: data.waypoints as { x: number; y: number; z: number }[],
        reached: data.reached as boolean,
        expanded: data.expanded as number,
      } as PathRouteResult);
    } else {
      pending.resolve(undefined);
    }
  }
}
