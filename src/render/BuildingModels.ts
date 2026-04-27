import * as THREE from 'three';
import { buildVoxelModel, VoxelBlock } from './UnitModels';
import { POWER_PLANT, REFINERY, TECH_LAB } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';

// ---------- Power plant — 3-blade wind turbine -------------------------------
// The turbine sits at the centre of the power plant roof, on top of the wood pylon
// stub stamped into the voxels. Hub geometry is centred at the origin; blades
// originate at the origin and extend along +Y (so an XYZ rotation around the
// turbine's forward axis sweeps them through the rotor plane).

const TURBINE_HUB = { r: 0.55, g: 0.55, b: 0.60 };
const TURBINE_HUB_DARK = { r: 0.32, g: 0.32, b: 0.36 };
const TURBINE_NACELLE = { r: 0.78, g: 0.78, b: 0.82 };
const TURBINE_BLADE = { r: 0.92, g: 0.92, b: 0.95 };
const TURBINE_BLADE_TIP = { r: 0.30, g: 0.55, b: 0.85 }; // blue tip

/** The hub + nacelle. Forward axis is -Z (matches the unit convention). */
export function buildTurbineHubGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    // Nacelle pod — long box behind the hub.
    { x: 0, y: 0, z: 0.45, sx: 0.50, sy: 0.50, sz: 1.10, ...TURBINE_NACELLE },
    // Tail fin on top of the nacelle.
    { x: 0, y: 0.45, z: 0.85, sx: 0.06, sy: 0.40, sz: 0.50, ...TURBINE_HUB_DARK },
    // Hub disc at the front.
    { x: 0, y: 0, z: 0.00, sx: 0.55, sy: 0.55, sz: 0.20, ...TURBINE_HUB },
    // Spinner cone tip (a stepped cap).
    { x: 0, y: 0, z: -0.18, sx: 0.40, sy: 0.40, sz: 0.16, ...TURBINE_HUB },
    { x: 0, y: 0, z: -0.30, sx: 0.20, sy: 0.20, sz: 0.10, ...TURBINE_HUB_DARK },
  ];
  return buildVoxelModel(blocks);
}

/**
 * One blade. Pivot is at the root (model origin); blade extends up +Y. The renderer
 * spins three copies of this around the hub's forward axis at 120° offsets, so the
 * three blades sweep through a vertical plane perpendicular to the nacelle.
 */
export function buildTurbineBladeGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    // Tapered blade — three stacked stretches that get thinner toward the tip.
    { x: 0, y: 0.30, z: 0, sx: 0.18, sy: 0.60, sz: 0.10, ...TURBINE_BLADE },
    { x: 0, y: 0.85, z: 0, sx: 0.14, sy: 0.50, sz: 0.08, ...TURBINE_BLADE },
    { x: 0, y: 1.30, z: 0, sx: 0.10, sy: 0.40, sz: 0.06, ...TURBINE_BLADE },
    // Blue tip cap.
    { x: 0, y: 1.55, z: 0, sx: 0.08, sy: 0.10, sz: 0.06, ...TURBINE_BLADE_TIP },
  ];
  return buildVoxelModel(blocks);
}

export const TURBINE_BLADE_COUNT = 3;

// ---------- Refinery — rising smoke puffs -----------------------------------
// Each puff is a small grey cube. The renderer instances SMOKE_PUFF_COUNT puffs
// per refinery, each with a phase offset so they stagger up the chimney plume.

const SMOKE_LIGHT = { r: 0.60, g: 0.60, b: 0.62 };
const SMOKE_DARK = { r: 0.42, g: 0.42, b: 0.44 };

/** A small "voxel cloud" — three offset cubes so puffs read as fluffy at distance. */
export function buildSmokePuffGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x:  0.00, y: 0.00, z:  0.00, sx: 0.40, sy: 0.40, sz: 0.40, ...SMOKE_LIGHT },
    { x:  0.18, y: 0.10, z: -0.08, sx: 0.30, sy: 0.30, sz: 0.30, ...SMOKE_DARK },
    { x: -0.15, y: 0.06, z:  0.10, sx: 0.30, sy: 0.30, sz: 0.30, ...SMOKE_LIGHT },
  ];
  return buildVoxelModel(blocks);
}

