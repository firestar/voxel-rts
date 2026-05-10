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
// Faces -Z. Origin = feet, centered in XZ. Federation infantry: navy fatigues,
// dark navy helmet, red chest plate, white shoulder mark.

const SOLDIER_FATIGUES = { r: 0.14, g: 0.22, b: 0.46 };  // Federation navy
const SOLDIER_BOOT = { r: 0.10, g: 0.10, b: 0.14 };

/** Body, head, helmet, arms, rifle — everything above the hips. */
export function buildSoldierBodyGeometry(): THREE.BufferGeometry {
  const skin = { r: 0.85, g: 0.70, b: 0.55 };
  const helmet = { r: 0.10, g: 0.16, b: 0.36 };           // dark Federation navy helmet
  const helmetStrap = { r: 0.06, g: 0.10, b: 0.20 };
  const rifleBody = { r: 0.18, g: 0.18, b: 0.20 };
  const rifleStock = { r: 0.30, g: 0.18, b: 0.10 };
  const rifleMag = { r: 0.16, g: 0.16, b: 0.18 };
  const vest = { r: 0.72, g: 0.14, b: 0.16 };             // red chest plate
  const pouch = { r: 0.85, g: 0.85, b: 0.88 };            // white mag pouches
  const ruck = { r: 0.10, g: 0.18, b: 0.40 };             // navy ruck
  const star = { r: 0.92, g: 0.92, b: 0.95 };             // white shoulder mark

  const blocks: VoxelBlock[] = [
    // Torso.
    { x: 0.00, y: 0.78, z: 0.00, sx: 0.46, sy: 0.50, sz: 0.28, ...SOLDIER_FATIGUES },
    // Vest plate front + back so torso reads as armoured.
    { x: 0.00, y: 0.78, z: -0.14, sx: 0.40, sy: 0.42, sz: 0.05, ...vest },
    { x: 0.00, y: 0.78, z:  0.14, sx: 0.40, sy: 0.42, sz: 0.05, ...vest },
    // Mag pouches across the lower chest.
    { x: -0.14, y: 0.66, z: -0.16, sx: 0.12, sy: 0.16, sz: 0.04, ...pouch },
    { x:  0.00, y: 0.66, z: -0.16, sx: 0.12, sy: 0.16, sz: 0.04, ...pouch },
    { x:  0.14, y: 0.66, z: -0.16, sx: 0.12, sy: 0.16, sz: 0.04, ...pouch },
    // Small rucksack on back so silhouette isn't flat from the rear.
    { x: 0.00, y: 0.84, z: 0.22, sx: 0.36, sy: 0.36, sz: 0.16, ...ruck },
    { x: 0.00, y: 1.02, z: 0.24, sx: 0.30, sy: 0.04, sz: 0.14, ...helmetStrap },
    // Neck + head.
    { x: 0.00, y: 1.07, z: 0.00, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    { x: 0.00, y: 1.22, z: 0.00, sx: 0.32, sy: 0.30, sz: 0.32, ...skin },
    // Helmet — slightly taller dome with chinstrap.
    { x: 0.00, y: 1.40, z: 0.00, sx: 0.40, sy: 0.18, sz: 0.40, ...helmet },
    { x: 0.00, y: 1.30, z: 0.00, sx: 0.42, sy: 0.04, sz: 0.42, ...helmetStrap },
    // Helmet brim (visible from above).
    { x: 0.00, y: 1.36, z: -0.18, sx: 0.36, sy: 0.06, sz: 0.06, ...helmetStrap },
    // White Federation star on the front of the helmet — visible from the front.
    { x: 0.00, y: 1.42, z: -0.20, sx: 0.10, sy: 0.10, sz: 0.02, ...star },
    // Arms — right held forward to grip rifle, left at side.
    { x: -0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...SOLDIER_FATIGUES },
    { x:  0.30, y: 0.85, z: -0.08, sx: 0.14, sy: 0.18, sz: 0.30, ...SOLDIER_FATIGUES },
    { x:  0.30, y: 0.66, z: -0.18, sx: 0.14, sy: 0.18, sz: 0.18, ...SOLDIER_FATIGUES },
    // Rifle barrel + stock + magazine + iron sights.
    { x:  0.30, y: 0.84, z: -0.40, sx: 0.07, sy: 0.07, sz: 0.50, ...rifleBody },
    { x:  0.30, y: 0.84, z:  0.02, sx: 0.07, sy: 0.10, sz: 0.20, ...rifleStock },
    // Curved magazine hanging below the receiver.
    { x:  0.30, y: 0.72, z: -0.20, sx: 0.06, sy: 0.16, sz: 0.10, ...rifleMag },
    // Front + rear iron sights.
    { x:  0.30, y: 0.92, z: -0.34, sx: 0.04, sy: 0.06, sz: 0.05, r: 0.08, g: 0.08, b: 0.10 },
    { x:  0.30, y: 0.92, z: -0.16, sx: 0.04, sy: 0.06, sz: 0.05, r: 0.08, g: 0.08, b: 0.10 },
    // Muzzle flash hider.
    { x:  0.30, y: 0.84, z: -0.66, sx: 0.06, sy: 0.06, sz: 0.06, r: 0.10, g: 0.10, b: 0.12 },
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

// ---------- Sniper -----------------------------------------------------------
// Crouched / kneeling overwatch silhouette. Head sits at ~1.05 m vs the
// soldier's ~1.55 m so the unit reads as low-profile from the RTS camera. The
// rifle barrel extends well past the body so the elongated front-back shape
// dominates the silhouette.

const SNIPER_GHILLIE = { r: 0.32, g: 0.26, b: 0.16 };   // dark earthy brown
const SNIPER_BOOT    = { r: 0.15, g: 0.12, b: 0.08 };

/** Sniper hip is lower than the soldier's so the unit reads as crouched. */
export const SNIPER_HIP_Y = 0.32;
export const SNIPER_LEG_X = 0.10;

export function buildSniperBodyGeometry(): THREE.BufferGeometry {
  const skin       = { r: 0.85, g: 0.70, b: 0.55 };
  const balaclava  = { r: 0.20, g: 0.17, b: 0.12 };
  const rifleBody  = { r: 0.14, g: 0.14, b: 0.16 };
  const rifleStock = { r: 0.28, g: 0.18, b: 0.10 };
  const scope      = { r: 0.08, g: 0.08, b: 0.10 };
  const suppressor = { r: 0.12, g: 0.12, b: 0.14 };
  const lensGlint  = { r: 0.55, g: 0.85, b: 0.95 };
  const fringe     = { r: 0.22, g: 0.18, b: 0.10 };

  const blocks: VoxelBlock[] = [
    // Torso leans forward over the rifle.
    { x: 0.00, y: 0.55, z: 0.04, sx: 0.50, sy: 0.40, sz: 0.32, ...SNIPER_GHILLIE },
    // Ghillie strips draped over back/shoulders.
    { x: 0.00, y: 0.74, z: 0.18, sx: 0.46, sy: 0.10, sz: 0.10, ...fringe },
    { x: 0.00, y: 0.62, z: 0.21, sx: 0.40, sy: 0.18, sz: 0.04, ...fringe },
    { x: -0.20, y: 0.50, z: 0.21, sx: 0.10, sy: 0.30, sz: 0.04, ...fringe },
    { x:  0.20, y: 0.50, z: 0.21, sx: 0.10, sy: 0.30, sz: 0.04, ...fringe },
    // Neck (tilted slightly forward).
    { x: 0.00, y: 0.78, z: -0.04, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    // Head — balaclava with only eyes exposed.
    { x: 0.00, y: 0.92, z: -0.04, sx: 0.32, sy: 0.30, sz: 0.32, ...balaclava },
    { x: 0.00, y: 0.94, z: -0.20, sx: 0.16, sy: 0.10, sz: 0.04, ...skin },
    // Low-profile cap/hood — shorter than soldier's helmet so the silhouette is squatter.
    { x: 0.00, y: 1.05, z: -0.04, sx: 0.36, sy: 0.08, sz: 0.36, r: 0.24, g: 0.20, b: 0.14 },
    // Arms extended forward cradling the rifle.
    { x: -0.22, y: 0.62, z: -0.20, sx: 0.14, sy: 0.16, sz: 0.34, ...SNIPER_GHILLIE },
    { x:  0.22, y: 0.62, z: -0.20, sx: 0.14, sy: 0.16, sz: 0.34, ...SNIPER_GHILLIE },
    // Rifle stock pulled into shoulder, very long barrel out the front.
    { x:  0.00, y: 0.62, z:  0.02, sx: 0.06, sy: 0.10, sz: 0.18, ...rifleStock },
    { x:  0.00, y: 0.62, z: -0.55, sx: 0.06, sy: 0.06, sz: 0.92, ...rifleBody },
    // Long scope on top of the receiver — visible eyepiece + bell objective.
    { x:  0.00, y: 0.72, z: -0.30, sx: 0.05, sy: 0.06, sz: 0.40, ...scope },
    { x:  0.00, y: 0.72, z: -0.10, sx: 0.07, sy: 0.07, sz: 0.05, ...lensGlint },
    { x:  0.00, y: 0.72, z: -0.51, sx: 0.10, sy: 0.10, sz: 0.06, ...lensGlint },
    // Suppressor at the muzzle (front-most point of the silhouette).
    { x:  0.00, y: 0.62, z: -1.06, sx: 0.10, sy: 0.10, sz: 0.16, ...suppressor },
    // Deployed bipod splayed under barrel.
    { x: -0.10, y: 0.50, z: -0.86, sx: 0.04, sy: 0.20, sz: 0.04, r: 0.10, g: 0.10, b: 0.12 },
    { x:  0.10, y: 0.50, z: -0.86, sx: 0.04, sy: 0.20, sz: 0.04, r: 0.10, g: 0.10, b: 0.12 },
    { x: -0.10, y: 0.40, z: -0.86, sx: 0.10, sy: 0.04, sz: 0.10, r: 0.10, g: 0.10, b: 0.12 },
    { x:  0.10, y: 0.40, z: -0.86, sx: 0.10, sy: 0.04, sz: 0.10, r: 0.10, g: 0.10, b: 0.12 },
  ];
  return buildVoxelModel(blocks);
}

/**
 * Short crouched leg — pivot at SNIPER_HIP_Y. Boot lands at body origin (= u.y)
 * when un-rotated. Tucked-in shape so leg-swing animation reads as a small
 * shuffle rather than a stride.
 */
export function buildSniperLegGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    // Thigh — angled forward (knee in front of hip).
    { x: 0.0, y: -0.10, z: 0.04, sx: 0.18, sy: 0.18, sz: 0.22, ...SNIPER_GHILLIE },
    // Shin tucked back under thigh.
    { x: 0.0, y: -0.22, z: -0.02, sx: 0.16, sy: 0.16, sz: 0.20, ...SNIPER_GHILLIE },
    // Boot.
    { x: 0.0, y: -0.32, z: 0.04, sx: 0.20, sy: 0.06, sz: 0.26, ...SNIPER_BOOT },
  ];
  return buildVoxelModel(blocks);
}

// ---------- Gunner -----------------------------------------------------------
// Heavy-weapons infantry. Wide planted stance, bulky shoulder armour, belt-fed
// machine gun with prominent forward bipod, and a square ammo pack riding
// high on the back. The widened LEG_X / pauldrons make the silhouette read
// as twice the soldier's width from the RTS camera.

const GUNNER_GEAR = { r: 0.10, g: 0.16, b: 0.36 };   // Federation deep navy
const GUNNER_BOOT = { r: 0.08, g: 0.08, b: 0.12 };

/** Wider stance than the soldier so the gunner is unmistakable from above. */
export const GUNNER_HIP_Y = 0.55;
export const GUNNER_LEG_X = 0.18;

export function buildGunnerBodyGeometry(): THREE.BufferGeometry {
  const skin    = { r: 0.85, g: 0.70, b: 0.55 };
  const helmet  = { r: 0.08, g: 0.12, b: 0.28 };          // Federation navy helmet
  const vest    = { r: 0.72, g: 0.14, b: 0.16 };          // red armour plate
  const pauldron= { r: 0.85, g: 0.85, b: 0.88 };          // white shoulder armour
  const visor   = { r: 0.05, g: 0.10, b: 0.18 };
  const gunMetal= { r: 0.15, g: 0.15, b: 0.17 };
  const gunStock= { r: 0.22, g: 0.14, b: 0.08 };
  const belt    = { r: 0.55, g: 0.48, b: 0.28 };
  const ammoCan = { r: 0.10, g: 0.16, b: 0.36 };          // navy ammo can

  const blocks: VoxelBlock[] = [
    // Torso — much wider silhouette than the soldier.
    { x: 0.00, y: 0.80, z: 0.00, sx: 0.62, sy: 0.55, sz: 0.36, ...GUNNER_GEAR },
    // Heavy armour plates front + back.
    { x: 0.00, y: 0.80, z: -0.18, sx: 0.56, sy: 0.50, sz: 0.06, ...vest },
    { x: 0.00, y: 0.80, z:  0.18, sx: 0.56, sy: 0.50, sz: 0.06, ...vest },
    // Wide pauldrons so shoulders dominate the top-down silhouette — white
    // so they read as Federation team colours from above.
    { x: -0.36, y: 1.00, z: 0.00, sx: 0.18, sy: 0.16, sz: 0.30, ...pauldron },
    { x:  0.36, y: 1.00, z: 0.00, sx: 0.18, sy: 0.16, sz: 0.30, ...pauldron },
    // Ammo belt looped from the can on the back over the right shoulder to the gun.
    { x: -0.18, y: 0.90, z: -0.10, sx: 0.10, sy: 0.34, sz: 0.06, ...belt },
    { x: -0.10, y: 1.10, z:  0.10, sx: 0.16, sy: 0.04, sz: 0.16, ...belt },
    // Square ammo can riding high on the back.
    { x: 0.00, y: 0.92, z: 0.34, sx: 0.42, sy: 0.36, sz: 0.18, ...ammoCan },
    { x: 0.00, y: 1.12, z: 0.34, sx: 0.46, sy: 0.04, sz: 0.20, r: 0.10, g: 0.18, b: 0.12 },
    // Neck + head.
    { x: 0.00, y: 1.10, z: 0.00, sx: 0.18, sy: 0.10, sz: 0.18, ...skin },
    { x: 0.00, y: 1.24, z: 0.00, sx: 0.34, sy: 0.30, sz: 0.34, ...skin },
    // Helmet — large ballistic dome.
    { x: 0.00, y: 1.44, z: 0.00, sx: 0.46, sy: 0.22, sz: 0.46, ...helmet },
    { x: 0.00, y: 1.34, z: 0.00, sx: 0.46, sy: 0.06, sz: 0.46, r: 0.12, g: 0.13, b: 0.11 },
    // Tactical visor strip across the eyes.
    { x: 0.00, y: 1.26, z: -0.18, sx: 0.30, sy: 0.06, sz: 0.04, ...visor },
    // Ear/cheek guards.
    { x: -0.24, y: 1.30, z: 0.00, sx: 0.05, sy: 0.20, sz: 0.34, ...helmet },
    { x:  0.24, y: 1.30, z: 0.00, sx: 0.05, sy: 0.20, sz: 0.34, ...helmet },
    // Arms — wider apart, extended forward holding the receiver.
    { x: -0.40, y: 0.82, z: -0.06, sx: 0.16, sy: 0.50, sz: 0.26, ...GUNNER_GEAR },
    { x:  0.40, y: 0.82, z: -0.06, sx: 0.16, sy: 0.50, sz: 0.26, ...GUNNER_GEAR },
    // Machine-gun receiver — chunky and centred at waist.
    { x:  0.00, y: 0.72, z: -0.36, sx: 0.18, sy: 0.18, sz: 0.56, ...gunMetal },
    { x:  0.00, y: 0.72, z:  0.06, sx: 0.12, sy: 0.14, sz: 0.20, ...gunStock },
    // Barrel + cooling shroud — longer than soldier rifle.
    { x:  0.00, y: 0.72, z: -0.78, sx: 0.10, sy: 0.10, sz: 0.46, ...gunMetal },
    { x:  0.00, y: 0.80, z: -0.65, sx: 0.20, sy: 0.04, sz: 0.40, ...gunMetal },
    { x:  0.00, y: 0.64, z: -0.65, sx: 0.20, sy: 0.04, sz: 0.40, ...gunMetal },
    // Big bipod, splayed wide, planted in front.
    { x: -0.16, y: 0.58, z: -1.02, sx: 0.04, sy: 0.22, sz: 0.04, r: 0.10, g: 0.10, b: 0.12 },
    { x:  0.16, y: 0.58, z: -1.02, sx: 0.04, sy: 0.22, sz: 0.04, r: 0.10, g: 0.10, b: 0.12 },
    { x: -0.16, y: 0.46, z: -1.02, sx: 0.10, sy: 0.04, sz: 0.10, r: 0.10, g: 0.10, b: 0.12 },
    { x:  0.16, y: 0.46, z: -1.02, sx: 0.10, sy: 0.04, sz: 0.10, r: 0.10, g: 0.10, b: 0.12 },
    // Top-mounted carry handle / iron sights.
    { x:  0.00, y: 0.86, z: -0.34, sx: 0.06, sy: 0.10, sz: 0.26, ...gunMetal },
    // Belt-feed box on right side of the receiver.
    { x:  0.16, y: 0.66, z: -0.34, sx: 0.10, sy: 0.20, sz: 0.24, r: 0.22, g: 0.22, b: 0.24 },
  ];
  return buildVoxelModel(blocks);
}

/** Gunner leg — thicker than the soldier's, pads at the knee. */
export function buildGunnerLegGeometry(): THREE.BufferGeometry {
  const padded = { r: 0.18, g: 0.20, b: 0.16 };
  const blocks: VoxelBlock[] = [
    // Thigh.
    { x: 0.0, y: -0.16, z: 0.0, sx: 0.22, sy: 0.32, sz: 0.24, ...GUNNER_GEAR },
    // Knee pad — visible armoured cap so it reads as heavy from above.
    { x: 0.0, y: -0.32, z: 0.06, sx: 0.24, sy: 0.06, sz: 0.18, ...padded },
    // Shin.
    { x: 0.0, y: -0.43, z: 0.0, sx: 0.20, sy: 0.20, sz: 0.22, ...GUNNER_GEAR },
    // Boot.
    { x: 0.0, y: -0.55, z: 0.04, sx: 0.24, sy: 0.10, sz: 0.30, ...GUNNER_BOOT },
  ];
  return buildVoxelModel(blocks);
}

// ---------- Civilian ---------------------------------------------------------
// Unarmed resident in plain white clothes. Same proportions as the soldier
// (so the leg pivot is identical) but stripped of helmet, vest, ruck, and
// rifle — just a shirt, trousers, and a head. Reads cleanly as a non-combatant
// among the army-coloured infantry.

const CIVILIAN_SHIRT = { r: 0.94, g: 0.94, b: 0.96 };  // off-white shirt
const CIVILIAN_PANTS = { r: 0.86, g: 0.86, b: 0.90 };  // light pale trousers
const CIVILIAN_BOOT  = { r: 0.30, g: 0.22, b: 0.16 };  // brown shoes

export const CIVILIAN_HIP_Y = 0.55;
export const CIVILIAN_LEG_X = 0.10;

export function buildCivilianBodyGeometry(): THREE.BufferGeometry {
  const skin = { r: 0.85, g: 0.70, b: 0.55 };
  const hair = { r: 0.32, g: 0.22, b: 0.14 };

  const blocks: VoxelBlock[] = [
    { x: 0.00, y: 0.78, z: 0.00, sx: 0.46, sy: 0.50, sz: 0.28, ...CIVILIAN_SHIRT },
    { x: 0.00, y: 1.07, z: 0.00, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    { x: 0.00, y: 1.22, z: 0.00, sx: 0.32, sy: 0.30, sz: 0.32, ...skin },
    // Plain dark hair so the bare head reads as a person, not a mannequin.
    { x: 0.00, y: 1.37, z: 0.00, sx: 0.34, sy: 0.06, sz: 0.34, ...hair },
    { x: 0.00, y: 1.34, z: 0.10, sx: 0.30, sy: 0.10, sz: 0.10, ...hair },
    // Both arms hang at the sides — no rifle, no forward grip.
    { x: -0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...CIVILIAN_SHIRT },
    { x:  0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...CIVILIAN_SHIRT },
    // Hands.
    { x: -0.30, y: 0.54, z: 0.00, sx: 0.14, sy: 0.06, sz: 0.18, ...skin },
    { x:  0.30, y: 0.54, z: 0.00, sx: 0.14, sy: 0.06, sz: 0.18, ...skin },
  ];
  return buildVoxelModel(blocks);
}

export function buildCivilianLegGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0.0, y: -0.25, z: 0.0, sx: 0.18, sy: 0.50, sz: 0.20, ...CIVILIAN_PANTS },
    { x: 0.0, y: -0.55, z: 0.04, sx: 0.20, sy: 0.10, sz: 0.26, ...CIVILIAN_BOOT },
  ];
  return buildVoxelModel(blocks);
}

