import * as THREE from 'three';
import { BuildingSpec } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS, NAV_CELL_METERS } from '../path/SurfaceNav';

/**
 * A wireframe + translucent box previewing a building footprint at the cursor.
 * Tinted green when valid, red when invalid.
 */
export class BuildingGhost {
  readonly group = new THREE.Group();
  private box: THREE.Mesh;
  private edges: THREE.LineSegments;
  private validMat: THREE.MeshBasicMaterial;
  private invalidMat: THREE.MeshBasicMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private spec: BuildingSpec | null = null;
  private currentValid = true;

  constructor() {
    this.validMat = new THREE.MeshBasicMaterial({ color: 0x33ff77, transparent: true, opacity: 0.25, depthWrite: false });
    this.invalidMat = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.25, depthWrite: false });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.box = new THREE.Mesh(geo, this.validMat);
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), this.edgeMat);
    this.group.add(this.box);
    this.group.add(this.edges);
    this.group.visible = false;
  }

  /** Reconfigure for a building spec (resizes the box). */
  setSpec(spec: BuildingSpec): void {
    if (this.spec === spec) return;
    this.spec = spec;
    const w = spec.cellsW * NAV_CELL_METERS;
    const d = spec.cellsD * NAV_CELL_METERS;
    const h = spec.headroomVoxels * VOXEL_SIZE;
    this.box.scale.set(w, h, d);
    this.edges.geometry.dispose();
    this.edges.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  }

  /** Place ghost at footprint origin (ox, oz) in nav cells with floor topY in voxels. */
  place(ox: number, oz: number, floorY: number, valid: boolean): void {
    if (!this.spec) return;
    this.group.visible = true;
    const w = this.spec.cellsW * NAV_CELL_METERS;
    const d = this.spec.cellsD * NAV_CELL_METERS;
    const h = this.spec.headroomVoxels * VOXEL_SIZE;
    const cx = (ox + this.spec.cellsW * 0.5) * NAV_CELL_METERS;
    const cz = (oz + this.spec.cellsD * 0.5) * NAV_CELL_METERS;
    const cy = (floorY + 1) * VOXEL_SIZE + h * 0.5;
    this.group.position.set(cx, cy, cz);
    void w; void d;
    if (valid !== this.currentValid) {
      this.currentValid = valid;
      this.box.material = valid ? this.validMat : this.invalidMat;
    }
  }

  hide(): void {
    this.group.visible = false;
  }
}