export const SMOKE_PUFF_COUNT = 6;
/** How tall (in metres) the smoke plume reaches above the chimney top before resetting. */
export const SMOKE_PLUME_HEIGHT_M = 5.0;
/** Period of the puff cycle in seconds (each puff travels the plume in this time). */
export const SMOKE_PLUME_PERIOD_S = 3.5;

// ---------- Tech lab — satellite dish + pulsing core -------------------------

const DISH_OUTER = { r: 0.78, g: 0.78, b: 0.82 };
const DISH_INNER = { r: 0.55, g: 0.55, b: 0.62 };
const DISH_RIM = { r: 0.32, g: 0.32, b: 0.36 };
const DISH_FEED = { r: 0.92, g: 0.92, b: 0.94 };

/**
 * Satellite dish — concentric stepped voxel rings on a cradle. Origin at the cradle
 * base; the dish faces -Z, so a yaw rotation around Y sweeps it horizontally.
 */
export function buildSatDishGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  // Cradle pin connecting to the antenna mast.
  blocks.push({ x: 0, y: 0.10, z: 0, sx: 0.18, sy: 0.20, sz: 0.18, ...DISH_RIM });
  // Tilt yoke.
  blocks.push({ x: 0, y: 0.30, z: 0, sx: 0.40, sy: 0.10, sz: 0.10, ...DISH_RIM });
  // Stepped dish — rings of decreasing radius advancing toward -Z so it's concave.
  blocks.push({ x: 0, y: 0.40, z:  0.00, sx: 1.10, sy: 1.10, sz: 0.10, ...DISH_OUTER });
  blocks.push({ x: 0, y: 0.40, z: -0.08, sx: 0.84, sy: 0.84, sz: 0.10, ...DISH_INNER });
  blocks.push({ x: 0, y: 0.40, z: -0.16, sx: 0.56, sy: 0.56, sz: 0.10, ...DISH_INNER });
  blocks.push({ x: 0, y: 0.40, z: -0.24, sx: 0.30, sy: 0.30, sz: 0.10, ...DISH_RIM });
  // Feed horn boom + antenna at the focus.
  blocks.push({ x: 0, y: 0.40, z: -0.50, sx: 0.06, sy: 0.06, sz: 0.50, ...DISH_RIM });
  blocks.push({ x: 0, y: 0.40, z: -0.78, sx: 0.18, sy: 0.18, sz: 0.10, ...DISH_FEED });
  return buildVoxelModel(blocks);
}

/** Small emissive cube that pulses on/off — the "research core". */
export function buildPulseCoreGeometry(): THREE.BufferGeometry {
  // Pure white vertex colours; the renderer uses a MeshBasicMaterial whose colour we
  // modulate per-frame for the pulse effect (so this geometry just needs uniform
  // bright colours to multiply against).
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0, z: 0, sx: 0.30, sy: 0.30, sz: 0.30, r: 1.0, g: 1.0, b: 1.0 },
  ];
  return buildVoxelModel(blocks);
}

// ---------- Per-spec local-space offsets (in metres, relative to building origin) ---
// Building origin convention: world XZ at the centre of the footprint, world Y at the
// top face of the stamped voxel floor. Matches stampXxx where yFloor = floorY + 1.
//
// Each constant below describes the local-space pivot of an animated accessory, in
// the building's own frame (no rotation — buildings don't rotate).

/** Top of the wind-turbine pylon (in metres above the building floor). */
export const POWER_PLANT_TURBINE_Y_M =
  (POWER_PLANT.headroomVoxels + 2 /* parapet */ + 6 /* pylon */) * VOXEL_SIZE;
/** Length (metres) of one turbine blade — used for the tip-circle radius. */
export const POWER_PLANT_BLADE_LENGTH_M = 1.7;

/**
 * Chimney top in the refinery's local frame. The stamp puts a 2x2 chimney column at
 * the back-left interior corner of the footprint (offset 2 voxels in each direction
 * from the nearest perimeter wall). We expose the centre of the column.
 *
 * Building origin is the centre of the footprint at floor level, so the X/Z below
 * are signed offsets from the centre.
 */
