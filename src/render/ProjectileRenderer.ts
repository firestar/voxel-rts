import * as THREE from 'three';
import { Projectile } from '../sim/Projectiles';

/**
 * Renders every live projectile as a streak: a thin world-aligned billboarded
 * line whose colour and length come from the projectile's spec, oriented along
 * the projectile's velocity vector. Bullets get a short bright streak; rockets
 * get a longer, warmer trail. Cluster bomblets reuse the rocket geometry at
 * their child spec's tint.
 *
 * Cheap because there are at most a few hundred live projectiles even during a
 * sustained MG burst, so we just rebuild the line geometry every frame.
 */
export class ProjectileRenderer {
  readonly object: THREE.LineSegments;
  private positions: Float32Array;
  private colors: Float32Array;
  private capacity: number;
  private geo: THREE.BufferGeometry;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 2 * 3);
    this.colors = new Float32Array(capacity * 2 * 3);
    this.geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.positions, 3);
    const colAttr = new THREE.BufferAttribute(this.colors, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', posAttr);
    this.geo.setAttribute('color', colAttr);
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,
    });
    this.object = new THREE.LineSegments(this.geo, mat);
    this.object.frustumCulled = false;
  }

  update(projectiles: Projectile[]): void {
    const max = Math.min(projectiles.length, this.capacity);
    for (let i = 0; i < max; i++) {
      const p = projectiles[i]!;
      const speed = Math.hypot(p.vx, p.vy, p.vz) || 1;
      const inv = 1 / speed;
      const dx = p.vx * inv, dy = p.vy * inv, dz = p.vz * inv;
      const len = p.spec.trailLengthM;
      const off = i * 6;
      // Trail extends backward from the projectile head along the reverse of velocity.
      this.positions[off + 0] = p.x;
      this.positions[off + 1] = p.y;
      this.positions[off + 2] = p.z;
      this.positions[off + 3] = p.x - dx * len;
      this.positions[off + 4] = p.y - dy * len;
      this.positions[off + 5] = p.z - dz * len;
      const r = p.spec.trailR, g = p.spec.trailG, b = p.spec.trailB;
      this.colors[off + 0] = r; this.colors[off + 1] = g; this.colors[off + 2] = b;
      this.colors[off + 3] = r * 0.4; this.colors[off + 4] = g * 0.4; this.colors[off + 5] = b * 0.4;
    }
    this.geo.setDrawRange(0, max * 2);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
