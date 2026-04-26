import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_METERS } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';
import {
  worldToVolumeCell, getBit, vnavIndex, VolumeNavBuffers, VNAV_CELL_METERS,
  VNAV_X, VNAV_Y, VNAV_Z,
} from '../path/VolumeNav';
import {
  TUNNELER_CUTTER_RADIUS, TUNNELER_CUTTER_FORWARD, TUNNELER_CUTTER_HEIGHT,
} from '../render/UnitModels';

export type UnitKind = 'soldier' | 'tank' | 'tunneler';

interface UnitConfig {
  footprintRadius: number;
  widthMeters: number;
  maxStepVoxels: number;
  slopePenalty: number;
  /**
   * Half-extent in nav cells of the unit's body footprint, used by the per-unit
   * "is this terrain even enough under me" check. 0 disables the check (single cell).
   */
  bodyHalfCells: number;
  /**
   * Max allowed (max topY - min topY) in voxels across the footprint cells. If the
   * spread exceeds this, the cell is too rough for this unit and the path search
   * rejects it. Set to a very large number to disable.
   */
  bodyRoughnessVoxels: number;
  /** How fast the unit can rotate around Y, in radians per second. */
  turnRateRadPerSec: number;
  canDig: boolean;
  requiresGround: boolean;
  speed: number;
  speedDigging: number;
  hp: number;
}

export function unitConfig(kind: UnitKind): UnitConfig {
  switch (kind) {
    case 'soldier':
      // Single-cell footprint, so the body-roughness check is a no-op for soldiers.
      return {
        footprintRadius: 1, widthMeters: 0.75,
        maxStepVoxels: 16, slopePenalty: 0.15,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        turnRateRadPerSec: 6.0,                  // ~340°/s, snappy infantry turn
        canDig: false, requiresGround: true,
        speed: 4.5, speedDigging: 0,
        hp: 80,
      };
    case 'tank':
      // 3x3 cells (3 m x 3 m) under the body; max 0.5 m residual from the best-fit plane.
      // Uniform slopes pass (planar = zero residual); ridges/steps that lift a corner
      // above the rest fail. Tank can climb steep hills as long as they're smooth.
      return {
        footprintRadius: 2, widthMeters: 2.4,
        maxStepVoxels: 14, slopePenalty: 0.12,
        bodyHalfCells: 1, bodyRoughnessVoxels: 4,
        turnRateRadPerSec: 1.4,                  // ~80°/s — tank pivots are slow
        canDig: false, requiresGround: true,
        speed: 3.5, speedDigging: 0,
        hp: 220,
      };
    case 'tunneler':
      // 5x5 cells (5 m x 5 m); 0.75 m residual tolerance.
      return {
        footprintRadius: 2, widthMeters: 3.6,
        maxStepVoxels: 10, slopePenalty: 0.18,
        bodyHalfCells: 2, bodyRoughnessVoxels: 6,
        turnRateRadPerSec: 0.7,                  // ~40°/s — heavy machine pivots slowly
        canDig: true, requiresGround: false,
        speed: 2.5, speedDigging: 1.8,
        hp: 320,
      };
  }
}

export interface Unit {
  id: number;
  kind: UnitKind;
  footprintRadius: number;
  widthMeters: number;
  maxStepVoxels: number;
  slopePenalty: number;
  bodyHalfCells: number;
  bodyRoughnessVoxels: number;
  /** Max angular velocity in rad/s. */
  turnRateRadPerSec: number;
  canDig: boolean;
  requiresGround: boolean;
  x: number; y: number; z: number;
  heading: number;
  pitch: number; roll: number;
  speed: number;
  speedDigging: number;
  path: { x: number; y: number; z: number }[];
  hp: number;
  selected: boolean;
  carveCooldown: number;
  distanceWalked: number;
  lastTrackDistance: number;
  /** Frames the unit has been blocked by collision. After enough, the path is cleared. */
  blockedFrames: number;
}

export interface CarveRequest {
  /** Center of the carve volume in world meters. */
  x: number; y: number; z: number;
  /** Carve radius (perpendicular extent for cylinders, full radius for spheres) in meters. */
  radiusMeters: number;
  /**
   * Optional oriented-cylinder carve. When set, the carve volume is a cylinder centered at
   * (x, y, z), extending +/- `halfLengthMeters` along the unit-vector axis (axisX, Y, Z),
   * with `radiusMeters` perpendicular extent. When unset, the carve is a sphere of radius
   * `radiusMeters` centered at (x, y, z).
   */
  axisX?: number; axisY?: number; axisZ?: number;
  halfLengthMeters?: number;
  unit: Unit;
}