// ---------- Worker -----------------------------------------------------------
// Civilian harvester / transporter. Same scale as the soldier (~1.6 m tall)
// but in distinctive blue work clothes + yellow hard hat. Same hip pivot so
// the leg geometry can be reused with a recolour.
//
// Four visual variants match the worker's focus setting:
//   auto  — yellow hard hat,  tan shirt,    pickaxe
//   mine  — steel hard hat,   orange shirt, pickaxe
//   chop  — brown wide hat,   green shirt,  axe
//   farm  — straw wide hat,   sky-blue shirt, hoe

export type WorkerVariant = 'auto' | 'mine' | 'chop' | 'farm';

const WORKER_JEANS = { r: 0.20, g: 0.30, b: 0.55 };
const WORKER_BOOT  = { r: 0.16, g: 0.12, b: 0.10 };

const VARIANT_SHIRT: Record<WorkerVariant, { r: number; g: number; b: number }> = {
  auto:  { r: 0.78, g: 0.55, b: 0.18 },
  mine:  { r: 0.90, g: 0.45, b: 0.10 },
  chop:  { r: 0.25, g: 0.45, b: 0.20 },
  farm:  { r: 0.30, g: 0.60, b: 0.85 },
};
const VARIANT_HAT: Record<WorkerVariant, { r: number; g: number; b: number }> = {
  auto:  { r: 0.95, g: 0.78, b: 0.10 },
  mine:  { r: 0.38, g: 0.38, b: 0.42 },
  chop:  { r: 0.45, g: 0.28, b: 0.10 },
  farm:  { r: 0.88, g: 0.78, b: 0.40 },
};

