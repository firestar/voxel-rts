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

// ---------- Tunneler ---------------------------------------------------------
// Compact drill rig — narrower than the tank, dominated by a stepped drill bit.
// Roughly 1.6 m long, 1.0 m wide, 1.2 m tall.

export function buildTunnelerHullGeometry(): THREE.BufferGeometry {
  const body = { r: 0.55, g: 0.40, b: 0.18 };       // industrial yellow
  const bodyDark = { r: 0.40, g: 0.28, b: 0.10 };
  const tread = { r: 0.10, g: 0.10, b: 0.12 };
  const treadHi = { r: 0.20, g: 0.22, b: 0.24 };
  const cabin = { r: 0.20, g: 0.45, b: 0.55 };      // teal cab glass
  const exhaust = { r: 0.25, g: 0.25, b: 0.27 };

  const blocks: VoxelBlock[] = [
    // Treads
    { x: -0.42, y: 0.22, z: 0.00, sx: 0.20, sy: 0.40, sz: 1.40, ...tread },
    { x:  0.42, y: 0.22, z: 0.00, sx: 0.20, sy: 0.40, sz: 1.40, ...tread },
  ];
  for (let i = -3; i <= 3; i++) {
    const z = i * 0.20;
    blocks.push({ x: -0.54, y: 0.22, z, sx: 0.05, sy: 0.12, sz: 0.10, ...treadHi });
    blocks.push({ x:  0.54, y: 0.22, z, sx: 0.05, sy: 0.12, sz: 0.10, ...treadHi });
  }
  // Chassis
  blocks.push({ x: 0.0, y: 0.46, z: 0.10, sx: 0.80, sy: 0.30, sz: 1.00, ...body });
  // Cabin
  blocks.push({ x: 0.0, y: 0.78, z: 0.30, sx: 0.50, sy: 0.30, sz: 0.40, ...cabin });
  // Roof bar
  blocks.push({ x: 0.0, y: 0.96, z: 0.30, sx: 0.60, sy: 0.06, sz: 0.50, ...bodyDark });
  // Drill collar (where the bit attaches)
  blocks.push({ x: 0.0, y: 0.46, z: -0.50, sx: 0.40, sy: 0.36, sz: 0.20, ...bodyDark });
  // Exhaust stack
  blocks.push({ x: -0.30, y: 0.94, z: -0.10, sx: 0.10, sy: 0.34, sz: 0.10, ...exhaust });
  return buildVoxelModel(blocks);
}

/** The drill bit, modeled as an arrow of stepped cones along -Z. Pivot at the collar. */
export function buildTunnelerDrillGeometry(): THREE.BufferGeometry {
  const drill = { r: 0.55, g: 0.55, b: 0.60 };
  const drillMid = { r: 0.70, g: 0.70, b: 0.75 };
  const drillTip = { r: 0.92, g: 0.92, b: 0.96 };
  // Coordinates relative to the drill pivot (front of the chassis).
  const blocks: VoxelBlock[] = [
    { x: 0.0, y: 0.0, z: -0.10, sx: 0.34, sy: 0.34, sz: 0.10, ...drill },
    { x: 0.0, y: 0.0, z: -0.22, sx: 0.28, sy: 0.28, sz: 0.10, ...drill },
    { x: 0.0, y: 0.0, z: -0.34, sx: 0.22, sy: 0.22, sz: 0.10, ...drillMid },
    { x: 0.0, y: 0.0, z: -0.44, sx: 0.16, sy: 0.16, sz: 0.08, ...drillMid },
    { x: 0.0, y: 0.0, z: -0.52, sx: 0.10, sy: 0.10, sz: 0.06, ...drillTip },
  ];
  // Three helical flute spikes — small angled cubes. Without skinning we just place a few
  // bumps around the perimeter at a coarse pitch; rotation animates them visually.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const r = 0.16;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.18,
      sx: 0.05, sy: 0.05, sz: 0.16, r: 0.85, g: 0.85, b: 0.90,
    });
  }
  return buildVoxelModel(blocks);
}

export const TUNNELER_DRILL_PIVOT_Y = 0.46;
export const TUNNELER_DRILL_PIVOT_Z = -0.60;
