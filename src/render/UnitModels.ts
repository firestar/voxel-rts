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
