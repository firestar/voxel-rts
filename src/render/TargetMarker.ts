import * as THREE from 'three';

/**
 * A small 3D marker for the proposed move target. While LMB is held the player can drag
 * the cursor up/down to push the target up or down in world Y; this widget renders a
 * vertical line from the surface hit point to that proposed Y, with a ring at each end.
 */
export class TargetMarker {
  readonly group = new THREE.Group();
  private surfaceRing: THREE.LineSegments;
  private targetRing: THREE.LineSegments;
  private spineGeo: THREE.BufferGeometry;
  private spinePositions = new Float32Array(2 * 3);
  private spine: THREE.Line;

  constructor() {
    this.surfaceRing = makeRing(0.6, 0xffe066);
    this.targetRing = makeRing(0.5, 0x77c2ff);
    this.spineGeo = new THREE.BufferGeometry();
    this.spineGeo.setAttribute('position', new THREE.BufferAttribute(this.spinePositions, 3));
    this.spineGeo.setDrawRange(0, 2);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true, opacity: 0.9 });
    this.spine = new THREE.Line(this.spineGeo, lineMat);
    this.spine.renderOrder = 999;
    this.group.add(this.surfaceRing);
    this.group.add(this.targetRing);
    this.group.add(this.spine);
    this.group.visible = false;
  }

  show(surface: THREE.Vector3, target: THREE.Vector3): void {
    this.group.visible = true;
    this.surfaceRing.position.copy(surface);
    this.targetRing.position.copy(target);
    this.spinePositions[0] = surface.x; this.spinePositions[1] = surface.y; this.spinePositions[2] = surface.z;
    this.spinePositions[3] = target.x;  this.spinePositions[4] = target.y;  this.spinePositions[5] = target.z;
    (this.spineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  hide(): void { this.group.visible = false; }
}

function makeRing(radius: number, color: number): THREE.LineSegments {
  const segs = 24;
  const positions: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const b = ((i + 1) / segs) * Math.PI * 2;
    positions.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    positions.push(Math.cos(b) * radius, 0, Math.sin(b) * radius);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
  const ring = new THREE.LineSegments(geo, mat);
  ring.renderOrder = 999;
  return ring;
}
