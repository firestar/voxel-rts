import * as THREE from 'three';

/**
 * Dashed line strip showing the selected unit's remaining path.
 * Updated each frame from the unit's current position + waypoints; hovers slightly
 * above the path so it doesn't z-fight with the ground.
 */
export class PathPreview {
  readonly object: THREE.Line;
  private positions: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private maxPoints: number;

  constructor(maxPoints = 1024) {
    this.maxPoints = maxPoints;
    this.positions = new Float32Array(maxPoints * 3);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineDashedMaterial({
      color: 0x66ffaa,
      dashSize: 0.4,
      gapSize: 0.25,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.object = new THREE.Line(geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 998;
    this.object.visible = false;
  }

  /**
   * `start` is where the line begins (typically the unit's current position).
   * `waypoints` is the ordered list of remaining targets in world meters.
   */
  update(
    start: { x: number; y: number; z: number } | null,
    waypoints: { x: number; y: number; z: number }[],
  ): void {
    if (!start || waypoints.length === 0) {
      this.object.visible = false;
      this.object.geometry.setDrawRange(0, 0);
      return;
    }
    const lift = 0.18; // hover above ground
    let n = 0;
    const writePoint = (x: number, y: number, z: number): void => {
      if (n >= this.maxPoints) return;
      const i = n * 3;
      this.positions[i] = x;
      this.positions[i + 1] = y + lift;
      this.positions[i + 2] = z;
      n++;
    };
    writePoint(start.x, start.y, start.z);
    for (const w of waypoints) writePoint(w.x, w.y, w.z);

    this.posAttr.needsUpdate = true;
    this.object.geometry.setDrawRange(0, n);
    // computeLineDistances feeds the dashed material's uvs.
    this.object.computeLineDistances();
    this.object.visible = true;
  }
}
