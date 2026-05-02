import * as THREE from 'three';
import { buildVoxelModel, VoxelBlock } from './UnitModels';
import { POWER_PLANT, REFINERY, TECH_LAB, TURRET, VEHICLE_DEPOT, POWER_PLANT_MAST_VOXELS } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';

// ---------- Power plant — 3-blade wind turbine -------------------------------

const TURBINE_HUB = { r: 0.55, g: 0.55, b: 0.60 };
const TURBINE_HUB_DARK = { r: 0.32, g: 0.32, b: 0.36 };
const TURBINE_NACELLE = { r: 0.78, g: 0.78, b: 0.82 };
const TURBINE_BLADE = { r: 0.92, g: 0.92, b: 0.95 };
const TURBINE_BLADE_TIP = { r: 0.30, g: 0.55, b: 0.85 };

export function buildTurbineHubGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0, z: 0.45, sx: 0.50, sy: 0.50, sz: 1.10, ...TURBINE_NACELLE },
    { x: 0, y: 0.45, z: 0.85, sx: 0.06, sy: 0.40, sz: 0.50, ...TURBINE_HUB_DARK },
    { x: 0, y: 0, z: 0.00, sx: 0.55, sy: 0.55, sz: 0.20, ...TURBINE_HUB },
    { x: 0, y: 0, z: -0.18, sx: 0.40, sy: 0.40, sz: 0.16, ...TURBINE_HUB },
    { x: 0, y: 0, z: -0.30, sx: 0.20, sy: 0.20, sz: 0.10, ...TURBINE_HUB_DARK },
  ];
  return buildVoxelModel(blocks);
}

export function buildTurbineBladeGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0.30, z: 0, sx: 0.18, sy: 0.60, sz: 0.10, ...TURBINE_BLADE },
    { x: 0, y: 0.85, z: 0, sx: 0.14, sy: 0.50, sz: 0.08, ...TURBINE_BLADE },
    { x: 0, y: 1.30, z: 0, sx: 0.10, sy: 0.40, sz: 0.06, ...TURBINE_BLADE },
    { x: 0, y: 1.55, z: 0, sx: 0.08, sy: 0.10, sz: 0.06, ...TURBINE_BLADE_TIP },
  ];
  return buildVoxelModel(blocks);
}

export const TURBINE_BLADE_COUNT = 3;

// ---------- Refinery — rising smoke puffs -----------------------------------

const SMOKE_LIGHT = { r: 0.60, g: 0.60, b: 0.62 };
const SMOKE_DARK = { r: 0.42, g: 0.42, b: 0.44 };

export function buildSmokePuffGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x:  0.00, y: 0.00, z:  0.00, sx: 0.40, sy: 0.40, sz: 0.40, ...SMOKE_LIGHT },
    { x:  0.18, y: 0.10, z: -0.08, sx: 0.30, sy: 0.30, sz: 0.30, ...SMOKE_DARK },
    { x: -0.15, y: 0.06, z:  0.10, sx: 0.30, sy: 0.30, sz: 0.30, ...SMOKE_LIGHT },
  ];
  return buildVoxelModel(blocks);
}

export const SMOKE_PUFF_COUNT = 6;
export const SMOKE_PLUME_HEIGHT_M = 5.0;
export const SMOKE_PLUME_PERIOD_S = 3.5;

// ---------- Tech lab — satellite dish + pulsing core -------------------------

const DISH_OUTER = { r: 0.78, g: 0.78, b: 0.82 };
const DISH_INNER = { r: 0.55, g: 0.55, b: 0.62 };
const DISH_RIM = { r: 0.32, g: 0.32, b: 0.36 };
const DISH_FEED = { r: 0.92, g: 0.92, b: 0.94 };

export function buildSatDishGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];
  blocks.push({ x: 0, y: 0.10, z: 0, sx: 0.18, sy: 0.20, sz: 0.18, ...DISH_RIM });
  blocks.push({ x: 0, y: 0.30, z: 0, sx: 0.40, sy: 0.10, sz: 0.10, ...DISH_RIM });
  blocks.push({ x: 0, y: 0.40, z:  0.00, sx: 1.10, sy: 1.10, sz: 0.10, ...DISH_OUTER });
  blocks.push({ x: 0, y: 0.40, z: -0.08, sx: 0.84, sy: 0.84, sz: 0.10, ...DISH_INNER });
  blocks.push({ x: 0, y: 0.40, z: -0.16, sx: 0.56, sy: 0.56, sz: 0.10, ...DISH_INNER });
  blocks.push({ x: 0, y: 0.40, z: -0.24, sx: 0.30, sy: 0.30, sz: 0.10, ...DISH_RIM });
  blocks.push({ x: 0, y: 0.40, z: -0.50, sx: 0.06, sy: 0.06, sz: 0.50, ...DISH_RIM });
  blocks.push({ x: 0, y: 0.40, z: -0.78, sx: 0.18, sy: 0.18, sz: 0.10, ...DISH_FEED });
  return buildVoxelModel(blocks);
}

