import * as THREE from 'three';
import { VOXEL_SIZE } from '../voxel/types';
import { MATERIALS } from '../voxel/Materials';

/**
 * GPU-instanced cube debris pool.
 * Spawn N particles at an explosion site; they fly with gravity and despawn at end-of-life.
 *
 * Decorative only — particles never write back to the voxel world.
 */
export class DebrisParticles {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private head = 0;        // ring head
  private alive = 0;

  // Per-particle state in flat arrays.
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;     // remaining seconds; <= 0 means dead
  private maxLife: Float32Array;  // for fade
  private color: Float32Array;    // RGB triplet per particle

  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();

  constructor(capacity = 4096) {
    this.capacity = capacity;
    const geo = new THREE.BoxGeometry(VOXEL_SIZE * 0.5, VOXEL_SIZE * 0.5, VOXEL_SIZE * 0.5);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
  }

  /** Spawn `count` particles centered at (x,y,z) in meters, tinted by the given material. */
  spawnBurst(x: number, y: number, z: number, count: number, materialId: number): void {
    const mat = MATERIALS[materialId];
    if (!mat) return;
    const r = mat.r / 255, g = mat.g / 255, b = mat.b / 255;
    for (let i = 0; i < count; i++) {
      const slot = this.head;
      this.head = (this.head + 1) % this.capacity;
      // Hemispherical-ish initial velocity, biased upward.
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * 4;
      const horiz = Math.sqrt(1 - u * u);
      this.px[slot] = x + (Math.random() - 0.5) * 0.3;
      this.py[slot] = y + 0.05;
      this.pz[slot] = z + (Math.random() - 0.5) * 0.3;
      this.vx[slot] = horiz * Math.cos(t) * sp;
      this.vy[slot] = Math.abs(u) * sp + 1.5;
      this.vz[slot] = horiz * Math.sin(t) * sp;
      const life = 0.5 + Math.random() * 0.6;
      this.life[slot] = life;
      this.maxLife[slot] = life;
      this.color[slot * 3 + 0] = r;
      this.color[slot * 3 + 1] = g;
      this.color[slot * 3 + 2] = b;
      if (this.alive < this.capacity) this.alive++;
    }
  }

  /** Advance simulation and write instance matrices. */
  update(dt: number): void {
    const g = -9.8;
    const drag = Math.exp(-1.4 * dt); // simple exponential drag
    let visible = 0;
    const colAttr = this.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const colArr = colAttr.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) {
      const l = this.life[i]!;
      if (l <= 0) continue;
      const newL = l - dt;
      if (newL <= 0) {
        this.life[i] = 0;
        continue;
      }
      this.life[i] = newL;
      // Integrate.
      this.vy[i]! += g * dt;
      this.vx[i]! *= drag;
      this.vy[i]! *= drag;
      this.vz[i]! *= drag;
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;
      if (this.py[i]! < 0) { this.py[i] = 0; this.vy[i] = 0; }

      // Write instance.
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      const fade = newL / this.maxLife[i]!;
      const s = 0.6 + 0.4 * fade;
      this.dummy.scale.setScalar(s);
      this.dummy.rotation.set(this.px[i]! * 5, this.py[i]! * 5, this.pz[i]! * 5);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(visible, this.dummy.matrix);
      colArr[visible * 3 + 0] = this.color[i * 3 + 0]!;
      colArr[visible * 3 + 1] = this.color[i * 3 + 1]!;
      colArr[visible * 3 + 2] = this.color[i * 3 + 2]!;
      visible++;
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}
