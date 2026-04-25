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
import { UnitManager, Unit, UnitKind, CarveRequest } from '../sim/Units';
import { UnitRenderer } from '../render/UnitRenderer';
import { NAV_W, NAV_H, navIndex, navCenter } from '../path/SurfaceNav';
import { worldToVolumeCell } from '../path/VolumeNav';
import { BuildingManager, BARRACKS, checkFootprint } from '../sim/Buildings';
import { BuildingGhost } from '../render/BuildingGhost';

type Mode = 'play' | 'build';

export class Game {
  readonly renderer: Renderer;
  readonly camera: RTSCamera;
  readonly input: Input;
  readonly world: VoxelWorld;
  readonly meshes: ChunkMeshRegistry;
  readonly debris: DebrisParticles;
  readonly units = new UnitManager();
  readonly unitRenderer = new UnitRenderer();
  readonly buildings = new BuildingManager();
  readonly ghost = new BuildingGhost();
  pathClient: PathClient | null = null;

  private last = performance.now();
  private fpsAcc = 0;
  private fpsCount = 0;
  private fpsTimer = 0;
  private fpsEl: HTMLElement | null;
  private modeEl: HTMLElement | null = null;
  private mode: Mode = 'play';
  private rebuildPending = false;
  private rebuildQueued = false;

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
    this.renderer.scene.add(this.ghost.group);
    this.ghost.setSpec(BARRACKS);

    this.buildings.spawner = (kind, x, y, z): Unit | null => this.spawnUnit(kind, x, y, z);

    this.fpsEl = statsEl;
    this.modeEl = document.getElementById('mode');

