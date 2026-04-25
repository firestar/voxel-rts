import { FourAryHeap } from '../util/Heap';
import {
  VolumeNavBuffers, VNAV_X, VNAV_Y, VNAV_Z, VNAV_COUNT,
  vnavIndex, getBit,
} from './VolumeNav';

export interface AStar3DRequest {
  startCx: number; startCy: number; startCz: number;
  goalCx: number;  goalCy: number;  goalCz: number;
  /** Cells per max-expansion budget. */
  maxExpansions?: number;
}

export interface AStar3DResult {
  cells: { cx: number; cy: number; cz: number }[];
  reached: boolean;
  expanded: number;
}

// 26-neighbor offsets and base step costs (cardinal=1, face-diag=√2, corner-diag=√3).
const NB26: { dx: number; dy: number; dz: number; cost: number }[] = (() => {
  const out: { dx: number; dy: number; dz: number; cost: number }[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const k = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
        const cost = k === 1 ? 1 : k === 2 ? Math.SQRT2 : Math.sqrt(3);
        out.push({ dx, dy, dz, cost });
      }
    }
  }
  return out;
})();

function chebyshev3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by), dz = Math.abs(az - bz);
  // Chebyshev with √2/√3 corrections is more admissible:
  const max = Math.max(dx, dy, dz);
  const min = Math.min(dx, dy, dz);
  const mid = dx + dy + dz - max - min;
  return (max - mid) + (mid - min) * Math.SQRT2 + min * Math.sqrt(3);
}

export class AStar3DWorkspace {
  readonly gScore = new Float32Array(VNAV_COUNT);
  readonly cameFrom = new Int32Array(VNAV_COUNT);
  readonly closed = new Uint8Array(VNAV_COUNT);
  readonly gen = new Int32Array(VNAV_COUNT);
  readonly open = new FourAryHeap(8192);
  private genTick = 0;

  resetGeneration(): number {
    this.genTick = (this.genTick + 1) | 0;
    if (this.genTick === 0) {
      this.gen.fill(0);
      this.genTick = 1;
    }
    this.open.clear();
    return this.genTick;
  }
}

export function findPathVolume(
  vnav: VolumeNavBuffers,
  ws: AStar3DWorkspace,
  req: AStar3DRequest,
): AStar3DResult {
  const gen = ws.resetGeneration();
  const { startCx, startCy, startCz, goalCx, goalCy, goalCz } = req;
  const maxExpansions = req.maxExpansions ?? 5000;

  const startI = vnavIndex(startCx, startCy, startCz);
  const goalI = vnavIndex(goalCx, goalCy, goalCz);

  // Goal must not be bedrock.
  if (getBit(vnav.bedrock, goalI)) {
    return { cells: [], reached: false, expanded: 0 };
  }

  ws.gScore[startI] = 0;
  ws.gen[startI] = gen;
  ws.cameFrom[startI] = -1;
  ws.open.push(startI, chebyshev3(startCx, startCy, startCz, goalCx, goalCy, goalCz));

  let expanded = 0;
  let reached = false;
  while (ws.open.length > 0) {
    const i = ws.open.pop();
    if (ws.closed[i] === gen) continue;
    ws.closed[i] = gen;
    expanded++;
    if (i === goalI) { reached = true; break; }
    if (expanded >= maxExpansions) break;

    const cx = i % VNAV_X;
    const tmp = (i / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;

    for (let n = 0; n < NB26.length; n++) {
      const off = NB26[n]!;
      const nx = cx + off.dx;
      const ny = cy + off.dy;
      const nz = cz + off.dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= VNAV_X || ny >= VNAV_Y || nz >= VNAV_Z) continue;
      const ni = vnavIndex(nx, ny, nz);
      if (ws.closed[ni] === gen) continue;
      if (getBit(vnav.bedrock, ni)) continue;

      let stepCost = off.cost;
      const isSolid = getBit(vnav.solid, ni);
      if (isSolid) {
        // Add the cell's stored dig cost on top of the geometric step.
        stepCost += vnav.digCost[ni]!;
      }

      const g = ws.gScore[i]! + stepCost;
      const seen = ws.gen[ni] === gen;
      if (!seen || g < ws.gScore[ni]!) {
        ws.gen[ni] = gen;
        ws.gScore[ni] = g;
        ws.cameFrom[ni] = i;
        const f = g + chebyshev3(nx, ny, nz, goalCx, goalCy, goalCz);
        ws.open.push(ni, f);
      }
    }
  }

  let endI = goalI;
  if (!reached) {
    let bestH = Infinity, best = -1;
    // Scan closed set — bounded by maxExpansions worth of cells.
    for (let i = 0; i < VNAV_COUNT; i++) {
      if (ws.closed[i] !== gen) continue;
      const cx = i % VNAV_X;
      const tmp = (i / VNAV_X) | 0;
      const cz = tmp % VNAV_Z;
      const cy = (tmp / VNAV_Z) | 0;
      const h = chebyshev3(cx, cy, cz, goalCx, goalCy, goalCz);
      if (h < bestH) { bestH = h; best = i; }
    }
    if (best < 0) return { cells: [], reached: false, expanded };
    endI = best;
  }

  const out: { cx: number; cy: number; cz: number }[] = [];
  let cur = endI;
  while (cur !== -1) {
    const cx = cur % VNAV_X;
    const tmp = (cur / VNAV_X) | 0;
    const cz = tmp % VNAV_Z;
    const cy = (tmp / VNAV_Z) | 0;
    out.push({ cx, cy, cz });
    if (cur === startI) break;
    if (ws.gen[cur] !== gen) break;
    cur = ws.cameFrom[cur]!;
  }
  out.reverse();
  return { cells: out, reached, expanded };
}
