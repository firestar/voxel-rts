import { SurfaceNavBuffers, navIndex, NAV_W, NAV_H, NAV_CELL_METERS } from '../path/SurfaceNav';
import { VOXEL_SIZE, WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../voxel/types';
import { worldIndex } from '../voxel/VoxelWorld';
import { digSpeedMultiplier, groundSpeedMultiplier, M_WOOD, M_LEAF } from '../voxel/Materials';
import {
  worldToVolumeCell, getBit, vnavIndex, VolumeNavBuffers, VNAV_CELL_METERS,
  VNAV_X, VNAV_Y, VNAV_Z,
} from '../path/VolumeNav';
import {
  TUNNELER_CUTTER_RADIUS, TUNNELER_CUTTER_FORWARD, TUNNELER_CUTTER_HEIGHT,
} from '../render/UnitModels';

export type UnitKind = 'soldier' | 'tank' | 'tunneler';

/** Downward acceleration in m/s². Slightly snappier than real-world 9.81 — units feel
 *  "weighty" without dragging out the fall arc. Per-unit terminal velocity then sets
 *  how hard each kind eventually falls. */
const GRAVITY = 22;

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
  /** Hard cap on visual + path-plan pitch angle, radians. Volume A* rejects edges that
   *  would require a steeper climb/dive, and applyPathOrientation clamps the rendered
   *  body pitch to this value so the model never tips past it. */
  maxPitchRad: number;
  /** Unit's vertical extent in voxels (head/turret/cab clearance). The surface path
   *  search rejects cells whose `headroom` (air above topY) is less than this — keeps
   *  units out of cells where their head would clip a tree canopy or overhang. */
  heightVoxels: number;
  canDig: boolean;
  requiresGround: boolean;
  speed: number;
  speedDigging: number;
  hp: number;
  /** Unit mass in kilograms. Drives terminal-velocity scaling (heavier units settle
   *  to a higher cap because they shed more drag per kilogram). Also useful as a
   *  general weight reference for any later "tank crushes a soldier" interactions. */
  massKg: number;
  /** Magnitude of the terminal vertical velocity in m/s. Stored positive; falling
   *  velocity is clamped at -terminalFallSpeed. */
  terminalFallSpeed: number;
}

