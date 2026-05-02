import * as THREE from 'three';
import { Building } from '../sim/Buildings';

const COLOR_AGGRESSIVE = 0xff4444;
const COLOR_DEFENSIVE  = 0x44aaff;
const SEGMENTS = 32;

function makeRingGeo(radius: number): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/**
 * Draws a ground ring at each producer building's rally point. Ring color
 * reflects stance: red = aggressive, blue = defensive.
 */
export class RallyMarkerRenderer {
  readonly group = new THREE.Group();
  private rings: THREE.Line[] = [];

  update(buildings: Building[]): void {
    const active = buildings.filter(b => !b.destroyed && b.rallyPoint !== null && b.spec.produces.length > 0);

    // Grow pool.
    while (this.rings.length < active.length) {
      const geo = makeRingGeo(1.0);
      const mat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 999;
      this.group.add(line);
      this.rings.push(line);
    }

    // Update visible rings.
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i]!;
      const b = active[i];
      if (!b) { ring.visible = false; continue; }
      ring.visible = true;
      const rp = b.rallyPoint!;
      ring.position.set(rp.x, rp.y + 0.05, rp.z);
      (ring.material as THREE.LineBasicMaterial).color.setHex(
        b.rallyStance === 'aggressive' ? COLOR_AGGRESSIVE : COLOR_DEFENSIVE,
      );
    }
  }
}
