import * as THREE from 'three';
import { WORLD_X, WORLD_Y, WORLD_Z, VOXEL_SIZE } from '../voxel/types';
import { AIR } from '../voxel/types';
import { MATERIALS } from '../voxel/Materials';
import { worldIndex } from '../voxel/VoxelWorld';
import type { Unit } from '../sim/Units';
import type { Building } from '../sim/Buildings';
import type { MetalCluster } from '../voxel/Metals';
import type { RTSCamera } from './Camera';

const SIZE = 192; // canvas pixels

// Pre-built colour table: map material ID → [r, g, b] with a slight height-
// brightening applied at sample time.
const MAT_R = new Uint8Array(256);
const MAT_G = new Uint8Array(256);
const MAT_B = new Uint8Array(256);
for (const m of MATERIALS) {
  MAT_R[m.id] = m.r;
  MAT_G[m.id] = m.g;
  MAT_B[m.id] = m.b;
}

export class MinimapRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  // Static terrain layer — rebuilt once after world generation.
  private readonly terrainData: ImageData;
  // Scratch buffer composited every frame.
  private readonly frameData: ImageData;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.canvas.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'left:12px',
      `width:${SIZE}px`,
      `height:${SIZE}px`,
      'border:2px solid rgba(255,255,255,0.25)',
      'border-radius:4px',
      'image-rendering:pixelated',
      'cursor:crosshair',
    ].join(';');
    this.ctx = this.canvas.getContext('2d')!;
    this.terrainData = this.ctx.createImageData(SIZE, SIZE);
    this.frameData   = this.ctx.createImageData(SIZE, SIZE);
  }

  /** Register a callback invoked when the player clicks the minimap. */
  onPan(cb: (worldX: number, worldZ: number) => void): void {
    const worldMetersX = WORLD_X * VOXEL_SIZE;
    const worldMetersZ = WORLD_Z * VOXEL_SIZE;
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const pz = e.clientY - rect.top;
      cb((px / rect.width) * worldMetersX, (pz / rect.height) * worldMetersZ);
    });
  }

  /**
   * Bake the terrain colour layer from the voxel array. Call once after world
   * generation. Samples one column every (WORLD_X / SIZE) voxels in X and Z,
   * finds the highest non-air voxel, applies height-based brightness shading.
   */
  buildTerrain(voxels: Uint8Array): void {
    const d = this.terrainData.data;
    const stepX = WORLD_X / SIZE;
    const stepZ = WORLD_Z / SIZE;

    for (let pz = 0; pz < SIZE; pz++) {
      for (let px = 0; px < SIZE; px++) {
        const wx = Math.floor(px * stepX);
        const wz = Math.floor(pz * stepZ);

        // Find the highest non-air voxel in this column.
        let surfY = -1;
        let mat = 0;
        for (let y = WORLD_Y - 1; y >= 0; y--) {
          const m = voxels[worldIndex(wx, y, wz)];
          if (m !== AIR) { surfY = y; mat = m; break; }
        }

        const i = (pz * SIZE + px) * 4;
        if (surfY < 0) {
          // Empty column (shouldn't happen on a generated map, but be safe).
          d[i] = 20; d[i+1] = 30; d[i+2] = 40; d[i+3] = 255;
        } else {
          // Height-based brightness: range roughly 80–192 (deep valley to hilltop).
          const bright = 0.65 + (surfY / WORLD_Y) * 0.5;
          d[i]   = Math.min(255, Math.round(MAT_R[mat]! * bright));
          d[i+1] = Math.min(255, Math.round(MAT_G[mat]! * bright));
          d[i+2] = Math.min(255, Math.round(MAT_B[mat]! * bright));
          d[i+3] = 255;
        }
      }
    }
  }

  /**
   * Draw one frame. Composites the static terrain layer with dynamic elements:
   * metal clusters, buildings, units, and the camera viewport rectangle.
   */
  update(
    units: readonly Unit[],
    buildings: readonly Building[],
    clusters: readonly MetalCluster[],
    camera: RTSCamera,
  ): void {
    // Copy terrain into frame buffer.
    this.frameData.data.set(this.terrainData.data);

    const d = this.frameData.data;
    const worldMetersX = WORLD_X * VOXEL_SIZE;
    const worldMetersZ = WORLD_Z * VOXEL_SIZE;

    const dot = (wx: number, wz: number, r: number, g: number, b: number, radius = 1): void => {
      const px = Math.floor((wx / worldMetersX) * SIZE);
      const pz = Math.floor((wz / worldMetersZ) * SIZE);
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dz * dz > radius * radius + 0.5) continue;
          const x = px + dx, z = pz + dz;
          if (x < 0 || x >= SIZE || z < 0 || z >= SIZE) continue;
          const i = (z * SIZE + x) * 4;
          d[i] = r; d[i+1] = g; d[i+2] = b; d[i+3] = 255;
        }
      }
    };

    // Metal clusters — gold dots.
    for (const c of clusters) {
      if (c.destroyed) continue;
      dot(c.worldX, c.worldZ, 220, 180, 40, 2);
    }

    // Buildings — teal squares (2×2 px minimum).
    for (const b of buildings) {
      if (b.destroyed) continue;
      const bx = (b.ox + b.spec.cellsW * 0.5) * 8 * VOXEL_SIZE;
      const bz = (b.oz + b.spec.cellsD * 0.5) * 8 * VOXEL_SIZE;
      dot(bx, bz, 60, 200, 200, 2);
    }

    // Units — green (player) or red (enemy).
    for (const u of units) {
      if (u.hp <= 0) continue;
      const [r, g, b] = u.team === 'player' ? [80, 230, 80] : [230, 60, 60];
      dot(u.x, u.z, r, g, b, 1);
    }

    this.ctx.putImageData(this.frameData, 0, 0);

    // Camera viewport rectangle — drawn via canvas 2D API on top of the pixels.
    this.drawViewport(camera, worldMetersX, worldMetersZ);
  }

  private drawViewport(camera: RTSCamera, worldW: number, worldD: number): void {
    // Project the four ground-plane corners of the camera frustum onto the
    // minimap. We cast rays from each screen corner to y=0.
    const cam = camera.cam;
    const corners: [number, number, number, number][] = [
      [-1, -1, 1, 1],
      [ 1, -1, -1, 1],
      [ 1,  1, -1, -1],
      [-1,  1,  1, -1],
    ];

    const pts: { x: number; z: number }[] = [];
    for (const [nx, nz] of corners) {
      const ndc = new THREE.Vector3(nx, nz, 0.5);
      ndc.unproject(cam);
      const dir = ndc.sub(cam.position).normalize();
      if (Math.abs(dir.y) < 1e-6) continue;
      const t = -cam.position.y / dir.y;
      if (t <= 0 || t > 2000) continue;
      const wx = cam.position.x + dir.x * t;
      const wz = cam.position.z + dir.z * t;
      pts.push({
        x: (wx / worldW) * SIZE,
        z: (wz / worldD) * SIZE,
      });
    }

    if (pts.length < 3) return;

    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(pts[0]!.x, pts[0]!.z);
    for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i]!.x, pts[i]!.z);
    this.ctx.closePath();
    this.ctx.stroke();
    this.ctx.restore();
  }
}
