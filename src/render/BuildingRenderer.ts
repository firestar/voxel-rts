import * as THREE from 'three';
import { Building } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';
import {
  buildTurbineHubGeometry, buildTurbineBladeGeometry, TURBINE_BLADE_COUNT,
  POWER_PLANT_TURBINE_Y_M,
  buildSmokePuffGeometry, SMOKE_PUFF_COUNT, SMOKE_PLUME_HEIGHT_M, SMOKE_PLUME_PERIOD_S,
  REFINERY_CHIMNEY_X_M, REFINERY_CHIMNEY_Z_M, REFINERY_CHIMNEY_TOP_Y_M,
  buildSatDishGeometry, buildPulseCoreGeometry,
  TECH_LAB_MAST_TOP_Y_M,
  buildCornStalkGeometry, buildWheatStalkGeometry,
  FARM_CORN_PER_FARM, FARM_WHEAT_PER_FARM,
  buildTurretHeadGeometry, TURRET_HEAD_Y_M,
} from './BuildingModels';

/**
 * Per-building, per-part InstancedMesh renderer for animated accessories that sit on
 * top of the stamped voxel structures.
 *
 *   Power plant — wind turbine: hub + 3 blades, blades spin around the hub's
 *                  forward axis (slow continuous rotation when the building is alive).
 *   Refinery    — smoke puffs: SMOKE_PUFF_COUNT puff instances rise from the chimney
 *                  on a staggered loop (translate + scale-down toward the top).
 *   Tech lab    — satellite dish + pulsing core: dish yaws back and forth, the core
 *                  brightness pulses with a cosine wave.
 */
export class BuildingRenderer {
  readonly group = new THREE.Group();

  private turbineHub: THREE.InstancedMesh;
  private turbineBlade: THREE.InstancedMesh;
  private smoke: THREE.InstancedMesh;
  private satDish: THREE.InstancedMesh;
  private pulseCore: THREE.InstancedMesh;
  private cornStalk: THREE.InstancedMesh;
  private wheatStalk: THREE.InstancedMesh;
  private turretHead: THREE.InstancedMesh;

  private capacity: number;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpScale = new THREE.Vector3(1, 1, 1);
  private tmpEuler = new THREE.Euler();

  constructor(capacity = 64) {
    this.capacity = capacity;
    const lit = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Pulse core uses a basic (unlit) material whose colour we modulate — that's how
    // it reads as "emissive" without paying for a real emissive map.
    const emissive = new THREE.MeshBasicMaterial({ vertexColors: true });

    this.turbineHub = makeIM(buildTurbineHubGeometry(), lit, capacity);
    this.turbineBlade = makeIM(buildTurbineBladeGeometry(), lit, capacity * TURBINE_BLADE_COUNT);
    this.smoke = makeIM(buildSmokePuffGeometry(), lit, capacity * SMOKE_PUFF_COUNT);
    this.satDish = makeIM(buildSatDishGeometry(), lit, capacity);
    this.pulseCore = makeIM(buildPulseCoreGeometry(), emissive, capacity);
    // Farm crops — one corn + one wheat instance per stalk slot per farm.
    // Stalk-instance count is bounded by `capacity * FARM_*_PER_FARM` so a
    // map-full of farms doesn't run out of slots.
    this.cornStalk = makeIM(buildCornStalkGeometry(), lit, capacity * FARM_CORN_PER_FARM);
    this.wheatStalk = makeIM(buildWheatStalkGeometry(), lit, capacity * FARM_WHEAT_PER_FARM);
    this.turretHead = makeIM(buildTurretHeadGeometry(), lit, capacity);

    this.group.add(
      this.turbineHub, this.turbineBlade,
      this.smoke,
      this.satDish, this.pulseCore,
      this.cornStalk, this.wheatStalk,
      this.turretHead,
    );
  }

