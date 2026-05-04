import * as THREE from 'three';
import { Unit, UnitManager } from '../sim/Units';
import {
  buildSoldierBodyGeometry, buildSoldierLegGeometry, SOLDIER_HIP_Y, SOLDIER_LEG_X,
  buildSniperBodyGeometry, buildSniperLegGeometry,
  buildGunnerBodyGeometry, buildGunnerLegGeometry,
  buildTankHullGeometry, buildTankTurretGeometry, TANK_TURRET_PIVOT_Y, TANK_TURRET_PIVOT_Z,
  buildTunnelerHullGeometry, buildTunnelerDrillGeometry,
  TUNNELER_DRILL_PIVOT_Y, TUNNELER_DRILL_PIVOT_Z,
  buildWormHeadGeometry, buildWormSegmentGeometry, buildWormDrillGeometry,
  WORM_DRILL_PIVOT_Y, WORM_DRILL_PIVOT_Z, WORM_SEGMENT_COUNT,
  buildWorkerBodyGeometry, buildWorkerLegGeometry, buildWorkerArmGeometry,
  buildWorkerCrateGeometry, WorkerVariant,
  WORKER_HIP_Y, WORKER_LEG_X, WORKER_SHOULDER_X, WORKER_SHOULDER_Y,
  buildDozerHullGeometry, buildDozerBladeGeometry,
  DOZER_BLADE_PIVOT_Y, DOZER_BLADE_PIVOT_Z,
  buildRocketTruckHullGeometry, buildRocketTruckPodGeometry,
  ROCKET_TRUCK_POD_PIVOT_Y, ROCKET_TRUCK_POD_PIVOT_Z,
  buildSupplyTruckHullGeometry, buildSupplyTruckCratesGeometry,
} from './UnitModels';

