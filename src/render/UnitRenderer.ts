import * as THREE from 'three';
import { Unit, UnitManager } from '../sim/Units';
import {
  buildSoldierBodyGeometry, buildSoldierLegGeometry, SOLDIER_HIP_Y, SOLDIER_LEG_X,
  buildTankHullGeometry, buildTankTurretGeometry, TANK_TURRET_PIVOT_Y, TANK_TURRET_PIVOT_Z,
  buildTunnelerHullGeometry, buildTunnelerDrillGeometry,
  TUNNELER_DRILL_PIVOT_Y, TUNNELER_DRILL_PIVOT_Z,
  buildWormHeadGeometry, buildWormSegmentGeometry, buildWormDrillGeometry,
  WORM_DRILL_PIVOT_Y, WORM_DRILL_PIVOT_Z, WORM_SEGMENT_COUNT,
  buildDozerHullGeometry, buildDozerBladeGeometry,
  DOZER_BLADE_PIVOT_Y, DOZER_BLADE_PIVOT_Z,
  buildHaulerHullGeometry, buildHaulerBedGeometry,
  HAULER_BED_PIVOT_Y, HAULER_BED_PIVOT_Z,
} from './UnitModels';

/**
 * Per-kind, per-part InstancedMesh renderer.
 *
 *   Soldier  — 3 parts: body, left leg, right leg. Legs counter-swing, body bobs.
 *   Tank     — 2 parts: hull, turret. Turret will rotate independently when AI lands.
 *   Tunneler — 2 parts: hull, drill. Drill spins about its forward axis.
 */
export class UnitRenderer {
  readonly group = new THREE.Group();

  private soldierBody: THREE.InstancedMesh;
  private soldierLegL: THREE.InstancedMesh;
  private soldierLegR: THREE.InstancedMesh;
  private tankHull: THREE.InstancedMesh;
  private tankTurret: THREE.InstancedMesh;
  private tunnelerHull: THREE.InstancedMesh;
  private tunnelerDrill: THREE.InstancedMesh;
  private wormHead: THREE.InstancedMesh;
  private wormDrill: THREE.InstancedMesh;
  private wormSegment: THREE.InstancedMesh;
  private dozerHull: THREE.InstancedMesh;
  private dozerBlade: THREE.InstancedMesh;
  private haulerHull: THREE.InstancedMesh;
  private haulerBed: THREE.InstancedMesh;

  private capacity: number;
  private bodyM = new THREE.Matrix4();
  private partM = new THREE.Matrix4();
  private legPivot = new THREE.Matrix4();
  private hipOffset = new THREE.Matrix4();
  private legRot = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private tmpEuler = new THREE.Euler();
  private tmpV = new THREE.Vector3();

  private selectionRingSoldier: THREE.LineSegments;
  private selectionRingTank: THREE.LineSegments;
  private selectionRingTunneler: THREE.LineSegments;
  private selectionRingWorm: THREE.LineSegments;
  private selectionRingDozer: THREE.LineSegments;
  private selectionRingHauler: THREE.LineSegments;

  constructor(capacity = 256) {
    this.capacity = capacity;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

    this.soldierBody = makeIM(buildSoldierBodyGeometry(), mat, capacity);
    this.soldierLegL = makeIM(buildSoldierLegGeometry(), mat, capacity);
    this.soldierLegR = makeIM(buildSoldierLegGeometry(), mat, capacity);
    this.tankHull = makeIM(buildTankHullGeometry(), mat, capacity);
    this.tankTurret = makeIM(buildTankTurretGeometry(), mat, capacity);
    this.tunnelerHull = makeIM(buildTunnelerHullGeometry(), mat, capacity);
    this.tunnelerDrill = makeIM(buildTunnelerDrillGeometry(), mat, capacity);
    this.wormHead = makeIM(buildWormHeadGeometry(), mat, capacity);
    this.wormDrill = makeIM(buildWormDrillGeometry(), mat, capacity);
    // The body-segment mesh holds capacity * SEGMENT_COUNT instances — one per
    // (worm, segment) pair — so a roomful of worms doesn't run out of slots.
    this.wormSegment = makeIM(buildWormSegmentGeometry(), mat, capacity * WORM_SEGMENT_COUNT);
    this.dozerHull = makeIM(buildDozerHullGeometry(), mat, capacity);
    this.dozerBlade = makeIM(buildDozerBladeGeometry(), mat, capacity);
    this.haulerHull = makeIM(buildHaulerHullGeometry(), mat, capacity);
    this.haulerBed = makeIM(buildHaulerBedGeometry(), mat, capacity);

    this.group.add(
      this.soldierBody, this.soldierLegL, this.soldierLegR,
      this.tankHull, this.tankTurret,
      this.tunnelerHull, this.tunnelerDrill,
      this.wormHead, this.wormDrill, this.wormSegment,
      this.dozerHull, this.dozerBlade,
      this.haulerHull, this.haulerBed,
    );

    this.selectionRingSoldier = makeSelectionRing(0.6, 0x00ff88);
    this.selectionRingTank = makeSelectionRing(1.6, 0xffaa33);
    this.selectionRingTunneler = makeSelectionRing(0.7, 0xffe066);
    this.selectionRingWorm = makeSelectionRing(0.9, 0xc266ff);
    this.selectionRingDozer = makeSelectionRing(1.7, 0xffc044);
    this.selectionRingHauler = makeSelectionRing(1.5, 0xff5544);
    this.selectionRingSoldier.visible = false;
    this.selectionRingTank.visible = false;
    this.selectionRingTunneler.visible = false;
    this.selectionRingWorm.visible = false;
    this.selectionRingDozer.visible = false;
    this.selectionRingHauler.visible = false;
    this.group.add(
      this.selectionRingSoldier, this.selectionRingTank,
      this.selectionRingTunneler, this.selectionRingWorm,
      this.selectionRingDozer, this.selectionRingHauler,
    );
  }