export function buildPulseCoreGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0, z: 0, sx: 0.30, sy: 0.30, sz: 0.30, r: 1.0, g: 1.0, b: 1.0 },
  ];
  return buildVoxelModel(blocks);
}

export const POWER_PLANT_TURBINE_Y_M =
  (POWER_PLANT.headroomVoxels + POWER_PLANT_MAST_VOXELS) * VOXEL_SIZE;
export const POWER_PLANT_BLADE_LENGTH_M = 1.7;

const _refineryHalfW = REFINERY.cellsW * NAV_CELL_VOXELS * 0.5;
const _refineryHalfD = REFINERY.cellsD * NAV_CELL_VOXELS * 0.5;
export const REFINERY_CHIMNEY_X_M = (-_refineryHalfW + 2 + 1) * VOXEL_SIZE;
export const REFINERY_CHIMNEY_Z_M = (-_refineryHalfD + 2 + 1) * VOXEL_SIZE;
export const REFINERY_CHIMNEY_TOP_Y_M =
  (REFINERY.headroomVoxels + 24) * VOXEL_SIZE;

export const TECH_LAB_MAST_TOP_Y_M =
  (TECH_LAB.headroomVoxels + 3 * 2 + 6) * VOXEL_SIZE;

// ---------- Farm — corn + wheat stalks --------------------------------------

const STALK_STEM = { r: 0.18, g: 0.55, b: 0.15 };
const STALK_STEM_DARK = { r: 0.10, g: 0.40, b: 0.10 };
const STALK_HEAD = { r: 0.62, g: 0.78, b: 0.20 };
const STALK_TIP = { r: 0.55, g: 0.80, b: 0.24 };

export function buildCornStalkGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0.30, z: 0, sx: 0.07, sy: 0.60, sz: 0.07, ...STALK_STEM_DARK },
    { x: 0, y: 0.65, z: 0, sx: 0.05, sy: 0.30, sz: 0.05, ...STALK_STEM },
    { x:  0.10, y: 0.45, z: 0.00, sx: 0.18, sy: 0.04, sz: 0.05, ...STALK_STEM },
    { x: -0.10, y: 0.55, z: 0.00, sx: 0.18, sy: 0.04, sz: 0.05, ...STALK_STEM },
    { x: 0, y: 0.78, z: 0.05, sx: 0.08, sy: 0.18, sz: 0.06, ...STALK_HEAD },
  ];
  return buildVoxelModel(blocks);
}

export function buildWheatStalkGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0.25, z: 0, sx: 0.04, sy: 0.50, sz: 0.04, ...STALK_STEM },
    { x: 0, y: 0.55, z: 0, sx: 0.03, sy: 0.16, sz: 0.03, ...STALK_STEM_DARK },
    { x: 0, y: 0.65, z: 0, sx: 0.05, sy: 0.06, sz: 0.05, ...STALK_TIP },
    { x: 0, y: 0.70, z: 0, sx: 0.04, sy: 0.06, sz: 0.04, ...STALK_TIP },
    { x: 0, y: 0.74, z: 0, sx: 0.03, sy: 0.04, sz: 0.03, ...STALK_TIP },
  ];
  return buildVoxelModel(blocks);
}

export const FARM_CORN_PER_FARM = 8;
export const FARM_WHEAT_PER_FARM = 8;

// ---------- Turret — rotating cannon head ------------------------------------
// Detailed cannon with blast shield, mantlet armor, and recoil slide.

const TURRET_MANTLE = { r: 0.42, g: 0.45, b: 0.50 };
const TURRET_MANTLE_DARK = { r: 0.28, g: 0.30, b: 0.34 };
const TURRET_BARREL = { r: 0.22, g: 0.22, b: 0.24 };
const TURRET_BARREL_TIP = { r: 0.10, g: 0.10, b: 0.12 };
const TURRET_SHIELD = { r: 0.36, g: 0.38, b: 0.42 };
const TURRET_RIVETS = { r: 0.18, g: 0.18, b: 0.22 };

