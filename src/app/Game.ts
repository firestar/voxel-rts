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
import { NAV_W, NAV_H, navIndex, navCenter, NAV_CELL_METERS } from '../path/SurfaceNav';
import { worldToVolumeCell, vnavIndex, getBit } from '../path/VolumeNav';
import { trackDamageFor } from '../voxel/Materials';
import { BuildingManager, BARRACKS, checkFootprint } from '../sim/Buildings';
import { BuildingGhost } from '../render/BuildingGhost';
import { PathPreview } from '../render/PathPreview';
import { TargetMarker } from '../render/TargetMarker';

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
  readonly pathPreview = new PathPreview();
  readonly target = new TargetMarker();
  pathClient: PathClient | null = null;
  /** Pixels of vertical drag = 1 m of altitude offset for tunneler targets. */
  private readonly altitudeDragSensitivity = 8;
  /** Squared px threshold above which a click is treated as a "drag". */
  private readonly dragThresholdPx2 = 6 * 6;

  private last = performance.now();
  private fpsAcc = 0;
  private fpsCount = 0;
  private fpsTimer = 0;
  private fpsEl: HTMLElement | null;
  private modeEl: HTMLElement | null = null;
  private mode: Mode = 'play';
  private rebuildPending = false;
  private rebuildQueued = false;
  private rebuildShouldReplan = false;

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
    this.renderer.scene.add(this.pathPreview.object);
    this.renderer.scene.add(this.target.group);
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
    this.spawnUnit('tank', c.x + 3.0, c.y, c.z);
    this.spawnUnit('tunneler', c.x - 2.0, c.y, c.z);
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

    // LMB hold → preview marker (tunneler altitude drag); release → fire actual command.
    this.updateLmbPreview(w, h);
    if (this.input.release) {
      this.handleRelease(this.input.release, w, h);
    }

    if (this.pathClient) {
      this.units.tick(dt, this.pathClient.nav, this.pathClient.vnav, this.world.buffers.voxels, (req) => this.handleCarve(req));
      this.buildings.tick(dt, this.world, this.units);
      this.paintTankTracks();
    }
    this.unitRenderer.update(this.units);

    // Dashed path preview for the selected unit (if any).
    const sel = this.units.units.find(u => u.selected);
    if (sel && sel.path.length > 0) {
      this.pathPreview.update({ x: sel.x, y: sel.y, z: sel.z }, sel.path);
    } else {
      this.pathPreview.update(null, []);
    }
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

  /**
   * Compute the world-space target for the currently-selected unit given the cursor at
   * (px, py) and an optional vertical drag in pixels (positive = drag down = go deeper).
   * Returns null when the ray misses geometry.
   */
  private resolveTarget(px: number, py: number, w: number, h: number, verticalDragPx: number): {
    surface: THREE.Vector3;
    target: THREE.Vector3;
    voxelXYZ: { x: number; y: number; z: number; nx: number; ny: number; nz: number };
  } | null {
    const { origin, dir } = this.rayFromScreen(px, py, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 400);
    if (!hit) return null;
    const wx = (hit.x + 0.5) * VOXEL_SIZE;
    const wy = (hit.y + 0.5) * VOXEL_SIZE;
    const wz = (hit.z + 0.5) * VOXEL_SIZE;
    const dragMeters = verticalDragPx / this.altitudeDragSensitivity; // down = +meters depth
    const target = new THREE.Vector3(wx, Math.max(0.5, wy - dragMeters), wz);
    return {
      surface: new THREE.Vector3(wx, wy, wz),
      target,
      voxelXYZ: { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz },
    };
  }

  private updateLmbPreview(w: number, h: number): void {
    const hold = this.input.hold;
    if (!hold || this.mode === 'build' || hold.shift) {
      this.target.hide();
      return;
    }
    const selected = this.units.units.find(u => u.selected);
    // Preview only matters for tunnelers (vertical drag) — keep marker visible when held over terrain.
    if (!selected) { this.target.hide(); return; }
    const verticalDrag = hold.currentY - hold.startY;
    const r = this.resolveTarget(hold.startX, hold.startY, w, h, selected.kind === 'tunneler' ? verticalDrag : 0);
    if (!r) { this.target.hide(); return; }
    this.target.show(r.surface, r.target);
  }

  private handleRelease(release: { startX: number; startY: number; endX: number; endY: number; shift: boolean }, w: number, h: number): void {
    this.target.hide();
    if (this.mode === 'build') {
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (r) this.tryPlaceBuilding(r.voxelXYZ);
      return;
    }
    if (release.shift) {
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (r) this.detonateAt(r.voxelXYZ);
      return;
    }
    const selected = this.units.units.find(u => u.selected);
    const verticalDrag = release.endY - release.startY;
    const useDrag = selected?.kind === 'tunneler';
    const r = this.resolveTarget(release.startX, release.startY, w, h, useDrag ? verticalDrag : 0);
    if (!r) return;
    void this.commandMoveToWorld(r.target.x, r.target.y, r.target.z);
  }

  private async commandMoveToWorld(wx: number, wy: number, wz: number): Promise<void> {
    if (!this.pathClient) return;
    const selected = this.units.units.find(u => u.selected);
    if (!selected) return;
    await this.routePath(selected, wx, wy, wz);
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

  /** Tunneler asks to clear voxels at the cutter — sphere by default, oriented cylinder when axis is supplied. */
  private handleCarve(req: CarveRequest): void {
    const radiusVoxels = req.radiusMeters / VOXEL_SIZE;
    const cx = req.x / VOXEL_SIZE;
    const cy = req.y / VOXEL_SIZE;
    const cz = req.z / VOXEL_SIZE;
    const result = req.axisX !== undefined
      ? this.world.damageOrientedCylinder(
          cx, cy, cz,
          req.axisX, req.axisY!, req.axisZ!,
          (req.halfLengthMeters ?? 0) / VOXEL_SIZE,
          radiusVoxels,
          250,
        )
      : this.world.damageSphere(cx, cy, cz, radiusVoxels, 250);
    if (result.destroyed.length > 0) {
      const sample = result.destroyed[Math.floor(result.destroyed.length / 2)]!;
      this.debris.spawnBurst(req.x, req.y, req.z, 30, sample.material);
      // Carving only opens new space — it never blocks an existing path. Refresh nav so
      // future routes see the tunnel, but skip the replan that would yank live paths.
      this.requestNavRebuild(false);
    }
  }

  private requestNavRebuild(replan = true): void {
    if (!this.pathClient) return;
    if (this.rebuildPending) {
      this.rebuildQueued = true;
      // If any caller asks to replan, the eventual rebuild should replan.
      if (replan) this.rebuildShouldReplan = true;
      return;
    }
    this.rebuildPending = true;
    this.rebuildShouldReplan = replan;
    void this.pathClient.rebuildNav().then(() => {
      this.rebuildPending = false;
      const shouldReplan = this.rebuildShouldReplan;
      this.rebuildShouldReplan = false;
      if (shouldReplan) this.replanMovingUnits();
      if (this.rebuildQueued) {
        this.rebuildQueued = false;
        this.requestNavRebuild(shouldReplan);
      }
    });
  }

  private replanMovingUnits(): void {
    if (!this.pathClient) return;
    for (const u of this.units.units) {
      if (u.path.length === 0) continue;
      const goal = u.path[u.path.length - 1]!;
      void this.routePath(u, goal.x, goal.y, goal.z);
    }
  }

  /**
   * Pick surface vs volume pathing for a unit:
   *  - Tunneler always uses volume (it digs).
   *  - Anyone whose start OR destination is meaningfully below the local surface uses volume.
   *  - Otherwise surface pathing (cheaper, gives a smoother surface walk).
   */
  private async routePath(unit: Unit, wx: number, wy: number, wz: number): Promise<void> {
    if (!this.pathClient) return;
    const goalSurfaceY = this.surfaceWorldY(wx, wz);
    const startSurfaceY = this.surfaceWorldY(unit.x, unit.z);
    const goalUnderground = wy < goalSurfaceY - 0.5;
    const startUnderground = unit.y < startSurfaceY - 0.5;
    const useVolume = unit.canDig || goalUnderground || startUnderground;

    if (useVolume) {
      // Tunneler shortcut — it can grind through anything that isn't bedrock, so
      // we don't need a graph search to find a route. Just heading straight at
      // the destination is correct in the common case; the only reasons to fall
      // back to volume A* are:
      //   - the line would require a steeper climb/dive than the unit can pitch,
      //   - or it crosses a bedrock cell the unit physically can't cut.
      if (unit.canDig && this.tunnelerCanGoStraight(unit, wx, wy, wz)) {
        this.units.setPath(unit, [{ x: wx, y: wy, z: wz }]);
        return;
      }
      const startCell = worldToVolumeCell(unit.x, unit.y, unit.z);
      const goalCell = worldToVolumeCell(wx, wy, wz);
      const res = await this.pathClient.requestVolumePath({
        startCx: startCell.cx, startCy: startCell.cy, startCz: startCell.cz,
        goalCx: goalCell.cx, goalCy: goalCell.cy, goalCz: goalCell.cz,
        canDig: unit.canDig,
        requiresGround: unit.requiresGround,
        footprintRadius: unit.footprintRadius,
        maxPitchRad: unit.maxPitchRad,
      });
      // Refuse partial paths — the unit only moves if A* could reach the destination.
      if (res.cells.length === 0 || !res.reached) return;
      this.units.setPath(unit, this.pathClient.volumeCellsToWaypoints(res.cells));
      return;
    }

    // If the click landed on a blocked cell (e.g. a column where every voxel was carved
    // out, or right at a building edge), pull the goal toward the nearest walkable cell
    // so the unit at least gets close instead of refusing to move.
    const goal = this.pathClient.nearestWalkable(wx, wz, 4);
    const start = this.pathClient.cellAt(unit.x, unit.z);
    const res = await this.pathClient.requestPath({
      startCx: start.cx, startCz: start.cz,
      goalCx: goal.cx, goalCz: goal.cz,
      footprintRadius: unit.footprintRadius,
      maxStepVoxels: unit.maxStepVoxels,
      slopePenalty: unit.slopePenalty,
      bodyHalfCells: unit.bodyHalfCells,
      bodyRoughnessVoxels: unit.bodyRoughnessVoxels,
      prefersRoads: false,
      // Per-unit seed so units headed to the same goal don't all share the same A*-optimal
      // line — they spread out along nearby alternates instead.
      routeSeed: unit.id * 0x9e3779b9 + 1,
    });
    if (res.cells.length === 0 || !res.reached) return;
    this.units.setPath(unit, this.pathClient.cellsToWaypoints(res.cells));
  }

  /**
   * For every tank that's traveled at least TANK_TRACK_INTERVAL metres since its last
   * mark, fire a small damageSphere under each tread keyed off the surface material.
   * Soft ground (mud) accumulates damage fast and the top voxel disappears within a
   * pass or two, so the tank visibly sinks. Grass takes a few passes before grooves
   * expose dirt below. Stone/wood/etc. are not affected (peak === 0).
   */
  private paintTankTracks(): void {
    if (!this.pathClient) return;
    const TANK_TRACK_INTERVAL = 0.4;     // m between tread marks
    const TANK_TREAD_OFFSET = 1.20;      // half-spacing between treads, m (matches model)
    const nav = this.pathClient.nav;
    let anythingDestroyed = false;

    for (const u of this.units.units) {
      if (u.kind !== 'tank') continue;
      if (u.distanceWalked - u.lastTrackDistance < TANK_TRACK_INTERVAL) continue;
      u.lastTrackDistance = u.distanceWalked;
      // forward = (-sin h, -cos h);  right = (cos h, -sin h).
      const ch = Math.cos(u.heading);
      const sh = Math.sin(u.heading);
      const rx = ch, rz = -sh;
      for (const off of [-TANK_TREAD_OFFSET, TANK_TREAD_OFFSET]) {
        const wx = u.x + rx * off;
        const wz = u.z + rz * off;
        const cx = Math.floor(wx / NAV_CELL_METERS);
        const cz = Math.floor(wz / NAV_CELL_METERS);
        if (cx < 0 || cz < 0 || cx >= NAV_W || cz >= NAV_H) continue;
        const top = nav.topY[navIndex(cx, cz)]!;
        if (top < 0) continue;

        // Sample the actual top voxel under the tread (not just cell-average) to pick a
        // recipe — sloped ground varies across an 8-voxel cell.
        const baseX = Math.floor(wx / VOXEL_SIZE);
        const baseZ = Math.floor(wz / VOXEL_SIZE);
        let surfaceY = top;
        let surfaceMat = 0;
        for (let yProbe = top + 2; yProbe >= top - 2 && yProbe >= 0; yProbe--) {
          const m = this.world.get(baseX, yProbe, baseZ);
          if (m === 0) continue;
          surfaceY = yProbe;
          surfaceMat = m;
          break;
        }
        if (surfaceMat === 0) continue;

        const recipe = trackDamageFor(surfaceMat);
        if (recipe.peak <= 0 || recipe.radiusMeters <= 0) continue;

        // damageSphere takes voxel-space coords; centre slightly above the top voxel so
        // the falloff bites the topmost layer hardest.
        const cxv = (baseX + 0.5);
        const cyv = surfaceY + 0.5;
        const czv = (baseZ + 0.5);
        const result = this.world.damageSphere(
          cxv, cyv, czv,
          recipe.radiusMeters / VOXEL_SIZE,
          recipe.peak,
        );
        if (result.destroyed.length > 0) anythingDestroyed = true;
      }
    }
    // Only request a nav rebuild when track damage actually removed voxels (changed
    // topY); a no-op pass over compacted grass/dirt just bumps damage counters.
    if (anythingDestroyed) this.requestNavRebuild(false);
  }

  /**
   * Validate a straight-line route for a tunneler from its current position to the
   * world-space goal. Returns true when:
   *   - the climb/dive pitch is within the unit's maxPitchRad, AND
   *   - no volume cell along the line is marked bedrock.
   *
   * Anything else is fair game — the cutter chews through dirt, stone, and walks
   * through air with the same path. This is what lets the tunneler ignore the volume
   * A* on the common case where the user just wants it to head toward a target.
   */
  private tunnelerCanGoStraight(unit: { x: number; y: number; z: number; maxPitchRad: number }, wx: number, wy: number, wz: number): boolean {
    if (!this.pathClient) return false;
    const dx = wx - unit.x, dy = wy - unit.y, dz = wz - unit.z;
    const horiz = Math.hypot(dx, dz);
    const pitch = horiz < 1e-4 ? Math.PI / 2 : Math.atan2(Math.abs(dy), horiz);
    if (pitch > unit.maxPitchRad) return false;

    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return true;
    // One sample per metre — volume cells are 1 m so this hits every cell on the line.
    const steps = Math.max(1, Math.ceil(dist));
    const vnav = this.pathClient.vnav;
    let lastIdx = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = unit.x + dx * t;
      const sy = unit.y + dy * t;
      const sz = unit.z + dz * t;
      const cell = worldToVolumeCell(sx, sy, sz);
      const idx = vnavIndex(cell.cx, cell.cy, cell.cz);
      if (idx === lastIdx) continue;
      lastIdx = idx;
      if (getBit(vnav.bedrock, idx)) return false;
    }
    return true;
  }

  /** World-space Y (meters) of the topY voxel under the given world-space (x, z). */
  private surfaceWorldY(wx: number, wz: number): number {
    if (!this.pathClient) return 0;
    const cell = this.pathClient.cellAt(wx, wz);
    const i = navIndex(cell.cx, cell.cz);
    const top = this.pathClient.nav.topY[i]!;
    return top < 0 ? 0 : (top + 1) * VOXEL_SIZE;
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.resize(w, h);
    this.camera.resize(w, h);
  };
}