const TUNNELER_CARVE_PERIOD = 0.4; // seconds between carves per tunneler
const COLLISION_BLOCK_LIMIT = 6;   // frames stalled before we drop the path

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
      bodyHalfCells: cfg.bodyHalfCells,
      bodyRoughnessVoxels: cfg.bodyRoughnessVoxels,
      turnRateRadPerSec: cfg.turnRateRadPerSec,
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
      lastTrackDistance: 0,
      blockedFrames: 0,
    };
    this.units.push(u);
    return u;
  }

  setPath(unit: Unit, waypoints: { x: number; y: number; z: number }[]): void {
    if (waypoints.length === 0) {
      unit.path = [];
      unit.carveCooldown = 0;
      unit.blockedFrames = 0;
      return;
    }
    let i = 0;
    if (unit.path.length > 0) {
      const fx = -Math.sin(unit.heading);
      const fz = -Math.cos(unit.heading);
      while (i < waypoints.length - 1) {
        const w = waypoints[i]!;
        const dx = w.x - unit.x;
        const dz = w.z - unit.z;
        const distSq = dx * dx + dz * dz;
        const ahead = dx * fx + dz * fz;
        if (distSq > 0.6 * 0.6 && ahead > -0.15) break;
        i++;
      }
    } else {
      const w = waypoints[0]!;
      const dx = w.x - unit.x;
      const dy = w.y - unit.y;
      const dz = w.z - unit.z;
      if (dx * dx + dy * dy + dz * dz < 0.5 * 0.5) i = 1;
    }
    if (i >= waypoints.length) i = waypoints.length - 1;
    unit.path = waypoints.slice(i);
    unit.carveCooldown = 0;
    unit.blockedFrames = 0;
  }

  tick(
    dt: number,
    nav: SurfaceNavBuffers,
    vnav: VolumeNavBuffers,
    carveOut: (req: CarveRequest) => void,
  ): void {
    this.lastSurfaceNav = nav;
    for (const u of this.units) {
      const underground = isUnderground(u, nav);
      if (u.path.length === 0) {
        // Idle: surface-follow only when actually on the surface; underground tunnelers
        // (and any unit caught in a cave) just relax pitch/roll instead of snapping Y up.
        if (!underground) {
          sampleSurfaceFollow(u, nav, dt);
        } else {
          relaxOrientation(u, dt);
        }
        continue;
      }
      const tgt = u.path[0]!;
      const dy = tgt.y - u.y;
      const using3D = u.canDig || underground || Math.abs(dy) > 0.3;
      if (using3D) this.tickVolume(u, dt, nav, vnav, carveOut);
      else this.tickSurface(u, dt, nav);
    }
  }

  /**
   * Surface motion. The path search already enforces blocked + climb-step gating, and the
   * smoother only emits line segments whose adjacent topY deltas are within the unit's
   * climb limit (plus a small slack for fp >= 2). So we trust the path here — there's no
   * runtime "is this cell solid in the volume grid" check, because a surface unit's Y
   * always sits in a volume cell that contains the top voxel itself, which would always
   * read as solid. That false-positive is what was freezing soldiers and tanks.
   */
  private tickSurface(u: Unit, dt: number, nav: SurfaceNavBuffers): void {
    const tgt = u.path[0]!;
    const dx = tgt.x - u.x;
    const dz = tgt.z - u.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) { sampleSurfaceFollow(u, nav, dt); return; }

    // Slew the heading toward the path direction at the unit's turn rate. Until the unit
    // is roughly facing forward, forward speed is reduced (cosine of misalignment), so a
    // tank pivots in place before driving and a soldier sweeps around briskly.
    const targetHeading = Math.atan2(-dx, -dz);
    const angDiff = wrapAngle(targetHeading - u.heading);
    const turnStep = u.turnRateRadPerSec * dt;
    u.heading += clamp(angDiff, -turnStep, turnStep);

    const align = Math.max(0, Math.cos(Math.abs(angDiff)));
    const step = u.speed * align * dt;

    let moved = 0;
    if (step >= d) {
      moved = d;
      u.x = tgt.x; u.z = tgt.z;
      u.path.shift();
    } else if (step > 0) {
      const inv = 1 / d;
      u.x += dx * inv * step;
      u.z += dz * inv * step;
      moved = step;
    }
    u.blockedFrames = 0;
    sampleSurfaceFollow(u, nav, dt);
    u.distanceWalked += moved;
  }

  private tickVolume(
    u: Unit,
    dt: number,
    nav: SurfaceNavBuffers,
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
      if (!u.canDig) {
        // Path now requires going through solid, but we can't dig. Stop and request replan.
        u.path = [];
        u.blockedFrames = 0;
        applyPathOrientation(u, dx, dy, dz, dt);
        return;
      }
      const step = u.speedDigging * dt;
      if (d > 0.001) {
        const inv = 1 / d;
        u.x += dx * inv * step;
        u.y += dy * inv * step;
        u.z += dz * inv * step;
        applyPathOrientation(u, dx, dy, dz, dt);
      }
      u.distanceWalked += step;
      this.maybeCarveAtCutter(u, dt, dx, dy, dz, d, carveOut);
      return;
    }

    // Cell is clear — propose normal motion toward waypoint, then collision-check it.
    const step = u.speed * dt;
    let nextX: number, nextY: number, nextZ: number, snapping = false;
    if (d <= step) {
      nextX = tgt.x; nextY = tgt.y; nextZ = tgt.z;
      snapping = true;
    } else {
      const inv = 1 / d;
      nextX = u.x + dx * inv * step;
      nextY = u.y + dy * inv * step;
      nextZ = u.z + dz * inv * step;
    }
    if (!volumePassable(u, vnav, nextX, nextY, nextZ)) {
      // Would clip through solid (or bedrock). Don't move this frame.
      u.blockedFrames++;
      if (u.blockedFrames >= COLLISION_BLOCK_LIMIT) u.path = [];
      applyPathOrientation(u, dx, dy, dz, dt);
      return;
    }
    u.blockedFrames = 0;
    const consumed = snapping ? d : step;
    u.x = nextX; u.y = nextY; u.z = nextZ;
    if (snapping) {
      u.path.shift();
      u.carveCooldown = 0;
    }
    u.distanceWalked += consumed;
    applyPathOrientation(u, dx, dy, dz, dt);
    // Surface-follow only when we've actually emerged onto the surface — otherwise the
    // unit is following its 3D path Y, no snapping.
    if (!isUnderground(u, nav)) {
      sampleSurfaceFollow(u, nav, dt);
    }
    this.maybeCarveAtCutter(u, dt, dx, dy, dz, d, carveOut);
  }

  private maybeCarveAtCutter(
    u: Unit, dt: number,
    dx: number, dy: number, dz: number, d: number,
    carveOut: (req: CarveRequest) => void,
  ): void {
    if (!u.canDig) return;
    if (d < 1e-3) return;
    u.carveCooldown += dt;
    if (u.carveCooldown < TUNNELER_CARVE_PERIOD) return;
    u.carveCooldown = 0;
    const inv = 1 / d;
    const fx = dx * inv, fy = dy * inv, fz = dz * inv;

    // Tunneling only happens at the blade itself: an oriented cylinder 2 voxels deep
    // along the unit's forward axis, with its perpendicular extent equal to the cutter
    // radius plus one voxel of clearance on every side.
    //
    // The cylinder center sits one voxel in front of the blade face, so the cylinder
    // covers from the blade face out to two voxels ahead.
    const VOXEL = 0.125;
    const halfLength = VOXEL;                   // 2 voxels of total depth
    const radius = TUNNELER_CUTTER_RADIUS + VOXEL;
    // Blade face is at TUNNELER_CUTTER_FORWARD relative to the unit. Push the cylinder
    // center halfLength forward of that so the cylinder occupies the volume immediately
    // in front of the blade.
    const centerForward = TUNNELER_CUTTER_FORWARD + halfLength;
    carveOut({
      x: u.x + fx * centerForward,
      y: u.y + TUNNELER_CUTTER_HEIGHT + fy * centerForward,
      z: u.z + fz * centerForward,
      axisX: fx, axisY: fy, axisZ: fz,
      halfLengthMeters: halfLength,
      radiusMeters: radius,
      unit: u,
    });
  }
  private lastSurfaceNav!: SurfaceNavBuffers;
}