export function buildTurretHeadGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    // Wide octagonal mantlet base — faceted armour plate.
    { x: 0, y: 0.20, z:  0.00, sx: 1.10, sy: 0.40, sz: 1.10, ...TURRET_MANTLE },
    { x: 0, y: 0.20, z:  0.00, sx: 1.40, sy: 0.28, sz: 0.80, ...TURRET_MANTLE },
    // Upper turret cap — slightly smaller with bevel corners.
    { x: 0, y: 0.46, z:  0.10, sx: 0.90, sy: 0.14, sz: 0.90, ...TURRET_MANTLE_DARK },
    // Side armour skirts.
    { x:  0.48, y: 0.20, z: 0, sx: 0.14, sy: 0.38, sz: 0.80, ...TURRET_MANTLE_DARK },
    { x: -0.48, y: 0.20, z: 0, sx: 0.14, sy: 0.38, sz: 0.80, ...TURRET_MANTLE_DARK },
    // Gun mantlet — the thick cylindrical housing the barrel emerges from.
    { x: 0, y: 0.22, z: -0.42, sx: 0.48, sy: 0.42, sz: 0.55, ...TURRET_SHIELD },
    { x: 0, y: 0.22, z: -0.70, sx: 0.36, sy: 0.36, sz: 0.32, ...TURRET_SHIELD },
    // Blast deflector plates (angled wings either side of the mantlet).
    { x:  0.34, y: 0.22, z: -0.55, sx: 0.18, sy: 0.30, sz: 0.50, ...TURRET_RIVETS },
    { x: -0.34, y: 0.22, z: -0.55, sx: 0.18, sy: 0.30, sz: 0.50, ...TURRET_RIVETS },
    // Main barrel — long octagonal tube.
    { x: 0, y: 0.22, z: -1.08, sx: 0.18, sy: 0.18, sz: 0.76, ...TURRET_BARREL },
    { x: 0, y: 0.22, z: -1.42, sx: 0.14, sy: 0.14, sz: 0.60, ...TURRET_BARREL },
    // Muzzle brake — prominent cross.
    { x: 0, y: 0.22, z: -1.76, sx: 0.26, sy: 0.14, sz: 0.12, ...TURRET_BARREL_TIP },
    { x: 0, y: 0.22, z: -1.76, sx: 0.14, sy: 0.26, sz: 0.12, ...TURRET_BARREL_TIP },
    { x: 0, y: 0.22, z: -1.84, sx: 0.18, sy: 0.18, sz: 0.06, ...TURRET_BARREL_TIP },
    // Commander's cupola hatch on top.
    { x:  0.25, y: 0.52, z:  0.20, sx: 0.28, sy: 0.12, sz: 0.28, ...TURRET_MANTLE_DARK },
    { x:  0.25, y: 0.60, z:  0.20, sx: 0.18, sy: 0.08, sz: 0.18, ...TURRET_RIVETS },
    // Rangefinder stub on the left side.
    { x: -0.55, y: 0.40, z:  0.05, sx: 0.08, sy: 0.08, sz: 0.22, ...TURRET_BARREL },
  ];
  return buildVoxelModel(blocks);
}

export const TURRET_HEAD_Y_M =
  (TURRET.headroomVoxels + 4) * VOXEL_SIZE;

// ---------- AA missile launcher — 10-tube rotating rack ----------------------
// Ten missile tubes arranged in two rows of five, mounted on a rotating
// traverse that yaws to face the target. Each tube holds a visible missile
// nosecone and is separated by a steel rack frame. The whole assembly sits
// on a pivot box that bolts to the stamp's launch-pad pillar.

const RACK_FRAME   = { r: 0.28, g: 0.30, b: 0.32 };  // dark structural steel
const RACK_TUBE    = { r: 0.20, g: 0.22, b: 0.26 };  // slightly darker tube body
const RACK_BAND    = { r: 0.36, g: 0.36, b: 0.40 };  // retention bands
const MISSILE_BODY = { r: 0.72, g: 0.72, b: 0.76 };  // light grey missile body
const MISSILE_NOSE = { r: 0.85, g: 0.30, b: 0.12 };  // red nosecone
const MISSILE_FIN  = { r: 0.55, g: 0.55, b: 0.58 };  // slightly lighter fin