export function unitConfig(kind: UnitKind): UnitConfig {
  switch (kind) {
    case 'soldier':
      // Single-cell footprint, so the body-roughness check is a no-op for soldiers.
      // maxStepVoxels = 32 voxels (4 m climb between adjacent cells) — effectively
      // soldiers scale anything that isn't a building wall. The path search also
      // skips the diagonal corner-cut for agile units (footprintRadius <= 1), so
      // a soldier can scramble onto a ledge from the inside of an L-shaped corner.
      return {
        footprintRadius: 1, widthMeters: 0.75,
        maxStepVoxels: 32, slopePenalty: 0.08,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        turnRateRadPerSec: 6.0,                  // ~340°/s, snappy infantry turn
        maxPitchRad: Math.PI / 2,                // soldiers are flexible — no real pitch cap
        heightVoxels: 14,                        // ~1.75 m head clearance
        canDig: false, requiresGround: true,
        speed: 4.5, speedDigging: 0,
        hp: 80,
        massKg: 80,                              // a person in full kit
        terminalFallSpeed: 28,                   // skydiver-ish cap
      };
    case 'tank':
      // Tanks are restricted to fairly flat terrain.
      //   maxStepVoxels = 4 voxels (0.5 m climb between adjacent 1 m cells, ~27° slope).
      //   bodyRoughnessVoxels = 5 (0.625 m residual from the plane fit) — uniform slopes
      //     up to that 27° still pass, but ridges and rocky bumps are rejected.
      //   slopePenalty = 0.25 — A* actively prefers flatter routes even when steeper
      //     ones are technically allowed.
      // Cliffs / steep hills now hard-block tank routes; the unit will detour around
      // them instead of trying to scale them.
      return {
        footprintRadius: 2, widthMeters: 2.4,
        maxStepVoxels: 4, slopePenalty: 0.25,
        bodyHalfCells: 1, bodyRoughnessVoxels: 5,
        turnRateRadPerSec: 1.4,                  // ~80°/s — tank pivots are slow
        maxPitchRad: Math.PI / 6,                // 30° — pitched body cap matches the climb cap
        heightVoxels: 18,                        // ~2.25 m turret + antenna clearance
        canDig: false, requiresGround: true,
        speed: 3.5, speedDigging: 0,
        hp: 220,
        massKg: 50_000,                          // ~50 t — main battle tank
        terminalFallSpeed: 45,                   // heavier shell, drags less per kg
      };
    case 'tunneler':
      // 5x5 cells (5 m x 5 m); 9 voxels (≈1.1 m) residual tolerance — generous because
      // the cutter levels its own bench as it goes.
      // Ground-locked like the tank: it can carve through anything but it can't levitate
      // through open air. Tunnels it digs leave a solid floor underneath, so this still
      // lets the unit walk along its own freshly-bored shafts.
      // maxStepVoxels = 14 voxels (1.75 m climb ≈ 60° slope) — wider machine than the
      // tank, but with the cutter pulling it up steep grades.
      return {
        footprintRadius: 2, widthMeters: 3.6,
        maxStepVoxels: 14, slopePenalty: 0.15,
        bodyHalfCells: 2, bodyRoughnessVoxels: 9,
        turnRateRadPerSec: 0.7,                  // ~40°/s — heavy machine pivots slowly
        maxPitchRad: 40 * Math.PI / 180,         // 40° — capped dig angle in either direction
        heightVoxels: 22,                        // ~2.75 m for the cab + exhaust stack
        canDig: true, requiresGround: true,
        speed: 1.6, speedDigging: 1.2,
        hp: 320,
        massKg: 150_000,                         // ~150 t — full TBM with cutter head
        terminalFallSpeed: 55,                   // dense + low drag per kg → falls hardest
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
  /** Max climb / dive pitch in radians. */
  maxPitchRad: number;
  /** Vertical extent of the unit in voxels — used to gate cells with too-low headroom. */
  heightVoxels: number;
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
  /** Frames the unit has been blocked by collision. We pause motion but don't drop
   *  the path — gravity / terrain edits may resolve the block. */
  blockedFrames: number;
  /** Vertical velocity in m/s. Negative = falling. Reset to 0 on landing. */
  vy: number;
  /** Mass in kg — see UnitConfig.massKg. */
  massKg: number;
  /** Magnitude of terminal fall velocity in m/s — see UnitConfig.terminalFallSpeed. */
  terminalFallSpeed: number;
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
  /**
   * Optional hard floor in world meters. Voxels below this Y are not damaged. The
   * tunneler uses this to cap its cutter at its own body bottom (u.y) so the
   * disc-shaped cylinder doesn't carve out the floor underneath.
   */
  floorMeters?: number;
  unit: Unit;
}


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
      maxPitchRad: cfg.maxPitchRad,
      heightVoxels: cfg.heightVoxels,
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
      vy: 0,
      massKg: cfg.massKg,
      terminalFallSpeed: cfg.terminalFallSpeed,
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
    voxels: Uint8Array,
    carveOut: (req: CarveRequest) => void,
  ): void {
    this.lastSurfaceNav = nav;
    this.lastVoxels = voxels;
    for (const u of this.units) {
      const underground = isUnderground(u, nav);
      if (u.path.length === 0) {
        // Idle: surface-follow only when actually on the surface; underground tunnelers
        // (and any unit caught in a cave) just relax pitch/roll instead of snapping Y up.
        if (!underground) {
          sampleSurfaceFollow(u, nav, this.lastVoxels, dt);
        } else {
          relaxOrientation(u, dt);
        }
        continue;
      }
      const tgt = u.path[0]!;
      // Pick the surface tick whenever the unit is on the surface and the next waypoint
      // is also on the surface. The previous heuristic — "switch to volume motion if
      // |dy| > 0.3" — fired for every uphill step on natural hills (waypoints sit at
      // each cell's topY, so a 1 m hillside produces dy = 1 m). tickVolume's clear
      // branch then ran a volumePassable() check whose volume cell *contains* the
      // surface voxel, so it always read as solid → blockedFrames ticked up →
      // path cleared after 6 frames. The result was paths planned correctly but
      // canceled mid-stride on any climb.
      const tgtSurfaceY = surfaceWorldY(nav, tgt.x, tgt.z);
      const tgtUnderground = tgt.y < tgtSurfaceY - 0.5;
      const using3D = u.canDig || underground || tgtUnderground;
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
    if (d < 1e-4) { sampleSurfaceFollow(u, nav, this.lastVoxels, dt); return; }

    // Slew the heading toward the path direction at the unit's turn rate. Until the unit
    // is roughly facing forward, forward speed is reduced (cosine of misalignment), so a
    // tank pivots in place before driving and a soldier sweeps around briskly.
    const targetHeading = Math.atan2(-dx, -dz);
    const angDiff = wrapAngle(targetHeading - u.heading);
    const turnStep = u.turnRateRadPerSec * dt;
    u.heading += clamp(angDiff, -turnStep, turnStep);

    const align = Math.max(0, Math.cos(Math.abs(angDiff)));
    // Surface material under the unit modulates speed — mud bogs vehicles down, paths
    // give a small bonus. Sample the cell-level top material; for soldiers this barely
    // matters but is consistent with the tank/tunneler.
    const cx0 = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
    const cz0 = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
    const groundMat = nav.material[navIndex(cx0, cz0)]!;
    const groundMult = groundSpeedMultiplier(groundMat);
    const step = u.speed * align * groundMult * dt;

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
    sampleSurfaceFollow(u, nav, this.lastVoxels, dt);
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
      // Always carve at the blade — we're explicitly digging through solid here, so
      // bypass the surface engagement gate. Forward motion is gated below on the
      // cleared volume so the body never moves through unbroken voxels.
      this.maybeCarveAtCutter(u, dt, dx, dy, dz, d, carveOut, true);
      // Per-material dig speed. Sample the live voxel sitting at (or just past) the
      // blade face — that's the material the cutter is currently chewing through. A
      // multiplier of 0.3 in stone vs 1.0 in dirt makes the tunneler feel like an
      // actual TBM rather than a uniform cell-eater. Air at the cutter (e.g. cutter
      // is poking into a chamber) reads as 1.0 so the unit can coast through.
      const inv = d > 1e-3 ? 1 / d : 0;
      const fx = dx * inv, fy = dy * inv, fz = dz * inv;
      const cutterMat = sampleCutterMaterial(this.lastVoxels, u, fx, fy, fz);
      const speedMult = digSpeedMultiplier(cutterMat);
      const step = u.speedDigging * speedMult * dt;
      const clearAhead = inv === 0
        ? true
        : voxelSlabClear(this.lastVoxels, u.x, u.y, u.z, fx, fy, fz, step);
      if (clearAhead && d > 0.001 && step > 0) {
        u.x += fx * step;
        u.y += fy * step;
        u.z += fz * step;
        u.distanceWalked += step;
      }
      // The cutter face is grinding into solid — that contact holds the unit, so any
      // residual fall velocity from a previous mid-air arc is killed here.
      u.vy = 0;
      applyPathOrientation(u, dx, dy, dz, dt);
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
      // Would clip through solid (or bedrock). Pause motion this frame, but DON'T
      // drop the path — the unit might be momentarily mid-air and gravity will
      // settle it back into a valid spot, or terrain edits may open the way. We
      // still bump blockedFrames for telemetry, just no longer act on it.
      u.blockedFrames++;
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
    // Vertical positioning. Three regimes:
    //   1. Above the local surface — surface nav drives the snap (handles hills).
    //   2. Underground in air with solid below (a tunnel floor) — snap to that floor so
    //      the tunneler walks the floor instead of floating at cell center.
    //   3. Underground in air with no solid within reach — leave the path Y alone (the
    //      unit is genuinely in the middle of an open volume, e.g. mid-jump into a cave).
    if (!isUnderground(u, nav)) {
      sampleSurfaceFollow(u, nav, this.lastVoxels, dt);
    } else {
      // Probe deep enough that a fast-falling unit (tunneler at terminal velocity)
      // still sees the floor it's about to hit this frame.
      const probeDepth = Math.max(3.0, -u.vy * dt + 1.0);
      const floorY = findFloorBelow(this.lastVoxels, u.x, u.y + 0.4, u.z, probeDepth);
      if (floorY !== null && floorY >= u.y) {
        // Floor is at or above feet — climb the step (e.g. up onto a tunnel ledge).
        u.y += (floorY - u.y) * Math.min(1, dt * 12);
        u.vy = 0;
      } else {
        // No floor under our feet within reach (or it's below us): accelerate downward
        // under gravity and clamp at the unit's terminal velocity. When a floor is
        // present below, land on it crisply.
        u.vy = Math.max(-u.terminalFallSpeed, u.vy - GRAVITY * dt);
        u.y += u.vy * dt;
        if (floorY !== null && u.y < floorY) {
          u.y = floorY;
          u.vy = 0;
        }
      }
    }
    this.maybeCarveAtCutter(u, dt, dx, dy, dz, d, carveOut);
  }

  private maybeCarveAtCutter(
    u: Unit, _dt: number,
    dx: number, dy: number, dz: number, d: number,
    carveOut: (req: CarveRequest) => void,
    forceCarve = false,
  ): void {
    if (!u.canDig) return;
    if (d < 1e-3) return;
    const inv = 1 / d;
    const fx = dx * inv, fy = dy * inv, fz = dz * inv;

    const VOXEL = 0.125;
    // Total cylinder depth = 2 * halfLength = 4 voxels along the forward axis.
    // Perpendicular extent = cutter radius + 3 voxels of clearance on every side.
    const halfLength = VOXEL * 2;                          // 4 voxels of total depth
    const radius = TUNNELER_CUTTER_RADIUS + VOXEL * 3;
    const centerForward = TUNNELER_CUTTER_FORWARD + halfLength;
    const cutterX = u.x + fx * centerForward;
    const cutterY = u.y + TUNNELER_CUTTER_HEIGHT + fy * centerForward;
    const cutterZ = u.z + fz * centerForward;

    // Engagement gate, only applied when the caller hasn't explicitly opted into carving.
    // Without this, a surface tunneler driving on flat ground would chew the grass with
    // its disc-shaped cutter (the disc dips below the ground because the cutter sits
    // 1.10 m above the feet but the disc has 1.83 m radius). The solid branch passes
    // forceCarve=true because we already know the destination cell is in solid material.
    if (!forceCarve) {
      const surfaceAtUnit = surfaceWorldY(this.lastSurfaceNav, u.x, u.z);
      const surfaceAtCutter = surfaceWorldY(this.lastSurfaceNav, cutterX, cutterZ);
      const unitUnderground = u.y < surfaceAtUnit - 0.4;
      const cutterInSolid = cutterY < surfaceAtCutter - 0.3;
      if (!unitUnderground && !cutterInSolid) return;
    }

    carveOut({
      x: cutterX, y: cutterY, z: cutterZ,
      axisX: fx, axisY: fy, axisZ: fz,
      halfLengthMeters: halfLength,
      radiusMeters: radius,
      // Don't carve below the unit's body bottom — keeps the cutter from eating
      // the floor underneath the tunneler and dropping it into its own hole.
      // Exception: when the dig direction is downward, eating the floor is the
      // whole point, so drop the guard and let the cutter chew straight down.
      floorMeters: fy < 0 ? -Infinity : u.y,
      unit: u,
    });
  }
  private lastSurfaceNav!: SurfaceNavBuffers;
  private lastVoxels!: Uint8Array;
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
/**
 * Runtime motion gate for the volume nav. A position is passable iff the cell at that
 * world position is **air**. Bedrock and any solid cell are rejected unconditionally —
 * the canDig flag is a *path-planning* concession that lets A* route through soil for
 * tunnelers, but at runtime even a tunneler must enter solid through the explicit
 * solid-branch carve loop in tickVolume (carve at the blade, gate the advance on
 * voxelSlabClear). Letting canDig pass through here was the clipping bug.
 */
function volumePassable(_u: Unit, vnav: VolumeNavBuffers, wx: number, wy: number, wz: number): boolean {
  const cx = Math.floor(wx / VNAV_CELL_METERS);
  const cy = Math.floor(wy / VNAV_CELL_METERS);
  const cz = Math.floor(wz / VNAV_CELL_METERS);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= VNAV_X || cy >= VNAV_Y || cz >= VNAV_Z) return false;
  const i = vnavIndex(cx, cy, cz);
  if (getBit(vnav.bedrock, i)) return false;
  if (getBit(vnav.solid, i) === 1) return false;
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
  const rawPitch = Math.atan2(-dy, Math.max(horiz, 1e-4));
  // Cap pitch to the unit's limit so the body never tips past it — even if the path
  // happens to require a steeper local slope, the model stays at the cap and the
  // motion uses the un-clamped path Y under the hood.
  const targetPitch = clamp(rawPitch, -u.maxPitchRad, u.maxPitchRad);
  const k = Math.min(1, dt * 8);
  u.pitch += (targetPitch - u.pitch) * k;
  u.roll  += (0           - u.roll ) * k;
}

/**
 * Read the voxel at the cutter face — used to pick the per-material dig speed.
 *
 * We sample the voxel sitting at TUNNELER_CUTTER_FORWARD + 1 voxel ahead of the unit
 * along its current motion direction, at the cutter's vertical offset. That's the
 * voxel the cutter is actively grinding, so its material drives how fast we advance.
 * Out-of-bounds reads as AIR.
 */
function sampleCutterMaterial(
  voxels: Uint8Array,
  u: Unit,
  fx: number, fy: number, fz: number,
): number {
  const aheadM = TUNNELER_CUTTER_FORWARD + 0.125; // 1 voxel past the blade face
  const wx = u.x + fx * aheadM;
  const wy = u.y + TUNNELER_CUTTER_HEIGHT + fy * aheadM;
  const wz = u.z + fz * aheadM;
  const vx = Math.floor(wx / VOXEL_SIZE);
  const vy = Math.floor(wy / VOXEL_SIZE);
  const vz = Math.floor(wz / VOXEL_SIZE);
  if (vx < 0 || vy < 0 || vz < 0 || vx >= WORLD_X || vy >= WORLD_Y || vz >= WORLD_Z) return AIR;
  return voxels[worldIndex(vx, vy, vz)]!;
}

/**
 * Walk the voxel column at (wx, wz) downward from wy until a solid voxel is found.
 * Returns the world-space Y of that voxel's top face, or null if no solid was hit
 * within `maxDownM` meters (or we walked off the world).
 *
 * Used to snap an underground tunneler onto the floor of whatever tunnel it's in,
 * instead of floating at the cell-center Y the path waypoints carry.
 */
function findFloorBelow(
  voxels: Uint8Array,
  wx: number, wy: number, wz: number,
  maxDownM: number,
): number | null {
  const vx = Math.floor(wx / VOXEL_SIZE);
  const vz = Math.floor(wz / VOXEL_SIZE);
  if (vx < 0 || vx >= WORLD_X || vz < 0 || vz >= WORLD_Z) return null;
  const vyStart = Math.floor(wy / VOXEL_SIZE);
  const maxDown = Math.ceil(maxDownM / VOXEL_SIZE);
  for (let dy = 0; dy <= maxDown; dy++) {
    const vy = vyStart - dy;
    if (vy < 0) return null;
    if (voxels[worldIndex(vx, vy, vz)] !== AIR) {
      return (vy + 1) * VOXEL_SIZE; // top of this solid voxel, meters
    }
  }
  return null;
}

/**
 * Probe a thin slab of voxels right past the cutter face. Returns true when every sample
 * is air, i.e. the carve has actually opened the volume the body would advance into.
 *
 * `(fx, fy, fz)` is the unit-vector forward direction; `step` is how far the unit wants to
 * move this frame. We sample a 4x4 grid of voxels in the plane perpendicular to forward,
 * sized to the cutter, located at `TUNNELER_CUTTER_FORWARD + step / 2` in front of the
 * unit's origin so the slab covers the volume between the blade face and where the body
 * would be after the move.
 */
function voxelSlabClear(
  voxels: Uint8Array,
  ux: number, uy: number, uz: number,
  fx: number, fy: number, fz: number,
  step: number,
): boolean {
  // Build any unit vector orthogonal to forward in the horizontal plane, then a third
  // perpendicular to both. Together they span the disc we want to sample.
  let rx = -fz, ry = 0, rz = fx;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
  rx /= rl; ry /= rl; rz /= rl;
  // up = forward × right
  const ux2 = fy * rz - fz * ry;
  const uy2 = fz * rx - fx * rz;
  const uz2 = fx * ry - fy * rx;

  const aheadDist = TUNNELER_CUTTER_FORWARD + step * 0.5;
  const cx = ux + fx * aheadDist;
  const cy = uy + TUNNELER_CUTTER_HEIGHT + fy * aheadDist;
  const cz = uz + fz * aheadDist;
  // Sample a 4x4 grid covering the cutter cross-section (radius + 1 voxel margin).
  const SAMPLES = 4;
  const r = TUNNELER_CUTTER_RADIUS + VOXEL_SIZE;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / (SAMPLES - 1)) * 2 - 1; // -1..+1
    for (let j = 0; j < SAMPLES; j++) {
      const b = (j / (SAMPLES - 1)) * 2 - 1;
      // Inside the cutter disc only.
      if (a * a + b * b > 1) continue;
      const px = cx + (rx * a + ux2 * b) * r;
      const py = cy + (ry * a + uy2 * b) * r;
      const pz = cz + (rz * a + uz2 * b) * r;
      const vx = Math.floor(px / VOXEL_SIZE);
      const vy = Math.floor(py / VOXEL_SIZE);
      const vz = Math.floor(pz / VOXEL_SIZE);
      if (vx < 0 || vy < 0 || vz < 0 || vx >= WORLD_X || vy >= WORLD_Y || vz >= WORLD_Z) continue;
      if (voxels[worldIndex(vx, vy, vz)] !== AIR) return false;
    }
  }
  return true;
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
  // Pitch eases noticeably faster than before (was dt*4) so when a tunneler reaches its
  // destination it stops nose-down within a fraction of a second instead of holding the
  // last dig pitch for ~1 s. Roll eases at the original rate.
  const kPitch = Math.min(1, dt * 10);
  const kRoll  = Math.min(1, dt * 4);
  u.pitch += (0 - u.pitch) * kPitch;
  u.roll  += (0 - u.roll)  * kRoll;
}

