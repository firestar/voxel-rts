import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_METERS } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';
import {
  worldToVolumeCell, getBit, vnavIndex, VolumeNavBuffers, VNAV_CELL_METERS,
} from '../path/VolumeNav';

export type UnitKind = 'soldier' | 'tank' | 'tunneler';

interface UnitConfig {
  footprintRadius: number;
  widthMeters: number;
  maxStepVoxels: number;
  slopePenalty: number;
  canDig: boolean;
  requiresGround: boolean;
  speed: number;
  speedDigging: number;
  hp: number;
}

export function unitConfig(kind: UnitKind): UnitConfig {
  switch (kind) {
    case 'soldier':
      return {
        footprintRadius: 1, widthMeters: 0.75,
        maxStepVoxels: 2, slopePenalty: 1.0,
        canDig: false, requiresGround: true,
        speed: 4.5, speedDigging: 0,
        hp: 80,
      };
    case 'tank':
      // Big, capable on rough ground, can use existing tunnels but never digs.
      return {
        footprintRadius: 2, widthMeters: 2.4,
        maxStepVoxels: 6, slopePenalty: 0.25,
        canDig: false, requiresGround: true,
        speed: 3.5, speedDigging: 0,
        hp: 220,
      };
    case 'tunneler':
      // Compact drill rig; happy to chew through stone, narrower than the tank.
      return {
        footprintRadius: 1, widthMeters: 1.0,
        maxStepVoxels: 4, slopePenalty: 0.5,
        canDig: true, requiresGround: true,
        speed: 2.8, speedDigging: 1.4,
        hp: 120,
      };
  }
}

export interface Unit {
  id: number;
  kind: UnitKind;
  /** Footprint half-width in nav cells (1m). */
  footprintRadius: number;
  /** Body diameter in meters — drives the carving radius for tunnelers. */
  widthMeters: number;
  /** Maximum step (voxels) the unit can climb. Cliffs above this are impassable. */
  maxStepVoxels: number;
  /** Per-step slope cost coefficient — soldiers care more, tanks less. */
  slopePenalty: number;
  /** Whether this unit may carve through solid material. Only the Tunneler does. */
  canDig: boolean;
  /** Whether this unit needs solid ground beneath it (no flying). */
  requiresGround: boolean;
  x: number; y: number; z: number;
  heading: number;
  /** Pitch and roll, applied each frame from the surface gradient. */
  pitch: number; roll: number;
  speed: number;          // m/s in clear air
  speedDigging: number;   // m/s while in solid (tunnelers)
  path: { x: number; y: number; z: number }[];
  hp: number;
  selected: boolean;
  /** Time accumulated while a tunneler is in solid; carve when >= the throttle. */
  carveCooldown: number;
  /** Distance traveled in meters — drives walk-cycle phase. */
  distanceWalked: number;
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
    const cfg = unitConfig(kind);
    const u: Unit = {
      id: this.nextId++,
      kind,
      footprintRadius: cfg.footprintRadius,
      widthMeters: cfg.widthMeters,
      maxStepVoxels: cfg.maxStepVoxels,
      slopePenalty: cfg.slopePenalty,
      canDig: cfg.canDig,
      requiresGround: cfg.requiresGround,
      x, y, z,
      heading: 0,
      pitch: 0, roll: 0,
      speed: cfg.speed,
      speedDigging: cfg.speedDigging,
      path: [],
      hp: cfg.hp,
      selected: false,
      carveCooldown: 0,
      distanceWalked: 0,
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
    this.lastSurfaceNav = nav;
    for (const u of this.units) {
      if (u.path.length === 0) {
        if (u.y > 0) sampleSurfaceFollow(u, nav, dt);
        continue;
      }
      // Path waypoints carry their own Y. Use 3D motion when the next waypoint is
      // meaningfully above/below the unit (typical underground / tunnel paths) or
      // when the unit can dig.
      const tgt = u.path[0]!;
      const dy = tgt.y - u.y;
      const using3D = u.canDig || Math.abs(dy) > 0.3;
      if (using3D) this.tickVolume(u, dt, vnav, carveOut);
      else this.tickSurface(u, dt, nav);
    }
  }

