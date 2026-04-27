import * as THREE from 'three';
import { ProjectileManager, PROJECTILES } from '../sim/Projectiles';

/**
 * GPU-instanced renderer for in-flight projectiles. Each live projectile is
 * drawn as a single coloured cylinder oriented along its velocity vector. The
 * length and radius come from the projectile catalog, so a 0.18-m long 9 mm
 * round and a 1.4-m heavy rocket coexist in the same instanced mesh with
 * different per-instance scales.
 *
 * Implementation note: a unit-length cylinder along Z is built once as the
 * base geometry; each frame we compose translation · quat · scale per
 * projectile so the world transform stretches the cylinder to its full length
 * AND rotates it from +Z to align with the projectile's velocity vector.
 */
export class ProjectileRenderer {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private dummy = new THREE.Object3D();
  private quat = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 0, 1);
  private dir = new THREE.Vector3();

  constructor(capacity = 1024) {
    this.capacity = capacity;
    // Unit cylinder along +Z so per-instance Z-scale stretches it to its real
    // length. CylinderGeometry's default axis is +Y, so we rotate it into +Z
    // once at construction.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
    geo.rotateX(Math.PI * 0.5);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  update(pm: ProjectileManager): void {
    const colAttr = this.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const colArr = colAttr.array as Float32Array;
    let i = 0;
    for (const p of pm.projectiles) {
      if (i >= this.capacity) break;
      const cfg = PROJECTILES[p.kind];
      // Orient cylinder along velocity vector — clamp tiny speeds to a default
      // axis so a stalled projectile (e.g. crested rocket) still renders.
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      if (sp > 1e-4) {
        this.dir.set(p.vx / sp, p.vy / sp, p.vz / sp);
      } else {
        this.dir.set(0, 0, -1);
      }
      this.quat.setFromUnitVectors(this.up, this.dir);
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.quaternion.copy(this.quat);
      this.dummy.scale.set(
        cfg.visualRadiusMeters,
        cfg.visualRadiusMeters,
        cfg.visualLengthMeters,
      );
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      colArr[i * 3 + 0] = cfg.colorR;
      colArr[i * 3 + 1] = cfg.colorG;
      colArr[i * 3 + 2] = cfg.colorB;
      i++;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}

/**
 * Pool of short-lived expanding spheres used as muzzle flashes and as the
 * fire-burst at impact. Each entry has a fixed life; the visual scales from
 * 0 → radius and the alpha fades from 1 → 0 across that life. We use a single
 * InstancedMesh with vertex colors and per-instance scale; opacity is faked
 * by darkening the color toward black as the flash fades, since transparency
 * on InstancedMesh in Three.js is fiddly to get right with depth sorting and
 * we don't want partial-z artefacts on top of the world.
 */
export class FlashPool {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private radius: Float32Array;
  private life: Float32Array; private maxLife: Float32Array;
  private color: Float32Array;
  private active = 0;
  private dummy = new THREE.Object3D();

  constructor(capacity = 256) {
    this.capacity = capacity;
    const geo = new THREE.SphereGeometry(1, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: false, transparent: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
  }

  /**
   * Spawn one flash centred at (x,y,z) that grows to `radius` meters across
   * `lifeSeconds`, tinted by the supplied color. Used by both muzzle blasts
   * (small, white-hot orange) and impact fireballs (larger, scaled to the
   * explosion radius).
   */
  spawn(x: number, y: number, z: number, radius: number, lifeSeconds: number, r: number, g: number, b: number): void {
    let slot = -1;
    // Find a dead slot; ring-buffer overwrite if all are alive.
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) { slot = i; break; }
    }
    if (slot < 0) slot = this.active % this.capacity;
    this.px[slot] = x; this.py[slot] = y; this.pz[slot] = z;
    this.radius[slot] = radius;
    this.life[slot] = lifeSeconds;
    this.maxLife[slot] = lifeSeconds;
    this.color[slot * 3 + 0] = r;
    this.color[slot * 3 + 1] = g;
    this.color[slot * 3 + 2] = b;
    this.active++;
  }

  update(dt: number): void {
    const colAttr = this.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const colArr = colAttr.array as Float32Array;
    let visible = 0;
    for (let i = 0; i < this.capacity; i++) {
      const l = this.life[i]!;
      if (l <= 0) continue;
      const newL = l - dt;
      if (newL <= 0) { this.life[i] = 0; continue; }
      this.life[i] = newL;
      const t = 1 - newL / this.maxLife[i]!;
      // Grow fast at the start, hold near peak, then fade. A simple ease-out
      // pulse keeps the flash readable on screen.
      const pulse = Math.min(1, t * 4) * (1 - t * 0.4);
      const scale = this.radius[i]! * pulse;
      const fade = 1 - t;
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.dummy.scale.setScalar(Math.max(0.01, scale));
      this.dummy.quaternion.set(0, 0, 0, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(visible, this.dummy.matrix);
      colArr[visible * 3 + 0] = this.color[i * 3 + 0]! * fade;
      colArr[visible * 3 + 1] = this.color[i * 3 + 1]! * fade;
      colArr[visible * 3 + 2] = this.color[i * 3 + 2]! * fade;
      visible++;
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}

/**
 * Pool of expanding flat rings drawn just above the ground at impact sites.
 * Each ring expands from r=0 outward to its target radius (matching the
 * projectile's explosion radius), then fades. The pool keeps a single
 * line-segment ring geometry of unit radius and re-scales it per instance —
 * but because Three.js doesn't instance lines well, we use one Object3D per
 * pool slot and toggle visibility. With a small pool (32) this is cheap.
 */
export class ImpactRingPool {
  readonly group = new THREE.Group();
  private rings: THREE.LineLoop[] = [];
  private capacity: number;
  private radius: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private color: Float32Array;

  constructor(capacity = 64) {
    this.capacity = capacity;
    this.radius = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    const segs = 48;
    const positions: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      positions.push(Math.cos(a), 0, Math.sin(a));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthTest: false });
      const ring = new THREE.LineLoop(geo, mat);
      ring.visible = false;
      ring.renderOrder = 1000;
      this.rings.push(ring);
      this.group.add(ring);
    }
  }

  /**
   * Spawn one ring at (x,y,z) that expands to `targetRadius` over `lifeSeconds`.
   * `r,g,b` are 0..1 components — typically tuned to match the projectile that
   * caused the impact so a tank shell flashes a different colour from a bullet pit.
   */
  spawn(x: number, y: number, z: number, targetRadius: number, lifeSeconds: number, r: number, g: number, b: number): void {
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) { slot = i; break; }
    }
    if (slot < 0) {
      // All slots occupied — overwrite the oldest (smallest remaining life).
      let bestL = Infinity;
      for (let i = 0; i < this.capacity; i++) {
        if (this.life[i]! < bestL) { bestL = this.life[i]!; slot = i; }
      }
      if (slot < 0) slot = 0;
    }
    this.px[slot] = x; this.py[slot] = y + 0.05; this.pz[slot] = z;
    this.radius[slot] = targetRadius;
    this.life[slot] = lifeSeconds;
    this.maxLife[slot] = lifeSeconds;
    this.color[slot * 3 + 0] = r;
    this.color[slot * 3 + 1] = g;
    this.color[slot * 3 + 2] = b;
    const ring = this.rings[slot]!;
    (ring.material as THREE.LineBasicMaterial).color.setRGB(r, g, b);
    ring.position.set(x, y + 0.05, z);
    ring.scale.setScalar(0.001);
    ring.visible = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      const l = this.life[i]!;
      if (l <= 0) {
        this.rings[i]!.visible = false;
        continue;
      }
      const newL = l - dt;
      if (newL <= 0) {
        this.life[i] = 0;
        this.rings[i]!.visible = false;
        continue;
      }
      this.life[i] = newL;
      const t = 1 - newL / this.maxLife[i]!;
      // Expand fast then taper. Opacity follows the inverse so the ring
      // sweeps outward and fades cleanly.
      const r = this.radius[i]! * (1 - Math.pow(1 - t, 2));
      const ring = this.rings[i]!;
      ring.scale.setScalar(Math.max(0.01, r));
      const mat = ring.material as THREE.LineBasicMaterial;
      mat.opacity = Math.max(0, 1 - t);
      mat.transparent = true;
    }
  }
}

