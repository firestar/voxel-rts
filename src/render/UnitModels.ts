import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface VoxelBlock {
  /** Center position in meters, relative to the model origin (feet on the ground). */
  x: number; y: number; z: number;
  /** Size in meters. */
  sx: number; sy: number; sz: number;
  /** Linear sRGB color components in 0..1. */
  r: number; g: number; b: number;
}

/**
 * Merge a list of colored boxes into a single BufferGeometry with per-vertex colors.
 */
export function buildVoxelModel(blocks: VoxelBlock[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const b of blocks) {
    const g = new THREE.BoxGeometry(b.sx, b.sy, b.sz);
    g.translate(b.x, b.y, b.z);
    const positionCount = g.attributes.position!.count;
    const colors = new Float32Array(positionCount * 3);
    for (let i = 0; i < positionCount; i++) {
      colors[i * 3 + 0] = b.r;
      colors[i * 3 + 1] = b.g;
      colors[i * 3 + 2] = b.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('mergeGeometries returned null');
  for (const g of geos) g.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

// ---------- Soldier ----------------------------------------------------------
// Faces -Z. Origin = feet, centered in XZ.

const SOLDIER_FATIGUES = { r: 0.40, g: 0.45, b: 0.27 };
const SOLDIER_BOOT = { r: 0.18, g: 0.14, b: 0.10 };

/** Body, head, helmet, arms, rifle — everything above the hips. */
export function buildSoldierBodyGeometry(): THREE.BufferGeometry {
  const skin = { r: 0.85, g: 0.70, b: 0.55 };
  const helmet = { r: 0.27, g: 0.32, b: 0.20 };
  const rifleBody = { r: 0.18, g: 0.18, b: 0.20 };
  const rifleStock = { r: 0.30, g: 0.18, b: 0.10 };
  const vest = { r: 0.22, g: 0.25, b: 0.18 };

  const blocks: VoxelBlock[] = [
    // Torso
    { x: 0.00, y: 0.78, z: 0.00, sx: 0.46, sy: 0.50, sz: 0.28, ...SOLDIER_FATIGUES },
    // Vest plate
    { x: 0.00, y: 0.78, z: -0.13, sx: 0.40, sy: 0.42, sz: 0.05, ...vest },
    // Neck + head
    { x: 0.00, y: 1.07, z: 0.00, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    { x: 0.00, y: 1.22, z: 0.00, sx: 0.32, sy: 0.30, sz: 0.32, ...skin },
    // Helmet
    { x: 0.00, y: 1.40, z: 0.00, sx: 0.40, sy: 0.16, sz: 0.40, ...helmet },
    { x: 0.00, y: 1.32, z: 0.00, sx: 0.40, sy: 0.04, sz: 0.40, r: 0.18, g: 0.20, b: 0.14 },
    // Arms — right held forward to grip rifle, left at side
    { x: -0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...SOLDIER_FATIGUES },
    { x:  0.30, y: 0.85, z: -0.08, sx: 0.14, sy: 0.18, sz: 0.30, ...SOLDIER_FATIGUES },
    { x:  0.30, y: 0.66, z: -0.18, sx: 0.14, sy: 0.18, sz: 0.18, ...SOLDIER_FATIGUES },
    // Rifle
    { x:  0.30, y: 0.84, z: -0.36, sx: 0.06, sy: 0.06, sz: 0.42, ...rifleBody },
    { x:  0.30, y: 0.84, z: -0.04, sx: 0.06, sy: 0.10, sz: 0.16, ...rifleStock },
    { x:  0.30, y: 0.74, z: -0.24, sx: 0.06, sy: 0.10, sz: 0.06, r: 0.10, g: 0.10, b: 0.12 },
    { x:  0.30, y: 0.92, z: -0.30, sx: 0.04, sy: 0.04, sz: 0.10, r: 0.10, g: 0.10, b: 0.12 },
  ];
  return buildVoxelModel(blocks);
}

/**
 * One soldier leg, modeled around a hip pivot at (0, 0.55, 0).
 * Pivot is at the top of the leg so a rotation around X swings the leg around the hip.
 */
export function buildSoldierLegGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    // Upper leg + lower leg merged into a thin column hanging from the pivot.
    // Leg model space: pivot at origin, leg hangs down to y = -0.55.
    { x: 0.0, y: -0.25, z: 0.0, sx: 0.18, sy: 0.50, sz: 0.20, ...SOLDIER_FATIGUES },
    // Boot
    { x: 0.0, y: -0.55, z: 0.04, sx: 0.20, sy: 0.10, sz: 0.26, ...SOLDIER_BOOT },
  ];
  return buildVoxelModel(blocks);
}

/** Hip pivot height in meters (where leg attaches to body). */
export const SOLDIER_HIP_Y = 0.55;
export const SOLDIER_LEG_X = 0.10;

// ---------- Worker -----------------------------------------------------------
// Civilian harvester / transporter. Same scale as the soldier (~1.6 m tall)
// but in distinctive blue work clothes + yellow hard hat. Same hip pivot so
// the leg geometry can be reused with a recolour.

const WORKER_JEANS = { r: 0.20, g: 0.30, b: 0.55 };
const WORKER_SHIRT = { r: 0.78, g: 0.55, b: 0.18 }; // hi-vis tan
const WORKER_HAT   = { r: 0.95, g: 0.78, b: 0.10 }; // safety yellow
const WORKER_BOOT  = { r: 0.16, g: 0.12, b: 0.10 };

export function buildWorkerBodyGeometry(): THREE.BufferGeometry {
  const skin = { r: 0.85, g: 0.70, b: 0.55 };
  const tool = { r: 0.28, g: 0.20, b: 0.12 };       // wooden pickaxe handle
  const head = { r: 0.55, g: 0.55, b: 0.58 };       // pickaxe head
  const beltStrap = { r: 0.35, g: 0.22, b: 0.14 };

  const blocks: VoxelBlock[] = [
    // Torso (hi-vis vest over a darker shirt)
    { x: 0.00, y: 0.78, z: 0.00, sx: 0.46, sy: 0.50, sz: 0.28, ...WORKER_SHIRT },
    // Tool belt
    { x: 0.00, y: 0.55, z: 0.00, sx: 0.50, sy: 0.06, sz: 0.32, ...beltStrap },
    // Neck + head
    { x: 0.00, y: 1.07, z: 0.00, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    { x: 0.00, y: 1.22, z: 0.00, sx: 0.32, sy: 0.30, sz: 0.32, ...skin },
    // Hard hat — domed top + narrow brim
    { x: 0.00, y: 1.40, z: 0.00, sx: 0.36, sy: 0.14, sz: 0.36, ...WORKER_HAT },
    { x: 0.00, y: 1.32, z: 0.04, sx: 0.40, sy: 0.04, sz: 0.40, ...WORKER_HAT },
    // Arms — left at side, right gripping a pickaxe forward
    { x: -0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...WORKER_SHIRT },
    { x:  0.30, y: 0.85, z: -0.06, sx: 0.14, sy: 0.18, sz: 0.30, ...WORKER_SHIRT },
    { x:  0.30, y: 0.66, z: -0.16, sx: 0.14, sy: 0.18, sz: 0.18, ...WORKER_SHIRT },
    // Pickaxe — handle running forward, head crossways near the tip
    { x:  0.30, y: 0.84, z: -0.34, sx: 0.05, sy: 0.05, sz: 0.40, ...tool },
    { x:  0.30, y: 0.84, z: -0.50, sx: 0.30, sy: 0.10, sz: 0.06, ...head },
  ];
  return buildVoxelModel(blocks);
}

/** One worker leg, modeled identically to the soldier leg but in jeans / boot colours. */
export function buildWorkerLegGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0.0, y: -0.25, z: 0.0, sx: 0.18, sy: 0.50, sz: 0.20, ...WORKER_JEANS },
    { x: 0.0, y: -0.55, z: 0.04, sx: 0.20, sy: 0.10, sz: 0.26, ...WORKER_BOOT },
  ];
  return buildVoxelModel(blocks);
}