export function buildWorkerBodyGeometry(variant: WorkerVariant = 'auto'): THREE.BufferGeometry {
  const skin = { r: 0.85, g: 0.70, b: 0.55 };
  const beltStrap = { r: 0.35, g: 0.22, b: 0.14 };
  const shirt = VARIANT_SHIRT[variant];
  const hat   = VARIANT_HAT[variant];

  const blocks: VoxelBlock[] = [
    { x: 0.00, y: 0.78, z: 0.00, sx: 0.46, sy: 0.50, sz: 0.28, ...shirt },
    { x: 0.00, y: 0.55, z: 0.00, sx: 0.50, sy: 0.06, sz: 0.32, ...beltStrap },
    { x: 0.00, y: 1.07, z: 0.00, sx: 0.16, sy: 0.10, sz: 0.16, ...skin },
    { x: 0.00, y: 1.22, z: 0.00, sx: 0.32, sy: 0.30, sz: 0.32, ...skin },
    { x: -0.30, y: 0.78, z: 0.00, sx: 0.14, sy: 0.46, sz: 0.18, ...shirt },
  ];

  if (variant === 'auto' || variant === 'mine') {
    // Hard hat — domed top + narrow brim
    blocks.push({ x: 0.00, y: 1.40, z: 0.00, sx: 0.36, sy: 0.14, sz: 0.36, ...hat });
    blocks.push({ x: 0.00, y: 1.32, z: 0.04, sx: 0.40, sy: 0.04, sz: 0.40, ...hat });
  } else if (variant === 'chop') {
    // Wide-brim leather hat
    blocks.push({ x: 0.00, y: 1.38, z: 0.00, sx: 0.32, sy: 0.12, sz: 0.32, ...hat });
    blocks.push({ x: 0.00, y: 1.30, z: 0.02, sx: 0.48, sy: 0.04, sz: 0.46, ...hat });
  } else {
    // Straw hat — very wide brim, flat low dome
    blocks.push({ x: 0.00, y: 1.37, z: 0.00, sx: 0.28, sy: 0.08, sz: 0.28, ...hat });
    blocks.push({ x: 0.00, y: 1.30, z: 0.02, sx: 0.54, sy: 0.03, sz: 0.52, ...hat });
  }

  return buildVoxelModel(blocks);
}

