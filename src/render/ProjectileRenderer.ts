import * as THREE from 'three';
import { Projectile, ProjectileManager, PROJECTILES } from '../sim/Projectiles';

/**
 * Single instanced cube mesh that shows every live projectile in the scene.
 *
 * Each projectile draws as a small box scaled to its caliber (`spec.sizeMeters`)
 * and tinted from `spec.color`. Cube orientation is locked to the projectile's
 * velocity vector so streaks of bullets look directional and rockets visibly
 * pitch as they arc.
 *
 * Modeled after `DebrisParticles` (instanced cubes with a per-instance color
 * attribute) — same pattern, simpler lifecycle (no internal pool — it just
 * mirrors the manager's live array).
 */
export class ProjectileRenderer {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private dummy = new THREE.Object3D();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();

  constructor(capacity = 1024) {
    this.capacity = capacity;
    // Unit cube; per-instance scale stretches it to projectile size.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3), 3,
    );
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
  }

  update(projectiles: ProjectileManager): void {
    const colAttr = this.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const colArr = colAttr.array as Float32Array;
    let n = 0;
    for (const p of projectiles.projectiles) {
      if (n >= this.capacity) break;
      const spec = PROJECTILES[p.kind];
      // Orient the cube so its long axis points along velocity. We use the
      // default forward (+Z) of the cube and rotate it to the velocity vector.
      const v = Math.hypot(p.vx, p.vy, p.vz);
      if (v > 1e-4) {
        this.tmpV.set(p.vx / v, p.vy / v, p.vz / v);
        this.tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.tmpV);
      } else {
        this.tmpQ.identity();
      }
      // Bullet streak: long along velocity, slim across. Rockets are chunkier.
      const long = spec.sizeMeters * (spec.family === 'bullet' ? 4.0 : 2.2);
      const wide = spec.sizeMeters;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.quaternion.copy(this.tmpQ);
      this.dummy.scale.set(wide, wide, long);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n, this.dummy.matrix);
      const r = ((spec.color >> 16) & 0xff) / 255;
      const g = ((spec.color >> 8) & 0xff) / 255;
      const b = (spec.color & 0xff) / 255;
      colArr[n * 3 + 0] = r;
      colArr[n * 3 + 1] = g;
      colArr[n * 3 + 2] = b;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}

// Reference type to keep TS happy when consumers import nothing else.
export type { Projectile };
