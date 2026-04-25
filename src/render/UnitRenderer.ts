import * as THREE from 'three';
import { Unit, UnitManager } from '../sim/Units';

/**
 * Renders units as instanced upright capsules with a flat color.
 * Selection ring drawn separately (one per selected unit).
 */
export class UnitRenderer {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private capacity: number;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private selectionRing: THREE.LineSegments;

  constructor(capacity = 256) {
    this.capacity = capacity;
    const geo = new THREE.CapsuleGeometry(0.35, 0.7, 4, 8);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // Single selection ring (unit circle) reused by translation per selected unit.
    const segs = 24;
    const positions: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const b = ((i + 1) / segs) * Math.PI * 2;
      positions.push(Math.cos(a) * 0.6, 0.02, Math.sin(a) * 0.6);
      positions.push(Math.cos(b) * 0.6, 0.02, Math.sin(b) * 0.6);
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const ringMat = new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.85 });
    this.selectionRing = new THREE.LineSegments(ringGeo, ringMat);
    this.selectionRing.renderOrder = 999;
    this.selectionRing.visible = false;
    this.group.add(this.selectionRing);
  }

  update(units: UnitManager): void {
    const colAttr = this.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const colArr = colAttr.array as Float32Array;
    let n = 0;
    let firstSelected: Unit | null = null;
    for (const u of units.units) {
      if (n >= this.capacity) break;
      this.dummy.position.set(u.x, u.y + 0.7, u.z);
      this.dummy.rotation.set(0, u.heading, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n, this.dummy.matrix);
      // Color by kind. Soldier = warm orange, tunneler = cool teal.
      if (u.kind === 'soldier') { this.color.setRGB(0.95, 0.55, 0.2); }
      else { this.color.setRGB(0.25, 0.75, 0.85); }
      colArr[n * 3 + 0] = this.color.r;
      colArr[n * 3 + 1] = this.color.g;
      colArr[n * 3 + 2] = this.color.b;
      if (u.selected && !firstSelected) firstSelected = u;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colAttr.needsUpdate = true;

    if (firstSelected) {
      this.selectionRing.visible = true;
      this.selectionRing.position.set(firstSelected.x, firstSelected.y + 0.05, firstSelected.z);
    } else {
      this.selectionRing.visible = false;
    }
  }
}
