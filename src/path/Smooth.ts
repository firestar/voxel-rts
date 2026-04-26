import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H } from './SurfaceNav';
import { bodyRoughnessOk } from './AStar';

/**
 * String-pulling: walk a line between two cells using a 2D Bresenham-style supercover and
 * return false the moment any sampled cell is impassable for a unit with the given step
 * limit. Surface pathing relies on climb-step alone; flatness is no longer gated here.
 */
function navLineClear(
  nav: SurfaceNavBuffers,
  ax: number, az: number,
  bx: number, bz: number,
  footprintRadius: number,
  maxStepVoxels: number,
  bodyHalfCells: number,
  bodyRoughnessVoxels: number,
): boolean {
  let x0 = ax, z0 = az;
  const x1 = bx, z1 = bz;
  const dx = Math.abs(x1 - x0);
  const dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;
  const startTopY = nav.topY[navIndex(x0, z0)]!;
  let prevY = startTopY;

  // Larger units get a slightly more generous step limit since A* already verified a
  // climb-feasible cardinal path through the surrounding terrain.
  const stepLimit = maxStepVoxels + (footprintRadius >= 2 ? 2 : 0);

  const guard = dx + dz + 2;
  for (let i = 0; i <= guard; i++) {
    if (x0 < 0 || z0 < 0 || x0 >= NAV_W || z0 >= NAV_H) return false;
    const idx = navIndex(x0, z0);
    if (nav.blocked[idx]) return false;
    const y = nav.topY[idx]!;
    if (Math.abs(y - prevY) > stepLimit) return false;
    prevY = y;
    if (bodyHalfCells > 0 && !bodyRoughnessOk(nav, x0, z0, bodyHalfCells, bodyRoughnessVoxels)) return false;
    if (x0 === x1 && z0 === z1) return true;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x0 += sx; }
    if (e2 < dx) { err += dx; z0 += sz; }
  }
  return false;
}

/**
 * Greedy smoothing: keep the current waypoint, skip ahead while the straight line from it
 * to the next-next waypoint is still passable.
 */
export function smoothPath(
  nav: SurfaceNavBuffers,
  cells: { cx: number; cz: number }[],
  footprintRadius: number,
  maxStepVoxels: number,
  bodyHalfCells: number,
  bodyRoughnessVoxels: number,
): { cx: number; cz: number }[] {
  if (cells.length <= 2) return cells;
  const out: { cx: number; cz: number }[] = [cells[0]!];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1) {
      const a = cells[i]!;
      const b = cells[j]!;
      if (navLineClear(nav, a.cx, a.cz, b.cx, b.cz, footprintRadius, maxStepVoxels, bodyHalfCells, bodyRoughnessVoxels)) break;
      j--;
    }
    out.push(cells[j]!);
    i = j;
  }
  return out;
}
