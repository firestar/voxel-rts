import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H } from './SurfaceNav';
import { bodyRoughnessOk } from './AStar';

/**
 * Walk every nav cell touched by the line from (ax, az) to (bx, bz) and return false
 * the moment a cell is impassable for the unit. Visiting EVERY cell — not just the
 * Bresenham-stepped ones — is what stops the smoother from drawing a long diagonal
 * across a 1-cell air gap (a void column whose blocked bit Bresenham would otherwise
 * skip past).
 *
 * Implementation: round-to-nearest sample along the parameterised line at 4× cell
 * oversampling. Any cell touched by the line is hit at least once.
 */
function navLineClear(
  nav: SurfaceNavBuffers,
  ax: number, az: number,
  bx: number, bz: number,
  footprintRadius: number,
  maxStepVoxels: number,
  bodyHalfCells: number,
  bodyRoughnessVoxels: number,
  headroomVoxels: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const span = Math.max(Math.abs(dx), Math.abs(dz));
  if (span === 0) {
    if (ax < 0 || az < 0 || ax >= NAV_W || az >= NAV_H) return false;
    return !nav.blocked[navIndex(ax, az)];
  }
  // Larger units get a slightly more generous step limit since A* already verified a
  // climb-feasible cardinal path through the surrounding terrain.
  const stepLimit = maxStepVoxels + (footprintRadius >= 2 ? 2 : 0);
  const steps = span * 4; // 4× oversample — catches every cell the line clips
  let prevX = -1, prevZ = -1;
  let prevY = 0;
  let havePrev = false;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(ax + dx * t);
    const z = Math.round(az + dz * t);
    if (x === prevX && z === prevZ) continue;
    if (x < 0 || z < 0 || x >= NAV_W || z >= NAV_H) return false;
    const idx = navIndex(x, z);
    if (nav.blocked[idx]) return false;
    const y = nav.topY[idx]!;
    if (havePrev && Math.abs(y - prevY) > stepLimit) return false;
    if (bodyHalfCells > 0 && !bodyRoughnessOk(nav, x, z, bodyHalfCells, bodyRoughnessVoxels)) return false;
    if (headroomVoxels > 0 && nav.headroom[idx]! < headroomVoxels) return false;
    prevX = x; prevZ = z; prevY = y; havePrev = true;
  }
  return true;
}

/**
 * Greedy smoothing: keep the current waypoint, skip ahead while the straight line from it
 * to the next-next waypoint is still passable.
 */
/**
 * Greedy smoothing with a bounded lookahead: from each waypoint, only collapse forward
 * by at most `maxLookaheadCells` cells. That keeps natural curves in the path instead of
 * folding everything into one straight line, which gives several useful properties:
 *  - the unit stays close to the A* route through terrain rather than cutting corners
 *  - paths look more like routes with bends
 *  - the per-unit A* cost jitter still produces visibly different routes
 */
export function smoothPath(
  nav: SurfaceNavBuffers,
  cells: { cx: number; cz: number }[],
  footprintRadius: number,
  maxStepVoxels: number,
  bodyHalfCells: number,
  bodyRoughnessVoxels: number,
  headroomVoxels: number,
  maxLookaheadCells = 12,
): { cx: number; cz: number }[] {
  if (cells.length <= 2) return cells;
  const out: { cx: number; cz: number }[] = [cells[0]!];
  let i = 0;
  while (i < cells.length - 1) {
    let j = Math.min(cells.length - 1, i + maxLookaheadCells);
    while (j > i + 1) {
      const a = cells[i]!;
      const b = cells[j]!;
      if (navLineClear(nav, a.cx, a.cz, b.cx, b.cz, footprintRadius, maxStepVoxels, bodyHalfCells, bodyRoughnessVoxels, headroomVoxels)) break;
      j--;
    }
    out.push(cells[j]!);
    i = j;
  }
  return out;
}
