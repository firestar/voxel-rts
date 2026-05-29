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
  /**
   * Shared with the chunk material's onBeforeCompile shader so the underground
   * overlay (`Game.hideAboveY`) can render any fragment whose world-space Y is
   * at or above this value at 5% opacity. A very large default (~1e9) keeps
   * the cutoff disabled until the player toggles it on.
   */
  readonly hideAboveYUniform = { value: 1e9 };

  /** Maximum number of vision sources (units + buildings) packed
   *  into the FoW uniform per frame. Sized to fit comfortably
   *  inside the WebGL minimum guaranteed vec4 uniform budget for
   *  fragment shaders (224 fragment-uniform vectors on the floor)
   *  while leaving headroom for Three.js's own MeshLambert
   *  uniforms. The fragment shader loop is bounded at compile
   *  time at this value with a runtime `break` once the active
   *  count is reached. */
  static readonly MAX_FOW_SOURCES = 64;

  /**
   * Fog-of-war uniforms shared with the chunk material's
   * onBeforeCompile patch. Game updates them every render frame with
   * the player's live vision-source positions; fragments outside
   * every sphere are discarded so terrain only shows where the
   * player has eyes. Each source is a vec4 with .xyz = world-metre
   * position and .w = radius² (so the fragment shader avoids a
   * per-pixel sqrt). Buildings get a wider radius than units.
   */
  readonly fowUniforms = {
    uFowEnabled: { value: 0 },
    uFowSourceCountM: { value: 0 },
    uFowSourcesM: {
      value: Array.from(
        { length: ChunkMeshRegistry.MAX_FOW_SOURCES },
        () => new THREE.Vector4(),
      ) as THREE.Vector4[],
    },
    // Tri-state FoW: an XZ bitmap of explored cells (sticky once
    // visited). Inside a current vision sphere → full colour;
    // explored-but-out-of-current-vision → desaturated grey;
    // unexplored → discarded. The texture is single-channel R8 of
    // size NAV_W × NAV_H; sampling uses world XZ / world-extent.
    uExploredMap: { value: null as THREE.Texture | null },
    uExploredEnabled: { value: 0 },
    uWorldExtentXZ: { value: new THREE.Vector2(1, 1) },
  };

  constructor(
    public readonly scene: THREE.Scene,
    public readonly world: VoxelWorld,
    opts: { debugMaterial?: THREE.Material } = {},
  ) {
    this.worldVersion = world.buffers.version;
    // When a debug override is provided we skip the onBeforeCompile
    // patch entirely — the FoW + Y-cutoff + AO shader work is dead
    // weight in wireframe mode. setHideAboveY / setFow / setExplored
    // remain callable (they just twiddle uniforms nothing reads).
    this.material = opts.debugMaterial
      ?? makeChunkMaterial(this.hideAboveYUniform, this.fowUniforms);
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
  getInflightChunks(): ReadonlySet<number> { return this.inflight; }

  /**
   * Set the Y cutoff (in meters). Anything above this Y is rendered at 5%
   * opacity by the chunk material's shader patch. Pass a very large value
   * (or `Infinity`) to disable the cutoff and restore solid terrain. The
   * material's `transparent` flag is toggled with the cutoff so the engine
   * isn't paying for alpha sorting when the cutoff is off.
   */
  setHideAboveY(meters: number): void {
    const enabled = isFinite(meters) && meters < 1e8;
    this.hideAboveYUniform.value = enabled ? meters : 1e9;
    const m = this.material as THREE.MeshLambertMaterial;
    if (m.transparent !== enabled) {
      m.transparent = enabled;
      m.depthWrite = !enabled;
      m.needsUpdate = true;
    }
  }

  /**
   * Configure the chunk-FoW shader. `flatXyzR` is a Float32Array of
   * length ≥ 4*count packed as (x, y, z, radius) per source — both
   * units and buildings. Each source's radius is independent, so a
   * 22 m HQ vision disc and a 6 m soldier disc share the same
   * uniform. Anything outside every sphere is discarded by the
   * fragment shader. Pass `enabled=false` to restore full terrain.
   */
  setFow(
    enabled: boolean,
    flatXyzR: Float32Array,
    count: number,
  ): void {
    const max = ChunkMeshRegistry.MAX_FOW_SOURCES;
    const n = Math.min(count | 0, max);
    this.fowUniforms.uFowEnabled.value = enabled ? 1 : 0;
    this.fowUniforms.uFowSourceCountM.value = n;
    const arr = this.fowUniforms.uFowSourcesM.value;
    for (let i = 0; i < n; i++) {
      const r = flatXyzR[i * 4 + 3]!;
      arr[i]!.set(
        flatXyzR[i * 4]!,
        flatXyzR[i * 4 + 1]!,
        flatXyzR[i * 4 + 2]!,
        r * r,
      );
    }
  }

  /**
   * Wire an explored-cells texture into the chunk material. The
   * texture is single-channel R8 of size NAV_W × NAV_H; the shader
   * samples it by (worldX, worldZ) / worldExtent to decide whether a
   * fragment outside the live FoW spheres should render as
   * desaturated grey (was-seen) or be discarded (never-seen).
   */
  setExplored(
    enabled: boolean,
    tex: THREE.Texture,
    worldExtentX: number,
    worldExtentZ: number,
  ): void {
    this.fowUniforms.uExploredEnabled.value = enabled ? 1 : 0;
    this.fowUniforms.uExploredMap.value = tex;
    this.fowUniforms.uWorldExtentXZ.value.set(worldExtentX, worldExtentZ);
  }
}