/**
 * Right arm + tool, modeled with the shoulder pivot at the local origin.
 * Tool head shape varies by variant: pickaxe (auto/mine), axe (chop), hoe (farm).
 */
export function buildWorkerArmGeometry(variant: WorkerVariant = 'auto'): THREE.BufferGeometry {
  const shirt = VARIANT_SHIRT[variant];
  const handle = { r: 0.28, g: 0.20, b: 0.12 };
  const steel  = { r: 0.55, g: 0.55, b: 0.58 };
  const blocks: VoxelBlock[] = [
    { x: 0, y: -0.09, z: -0.06, sx: 0.14, sy: 0.18, sz: 0.30, ...shirt },
    { x: 0, y: -0.28, z: -0.16, sx: 0.14, sy: 0.18, sz: 0.18, ...shirt },
    { x: 0, y: -0.10, z: -0.34, sx: 0.05, sy: 0.05, sz: 0.40, ...handle },
  ];

  if (variant === 'chop') {
    // Axe — tall vertical blade at the tip
    blocks.push({ x: 0, y: -0.10, z: -0.50, sx: 0.06, sy: 0.32, sz: 0.10, ...steel });
  } else if (variant === 'farm') {
    // Hoe — flat horizontal scraper perpendicular to handle
    blocks.push({ x: 0, y: -0.22, z: -0.50, sx: 0.28, sy: 0.04, sz: 0.10, ...steel });
  } else {
    // Pickaxe — crossways head (auto / mine)
    blocks.push({ x: 0, y: -0.10, z: -0.50, sx: 0.30, sy: 0.10, sz: 0.06, ...steel });
  }

  return buildVoxelModel(blocks);
}