/**
 * Carry pack — a small crate that floats above the worker's back when
 * carrying anything. Two variants (wood / metal) are colour-coded so the
 * player can tell at a glance what each worker is holding.
 */
export function buildWorkerCrateGeometry(metal: boolean): THREE.BufferGeometry {
  const wood = { r: 0.40, g: 0.28, b: 0.16 };
  const metalCol = { r: 0.50, g: 0.55, b: 0.65 };
  const c = metal ? metalCol : wood;
  const trim = metal ? { r: 0.30, g: 0.32, b: 0.36 } : { r: 0.22, g: 0.16, b: 0.10 };
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0, z: 0, sx: 0.34, sy: 0.30, sz: 0.26, ...c },
    { x: 0, y: 0.16, z: 0, sx: 0.36, sy: 0.04, sz: 0.28, ...trim },
  ];
  return buildVoxelModel(blocks);
}

/** Worker uses the same hip pivot offsets as the soldier. */
export const WORKER_HIP_Y = 0.55;
export const WORKER_LEG_X = 0.10;

// ---------- Tank --------------------------------------------------------------
// Scaled ~2x from earlier so it reads as a proper vehicle next to a 1.6 m soldier.
// Rough dimensions: 3.2 m long, 2.4 m wide (incl. treads), 2.0 m tall to top of antenna.

export function buildTankHullGeometry(): THREE.BufferGeometry {
  const hull = { r: 0.30, g: 0.45, b: 0.35 };
  const hullDark = { r: 0.20, g: 0.30, b: 0.24 };
  const tread = { r: 0.08, g: 0.08, b: 0.10 };
  const treadHi = { r: 0.20, g: 0.22, b: 0.24 };
  const wheelHub = { r: 0.45, g: 0.45, b: 0.45 };

  const blocks: VoxelBlock[] = [
    // Treads (left + right) — long and tall
    { x: -0.95, y: 0.40, z: 0.00, sx: 0.40, sy: 0.70, sz: 3.00, ...tread },
    { x:  0.95, y: 0.40, z: 0.00, sx: 0.40, sy: 0.70, sz: 3.00, ...tread },
  ];
  // Tread tooth bumps along outer faces.
  for (let i = -6; i <= 6; i++) {
    const z = i * 0.22;
    blocks.push({ x: -1.18, y: 0.40, z, sx: 0.06, sy: 0.20, sz: 0.18, ...treadHi });
    blocks.push({ x:  1.18, y: 0.40, z, sx: 0.06, sy: 0.20, sz: 0.18, ...treadHi });
  }
  // Drive sprockets (front + back, both sides)
  for (const sx of [-0.95, 0.95]) {
    for (const sz of [1.30, -1.30]) {
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.46, sy: 0.40, sz: 0.40, ...wheelHub });
    }
  }
  // Lower hull skirt + upper hull deck.
  blocks.push({ x: 0.0, y: 0.55, z: 0.0, sx: 1.50, sy: 0.36, sz: 2.80, ...hullDark });
  blocks.push({ x: 0.0, y: 0.92, z: 0.0, sx: 1.70, sy: 0.34, sz: 2.50, ...hull });
  // Glacis (sloped front impression — a forward-jutting block at deck height).
  blocks.push({ x: 0.0, y: 0.80, z: -1.30, sx: 1.40, sy: 0.28, sz: 0.26, ...hull });
  // Side fender ridges
  blocks.push({ x: -0.78, y: 1.04, z: 0.00, sx: 0.10, sy: 0.06, sz: 2.20, ...hullDark });
  blocks.push({ x:  0.78, y: 1.04, z: 0.00, sx: 0.10, sy: 0.06, sz: 2.20, ...hullDark });
  return buildVoxelModel(blocks);
}

