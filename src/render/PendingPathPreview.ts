import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/**
 * Blue dashed straight-line indicators for all in-flight path requests.
 * Each pending request draws a line from the unit's position at request time
 * to the requested goal. Lines disappear once the result arrives.
 *
 * Uses LineSegments2 + LineMaterial so linewidth is in screen-space pixels
 * and actually renders thick on all WebGL implementations (LineBasicMaterial
 * linewidth is silently ignored by WebGL).
 */
export class PendingPathPreview {
  readonly object: LineSegments2;
  private readonly geo: LineSegmentsGeometry;
  private readonly mat: LineMaterial;
  private readonly maxPaths: number;
  private positions: Float32Array;

  constructor(maxPaths = 64) {
    this.maxPaths = maxPaths;
    // LineSegmentsGeometry expects flat [x1,y1,z1, x2,y2,z2, ...] per segment.
    this.positions = new Float32Array(maxPaths * 6);
    this.geo = new LineSegmentsGeometry();
    this.mat = new LineMaterial({
      color: 0x4488ff,
      linewidth: 3,
      dashed: true,
      dashSize: 0.5,
      gapSize: 0.3,
      dashScale: 1,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });
    this.object = new LineSegments2(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 997;
    this.object.visible = false;
  }

  /** Call from the Game resize handler so pixel-space linewidth stays correct. */
  setResolution(w: number, h: number): void {
    this.mat.resolution.set(w, h);
  }

  update(paths: { start: { x: number; y: number; z: number }; goal: { x: number; y: number; z: number } }[]): void {
    const n = Math.min(paths.length, this.maxPaths);
    if (n === 0) {
      this.object.visible = false;
      return;
    }
    const lift = 0.22;
    for (let i = 0; i < n; i++) {
      const p = paths[i]!;
      const base = i * 6;
      this.positions[base + 0] = p.start.x;
      this.positions[base + 1] = p.start.y + lift;
      this.positions[base + 2] = p.start.z;
      this.positions[base + 3] = p.goal.x;
      this.positions[base + 4] = p.goal.y + lift;
      this.positions[base + 5] = p.goal.z;
    }
    this.geo.setPositions(this.positions.subarray(0, n * 6));
    // computeLineDistances drives the dashed pattern along each segment.
    this.object.computeLineDistances();
    this.object.visible = true;
  }
}
