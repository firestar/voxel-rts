import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { RTSCamera } from '../render/Camera';
import { Input } from './Input';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { ChunkMeshRegistry } from '../render/ChunkMeshRegistry';
import { generateWorld } from '../voxel/WorldGen';
import { raycastVoxel } from '../voxel/Raycast';
import { VOXEL_SIZE } from '../voxel/types';
import { DebrisParticles } from '../render/DebrisParticles';
import { PathClient } from '../path/PathClient';
import { UnitManager } from '../sim/Units';
import { UnitRenderer } from '../render/UnitRenderer';
import { NAV_W, NAV_H, navIndex, navCenter } from '../path/SurfaceNav';

export class Game {
  readonly renderer: Renderer;
  readonly camera: RTSCamera;
  readonly input: Input;
  readonly world: VoxelWorld;
  readonly meshes: ChunkMeshRegistry;
  readonly debris: DebrisParticles;
  readonly units = new UnitManager();
  readonly unitRenderer = new UnitRenderer();
  pathClient: PathClient | null = null;

  private last = performance.now();
  private fpsAcc = 0;
  private fpsCount = 0;
  private fpsTimer = 0;
  private fpsEl: HTMLElement | null;

  private readonly explosionRadiusMeters = 1.5;
  private readonly explosionRadiusBigMeters = 3.0;
  private readonly explosionPeak = 90;

  constructor(canvas: HTMLCanvasElement, statsEl: HTMLElement | null) {
    this.renderer = new Renderer(canvas);
    this.camera = new RTSCamera();
    this.input = new Input();
    this.input.attach(window);

    const sharedAvailable = typeof SharedArrayBuffer !== 'undefined' && (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    this.world = VoxelWorld.create(sharedAvailable);
    this.meshes = new ChunkMeshRegistry(this.renderer.scene, this.world);
    this.debris = new DebrisParticles(4096);
    this.renderer.scene.add(this.debris.mesh);
    this.renderer.scene.add(this.unitRenderer.group);
    this.fpsEl = statsEl;

    this.onResize();
    window.addEventListener('resize', this.onResize);
  }

  async generate(seed: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    await generateWorld(this.world, seed, p => onProgress?.(p.done, p.total));
    // Spin up the path worker once the voxel buffer is filled.
    this.pathClient = new PathClient(this.world);
    await this.pathClient.awaitReady();
    this.spawnInitialUnits();
  }

  private spawnInitialUnits(): void {
    if (!this.pathClient) return;
    // Find a flat cell near map center for the soldier spawn.
    const nav = this.pathClient.nav;
    const cx = NAV_W >> 1;
    const cz = NAV_H >> 1;
    let found = { cx, cz };
    let bestFlat = -1;
    for (let dz = -8; dz <= 8; dz++) {
      for (let dx = -8; dx <= 8; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= NAV_W || z >= NAV_H) continue;
        const i = navIndex(x, z);
        if (nav.blocked[i]) continue;
        const f = nav.flatness[i]!;
        if (f > bestFlat) { bestFlat = f; found = { cx: x, cz: z }; }
      }
    }
    const c = navCenter(nav, found.cx, found.cz);
    const soldier = this.units.spawn('soldier', c.x, c.y, c.z);
    soldier.selected = true;
    // Center camera on spawn.
    this.camera.target.set(c.x, 0, c.z);
  }

  start(): void {
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.tick(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private tick(dt: number): void {
    this.input.beginFrame();
    const w = window.innerWidth, h = window.innerHeight;

    this.camera.update({
      keys: this.input.keys,
      mouseX: this.input.mouseX, mouseY: this.input.mouseY,
      rmbDown: this.input.rmbDown,
      rmbDx: this.input.rmbDx, rmbDy: this.input.rmbDy,
      wheel: this.input.wheel,
      width: w, height: h,
    }, dt);

    if (this.input.lmbClickX >= 0) {
      this.handleClick(this.input.lmbClickX, this.input.lmbClickY, w, h, this.input.lmbShift);
    }

    if (this.pathClient) {
      this.units.tick(dt, this.pathClient.nav);
    }
    this.unitRenderer.update(this.units);

    this.debris.update(dt);
    this.meshes.pump(8);

    this.renderer.render(this.camera.cam);

    this.fpsAcc += dt;
    this.fpsCount += 1;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5 && this.fpsEl) {
      const fps = this.fpsCount / this.fpsAcc;
      this.fpsEl.textContent = `FPS ${fps.toFixed(0)} | meshed ${this.meshes.getMeshCount()} | inflight ${this.meshes.getInflight()} | units ${this.units.units.length}`;
      this.fpsAcc = 0; this.fpsCount = 0; this.fpsTimer = 0;
    }
  }

  private rayFromScreen(px: number, py: number, w: number, h: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const ndc = new THREE.Vector2(
      (px / w) * 2 - 1,
      -((py / h) * 2 - 1),
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera.cam);
    return { origin: ray.ray.origin.clone(), dir: ray.ray.direction.clone() };
  }

  private handleClick(px: number, py: number, w: number, h: number, shift: boolean): void {
    const { origin, dir } = this.rayFromScreen(px, py, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 200);
    if (!hit) return;

    if (shift) {
      this.detonateAt(hit);
    } else {
      this.commandMoveTo(hit.x, hit.z);
    }
  }

  private detonateAt(hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number }): void {
    const radiusVoxels = this.explosionRadiusBigMeters / VOXEL_SIZE;
    const cx = hit.x + 0.5 - hit.nx * 0.5;
    const cy = hit.y + 0.5 - hit.ny * 0.5;
    const cz = hit.z + 0.5 - hit.nz * 0.5;
    const result = this.world.damageSphere(cx, cy, cz, radiusVoxels, this.explosionPeak);
    if (result.destroyed.length > 0) {
      const sample = result.destroyed[Math.floor(result.destroyed.length / 2)]!;
      const wx = cx * VOXEL_SIZE, wy = cy * VOXEL_SIZE, wz = cz * VOXEL_SIZE;
      const burst = Math.min(160, 20 + result.destroyed.length * 2);
      this.debris.spawnBurst(wx, wy, wz, burst, sample.material);
    }
  }

  private async commandMoveTo(voxelX: number, voxelZ: number): Promise<void> {
    if (!this.pathClient) return;
    const selected = this.units.units.find(u => u.selected);
    if (!selected) return;

    const wx = (voxelX + 0.5) * VOXEL_SIZE;
    const wz = (voxelZ + 0.5) * VOXEL_SIZE;
    const goal = this.pathClient.cellAt(wx, wz);
    if (!goal.ok) return;

    const start = this.pathClient.cellAt(selected.x, selected.z);
    if (!start.ok) return;

    const res = await this.pathClient.requestPath({
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: selected.footprintRadius,
      prefersRoads: false,
    });
    if (res.cells.length === 0) return;
    const wpts = this.pathClient.cellsToWaypoints(res.cells);
    this.units.setPath(selected, wpts);
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.resize(w, h);
    this.camera.resize(w, h);
  };
}
