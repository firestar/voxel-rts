import * as THREE from 'three';
import { Projectile, ProjectileManager, PROJECTILES } from '../sim/Projectiles';

/**
 * Instanced renderer for live projectiles. Two meshes — one for small bullets
 * (sphere) and one for the larger rockets (elongated capsule). We pick the
 * mesh per-projectile based on the spec's category.
 *
 * Each instance is colour-tinted from the projectile spec; rockets also align
 * their long axis to the velocity vector so they read as missiles in flight.
 * Bullets are point-like enough that a static sphere suffices.
 */
export class ProjectileRenderer {
  readonly group = new THREE.Group();

  private bulletMesh: THREE.InstancedMesh;
  private rocketMesh: THREE.InstancedMesh;
  private capacity: number;

  private dummy = new THREE.Object3D();
  private tmpMat = new THREE.Matrix4();
  private tmpQuat = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private upRef = new THREE.Vector3(0, 0, 1);

  constructor(capacity = 1024) {
    this.capacity = capacity;
    const bulletGeo = new THREE.SphereGeometry(1, 6, 6);
    const rocketGeo = new THREE.CylinderGeometry(0.4, 0.5, 2.4, 8);
    // Cylinder defaults to Y-aligned; pre-rotate so its long axis is along +Z so
    // we can lookAt(velocity) and have the body point forward.
    rocketGeo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });

    this.bulletMesh = new THREE.InstancedMesh(bulletGeo, mat, capacity);
    this.bulletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bulletMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    (this.bulletMesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.bulletMesh.frustumCulled = false;
    this.bulletMesh.count = 0;

    this.rocketMesh = new THREE.InstancedMesh(rocketGeo, mat, capacity);
    this.rocketMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocketMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    (this.rocketMesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.rocketMesh.frustumCulled = false;
    this.rocketMesh.count = 0;

    this.group.add(this.bulletMesh, this.rocketMesh);
  }

  update(projectiles: ProjectileManager): void {
    let nB = 0, nR = 0;
    const bulletCol = (this.bulletMesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    const rocketCol = (this.rocketMesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    for (const p of projectiles.projectiles) {
      const spec = PROJECTILES[p.kind];
      if (spec.category === 'bullet' || spec.kind === 'cluster_bomblet') {
        if (nB >= this.capacity) continue;
        // Bullets: small sphere, scaled to the spec's visual radius. Stretched
        // slightly along velocity so high-speed rounds read as a tracer streak.
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        const stretch = 1 + Math.min(2.0, speed / 250);
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.scale.set(spec.visualRadiusMeters, spec.visualRadiusMeters, spec.visualRadiusMeters * stretch);
        this.orientAlongVelocity(this.dummy, p);
        this.dummy.updateMatrix();
        this.bulletMesh.setMatrixAt(nB, this.dummy.matrix);
        bulletCol[nB * 3 + 0] = spec.color.r;
        bulletCol[nB * 3 + 1] = spec.color.g;
        bulletCol[nB * 3 + 2] = spec.color.b;
        nB++;
      } else {
        if (nR >= this.capacity) continue;
        const r = spec.visualRadiusMeters;
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.scale.set(r, r, r);
        this.orientAlongVelocity(this.dummy, p);
        this.dummy.updateMatrix();
        this.rocketMesh.setMatrixAt(nR, this.dummy.matrix);
        rocketCol[nR * 3 + 0] = spec.color.r;
        rocketCol[nR * 3 + 1] = spec.color.g;
        rocketCol[nR * 3 + 2] = spec.color.b;
        nR++;
      }
    }
    this.bulletMesh.count = nB;
    this.rocketMesh.count = nR;
    this.bulletMesh.instanceMatrix.needsUpdate = true;
    this.rocketMesh.instanceMatrix.needsUpdate = true;
    (this.bulletMesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.rocketMesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private orientAlongVelocity(obj: THREE.Object3D, p: Projectile): void {
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    if (speed < 1e-3) {
      obj.quaternion.identity();
      return;
    }
    this.tmpV.set(p.vx / speed, p.vy / speed, p.vz / speed);
    this.tmpQuat.setFromUnitVectors(this.upRef, this.tmpV);
    obj.quaternion.copy(this.tmpQuat);
  }
}
