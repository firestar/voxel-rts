import * as THREE from 'three';
import { VOXEL_SIZE, WORLD_X, WORLD_Y, WORLD_Z } from '../voxel/types';

// Tilted RTS orbit camera. Pans on WASD + edge scroll, yaws on RMB drag, zooms on wheel.
// Target is a point on the ground plane in world (meter) space; camera sits above-and-behind it.

export interface CameraInput {
  keys: Set<string>;
  mouseX: number; mouseY: number;     // pixel coords
  rmbDown: boolean;
  rmbDx: number; rmbDy: number;       // pixel delta this frame, only when rmbDown
  wheel: number;                       // accumulated this frame
  width: number; height: number;
}

export class RTSCamera {
  readonly cam: THREE.PerspectiveCamera;
  target = new THREE.Vector3(WORLD_X * VOXEL_SIZE * 0.5, 0, WORLD_Z * VOXEL_SIZE * 0.5);
  yaw = 0;          // radians, around Y
  pitch = -0.95;    // ~ -54° (look down)
  distance = 24;    // meters from target
  /** When set, overrides the fixed look-at height (the world is normally
   *  framed around a point ~18 m up). The cave follow-cam sets this to the
   *  tracked unit's Y so underground units stay centred in the frame instead
   *  of projecting far below the surface look-point. Null = default behaviour. */
  targetY: number | null = null;

  readonly minDist = 4;
  readonly maxDist = 60;
  readonly panSpeed = 18; // m/s at base zoom
  readonly edgeMargin = 8;

  constructor() {
    this.cam = new THREE.PerspectiveCamera(50, 1, 0.1, 800);
    this.update({ keys: new Set(), mouseX: -1, mouseY: -1, rmbDown: false, rmbDx: 0, rmbDy: 0, wheel: 0, width: 1, height: 1 }, 0);
  }

  resize(w: number, h: number): void {
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  update(input: CameraInput, dt: number): void {
    // Yaw via RMB drag.
    if (input.rmbDown) {
      this.yaw -= input.rmbDx * 0.0035;
    }
    // Zoom.
    if (input.wheel !== 0) {
      this.distance = Math.max(this.minDist, Math.min(this.maxDist, this.distance * (1 + input.wheel * 0.001)));
    }
    // Pan.
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const speed = this.panSpeed * (this.distance / 24);
    let mx = 0, mz = 0;
    if (input.keys.has('KeyW') || (input.mouseY >= 0 && input.mouseY < this.edgeMargin)) mz -= 1;
    if (input.keys.has('KeyS') || (input.mouseY > input.height - this.edgeMargin)) mz += 1;
    if (input.keys.has('KeyA') || (input.mouseX >= 0 && input.mouseX < this.edgeMargin)) mx -= 1;
    if (input.keys.has('KeyD') || (input.mouseX > input.width - this.edgeMargin)) mx += 1;
    if (mx !== 0 || mz !== 0) {
      const len = Math.hypot(mx, mz);
      mx /= len; mz /= len;
      // Rotate input by camera yaw so W is "forward" relative to camera.
      const wx = mx * cy + mz * sy;
      const wz = -mx * sy + mz * cy;
      this.target.x += wx * speed * dt;
      this.target.z += wz * speed * dt;
    }
    // Clamp target to world bounds.
    this.target.x = Math.max(0, Math.min(WORLD_X * VOXEL_SIZE, this.target.x));
    this.target.z = Math.max(0, Math.min(WORLD_Z * VOXEL_SIZE, this.target.z));

    // Position camera relative to target.
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    const offX = Math.sin(this.yaw) * cosP * this.distance;
    const offZ = Math.cos(this.yaw) * cosP * this.distance;
    const offY = -sinP * this.distance;
    // Aim at a point slightly above the world floor so the lookat tilts the world correctly.
    // A caller may override the look-at height (e.g. to follow an underground unit).
    const tgtY = this.targetY != null ? this.targetY : Math.min(WORLD_Y * VOXEL_SIZE * 0.4, 18);
    this.cam.position.set(this.target.x + offX, tgtY + offY, this.target.z + offZ);
    this.cam.lookAt(this.target.x, tgtY, this.target.z);
  }
}
