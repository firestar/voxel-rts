import * as THREE from 'three';
import {
  CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, VOXEL_SIZE,
  chunkKey,
} from '../voxel/types';
import { VoxelWorld } from '../voxel/VoxelWorld';

import MesherWorker from '../workers/mesher.worker?worker';

/**
 * Owns Three.js Meshes per chunk; coordinates a worker pool that produces meshes from voxel data.
 *
 * Workers receive the shared voxel buffer (no copy under SharedArrayBuffer) and return positions/colors/indices.
 */
export class ChunkMeshRegistry {
  private meshes = new Map<number, THREE.Mesh>();
  private inflight = new Set<number>();
  private workers: Worker[] = [];
  private nextWorker = 0;
  private nextReqId = 1;

  // Per chunk: the mesh version we've most recently built (or are building).
  private builtVersion = new Int32Array(CHUNKS_X * CHUNKS_Y * CHUNKS_Z);

  // Shared per-chunk version buffer (mirror of world.buffers.version) — bumped when chunk is dirtied.
  private worldVersion: Int32Array;

  // Material reused across chunks.
  private material: THREE.Material;

  constructor(
    public readonly scene: THREE.Scene,
    public readonly world: VoxelWorld,
  ) {
    this.worldVersion = world.buffers.version;
    this.material = makeChunkMaterial();
    const cores = Math.max(2, Math.min((navigator.hardwareConcurrency ?? 4) - 1, 8));
    for (let i = 0; i < cores; i++) {
      const w = new MesherWorker();
      w.onmessage = this.onMesherMessage;
      this.workers.push(w);
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      this.scene.remove(m);
    }
    this.meshes.clear();
  }

  /** Walk the dirty bits and queue mesh jobs for any chunk that needs rebuilding. */
  pump(maxJobs = 8): number {
    const dirty = this.world.buffers.dirty;
    let queued = 0;
    for (let cy = 0; cy < CHUNKS_Y && queued < maxJobs; cy++) {
      for (let cz = 0; cz < CHUNKS_Z && queued < maxJobs; cz++) {
        for (let cx = 0; cx < CHUNKS_X && queued < maxJobs; cx++) {
          const k = chunkKey(cx, cy, cz);
          if (!dirty[k]) continue;
          if (this.inflight.has(k)) continue;
          // Bump version so on completion we know if it's stale.
          const v = (this.worldVersion[k]! + 1) | 0;
          this.worldVersion[k] = v;
          dirty[k] = 0;
          this.inflight.add(k);
          this.builtVersion[k] = v;
          const w = this.workers[this.nextWorker]!;
          this.nextWorker = (this.nextWorker + 1) % this.workers.length;
          w.postMessage({
            voxels: this.world.buffers.voxels,
            version: this.worldVersion,
            cx, cy, cz,
            reqId: this.nextReqId++,
          });
          queued++;
        }
      }
    }
    return queued;
  }

  private onMesherMessage = (ev: MessageEvent): void => {
    const msg = ev.data as {
      reqId: number; cx: number; cy: number; cz: number;
      positions: Float32Array; colors: Uint8Array; indices: Uint32Array; version: number;
    };
    const k = chunkKey(msg.cx, msg.cy, msg.cz);
    this.inflight.delete(k);

    // If chunk got dirtied again while we were meshing, schedule another build immediately.
    if (this.world.buffers.dirty[k]) {
      // re-mesh on next pump
    }

    if (msg.indices.length === 0) {
      // Empty chunk — drop any existing mesh.
      const existing = this.meshes.get(k);
      if (existing) {
        existing.geometry.dispose();
        this.scene.remove(existing);
        this.meshes.delete(k);
      }
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(msg.colors, 4, true));
    geo.setIndex(new THREE.BufferAttribute(msg.indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    let mesh = this.meshes.get(k);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, this.material);
      mesh.frustumCulled = true;
      // Scale voxel-space (1 unit per voxel) into meters.
      mesh.scale.setScalar(VOXEL_SIZE);
      mesh.position.set(0, 0, 0);
      this.scene.add(mesh);
      this.meshes.set(k, mesh);
    }
  };

  getMeshCount(): number { return this.meshes.size; }
  getInflight(): number { return this.inflight.size; }
}

function makeChunkMaterial(): THREE.Material {
  // Per-vertex color carries (r,g,b, ao). We pipe AO through a tiny onBeforeCompile patch
  // so it multiplies the diffuse term, giving cheap baked AO without a custom ShaderMaterial.
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>
      diffuseColor.rgb *= vColor.a;
      `,
    );
  };
  return m;
}