/** Turret + cannon. Turret pivot at TANK_TURRET_PIVOT_Y / _Z relative to hull origin. */
export function buildTankTurretGeometry(): THREE.BufferGeometry {
  const turret = { r: 0.34, g: 0.50, b: 0.40 };
  const turretDark = { r: 0.24, g: 0.36, b: 0.28 };
  const cannon = { r: 0.16, g: 0.16, b: 0.18 };
  const cannonHi = { r: 0.30, g: 0.30, b: 0.34 };
  const hatch = { r: 0.18, g: 0.20, b: 0.16 };

  const blocks: VoxelBlock[] = [
    // Turret base (around pivot)
    { x: 0.00, y: 0.00, z: 0.00, sx: 1.30, sy: 0.36, sz: 1.30, ...turret },
    // Mantlet (front step)
    { x: 0.00, y: 0.18, z: -0.55, sx: 1.00, sy: 0.40, sz: 0.50, ...turretDark },
    // Roof
    { x: 0.00, y: 0.36, z: 0.00, sx: 1.20, sy: 0.10, sz: 1.20, ...turret },
    // Commander hatch
    { x: 0.20, y: 0.40, z: 0.30, sx: 0.34, sy: 0.06, sz: 0.34, ...hatch },
    // Periscope
    { x: 0.20, y: 0.46, z: 0.30, sx: 0.10, sy: 0.10, sz: 0.10, r: 0.05, g: 0.05, b: 0.08 },
    // Antenna whip
    { x: -0.36, y: 0.62, z: 0.36, sx: 0.04, sy: 0.50, sz: 0.04, r: 0.05, g: 0.05, b: 0.05 },
    // Cannon barrel
    { x: 0.0, y: 0.22, z: -1.10, sx: 0.26, sy: 0.26, sz: 1.00, ...cannon },
    // Muzzle brake
    { x: 0.0, y: 0.22, z: -1.66, sx: 0.34, sy: 0.34, sz: 0.16, ...cannonHi },
    // Bore evacuator (a slight bulge on the barrel)
    { x: 0.0, y: 0.22, z: -1.40, sx: 0.32, sy: 0.32, sz: 0.18, ...cannonHi },
  ];
  return buildVoxelModel(blocks);
}

export const TANK_TURRET_PIVOT_Y = 1.20;
export const TANK_TURRET_PIVOT_Z = 0.05;

// ---------- Tunneler (TBM) ---------------------------------------------------
// Sized to ~1.5x the tank: roughly 4.5 m long, 3.6 m wide, ~3 m tall. Dominated
// by a stepped cutter head; chassis behind it on heavy treads with a raised cab.