/**
 * True when the unit is meaningfully below the local surface — used to suppress the
 * surface-follow Y snap (which otherwise yanks underground units up to the ceiling).
 */
function isUnderground(u: Unit, nav: SurfaceNavBuffers): boolean {
  return u.y < surfaceWorldY(nav, u.x, u.z) - 0.5;
}

/**
 * True if the world-space position (wx, wy, wz) is enterable for this unit:
 *  - inside the world's volume bounds
 *  - not bedrock
 *  - not solid (unless the unit can dig — tunnelers carve their way in)
 */
function volumePassable(u: Unit, vnav: VolumeNavBuffers, wx: number, wy: number, wz: number): boolean {
  const cx = Math.floor(wx / VNAV_CELL_METERS);
  const cy = Math.floor(wy / VNAV_CELL_METERS);
  const cz = Math.floor(wz / VNAV_CELL_METERS);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= VNAV_X || cy >= VNAV_Y || cz >= VNAV_Z) return false;
  const i = vnavIndex(cx, cy, cz);
  if (getBit(vnav.bedrock, i)) return false;
  const isSolid = getBit(vnav.solid, i) === 1;
  if (isSolid && !u.canDig) return false;
  return true;
}

function applyPathOrientation(u: Unit, dx: number, dy: number, dz: number, dt: number): void {
  const horiz = Math.hypot(dx, dz);
  if (horiz > 1e-4) {
    const targetHeading = Math.atan2(-dx, -dz);
    const angDiff = wrapAngle(targetHeading - u.heading);
    const turnStep = u.turnRateRadPerSec * dt;
    u.heading += clamp(angDiff, -turnStep, turnStep);
  }
  const targetPitch = Math.atan2(-dy, Math.max(horiz, 1e-4));
  const k = Math.min(1, dt * 8);
  u.pitch += (targetPitch - u.pitch) * k;
  u.roll  += (0           - u.roll ) * k;
}

