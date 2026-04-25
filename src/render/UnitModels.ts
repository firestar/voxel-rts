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
// Sized to ~3x the tank: roughly 9 m long, 7 m wide, 6 m tall. Dominated by a
// massive cutter head; chassis behind it is a wide armored hull on heavy treads.

export function buildTunnelerHullGeometry(): THREE.BufferGeometry {
  const body = { r: 0.55, g: 0.42, b: 0.18 };       // industrial yellow
  const bodyDark = { r: 0.40, g: 0.30, b: 0.10 };
  const bodyHi = { r: 0.70, g: 0.55, b: 0.22 };
  const tread = { r: 0.08, g: 0.08, b: 0.10 };
  const treadHi = { r: 0.20, g: 0.22, b: 0.24 };
  const wheelHub = { r: 0.45, g: 0.45, b: 0.45 };
  const cabin = { r: 0.20, g: 0.45, b: 0.55 };      // teal cab glass
  const exhaust = { r: 0.30, g: 0.30, b: 0.32 };
  const reinf = { r: 0.55, g: 0.55, b: 0.60 };      // structural ribs

  const blocks: VoxelBlock[] = [];

  // Massive treads (left + right), 6 m long, 1.0 m wide, 1.6 m tall.
  for (const sx of [-2.4, 2.4]) {
    blocks.push({ x: sx, y: 0.80, z: 0.00, sx: 1.00, sy: 1.60, sz: 6.00, ...tread });
  }
  // Tread tooth bumps along outer faces.
  for (let i = -8; i <= 8; i++) {
    const z = i * 0.32;
    blocks.push({ x: -2.95, y: 0.80, z, sx: 0.12, sy: 0.50, sz: 0.24, ...treadHi });
    blocks.push({ x:  2.95, y: 0.80, z, sx: 0.12, sy: 0.50, sz: 0.24, ...treadHi });
  }
  // Drive sprockets at front + back, each side.
  for (const sx of [-2.4, 2.4]) {
    for (const sz of [2.6, -2.6]) {
      blocks.push({ x: sx, y: 0.80, z: sz, sx: 1.10, sy: 1.00, sz: 1.00, ...wheelHub });
    }
  }
  // Lower hull skirt
  blocks.push({ x: 0.0, y: 1.20, z: 0.0, sx: 4.40, sy: 0.80, sz: 5.40, ...bodyDark });
  // Main armored body (the "can")
  blocks.push({ x: 0.0, y: 2.20, z: 0.0, sx: 4.80, sy: 1.80, sz: 5.00, ...body });
  // Side reinforcement ribs along the can.
  for (let i = -2; i <= 2; i++) {
    const z = i * 1.0;
    blocks.push({ x: -2.42, y: 2.20, z, sx: 0.08, sy: 1.80, sz: 0.20, ...reinf });
    blocks.push({ x:  2.42, y: 2.20, z, sx: 0.08, sy: 1.80, sz: 0.20, ...reinf });
  }
  // Top deck — slightly inset.
  blocks.push({ x: 0.0, y: 3.20, z: 0.0, sx: 4.20, sy: 0.40, sz: 4.40, ...bodyHi });
  // Operator cab toward the back, raised up.
  blocks.push({ x: 0.0, y: 3.80, z: 1.40, sx: 1.80, sy: 0.90, sz: 1.40, ...cabin });
  // Cab roof
  blocks.push({ x: 0.0, y: 4.30, z: 1.40, sx: 2.00, sy: 0.20, sz: 1.60, ...bodyDark });
  // Two big exhaust stacks on the deck.
  blocks.push({ x: -1.00, y: 3.80, z: 0.20, sx: 0.40, sy: 1.40, sz: 0.40, ...exhaust });
  blocks.push({ x:  1.00, y: 3.80, z: 0.20, sx: 0.40, sy: 1.40, sz: 0.40, ...exhaust });
  // Rear conveyor / spoil chute (sloped block out the back).
  blocks.push({ x: 0.0, y: 1.40, z: 3.20, sx: 1.80, sy: 0.40, sz: 1.20, ...bodyDark });
  // Front collar where the cutter head mounts.
  blocks.push({ x: 0.0, y: 2.20, z: -2.60, sx: 4.20, sy: 1.80, sz: 0.40, ...reinf });
  return buildVoxelModel(blocks);
}

/**
 * The cutter head — a massive disc with stepped rings and many teeth around the perimeter.
 * Pivot at the collar; spins about its forward axis (the unit's local Z).
 */
export function buildTunnelerDrillGeometry(): THREE.BufferGeometry {
  const headOuter = { r: 0.40, g: 0.40, b: 0.45 };
  const headInner = { r: 0.55, g: 0.55, b: 0.60 };
  const headCenter = { r: 0.70, g: 0.70, b: 0.75 };
  const tooth = { r: 0.85, g: 0.85, b: 0.90 };
  const teethTip = { r: 0.95, g: 0.95, b: 1.00 };

  const blocks: VoxelBlock[] = [];
  // Stepped rings of decreasing radius, advancing forward (-Z) so the head looks dome-like.
  // Outer disc (3.6 m radius)
  blocks.push({ x: 0.0, y: 0.0, z: -0.20, sx: 6.40, sy: 6.40, sz: 0.40, ...headOuter });
  // Mid disc
  blocks.push({ x: 0.0, y: 0.0, z: -0.55, sx: 5.20, sy: 5.20, sz: 0.40, ...headInner });
  // Inner disc
  blocks.push({ x: 0.0, y: 0.0, z: -0.85, sx: 3.60, sy: 3.60, sz: 0.30, ...headInner });
  // Hub
  blocks.push({ x: 0.0, y: 0.0, z: -1.05, sx: 1.80, sy: 1.80, sz: 0.30, ...headCenter });
  // Center pyramid tip
  blocks.push({ x: 0.0, y: 0.0, z: -1.25, sx: 0.80, sy: 0.80, sz: 0.20, ...teethTip });

  // Cutter teeth — small studs around the outermost ring, every ~22.5°.
  const teethCount = 16;
  for (let i = 0; i < teethCount; i++) {
    const a = (i / teethCount) * Math.PI * 2;
    const r = 3.05;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.20,
      sx: 0.40, sy: 0.40, sz: 0.50, ...tooth,
    });
  }
  // Inner ring of teeth too.
  const innerTeeth = 10;
  for (let i = 0; i < innerTeeth; i++) {
    const a = (i / innerTeeth) * Math.PI * 2 + 0.15;
    const r = 2.30;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.55,
      sx: 0.30, sy: 0.30, sz: 0.40, ...tooth,
    });
  }
  return buildVoxelModel(blocks);
}

/** Drill pivot is at the front collar of the hull. */
export const TUNNELER_DRILL_PIVOT_Y = 2.20;
export const TUNNELER_DRILL_PIVOT_Z = -2.85;