export function buildTunnelerHullGeometry(): THREE.BufferGeometry {
  const body = { r: 0.55, g: 0.42, b: 0.18 };       // industrial yellow
  const bodyDark = { r: 0.40, g: 0.30, b: 0.10 };
  const bodyHi = { r: 0.70, g: 0.55, b: 0.22 };
  const tread = { r: 0.08, g: 0.08, b: 0.10 };
  const treadHi = { r: 0.20, g: 0.22, b: 0.24 };
  const wheelHub = { r: 0.45, g: 0.45, b: 0.45 };
  const cabin = { r: 0.20, g: 0.45, b: 0.55 };      // teal cab glass
  const exhaust = { r: 0.30, g: 0.30, b: 0.32 };
  const reinf = { r: 0.55, g: 0.55, b: 0.60 };

  const blocks: VoxelBlock[] = [];

  // Treads (left + right), 3 m long, 0.5 m wide, 0.8 m tall.
  for (const sx of [-1.20, 1.20]) {
    blocks.push({ x: sx, y: 0.40, z: 0.00, sx: 0.50, sy: 0.80, sz: 3.00, ...tread });
  }
  for (let i = -4; i <= 4; i++) {
    const z = i * 0.32;
    blocks.push({ x: -1.48, y: 0.40, z, sx: 0.06, sy: 0.26, sz: 0.18, ...treadHi });
    blocks.push({ x:  1.48, y: 0.40, z, sx: 0.06, sy: 0.26, sz: 0.18, ...treadHi });
  }
  // Drive sprockets at front + back, each side.
  for (const sx of [-1.20, 1.20]) {
    for (const sz of [1.30, -1.30]) {
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.55, sy: 0.55, sz: 0.55, ...wheelHub });
    }
  }
  // Lower hull skirt
  blocks.push({ x: 0.0, y: 0.60, z: 0.0, sx: 2.20, sy: 0.40, sz: 2.70, ...bodyDark });
  // Main armored body (the "can")
  blocks.push({ x: 0.0, y: 1.10, z: 0.0, sx: 2.40, sy: 0.90, sz: 2.50, ...body });
  // Side ribs.
  for (let i = -1; i <= 1; i++) {
    const z = i * 0.60;
    blocks.push({ x: -1.21, y: 1.10, z, sx: 0.04, sy: 0.90, sz: 0.12, ...reinf });
    blocks.push({ x:  1.21, y: 1.10, z, sx: 0.04, sy: 0.90, sz: 0.12, ...reinf });
  }
  // Top deck.
  blocks.push({ x: 0.0, y: 1.60, z: 0.0, sx: 2.10, sy: 0.20, sz: 2.20, ...bodyHi });
  // Operator cab toward the back, raised up.
  blocks.push({ x: 0.0, y: 1.95, z: 0.70, sx: 0.90, sy: 0.50, sz: 0.70, ...cabin });
  // Cab roof
  blocks.push({ x: 0.0, y: 2.22, z: 0.70, sx: 1.00, sy: 0.10, sz: 0.80, ...bodyDark });
  // Two exhaust stacks on the deck.
  blocks.push({ x: -0.50, y: 1.95, z: 0.10, sx: 0.20, sy: 0.70, sz: 0.20, ...exhaust });
  blocks.push({ x:  0.50, y: 1.95, z: 0.10, sx: 0.20, sy: 0.70, sz: 0.20, ...exhaust });
  // Rear spoil chute.
  blocks.push({ x: 0.0, y: 0.70, z: 1.60, sx: 0.90, sy: 0.20, sz: 0.60, ...bodyDark });
  // Front collar where the cutter head mounts.
  blocks.push({ x: 0.0, y: 1.10, z: -1.30, sx: 2.10, sy: 0.90, sz: 0.20, ...reinf });
  return buildVoxelModel(blocks);
}

/**
 * The cutter head — stepped rings and many teeth around the perimeter. Pivot at the collar;
 * spins about its forward axis (the unit's local Z).
 */
export function buildTunnelerDrillGeometry(): THREE.BufferGeometry {
  const headOuter = { r: 0.40, g: 0.40, b: 0.45 };
  const headInner = { r: 0.55, g: 0.55, b: 0.60 };
  const headCenter = { r: 0.70, g: 0.70, b: 0.75 };
  const tooth = { r: 0.85, g: 0.85, b: 0.90 };
  const teethTip = { r: 0.95, g: 0.95, b: 1.00 };

  const blocks: VoxelBlock[] = [];
  // Stepped rings of decreasing radius, advancing forward (-Z) so the head looks dome-like.
  // Outer disc — 1.8 m diameter
  blocks.push({ x: 0.0, y: 0.0, z: -0.10, sx: 3.20, sy: 3.20, sz: 0.20, ...headOuter });
  // Mid disc
  blocks.push({ x: 0.0, y: 0.0, z: -0.28, sx: 2.60, sy: 2.60, sz: 0.20, ...headInner });
  // Inner disc
  blocks.push({ x: 0.0, y: 0.0, z: -0.43, sx: 1.80, sy: 1.80, sz: 0.16, ...headInner });
  // Hub
  blocks.push({ x: 0.0, y: 0.0, z: -0.53, sx: 0.90, sy: 0.90, sz: 0.16, ...headCenter });
  // Center tip
  blocks.push({ x: 0.0, y: 0.0, z: -0.62, sx: 0.40, sy: 0.40, sz: 0.10, ...teethTip });

  // Outer ring of cutter teeth.
  const teethCount = 14;
  for (let i = 0; i < teethCount; i++) {
    const a = (i / teethCount) * Math.PI * 2;
    const r = 1.50;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.10,
      sx: 0.22, sy: 0.22, sz: 0.28, ...tooth,
    });
  }
  // Inner ring of teeth.
  const innerTeeth = 8;
  for (let i = 0; i < innerTeeth; i++) {
    const a = (i / innerTeeth) * Math.PI * 2 + 0.20;
    const r = 1.10;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.28,
      sx: 0.18, sy: 0.18, sz: 0.22, ...tooth,
    });
  }
  return buildVoxelModel(blocks);
}

/** Drill pivot is at the front collar of the hull. */
export const TUNNELER_DRILL_PIVOT_Y = 1.10;
export const TUNNELER_DRILL_PIVOT_Z = -1.42;
/** Cutter head outer radius in meters — used by the carve sphere. */
export const TUNNELER_CUTTER_RADIUS = 1.7;
/** How far ahead of the unit origin the cutter face sits (positive number; forward = -Z in model). */
export const TUNNELER_CUTTER_FORWARD = 1.65;
/** Height of cutter center above feet in unit-local coords. */
export const TUNNELER_CUTTER_HEIGHT = 1.10;

// ---------- Worm tunneler ----------------------------------------------------
// A subway-style chain: a wedge-shaped head with a small cutter at the nose, then
// several body segments that trail behind on a rope-like distance constraint and
// each gravity-settle onto the local ground (or tunnel floor). Faces -Z. Origin =
// feet, centred in XZ, just like the other vehicles.

