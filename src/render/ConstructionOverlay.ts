import * as THREE from 'three';
import { Building } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS, NAV_CELL_METERS } from '../path/SurfaceNav';

/**
 * Translucent "scaffolding" overlay rendered over any building whose
 * `upgradeState` is `pending` or `cancelled`. The box's height is scaled by
 * the upgrade progress so a fresh building shows just a base footprint and
 * a near-complete one rises to the building's full headroom — a quick
 * visual readout of how far an upgrade has gotten.
 *
 * Cheap: one mesh + one wireframe per pending building, allocated lazily and
 * disposed when the building either completes or is destroyed. Materials
 * are shared across instances so the scene-graph cost is just the
 * matrix-and-scale updates per frame.
 */
export class ConstructionOverlay {
  readonly group = new THREE.Group();
  private fillMat: THREE.MeshBasicMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  private edgeGeo = new THREE.EdgesGeometry(this.cubeGeo);
  private entries = new Map<number, { fill: THREE.Mesh; edges: THREE.LineSegments }>();

  constructor() {
    // The voxel structure now grows up phase-by-phase so the heavy fill
    // overlay would just hide what the player wants to see. We keep a
    // light translucent shell + bright wireframe marking the *target*
    // silhouette so the player can read "this footprint will be a
    // building" at a glance.
    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    });
    this.edgeMat = new THREE.LineBasicMaterial({
      color: 0xffcc66,
      transparent: true,
      opacity: 0.9,
    });
  }

  /**
   * Refresh the scaffold meshes from the live building list. Pending /
   * cancelled buildings get an entry; everything else (including newly-
   * completed buildings) has its entry removed.
   */
  update(buildings: ReadonlyArray<Building>): void {
    // 1.4 Hz sin oscillator — gentle pulse so the player can read the
    // overlay as "active build site" rather than a static decal.
    const t = performance.now() / 1000;
    const pulse = 0.85 + 0.15 * Math.sin(t * 2 * Math.PI * 1.4);
    this.fillMat.opacity = 0.06 * pulse;
    this.edgeMat.opacity = 0.6 + 0.3 * pulse;
    const seen = new Set<number>();
    for (const b of buildings) {
      if (b.destroyed) continue;
      if (b.upgradeState === 'enabled') continue;
      seen.add(b.id);
      let entry = this.entries.get(b.id);
      if (!entry) {
        const fill = new THREE.Mesh(this.cubeGeo, this.fillMat);
        const edges = new THREE.LineSegments(this.edgeGeo, this.edgeMat);
        this.group.add(fill);
        this.group.add(edges);
        entry = { fill, edges };
        this.entries.set(b.id, entry);
      }
      const w = b.spec.cellsW * NAV_CELL_METERS;
      const d = b.spec.cellsD * NAV_CELL_METERS;
      // Mark the building's full target volume — the voxel grow happens
      // inside the wireframe so the player has a reference for "this is
      // how big it will be when complete".
      const h = b.spec.headroomVoxels * VOXEL_SIZE;
      const cx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_METERS;
      const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_METERS;
      const baseY = (b.floorY + 1) * VOXEL_SIZE;
      entry.fill.scale.set(w, h, d);
      entry.fill.position.set(cx, baseY + h * 0.5, cz);
      entry.edges.scale.set(w, h, d);
      entry.edges.position.set(cx, baseY + h * 0.5, cz);
      // Cancelled upgrades read in muted red so the player can tell at a
      // glance which constructions have been aborted (and are waiting on a
      // recovery truck) versus actively progressing.
      const targetColor = b.upgradeState === 'cancelled' ? 0x884444 : 0xffaa33;
      const targetEdge  = b.upgradeState === 'cancelled' ? 0xcc8888 : 0xffcc66;
      (entry.fill.material as THREE.MeshBasicMaterial).color.setHex(targetColor);
      (entry.edges.material as THREE.LineBasicMaterial).color.setHex(targetEdge);
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.group.remove(entry.fill);
      this.group.remove(entry.edges);
      this.entries.delete(id);
    }
  }
}