  private tickSurface(u: Unit, dt: number, nav: SurfaceNavBuffers): void {
    const tgt = u.path[0]!;
    const dx = tgt.x - u.x;
    const dz = tgt.z - u.z;
    const d = Math.hypot(dx, dz);
    const step = u.speed * dt;
    let moved = 0;
    if (d <= step) {
      moved = d;
      u.x = tgt.x; u.z = tgt.z;
      u.path.shift();
    } else {
      const inv = 1 / d;
      u.x += dx * inv * step;
      u.z += dz * inv * step;
      u.heading = Math.atan2(dx, dz);
      moved = step;
    }
    // Snap to ground and update slope orientation from the surface gradient.
    sampleSurfaceFollow(u, nav, dt);
    u.distanceWalked += moved;
  }

  private tickVolume(
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

    const cell = worldToVolumeCell(tgt.x, tgt.y, tgt.z);
    const ci = vnavIndex(cell.cx, cell.cy, cell.cz);
    const stillSolid = getBit(vnav.solid, ci) === 1;

    if (stillSolid) {
      // Non-diggers can't enter a solid cell. Drop the path so the caller can replan.
      if (!u.canDig) {
        u.path = [];
        return;
      }
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
      u.distanceWalked += d;
      return;
    }
    const inv = 1 / d;
    u.x += dx * inv * step;
    u.y += dy * inv * step;
    u.z += dz * inv * step;
    u.heading = Math.atan2(dx, dz);
    u.distanceWalked += step;
    // Surface units (and tanks above ground) get slope-follow when they're not in a tunnel.
    if (u.y > 0) sampleSurfaceFollow(u, this.lastSurfaceNav, dt);
  }
  /** Last surface nav passed to tick — kept so the tunneler clear-cell branch can slope-follow. */
  private lastSurfaceNav!: SurfaceNavBuffers;
}

/**
 * Snap a surface unit's Y to the topY under it, and ease its pitch / roll toward the slope
 * vector projected into the unit's forward / right axes.
 */
function sampleSurfaceFollow(u: Unit, nav: SurfaceNavBuffers, dt: number): void {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
  const top = nav.topY[navIndex(cx, cz)]!;
  if (top < 0) return;
  const targetY = (top + 1) * VOXEL_SIZE;
  // Ease vertical position so going over crests doesn't snap.
  u.y += (targetY - u.y) * Math.min(1, dt * 12);

  // Central differences (in voxels per cell) → meters per meter.
  const xm1 = nav.topY[navIndex(Math.max(0, cx - 1), cz)]!;
  const xp1 = nav.topY[navIndex(Math.min(NAV_W - 1, cx + 1), cz)]!;
  const zm1 = nav.topY[navIndex(cx, Math.max(0, cz - 1))]!;
  const zp1 = nav.topY[navIndex(cx, Math.min(NAV_H - 1, cz + 1))]!;
  // Convert voxel-difference per 2 cells into rise/run.
  const dydx = ((xp1 - xm1) * VOXEL_SIZE) / (2 * NAV_CELL_METERS);
  const dydz = ((zp1 - zm1) * VOXEL_SIZE) / (2 * NAV_CELL_METERS);

  // Project gradient into the unit's local forward (heading) and right axes.
  // Heading: atan2(dx, dz) — forward = (sin h, 0, cos h); right = (cos h, 0, -sin h).
  const ch = Math.cos(u.heading), sh = Math.sin(u.heading);
  const slopeForward = dydx * sh + dydz * ch;       // along forward
  const slopeRight   = dydx * ch - dydz * sh;       // along right
  // Pitch up when going downhill is negative; pitch up when going uphill is positive.
  const targetPitch = Math.atan(-slopeForward);
  const targetRoll  = Math.atan(slopeRight);
  const k = Math.min(1, dt * 8);
  u.pitch += (targetPitch - u.pitch) * k;
  u.roll  += (targetRoll  - u.roll)  * k;
}
