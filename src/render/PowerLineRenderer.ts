import * as THREE from 'three';

/**
 * Draws ground-hugging power lines from energy buildings to the HQ. The routes
 * are computed by A* in Game.ts (so lines follow the terrain and avoid walls)
 * and passed in as waypoint arrays via `setRoutes`. Each route becomes a polyline
 * drawn as LINE_SEGMENTS pairs slightly above the surface.
 */
export class PowerLineRenderer {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly MAX_SEGMENTS = 2048;

  constructor() {
    this.positions = new Float32Array(this.MAX_SEGMENTS * 6);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffdd44,
      opacity: 0.60,
      transparent: true,
    });
    const line = new THREE.LineSegments(this.geometry, mat);
    line.frustumCulled = false;
    this.group.add(line);
  }

  /**
   * Replace the rendered routes with a new set of waypoint paths.
   * Each route is an ordered array of world-space points; adjacent pairs
   * become individual line segments. Y is taken from the waypoints (A* surface
   * path) plus a small above-ground offset so the lines are visible.
   */
  setRoutes(routes: { waypoints: { x: number; y: number; z: number }[] }[]): void {
    let seg = 0;
    const Y_LIFT = 0.18; // meters above the surface path waypoints

    for (const route of routes) {
      const pts = route.waypoints;
      for (let i = 0; i + 1 < pts.length; i++) {
        if (seg >= this.MAX_SEGMENTS) break;
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const base = seg * 6;
        this.positions[base + 0] = a.x;
        this.positions[base + 1] = a.y + Y_LIFT;
        this.positions[base + 2] = a.z;
        this.positions[base + 3] = b.x;
        this.positions[base + 4] = b.y + Y_LIFT;
        this.positions[base + 5] = b.z;
        seg++;
      }
    }

    this.geometry.setDrawRange(0, seg * 2);
    (this.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
  }
}