/**
 * Dashed line preview that traces the predicted trajectory of the next shot.
 * Game pushes a polyline of world-space points into `update`; the line auto-
 * resizes its buffer when the array grows beyond the current capacity.
 *
 * Hidden by default — call `update` with an empty array to hide.
 */
export class TrajectoryPreview {
  readonly object: THREE.Line;
  private positions: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor(initialCapacity = 256) {
    this.positions = new Float32Array(initialCapacity * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.LineDashedMaterial({
      color: 0xffd44d,
      dashSize: 0.4,
      gapSize: 0.3,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    this.object = new THREE.Line(this.geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 1100;
    this.object.visible = false;
  }

  update(points: { x: number; y: number; z: number }[]): void {
    if (points.length < 2) {
      this.object.visible = false;
      this.geo.setDrawRange(0, 0);
      return;
    }
    if (points.length * 3 > this.positions.length) {
      this.positions = new Float32Array(points.length * 3 * 2);
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      this.positions[i * 3 + 0] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
    }
    const attr = this.geo.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.geo.setDrawRange(0, points.length);
    this.object.computeLineDistances();
    this.object.visible = true;
  }
}

/**
 * Pool of dashed arcs that follow live projectiles in flight. The Game
 * predicts each projectile's remaining trajectory once per frame and pushes
 * them in here; the pool reuses up to `capacity` Line objects, hiding any
 * trailing slot when the projectile count drops. Each line shares the same
 * `LineDashedMaterial` instance — three.js renders them as dashed strokes
 * regardless of the number of segments.
 */
export class ProjectileArcPool {
  readonly group = new THREE.Group();
  private lines: THREE.Line[] = [];
  private buffers: Float32Array[] = [];
  private capacity: number;
  private maxSamples: number;

  constructor(capacity = 64, maxSamples = 96) {
    this.capacity = capacity;
    this.maxSamples = maxSamples;
    const mat = new THREE.LineDashedMaterial({
      color: 0xffaa55,
      dashSize: 0.5,
      gapSize: 0.35,
      depthTest: false,
      transparent: true,
      opacity: 0.55,
    });
    for (let i = 0; i < capacity; i++) {
      const buf = new Float32Array(maxSamples * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(buf, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 1090;
      line.visible = false;
      this.lines.push(line);
      this.buffers.push(buf);
      this.group.add(line);
    }
  }

  /**
   * Push the trajectories. Each entry is a sampled list of points; lines
   * past the supplied list are hidden, lines past `capacity` are dropped.
   */
  update(arcs: { points: { x: number; y: number; z: number }[] }[]): void {
    const n = Math.min(arcs.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const pts = arcs[i]!.points;
      const line = this.lines[i]!;
      const buf = this.buffers[i]!;
      if (pts.length < 2) {
        line.visible = false;
        continue;
      }
      const count = Math.min(pts.length, this.maxSamples);
      for (let j = 0; j < count; j++) {
        const p = pts[j]!;
        buf[j * 3 + 0] = p.x;
        buf[j * 3 + 1] = p.y;
        buf[j * 3 + 2] = p.z;
      }
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
      line.geometry.setDrawRange(0, count);
      line.computeLineDistances();
      line.visible = true;
    }
    for (let i = n; i < this.capacity; i++) {
      this.lines[i]!.visible = false;
    }
  }
}

/**
 * Tiny marker placed at the predicted impact point of the trajectory preview
 * arc. A flat disc on the ground so the player can see exactly where the
 * round will land if they release RMB now.
 */
export class ImpactMarker {
  readonly object: THREE.Mesh;
  constructor() {
    const geo = new THREE.RingGeometry(0.4, 0.6, 24);
    geo.rotateX(-Math.PI * 0.5);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
    this.object = new THREE.Mesh(geo, mat);
    this.object.renderOrder = 1100;
    this.object.visible = false;
  }
  show(x: number, y: number, z: number, radiusMeters: number): void {
    this.object.position.set(x, y + 0.05, z);
    this.object.scale.setScalar(Math.max(0.4, radiusMeters));
    this.object.visible = true;
  }
  hide(): void {
    this.object.visible = false;
  }
}