/** Shoulder pivot in body-local coords — top of the right upper arm. */
export const WORKER_SHOULDER_Y = 0.94;
export const WORKER_SHOULDER_X = 0.30;

/** One worker leg, modeled identically to the soldier leg but in jeans / boot colours. */
export function buildWorkerLegGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0.0, y: -0.25, z: 0.0, sx: 0.18, sy: 0.50, sz: 0.20, ...WORKER_JEANS },
    { x: 0.0, y: -0.55, z: 0.04, sx: 0.20, sy: 0.10, sz: 0.26, ...WORKER_BOOT },
  ];
  return buildVoxelModel(blocks);
}

export type WorkerCargoKind = 'wood' | 'metal' | 'food';

/**
 * Carry pack — a small crate that floats above the worker's back when
 * carrying anything. Three variants (wood / metal / food) are colour-coded
 * so the player can tell at a glance what each worker is hauling.
 */
export function buildWorkerCrateGeometry(kind: WorkerCargoKind): THREE.BufferGeometry {
  const palette: Record<WorkerCargoKind, { body: { r: number; g: number; b: number }; trim: { r: number; g: number; b: number } }> = {
    wood:  { body: { r: 0.40, g: 0.28, b: 0.16 }, trim: { r: 0.22, g: 0.16, b: 0.10 } },
    metal: { body: { r: 0.50, g: 0.55, b: 0.65 }, trim: { r: 0.30, g: 0.32, b: 0.36 } },
    food:  { body: { r: 0.85, g: 0.65, b: 0.20 }, trim: { r: 0.45, g: 0.30, b: 0.10 } },
  };
  const { body, trim } = palette[kind];
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0, z: 0, sx: 0.34, sy: 0.30, sz: 0.26, ...body },
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
  const hull = { r: 0.14, g: 0.22, b: 0.46 };       // Federation navy
  const hullDark = { r: 0.08, g: 0.14, b: 0.32 };
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

/**
 * Turret + long cannon + commander DShK + bustle rack. Pivot at
 * TANK_TURRET_PIVOT_Y / _Z relative to hull origin. Roof detail is asymmetric
 * (commander hatch + DShK on one side, loader hatch + smoke launchers on the
 * other) so the turret yaw is legible even from straight overhead.
 */
