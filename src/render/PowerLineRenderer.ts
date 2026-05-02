import * as THREE from 'three';
import type { Building } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';

/**
 * Draws glowing power lines from every live energy-source building (power
 * plants, isEnergySource=true) to the nearest live HQ. Each line runs from
 * the top-centre of the energy building to the top-centre of the HQ.
 */
export class PowerLineRenderer {
  readonly group = new THREE.Group();
  private readonly line: THREE.LineSegments;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly maxLines: number;

  constructor(maxLines = 64) {
    this.maxLines = maxLines;
    this.positions = new Float32Array(maxLines * 6); // 2 endpoints × xyz
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffdd44,
      opacity: 0.55,
      transparent: true,
    });
    this.line = new THREE.LineSegments(this.geometry, mat);
    this.line.frustumCulled = false;
    this.group.add(this.line);
  }

  update(buildings: readonly Building[]): void {
    const hqs = buildings.filter(b => b.spec.kind === 'hq' && !b.destroyed);
    let count = 0;

    for (const src of buildings) {
      if (!src.spec.isEnergySource || src.destroyed) continue;
      if (count >= this.maxLines) break;

      const sx = (src.ox + src.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const sz = (src.oz + src.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const sy = (src.floorY + src.spec.headroomVoxels + 2) * VOXEL_SIZE;

      let nearestHQ: Building | null = null;
      let nearestDist = Infinity;
      for (const hq of hqs) {
        const hx = (hq.ox + hq.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const hz = (hq.oz + hq.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const d = Math.hypot(sx - hx, sz - hz);
        if (d < nearestDist) { nearestDist = d; nearestHQ = hq; }
      }
      if (!nearestHQ) continue;

      const hx = (nearestHQ.ox + nearestHQ.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const hz = (nearestHQ.oz + nearestHQ.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const hy = (nearestHQ.floorY + nearestHQ.spec.headroomVoxels + 2) * VOXEL_SIZE;

      const base = count * 6;
      this.positions[base + 0] = sx;
      this.positions[base + 1] = sy;
      this.positions[base + 2] = sz;
      this.positions[base + 3] = hx;
      this.positions[base + 4] = hy;
      this.positions[base + 5] = hz;
      count++;
    }

    this.geometry.setDrawRange(0, count * 2);
    (this.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
  }
}