function makeChunkMaterial(
  hideUniform: { value: number },
  fowUniforms: {
    uFowEnabled: { value: number };
    uFowSourceCountM: { value: number };
    uFowSourcesM: { value: THREE.Vector4[] };
    uExploredMap: { value: THREE.Texture | null };
    uExploredEnabled: { value: number };
    uWorldExtentXZ: { value: THREE.Vector2 };
  },
): THREE.Material {
  // Per-vertex color carries (r,g,b, ao). We pipe AO through a tiny onBeforeCompile patch
  // so it multiplies the diffuse term, giving cheap baked AO without a custom ShaderMaterial.
  // The same patch wires `uHideAboveY` (Y-axis cutoff at 5% opacity for underground viewing)
  // and a fog-of-war discard around the player's units, so terrain only renders where the
  // player has eyes on the ground.
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHideAboveY = hideUniform;
    shader.uniforms.uFowEnabled = fowUniforms.uFowEnabled;
    shader.uniforms.uFowSourceCountM = fowUniforms.uFowSourceCountM;
    shader.uniforms.uFowSourcesM = fowUniforms.uFowSourcesM;
    shader.uniforms.uExploredMap = fowUniforms.uExploredMap;
    shader.uniforms.uExploredEnabled = fowUniforms.uExploredEnabled;
    shader.uniforms.uWorldExtentXZ = fowUniforms.uWorldExtentXZ;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `
        #include <common>
        varying vec3 vWorldPosForCutoff;
        `,
      )
      .replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        vWorldPosForCutoff = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `
        #include <common>
        uniform float uHideAboveY;
        uniform int uFowEnabled;
        uniform int uFowSourceCountM;
        uniform vec4 uFowSourcesM[${ChunkMeshRegistry.MAX_FOW_SOURCES}];
        uniform sampler2D uExploredMap;
        uniform int uExploredEnabled;
        uniform vec2 uWorldExtentXZ;
        varying vec3 vWorldPosForCutoff;
        `,
      )
      .replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb *= vColor.a;
        if (vWorldPosForCutoff.y >= uHideAboveY) {
          diffuseColor.a *= 0.05;
        }
        if (uFowEnabled == 1) {
          bool inside = false;
          for (int i = 0; i < ${ChunkMeshRegistry.MAX_FOW_SOURCES}; i++) {
            if (i >= uFowSourceCountM) break;
            vec4 src = uFowSourcesM[i];
            vec3 d = vWorldPosForCutoff - src.xyz;
            if (dot(d, d) <= src.w) { inside = true; break; }
          }
          if (!inside) {
            if (uExploredEnabled == 1) {
              vec2 uvE = vWorldPosForCutoff.xz / uWorldExtentXZ;
              float ex = texture2D(uExploredMap, uvE).r;
              if (ex < 0.5) discard;
              float g = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
              diffuseColor.rgb = vec3(g) * 0.55;
            } else {
              discard;
            }
          }
        }
        `,
      );
  };
  return m;
}