export function buildTankTurretGeometry(): THREE.BufferGeometry {
  const turret = { r: 0.16, g: 0.24, b: 0.50 };       // Federation navy turret
  const turretDark = { r: 0.10, g: 0.16, b: 0.36 };
  const cannon = { r: 0.16, g: 0.16, b: 0.18 };
  const cannonHi = { r: 0.30, g: 0.30, b: 0.34 };
  const hatch = { r: 0.10, g: 0.14, b: 0.30 };
  const dshk = { r: 0.12, g: 0.12, b: 0.14 };
  const stowage = { r: 0.30, g: 0.26, b: 0.16 };
  const star = { r: 0.92, g: 0.92, b: 0.95 };
  const accent = { r: 0.72, g: 0.14, b: 0.16 };       // red accent stripe

  const blocks: VoxelBlock[] = [
    // Turret base (around pivot).
    { x: 0.00, y: 0.00, z: 0.00, sx: 1.30, sy: 0.36, sz: 1.30, ...turret },
    // Sloped cheek plates that flare out toward the sides.
    { x: -0.74, y: 0.10, z: -0.20, sx: 0.18, sy: 0.30, sz: 0.80, ...turretDark },
    { x:  0.74, y: 0.10, z: -0.20, sx: 0.18, sy: 0.30, sz: 0.80, ...turretDark },
    // Red accent stripe along the cheek.
    { x: -0.74, y: 0.04, z: -0.20, sx: 0.20, sy: 0.05, sz: 0.80, ...accent },
    { x:  0.74, y: 0.04, z: -0.20, sx: 0.20, sy: 0.05, sz: 0.80, ...accent },
    // Mantlet (front step) wraps around the trunnion of the gun.
    { x: 0.00, y: 0.18, z: -0.55, sx: 1.00, sy: 0.46, sz: 0.50, ...turretDark },
    // Roof.
    { x: 0.00, y: 0.36, z: 0.00, sx: 1.20, sy: 0.10, sz: 1.20, ...turret },
    // Big white Federation star painted on the turret roof — visible from above.
    { x: 0.00, y: 0.42, z: -0.05, sx: 0.40, sy: 0.02, sz: 0.40, ...star },
    // Commander cupola + hatch (right side).
    { x:  0.30, y: 0.42, z: 0.18, sx: 0.40, sy: 0.10, sz: 0.40, ...turretDark },
    { x:  0.30, y: 0.50, z: 0.18, sx: 0.32, sy: 0.06, sz: 0.32, ...hatch },
    // DShK heavy machine gun pintled on the cupola.
    { x:  0.30, y: 0.60, z:  0.04, sx: 0.06, sy: 0.06, sz: 0.40, ...dshk },
    { x:  0.30, y: 0.66, z: -0.04, sx: 0.04, sy: 0.04, sz: 0.30, ...dshk },
    { x:  0.30, y: 0.62, z:  0.18, sx: 0.20, sy: 0.10, sz: 0.10, ...dshk },
    // Loader hatch (left side).
    { x: -0.28, y: 0.42, z: 0.20, sx: 0.34, sy: 0.06, sz: 0.34, ...hatch },
    // Smoke launchers (cluster on left turret cheek).
    { x: -0.50, y: 0.40, z: -0.46, sx: 0.10, sy: 0.10, sz: 0.18, ...dshk },
    { x: -0.36, y: 0.40, z: -0.46, sx: 0.10, sy: 0.10, sz: 0.18, ...dshk },
    { x: -0.50, y: 0.50, z: -0.46, sx: 0.10, sy: 0.10, sz: 0.18, ...dshk },
    { x: -0.36, y: 0.50, z: -0.46, sx: 0.10, sy: 0.10, sz: 0.18, ...dshk },
    // Stowage bustle on the rear of the turret (tarp + boxes).
    { x: 0.00, y: 0.30, z: 0.62, sx: 1.10, sy: 0.30, sz: 0.18, ...stowage },
    { x: -0.30, y: 0.46, z: 0.62, sx: 0.30, sy: 0.10, sz: 0.18, ...stowage },
    // Antenna whips (two — one taller).
    { x: -0.50, y: 0.62, z: 0.42, sx: 0.04, sy: 0.60, sz: 0.04, r: 0.05, g: 0.05, b: 0.05 },
    { x:  0.52, y: 0.62, z: 0.42, sx: 0.04, sy: 0.40, sz: 0.04, r: 0.05, g: 0.05, b: 0.05 },
    // Long main cannon — thicker and longer than before.
    { x: 0.0, y: 0.22, z: -1.20, sx: 0.30, sy: 0.30, sz: 1.20, ...cannon },
    // Bore evacuator bulge along the barrel.
    { x: 0.0, y: 0.22, z: -1.55, sx: 0.38, sy: 0.38, sz: 0.22, ...cannonHi },
    // Front-most muzzle brake — distinct silhouette tip.
    { x: 0.0, y: 0.22, z: -1.92, sx: 0.42, sy: 0.20, sz: 0.18, ...cannonHi },
    { x: 0.0, y: 0.22, z: -1.92, sx: 0.20, sy: 0.42, sz: 0.18, ...cannonHi },
    { x: 0.0, y: 0.22, z: -2.04, sx: 0.30, sy: 0.30, sz: 0.08, ...cannonHi },
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
 * spins about its forward axis (the unit's local Z). The outer disc is widened so it
 * over-fills the chassis width and reads as the dominant element of the silhouette.
 */
export function buildTunnelerDrillGeometry(): THREE.BufferGeometry {
  const headOuter = { r: 0.40, g: 0.40, b: 0.45 };
  const headInner = { r: 0.55, g: 0.55, b: 0.60 };
  const headCenter = { r: 0.70, g: 0.70, b: 0.75 };
  const tooth = { r: 0.85, g: 0.85, b: 0.90 };
  const teethTip = { r: 0.95, g: 0.95, b: 1.00 };
  const rim = { r: 0.32, g: 0.32, b: 0.36 };

  const blocks: VoxelBlock[] = [];
  // Outer rim — slightly wider than the chassis so it dominates the head-on silhouette.
  blocks.push({ x: 0.0, y: 0.0, z: 0.04, sx: 3.60, sy: 3.60, sz: 0.14, ...rim });
  // Outer disc — main face plate.
  blocks.push({ x: 0.0, y: 0.0, z: -0.10, sx: 3.40, sy: 3.40, sz: 0.20, ...headOuter });
  // Mid disc.
  blocks.push({ x: 0.0, y: 0.0, z: -0.28, sx: 2.70, sy: 2.70, sz: 0.20, ...headInner });
  // Inner disc.
  blocks.push({ x: 0.0, y: 0.0, z: -0.43, sx: 1.90, sy: 1.90, sz: 0.16, ...headInner });
  // Hub.
  blocks.push({ x: 0.0, y: 0.0, z: -0.53, sx: 0.90, sy: 0.90, sz: 0.16, ...headCenter });
  // Center pilot tip — protrudes ahead of the rest of the head.
  blocks.push({ x: 0.0, y: 0.0, z: -0.66, sx: 0.50, sy: 0.50, sz: 0.14, ...headCenter });
  blocks.push({ x: 0.0, y: 0.0, z: -0.78, sx: 0.20, sy: 0.20, sz: 0.16, ...teethTip });

  // Outer ring of cutter teeth — bigger and more numerous so the perimeter reads as serrated.
  const teethCount = 18;
  for (let i = 0; i < teethCount; i++) {
    const a = (i / teethCount) * Math.PI * 2;
    const r = 1.62;
    blocks.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r, z: -0.04,
      sx: 0.26, sy: 0.26, sz: 0.36, ...tooth,
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

// ---------- Rocket truck -----------------------------------------------------
// Wheeled chassis with an independently-yawing rocket pod on the deck. Pod
// pivots around the centre of the deck so the renderer can rotate it freely
// on (turretYaw - heading) regardless of the hull's orientation.

const ROCKET_HULL = { r: 0.14, g: 0.22, b: 0.46 };       // Federation navy
const ROCKET_HULL_DARK = { r: 0.08, g: 0.14, b: 0.32 };
const ROCKET_HULL_HI = { r: 0.85, g: 0.85, b: 0.88 };    // white deck stripe
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
  // Pod base (the frame that holds the tubes) + traverse pivot disc.
  blocks.push({ x: 0, y: 0.06, z: 0.0, sx: 1.40, sy: 0.12, sz: 1.40, ...ROCKET_POD_RIM });
  blocks.push({ x: 0, y: 0.16, z: 0.0, sx: 1.30, sy: 0.20, sz: 1.40, ...ROCKET_POD_BODY });
  // Tube grid: 4 across, 2 stacked, fatter tubes than before so the pod
  // reads as a missile cluster rather than a rifle rack.
  const tubeLen = 1.70;
  const tubeR = 0.16;
  const tubeGapX = 0.36;
  const tubeRowY = [0.36, 0.72];
  for (const ty of tubeRowY) {
    for (let i = -1.5; i <= 1.5; i += 1) {
      blocks.push({
        x: i * tubeGapX, y: ty, z: -0.10,
        sx: tubeR * 2, sy: tubeR * 2, sz: tubeLen,
        ...ROCKET_POD_TUBE,
      });
      // Visible rocket nose protruding from the front of each tube.
      blocks.push({
        x: i * tubeGapX, y: ty, z: -0.10 - tubeLen * 0.5 + 0.02,
        sx: tubeR * 1.6, sy: tubeR * 1.6, sz: 0.10,
        ...ROCKET_TIP,
      });
      // Rear blast cap.
      blocks.push({
        x: i * tubeGapX, y: ty, z: -0.10 + tubeLen * 0.5 - 0.02,
        sx: tubeR * 2.3, sy: tubeR * 2.3, sz: 0.06,
        ...ROCKET_POD_RIM,
      });
    }
  }
  // Cross-bracing rings along the tube cluster — read as a real frame.
  for (const sz of [-0.55, -0.10, 0.40]) {
    blocks.push({ x: 0, y: 0.36, z: sz, sx: 1.30, sy: 0.04, sz: 0.06, ...ROCKET_POD_RIM });
    blocks.push({ x: 0, y: 0.72, z: sz, sx: 1.30, sy: 0.04, sz: 0.06, ...ROCKET_POD_RIM });
  }
  // Side reinforcement plates with cutouts.
  for (const sx of [-0.74, 0.74]) {
    blocks.push({ x: sx, y: 0.54, z: 0.0, sx: 0.08, sy: 0.65, sz: 1.30, ...ROCKET_POD_RIM });
    blocks.push({ x: sx, y: 0.36, z: -0.30, sx: 0.10, sy: 0.10, sz: 0.30, ...ROCKET_POD_BODY });
    blocks.push({ x: sx, y: 0.72, z: -0.30, sx: 0.10, sy: 0.10, sz: 0.30, ...ROCKET_POD_BODY });
  }
  // Rear-pointing aiming hydraulic — visible wedge that lifts the pod up.
  blocks.push({ x: 0, y: 0.30, z: 0.55, sx: 0.18, sy: 0.18, sz: 0.40, ...ROCKET_POD_RIM });
  blocks.push({ x: 0, y: 0.16, z: 0.55, sx: 0.30, sy: 0.10, sz: 0.20, ...ROCKET_POD_BODY });
  return buildVoxelModel(blocks);
}

/** Pod pivot in unit-local coords — sits in the centre of the rear deck. */
export const ROCKET_TRUCK_POD_PIVOT_Y = 1.00;
export const ROCKET_TRUCK_POD_PIVOT_Z = 0.55;

// ---------- AA vehicle ---------------------------------------------------
// Wheeled anti-air platform. Same chassis silhouette as the rocket truck so
// the model shares the road-physics feel, but with a quad-barrel flak gun
// where the rocket pod would be. Federation red/white/blue trim distinguishes
// it from the navy rocket truck.

const AA_HULL      = { r: 0.18, g: 0.30, b: 0.20 }; // olive drab
const AA_HULL_DARK = { r: 0.10, g: 0.18, b: 0.12 };
const AA_HULL_HI   = { r: 0.72, g: 0.14, b: 0.16 }; // red trim band
const AA_DECK      = { r: 0.85, g: 0.85, b: 0.88 }; // white deck
const AA_TIRE      = { r: 0.08, g: 0.08, b: 0.10 };
const AA_HUB       = { r: 0.45, g: 0.45, b: 0.45 };
const AA_GLASS     = { r: 0.20, g: 0.45, b: 0.55 };
const AA_GUN_BODY  = { r: 0.28, g: 0.32, b: 0.28 };
const AA_GUN_RIM   = { r: 0.55, g: 0.55, b: 0.58 };
const AA_BARREL    = { r: 0.18, g: 0.20, b: 0.18 };
const AA_RADAR     = { r: 0.95, g: 0.95, b: 0.95 };

export function buildAAVehicleHullGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Wheels: four tires.
  for (const sx of [-0.95, 0.95]) {
    for (const sz of [-1.05, 1.05]) {
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.40, sy: 0.80, sz: 0.80, ...AA_TIRE });
      blocks.push({ x: sx, y: 0.40, z: sz, sx: 0.30, sy: 0.40, sz: 0.40, ...AA_HUB });
    }
  }
  // Lower frame.
  blocks.push({ x: 0.0, y: 0.50, z: 0.0, sx: 1.70, sy: 0.30, sz: 2.70, ...AA_HULL_DARK });
  // Cab over the front wheels — slightly shorter than rocket truck so the
  // gun mount has more clearance.
  blocks.push({ x: 0.0, y: 0.95, z: -1.00, sx: 1.40, sy: 0.80, sz: 0.90, ...AA_HULL });
  blocks.push({ x: 0.0, y: 1.36, z: -1.00, sx: 1.45, sy: 0.10, sz: 0.95, ...AA_HULL_DARK });
  // Cab windscreen.
  blocks.push({ x: 0.0, y: 1.06, z: -1.42, sx: 1.10, sy: 0.40, sz: 0.05, ...AA_GLASS });
  // Side windows.
  blocks.push({ x: -0.73, y: 1.06, z: -1.00, sx: 0.05, sy: 0.36, sz: 0.65, ...AA_GLASS });
  blocks.push({ x:  0.73, y: 1.06, z: -1.00, sx: 0.05, sy: 0.36, sz: 0.65, ...AA_GLASS });
  // Front bumper + red Federation trim band on the cab roof.
  blocks.push({ x: 0.0, y: 0.55, z: -1.50, sx: 1.60, sy: 0.20, sz: 0.10, ...AA_GUN_RIM });
  blocks.push({ x: 0.0, y: 1.42, z: -0.70, sx: 1.20, sy: 0.04, sz: 0.10, ...AA_HULL_HI });
  // Rear deck base where the gun mount sits.
  blocks.push({ x: 0.0, y: 0.85, z: 0.55, sx: 1.50, sy: 0.18, sz: 1.40, ...AA_DECK });
  // Turntable ring.
  blocks.push({ x: 0.0, y: 0.95, z: 0.55, sx: 1.20, sy: 0.05, sz: 1.20, ...AA_GUN_RIM });
  return buildVoxelModel(blocks);
}

/**
 * The flak gun mount — a yawing quad-barrel cannon with a small acquisition
 * radar dish above the breech. Origin is at the centre of the turntable so
 * a Y rotation on this geometry yaws the gun freely. Faces -Z by default so
 * the barrels point forward.
 */
export function buildAAVehiclePodGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Mount base + breech housing.
  blocks.push({ x: 0, y: 0.06, z: 0.0, sx: 1.10, sy: 0.12, sz: 1.10, ...AA_GUN_RIM });
  blocks.push({ x: 0, y: 0.18, z: 0.0, sx: 0.95, sy: 0.20, sz: 0.95, ...AA_GUN_BODY });
  // Breech / gunner shield rises behind the barrels.
  blocks.push({ x: 0, y: 0.55, z: 0.30, sx: 0.85, sy: 0.55, sz: 0.20, ...AA_GUN_BODY });
  blocks.push({ x: 0, y: 0.85, z: 0.40, sx: 0.95, sy: 0.10, sz: 0.05, ...AA_GUN_RIM });
  // Quad barrels — 2x2 arrangement pointing -Z.
  const barrelLen = 1.60;
  const barrelR = 0.07;
  for (const bx of [-0.20, 0.20]) {
    for (const by of [0.45, 0.70]) {
      blocks.push({
        x: bx, y: by, z: -0.30,
        sx: barrelR * 2, sy: barrelR * 2, sz: barrelLen,
        ...AA_BARREL,
      });
      // Muzzle brake at the front of each barrel.
      blocks.push({
        x: bx, y: by, z: -0.30 - barrelLen * 0.5 - 0.04,
        sx: barrelR * 2.6, sy: barrelR * 2.6, sz: 0.10,
        ...AA_GUN_RIM,
      });
    }
  }
  // Cross-yoke that holds the barrel pairs together at the muzzle.
  blocks.push({ x: 0, y: 0.575, z: -1.00, sx: 0.55, sy: 0.06, sz: 0.06, ...AA_GUN_RIM });
  // Radar / sight cluster on top of the breech.
  blocks.push({ x: 0, y: 1.05, z: 0.40, sx: 0.10, sy: 0.30, sz: 0.10, ...AA_GUN_BODY });
  blocks.push({ x: 0, y: 1.22, z: 0.40, sx: 0.55, sy: 0.05, sz: 0.30, ...AA_RADAR });
  return buildVoxelModel(blocks);
}