const WORM_HEAD_PLATE = { r: 0.42, g: 0.36, b: 0.20 };
const WORM_HEAD_PLATE_DARK = { r: 0.28, g: 0.22, b: 0.10 };
const WORM_HEAD_RIB = { r: 0.55, g: 0.50, b: 0.42 };
const WORM_BODY_PLATE = { r: 0.46, g: 0.40, b: 0.22 };
const WORM_BODY_PLATE_DARK = { r: 0.30, g: 0.24, b: 0.12 };
const WORM_BODY_RIB = { r: 0.60, g: 0.55, b: 0.46 };
const WORM_BELLY = { r: 0.20, g: 0.18, b: 0.14 };

/** Worm head: a tapered wedge hull, the cutter mounts on its nose. */
export function buildWormHeadGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Main head body — broad at the back, narrowed and lifted toward the front.
  blocks.push({ x: 0, y: 0.55, z: 0.20, sx: 1.50, sy: 0.95, sz: 1.20, ...WORM_HEAD_PLATE });
  blocks.push({ x: 0, y: 0.55, z: -0.50, sx: 1.30, sy: 0.85, sz: 0.60, ...WORM_HEAD_PLATE });
  // Front-facing armoured collar where the cutter mounts.
  blocks.push({ x: 0, y: 0.55, z: -0.85, sx: 1.10, sy: 0.75, sz: 0.18, ...WORM_HEAD_RIB });
  // Belly plate (looks heavy and grounded).
  blocks.push({ x: 0, y: 0.10, z: 0.00, sx: 1.30, sy: 0.20, sz: 1.60, ...WORM_BELLY });
  // Side ribs.
  for (let i = -1; i <= 1; i++) {
    const z = i * 0.40;
    blocks.push({ x: -0.78, y: 0.55, z, sx: 0.04, sy: 0.85, sz: 0.10, ...WORM_HEAD_RIB });
    blocks.push({ x:  0.78, y: 0.55, z, sx: 0.04, sy: 0.85, sz: 0.10, ...WORM_HEAD_RIB });
  }
  // Top dorsal ridge — three small bumps along the spine.
  for (const sz of [-0.30, 0.10, 0.50]) {
    blocks.push({ x: 0, y: 1.10, z: sz, sx: 0.40, sy: 0.14, sz: 0.20, ...WORM_HEAD_PLATE_DARK });
  }
  return buildVoxelModel(blocks);
}

/** A single worm body segment — origin at feet, centred so a chain of them lines up flush. */
export function buildWormSegmentGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Belly + main armoured cylinder approximation (a couple of stacked plates).
  blocks.push({ x: 0, y: 0.10, z: 0, sx: 1.30, sy: 0.20, sz: 1.30, ...WORM_BELLY });
  blocks.push({ x: 0, y: 0.50, z: 0, sx: 1.40, sy: 0.80, sz: 1.30, ...WORM_BODY_PLATE });
  blocks.push({ x: 0, y: 0.95, z: 0, sx: 1.20, sy: 0.20, sz: 1.10, ...WORM_BODY_PLATE_DARK });
  // Ring rib at front and back of the segment so the chain has visible joints.
  for (const sz of [-0.55, 0.55]) {
    blocks.push({ x: 0, y: 0.55, z: sz, sx: 1.50, sy: 0.90, sz: 0.10, ...WORM_BODY_RIB });
  }
  // Side bolts, three per side.
  for (let i = -1; i <= 1; i++) {
    const z = i * 0.32;
    blocks.push({ x: -0.74, y: 0.55, z, sx: 0.04, sy: 0.20, sz: 0.10, ...WORM_BODY_RIB });
    blocks.push({ x:  0.74, y: 0.55, z, sx: 0.04, sy: 0.20, sz: 0.10, ...WORM_BODY_RIB });
  }
  // Spine bump.
  blocks.push({ x: 0, y: 1.10, z: 0, sx: 0.40, sy: 0.10, sz: 0.50, ...WORM_BODY_PLATE_DARK });
  return buildVoxelModel(blocks);
}

/** Worm cutter head — same idea as the tunneler drill but smaller and simpler. */
export function buildWormDrillGeometry(): THREE.BufferGeometry {
  const headOuter = { r: 0.42, g: 0.42, b: 0.46 };
  const headInner = { r: 0.55, g: 0.55, b: 0.58 };
  const headCenter = { r: 0.72, g: 0.72, b: 0.74 };
  const tooth = { r: 0.85, g: 0.85, b: 0.90 };
  const teethTip = { r: 0.95, g: 0.95, b: 1.00 };

  const blocks: VoxelBlock[] = [];
  blocks.push({ x: 0, y: 0, z: -0.05, sx: 1.70, sy: 1.70, sz: 0.16, ...headOuter });
  blocks.push({ x: 0, y: 0, z: -0.18, sx: 1.30, sy: 1.30, sz: 0.14, ...headInner });
  blocks.push({ x: 0, y: 0, z: -0.28, sx: 0.80, sy: 0.80, sz: 0.10, ...headInner });
  blocks.push({ x: 0, y: 0, z: -0.36, sx: 0.40, sy: 0.40, sz: 0.10, ...headCenter });
  blocks.push({ x: 0, y: 0, z: -0.44, sx: 0.20, sy: 0.20, sz: 0.08, ...teethTip });
  // Outer ring of teeth.
  const teethCount = 10;
  for (let i = 0; i < teethCount; i++) {
    const a = (i / teethCount) * Math.PI * 2;
    const r = 0.78;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.05,
      sx: 0.16, sy: 0.16, sz: 0.20, ...tooth,
    });
  }
  return buildVoxelModel(blocks);
}