function surfaceWorldY(nav: SurfaceNavBuffers, wx: number, wz: number): number {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
  const top = nav.topY[navIndex(cx, cz)]!;
  return top < 0 ? 0 : (top + 1) * VOXEL_SIZE;
}

/**
 * Find the highest top voxel anywhere under the unit's footprint at (wx, wz). We
 * scan the live voxel column at a small grid of points spanning ±halfWidth, walking
 * downward from a search ceiling sourced from the surface nav's cell-level topY.
 *
 * Returning the MAX over the footprint is what stops a wide chassis from clipping
 * into voxels that are taller than the cell-average — the unit is placed on top
 * of the highest voxel under any tread/foot, never inside one. (The path search
 * already guaranteed the cells are climb-feasible.)
 *
 * Returns null if no solid voxel is found in the search range.
 */
function findFootprintTopVoxel(
  voxels: Uint8Array,
  nav: SurfaceNavBuffers,
  wx: number, wz: number,
  halfWidthM: number,
  searchRangeVoxels = 12,
): number | null {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
  const cellTop = nav.topY[navIndex(cx, cz)]!;
  if (cellTop < 0) return null;
  // Sample a small grid covering the footprint. 3x3 is enough — the path search
  // already verified roughness over a wider radius for vehicles.
  const SAMPLES: number = 3;
  const startY = Math.min(cellTop + searchRangeVoxels, WORLD_Y - 1);
  const endY = Math.max(0, cellTop - searchRangeVoxels);
  let best = -1;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const t = SAMPLES === 1 ? 0 : (i / (SAMPLES - 1)) * 2 - 1; // -1..+1
      const u = SAMPLES === 1 ? 0 : (j / (SAMPLES - 1)) * 2 - 1;
      const sx = wx + t * halfWidthM;
      const sz = wz + u * halfWidthM;
      const vx = Math.floor(sx / VOXEL_SIZE);
      const vz = Math.floor(sz / VOXEL_SIZE);
      if (vx < 0 || vz < 0 || vx >= WORLD_X || vz >= WORLD_Z) continue;
      // Walk down from the ceiling looking for the first WALKABLE voxel. Tree
      // voxels (wood / leaf) are skipped — units stand on the ground under
      // canopies, not on top of the canopy. Without this skip, a footprint
      // sample landing in a tree column made the unit hover at the canopy top.
      const top = Math.min(startY, WORLD_Y - 1);
      for (let y = top; y >= endY; y--) {
        const m = voxels[worldIndex(vx, y, vz)];
        if (m === AIR || m === M_WOOD || m === M_LEAF) continue;
        if (y > best) best = y;
        break;
      }
    }
  }
  return best >= 0 ? best : null;
}