/** Pod pivot in unit-local coords — same as the rocket truck so the chassis
 *  shares the rear-deck mount geometry. */
export const AA_VEHICLE_POD_PIVOT_Y = 1.00;
export const AA_VEHICLE_POD_PIVOT_Z = 0.55;

// ---------- Supply truck -------------------------------------------------
// Unarmed logistics flatbed. Hull is built at 0.5× the original design scale.
// Crates are a separate geometry so the renderer can show 0–5 levels of cargo.

const SUPPLY_HULL      = { r: 0.85, g: 0.85, b: 0.88 }; // Federation white
const SUPPLY_HULL_DARK = { r: 0.10, g: 0.16, b: 0.36 }; // navy chassis
const SUPPLY_HULL_HI   = { r: 0.72, g: 0.14, b: 0.16 }; // red flatbed accent
const SUPPLY_TIRE      = { r: 0.08, g: 0.08, b: 0.10 };
const SUPPLY_HUB       = { r: 0.50, g: 0.50, b: 0.50 };
const SUPPLY_GLASS     = { r: 0.20, g: 0.45, b: 0.55 };
const SUPPLY_CRATE     = { r: 0.50, g: 0.38, b: 0.18 }; // wooden crate brown
const SUPPLY_CRATE_RIM = { r: 0.30, g: 0.22, b: 0.10 };

