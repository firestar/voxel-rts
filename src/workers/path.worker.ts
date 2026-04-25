/// <reference lib="webworker" />
import { buildSurfaceNav, SurfaceNavBuffers } from '../path/SurfaceNav';
import { findPathSurface, AStarRequest, AStarWorkspace } from '../path/AStar';

interface InitMessage {
  kind: 'init';
  voxels: Uint8Array;
  nav: SurfaceNavBuffers;
}

interface PathRequestMessage {
  kind: 'path';
  reqId: number;
  req: AStarRequest;
}

interface RebuildMessage {
  kind: 'rebuild';
  reqId: number;
}

type Message = InitMessage | PathRequestMessage | RebuildMessage;

let nav: SurfaceNavBuffers | null = null;
let voxels: Uint8Array | null = null;
const ws = new AStarWorkspace();

self.onmessage = (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init': {
      nav = msg.nav;
      voxels = msg.voxels;
      buildSurfaceNav(voxels, nav);
      (self as unknown as Worker).postMessage({ kind: 'ready' });
      break;
    }
    case 'rebuild': {
      if (nav && voxels) buildSurfaceNav(voxels, nav);
      (self as unknown as Worker).postMessage({ kind: 'rebuild', reqId: msg.reqId });
      break;
    }
    case 'path': {
      if (!nav) {
        (self as unknown as Worker).postMessage({ kind: 'path', reqId: msg.reqId, cells: [], reached: false, expanded: 0 });
        break;
      }
      const r = findPathSurface(nav, ws, msg.req);
      (self as unknown as Worker).postMessage({
        kind: 'path',
        reqId: msg.reqId,
        cells: r.cells,
        reached: r.reached,
        expanded: r.expanded,
      });
      break;
    }
  }
};

export {};