const _refineryHalfW = REFINERY.cellsW * NAV_CELL_VOXELS * 0.5;
const _refineryHalfD = REFINERY.cellsD * NAV_CELL_VOXELS * 0.5;
export const REFINERY_CHIMNEY_X_M = (-_refineryHalfW + 2 + 1) * VOXEL_SIZE;
export const REFINERY_CHIMNEY_Z_M = (-_refineryHalfD + 2 + 1) * VOXEL_SIZE;
export const REFINERY_CHIMNEY_TOP_Y_M =
  (REFINERY.headroomVoxels + 24 /* chimney height */) * VOXEL_SIZE;

/** Top of the tech-lab antenna mast. */
export const TECH_LAB_MAST_TOP_Y_M =
  (TECH_LAB.headroomVoxels + 3 /* dome tiers */ * 2 + 6 /* mast height */) * VOXEL_SIZE;

// ---------- Farm — corn + wheat stalks --------------------------------------
// Each stalk is a thin column geometry, origin at the base. The renderer
// scales stalks vertically by `cropProgress` so newly-planted fields show
// short shoots while ripe fields show full-height plants. We provide two
// stalk variants — corn (taller, thicker, with a small head at the top) and
// wheat (shorter, slimmer, tapered tip) — and alternate between them inside
// each farm so a field reads as a mixed crop.
//
// All stalks are kept green per the user spec ("have the crops be green
// (corn and wheat)"); the head/tip uses a slightly lighter / yellow-tinged
// green to suggest seed-bearing material without going outright golden.

const STALK_STEM = { r: 0.18, g: 0.55, b: 0.15 };
const STALK_STEM_DARK = { r: 0.10, g: 0.40, b: 0.10 };
const STALK_HEAD = { r: 0.62, g: 0.78, b: 0.20 };
const STALK_TIP = { r: 0.55, g: 0.80, b: 0.24 };

/**
 * Corn stalk — taller column with a small "ear" near the top. Origin at the
 * base; full height ~0.9 m, so a stalk with `cropProgress == 1` matches the
 * farm fence height without looming above it.
 */
export function buildCornStalkGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0.30, z: 0, sx: 0.07, sy: 0.60, sz: 0.07, ...STALK_STEM_DARK },
    { x: 0, y: 0.65, z: 0, sx: 0.05, sy: 0.30, sz: 0.05, ...STALK_STEM },
    // Two leaves angled out (just rectangular slabs - reads as foliage at distance).
    { x:  0.10, y: 0.45, z: 0.00, sx: 0.18, sy: 0.04, sz: 0.05, ...STALK_STEM },
    { x: -0.10, y: 0.55, z: 0.00, sx: 0.18, sy: 0.04, sz: 0.05, ...STALK_STEM },
    // Ear / cob near the top — small fat block in muted yellow-green.
    { x: 0, y: 0.78, z: 0.05, sx: 0.08, sy: 0.18, sz: 0.06, ...STALK_HEAD },
  ];
  return buildVoxelModel(blocks);
}

/**
 * Wheat stalk — slimmer, shorter column tapering to a single seed-head spike.
 * Same origin convention; full height ~0.7 m so wheat tiles are noticeably
 * shorter than corn tiles at full ripeness.
 */
export function buildWheatStalkGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0.25, z: 0, sx: 0.04, sy: 0.50, sz: 0.04, ...STALK_STEM },
    { x: 0, y: 0.55, z: 0, sx: 0.03, sy: 0.16, sz: 0.03, ...STALK_STEM_DARK },
    // Spiky head — three small blocks stacked tightly to suggest the husk.
    { x: 0, y: 0.65, z: 0, sx: 0.05, sy: 0.06, sz: 0.05, ...STALK_TIP },
    { x: 0, y: 0.70, z: 0, sx: 0.04, sy: 0.06, sz: 0.04, ...STALK_TIP },
    { x: 0, y: 0.74, z: 0, sx: 0.03, sy: 0.04, sz: 0.03, ...STALK_TIP },
  ];
  return buildVoxelModel(blocks);
}

/** Per-farm count of each stalk variant. */
export const FARM_CORN_PER_FARM = 8;
export const FARM_WHEAT_PER_FARM = 8;
