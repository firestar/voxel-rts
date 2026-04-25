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