    this.onResize();
    window.addEventListener('resize', this.onResize);
  }

  async generate(seed: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    await generateWorld(this.world, seed, p => onProgress?.(p.done, p.total));
    this.pathClient = new PathClient(this.world);
    await this.pathClient.awaitReady();
    this.spawnInitialUnits();
  }

  private spawnInitialUnits(): void {
    if (!this.pathClient) return;
    const nav = this.pathClient.nav;
    const cx = NAV_W >> 1, cz = NAV_H >> 1;
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
    const soldier = this.spawnUnit('soldier', c.x, c.y, c.z);
    if (soldier) soldier.selected = true;
    // Spawn a tunneler nearby so the user has both kinds available right away.
    this.spawnUnit('tunneler', c.x + 1.5, c.y, c.z);
    this.camera.target.set(c.x, 0, c.z);
  }

  private spawnUnit(kind: UnitKind, x: number, y: number, z: number): Unit | null {
    return this.units.spawn(kind, x, y, z);
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

    if (this.input.pressed.has('KeyB')) {
      this.mode = this.mode === 'build' ? 'play' : 'build';
      if (this.mode !== 'build') this.ghost.hide();
    }
    if (this.input.pressed.has('Escape') && this.mode === 'build') {
      this.mode = 'play';
      this.ghost.hide();
    }
    if (this.input.pressed.has('Tab')) this.cycleSelection();

    if (this.mode === 'build') {
      this.updateGhost(w, h);
    }

    if (this.input.lmbClickX >= 0) {
      this.handleClick(this.input.lmbClickX, this.input.lmbClickY, w, h, this.input.lmbShift);
    }

    if (this.pathClient) {
      this.units.tick(dt, this.pathClient.nav, this.pathClient.vnav, (req) => this.handleCarve(req));
      this.buildings.tick(dt, this.world, this.units);
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
      this.fpsEl.textContent = `FPS ${fps.toFixed(0)} | meshed ${this.meshes.getMeshCount()} | inflight ${this.meshes.getInflight()} | units ${this.units.units.length} | buildings ${this.buildings.buildings.length}`;
      this.fpsAcc = 0; this.fpsCount = 0; this.fpsTimer = 0;
    }
    if (this.modeEl) {
      const sel = this.units.units.find(u => u.selected);
      const selDesc = sel ? `${sel.kind} #${sel.id}` : 'none';
      this.modeEl.textContent = `${this.mode === 'build' ? 'MODE: BUILD (LMB place, Esc cancel)' : 'MODE: PLAY'} | selected: ${selDesc}`;
    }
  }

  private cycleSelection(): void {
    const arr = this.units.units;
    if (arr.length === 0) return;
    const idx = arr.findIndex(u => u.selected);
    arr.forEach(u => u.selected = false);
    const next = (idx + 1) % arr.length;
    arr[next]!.selected = true;
  }

  private rayFromScreen(px: number, py: number, w: number, h: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const ndc = new THREE.Vector2((px / w) * 2 - 1, -((py / h) * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera.cam);
    return { origin: ray.ray.origin.clone(), dir: ray.ray.direction.clone() };
  }

  private updateGhost(w: number, h: number): void {
    if (!this.pathClient) return;
    if (this.input.mouseX < 0) { this.ghost.hide(); return; }
    const { origin, dir } = this.rayFromScreen(this.input.mouseX, this.input.mouseY, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 200);
    if (!hit) { this.ghost.hide(); return; }
    const wx = hit.x * VOXEL_SIZE;
    const wz = hit.z * VOXEL_SIZE;
    const cell = this.pathClient.cellAt(wx, wz);
    const ox = Math.max(0, Math.min(NAV_W - BARRACKS.cellsW, cell.cx - (BARRACKS.cellsW >> 1)));
    const oz = Math.max(0, Math.min(NAV_H - BARRACKS.cellsD, cell.cz - (BARRACKS.cellsD >> 1)));
    const fp = checkFootprint(this.world.buffers.voxels, this.pathClient.nav, BARRACKS, ox, oz);
    this.ghost.place(ox, oz, fp.floorY >= 0 ? fp.floorY : hit.y, fp.ok);
  }

  private handleClick(px: number, py: number, w: number, h: number, shift: boolean): void {
    const { origin, dir } = this.rayFromScreen(px, py, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 200);
    if (!hit) return;

    if (this.mode === 'build') {
      this.tryPlaceBuilding(hit);
      return;
    }

    if (shift) {
      this.detonateAt(hit);
    } else {
      this.commandMoveTo(hit.x, hit.y, hit.z);
    }
  }

  private tryPlaceBuilding(hit: { x: number; z: number }): void {
    if (!this.pathClient) return;
    const wx = hit.x * VOXEL_SIZE;
    const wz = hit.z * VOXEL_SIZE;
    const cell = this.pathClient.cellAt(wx, wz);
    const ox = Math.max(0, Math.min(NAV_W - BARRACKS.cellsW, cell.cx - (BARRACKS.cellsW >> 1)));
    const oz = Math.max(0, Math.min(NAV_H - BARRACKS.cellsD, cell.cz - (BARRACKS.cellsD >> 1)));
    const fp = checkFootprint(this.world.buffers.voxels, this.pathClient.nav, BARRACKS, ox, oz);
    if (!fp.ok) return;
    this.buildings.place(this.world, BARRACKS, ox, oz, fp.floorY);
    this.requestNavRebuild();
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
      this.requestNavRebuild();
    }
  }

  /** Tunneler asks to clear a cell — issue a destructive sphere edit and queue a rebuild. */
  private handleCarve(req: CarveRequest): void {
    const radiusVoxels = req.radiusMeters / VOXEL_SIZE;
    const cx = req.x / VOXEL_SIZE;
    const cy = req.y / VOXEL_SIZE;
    const cz = req.z / VOXEL_SIZE;
    // Use a peak well above any soft-material HP so the cell fully clears.
    const result = this.world.damageSphere(cx, cy, cz, radiusVoxels, 250);
    if (result.destroyed.length > 0) {
      const sample = result.destroyed[Math.floor(result.destroyed.length / 2)]!;
      this.debris.spawnBurst(req.x, req.y, req.z, 30, sample.material);
      this.requestNavRebuild();
    }
  }

  private requestNavRebuild(): void {
    if (!this.pathClient) return;
    if (this.rebuildPending) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuildPending = true;
    void this.pathClient.rebuildNav().then(() => {
      this.rebuildPending = false;
      this.replanMovingUnits();
      if (this.rebuildQueued) {
        this.rebuildQueued = false;
        this.requestNavRebuild();
      }
    });
  }

  private replanMovingUnits(): void {
    if (!this.pathClient) return;
    for (const u of this.units.units) {
      if (u.path.length === 0) continue;
      const goal = u.path[u.path.length - 1]!;
      if (u.kind === 'tunneler') {
        const startCell = worldToVolumeCell(u.x, u.y, u.z);
        const goalCell = worldToVolumeCell(goal.x, goal.y, goal.z);
        void this.pathClient.requestVolumePath({
          startCx: startCell.cx, startCy: startCell.cy, startCz: startCell.cz,
          goalCx: goalCell.cx, goalCy: goalCell.cy, goalCz: goalCell.cz,
        }).then((res) => {
          if (res.cells.length > 0) {
            this.units.setPath(u, this.pathClient!.volumeCellsToWaypoints(res.cells));
          }
        });
      } else {
        const start = this.pathClient.cellAt(u.x, u.z);
        const goalCell = this.pathClient.cellAt(goal.x, goal.z);
        void this.pathClient.requestPath({
          startCx: start.cx, startCz: start.cz,
          goalCx: goalCell.cx, goalCz: goalCell.cz,
          footprintRadius: u.footprintRadius,
          prefersRoads: false,
        }).then((res) => {
          if (res.cells.length > 0) {
            this.units.setPath(u, this.pathClient!.cellsToWaypoints(res.cells));
          } else {
            u.path = [];
          }
        });
      }
    }
  }

  private async commandMoveTo(voxelX: number, voxelY: number, voxelZ: number): Promise<void> {
    if (!this.pathClient) return;
    const selected = this.units.units.find(u => u.selected);
    if (!selected) return;
    const wx = (voxelX + 0.5) * VOXEL_SIZE;
    const wy = (voxelY + 0.5) * VOXEL_SIZE;
    const wz = (voxelZ + 0.5) * VOXEL_SIZE;

    if (selected.kind === 'tunneler') {
      const startCell = worldToVolumeCell(selected.x, selected.y, selected.z);
      const goalCell = worldToVolumeCell(wx, wy, wz);
      const res = await this.pathClient.requestVolumePath({
        startCx: startCell.cx, startCy: startCell.cy, startCz: startCell.cz,
        goalCx: goalCell.cx, goalCy: goalCell.cy, goalCz: goalCell.cz,
      });
      if (res.cells.length === 0) return;
      this.units.setPath(selected, this.pathClient.volumeCellsToWaypoints(res.cells));
    } else {
      const goal = this.pathClient.cellAt(wx, wz);
      const start = this.pathClient.cellAt(selected.x, selected.z);
      const res = await this.pathClient.requestPath({
        startCx: start.cx, startCz: start.cz,
        goalCx: goal.cx, goalCz: goal.cz,
        footprintRadius: selected.footprintRadius,
        prefersRoads: false,
      });
      if (res.cells.length === 0) return;
      this.units.setPath(selected, this.pathClient.cellsToWaypoints(res.cells));
    }
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.resize(w, h);
    this.camera.resize(w, h);
  };
}
