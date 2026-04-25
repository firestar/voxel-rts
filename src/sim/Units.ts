import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_METERS } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';

export type UnitKind = 'soldier' | 'tunneler';

export interface Unit {
  id: number;
  kind: UnitKind;
  /** Footprint half-width in nav cells (1m). 1 = 1x1 cell tolerance. */
  footprintRadius: number;
  /** World-space position in meters. */
  x: number; y: number; z: number;
  /** Heading (radians, around Y). */
  heading: number;
  /** Movement speed in m/s. */
  speed: number;
  /** Active waypoint list in meters; consumed front-to-back. */
  path: { x: number; y: number; z: number }[];
  /** Hit points for explosion effects. */
  hp: number;
  selected: boolean;
}

export class UnitManager {
  units: Unit[] = [];
  private nextId = 1;

  spawn(kind: UnitKind, x: number, y: number, z: number): Unit {
    const u: Unit = {
      id: this.nextId++,
      kind,
      footprintRadius: kind === 'soldier' ? 1 : 2,
      x, y, z,
      heading: 0,
      speed: kind === 'soldier' ? 4.5 : 2.5,
      path: [],
      hp: 100,
      selected: false,
    };
    this.units.push(u);
    return u;
  }

  /** Replace a unit's path with new world-space waypoints. */
  setPath(unit: Unit, waypoints: { x: number; y: number; z: number }[]): void {
    // Drop the first waypoint if it's basically where we already are — avoids a stutter.
    let i = 0;
    if (waypoints.length > 0) {
      const w = waypoints[0]!;
      const dx = w.x - unit.x, dz = w.z - unit.z;
      if (dx * dx + dz * dz < 0.5 * 0.5) i = 1;
    }
    unit.path = waypoints.slice(i);
  }

  /** Step all unit motion. */
  tick(dt: number, nav: SurfaceNavBuffers): void {
    for (const u of this.units) {
      if (u.path.length === 0) continue;
      const tgt = u.path[0]!;
      const dx = tgt.x - u.x;
      const dz = tgt.z - u.z;
      const d = Math.hypot(dx, dz);
      const step = u.speed * dt;
      if (d <= step) {
        u.x = tgt.x;
        u.z = tgt.z;
        // Snap Y to surface under the new cell.
        const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
        const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
        const top = nav.topY[navIndex(cx, cz)]!;
        if (top >= 0) u.y = (top + 1) * VOXEL_SIZE;
        u.path.shift();
        continue;
      }
      const inv = 1 / d;
      u.x += dx * inv * step;
      u.z += dz * inv * step;
      u.heading = Math.atan2(dx, dz);
      // Glide Y toward target Y over a few cells to look natural.
      u.y += (tgt.y - u.y) * Math.min(1, dt * 6);
    }
  }
}
