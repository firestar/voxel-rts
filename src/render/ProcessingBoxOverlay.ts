import * as THREE from 'three';
import { CHUNK, CHUNKS_X, CHUNKS_Z, VOXEL_SIZE } from '../voxel/types';

const CHUNK_M = CHUNK * VOXEL_SIZE; // 32 voxels × 0.125 m = 4.0 m

export interface ProcessBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** 0xRRGGBB wire colour. */
  color: number;
}

/**
 * Pools THREE.Box3Helper objects and shows them as pulsing wireframe outlines
 * over regions that are actively being processed (nav rebuild, chunk remesh).
 * Boxes are reused across frames; any pool slot past the active count is hidden.
 */
export class ProcessingBoxOverlay {
  readonly group = new THREE.Group();
  private readonly pool: THREE.Box3Helper[] = [];

  update(boxes: ProcessBox[], t: number): void {
    while (this.pool.length < boxes.length) {
      const h = new THREE.Box3Helper(new THREE.Box3(), 0xffffff);
      const mat = h.material as THREE.LineBasicMaterial;
      mat.transparent = true;
      mat.depthTest = false;
      h.renderOrder = 996;
      h.frustumCulled = false;
      this.pool.push(h);
      this.group.add(h);
    }
    const pulse = 0.3 + 0.7 * Math.abs(Math.sin(t * 3.5));
    for (let i = 0; i < this.pool.length; i++) {
      const h = this.pool[i]!;
      if (i < boxes.length) {
        const b = boxes[i]!;
        h.box.min.set(b.minX, b.minY, b.minZ);
        h.box.max.set(b.maxX, b.maxY, b.maxZ);
        const mat = h.material as THREE.LineBasicMaterial;
        mat.color.setHex(b.color);
        mat.opacity = pulse;
        h.visible = true;
      } else {
        h.visible = false;
      }
    }
  }

  /** Convert a packed chunkKey back into a world-space ProcessBox (cyan). */
  static chunkToBox(key: number): ProcessBox {
    const cx = key % CHUNKS_X;
    const tmp = (key / CHUNKS_X) | 0;
    const cz = tmp % CHUNKS_Z;
    const cy = (tmp / CHUNKS_Z) | 0;
    return {
      minX: cx * CHUNK_M, minY: cy * CHUNK_M, minZ: cz * CHUNK_M,
      maxX: (cx + 1) * CHUNK_M, maxY: (cy + 1) * CHUNK_M, maxZ: (cz + 1) * CHUNK_M,
      color: 0x00ccff,
    };
  }
}
