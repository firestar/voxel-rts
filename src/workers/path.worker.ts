/// <reference lib="webworker" />
import { buildSurfaceNav, SurfaceNavBuffers } from '../path/SurfaceNav';
import { findPathSurface, AStarRequest, AStarWorkspace } from '../path/AStar';
import { smoothPath } from '../path/Smooth';
import { buildVolumeNav, VolumeNavBuffers } from '../path/VolumeNav';
import { findPathVolume, smoothPathVolume, AStar3DRequest, AStar3DWorkspace } from '../path/AStar3D';

interface InitMessage {
  kind: 'init';
  voxels: Uint8Array;
  nav: SurfaceNavBuffers;
  vnav: VolumeNavBuffers;
}

interface PathRequestMessage {
  kind: 'path';
  reqId: number;
  req: AStarRequest;
}

interface VolumePathMessage {
  kind: 'volumePath';
  reqId: number;
  req: AStar3DRequest;
}

interface RebuildMessage {
  kind: 'rebuild';
  reqId: number;
}

type Message = InitMessage | PathRequestMessage | VolumePathMessage | RebuildMessage;

let nav: SurfaceNavBuffers | null = null;
let vnav: VolumeNavBuffers | null = null;
let voxels: Uint8Array | null = null;
const ws2 = new AStarWorkspace();
const ws3 = new AStar3DWorkspace();

self.onmessage = (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init': {
      nav = msg.nav;
      vnav = msg.vnav;
      voxels = msg.voxels;
      buildSurfaceNav(voxels, nav);
      buildVolumeNav(voxels, vnav);
      (self as unknown as Worker).postMessage({ kind: 'ready' });
      break;
    }
    case 'rebuild': {
      if (nav && voxels) buildSurfaceNav(voxels, nav);
      if (vnav && voxels) buildVolumeNav(voxels, vnav);
      (self as unknown as Worker).postMessage({ kind: 'rebuild', reqId: msg.reqId });
      break;
    }
    case 'path': {
      if (!nav) {
        (self as unknown as Worker).postMessage({ kind: 'path', reqId: msg.reqId, cells: [], reached: false, expanded: 0 });
        break;
      }
      const r = findPathSurface(nav, ws2, msg.req);
      const smoothed = r.cells.length > 2
        ? smoothPath(
            nav, r.cells,
            msg.req.footprintRadius, msg.req.maxStepVoxels,
            msg.req.bodyHalfCells, msg.req.bodyRoughnessVoxels,
            msg.req.headroomVoxels,
          )
        : r.cells;
      (self as unknown as Worker).postMessage({
        kind: 'path', reqId: msg.reqId,
        cells: smoothed, reached: r.reached, expanded: r.expanded,
      });
      break;
    }
    case 'volumePath': {
      if (!vnav) {
        (self as unknown as Worker).postMessage({ kind: 'volumePath', reqId: msg.reqId, cells: [], reached: false, expanded: 0 });
        break;
      }
      const r = findPathVolume(vnav, ws3, msg.req);
      const smoothed = r.cells.length > 2
        ? smoothPathVolume(vnav, r.cells, msg.req.canDig, msg.req.requiresGround, msg.req.footprintRadius)
        : r.cells;
      (self as unknown as Worker).postMessage({
        kind: 'volumePath', reqId: msg.reqId,
        cells: smoothed, reached: r.reached, expanded: r.expanded,
      });
      break;
    }
  }
};

export {};