function sampleSurfaceFollow(u: Unit, nav: SurfaceNavBuffers, voxels: Uint8Array, dt: number): void {
  // Use the live voxel column under the unit's footprint to find the actual highest
  // top voxel — not the cell-average topY (which can leave a wide chassis clipping
  // into a higher voxel inside the same cell). The path search already proved the
  // cells are climb-feasible, so we trust it and just keep the unit visually on
  // top of the terrain.
  const halfWidthM = u.widthMeters * 0.5;
  const topVoxel = findFootprintTopVoxel(voxels, nav, u.x, u.z, halfWidthM);
  if (topVoxel === null) return;
  const targetY = (topVoxel + 1) * VOXEL_SIZE;
  // Climb is fast (the unit was already gated by maxStepVoxels at path time so we trust
  // the path here). Falling uses real gravity so the unit accelerates downward
  // off a ledge or out of mid-air, with a terminal-velocity cap, and lands
  // crisply on the surface (vy reset to 0). Both directions sit on top of the
  // walkable topY — never below — so the unit's feet are always on solid ground.
  const dyDesired = targetY - u.y;
  if (dyDesired >= 0) {
    // Climbing or already at floor: snap up, kill any residual fall velocity.
    u.y += dyDesired * Math.min(1, dt * 12);
    u.vy = 0;
  } else {
    u.vy = Math.max(-u.terminalFallSpeed, u.vy - GRAVITY * dt);
    u.y += u.vy * dt;
    if (u.y <= targetY) {
      u.y = targetY;
      u.vy = 0;
    }
  }

  // Pitch + roll come from the cell-level slope still — they only need to be
  // accurate enough to tilt the model, not collision-correct.
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(u.x / NAV_CELL_METERS)));
  const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(u.z / NAV_CELL_METERS)));
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