/** Drill pivot mounts on the worm head's front collar. */
export const WORM_DRILL_PIVOT_Y = 0.55;
export const WORM_DRILL_PIVOT_Z = -0.95;
/** Cutter dimensions — see Units.ts cutter helpers (carve, slab clear, sample). */
export const WORM_CUTTER_RADIUS = 0.85;
export const WORM_CUTTER_FORWARD = 1.05;
export const WORM_CUTTER_HEIGHT = 0.55;
/** Number of trailing body segments and their target spacing in metres. */
export const WORM_SEGMENT_COUNT = 6;
export const WORM_SEGMENT_SPACING = 1.30;

// ---------- Dozer (bulldozer) ------------------------------------------------
// Tracked chassis like the tank, with a wide curved blade angled forward of the
// hull. Origin = feet, centred in XZ. Faces -Z so blade is at -Z relative to origin.

const DOZER_HULL = { r: 0.78, g: 0.55, b: 0.18 };       // construction yellow
const DOZER_HULL_DARK = { r: 0.55, g: 0.36, b: 0.10 };
const DOZER_HULL_HI = { r: 0.92, g: 0.72, b: 0.26 };
const DOZER_BLADE = { r: 0.55, g: 0.42, b: 0.16 };
const DOZER_BLADE_TRIM = { r: 0.30, g: 0.22, b: 0.10 };
const DOZER_TREAD = { r: 0.08, g: 0.08, b: 0.10 };
const DOZER_TREAD_HI = { r: 0.20, g: 0.22, b: 0.24 };
const DOZER_HUB = { r: 0.45, g: 0.45, b: 0.45 };
const DOZER_CAB = { r: 0.20, g: 0.45, b: 0.55 };

export function buildDozerHullGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Treads — same length / wider than tank for a stockier look.
  for (const sx of [-1.05, 1.05]) {
    blocks.push({ x: sx, y: 0.40, z: 0.10, sx: 0.46, sy: 0.70, sz: 3.10, ...DOZER_TREAD });
  }
  for (let i = -6; i <= 6; i++) {
    const z = i * 0.22;
    blocks.push({ x: -1.30, y: 0.40, z: z + 0.10, sx: 0.06, sy: 0.20, sz: 0.18, ...DOZER_TREAD_HI });
    blocks.push({ x:  1.30, y: 0.40, z: z + 0.10, sx: 0.06, sy: 0.20, sz: 0.18, ...DOZER_TREAD_HI });
  }
  // Drive sprockets.
  for (const sx of [-1.05, 1.05]) {
    for (const sz of [1.45, -1.25]) {
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.50, sy: 0.46, sz: 0.46, ...DOZER_HUB });
    }
  }
  // Lower hull skirt.
  blocks.push({ x: 0.0, y: 0.55, z: 0.10, sx: 1.60, sy: 0.36, sz: 2.60, ...DOZER_HULL_DARK });
  // Main hull.
  blocks.push({ x: 0.0, y: 0.92, z: 0.10, sx: 1.80, sy: 0.50, sz: 2.30, ...DOZER_HULL });
  // Upper deck.
  blocks.push({ x: 0.0, y: 1.20, z: 0.20, sx: 1.50, sy: 0.10, sz: 1.80, ...DOZER_HULL_HI });
  // Cab toward the back.
  blocks.push({ x: 0.0, y: 1.45, z: 0.80, sx: 1.10, sy: 0.50, sz: 0.80, ...DOZER_CAB });
  blocks.push({ x: 0.0, y: 1.74, z: 0.80, sx: 1.20, sy: 0.10, sz: 0.90, ...DOZER_HULL_DARK });
  // Exhaust stack on top of the hull.
  blocks.push({ x: -0.45, y: 1.45, z: 0.20, sx: 0.16, sy: 0.55, sz: 0.16, ...DOZER_TREAD });
  // Push arms — angled steel members from the chassis flank to the blade pivot.
  // Approximated as two long thin blocks on each side.
  for (const sx of [-1.10, 1.10]) {
    blocks.push({ x: sx, y: 0.85, z: -0.90, sx: 0.10, sy: 0.20, sz: 1.40, ...DOZER_BLADE_TRIM });
  }
  return buildVoxelModel(blocks);
}

/** The dozer blade — a wide curved (stepped) plate mounted at the front of the hull. */
export function buildDozerBladeGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Main blade face: 3.6 m wide (matches half-width 1.6 m + 0.2 m clearance on each side),
  // 1.2 m tall, ~0.3 m thick.
  blocks.push({ x: 0, y: 0.50, z: 0.00, sx: 3.60, sy: 1.10, sz: 0.30, ...DOZER_BLADE });
  // Top reinforcing rib.
  blocks.push({ x: 0, y: 1.05, z: 0.05, sx: 3.60, sy: 0.10, sz: 0.20, ...DOZER_BLADE_TRIM });
  // Bottom cutting edge.
  blocks.push({ x: 0, y: 0.05, z: -0.08, sx: 3.60, sy: 0.10, sz: 0.16, ...DOZER_BLADE_TRIM });
  // Back-curve impression: a second slimmer plate behind.
  blocks.push({ x: 0, y: 0.55, z: 0.18, sx: 3.30, sy: 0.90, sz: 0.16, ...DOZER_BLADE_TRIM });
  // Side wings (angled inward — approximated as two outboard plates).
  for (const sx of [-1.78, 1.78]) {
    blocks.push({ x: sx, y: 0.55, z: 0.20, sx: 0.20, sy: 0.95, sz: 0.50, ...DOZER_BLADE });
  }
  return buildVoxelModel(blocks);
}