/** Shortest signed angle in (-π, π]. */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Idle underground / aerial: ease pitch & roll to neutral so the unit doesn't sit askew. */
function relaxOrientation(u: Unit, dt: number): void {
  const k = Math.min(1, dt * 4);
  u.pitch += (0 - u.pitch) * k;
  u.roll  += (0 - u.roll)  * k;
}

function surfaceWorldY(nav: SurfaceNavBuffers, wx: number, wz: number): number {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
  const top = nav.topY[navIndex(cx, cz)]!;
  return top < 0 ? 0 : (top + 1) * VOXEL_SIZE;
}

function sampleSurfaceFollow(u: Unit, nav: SurfaceNavBuffers, dt: number): void {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
  const top = nav.topY[navIndex(cx, cz)]!;
  if (top < 0) return;
  const targetY = (top + 1) * VOXEL_SIZE;
  // Climb is fast (the unit was already gated by maxStepVoxels at path time so we trust
  // the path here). Descent is capped at a constant rate so walking off a ledge doesn't
  // snap straight down — the unit falls at a controlled speed and then catches up to
  // the ground.
  const dyDesired = targetY - u.y;
  if (dyDesired >= 0) {
    u.y += dyDesired * Math.min(1, dt * 12);
  } else {
    const maxDescentMPS = 4.0;
    u.y = Math.max(targetY, u.y - maxDescentMPS * dt);
  }

  const xm1 = nav.topY[navIndex(Math.max(0, cx - 1), cz)]!;
  const xp1 = nav.topY[navIndex(Math.min(NAV_W - 1, cx + 1), cz)]!;
  const zm1 = nav.topY[navIndex(cx, Math.max(0, cz - 1))]!;
  const zp1 = nav.topY[navIndex(cx, Math.min(NAV_H - 1, cz + 1))]!;
  const dydx = ((xp1 - xm1) * VOXEL_SIZE) / (2 * NAV_CELL_METERS);
  const dydz = ((zp1 - zm1) * VOXEL_SIZE) / (2 * NAV_CELL_METERS);

  const ch = Math.cos(u.heading), sh = Math.sin(u.heading);
  const slopeForward = dydx * sh + dydz * ch;
  const slopeRight   = dydx * ch - dydz * sh;
  const targetPitch = Math.atan(-slopeForward);
  const targetRoll  = Math.atan(slopeRight);
  const k = Math.min(1, dt * 8);
  u.pitch += (targetPitch - u.pitch) * k;
  u.roll  += (targetRoll  - u.roll)  * k;
}
