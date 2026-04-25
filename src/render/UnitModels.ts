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

// ---------- Tank (Tunneler) --------------------------------------------------

export function buildTankHullGeometry(): THREE.BufferGeometry {
  const hull = { r: 0.30, g: 0.45, b: 0.35 };
  const tread = { r: 0.10, g: 0.10, b: 0.12 };
  const treadHi = { r: 0.20, g: 0.22, b: 0.24 };

  const blocks: VoxelBlock[] = [
    // Treads (left + right)
    { x: -0.45, y: 0.20, z: 0.00, sx: 0.20, sy: 0.36, sz: 1.40, ...tread },
    { x:  0.45, y: 0.20, z: 0.00, sx: 0.20, sy: 0.36, sz: 1.40, ...tread },
  ];
  // Tread tooth bumps along outer faces.
  for (let i = -3; i <= 3; i++) {
    const z = i * 0.18;
    blocks.push({ x: -0.56, y: 0.20, z, sx: 0.04, sy: 0.10, sz: 0.10, ...treadHi });
    blocks.push({ x:  0.56, y: 0.20, z, sx: 0.04, sy: 0.10, sz: 0.10, ...treadHi });
  }
  // Lower hull skirt + upper hull deck + glacis nub.
  blocks.push({ x: 0.0, y: 0.30, z: 0.0, sx: 0.74, sy: 0.18, sz: 1.30, ...hull });
  blocks.push({ x: 0.0, y: 0.50, z: 0.0, sx: 0.84, sy: 0.20, sz: 1.20, ...hull });
  blocks.push({ x: 0.0, y: 0.50, z: -0.62, sx: 0.74, sy: 0.16, sz: 0.10, ...hull });
  return buildVoxelModel(blocks);
}

/** Turret + cannon + drill. Turret pivot at (0, 0.66, 0.05). */
export function buildTankTurretGeometry(): THREE.BufferGeometry {
  const turret = { r: 0.34, g: 0.50, b: 0.40 };
  const cannon = { r: 0.18, g: 0.18, b: 0.20 };
  const drill = { r: 0.55, g: 0.55, b: 0.60 };
  const drillTip = { r: 0.85, g: 0.85, b: 0.90 };
  const hatch = { r: 0.18, g: 0.20, b: 0.16 };

  const blocks: VoxelBlock[] = [
    // Turret base (around pivot)
    { x: 0.00, y: 0.00, z: 0.00, sx: 0.66, sy: 0.18, sz: 0.66, ...turret },
    // Mantlet (front step)
    { x: 0.00, y: 0.08, z: -0.25, sx: 0.50, sy: 0.20, sz: 0.30, ...turret },
    // Hatch + periscope + antenna
    { x: 0.10, y: 0.14, z: 0.13, sx: 0.18, sy: 0.06, sz: 0.18, ...hatch },
    { x: 0.10, y: 0.20, z: 0.13, sx: 0.06, sy: 0.06, sz: 0.06, r: 0.05, g: 0.05, b: 0.08 },
    { x: -0.18, y: 0.29, z: 0.15, sx: 0.02, sy: 0.30, sz: 0.02, r: 0.05, g: 0.05, b: 0.05 },
    // Cannon
    { x: 0.0, y: 0.12, z: -0.55, sx: 0.16, sy: 0.16, sz: 0.50, ...cannon },
    { x: 0.0, y: 0.12, z: -0.83, sx: 0.20, sy: 0.20, sz: 0.10, ...cannon },
    // Drill bit
    { x: 0.0, y: 0.12, z: -0.95, sx: 0.18, sy: 0.18, sz: 0.10, ...drill },
    { x: 0.0, y: 0.12, z: -1.05, sx: 0.14, sy: 0.14, sz: 0.10, ...drill },
    { x: 0.0, y: 0.12, z: -1.13, sx: 0.08, sy: 0.08, sz: 0.08, ...drillTip },
  ];
  return buildVoxelModel(blocks);
}

/** Turret pivot in tank-local space (relative to tank origin = feet of treads). */
export const TANK_TURRET_PIVOT_Y = 0.66;
export const TANK_TURRET_PIVOT_Z = 0.05;