export function buildAALauncherGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [];

  // Pivot housing that connects to the pillar below.
  blocks.push({ x: 0, y: 0.10, z: 0.05, sx: 0.90, sy: 0.20, sz: 0.50, ...RACK_FRAME });
  // Traverse yoke — horizontal bar the two rows hang from.
  blocks.push({ x: 0, y: 0.30, z: 0.00, sx: 1.20, sy: 0.12, sz: 0.18, ...RACK_FRAME });
  // Vertical back-plate connecting the two rows.
  blocks.push({ x: 0, y: 0.52, z: 0.14, sx: 1.15, sy: 0.44, sz: 0.16, ...RACK_FRAME });

  // Two rows of 5 tubes each.
  //   Row 0 (lower): y-centre ≈ 0.38
  //   Row 1 (upper): y-centre ≈ 0.68
  // Tubes point forward (-Z); nosecones protrude from the front.
  const rows = [
    { yC: 0.38, tubeL: 1.10 },
    { yC: 0.70, tubeL: 1.10 },
  ];
  const xOffsets = [-0.48, -0.24, 0.00, 0.24, 0.48];

  for (const { yC, tubeL } of rows) {
    for (const xOff of xOffsets) {
      // Outer tube shell.
      blocks.push({
        x: xOff, y: yC, z: -(tubeL / 2 - 0.05),
        sx: 0.18, sy: 0.18, sz: tubeL,
        ...RACK_TUBE,
      });
      // Retention band (slightly wider ring near the rear).
      blocks.push({
        x: xOff, y: yC, z: 0.12,
        sx: 0.22, sy: 0.22, sz: 0.08,
        ...RACK_BAND,
      });
      // Missile body visible inside the open front of the tube.
      blocks.push({
        x: xOff, y: yC, z: -(tubeL / 2 - 0.26),
        sx: 0.13, sy: 0.13, sz: tubeL - 0.30,
        ...MISSILE_BODY,
      });
      // Red nosecone protruding slightly from the tube.
      blocks.push({
        x: xOff, y: yC, z: -(tubeL - 0.06),
        sx: 0.10, sy: 0.10, sz: 0.14,
        ...MISSILE_NOSE,
      });
      // Tail fins (two crossed slabs at the rear of each missile).
      blocks.push({
        x: xOff, y: yC, z: 0.02,
        sx: 0.20, sy: 0.06, sz: 0.10,
        ...MISSILE_FIN,
      });
      blocks.push({
        x: xOff, y: yC, z: 0.02,
        sx: 0.06, sy: 0.20, sz: 0.10,
        ...MISSILE_FIN,
      });
    }
  }

  // Side rails that stiffen the rack.
  blocks.push({ x:  0.58, y: 0.54, z: -0.38, sx: 0.08, sy: 0.52, sz: 1.00, ...RACK_FRAME });
  blocks.push({ x: -0.58, y: 0.54, z: -0.38, sx: 0.08, sy: 0.52, sz: 1.00, ...RACK_FRAME });

  return buildVoxelModel(blocks);
}

/** Y position of the AA launcher pivot above the building floor. */
export const AA_LAUNCHER_HEAD_Y_M = TURRET_HEAD_Y_M; // same pintle height

// ---------- Vehicle depot — gantry crane ------------------------------------

const CRANE_FRAME = { r: 0.62, g: 0.62, b: 0.66 };
const CRANE_FRAME_DARK = { r: 0.32, g: 0.32, b: 0.36 };
const CRANE_HOOK = { r: 0.85, g: 0.32, b: 0.20 };

export function buildDepotCraneGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0, z: 0, sx: 0.40, sy: 0.30, sz: 4.40, ...CRANE_FRAME },
    { x: 0, y: 0.20, z: 0, sx: 0.30, sy: 0.10, sz: 4.20, ...CRANE_FRAME_DARK },
    { x: 0, y: -0.10, z: 0, sx: 0.50, sy: 0.30, sz: 0.60, ...CRANE_FRAME_DARK },
    { x: 0, y: -0.65, z: 0, sx: 0.10, sy: 0.40, sz: 0.10, ...CRANE_FRAME_DARK },
    { x: 0, y: -0.95, z: 0, sx: 0.18, sy: 0.16, sz: 0.18, ...CRANE_HOOK },
  ];
  return buildVoxelModel(blocks);
}

export const VEHICLE_DEPOT_CRANE_Y_M =
  (VEHICLE_DEPOT.headroomVoxels - 3) * VOXEL_SIZE;
export const VEHICLE_DEPOT_CRANE_SLIDE_M =
  (VEHICLE_DEPOT.cellsW * NAV_CELL_VOXELS * VOXEL_SIZE) * 0.30;

// ---------- Power plant — solar panels --------------------------------------

const SOLAR_FRAME = { r: 0.32, g: 0.32, b: 0.34 };
const SOLAR_GLASS = { r: 0.10, g: 0.18, b: 0.42 };

export function buildSolarPanelGeometry(): THREE.BufferGeometry {
  const blocks: VoxelBlock[] = [
    { x: 0, y: 0.10, z: 0, sx: 0.10, sy: 0.20, sz: 0.10, ...SOLAR_FRAME },
    { x: 0, y: 0.30, z: 0, sx: 0.90, sy: 0.06, sz: 0.60, ...SOLAR_FRAME },
    { x: 0, y: 0.34, z: 0, sx: 0.84, sy: 0.04, sz: 0.54, ...SOLAR_GLASS },
  ];
  return buildVoxelModel(blocks);
}

export const POWER_PLANT_SOLAR_Y_M = (POWER_PLANT.headroomVoxels + 1) * VOXEL_SIZE;
export const POWER_PLANT_SOLAR_COUNT = 4;