// Hull only — no crates. All coordinates are 0.5× the original design values.
export function buildSupplyTruckHullGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Wheels: six tires (two axles at rear for load bearing).
  for (const sx of [-0.41, 0.41]) {
    for (const sz of [-0.525, 0.20, 0.60]) {
      blocks.push({ x: sx, y: 0.17, z: sz, sx: 0.16, sy: 0.34, sz: 0.34, ...SUPPLY_TIRE });
      blocks.push({ x: sx, y: 0.17, z: sz, sx: 0.12, sy: 0.18, sz: 0.18, ...SUPPLY_HUB });
    }
  }
  // Lower frame / chassis.
  blocks.push({ x: 0.0, y: 0.22, z: 0.025, sx: 0.75, sy: 0.12, sz: 1.30, ...SUPPLY_HULL_DARK });
  // Cab over front axle.
  blocks.push({ x: 0.0, y: 0.44, z: -0.50, sx: 0.65, sy: 0.40, sz: 0.45, ...SUPPLY_HULL });
  blocks.push({ x: 0.0, y: 0.675, z: -0.50, sx: 0.66, sy: 0.04, sz: 0.46, ...SUPPLY_HULL_DARK });
  // Windscreen.
  blocks.push({ x: 0.0, y: 0.525, z: -0.725, sx: 0.50, sy: 0.20, sz: 0.025, ...SUPPLY_GLASS });
  // Side windows.
  blocks.push({ x: -0.34, y: 0.525, z: -0.50, sx: 0.025, sy: 0.18, sz: 0.325, ...SUPPLY_GLASS });
  blocks.push({ x:  0.34, y: 0.525, z: -0.50, sx: 0.025, sy: 0.18, sz: 0.325, ...SUPPLY_GLASS });
  // Flatbed floor.
  blocks.push({ x: 0.0, y: 0.35, z: 0.36, sx: 0.69, sy: 0.05, sz: 0.79, ...SUPPLY_HULL_HI });
  // Flatbed side rails.
  blocks.push({ x: -0.36, y: 0.45, z: 0.36, sx: 0.03, sy: 0.16, sz: 0.79, ...SUPPLY_HULL_DARK });
  blocks.push({ x:  0.36, y: 0.45, z: 0.36, sx: 0.03, sy: 0.16, sz: 0.79, ...SUPPLY_HULL_DARK });
  // Rear gate.
  blocks.push({ x: 0.0, y: 0.44, z: 0.745, sx: 0.72, sy: 0.17, sz: 0.03, ...SUPPLY_HULL_DARK });
  return buildVoxelModel(blocks);
}

// Crate geometry for cargo level 1–5. Each level adds more crates on the flatbed.
// Flatbed surface is at y ≈ 0.375; crate body is 0.19 tall, so first-layer
// centres sit at y ≈ 0.47, second layer at y ≈ 0.66.
export function buildSupplyTruckCratesGeometry(level: 1 | 2 | 3 | 4 | 5): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];

  const addCrate = (cx: number, cy: number, cz: number): void => {
    blocks.push({ x: cx, y: cy, z: cz, sx: 0.26, sy: 0.19, sz: 0.30, ...SUPPLY_CRATE });
    blocks.push({ x: cx, y: cy, z: cz, sx: 0.28, sy: 0.20, sz: 0.32, ...SUPPLY_CRATE_RIM });
  };

  const y0 = 0.47; // bottom layer centre
  const y1 = 0.66; // stacked layer centre

  if (level >= 1) addCrate(0.00,  y0, 0.36);
  if (level >= 2) addCrate(-0.14, y0, 0.36);
  if (level >= 2) addCrate( 0.14, y0, 0.36);
  if (level >= 3) {
    // Shift the first two back and add a third in front.
    blocks.length = 0;
    addCrate(-0.14, y0, 0.22);
    addCrate( 0.14, y0, 0.22);
    addCrate(0.00,  y0, 0.52);
  }
  if (level >= 4) {
    blocks.length = 0;
    addCrate(-0.14, y0, 0.22);
    addCrate( 0.14, y0, 0.22);
    addCrate(-0.14, y0, 0.52);
    addCrate( 0.14, y0, 0.52);
  }
  if (level >= 5) addCrate(0.00, y1, 0.37);

  return buildVoxelModel(blocks);
}