  update(units: UnitManager): void {
    let nSold = 0, nTank = 0, nTun = 0, nWorm = 0, nWormSeg = 0, nDoz = 0, nHaul = 0;
    let selected: Unit | null = null;
    const now = performance.now() / 1000;

    for (const u of units.units) {
      const isMoving = u.path.length > 0;
      // Tunneler/worm chassis stays mostly level — it's the cutter that articulates to
      // follow the dig angle. We render the body with a small fraction of u.pitch
      // so it still leans into the slope a bit, then push the rest of the pitch
      // onto the drill via an extra X-rotation at its pivot. Soldier and tank
      // bodies still use the full pitch as before.
      const bodyPitchScale =
        (u.kind === 'tunneler' || u.kind === 'worm') ? 0.2
        : (u.kind === 'dozer' || u.kind === 'hauler') ? 0.6
        : 1.0;
      const bodyPitch = u.pitch * bodyPitchScale;
      const cutterExtraPitch = u.pitch - bodyPitch;
      this.tmpEuler.set(bodyPitch, u.heading, u.roll, 'YXZ');
      this.quat.setFromEuler(this.tmpEuler);
      // One-sided bob: max(0, sin) lifts the body up and lets it settle back to
      // u.y, never dipping below. The previous symmetric ±sin had the model
      // descend ~4 cm below the snapped feet on the down-swing, clipping boots
      // / treads into the voxel underneath. Collision/path always use u.y as
      // the static feet position; the renderer must never draw the model lower
      // than that. Amplitude doubled to keep the same visual lift.
      const bobFreq = u.kind === 'soldier' ? 6.0
        : u.kind === 'tank' ? 3.0
        : u.kind === 'tunneler' ? 4.0
        : u.kind === 'worm' ? 5.0
        : u.kind === 'dozer' ? 3.5
        : 3.5; // hauler
      const bobAmp  = u.kind === 'soldier' ? 0.08
        : u.kind === 'tank' ? 0.04
        : u.kind === 'tunneler' ? 0.05
        : u.kind === 'worm' ? 0.03
        : u.kind === 'dozer' ? 0.04
        : 0.05; // hauler — slightly more bounce on tires
      const sineRaw = Math.sin(u.distanceWalked * bobFreq + u.id);
      const bodyBob = isMoving ? Math.max(0, sineRaw) * bobAmp : 0;
      // Per-kind feet offset. Each model has its lowest geometry at a different
      // body-local Y; this lifts/drops the body so that lowest point lines up
      // exactly with u.y (the snapped voxel-top position).
      //   Soldier: boot bottom is at body-local y = -0.05 (hip 0.55, leg 0.60)
      //            → +0.05 lifts the boots to u.y.
      //   Tank:    tread bottom at body-local y = 0.05 → -0.05 drops the treads
      //            to u.y (was 5 cm of ground clearance which read as floating).
      //   Tunneler: tread bottom at body-local y = 0.0 already → no offset.
      const feetOffset = u.kind === 'soldier' ? 0.05
        : u.kind === 'tank' ? -0.05
        : 0.0;
      this.tmpV.set(u.x, u.y + feetOffset + bodyBob, u.z);
      this.bodyM.compose(this.tmpV, this.quat, new THREE.Vector3(1, 1, 1));

      if (u.kind === 'soldier') {
        if (nSold >= this.capacity) continue;
        this.soldierBody.setMatrixAt(nSold, this.bodyM);
        const swing = isMoving ? Math.sin(u.distanceWalked * 4.5 + u.id) * 0.6 : 0;
        this.applyLegMatrix(nSold, this.soldierLegL, swing,  +SOLDIER_LEG_X);
        this.applyLegMatrix(nSold, this.soldierLegR, -swing, -SOLDIER_LEG_X);
        nSold++;
      } else if (u.kind === 'tank') {
        if (nTank >= this.capacity) continue;
        this.tankHull.setMatrixAt(nTank, this.bodyM);
        // Turret rides on the hull at the pivot. Locked to hull yaw for now.
        this.partM.makeTranslation(0, TANK_TURRET_PIVOT_Y, TANK_TURRET_PIVOT_Z);
        this.partM.premultiply(this.bodyM);
        this.tankTurret.setMatrixAt(nTank, this.partM);
        nTank++;
      } else if (u.kind === 'tunneler') {
        if (nTun >= this.capacity) continue;
        this.tunnelerHull.setMatrixAt(nTun, this.bodyM);
        // Drill spins around its local Z axis (forward) when moving or carving.
        const spin = isMoving ? now * 18 : u.carveCooldown > 0 ? now * 12 : 0;
        const spinE = new THREE.Euler(0, 0, spin, 'XYZ');
        const spinQ = new THREE.Quaternion().setFromEuler(spinE);
        const spinM = new THREE.Matrix4().makeRotationFromQuaternion(spinQ);
        // Drill local transform = translate-to-pivot · pitch-around-X · spin-around-Z.
        // The X-rotation makes the cutter point the rest of the way along the path
        // pitch (the body only got a fraction). Pivots around the drill's mounting
        // point on the chassis.
        // Negative because the body uses a positive X-rotation in YXZ Euler to
        // represent "nose down toward the dig"; the drill is offset in +Z (forward
        // of the chassis pivot) so to visually tip the cutter down with the path
        // we need the OPPOSITE-signed rotation around X at the pivot. Without the
        // negation the cutter swung up while the path went down.
        const cutterPitchM = new THREE.Matrix4().makeRotationX(-cutterExtraPitch);
        const drillLocal = new THREE.Matrix4()
          .makeTranslation(0, TUNNELER_DRILL_PIVOT_Y, TUNNELER_DRILL_PIVOT_Z)
          .multiply(cutterPitchM)
          .multiply(spinM);
        this.partM.multiplyMatrices(this.bodyM, drillLocal);
        this.tunnelerDrill.setMatrixAt(nTun, this.partM);
        nTun++;
      } else if (u.kind === 'worm') {
        if (nWorm >= this.capacity) continue;
        this.wormHead.setMatrixAt(nWorm, this.bodyM);
        // Same drill-spin idea as the tunneler — cutter rotates around its forward
        // axis when moving/carving, with the residual path-pitch applied at the
        // mounting pivot so the head points along the dig.
        const wSpin = isMoving ? now * 22 : u.carveCooldown > 0 ? now * 14 : 0;
        const wSpinE = new THREE.Euler(0, 0, wSpin, 'XYZ');
        const wSpinQ = new THREE.Quaternion().setFromEuler(wSpinE);
        const wSpinM = new THREE.Matrix4().makeRotationFromQuaternion(wSpinQ);
        const wCutterPitchM = new THREE.Matrix4().makeRotationX(-cutterExtraPitch);
        const wDrillLocal = new THREE.Matrix4()
          .makeTranslation(0, WORM_DRILL_PIVOT_Y, WORM_DRILL_PIVOT_Z)
          .multiply(wCutterPitchM)
          .multiply(wSpinM);
        this.partM.multiplyMatrices(this.bodyM, wDrillLocal);
        this.wormDrill.setMatrixAt(nWorm, this.partM);
        nWorm++;

        // Body segments — each one has its own world position, heading, and pitch
        // that the sim already settled this frame (chain constraint + gravity).
        for (const seg of u.segments) {
          if (nWormSeg >= this.wormSegment.count + this.capacity * WORM_SEGMENT_COUNT) break;
          this.tmpEuler.set(seg.pitch * 0.7, seg.heading, 0, 'YXZ');
          this.quat.setFromEuler(this.tmpEuler);
          this.tmpV.set(seg.x, seg.y, seg.z);
          const segM = new THREE.Matrix4();
          segM.compose(this.tmpV, this.quat, new THREE.Vector3(1, 1, 1));
          this.wormSegment.setMatrixAt(nWormSeg, segM);
          nWormSeg++;
        }
      } else if (u.kind === 'dozer') {
        if (nDoz >= this.capacity) continue;
        this.dozerHull.setMatrixAt(nDoz, this.bodyM);
        // Blade rides at the front of the chassis. No moving pivot for now —
        // it's a static plate. Blade model origin is centred at the leading
        // edge, so we translate to the pivot then leave the geometry as-is.
        this.partM.makeTranslation(0, DOZER_BLADE_PIVOT_Y, DOZER_BLADE_PIVOT_Z);
        this.partM.premultiply(this.bodyM);
        this.dozerBlade.setMatrixAt(nDoz, this.partM);
        nDoz++;
      } else if (u.kind === 'hauler') {
        if (nHaul >= this.capacity) continue;
        this.haulerHull.setMatrixAt(nHaul, this.bodyM);
        // Bed tilts up when there's a pending dump job. Pivot at the rear lower
        // edge of the bed; positive X-rotation lifts the front of the bed.
        const tipping = u.haulerJob !== null && u.haulerJob.mode === 'dump' && u.spoilLoad > 0;
        const tilt = tipping ? 0.45 : 0.0;
        const bedTiltM = new THREE.Matrix4().makeRotationX(tilt);
        const bedLocal = new THREE.Matrix4()
          .makeTranslation(0, HAULER_BED_PIVOT_Y, HAULER_BED_PIVOT_Z)
          .multiply(bedTiltM);
        this.partM.multiplyMatrices(this.bodyM, bedLocal);
        this.haulerBed.setMatrixAt(nHaul, this.partM);
        nHaul++;
      }

      if (u.selected && !selected) selected = u;
    }

    this.soldierBody.count = nSold;
    this.soldierLegL.count = nSold;
    this.soldierLegR.count = nSold;
    this.tankHull.count = nTank;
    this.tankTurret.count = nTank;
    this.tunnelerHull.count = nTun;
    this.tunnelerDrill.count = nTun;
    this.wormHead.count = nWorm;
    this.wormDrill.count = nWorm;
    this.wormSegment.count = nWormSeg;
    this.dozerHull.count = nDoz;
    this.dozerBlade.count = nDoz;
    this.haulerHull.count = nHaul;
    this.haulerBed.count = nHaul;
    for (const m of [
      this.soldierBody, this.soldierLegL, this.soldierLegR,
      this.tankHull, this.tankTurret,
      this.tunnelerHull, this.tunnelerDrill,
      this.wormHead, this.wormDrill, this.wormSegment,
      this.dozerHull, this.dozerBlade,
      this.haulerHull, this.haulerBed,
    ]) {
      m.instanceMatrix.needsUpdate = true;
    }

    this.selectionRingSoldier.visible = false;
    this.selectionRingTank.visible = false;
    this.selectionRingTunneler.visible = false;
    this.selectionRingWorm.visible = false;
    this.selectionRingDozer.visible = false;
    this.selectionRingHauler.visible = false;
    if (selected) {
      const ring =
        selected.kind === 'soldier' ? this.selectionRingSoldier
        : selected.kind === 'tank' ? this.selectionRingTank
        : selected.kind === 'tunneler' ? this.selectionRingTunneler
        : selected.kind === 'worm' ? this.selectionRingWorm
        : selected.kind === 'dozer' ? this.selectionRingDozer
        : this.selectionRingHauler;
      ring.position.set(selected.x, selected.y + 0.05, selected.z);
      ring.visible = true;
    }
  }

  private applyLegMatrix(slot: number, mesh: THREE.InstancedMesh, swing: number, hipX: number): void {
    this.hipOffset.makeTranslation(hipX, SOLDIER_HIP_Y, 0);
    this.legRot.makeRotationX(swing);
    this.legPivot.multiplyMatrices(this.hipOffset, this.legRot);
    this.partM.multiplyMatrices(this.bodyM, this.legPivot);
    mesh.setMatrixAt(slot, this.partM);
  }
}

function makeIM(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, capacity);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;
  im.count = 0;
  return im;
}

function makeSelectionRing(radius: number, color: number): THREE.LineSegments {
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
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
  const ring = new THREE.LineSegments(geo, mat);
  ring.renderOrder = 999;
  return ring;
}
