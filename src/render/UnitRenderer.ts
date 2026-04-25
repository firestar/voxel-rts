import * as THREE from 'three';
import { Unit, UnitManager } from '../sim/Units';
import { buildSoldierGeometry, buildTunnelerGeometry } from './UnitModels';

/**
 * Per-kind InstancedMesh renderer. Each unit kind has a hand-built voxel composite
 * geometry baked with vertex colors; per-instance data is just the world transform.
 *
 * A small walk bob (sin) is applied to moving units' Y for liveliness.
 */
export class UnitRenderer {
  readonly group = new THREE.Group();

  private soldierMesh: THREE.InstancedMesh;
  private tankMesh: THREE.InstancedMesh;
  private capacityPerKind: number;
  private dummy = new THREE.Object3D();
  private selectionRing: THREE.LineSegments;
  private selectionRingTank: THREE.LineSegments;

  constructor(capacity = 256) {
    this.capacityPerKind = capacity;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

    const soldierGeo = buildSoldierGeometry();
    this.soldierMesh = new THREE.InstancedMesh(soldierGeo, mat, capacity);
    this.soldierMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.soldierMesh.count = 0;
    this.soldierMesh.frustumCulled = false;
    this.group.add(this.soldierMesh);

    const tankGeo = buildTunnelerGeometry();
    this.tankMesh = new THREE.InstancedMesh(tankGeo, mat, capacity);
    this.tankMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tankMesh.count = 0;
    this.tankMesh.frustumCulled = false;
    this.group.add(this.tankMesh);

    this.selectionRing = makeSelectionRing(0.6);
    this.selectionRingTank = makeSelectionRing(1.0);
    this.selectionRing.visible = false;
    this.selectionRingTank.visible = false;
    this.group.add(this.selectionRing);
    this.group.add(this.selectionRingTank);
  }

  update(units: UnitManager, timeSec: number): void {
    let ns = 0, nt = 0;
    let selected: Unit | null = null;

    for (const u of units.units) {
      const isMoving = u.path.length > 0;
      const bob = isMoving ? Math.sin(timeSec * (u.kind === 'soldier' ? 11.0 : 6.0) + u.id) * (u.kind === 'soldier' ? 0.04 : 0.02) : 0;
      this.dummy.position.set(u.x, u.y + bob, u.z);
      this.dummy.rotation.set(0, u.heading, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      if (u.kind === 'soldier') {
        if (ns < this.capacityPerKind) {
          this.soldierMesh.setMatrixAt(ns, this.dummy.matrix);
          ns++;
        }
      } else {
        if (nt < this.capacityPerKind) {
          this.tankMesh.setMatrixAt(nt, this.dummy.matrix);
          nt++;
        }
      }
      if (u.selected && !selected) selected = u;
    }

    this.soldierMesh.count = ns;
    this.tankMesh.count = nt;
    this.soldierMesh.instanceMatrix.needsUpdate = true;
    this.tankMesh.instanceMatrix.needsUpdate = true;

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

