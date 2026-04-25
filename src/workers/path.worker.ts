/// <reference lib="webworker" />
import { allocateNav, buildSurfaceNav, SurfaceNavBuffers } from '../path/SurfaceNav';
import { findPathSurface, AStarRequest, AStarWorkspace } from '../path/AStar';

interface InitMessage {
  kind: 'init';
  voxels: Uint8Array;       // shared
  nav: SurfaceNavBuffers;   // shared (allocated on main thread)
}

interface PathRequestMessage {
  kind: 'path';
  reqId: number;
  req: AStarRequest;
}

type Message = InitMessage | PathRequestMessage;

let nav: SurfaceNavBuffers | null = null;
const ws = new AStarWorkspace();

self.onmessage = (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init': {
      nav = msg.nav;
      buildSurfaceNav(msg.voxels, nav);
      (self as unknown as Worker).postMessage({ kind: 'ready' });
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