  update(buildings: Building[]): void {
    let nHub = 0, nBlade = 0, nSmoke = 0, nDish = 0, nCore = 0, nCorn = 0, nWheat = 0, nTurret = 0;
    const t = performance.now() / 1000;

    // Pulse colour modulation for the tech-lab core (shared across all labs).
    const pulse = 0.5 + 0.5 * Math.cos(t * 2.4);
    const coreColor = new THREE.Color(0.4 + 0.6 * pulse, 0.7 + 0.3 * pulse, 1.0);
    (this.pulseCore.material as THREE.MeshBasicMaterial).color.copy(coreColor);

    for (const b of buildings) {
      if (b.destroyed) continue;
      const cx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const floorTopY = (b.floorY + 1) * VOXEL_SIZE;
      // Per-building phase so identical buildings don't pulse / spin in lockstep.
      const phase = b.id * 0.5710;

      switch (b.spec.kind) {
        case 'power_plant':
          if (nHub >= this.capacity) break;
          this.placePowerPlantTurbine(b.id, cx, cz, floorTopY, t + phase, nHub, nBlade);
          nHub++;
          nBlade += TURBINE_BLADE_COUNT;
          break;
        case 'refinery':
          this.placeRefinerySmoke(cx, cz, floorTopY, t + phase, nSmoke);
          nSmoke += SMOKE_PUFF_COUNT;
          break;
        case 'tech_lab':
          if (nDish >= this.capacity) break;
          this.placeTechLabAccessories(cx, cz, floorTopY, t + phase, nDish, nCore);
          nDish++;
          nCore++;
          break;
        case 'farm':
          this.placeFarmCrops(b, cx, cz, floorTopY, t, nCorn, nWheat);
          nCorn += FARM_CORN_PER_FARM;
          nWheat += FARM_WHEAT_PER_FARM;
          break;
        case 'turret':
          if (nTurret >= this.capacity) break;
          this.placeTurretHead(b, cx, cz, floorTopY, nTurret);
          nTurret++;
          break;
        default:
          // Barracks / storage / silo: no rotating accessories. The silo's
          // missile cluster is part of the static voxel stamp.
          break;
      }
    }

    this.turbineHub.count = nHub;
    this.turbineBlade.count = nBlade;
    this.smoke.count = nSmoke;
    this.satDish.count = nDish;
    this.pulseCore.count = nCore;
    this.cornStalk.count = nCorn;
    this.wheatStalk.count = nWheat;
    this.turretHead.count = nTurret;
    for (const m of [
      this.turbineHub, this.turbineBlade,
      this.smoke,
      this.satDish, this.pulseCore,
      this.cornStalk, this.wheatStalk,
      this.turretHead,
    ]) {
      m.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Position + yaw the rotating cannon head on top of a turret. Pivot sits at
   * the top of the building's pintle column (TURRET_HEAD_Y_M above the floor
   * top) and yaws to `weaponTurretYaw` so the visible barrel points at the
   * current target.
   */
  private placeTurretHead(
    b: Building,
    cx: number, cz: number, floorTopY: number,
    slot: number,
  ): void {
    this.tmpEuler.set(0, b.weaponTurretYaw, 0, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpEuler);
    this.tmpV.set(cx, floorTopY + TURRET_HEAD_Y_M, cz);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
    this.turretHead.setMatrixAt(slot, this.tmpM);
  }

  private placePowerPlantTurbine(
    _id: number,
    cx: number, cz: number, floorTopY: number,
    t: number,
    hubSlot: number, bladeStart: number,
  ): void {
    // Hub sits at the centre of the building, on top of the pylon stub. Face the
    // turbine "forward" along -Z (matches unit convention); a slow yaw makes the
    // nacelle drift over time so the blades sweep different terrain.
    const yaw = Math.sin(t * 0.15) * 0.8;
    this.tmpEuler.set(0, yaw, 0, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpEuler);
    this.tmpV.set(cx, floorTopY + POWER_PLANT_TURBINE_Y_M, cz);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
    this.turbineHub.setMatrixAt(hubSlot, this.tmpM);

    // Blades spin around the hub's forward (-Z) axis at a steady rate. Each blade
    // is 120° offset around that axis so the three together form the rotor.
    const spin = t * 1.5; // radians/sec ~ ~14 RPM
    const hubM = this.tmpM.clone();
    for (let i = 0; i < TURBINE_BLADE_COUNT; i++) {
      const angle = spin + (i / TURBINE_BLADE_COUNT) * Math.PI * 2;
      // Blade-local: rotate around Z so the blade (which extends along +Y) sweeps
      // through the rotor plane. Slight forward Z offset so the blades clear the hub.
      const bladeLocal = new THREE.Matrix4()
        .makeTranslation(0, 0, -0.20)
        .multiply(new THREE.Matrix4().makeRotationZ(angle));
      const bladeWorld = new THREE.Matrix4().multiplyMatrices(hubM, bladeLocal);
      this.turbineBlade.setMatrixAt(bladeStart + i, bladeWorld);
    }
  }

  private placeRefinerySmoke(
    cx: number, cz: number, floorTopY: number,
    t: number,
    smokeStart: number,
  ): void {
    // Chimney top in world meters.
    const cxStack = cx + REFINERY_CHIMNEY_X_M;
    const czStack = cz + REFINERY_CHIMNEY_Z_M;
    const cyStack = floorTopY + REFINERY_CHIMNEY_TOP_Y_M;

    // Each puff cycles through the plume on a phase offset of 1/SMOKE_PUFF_COUNT of
    // the period. A puff at u = 0 is at the chimney top, u = 1 has reached the top
    // of the plume; we scale it down + drift it sideways slightly as it rises.
    for (let i = 0; i < SMOKE_PUFF_COUNT; i++) {
      const phase = i / SMOKE_PUFF_COUNT;
      const u = (((t / SMOKE_PLUME_PERIOD_S) + phase) % 1.0);
      const yOff = u * SMOKE_PLUME_HEIGHT_M;
      const sideways = Math.sin(t * 0.6 + i * 1.7) * 0.5 * u; // drifts as it rises
      const scale = (1 - u) * 1.4 + 0.4; // shrinks slightly toward the top
      this.tmpScale.set(scale, scale, scale);
      this.tmpEuler.set(0, t * 0.4 + i, 0, 'YXZ'); // slow tumble
      this.tmpQ.setFromEuler(this.tmpEuler);
      this.tmpV.set(cxStack + sideways, cyStack + yOff, czStack);
      this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
      this.smoke.setMatrixAt(smokeStart + i, this.tmpM);
    }
    this.tmpScale.set(1, 1, 1); // restore for other branches
  }

  /**
   * Lay out the corn + wheat stalks for a single farm. Stalks are placed on a
   * deterministic interior grid so they don't move between frames; only their
   * vertical scale (cropProgress) and a small wind-sway yaw oscillation
   * change per frame. Stalks shorter than ~0.05× full height are clamped so
   * an empty field doesn't show flat polygons at the soil line.
   */
  private placeFarmCrops(
    b: Building,
    cx: number, cz: number, floorTopY: number,
    t: number,
    cornStart: number, wheatStart: number,
  ): void {
    // Per-farm stable phase so different farms sway out of sync.
    const phase = b.id * 0.713;
    // Interior rectangle (skip the perimeter fence cells). Farm is 3x3 nav
    // cells; interior is the inner 1x1, ~1m square. We pack stalks in a 4x4
    // grid biased toward the centre to keep them inside the fence.
    const interiorHalfMeters = (b.spec.cellsW - 2) * NAV_CELL_VOXELS * VOXEL_SIZE * 0.5;
    const stalkProg = Math.max(0.05, b.cropProgress);
    const baseScaleY = b.cropReady ? 1.05 : stalkProg;
    const totalCorn = FARM_CORN_PER_FARM;
    const totalWheat = FARM_WHEAT_PER_FARM;
    // Lay stalks on a roughly-square grid covering totalCorn + totalWheat
    // slots. We index across the grid sequentially, alternating corn and
    // wheat so a field reads as a mixed crop.
    const total = totalCorn + totalWheat;
    const cols = Math.ceil(Math.sqrt(total));
    const rows = Math.ceil(total / cols);
    const spacingX = (interiorHalfMeters * 1.6) / cols;
    const spacingZ = (interiorHalfMeters * 1.6) / rows;
    const x0 = cx - spacingX * (cols - 1) * 0.5;
    const z0 = cz - spacingZ * (rows - 1) * 0.5;

    let cornI = 0, wheatI = 0;
    for (let i = 0; i < total; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const sx = x0 + col * spacingX;
      const sz = z0 + row * spacingZ;
      // Wind sway — small yaw oscillation so the field looks alive when ripe.
      const sway = Math.sin(t * 1.4 + phase + i * 0.31) * 0.12;
      this.tmpEuler.set(0, sway, 0, 'YXZ');
      this.tmpQ.setFromEuler(this.tmpEuler);
      this.tmpV.set(sx, floorTopY, sz);
      // Alternate corn / wheat by index parity.
      const isCorn = (i & 1) === 0 && cornI < totalCorn;
      if (isCorn) {
        this.tmpScale.set(1, baseScaleY, 1);
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
        this.cornStalk.setMatrixAt(cornStart + cornI, this.tmpM);
        cornI++;
      } else if (wheatI < totalWheat) {
        this.tmpScale.set(1, baseScaleY * 0.9, 1);
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
        this.wheatStalk.setMatrixAt(wheatStart + wheatI, this.tmpM);
        wheatI++;
      }
    }
    // Pad any leftover slots with degenerate (zero-scale) matrices so stale
    // instances from a previous farm don't render as floating relics.
    this.tmpEuler.set(0, 0, 0, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpEuler);
    this.tmpScale.set(0, 0, 0);
    this.tmpV.set(0, 0, 0);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
    for (; cornI < totalCorn; cornI++) this.cornStalk.setMatrixAt(cornStart + cornI, this.tmpM);
    for (; wheatI < totalWheat; wheatI++) this.wheatStalk.setMatrixAt(wheatStart + wheatI, this.tmpM);
    this.tmpScale.set(1, 1, 1); // restore for other branches
  }

  private placeTechLabAccessories(
    cx: number, cz: number, floorTopY: number,
    t: number,
    dishSlot: number, coreSlot: number,
  ): void {
    // Dish sits on top of the antenna mast.
    const dishY = floorTopY + TECH_LAB_MAST_TOP_Y_M;
    // Sweep yaw back and forth ±60°.
    const yaw = Math.sin(t * 0.5) * (Math.PI / 3);
    // Tilt up slightly so the dish points at the sky rather than the horizon.
    const tilt = -0.35;
    this.tmpEuler.set(tilt, yaw, 0, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpEuler);
    this.tmpV.set(cx, dishY, cz);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
    this.satDish.setMatrixAt(dishSlot, this.tmpM);

    // Pulse core sits just below the dish on the mast — small cube whose material
    // colour is updated globally at the top of update().
    this.tmpEuler.set(0, 0, 0, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpEuler);
    this.tmpV.set(cx, dishY - 0.5, cz);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpScale);
    this.pulseCore.setMatrixAt(coreSlot, this.tmpM);
  }
}

function makeIM(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, capacity);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;
  im.count = 0;
  return im;
}
