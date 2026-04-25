import * as THREE from 'three';
import { Unit, UnitManager } from '../sim/Units';
import {
  buildSoldierBodyGeometry, buildSoldierLegGeometry, SOLDIER_HIP_Y, SOLDIER_LEG_X,
  buildTankHullGeometry, buildTankTurretGeometry, TANK_TURRET_PIVOT_Y, TANK_TURRET_PIVOT_Z,
} from './UnitModels';

/**
 * Per-kind, per-part InstancedMesh renderer.
 *
 *   Soldier — 3 instanced parts: body, left leg, right leg. Legs counter-swing on
 *             distance walked so the gait reads as walking forward. Body bobs.
 *   Tank    — 2 instanced parts: hull, turret. Turret can rotate independently
 *             from the hull (currently locked to hull heading; left in for AI use).
 *
 * Each unit also gets its pitch/roll applied so it follows terrain slope.
 */
export class UnitRenderer {
  readonly group = new THREE.Group();

  private soldierBody: THREE.InstancedMesh;
  private soldierLegL: THREE.InstancedMesh;
  private soldierLegR: THREE.InstancedMesh;
  private tankHull: THREE.InstancedMesh;
  private tankTurret: THREE.InstancedMesh;

  private capacity: number;
  private bodyM = new THREE.Matrix4();
  private partM = new THREE.Matrix4();
  private legPivot = new THREE.Matrix4();
  private legBack = new THREE.Matrix4();
  private legRot = new THREE.Matrix4();
  private hipOffset = new THREE.Matrix4();
  private hipBackOffset = new THREE.Matrix4();
  private quat = new THREE.Quaternion();

  private selectionRing: THREE.LineSegments;
  private selectionRingTank: THREE.LineSegments;

  constructor(capacity = 256) {
    this.capacity = capacity;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

    this.soldierBody = makeIM(buildSoldierBodyGeometry(), mat, capacity);
    this.soldierLegL = makeIM(buildSoldierLegGeometry(), mat, capacity);
    this.soldierLegR = makeIM(buildSoldierLegGeometry(), mat, capacity);
    this.tankHull = makeIM(buildTankHullGeometry(), mat, capacity);
    this.tankTurret = makeIM(buildTankTurretGeometry(), mat, capacity);

    this.group.add(this.soldierBody, this.soldierLegL, this.soldierLegR, this.tankHull, this.tankTurret);

    this.selectionRing = makeSelectionRing(0.6);
    this.selectionRingTank = makeSelectionRing(1.0);
    this.selectionRing.visible = false;
    this.selectionRingTank.visible = false;
    this.group.add(this.selectionRing);
    this.group.add(this.selectionRingTank);
  }

  update(units: UnitManager): void {
    let ns = 0, nt = 0;
    let selected: Unit | null = null;

    for (const u of units.units) {
      const isMoving = u.path.length > 0;
      // Compute the unit's body matrix: position + heading (Y) + pitch (X) + roll (Z).
      // Order: T * Ry * Rx * Rz so pitch and roll are intrinsic about local axes.
      this.quat.setFromEuler(new THREE.Euler(u.pitch, u.heading, u.roll, 'YXZ'));
      const bodyBob = isMoving ? Math.sin(u.distanceWalked * (u.kind === 'soldier' ? 6.0 : 3.0) + u.id) * (u.kind === 'soldier' ? 0.04 : 0.02) : 0;
      this.bodyM.compose(new THREE.Vector3(u.x, u.y + bodyBob, u.z), this.quat, new THREE.Vector3(1, 1, 1));

      if (u.kind === 'soldier') {
        if (ns >= this.capacity) continue;
        this.soldierBody.setMatrixAt(ns, this.bodyM);

        // Leg swing — phase from distance walked so the gait scales with speed.
        const swing = isMoving ? Math.sin(u.distanceWalked * 4.5 + u.id) * 0.6 : 0;
        // Left leg pivots forward, right leg pivots back (counter-phase).
        this.applyLegMatrix(ns, this.soldierLegL, swing,  +SOLDIER_LEG_X);
        this.applyLegMatrix(ns, this.soldierLegR, -swing, -SOLDIER_LEG_X);
        ns++;
      } else {
        if (nt >= this.capacity) continue;
        this.tankHull.setMatrixAt(nt, this.bodyM);
        // Turret in body-local space: translate to pivot, rotate, then attach to body matrix.
        this.partM.makeTranslation(0, TANK_TURRET_PIVOT_Y, TANK_TURRET_PIVOT_Z);
        // (No turret yaw delta yet — locked to hull. Hook left in for AI to drive.)
        this.partM.premultiply(this.bodyM);
        this.tankTurret.setMatrixAt(nt, this.partM);
        nt++;
      }

      if (u.selected && !selected) selected = u;
    }

    this.soldierBody.count = ns;
    this.soldierLegL.count = ns;
    this.soldierLegR.count = ns;
    this.tankHull.count = nt;
    this.tankTurret.count = nt;
    for (const m of [this.soldierBody, this.soldierLegL, this.soldierLegR, this.tankHull, this.tankTurret]) {
      m.instanceMatrix.needsUpdate = true;
    }

    if (selected) {
      const ring = selected.kind === 'soldier' ? this.selectionRing : this.selectionRingTank;
      const other = selected.kind === 'soldier' ? this.selectionRingTank : this.selectionRing;
      ring.position.set(selected.x, selected.y + 0.05, selected.z);
      ring.visible = true;
      other.visible = false;
    } else {
      this.selectionRing.visible = false;
      this.selectionRingTank.visible = false;
    }
  }

  /** Compose a leg part's matrix from the body matrix + hip offset + leg-swing rotation. */
  private applyLegMatrix(slot: number, mesh: THREE.InstancedMesh, swing: number, hipX: number): void {
    // Body-local: translate to hip, rotate around X (swing), translate back to leg origin (hip is the leg's local 0).
    this.hipOffset.makeTranslation(hipX, SOLDIER_HIP_Y, 0);
    this.legRot.makeRotationX(swing);
    this.hipBackOffset.makeTranslation(0, 0, 0); // leg model is already centered around hip pivot
    this.legPivot.identity().multiply(this.hipOffset).multiply(this.legRot).multiply(this.hipBackOffset);
    this.legBack.multiplyMatrices(this.bodyM, this.legPivot);
    mesh.setMatrixAt(slot, this.legBack);
  }
}

function makeIM(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, capacity);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;
  im.count = 0;
  return im;
}

function makeSelectionRing(radius: number): THREE.LineSegments {
  const segs = 32;
  const positions: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const b = ((i + 1) / segs) * Math.PI * 2;
    positions.push(Math.cos(a) * radius, 0.02, Math.sin(a) * radius);
    positions.push(Math.cos(b) * radius, 0.02, Math.sin(b) * radius);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.85 });
  const ring = new THREE.LineSegments(geo, mat);
  ring.renderOrder = 999;
  return ring;
}