const WORKER_VARIANTS: WorkerVariant[] = ['auto', 'mine', 'chop', 'farm'];
const WORKER_VARIANT_IDX: Record<string, number> = { auto: 0, mine: 1, chop: 2, farm: 3 };

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
  private sniperBody: THREE.InstancedMesh;
  private sniperLegL: THREE.InstancedMesh;
  private sniperLegR: THREE.InstancedMesh;
  private gunnerBody: THREE.InstancedMesh;
  private gunnerLegL: THREE.InstancedMesh;
  private gunnerLegR: THREE.InstancedMesh;
  private tankHull: THREE.InstancedMesh;
  private tankTurret: THREE.InstancedMesh;
  private tunnelerHull: THREE.InstancedMesh;
  private tunnelerDrill: THREE.InstancedMesh;
  private wormHead: THREE.InstancedMesh;
  private wormDrill: THREE.InstancedMesh;
  private wormSegment: THREE.InstancedMesh;
  private workerBody: THREE.InstancedMesh[] = [];
  private workerLegL: THREE.InstancedMesh[] = [];
  private workerLegR: THREE.InstancedMesh[] = [];
  private workerArm: THREE.InstancedMesh[] = [];
  private workerCrateWood: THREE.InstancedMesh;
  private workerCrateMetal: THREE.InstancedMesh;
  private dozerHull: THREE.InstancedMesh;
  private dozerBlade: THREE.InstancedMesh;
  private rocketTruckHull: THREE.InstancedMesh;
  private rocketTruckPod: THREE.InstancedMesh;
  private supplyTruckHull: THREE.InstancedMesh;
  // One crate mesh per cargo level (index 0 = level 1, index 4 = level 5).
  private supplyTruckCrates: THREE.InstancedMesh[] = [];

  private capacity: number;
  private bodyM = new THREE.Matrix4();
  private partM = new THREE.Matrix4();
  private legPivot = new THREE.Matrix4();
  private hipOffset = new THREE.Matrix4();
  private legRot = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private tmpEuler = new THREE.Euler();
  private tmpV = new THREE.Vector3();
  /**
   * Per-instance team tint. We store one Color object per team and reuse it via
   * `setColorAt`, so each instance is multiplied by either white (no tint, for
   * player units) or a red multiplier (so enemy fatigues / hulls read red while
   * still preserving the underlying voxel-colour silhouette). The instance
   * colour multiplies the per-vertex colour at draw time, so values >1 are
   * clamped to 1 — we keep all components ≤ 1.
   */
  private playerTint = new THREE.Color(1.0, 1.0, 1.0);
  private enemyTint = new THREE.Color(1.0, 0.32, 0.30);

  /**
   * Pool of selection rings keyed by unit kind. Each frame we lay out the
   * first `n` rings of a given kind onto the first `n` selected units of
   * that kind and hide the rest. The pool grows as needed; capped only by
   * how many units the player can select in practice.
   */
  private ringPools: Map<string, THREE.LineSegments[]> = new Map();
  private ringTemplates: Map<string, { radius: number; color: number }> = new Map();

  constructor(capacity = 256) {
    this.capacity = capacity;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

    this.soldierBody = makeIM(buildSoldierBodyGeometry(), mat, capacity);
    this.soldierLegL = makeIM(buildSoldierLegGeometry(), mat, capacity);
    this.soldierLegR = makeIM(buildSoldierLegGeometry(), mat, capacity);
    this.sniperBody = makeIM(buildSniperBodyGeometry(), mat, capacity);
    this.sniperLegL = makeIM(buildSniperLegGeometry(), mat, capacity);
    this.sniperLegR = makeIM(buildSniperLegGeometry(), mat, capacity);
    this.gunnerBody = makeIM(buildGunnerBodyGeometry(), mat, capacity);
    this.gunnerLegL = makeIM(buildGunnerLegGeometry(), mat, capacity);
    this.gunnerLegR = makeIM(buildGunnerLegGeometry(), mat, capacity);
    this.tankHull = makeIM(buildTankHullGeometry(), mat, capacity);
    this.tankTurret = makeIM(buildTankTurretGeometry(), mat, capacity);
    this.tunnelerHull = makeIM(buildTunnelerHullGeometry(), mat, capacity);
    this.tunnelerDrill = makeIM(buildTunnelerDrillGeometry(), mat, capacity);
    this.wormHead = makeIM(buildWormHeadGeometry(), mat, capacity);
    this.wormDrill = makeIM(buildWormDrillGeometry(), mat, capacity);
    // The body-segment mesh holds capacity * SEGMENT_COUNT instances — one per
    // (worm, segment) pair — so a roomful of worms doesn't run out of slots.
    this.wormSegment = makeIM(buildWormSegmentGeometry(), mat, capacity * WORM_SEGMENT_COUNT);
    for (const v of WORKER_VARIANTS) {
      this.workerBody.push(makeIM(buildWorkerBodyGeometry(v), mat, capacity));
      this.workerLegL.push(makeIM(buildWorkerLegGeometry(),   mat, capacity));
      this.workerLegR.push(makeIM(buildWorkerLegGeometry(),   mat, capacity));
      this.workerArm.push( makeIM(buildWorkerArmGeometry(v),  mat, capacity));
    }
    this.workerCrateWood  = makeIM(buildWorkerCrateGeometry(false), mat, capacity);
    this.workerCrateMetal = makeIM(buildWorkerCrateGeometry(true),  mat, capacity);
    this.dozerHull = makeIM(buildDozerHullGeometry(), mat, capacity);
    this.dozerBlade = makeIM(buildDozerBladeGeometry(), mat, capacity);
    this.rocketTruckHull = makeIM(buildRocketTruckHullGeometry(), mat, capacity);
    this.rocketTruckPod = makeIM(buildRocketTruckPodGeometry(), mat, capacity);
    this.supplyTruckHull = makeIM(buildSupplyTruckHullGeometry(), mat, capacity);
    for (let lv = 1; lv <= 5; lv++) {
      this.supplyTruckCrates.push(
        makeIM(buildSupplyTruckCratesGeometry(lv as 1|2|3|4|5), mat, capacity),
      );
    }

    this.group.add(
      this.soldierBody, this.soldierLegL, this.soldierLegR,
      this.sniperBody, this.sniperLegL, this.sniperLegR,
      this.gunnerBody, this.gunnerLegL, this.gunnerLegR,
      this.tankHull, this.tankTurret,
      this.tunnelerHull, this.tunnelerDrill,
      this.wormHead, this.wormDrill, this.wormSegment,
      ...this.workerBody, ...this.workerLegL, ...this.workerLegR, ...this.workerArm,
      this.workerCrateWood, this.workerCrateMetal,
      this.dozerHull, this.dozerBlade,
      this.rocketTruckHull, this.rocketTruckPod,
      this.supplyTruckHull, ...this.supplyTruckCrates,
    );

    this.ringTemplates.set('soldier',      { radius: 0.6,  color: 0x00ff88 });
    this.ringTemplates.set('sniper',       { radius: 0.6,  color: 0x88cc44 });
    this.ringTemplates.set('gunner',       { radius: 0.65, color: 0x44ddaa });
    this.ringTemplates.set('tank',         { radius: 1.6,  color: 0xffaa33 });
    this.ringTemplates.set('tunneler',     { radius: 0.7,  color: 0xffe066 });
    this.ringTemplates.set('worm',         { radius: 0.9,  color: 0xc266ff });
    this.ringTemplates.set('worker',       { radius: 0.55, color: 0x33ccff });
    this.ringTemplates.set('dozer',        { radius: 1.7,  color: 0xffc044 });
    this.ringTemplates.set('rocket_truck', { radius: 1.55, color: 0xff8855 });
    this.ringTemplates.set('supply_truck', { radius: 1.30, color: 0xffdd44 });
    for (const kind of this.ringTemplates.keys()) this.ringPools.set(kind, []);
  }

  private getRing(kind: string, idx: number): THREE.LineSegments {
    const pool = this.ringPools.get(kind)!;
    while (pool.length <= idx) {
      const tpl = this.ringTemplates.get(kind)!;
      const ring = makeSelectionRing(tpl.radius, tpl.color);
      ring.visible = false;
      this.group.add(ring);
      pool.push(ring);
    }
    return pool[idx]!;
  }

  update(units: UnitManager): void {
    let nSold = 0, nSnip = 0, nGun = 0;
    let nTank = 0, nTun = 0, nWorm = 0, nWormSeg = 0;
    const nWorkV = [0, 0, 0, 0];
    let nCrateW = 0, nCrateM = 0;
    let nDoz = 0, nRkt = 0, nSup = 0;
    const nSupCrates = [0, 0, 0, 0, 0]; // per level 1-5
    const ringCounts = new Map<string, number>();
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
        : u.kind === 'dozer' ? 0.6
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
        : u.kind === 'sniper' ? 5.0           // deliberate pace
        : u.kind === 'gunner' ? 4.5           // heavy, plodding gait
        : u.kind === 'tank' ? 3.0
        : u.kind === 'tunneler' ? 4.0
        : u.kind === 'worm' ? 5.0
        : u.kind === 'worker' ? 6.0
        : u.kind === 'dozer' ? 3.5
        : 3.5; // rocket_truck
      const bobAmp  = u.kind === 'soldier' ? 0.08
        : u.kind === 'sniper' ? 0.06
        : u.kind === 'gunner' ? 0.06
        : u.kind === 'tank' ? 0.04
        : u.kind === 'tunneler' ? 0.05
        : u.kind === 'worm' ? 0.03
        : u.kind === 'worker' ? 0.07
        : u.kind === 'dozer' ? 0.04
        : 0.05; // rocket_truck — slightly more bounce on tires
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
        : u.kind === 'sniper' ? 0.05
        : u.kind === 'gunner' ? 0.05
        : u.kind === 'tank' ? -0.05
        : u.kind === 'worker' ? 0.05
        : 0.0;
      this.tmpV.set(u.x, u.y + feetOffset + bodyBob, u.z);
      this.bodyM.compose(this.tmpV, this.quat, new THREE.Vector3(1, 1, 1));
      const tint = u.team === 'enemy' ? this.enemyTint : this.playerTint;

      if (u.kind === 'soldier') {
        if (nSold >= this.capacity) continue;
        this.soldierBody.setMatrixAt(nSold, this.bodyM);
        this.soldierBody.setColorAt(nSold, tint);
        this.soldierLegL.setColorAt(nSold, tint);
        this.soldierLegR.setColorAt(nSold, tint);
        const swing = isMoving ? Math.sin(u.distanceWalked * 4.5 + u.id) * 0.6 : 0;
        this.applyLegMatrix(nSold, this.soldierLegL, swing,  +SOLDIER_LEG_X);
        this.applyLegMatrix(nSold, this.soldierLegR, -swing, -SOLDIER_LEG_X);
        nSold++;
      } else if (u.kind === 'sniper') {
        if (nSnip >= this.capacity) continue;
        this.sniperBody.setMatrixAt(nSnip, this.bodyM);
        this.sniperBody.setColorAt(nSnip, tint);
        this.sniperLegL.setColorAt(nSnip, tint);
        this.sniperLegR.setColorAt(nSnip, tint);
        const swing = isMoving ? Math.sin(u.distanceWalked * 4.0 + u.id) * 0.55 : 0;
        this.applyLegMatrix(nSnip, this.sniperLegL, swing,  +SOLDIER_LEG_X);
        this.applyLegMatrix(nSnip, this.sniperLegR, -swing, -SOLDIER_LEG_X);
        nSnip++;
      } else if (u.kind === 'gunner') {
        if (nGun >= this.capacity) continue;
        this.gunnerBody.setMatrixAt(nGun, this.bodyM);
        this.gunnerBody.setColorAt(nGun, tint);
        this.gunnerLegL.setColorAt(nGun, tint);
        this.gunnerLegR.setColorAt(nGun, tint);
        const swing = isMoving ? Math.sin(u.distanceWalked * 3.5 + u.id) * 0.50 : 0;
        this.applyLegMatrix(nGun, this.gunnerLegL, swing,  +SOLDIER_LEG_X);
        this.applyLegMatrix(nGun, this.gunnerLegR, -swing, -SOLDIER_LEG_X);
        nGun++;
      } else if (u.kind === 'worker') {
        const vi = WORKER_VARIANT_IDX[u.workerFocus] ?? 0;
        const nW = nWorkV[vi]!;
        if (nW >= this.capacity) continue;
        const wBody = this.workerBody[vi]!;
        const wArm  = this.workerArm[vi]!;
        const wLegL = this.workerLegL[vi]!;
        const wLegR = this.workerLegR[vi]!;
        wBody.setMatrixAt(nW, this.bodyM);
        wBody.setColorAt(nW, tint);
        wLegL.setColorAt(nW, tint);
        wLegR.setColorAt(nW, tint);
        wArm.setColorAt(nW, tint);
        const swing = isMoving ? Math.sin(u.distanceWalked * 4.5 + u.id) * 0.55 : 0;
        this.applyWorkerLegMatrix(nW, wLegL, swing,  +WORKER_LEG_X);
        this.applyWorkerLegMatrix(nW, wLegR, -swing, -WORKER_LEG_X);
        const isDigging = !isMoving && (
          u.task.kind === 'chop' || u.task.kind === 'mine'
        );
        const armAngle = isDigging
          ? Math.sin(now * 6.0 + u.id * 0.37) * 0.75 - 0.25
          : 0;
        const armRotM = new THREE.Matrix4().makeRotationX(armAngle);
        const armLocal = new THREE.Matrix4()
          .makeTranslation(WORKER_SHOULDER_X, WORKER_SHOULDER_Y, 0)
          .multiply(armRotM);
        this.partM.multiplyMatrices(this.bodyM, armLocal);
        wArm.setMatrixAt(nW, this.partM);
        const carryW = u.carrying.wood;
        const carryM = u.carrying.metals;
        if (carryW + carryM > 0) {
          const crateLocal = new THREE.Matrix4().makeTranslation(0, 0.95, 0.18);
          this.partM.multiplyMatrices(this.bodyM, crateLocal);
          if (carryM > carryW) {
            this.workerCrateMetal.setMatrixAt(nCrateM, this.partM);
            this.workerCrateMetal.setColorAt(nCrateM, tint);
            nCrateM++;
          } else {
            this.workerCrateWood.setMatrixAt(nCrateW, this.partM);
            this.workerCrateWood.setColorAt(nCrateW, tint);
            nCrateW++;
          }
        }
        nWorkV[vi]++;
      } else if (u.kind === 'tank') {
        if (nTank >= this.capacity) continue;
        this.tankHull.setMatrixAt(nTank, this.bodyM);
        this.tankHull.setColorAt(nTank, tint);
        this.tankTurret.setColorAt(nTank, tint);
        // Turret rides on the hull at the pivot, but yaws independently of
        // the hull. We rotate the turret geometry by (turretYaw - heading)
        // around its own pivot so the cannon ends up pointing at the unit's
        // aim direction in world space, while the hull keeps its own yaw.
        const turretLocalYaw = wrapAngle(u.turretYaw - u.heading);
        const turretYawM = new THREE.Matrix4().makeRotationY(turretLocalYaw);
        const turretLocal = new THREE.Matrix4()
          .makeTranslation(0, TANK_TURRET_PIVOT_Y, TANK_TURRET_PIVOT_Z)
          .multiply(turretYawM);
        this.partM.multiplyMatrices(this.bodyM, turretLocal);
        this.tankTurret.setMatrixAt(nTank, this.partM);
        nTank++;
      } else if (u.kind === 'tunneler') {
        if (nTun >= this.capacity) continue;
        this.tunnelerHull.setMatrixAt(nTun, this.bodyM);
        this.tunnelerHull.setColorAt(nTun, tint);
        this.tunnelerDrill.setColorAt(nTun, tint);
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
        this.wormHead.setColorAt(nWorm, tint);
        this.wormDrill.setColorAt(nWorm, tint);
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
          this.wormSegment.setColorAt(nWormSeg, tint);
          nWormSeg++;
        }
      } else if (u.kind === 'dozer') {
        if (nDoz >= this.capacity) continue;
        this.dozerHull.setMatrixAt(nDoz, this.bodyM);
        this.dozerHull.setColorAt(nDoz, tint);
        this.dozerBlade.setColorAt(nDoz, tint);
        // Blade rides at the front of the chassis. No moving pivot for now —
        // it's a static plate. Blade model origin is centred at the leading
        // edge, so we translate to the pivot then leave the geometry as-is.
        this.partM.makeTranslation(0, DOZER_BLADE_PIVOT_Y, DOZER_BLADE_PIVOT_Z);
        this.partM.premultiply(this.bodyM);
        this.dozerBlade.setMatrixAt(nDoz, this.partM);
        nDoz++;
      } else if (u.kind === 'rocket_truck') {
        if (nRkt >= this.capacity) continue;
        this.rocketTruckHull.setMatrixAt(nRkt, this.bodyM);
        this.rocketTruckHull.setColorAt(nRkt, tint);
        this.rocketTruckPod.setColorAt(nRkt, tint);
        // Pod rides on the deck, yaws independently of the hull. Same trick
        // as the tank turret: rotate the pod geometry by (turretYaw -
        // heading) around its own pivot so it points at the world-space aim
        // direction while the hull yaws to its path heading.
        const podLocalYaw = wrapAngle(u.turretYaw - u.heading);
        const podYawM = new THREE.Matrix4().makeRotationY(podLocalYaw);
        const podLocal = new THREE.Matrix4()
          .makeTranslation(0, ROCKET_TRUCK_POD_PIVOT_Y, ROCKET_TRUCK_POD_PIVOT_Z)
          .multiply(podYawM);
        this.partM.multiplyMatrices(this.bodyM, podLocal);
        this.rocketTruckPod.setMatrixAt(nRkt, this.partM);
        nRkt++;
      } else if (u.kind === 'supply_truck') {
        if (nSup >= this.capacity) continue;
        this.supplyTruckHull.setMatrixAt(nSup, this.bodyM);
        this.supplyTruckHull.setColorAt(nSup, tint);
        // Determine cargo amount for crate level.
        let cargo = 0;
        const t = u.task;
        if (t.kind === 'truck_deliver_hq') cargo = t.payload.metals + t.payload.wood;
        else if (t.kind === 'truck_resupply') cargo = t.payload.food + t.payload.metals + t.payload.wood;
        if (cargo > 0) {
          const lv = Math.min(5, Math.ceil(cargo / 20)) - 1; // index 0-4
          const cm = this.supplyTruckCrates[lv]!;
          const ci = nSupCrates[lv]!;
          if (ci < this.capacity) {
            cm.setMatrixAt(ci, this.bodyM);
            cm.setColorAt(ci, tint);
            nSupCrates[lv] = ci + 1;
          }
        }
        nSup++;
      }

      if (u.selected) {
        const idx = ringCounts.get(u.kind) ?? 0;
        const ring = this.getRing(u.kind, idx);
        ring.position.set(u.x, u.y + 0.05, u.z);
        ring.visible = true;
        ringCounts.set(u.kind, idx + 1);
      }
    }

    this.soldierBody.count = nSold;
    this.soldierLegL.count = nSold;
    this.soldierLegR.count = nSold;
    this.sniperBody.count = nSnip;
    this.sniperLegL.count = nSnip;
    this.sniperLegR.count = nSnip;
    this.gunnerBody.count = nGun;
    this.gunnerLegL.count = nGun;
    this.gunnerLegR.count = nGun;
    this.tankHull.count = nTank;
    this.tankTurret.count = nTank;
    this.tunnelerHull.count = nTun;
    this.tunnelerDrill.count = nTun;
    this.wormHead.count = nWorm;
    this.wormDrill.count = nWorm;
    this.wormSegment.count = nWormSeg;
    for (let i = 0; i < 4; i++) {
      this.workerBody[i]!.count = nWorkV[i]!;
      this.workerLegL[i]!.count = nWorkV[i]!;
      this.workerLegR[i]!.count = nWorkV[i]!;
      this.workerArm[i]!.count  = nWorkV[i]!;
    }
    this.workerCrateWood.count = nCrateW;
    this.workerCrateMetal.count = nCrateM;
    this.dozerHull.count = nDoz;
    this.dozerBlade.count = nDoz;
    this.rocketTruckHull.count = nRkt;
    this.rocketTruckPod.count = nRkt;
    this.supplyTruckHull.count = nSup;
    for (let i = 0; i < 5; i++) this.supplyTruckCrates[i]!.count = nSupCrates[i]!;
    for (const m of [
      this.soldierBody, this.soldierLegL, this.soldierLegR,
      this.sniperBody, this.sniperLegL, this.sniperLegR,
      this.gunnerBody, this.gunnerLegL, this.gunnerLegR,
      this.tankHull, this.tankTurret,
      this.tunnelerHull, this.tunnelerDrill,
      this.wormHead, this.wormDrill, this.wormSegment,
      ...this.workerBody, ...this.workerLegL, ...this.workerLegR, ...this.workerArm,
      this.workerCrateWood, this.workerCrateMetal,
      this.dozerHull, this.dozerBlade,
      this.rocketTruckHull, this.rocketTruckPod,
      this.supplyTruckHull, ...this.supplyTruckCrates,
    ]) {
      m.instanceMatrix.needsUpdate = true;
      // instanceColor only exists once setColorAt has been called at least
      // once, so it's null on the first frame for meshes that have no
      // active instances. Guard the upload so we don't throw on a bare
      // mesh.
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // Hide any leftover rings from frames where more units were selected.
    for (const [kind, pool] of this.ringPools) {
      const used = ringCounts.get(kind) ?? 0;
      for (let i = used; i < pool.length; i++) pool[i]!.visible = false;
    }
  }

  private applyLegMatrix(slot: number, mesh: THREE.InstancedMesh, swing: number, hipX: number): void {
    this.hipOffset.makeTranslation(hipX, SOLDIER_HIP_Y, 0);
    this.legRot.makeRotationX(swing);
    this.legPivot.multiplyMatrices(this.hipOffset, this.legRot);
    this.partM.multiplyMatrices(this.bodyM, this.legPivot);
    mesh.setMatrixAt(slot, this.partM);
  }

  private applyWorkerLegMatrix(slot: number, mesh: THREE.InstancedMesh, swing: number, hipX: number): void {
    this.hipOffset.makeTranslation(hipX, WORKER_HIP_Y, 0);
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

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
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
