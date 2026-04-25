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
 * Caller can drop the result into an InstancedMesh with `vertexColors: true` material.
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
// Faces -Z (heading 0 in our convention rotates around Y; we model the rifle
// pointing toward -Z so atan2(dx, dz) = heading aligns it with motion).
//
// All coordinates in meters. Origin = feet, centered in XZ.

export function buildSoldierGeometry(): THREE.BufferGeometry {
  const skin = { r: 0.85, g: 0.70, b: 0.55 };
  const fatigues = { r: 0.40, g: 0.45, b: 0.27 };   // olive
  const helmet = { r: 0.27, g: 0.32, b: 0.20 };
  const boot = { r: 0.18, g: 0.14, b: 0.10 };
  const rifleBody = { r: 0.18, g: 0.18, b: 0.20 };
  const rifleStock = { r: 0.30, g: 0.18, b: 0.10 };
  const vest = { r: 0.22, g: 0.25, b: 0.18 };

  const blocks: VoxelBlock[] = [
    // Legs
    { x: -0.10, y: 0.25, z: 0.0, sx: 0.18, sy: 0.50, sz: 0.20, ...fatigues },
    { x:  0.10, y: 0.25, z: 0.0, sx: 0.18, sy: 0.50, sz: 0.20, ...fatigues },
    // Boots
    { x: -0.10, y: 0.05, z: 0.02, sx: 0.20, sy: 0.10, sz: 0.26, ...boot },
    { x:  0.10, y: 0.05, z: 0.02, sx: 0.20, sy: 0.10, sz: 0.26, ...boot },
    // Torso
    { x: 0.00, y: 0.78, z: 0.00, sx: 0.46, sy: 0.50, sz: 0.28, ...fatigues },
    // Vest plate (slightly in front)
    { x: 0.00, y: 0.78, z: -0.13, sx: 0.40, sy: 0.42, sz: 0.05, ...vest },
    // Neck + head
    { x: 0.00, y: 1.07, z: 0.00, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    { x: 0.00, y: 1.22, z: 0.00, sx: 0.32, sy: 0.30, sz: 0.32, ...skin },
    // Helmet
    { x: 0.00, y: 1.40, z: 0.00, sx: 0.40, sy: 0.16, sz: 0.40, ...helmet },
    // Helmet band (darker)
    { x: 0.00, y: 1.32, z: 0.00, sx: 0.40, sy: 0.04, sz: 0.40, r: 0.18, g: 0.20, b: 0.14 },
    // Arms — right held forward to grip rifle, left at side
    { x: -0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...fatigues },
    { x:  0.30, y: 0.85, z: -0.08, sx: 0.14, sy: 0.18, sz: 0.30, ...fatigues },
    { x:  0.30, y: 0.66, z: -0.18, sx: 0.14, sy: 0.18, sz: 0.18, ...fatigues },
    // Rifle (oriented along -Z = forward)
    { x:  0.30, y: 0.84, z: -0.36, sx: 0.06, sy: 0.06, sz: 0.42, ...rifleBody },
    // Rifle stock
    { x:  0.30, y: 0.84, z: -0.04, sx: 0.06, sy: 0.10, sz: 0.16, ...rifleStock },
    // Magazine
    { x:  0.30, y: 0.74, z: -0.24, sx: 0.06, sy: 0.10, sz: 0.06, r: 0.10, g: 0.10, b: 0.12 },
    // Sight rail (small cube on top of barrel)
    { x:  0.30, y: 0.92, z: -0.30, sx: 0.04, sy: 0.04, sz: 0.10, r: 0.10, g: 0.10, b: 0.12 },
  ];
  return buildVoxelModel(blocks);
}

// ---------- Tunneler (rendered as a tank with a drill-style cannon) ----------

export function buildTunnelerGeometry(): THREE.BufferGeometry {
  const hull = { r: 0.30, g: 0.45, b: 0.35 };       // olive-teal
  const turret = { r: 0.34, g: 0.50, b: 0.40 };
  const tread = { r: 0.10, g: 0.10, b: 0.12 };
  const treadHi = { r: 0.20, g: 0.22, b: 0.24 };    // small bumps for treads
  const cannon = { r: 0.18, g: 0.18, b: 0.20 };
  const drill = { r: 0.55, g: 0.55, b: 0.60 };
  const drillTip = { r: 0.85, g: 0.85, b: 0.90 };
  const hatch = { r: 0.18, g: 0.20, b: 0.16 };

  const blocks: VoxelBlock[] = [];

  // Treads (left + right) running the length of the body.
  blocks.push({ x: -0.45, y: 0.20, z: 0.00, sx: 0.20, sy: 0.36, sz: 1.40, ...tread });
  blocks.push({ x:  0.45, y: 0.20, z: 0.00, sx: 0.20, sy: 0.36, sz: 1.40, ...tread });
  // Tread tooth bumps along outer faces — pure cosmetic.
  for (let i = -3; i <= 3; i++) {
    const z = i * 0.18;
    blocks.push({ x: -0.56, y: 0.20, z, sx: 0.04, sy: 0.10, sz: 0.10, ...treadHi });
    blocks.push({ x:  0.56, y: 0.20, z, sx: 0.04, sy: 0.10, sz: 0.10, ...treadHi });
  }

  // Lower hull skirt.
  blocks.push({ x: 0.0, y: 0.30, z: 0.0, sx: 0.74, sy: 0.18, sz: 1.30, ...hull });
  // Upper hull (chamfered impression: a slightly narrower deck).
  blocks.push({ x: 0.0, y: 0.50, z: 0.0, sx: 0.84, sy: 0.20, sz: 1.20, ...hull });
  // Glacis / front slope hint — a slim block protruding forward at deck level.
  blocks.push({ x: 0.0, y: 0.50, z: -0.62, sx: 0.74, sy: 0.16, sz: 0.10, ...hull });

  // Turret base.
  blocks.push({ x: 0.0, y: 0.66, z: 0.05, sx: 0.66, sy: 0.18, sz: 0.66, ...turret });
  // Turret mantlet (step up at front).
  blocks.push({ x: 0.0, y: 0.74, z: -0.20, sx: 0.50, sy: 0.20, sz: 0.30, ...turret });
  // Commander hatch.
  blocks.push({ x: 0.10, y: 0.80, z: 0.18, sx: 0.18, sy: 0.06, sz: 0.18, ...hatch });
  // Periscope.
  blocks.push({ x: 0.10, y: 0.86, z: 0.18, sx: 0.06, sy: 0.06, sz: 0.06, r: 0.05, g: 0.05, b: 0.08 });
  // Antenna whip — rendered as a thin tall block.
  blocks.push({ x: -0.18, y: 0.95, z: 0.20, sx: 0.02, sy: 0.30, sz: 0.02, r: 0.05, g: 0.05, b: 0.05 });

  // Cannon barrel — main horizontal cylinder approximated by stacked boxes.
  blocks.push({ x: 0.0, y: 0.78, z: -0.50, sx: 0.16, sy: 0.16, sz: 0.50, ...cannon });
  // Muzzle brake (slightly wider).
  blocks.push({ x: 0.0, y: 0.78, z: -0.78, sx: 0.20, sy: 0.20, sz: 0.10, ...cannon });

  // Drill bit on the very front of the muzzle — three stepped boxes ending in a bright tip.
  blocks.push({ x: 0.0, y: 0.78, z: -0.90, sx: 0.18, sy: 0.18, sz: 0.10, ...drill });
  blocks.push({ x: 0.0, y: 0.78, z: -1.00, sx: 0.14, sy: 0.14, sz: 0.10, ...drill });
  blocks.push({ x: 0.0, y: 0.78, z: -1.08, sx: 0.08, sy: 0.08, sz: 0.08, ...drillTip });

  return buildVoxelModel(blocks);
}