/** Blade pivot in unit-local coords — sits in front of and slightly below the hull. */
export const DOZER_BLADE_PIVOT_Y = 0.10;
export const DOZER_BLADE_PIVOT_Z = -1.80;

// ---------- Hauler (dump truck) ----------------------------------------------
// Boxy cab + tall open-top dump bed. Origin = feet, centred in XZ. Faces -Z.

const HAULER_BODY = { r: 0.78, g: 0.32, b: 0.18 };       // industrial red-orange
const HAULER_BODY_DARK = { r: 0.55, g: 0.20, b: 0.10 };
const HAULER_BED = { r: 0.34, g: 0.34, b: 0.36 };
const HAULER_BED_DARK = { r: 0.20, g: 0.20, b: 0.22 };
const HAULER_BED_RIB = { r: 0.55, g: 0.55, b: 0.58 };
const HAULER_GLASS = { r: 0.20, g: 0.45, b: 0.55 };
const HAULER_TIRE = { r: 0.08, g: 0.08, b: 0.10 };
const HAULER_HUB = { r: 0.45, g: 0.45, b: 0.45 };

export function buildHaulerHullGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Wheels: four large tires.
  for (const sx of [-1.00, 1.00]) {
    for (const sz of [-1.10, 1.10]) {
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.40, sy: 0.80, sz: 0.80, ...HAULER_TIRE });
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.30, sy: 0.40, sz: 0.40, ...HAULER_HUB });
    }
  }
  // Lower frame.
  blocks.push({ x: 0.0, y: 0.50, z: 0.0, sx: 1.80, sy: 0.30, sz: 2.80, ...HAULER_BODY_DARK });
  // Cab over the front wheels.
  blocks.push({ x: 0.0, y: 0.95, z: -1.05, sx: 1.50, sy: 0.85, sz: 0.95, ...HAULER_BODY });
  blocks.push({ x: 0.0, y: 1.42, z: -1.05, sx: 1.55, sy: 0.10, sz: 1.00, ...HAULER_BODY_DARK });
  // Cab windscreen.
  blocks.push({ x: 0.0, y: 1.10, z: -1.50, sx: 1.20, sy: 0.45, sz: 0.05, ...HAULER_GLASS });
  // Side windows.
  blocks.push({ x: -0.78, y: 1.10, z: -1.05, sx: 0.05, sy: 0.40, sz: 0.70, ...HAULER_GLASS });
  blocks.push({ x:  0.78, y: 1.10, z: -1.05, sx: 0.05, sy: 0.40, sz: 0.70, ...HAULER_GLASS });
  // Front bumper.
  blocks.push({ x: 0.0, y: 0.55, z: -1.55, sx: 1.70, sy: 0.20, sz: 0.10, ...HAULER_BED_RIB });
  return buildVoxelModel(blocks);
}

/** Open-top dump bed. Built to pivot around its rear lower edge for tip-up animation. */
export function buildHaulerBedGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Bed sits with origin at the rear-lower edge so a positive X-rotation tips it
  // up at the front. Bed is 1.8 m wide × 1.6 m long × 0.7 m tall.
  // Floor.
  blocks.push({ x: 0, y: 0.05, z: -0.80, sx: 1.70, sy: 0.10, sz: 1.60, ...HAULER_BED });
  // Side walls.
  blocks.push({ x: -0.85, y: 0.45, z: -0.80, sx: 0.10, sy: 0.70, sz: 1.60, ...HAULER_BED });
  blocks.push({ x:  0.85, y: 0.45, z: -0.80, sx: 0.10, sy: 0.70, sz: 1.60, ...HAULER_BED });
  // Front wall (tall).
  blocks.push({ x: 0, y: 0.55, z: -1.55, sx: 1.80, sy: 0.90, sz: 0.10, ...HAULER_BED_DARK });
  // Rear wall (shorter — tipping gate).
  blocks.push({ x: 0, y: 0.30, z: -0.05, sx: 1.80, sy: 0.50, sz: 0.10, ...HAULER_BED_DARK });
  // Top rib for visual structure.
  blocks.push({ x: 0, y: 0.78, z: -0.80, sx: 1.80, sy: 0.06, sz: 1.60, ...HAULER_BED_RIB });
  return buildVoxelModel(blocks);
}

/** Bed pivot in unit-local coords — placed at the rear lower edge of the bed. */
export const HAULER_BED_PIVOT_Y = 0.85;
export const HAULER_BED_PIVOT_Z = 1.10;

// ---------- Rocket truck -----------------------------------------------------
// Wheeled chassis (slimmer than the hauler) with an independently-yawing
// rocket pod on the deck. Pod pivots around the centre of the deck so the
// renderer can rotate it freely on (turretYaw - heading) regardless of the
// hull's orientation.

