import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H } from './SurfaceNav';

/**
 * Effective flatness threshold used when probing intermediate cells. Always one less than
 * the unit's full footprint requirement — A* already proved a footprint-strict path exists,
 * so the smoother is allowed to nibble through "almost flat" cells to straighten it out.
 */
function smoothingThreshold(footprintRadius: number): number {
  return Math.max(0, footprintRadius - 1);
}

/**
 * String-pulling: walk a line between two cells using a 2D Bresenham-style supercover and
 * return false the moment any sampled cell is impassable for a unit with the given footprint
 * and step limit. Uses the relaxed flatness threshold so larger units get longer segments.
 */
function navLineClear(
  nav: SurfaceNavBuffers,
  ax: number, az: number,
  bx: number, bz: number,
  footprintRadius: number,
  maxStepVoxels: number,
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
  const flatThresh = smoothingThreshold(footprintRadius);
  const isAgile = footprintRadius <= 1;

  // Larger units may roll over a slightly bigger ledge between adjacent cells than they'd
  // accept for a fresh A* expansion — we know the surrounding terrain is path-feasible.
  const stepLimit = maxStepVoxels + (footprintRadius >= 2 ? 2 : 0);

  const guard = dx + dz + 2;
  for (let i = 0; i <= guard; i++) {
    if (x0 < 0 || z0 < 0 || x0 >= NAV_W || z0 >= NAV_H) return false;
    const idx = navIndex(x0, z0);
    if (nav.blocked[idx]) return false;
    if (!isAgile && nav.flatness[idx]! < flatThresh) return false;
    const y = nav.topY[idx]!;
    if (Math.abs(y - prevY) > stepLimit) return false;
    prevY = y;
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
): { cx: number; cz: number }[] {
  if (cells.length <= 2) return cells;
  const out: { cx: number; cz: number }[] = [cells[0]!];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1) {
      const a = cells[i]!;
      const b = cells[j]!;
      if (navLineClear(nav, a.cx, a.cz, b.cx, b.cz, footprintRadius, maxStepVoxels)) break;
      j--;
    }
    out.push(cells[j]!);
    i = j;
  }
  return out;
}
