import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_METERS } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';
import {
  worldToVolumeCell, getBit, vnavIndex, VolumeNavBuffers, VNAV_CELL_METERS,
} from '../path/VolumeNav';

export type UnitKind = 'soldier' | 'tunneler';

export interface Unit {
  id: number;
  kind: UnitKind;
  /** Footprint half-width in nav cells (1m). */
  footprintRadius: number;
  /** Body diameter in meters — drives the carving radius for tunnelers. */
  widthMeters: number;
  x: number; y: number; z: number;
  heading: number;
  speed: number;          // m/s in clear air
  speedDigging: number;   // m/s while in solid (tunnelers)
  path: { x: number; y: number; z: number }[];
  hp: number;
  selected: boolean;
  /** Time accumulated while a tunneler is in solid; carve when >= the throttle. */
  carveCooldown: number;
}

export interface CarveRequest {
  x: number; y: number; z: number;
  radiusMeters: number;
  unit: Unit;
}

const TUNNELER_CARVE_PERIOD = 0.4; // seconds between carves per tunneler

export class UnitManager {
  units: Unit[] = [];
  private nextId = 1;

  spawn(kind: UnitKind, x: number, y: number, z: number): Unit {
    const u: Unit = {
      id: this.nextId++,
      kind,
      footprintRadius: kind === 'soldier' ? 1 : 2,
      widthMeters: kind === 'soldier' ? 0.75 : 1.0,
      x, y, z,
      heading: 0,
      speed: kind === 'soldier' ? 4.5 : 2.5,
      speedDigging: 1.2,
      path: [],
      hp: 100,
      selected: false,
      carveCooldown: 0,
    };
    this.units.push(u);
    return u;
  }

  setPath(unit: Unit, waypoints: { x: number; y: number; z: number }[]): void {
    let i = 0;
    if (waypoints.length > 0) {
      const w = waypoints[0]!;
      const dx = w.x - unit.x;
      const dy = w.y - unit.y;
      const dz = w.z - unit.z;
      if (dx * dx + dy * dy + dz * dz < 0.5 * 0.5) i = 1;
    }
    unit.path = waypoints.slice(i);
    unit.carveCooldown = 0;
  }

  /**
   * Step all unit motion. `carveOut` is invoked when a tunneler needs to clear the next
   * volume cell to advance — the caller should perform a sphere damage at the given world center.
   */
  tick(
    dt: number,
    nav: SurfaceNavBuffers,
    vnav: VolumeNavBuffers,
    carveOut: (req: CarveRequest) => void,
  ): void {
    for (const u of this.units) {
      if (u.path.length === 0) continue;
      if (u.kind === 'tunneler') {
        this.tickTunneler(u, dt, vnav, carveOut);
      } else {
        this.tickSoldier(u, dt, nav);
      }
    }
  }

  private tickSoldier(u: Unit, dt: number, nav: SurfaceNavBuffers): void {
    const tgt = u.path[0]!;
    const dx = tgt.x - u.x;
    const dz = tgt.z - u.z;
    const d = Math.hypot(dx, dz);
    const step = u.speed * dt;
    if (d <= step) {
      u.x = tgt.x; u.z = tgt.z;
      const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
      const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
      const top = nav.topY[navIndex(cx, cz)]!;
      if (top >= 0) u.y = (top + 1) * VOXEL_SIZE;
      u.path.shift();
      return;
    }
    const inv = 1 / d;
    u.x += dx * inv * step;
    u.z += dz * inv * step;
    u.heading = Math.atan2(dx, dz);
    u.y += (tgt.y - u.y) * Math.min(1, dt * 6);
  }

  private tickTunneler(
    u: Unit,
    dt: number,
    vnav: VolumeNavBuffers,
    carveOut: (req: CarveRequest) => void,
  ): void {
    const tgt = u.path[0]!;
    const dx = tgt.x - u.x;
    const dy = tgt.y - u.y;
    const dz = tgt.z - u.z;
    const d = Math.hypot(dx, dy, dz);

    // Determine whether the next waypoint cell is still solid.
    const cell = worldToVolumeCell(tgt.x, tgt.y, tgt.z);
    const ci = vnavIndex(cell.cx, cell.cy, cell.cz);
    const stillSolid = getBit(vnav.solid, ci) === 1;

    if (stillSolid) {
      u.carveCooldown += dt;
      if (u.carveCooldown >= TUNNELER_CARVE_PERIOD) {
        u.carveCooldown = 0;
        carveOut({
          x: (cell.cx + 0.5) * VNAV_CELL_METERS,
          y: (cell.cy + 0.5) * VNAV_CELL_METERS,
          z: (cell.cz + 0.5) * VNAV_CELL_METERS,
          radiusMeters: u.widthMeters * 0.55,
          unit: u,
        });
      }
      // Crawl forward at digging speed.
      const step = u.speedDigging * dt;
      if (d > 0.001) {
        const inv = 1 / d;
        u.x += dx * inv * step;
        u.y += dy * inv * step;
        u.z += dz * inv * step;
        u.heading = Math.atan2(dx, dz);
      }
      return;
    }

    // Cell is clear — normal motion toward waypoint.
    const step = u.speed * dt;
    if (d <= step) {
      u.x = tgt.x; u.y = tgt.y; u.z = tgt.z;
      u.path.shift();
      u.carveCooldown = 0;
      return;
    }
    const inv = 1 / d;
    u.x += dx * inv * step;
    u.y += dy * inv * step;
    u.z += dz * inv * step;
    u.heading = Math.atan2(dx, dz);
  }
}
