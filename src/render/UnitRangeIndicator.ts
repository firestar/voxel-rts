import * as THREE from 'three';
import { Unit } from '../sim/Units';
import { WEAPONS } from '../sim/Weapons';

/**
 * Translucent green hemisphere drawn over the currently-selected armed unit
 * to show its weapon's reach — same colour and opacity as the building range
 * indicator so a player flipping between selecting a building and a unit
 * reads the indicator the same way. Hidden when no armed unit is selected.
 */
const COLOR = 0x33ff66;
const OPACITY = 0.32;

export class UnitRangeIndicator {
  readonly group = new THREE.Group();
  private domeGeo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  private domeMat: THREE.MeshBasicMaterial;
  private dome: THREE.Mesh;

  constructor() {
    this.domeMat = new THREE.MeshBasicMaterial({
      color: COLOR, transparent: true, opacity: OPACITY,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.dome = new THREE.Mesh(this.domeGeo, this.domeMat);
    this.dome.renderOrder = 998;
    this.dome.visible = false;
    this.group.add(this.dome);
  }

  /** Show the dome on the first selected armed unit, hide otherwise. */
  show(units: readonly Unit[]): void {
    let target: Unit | null = null;
    for (const u of units) {
      if (!u.selected) continue;
      if (u.hp <= 0) continue;
      if (!u.weapon) continue;
      target = u;
      break;
    }
    if (!target) {
      this.dome.visible = false;
      return;
    }
    const w = WEAPONS[target.weapon!];
    this.dome.position.set(target.x, target.y, target.z);
    this.dome.scale.set(w.rangeMeters, w.rangeMeters, w.rangeMeters);
    this.dome.visible = true;
  }
}