const ROCKET_HULL = { r: 0.35, g: 0.45, b: 0.30 };       // olive drab
const ROCKET_HULL_DARK = { r: 0.22, g: 0.28, b: 0.18 };
const ROCKET_HULL_HI = { r: 0.55, g: 0.62, b: 0.42 };
const ROCKET_TIRE = { r: 0.08, g: 0.08, b: 0.10 };
const ROCKET_HUB = { r: 0.45, g: 0.45, b: 0.45 };
const ROCKET_GLASS = { r: 0.20, g: 0.45, b: 0.55 };
const ROCKET_POD_BODY = { r: 0.30, g: 0.35, b: 0.30 };
const ROCKET_POD_TUBE = { r: 0.18, g: 0.20, b: 0.18 };
const ROCKET_POD_RIM = { r: 0.55, g: 0.55, b: 0.58 };
const ROCKET_TIP = { r: 0.85, g: 0.55, b: 0.20 };

export function buildRocketTruckHullGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Wheels: four large tires.
  for (const sx of [-0.95, 0.95]) {
    for (const sz of [-1.10, 1.10]) {
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.40, sy: 0.80, sz: 0.80, ...ROCKET_TIRE });
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.30, sy: 0.40, sz: 0.40, ...ROCKET_HUB });
    }
  }
  // Lower frame.
  blocks.push({ x: 0.0, y: 0.50, z: 0.0, sx: 1.70, sy: 0.30, sz: 2.80, ...ROCKET_HULL_DARK });
  // Cab over the front wheels.
  blocks.push({ x: 0.0, y: 0.95, z: -1.05, sx: 1.40, sy: 0.85, sz: 0.95, ...ROCKET_HULL });
  blocks.push({ x: 0.0, y: 1.42, z: -1.05, sx: 1.45, sy: 0.10, sz: 1.00, ...ROCKET_HULL_DARK });
  // Cab windscreen.
  blocks.push({ x: 0.0, y: 1.10, z: -1.50, sx: 1.10, sy: 0.45, sz: 0.05, ...ROCKET_GLASS });
  // Side windows.
  blocks.push({ x: -0.73, y: 1.10, z: -1.05, sx: 0.05, sy: 0.40, sz: 0.70, ...ROCKET_GLASS });
  blocks.push({ x:  0.73, y: 1.10, z: -1.05, sx: 0.05, sy: 0.40, sz: 0.70, ...ROCKET_GLASS });
  // Front bumper.
  blocks.push({ x: 0.0, y: 0.55, z: -1.55, sx: 1.60, sy: 0.20, sz: 0.10, ...ROCKET_POD_RIM });
  // Rear deck base where the pod mounts.
  blocks.push({ x: 0.0, y: 0.85, z: 0.55, sx: 1.50, sy: 0.18, sz: 1.40, ...ROCKET_HULL_HI });
  // Pod turntable (the visible ring under the rotating pod).
  blocks.push({ x: 0.0, y: 0.95, z: 0.55, sx: 1.20, sy: 0.05, sz: 1.20, ...ROCKET_POD_RIM });
  return buildVoxelModel(blocks);
}

/**
 * The rocket pod — a 4×2 grid of launch tubes mounted on a low frame. Origin
 * is at the centre of the turntable so a rotation around Y on this geometry
 * yaws the pod freely. Faces -Z by default so the tubes point forward.
 */
export function buildRocketTruckPodGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Pod base (the frame that holds the tubes).
  blocks.push({ x: 0, y: 0.10, z: 0.0, sx: 1.20, sy: 0.20, sz: 1.30, ...ROCKET_POD_BODY });
  // Tube grid: 4 across, 2 stacked. Each tube is a long cylinder approximated
  // as a stack of two boxes (body + dark inner liner) pointing -Z.
  const tubeLen = 1.50;
  const tubeR = 0.12;
  const tubeGapX = 0.32;
  const tubeRowY = [0.30, 0.58];
  for (const ty of tubeRowY) {
    for (let i = -1.5; i <= 1.5; i += 1) {
      blocks.push({
        x: i * tubeGapX, y: ty, z: -0.05,
        sx: tubeR * 2, sy: tubeR * 2, sz: tubeLen,
        ...ROCKET_POD_TUBE,
      });
      // Tip showing the rocket nose.
      blocks.push({
        x: i * tubeGapX, y: ty, z: -0.05 - tubeLen * 0.5 + 0.03,
        sx: tubeR * 1.4, sy: tubeR * 1.4, sz: 0.06,
        ...ROCKET_TIP,
      });
      // Rear cap (where exhaust would come out).
      blocks.push({
        x: i * tubeGapX, y: ty, z: -0.05 + tubeLen * 0.5 - 0.03,
        sx: tubeR * 2.2, sy: tubeR * 2.2, sz: 0.06,
        ...ROCKET_POD_RIM,
      });
    }
  }
  // Side reinforcements.
  for (const sx of [-0.66, 0.66]) {
    blocks.push({ x: sx, y: 0.45, z: 0.0, sx: 0.06, sy: 0.55, sz: 1.30, ...ROCKET_POD_RIM });
  }
  return buildVoxelModel(blocks);
}

/** Pod pivot in unit-local coords — sits in the centre of the rear deck. */
export const ROCKET_TRUCK_POD_PIVOT_Y = 1.00;
export const ROCKET_TRUCK_POD_PIVOT_Z = 0.55;
