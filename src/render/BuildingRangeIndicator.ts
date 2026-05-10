import * as THREE from 'three';
import { Building } from '../sim/Buildings';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';
import { WEAPONS } from '../sim/Weapons';

/**
 * Translucent green volumes drawn over the currently-selected armed building
 * to show its weapon's reach.
 *
 *   Regular turret / silo → upper hemisphere of radius `weapon.rangeMeters`,
 *                            centred on the muzzle.
 *   AA turret             → cone (apex at the muzzle, opens upward) plus an
 *                            upper hemisphere whose flat side meets the cone's
 *                            base. The cone visualises the ground-to-air
 *                            firing envelope; the hemisphere visualises the
 *                            remaining reach. Combined vertical extent of the
 *                            two volumes equals `weapon.rangeMeters`.
 *
 * Only one selected building is shown at a time; non-selected armed buildings
 * have their range hidden. The indicator is rendered with `depthWrite=false`
 * so the green tint blends over the world geometry behind it.
 */
const COLOR = 0x33ff66;
const OPACITY = 0.40;
const HQ_RING_COLOR = 0xff8833;
const HQ_RING_OPACITY = 0.50;

/** AA cone half-angle. 45° gives a square cone-base radius that matches its height. */
const AA_CONE_HALF_ANGLE = Math.PI / 4;

export class BuildingRangeIndicator {
  readonly group = new THREE.Group();

  private domeGeo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  private domeMat: THREE.MeshBasicMaterial;
  private dome: THREE.Mesh;

  private coneGeo = new THREE.ConeGeometry(1, 1, 32, 1, true);
  private coneMat: THREE.MeshBasicMaterial;
  private cone: THREE.Mesh;

  // Flat ground ring shown when an HQ is selected — indicates build range.
  private hqRingGeo: THREE.RingGeometry;
  private hqRingMat: THREE.MeshBasicMaterial;
  private hqRing: THREE.Mesh;

  constructor() {
    this.domeMat = new THREE.MeshBasicMaterial({
      color: COLOR, transparent: true, opacity: OPACITY,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.coneMat = new THREE.MeshBasicMaterial({
      color: COLOR, transparent: true, opacity: OPACITY,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.dome = new THREE.Mesh(this.domeGeo, this.domeMat);
    this.cone = new THREE.Mesh(this.coneGeo, this.coneMat);
    this.dome.renderOrder = 998;
    this.cone.renderOrder = 998;
    this.dome.visible = false;
    this.cone.visible = false;

    // HQ build-range ring: lies flat in the XZ plane, radius = 1 (scaled at render time).
    this.hqRingGeo = new THREE.RingGeometry(0.97, 1.0, 96);
    this.hqRingGeo.rotateX(-Math.PI / 2); // lay flat on XZ
    this.hqRingMat = new THREE.MeshBasicMaterial({
      color: HQ_RING_COLOR, transparent: true, opacity: HQ_RING_OPACITY,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.hqRing = new THREE.Mesh(this.hqRingGeo, this.hqRingMat);
    this.hqRing.renderOrder = 997;
    this.hqRing.visible = false;

    this.group.add(this.dome, this.cone, this.hqRing);
  }

  /**
   * Show the range volume for `b`. HQ buildings show a flat ground ring at
   * `buildRangeMeters`; weapon buildings show the dome/cone. Pass `null` to hide.
   */
  show(b: Building | null): void {
    this.hqRing.visible = false;

    if (!b) {
      this.dome.visible = false;
      this.cone.visible = false;
      return;
    }

    if (b.spec.kind === 'hq' && b.spec.buildRangeMeters) {
      const rangeTier = b.upgradeTracks?.range ?? 0;
      const range = b.spec.buildRangeMeters * (1 + rangeTier * 0.5);
      const cx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const groundY = (b.floorY + 1) * VOXEL_SIZE + 0.15;
      this.hqRing.position.set(cx, groundY, cz);
      this.hqRing.scale.set(range, range, range);
      this.hqRing.visible = true;
      this.dome.visible = false;
      this.cone.visible = false;
      return;
    }

    if (!b.spec.weapon) {
      this.dome.visible = false;
      this.cone.visible = false;
      return;
    }
    const w = WEAPONS[b.spec.weapon];
    const range = w.rangeMeters;
    const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const muzzleY = (b.floorY + 1) * VOXEL_SIZE + (b.spec.weaponMuzzleHeight ?? 1.0);

    if (b.spec.weapon === 'aa_turret') {
      // Split the total range in half: cone occupies the lower portion, the
      // dome sits on top of it. Cone height = base radius (45° half-angle),
      // both equal to range / 2 so the combined upward extent (cone height +
      // dome radius) equals `range`.
      const half = range * 0.5;
      const coneHeight = half;
      const coneBaseRadius = Math.tan(AA_CONE_HALF_ANGLE) * coneHeight;
      this.cone.position.set(cxw, muzzleY + coneHeight * 0.5, czw);
      this.cone.scale.set(coneBaseRadius, coneHeight, coneBaseRadius);
      this.cone.rotation.set(0, 0, 0);
      this.cone.visible = true;
      // Hemisphere sits with its flat side on the cone's base.
      this.dome.position.set(cxw, muzzleY + coneHeight, czw);
      this.dome.scale.set(half, half, half);
      this.dome.visible = true;
      return;
    }

    // Other turrets: upper hemisphere centred on the muzzle, radius = range.
    this.dome.position.set(cxw, muzzleY, czw);
    this.dome.scale.set(range, range, range);
    this.dome.visible = true;
    this.cone.visible = false;
  }
}
