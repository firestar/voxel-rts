import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { RTSCamera } from '../render/Camera';
import { Input } from './Input';
import { VoxelWorld, worldIndex } from '../voxel/VoxelWorld';
import { ChunkMeshRegistry } from '../render/ChunkMeshRegistry';
import { generateWorld } from '../voxel/WorldGen';
import { raycastVoxel } from '../voxel/Raycast';
import { VOXEL_SIZE, WORLD_Y, WORLD_X, WORLD_Z, AIR } from '../voxel/types';
import { DebrisParticles } from '../render/DebrisParticles';
import { Pathfinder, profileFromUnit } from '../path/Pathfinder';
import { PathWorkerClient } from '../path/PathWorkerClient';
import type { PathTelemetry } from '../path/PathWorkerClient';
import { sharedBuffersAvailable } from '../util/Shared';
import {
  SurfaceNavBuffers, allocateNav, buildSurfaceNav, refreshSurfaceNavBox,
  NAV_W, NAV_H, navIndex, navCenter, NAV_CELL_METERS, NAV_CELL_VOXELS,
} from '../path/SurfaceNav';
import {
  VolumeNavBuffers, allocateVolumeNav, buildVolumeNav, rebuildVolumeCell,
  worldToVolumeCell, vnavIndex, getBit,
} from '../path/VolumeNav';
import {
  UnitManager, Unit, UnitKind, CarveRequest, WorldEditRequest, LevelRequest, TrampleRequest,
  unitConfig, UNIT_KINDS,
} from '../sim/Units';
import { UnitRenderer } from '../render/UnitRenderer';
import {
  trackDamageFor,
  M_DIRT, M_WOOD, M_METAL, M_FARM,
  M_GRASS, M_STONE, M_PATH, M_MUD,
} from '../voxel/Materials';
import type { MaterialId } from '../voxel/types';
import { BuildingManager, BARRACKS, STORAGE, ALL_BUILDINGS, BuildingSpec, Building, checkFootprint } from '../sim/Buildings';
import { BuildingGhost } from '../render/BuildingGhost';
import { BuildingRenderer } from '../render/BuildingRenderer';
import { BuildingRangeIndicator } from '../render/BuildingRangeIndicator';
import { UnitRangeIndicator } from '../render/UnitRangeIndicator';
import { PathPreview } from '../render/PathPreview';
import { PendingPathPreview } from '../render/PendingPathPreview';
import { ProcessingBoxOverlay, ProcessBox } from '../render/ProcessingBoxOverlay';
import { TargetMarker } from '../render/TargetMarker';
import { Resources } from '../sim/Resources';
import { SaplingManager } from '../sim/Saplings';
import { tickWorkers, approachPos } from '../sim/Workers';
import { WorkerTaskBoard, describeOrder } from '../sim/WorkerTasks';
import { ProjectileManager, PROJECTILES, muzzleOrigin, ProjectileImpact } from '../sim/Projectiles';
import { WEAPONS, WeaponKind } from '../sim/Weapons';
import { tickWeapons } from '../sim/WeaponTick';
import {
  ProjectileRenderer, FlashPool, ImpactRingPool, TrajectoryPreview, ImpactMarker,
  ProjectileArcPool,
} from '../render/ProjectileRenderer';
import { HealthBarRenderer } from '../render/HealthBarRenderer';
import { RallyMarkerRenderer } from '../render/RallyMarker';
import { MetalCluster, METAL_PER_VOXEL } from '../voxel/Metals';
import {
  ActionContext, BuildingAction, UnitAction,
  buildingActionsFor, unitActionsFor,
} from './Actions';

/**
 * Player UI mode. `build*` modes preview a building footprint; `plant` mode
 * tells the next LMB-on-grass to dispatch a sapling-plant task to the
 * selected worker. `terrain` is the sandbox / map-editor mode where LMB
 * paints a sphere of the active material onto the world (shift-LMB carves
 * one out). `play` is everything else.
 */
type Mode = 'play' | 'build' | 'plant' | 'terrain' | 'waypoint';

/**
 * Material palette the terrain editor cycles through. Order maps to
 * Digit1..Digit{N} while the editor is active. Bedrock and air are
 * intentionally excluded — bedrock is indestructible, and air is reached
 * via shift-LMB carve.
 */
const TERRAIN_PALETTE: { id: MaterialId; label: string }[] = [
  { id: M_GRASS, label: 'grass' },
  { id: M_DIRT,  label: 'dirt' },
  { id: M_STONE, label: 'stone' },
  { id: M_WOOD,  label: 'wood' },
  { id: M_METAL, label: 'metal' },
  { id: M_PATH,  label: 'path' },
  { id: M_MUD,   label: 'mud' },
];

/** Brush radius bounds for the terrain editor, in voxel units. */
const TERRAIN_BRUSH_MIN = 1;
const TERRAIN_BRUSH_MAX = 12;

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
  readonly buildingRenderer = new BuildingRenderer();
  readonly buildingRange = new BuildingRangeIndicator();
  readonly unitRange = new UnitRangeIndicator();
  readonly ghost = new BuildingGhost();
  /** The spec the user will place next while in build mode. Cycled via 1..N keys. */
  private buildSpec: BuildingSpec = BARRACKS;
  readonly pathPreview = new PathPreview();
  readonly pendingPathPreview = new PendingPathPreview();
  readonly processingBoxOverlay = new ProcessingBoxOverlay();
  /** Pending path requests by unit id: start + goal for the blue routing indicator. */
  private readonly pendingPathRequests = new Map<number, { start: { x: number; y: number; z: number }; goal: { x: number; y: number; z: number } }>();
  /** In-flight nav-rebuild regions (yellow boxes). Key is a monotonic id. */
  private readonly navRebuildRegions = new Map<number, ProcessBox>();
  private nextNavRebuildId = 0;
  /**
   * Pending nav-rebuild boxes accumulated within the current tick.
   * Each entry is an AABB that will become one `executeNavRebuildAround` call.
   * Incoming boxes are merged into an existing entry only if they overlap
   * (or are within NAV_MERGE_PAD metres), so distant clusters stay separate
   * and we never rebuild a giant merged region spanning multiple ore sites.
   */
  private readonly pendingNavBoxes: Array<{ minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; replan: boolean }> = [];
  /** Last completed path stats per unit id, for the path-info debug panel. */
  private readonly lastPathStatsByUnit = new Map<number, { kind: string; start: { cx: number; cy: number; cz: number }; goal: { cx: number; cy: number; cz: number }; reached: boolean; expanded: number; waypointCount: number; timings: PathTelemetry | undefined; timestamp: number }>();
  readonly target = new TargetMarker();
  readonly resources = new Resources();
  readonly saplings = new SaplingManager();
  readonly taskBoard = new WorkerTaskBoard();
  readonly projectiles = new ProjectileManager();
  readonly projectileRenderer = new ProjectileRenderer();
  readonly muzzleFlashes = new FlashPool(256);
  readonly impactFlashes = new FlashPool(128);
  readonly impactRings = new ImpactRingPool(64);
  readonly trajectoryPreview = new TrajectoryPreview();
  readonly projectileArcs = new ProjectileArcPool(64, 96);
  readonly impactMarker = new ImpactMarker();
  readonly healthBars = new HealthBarRenderer();
  readonly rallyMarkers = new RallyMarkerRenderer();
  private metalClusters: MetalCluster[] = [];
  // Remaining metal per voxel (worldIndex → count). Defaults to METAL_PER_VOXEL on first access.
  private metalVoxelRemaining = new Map<number, number>();
  // Per-surface-column trample counter (2D: vx * WORLD_Z + vz). Grass converts to
  // dirt once the count reaches the kind-specific threshold.
  private readonly trampleCounts = new Uint8Array(WORLD_X * WORLD_Z);
  pathfinder: Pathfinder | null = null;
  pathWorker: PathWorkerClient | null = null;
  surfaceNav: SurfaceNavBuffers | null = null;
  vnav: VolumeNavBuffers | null = null;
  /**
   * Per-unit "latest pathfinding request" id. The path worker is async, so
   * if the player issues two move orders to the same unit in quick succession
   * the older response could otherwise clobber the newer one when it arrives.
   * We bump this on every routePath call and ignore stale replies.
   */
  private readonly latestPathReqByUnit = new Map<number, number>();
  /** Pixels of vertical drag = 1 m of altitude offset for tunneler targets. */
  private readonly altitudeDragSensitivity = 8;
  /** Squared px threshold above which a click is treated as a "drag". */
  private readonly dragThresholdPx2 = 6 * 6;
  /** DOM element used to draw the LMB box-select rectangle while dragging. */
  private selBoxEl: HTMLElement | null = null;

  private last = performance.now();
  private fpsAcc = 0;
  private fpsCount = 0;
  private fpsTimer = 0;
  private fpsEl: HTMLElement | null;
  private modeEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  /** Last rendered panel signature. Used to skip DOM rebuilds when nothing changed. */
  private actionsRenderedKey = '';
  private tasksEl: HTMLElement | null = null;
  /** Last rendered task-panel signature. Same purpose as `actionsRenderedKey`. */
  private tasksRenderedKey = '';
  private pathInfoEl: HTMLElement | null = null;
  private mode: Mode = 'play';
  /** Stance to assign when the next LMB click commits a rally waypoint. */
  private pendingWaypointStance: 'aggressive' | 'defensive' = 'aggressive';
  /** Active terrain-editor material (palette index). Persists across mode toggles. */
  private terrainPaletteIdx = 0;
  /** Active terrain-editor brush radius, in voxels. */
  private terrainBrushRadius = 3;
  /**
   * Y-axis cutoff (in meters). Anything at or above this Y is rendered at 5%
   * opacity so the player can see underground tunnels through it. Raycasts —
   * including the LMB target picker — also ignore voxels above the cutoff,
   * so a click pierces the see-through overlay and lands on whatever is
   * actually visible underneath. `Infinity` disables the cutoff entirely.
   *
   * Hotkeys: `[` lower the cutoff one meter, `]` raise it, `\` reset it
   * (back to disabled, i.e. show everything).
   */
  private hideAboveY = Infinity;
  private readonly explosionRadiusBigMeters = 3.0;
  private readonly explosionPeak = 90;

  constructor(canvas: HTMLCanvasElement, statsEl: HTMLElement | null) {
    this.renderer = new Renderer(canvas);
    this.camera = new RTSCamera();
    this.input = new Input();
    this.input.attach(window);

    const sharedAvailable = sharedBuffersAvailable();
    this.world = VoxelWorld.create(sharedAvailable);
    this.meshes = new ChunkMeshRegistry(this.renderer.scene, this.world);
    // Wire the world into the projectile manager so newly spawned rounds
    // pre-compute their full visible arc (used by the dashed-line renderer
    // so the arc stays visible from spawn through impact).
    this.projectiles.worldForPrediction = this.world;
    this.debris = new DebrisParticles(4096);
    this.renderer.scene.add(this.debris.mesh);
    this.renderer.scene.add(this.unitRenderer.group);
    this.renderer.scene.add(this.buildingRenderer.group);
    this.renderer.scene.add(this.buildingRange.group);
    this.renderer.scene.add(this.unitRange.group);
    this.renderer.scene.add(this.ghost.group);
    this.renderer.scene.add(this.pathPreview.object);
    this.renderer.scene.add(this.pendingPathPreview.object);
    this.renderer.scene.add(this.processingBoxOverlay.group);
    this.renderer.scene.add(this.target.group);
    this.renderer.scene.add(this.projectileRenderer.mesh);
    this.renderer.scene.add(this.muzzleFlashes.mesh);
    this.renderer.scene.add(this.impactFlashes.mesh);
    this.renderer.scene.add(this.impactRings.group);
    this.renderer.scene.add(this.trajectoryPreview.object);
    this.renderer.scene.add(this.projectileArcs.group);
    this.renderer.scene.add(this.impactMarker.object);
    this.renderer.scene.add(this.healthBars.group);
    this.renderer.scene.add(this.rallyMarkers.group);
    this.ghost.setSpec(this.buildSpec);

    this.buildings.spawner = (kind, x, y, z): Unit | null => this.spawnUnit(kind, x, y, z);
    this.buildings.afterSpawn = (unit, building): void => {
      if (!building.rallyPoint) return;
      const rp = building.rallyPoint;
      if (unit.weapon !== null) unit.stance = building.rallyStance;
      void this.routePath(unit, rp.x, rp.y, rp.z, { forceSurface: true });
    };
    // Farms feed the resource counter via the manager's foodSink hook so the
    // sim doesn't have to know about Resources directly.
    this.buildings.foodSink = (amount): void => { this.resources.food += amount; };
    // Buildings with weapons (turret, silo) drop their projectiles into the
    // shared manager and route their muzzle flashes into the same FlashPool
    // unit shots use, so the visual feels uniform.
    this.buildings.projectiles = this.projectiles;
    this.buildings.onBuildingMuzzleFlash = (x, y, z, radius, life, color): void => {
      this.muzzleFlashes.spawn(x, y, z, radius, life, color.r, color.g, color.b);
    };

    this.fpsEl = statsEl;
    this.modeEl = document.getElementById('mode');
    this.selBoxEl = document.getElementById('selbox');
    this.actionsEl = document.getElementById('actions');
    this.tasksEl = document.getElementById('tasks');
    this.pathInfoEl = document.getElementById('pathinfo');

    this.onResize();
    window.addEventListener('resize', this.onResize);
  }

  async generate(seed: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    this.metalClusters = await generateWorld(this.world, seed, p => onProgress?.(p.done, p.total));
    const useShared = sharedBuffersAvailable();
    // Surface projection — used by buildings, render code, Y-snap. Independent
    // of the per-unit-type 3D pathfinding grids below.
    this.surfaceNav = allocateNav(useShared);
    buildSurfaceNav(this.world.buffers.voxels, this.surfaceNav);
    // Volume summary — exposed for diggers' "is the next cell still solid?"
    // mid-tick check inside Units.tickVolume. Same shape the legacy code used.
    this.vnav = allocateVolumeNav(useShared);
    buildVolumeNav(this.world.buffers.voxels, this.vnav);
    // Per-unit-type pathfinding grids. The Pathfinder owns its own VolumeGrid
    // (a richer flavour of the vnav above with per-cell topY) and one
    // UnitGrid per kind, derived from the unit's footprint width and body
    // height. A* and Theta* run on these grids — when SAB is available, the
    // expensive work (path search, incremental rebuild) is dispatched to a
    // worker that shares the same bitmaps zero-copy.
    this.pathfinder = new Pathfinder(useShared);
    this.pathfinder.attach(this.world);
    const profiles = [];
    for (const kind of UNIT_KINDS) {
      const cfg = unitConfig(kind);
      const profile = profileFromUnit({
        kind,
        footprintRadius: cfg.footprintRadius,
        heightVoxels: cfg.heightVoxels,
        canDig: cfg.canDig,
        requiresGround: cfg.requiresGround,
        maxStepVoxels: cfg.maxStepVoxels,
        slopePenalty: cfg.slopePenalty,
      });
      this.pathfinder.registerProfile(profile, useShared);
      profiles.push(profile);
    }
    this.pathWorker = new PathWorkerClient(
      this.pathfinder,
      this.world.buffers.voxels,
      profiles,
      useShared,
    );
    await this.pathWorker.ready();
    this.spawnInitialUnits();
  }

  private spawnInitialUnits(): void {
    if (!this.pathfinder) return;
    const nav = this.surfaceNav!;
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
    this.spawnUnit('soldier', c.x, c.y, c.z);
    this.spawnUnit('tank', c.x + 3.0, c.y, c.z);
    this.spawnUnit('tunneler', c.x - 2.0, c.y, c.z);
    this.spawnUnit('worm', c.x + 0.5, c.y, c.z + 4.0);
    this.spawnUnit('dozer', c.x + 5.0, c.y, c.z + 1.5);
    // Vehicle rocket platforms — one cluster, one heavy. The cluster_pod is
    // the rocket_truck default; the heavy platform spawns with the
    // single-warhead rocket_pod weapon override.
    this.spawnUnit('rocket_truck', c.x + 7.0, c.y, c.z + 2.0);
    this.units.spawn('rocket_truck', c.x + 8.5, c.y, c.z + 2.0, { weapon: 'rocket_pod' });
    // Soldier loadouts — one of each archetype so the player can RMB-fire
    // any weapon without chasing the build menu first.
    this.units.spawn('soldier', c.x + 1.5, c.y, c.z - 2.0, { weapon: 'sniper' });
    this.units.spawn('soldier', c.x - 1.5, c.y, c.z - 2.0, { weapon: 'machine_gun' });
    this.units.spawn('soldier', c.x + 0.0, c.y, c.z - 3.0, { weapon: 'rpg_launcher' });
    this.units.spawn('soldier', c.x + 2.5, c.y, c.z - 3.0, { weapon: 'pistol' });
    // Three workers so the player sees the economy loop running from the
    // first frame. They auto-pick targets via tickWorkers — the player can
    // still override with click commands.
    this.spawnWorker(c.x - 4.0, c.y, c.z + 1.0);
    this.spawnWorker(c.x - 4.5, c.y, c.z - 1.0);
    this.spawnWorker(c.x - 3.0, c.y, c.z + 2.5);

    // Place a starter Storage depot near spawn so workers always have a
    // delivery target. We try a handful of candidate footprints around the
    // central flat cell; first valid wins. If none is valid (very rare on a
    // generated world) we just skip — the player can build one manually.
    const startCx = found.cx;
    const startCz = found.cz;
    const offsets: [number, number][] = [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, -4]];
    for (const [dx, dz] of offsets) {
      const ox = Math.max(0, Math.min(NAV_W - STORAGE.cellsW, startCx + dx - (STORAGE.cellsW >> 1)));
      const oz = Math.max(0, Math.min(NAV_H - STORAGE.cellsD, startCz + dz - (STORAGE.cellsD >> 1)));
      const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, STORAGE, ox, oz);
      if (fp.ok) {
        this.buildings.place(this.world, STORAGE, ox, oz, fp.floorY);
        const pad = NAV_CELL_METERS;
        const bx0 = ox * NAV_CELL_METERS;
        const bz0 = oz * NAV_CELL_METERS;
        const bx1 = (ox + STORAGE.cellsW) * NAV_CELL_METERS;
        const bz1 = (oz + STORAGE.cellsD) * NAV_CELL_METERS;
        const by0 = fp.floorY * VOXEL_SIZE;
        const by1 = (fp.floorY + STORAGE.headroomVoxels + 4) * VOXEL_SIZE;
        this.requestNavRebuildAround(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad, false);
        break;
      }
    }
    this.camera.target.set(c.x, 0, c.z);
  }

  private spawnUnit(kind: UnitKind, x: number, y: number, z: number): Unit | null {
    return this.units.spawn(kind, x, y, z);
  }

  private spawnWorker(x: number, y: number, z: number): Unit | null {
    return this.units.spawn('worker', x, y, z);
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

    // RMB is overloaded: with a weapon-bearing unit selected it's the
    // fire-aim gesture; with a tunneler/worm selected it's the dig-aim
    // gesture (hold to aim, vertical drag = target altitude, release to
    // commit the dig command). In every other case it falls through to
    // the camera yaw drag.
    const fireAimActive = this.isFireAimActive();
    const digAimActive = !fireAimActive && this.isDigAimActive();
    const rmbConsumed = fireAimActive || digAimActive;
    this.camera.update({
      keys: this.input.keys,
      mouseX: this.input.mouseX, mouseY: this.input.mouseY,
      rmbDown: rmbConsumed ? false : this.input.rmbDown,
      rmbDx: rmbConsumed ? 0 : this.input.rmbDx,
      rmbDy: rmbConsumed ? 0 : this.input.rmbDy,
      wheel: this.input.wheel,
      width: w, height: h,
    }, dt);

    // Build-mode cycle: Play → Barracks → Farm → Storage → Play. Each press
    // of 'B' advances one step. 'P' toggles plant mode (only meaningful with
    // a worker selected; the click handler enforces that).
    if (this.input.pressed.has('KeyB')) {
      if (this.mode !== 'build') {
        this.mode = 'build';
        this.buildSpec = ALL_BUILDINGS[0]!;
        this.ghost.setSpec(this.buildSpec);
      } else {
        const idx = ALL_BUILDINGS.indexOf(this.buildSpec);
        const next = idx + 1;
        if (next >= ALL_BUILDINGS.length) {
          this.mode = 'play';
          this.ghost.hide();
        } else {
          this.buildSpec = ALL_BUILDINGS[next]!;
          this.ghost.setSpec(this.buildSpec);
        }
      }
    }
    if (this.input.pressed.has('KeyP')) {
      this.mode = this.mode === 'plant' ? 'play' : 'plant';
      this.ghost.hide();
    }
    // Sandbox / map-editor terrain edit mode. Toggled with G; while active,
    // LMB paints a sphere of the active material and shift-LMB carves one
    // out. Material is cycled via the digit keys (overriding the build-mode
    // cycle for as long as terrain mode is on); brush radius is adjusted
    // with comma / period.
    if (this.input.pressed.has('KeyG')) {
      this.mode = this.mode === 'terrain' ? 'play' : 'terrain';
      this.ghost.hide();
    }
    if (this.input.pressed.has('Escape') && this.mode !== 'play') {
      this.mode = 'play';
      this.ghost.hide();
    }
    if (this.mode === 'terrain') {
      // In terrain mode the digit row picks a palette material instead of
      // entering build mode. Bracket / period keys nudge the brush radius.
      for (let i = 0; i < TERRAIN_PALETTE.length; i++) {
        const code = `Digit${i + 1}`;
        if (this.input.pressed.has(code)) this.terrainPaletteIdx = i;
      }
      if (this.input.pressed.has('Comma'))  this.terrainBrushRadius = Math.max(TERRAIN_BRUSH_MIN, this.terrainBrushRadius - 1);
      if (this.input.pressed.has('Period')) this.terrainBrushRadius = Math.min(TERRAIN_BRUSH_MAX, this.terrainBrushRadius + 1);
    } else {
      // Cycle building spec via Digit1..Digit{ALL_BUILDINGS.length}. Works in either
      // mode — pressing a digit also enters build mode so the user doesn't have to
      // hit B first.
      for (let i = 0; i < ALL_BUILDINGS.length; i++) {
        const code = `Digit${i + 1}`;
        if (this.input.pressed.has(code)) {
          this.buildSpec = ALL_BUILDINGS[i]!;
          this.ghost.setSpec(this.buildSpec);
          this.mode = 'build';
        }
      }
    }
    if (this.input.pressed.has('Tab')) this.cycleSelection();

    // Y-axis cutoff overlay. `[` lowers the cutoff (showing more underground),
    // `]` raises it. `\` resets to disabled. Holding shift quadruples the step
    // so the player can sweep through several layers quickly.
    if (this.input.pressed.has('BracketLeft') || this.input.pressed.has('BracketRight') || this.input.pressed.has('Backslash')) {
      this.adjustHideAboveY();
    }

    // Per-selection action keybinds (e.g. Q on a barracks queues a soldier;
    // H on selected units stops them). Runs after the global hotkeys (B/P/
    // Esc/digit cycle) so their bindings always win for the global mode.
    this.dispatchActionKeys();

    // Sandbox helper: 'E' spawns an enemy unit at the cursor's terrain xz.
    //   E             → enemy soldier (rifle)
    //   Shift+E       → enemy tank (cannon)
    //   Alt+E         → enemy rocket truck (cluster pod)
    //   Shift+Alt+E   → enemy rocket truck (heavy rocket pod)
    //   Ctrl+E        → enemy RPG soldier (rpg_launcher)
    // Used to test friendly-fire gating + selection rules without needing an
    // AI opponent. The new unit appears immediately at the picked surface
    // voxel and idles in place.
    if (this.input.pressed.has('KeyE')) {
      const shift = this.input.keys.has('ShiftLeft') || this.input.keys.has('ShiftRight');
      const alt = this.input.keys.has('AltLeft') || this.input.keys.has('AltRight');
      const ctrl = this.input.keys.has('ControlLeft') || this.input.keys.has('ControlRight');
      this.spawnEnemyAtCursor(w, h, shift, alt, ctrl);
    }

    if (isBuildMode(this.mode)) {
      this.updateGhost(w, h);
    }

    // LMB hold → preview marker at the cursor; release → fire actual command.
    this.updateLmbPreview(w, h);
    this.updateSelectionBox();
    if (this.input.release) {
      this.handleRelease(this.input.release, w, h);
    }

    // Fire-aim preview: if the player is currently holding RMB with a
    // weapon-bearing unit selected, draw the predicted trajectory + impact
    // marker. Released aim becomes a `firingTarget` on the unit, which the
    // weapon-tick consumes (slewing turret/hull and firing once aligned).
    this.updateFireAim(w, h);
    // Dig-aim preview: with a tunneler/worm selected, RMB hold draws a
    // surface→target marker (vertical drag adjusts target Y), and release
    // commits the dig as a normal volume-nav route command.
    this.updateDigAim(w, h);
    if (this.input.rmbRelease) {
      // Dispatch by selection — at release time `rmbHold` has already been
      // cleared, so we can't rely on the aim-active flags computed earlier.
      const sel = this.units.units.find(u => u.selected);
      if (sel && sel.canDig && sel.weapon === null) {
        this.handleDigRelease(this.input.rmbRelease, w, h);
      } else {
        this.handleFireRelease(this.input.rmbRelease, w, h);
      }
    }

    if (this.pathfinder) {
      this.units.tick(dt, this.surfaceNav!, this.vnav!, this.world.buffers.voxels, (req) => this.handleWorldEdit(req));
      // Any unit that latched needsRepath this frame (because it has been
      // collision-stuck long enough) gets a fresh route around the offending peer.
      this.servicePendingRepaths();
      this.buildings.tick(dt, this.world, this.units);
      this.paintTankTracks();
      // Aggressive-stance auto-engage: armed units in 'aggressive' mode pick
      // their own target and reposition when the trajectory is blocked.
      // Runs before tickWeapons so any new firingTarget assignments slew the
      // turret this same frame.
      this.tickAggressiveStance(dt);
      // Evasion pass: any unit with an inbound enemy round about to land near
      // it side-steps perpendicular to the projectile direction. Runs after
      // aggressive stance so the new target lock survives the dodge — we
      // don't re-route units that already have a firingTarget.
      this.tickEvade(dt);
      // Weapon firing pipeline. Slews turret/hull toward each unit's
      // firingTarget, fires when aligned, drops projectiles into the
      // ProjectileManager, and emits muzzle flashes for the renderer.
      tickWeapons(dt, this.units, this.projectiles, {
        onMuzzleFlash: (x, y, z, radius, life, color) => {
          this.muzzleFlashes.spawn(x, y, z, radius, life, color.r, color.g, color.b);
        },
      });
      // Projectile physics + collision detection. Pending impacts drain into
      // the world-edit machinery (damage spheres, debris bursts, impact rings)
      // immediately so a hit is felt the same frame the projectile lands.
      // The unit-hit callback lets the projectile manager intercept rounds
      // that strike a unit's body sphere, so bullets fired at a soldier in
      // the open actually deal damage instead of expiring uselessly past them.
      this.projectiles.tick(dt, this.world, (fx, fy, fz, dx, dy, dz, maxDist, ownerId) => {
        return this.unitRayHit(fx, fy, fz, dx, dy, dz, maxDist, ownerId);
      });
      for (const imp of this.projectiles.pendingImpacts) {
        this.handleProjectileImpact(imp);
      }
      // Sweep out anything that died from the impacts processed this frame.
      this.removeDeadUnits();
      // Worker automation: drive harvesters / transporters. Routing is
      // delegated back to routePath via the routeWorker callback so the
      // existing path client is reused unchanged.
      tickWorkers(dt, {
        units: this.units,
        world: this.world,
        buildings: this.buildings,
        saplings: this.saplings,
        resources: this.resources,
        taskBoard: this.taskBoard,
        routeWorker: (u, wx, wy, wz): void => { void this.routePath(u, wx, wy, wz); },
        onVoxelEdit: (wx: number, wy: number, wz: number): void => {
          // Use incremental rebuild around the edited voxel rather than a
          // full world rescan — a single mine event only affects a small region.
          const r = 2;
          this.requestNavRebuildAround(wx - r, wy - r, wz - r, wx + r, wy + r, wz + r, false);
        },
        findMetalCluster: (vx, vy, vz) => this.findMetalCluster(vx, vy, vz),
        onClusterVoxelChipped: (c, wx, wz) => this.onClusterVoxelChipped(c, wx, wz),
        tryClaimClusterSlot: (c, uid) => this.tryClaimClusterSlot(c, uid),
        releaseClusterSlot: (cid, uid) => this.releaseClusterSlot(cid, uid),
        clusterSlotPos: (c, si) => this.clusterSlotPos(c, si),
        findAlternateClusterTarget: (excl, fx, fz) => this.findAlternateClusterTarget(excl, fx, fz),
      });
      const grow = this.saplings.tick(dt, this.world);
      if (grow.matured > 0) this.requestNavRebuild(false);
      // Drain the per-tick accumulated nav-rebuild AABB: one sync main-thread
      // refresh + one applyDamage to the worker, regardless of how many
      // impacts / tracks triggered requestNavRebuildAround this frame.
      this.flushNavRebuild();
    }
    this.unitRenderer.update(this.units);
    this.healthBars.update(this.units.units, this.buildings.buildings, this.metalClusters);
    this.rallyMarkers.update(this.buildings.buildings);
    this.buildingRenderer.update(this.buildings.buildings);
    this.buildingRange.show(this.buildings.getSelected());
    this.unitRange.show(this.units.units);
    this.projectileRenderer.update(this.projectiles);
    this.updateProjectileArcs();
    this.muzzleFlashes.update(dt);
    this.impactFlashes.update(dt);
    this.impactRings.update(dt);

    // Dashed path preview for the first selected unit (if any).
    const sel = this.units.units.find(u => u.selected);
    if (sel && sel.path.length > 0) {
      this.pathPreview.update({ x: sel.x, y: sel.y, z: sel.z }, sel.path);
    } else {
      this.pathPreview.update(null, []);
    }

    // Blue pending-route indicators for all in-flight path requests.
    if (this.pendingPathRequests.size > 0) {
      this.pendingPathPreview.update(Array.from(this.pendingPathRequests.values()));
    } else {
      this.pendingPathPreview.update([]);
    }

    // Pulsing wireframe boxes: yellow = nav rebuild, cyan = chunk remesh.
    {
      const t = performance.now() / 1000;
      const boxes: ProcessBox[] = [];
      for (const b of this.navRebuildRegions.values()) boxes.push(b);
      for (const key of this.meshes.getInflightChunks()) boxes.push(ProcessingBoxOverlay.chunkToBox(key));
      this.processingBoxOverlay.update(boxes, t);
    }
    this.debris.update(dt);
    this.meshes.pump(8);

    this.renderer.render(this.camera.cam);

    this.fpsAcc += dt;
    this.fpsCount += 1;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5 && this.fpsEl) {
      const fps = this.fpsCount / this.fpsAcc;
      const r = this.resources;
      this.fpsEl.textContent = `FPS ${fps.toFixed(0)} | meshed ${this.meshes.getMeshCount()} | inflight ${this.meshes.getInflight()} | units ${this.units.units.length} | buildings ${this.buildings.buildings.length} | wood ${r.wood} metals ${r.metals} food ${r.food}`;
      this.fpsAcc = 0; this.fpsCount = 0; this.fpsTimer = 0;
    }
    if (this.modeEl) {
      const selected = this.units.units.filter(u => u.selected);
      const sel = selected[0];
      const selDesc = !sel
        ? 'none'
        : selected.length > 1
          ? `${selected.length} units (lead: ${sel.kind} #${sel.id})`
          : `${sel.kind} #${sel.id}`;
      const weaponDesc = sel && selected.length === 1 && sel.weapon !== null
        ? ` weapon: ${WEAPONS[sel.weapon].label} (RMB to fire, drag Y for altitude)`
        : sel && selected.length === 1 && sel.canDig
          ? ' (LMB digs toward click, RMB hold + drag Y to set depth)'
          : '';
      const buildDesc = this.mode === 'build'
        ? `MODE: BUILD ${this.buildSpec.label} (LMB place, B/1-${ALL_BUILDINGS.length} cycle, Esc cancel)`
        : this.mode === 'plant'
          ? 'MODE: PLANT SAPLING (LMB on grass, P cancel)'
          : this.mode === 'terrain'
            ? `MODE: TERRAIN EDIT — ${TERRAIN_PALETTE[this.terrainPaletteIdx]!.label} r=${this.terrainBrushRadius} (LMB paint, shift+LMB carve, 1-${TERRAIN_PALETTE.length} material, ,/. brush, G/Esc exit)`
            : 'MODE: PLAY';
      this.modeEl.textContent = `${buildDesc} | selected: ${selDesc}${weaponDesc}`;
    }
    this.renderActionPanel();
    this.renderTaskPanel();
    this.renderPathInfo();
  }

  /**
   * Sandbox helper: spawn an enemy unit at the surface voxel under the
   * cursor. Modifier keys select the unit type:
   *   (none)        → soldier (rifle)
   *   Shift         → tank (cannon)
   *   Alt           → rocket truck (cluster pod)
   *   Shift+Alt     → rocket truck (heavy rocket pod)
   *   Ctrl          → RPG soldier (rpg_launcher) — anti-armour infantry
   * All enemies start in aggressive stance so they auto-fire at player units.
   */
  private spawnEnemyAtCursor(w: number, h: number, shift: boolean, alt: boolean, ctrl: boolean): void {
    if (this.input.mouseX < 0) return;
    const r = this.resolveTarget(this.input.mouseX, this.input.mouseY, w, h, 0);
    if (!r) return;
    if (ctrl) {
      this.units.spawn('soldier', r.surface.x, r.surface.y, r.surface.z, {
        team: 'enemy', stance: 'aggressive', weapon: 'rpg_launcher',
      });
      return;
    }
    if (alt) {
      const weapon: WeaponKind = shift ? 'rocket_pod' : 'cluster_pod';
      this.units.spawn('rocket_truck', r.surface.x, r.surface.y, r.surface.z, {
        team: 'enemy', stance: 'aggressive', weapon,
      });
      return;
    }
    const kind: UnitKind = shift ? 'tank' : 'soldier';
    this.units.spawn(kind, r.surface.x, r.surface.y, r.surface.z, {
      team: 'enemy', stance: 'aggressive',
    });
  }

  /**
   * Pick the building under the cursor by ray-casting voxels and matching the
   * hit voxel's XZ to a building footprint. Returns null when the ray misses
   * geometry or lands outside any live building.
   */
  private pickBuildingAt(px: number, py: number, w: number, h: number): Building | null {
    const { origin, dir } = this.rayFromScreen(px, py, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 200, this.raycastMaxVoxelY());
    if (!hit) return null;
    for (const b of this.buildings.buildings) {
      if (b.destroyed) continue;
      const wxStart = b.ox * NAV_CELL_VOXELS;
      const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS;
      const wzStart = b.oz * NAV_CELL_VOXELS;
      const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS;
      if (hit.x >= wxStart && hit.x < wxEnd && hit.z >= wzStart && hit.z < wzEnd) {
        return b;
      }
    }
    return null;
  }

  private cycleSelection(): void {
    const arr = this.units.units;
    if (arr.length === 0) return;
    const idx = arr.findIndex(u => u.selected);
    arr.forEach(u => u.selected = false);
    const next = (idx + 1) % arr.length;
    arr[next]!.selected = true;
    this.buildings.deselectAll();
  }

  private rayFromScreen(px: number, py: number, w: number, h: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const ndc = new THREE.Vector2((px / w) * 2 - 1, -((py / h) * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera.cam);
    return { origin: ray.ray.origin.clone(), dir: ray.ray.direction.clone() };
  }

  private updateGhost(w: number, h: number): void {
    if (!this.pathfinder) return;
    const spec = this.activeBuildSpec();
    if (!spec) { this.ghost.hide(); return; }
    if (this.input.mouseX < 0) { this.ghost.hide(); return; }
    const { origin, dir } = this.rayFromScreen(this.input.mouseX, this.input.mouseY, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 200, this.raycastMaxVoxelY());
    if (!hit) { this.ghost.hide(); return; }
    const wx = hit.x * VOXEL_SIZE;
    const wz = hit.z * VOXEL_SIZE;
    const cell = this.surfaceCellAt(wx, wz);
    const ox = Math.max(0, Math.min(NAV_W - spec.cellsW, cell.cx - (spec.cellsW >> 1)));
    const oz = Math.max(0, Math.min(NAV_H - spec.cellsD, cell.cz - (spec.cellsD >> 1)));
    const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, spec, ox, oz);
    this.ghost.place(ox, oz, fp.floorY >= 0 ? fp.floorY : hit.y, fp.ok);
  }

  /** The BuildingSpec that matches the current build-mode (or null in non-build modes). */
  private activeBuildSpec(): BuildingSpec | null {
    return this.mode === 'build' ? this.buildSpec : null;
  }

  /**
   * Compute the world-space target for the currently-selected unit given the cursor at
   * (px, py) and an optional vertical drag in pixels (positive = drag down = go deeper).
   * Returns null when the ray misses geometry.
   */
  private resolveTarget(
    px: number, py: number, w: number, h: number,
    verticalDragPx: number,
    baseY?: number,
    pitchCapRad?: number,
    pitchOriginXZ?: { x: number; z: number },
  ): {
    surface: THREE.Vector3;
    target: THREE.Vector3;
    voxelXYZ: { x: number; y: number; z: number; nx: number; ny: number; nz: number };
  } | null {
    const { origin, dir } = this.rayFromScreen(px, py, w, h);
    const hit = raycastVoxel(this.world, origin, dir, 400, this.raycastMaxVoxelY());
    if (!hit) return null;
    const wx = (hit.x + 0.5) * VOXEL_SIZE;
    // When the click resolves to the top face of a solid voxel (the common
    // "click on the ground" case), report the click as being one voxel
    // ABOVE that voxel — i.e. on the standing surface — so worldToVolumeCell
    // lands in the air cell where the unit will actually stand instead of
    // inside the floor voxel itself. Without this, an LMB click on a tunnel
    // floor through the Y-cutoff overlay would resolve into a solid volume
    // cell and the volume A* would refuse the goal.
    const wy = hit.ny > 0 ? (hit.y + 1.0) * VOXEL_SIZE + 1e-3 : (hit.y + 0.5) * VOXEL_SIZE;
    const wz = (hit.z + 0.5) * VOXEL_SIZE;
    const dragMeters = verticalDragPx / this.altitudeDragSensitivity; // down = +meters depth
    // Default base height is the click's voxel y. Callers pass `baseY` to override —
    // tunnelers use their CURRENT y so vertical drag adjusts depth relative to where
    // they already are, not relative to whatever the cursor happens to be over.
    const base = baseY !== undefined ? baseY : wy;
    let targetY = Math.max(0.5, base - dragMeters);
    // If a pitch cap is supplied, clamp targetY so the line from the unit's xz to
    // the click xz stays within ±tan(pitchCapRad). Lets the tunneler dig down even
    // when the user drags past the steepest physically allowed angle — they get
    // the steepest legal slope instead of nothing.
    if (pitchCapRad !== undefined && pitchCapRad < Math.PI / 2 && pitchOriginXZ) {
      const horiz = Math.hypot(wx - pitchOriginXZ.x, wz - pitchOriginXZ.z);
      const maxDeltaY = horiz * Math.tan(pitchCapRad);
      const baseRef = baseY !== undefined ? baseY : wy;
      const minY = baseRef - maxDeltaY;
      const maxY = baseRef + maxDeltaY;
      if (targetY < minY) targetY = minY;
      if (targetY > maxY) targetY = maxY;
      if (targetY < 0.5) targetY = 0.5;
    }
    const target = new THREE.Vector3(wx, targetY, wz);
    return {
      surface: new THREE.Vector3(wx, wy, wz),
      target,
      voxelXYZ: { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz },
    };
  }

  private updateLmbPreview(w: number, h: number): void {
    const hold = this.input.hold;
    if (!hold || isBuildMode(this.mode) || this.mode === 'plant' || this.mode === 'terrain' || hold.shift) {
      this.target.hide();
      return;
    }
    // While dragging the box-select rectangle, suppress the move-target marker.
    if (this.isDragging(hold.startX, hold.startY, hold.currentX, hold.currentY)) {
      this.target.hide();
      return;
    }
    const selected = this.units.units.find(u => u.selected);
    if (!selected) { this.target.hide(); return; }
    const r = this.resolveTarget(hold.startX, hold.startY, w, h, 0);
    if (!r) { this.target.hide(); return; }
    this.target.show(r.surface, r.target);
  }

  /** True when the cursor has moved past the click/drag threshold from its press point. */
  private isDragging(sx: number, sy: number, cx: number, cy: number): boolean {
    const dx = cx - sx, dy = cy - sy;
    return dx * dx + dy * dy > this.dragThresholdPx2;
  }

  /**
   * Show / hide / size the screen-space box-select rectangle while LMB is
   * held. Only visible in play mode when the cursor has moved past the
   * drag threshold; build / plant mode keep their own placement preview.
   */
  private updateSelectionBox(): void {
    if (!this.selBoxEl) return;
    const hold = this.input.hold;
    if (!hold || this.mode !== 'play') {
      this.selBoxEl.style.display = 'none';
      return;
    }
    if (!this.isDragging(hold.startX, hold.startY, hold.currentX, hold.currentY)) {
      this.selBoxEl.style.display = 'none';
      return;
    }
    const x0 = Math.min(hold.startX, hold.currentX);
    const y0 = Math.min(hold.startY, hold.currentY);
    const x1 = Math.max(hold.startX, hold.currentX);
    const y1 = Math.max(hold.startY, hold.currentY);
    this.selBoxEl.style.display = 'block';
    this.selBoxEl.style.left = `${x0}px`;
    this.selBoxEl.style.top = `${y0}px`;
    this.selBoxEl.style.width = `${x1 - x0}px`;
    this.selBoxEl.style.height = `${y1 - y0}px`;
  }

  /**
   * Pick the unit nearest the cursor along the camera ray. Returns null when
   * no unit's bounding sphere is hit. Only player-team units are clickable —
   * enemy units render but can't be selected (they're commanded by no one).
   */
  private pickUnitAt(px: number, py: number, w: number, h: number): Unit | null {
    const { origin, dir } = this.rayFromScreen(px, py, w, h);
    let bestT = Infinity;
    let best: Unit | null = null;
    for (const u of this.units.units) {
      if (u.hp <= 0) continue;
      if (u.team !== 'player') continue;
      const radius = u.widthMeters * 0.55 + 0.35;
      const cx = u.x;
      const cy = u.y + Math.max(0.7, u.widthMeters * 0.6);
      const cz = u.z;
      const ox = origin.x - cx, oy = origin.y - cy, oz = origin.z - cz;
      const b = ox * dir.x + oy * dir.y + oz * dir.z;
      const cTerm = ox * ox + oy * oy + oz * oz - radius * radius;
      const disc = b * b - cTerm;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = -b - sq;
      if (t < 0) t = -b + sq;
      if (t < 0 || t > 400) continue;
      if (t < bestT) { bestT = t; best = u; }
    }
    return best;
  }

  /**
   * Project every unit's world position to screen pixels and select those
   * whose projected point lies inside the rectangle defined by the two
   * cursor positions. With `additive`, existing selection is preserved and
   * units in the box are added; without it, the existing selection is
   * replaced.
   *
   * "Military prefer" rule: if the box contains any armed unit (soldier,
   * tank, rocket truck — anything with a weapon), only those armed units are
   * selected. Workers / earthmovers / diggers are dropped from the resulting
   * selection so a player who drag-selects across a mixed clump picks a pure
   * combat group instead of accidentally pulling support units into a fight.
   * Boxes that contain only support units still select all of them.
   *
   * Enemy-team units never enter the selection regardless of the box.
   */
  private boxSelect(sx: number, sy: number, ex: number, ey: number, w: number, h: number, additive: boolean): void {
    const x0 = Math.min(sx, ex), x1 = Math.max(sx, ex);
    const y0 = Math.min(sy, ey), y1 = Math.max(sy, ey);
    const v = new THREE.Vector3();
    const inBox: Unit[] = [];
    for (const u of this.units.units) {
      if (u.hp <= 0) continue;
      if (u.team !== 'player') continue;
      v.set(u.x, u.y + Math.max(0.5, u.widthMeters * 0.5), u.z);
      v.project(this.camera.cam);
      // project() returns NDC (−1..+1) in x/y and a z that is < −1 / > +1
      // when behind / past the camera. Skip those so back-facing units
      // don't accidentally land in the box.
      if (v.z < -1 || v.z > 1) continue;
      const px = (v.x * 0.5 + 0.5) * w;
      const py = (-v.y * 0.5 + 0.5) * h;
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) inBox.push(u);
    }
    const hasArmed = inBox.some(u => u.weapon !== null);
    const finalSel = hasArmed ? inBox.filter(u => u.weapon !== null) : inBox;
    if (!additive) for (const u of this.units.units) u.selected = false;
    for (const u of finalSel) u.selected = true;
    if (finalSel.length > 0) this.buildings.deselectAll();
  }

  /**
   * Build a deterministic grid of formation slots centered on (cx, cz). One
   * slot per selected unit. Layout is a roughly-square grid with the unit
   * that is currently nearest the destination assigned the centre; remaining
   * slots fan outward by row. Slot spacing is set from the largest selected
   * unit's footprint so vehicles don't try to share the same nav cell.
   */
  private formationSlots(units: Unit[], cx: number, cz: number): { unit: Unit; x: number; z: number }[] {
    const n = units.length;
    if (n === 0) return [];
    if (n === 1) return [{ unit: units[0]!, x: cx, z: cz }];
    let maxWidth = 0;
    for (const u of units) maxWidth = Math.max(maxWidth, u.widthMeters);
    const spacing = Math.max(1.6, maxWidth + 0.8);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    // Forward direction = from the formation centroid TO the destination, so
    // the front row faces the destination and the rest line up behind.
    let avgX = 0, avgZ = 0;
    for (const u of units) { avgX += u.x; avgZ += u.z; }
    avgX /= n; avgZ /= n;
    let fx = cx - avgX, fz = cz - avgZ;
    const fl = Math.hypot(fx, fz);
    if (fl < 1e-3) { fx = 0; fz = 1; } else { fx /= fl; fz /= fl; }
    const rx = -fz, rz = fx; // right perpendicular
    const slots: { x: number; z: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (slots.length >= n) break;
        const colOff = c - (cols - 1) * 0.5;
        const rowOff = r - (rows - 1) * 0.5;
        slots.push({
          x: cx + rx * colOff * spacing - fx * rowOff * spacing,
          z: cz + rz * colOff * spacing - fz * rowOff * spacing,
        });
      }
    }
    // Greedy assignment: for each slot (closest-to-destination first), pick the
    // unselected unit with the smallest distance to it. Keeps the formation
    // tight without anyone walking across the whole pack.
    slots.sort((a, b) => {
      const da = (a.x - cx) ** 2 + (a.z - cz) ** 2;
      const db = (b.x - cx) ** 2 + (b.z - cz) ** 2;
      return da - db;
    });
    const remaining = units.slice();
    const out: { unit: Unit; x: number; z: number }[] = [];
    for (const s of slots) {
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const u = remaining[i]!;
        const d = (u.x - s.x) ** 2 + (u.z - s.z) ** 2;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI < 0) break;
      const u = remaining.splice(bestI, 1)[0]!;
      out.push({ unit: u, x: s.x, z: s.z });
    }
    return out;
  }

  private handleRelease(release: { startX: number; startY: number; endX: number; endY: number; shift: boolean }, w: number, h: number): void {
    this.target.hide();
    const dragged = this.isDragging(release.startX, release.startY, release.endX, release.endY);

    if (isBuildMode(this.mode)) {
      // Drag in build mode is meaningless — only the release-point cell matters.
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (r) this.tryPlaceBuilding(r.voxelXYZ);
      return;
    }

    if (this.mode === 'terrain') {
      // Sandbox / map-editor: LMB paints a sphere of the active material at
      // the clicked voxel, shift-LMB carves voxels out instead. Drag is
      // ignored — only the release point matters; the player can hold the
      // gesture and click again to extend a stroke.
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (r) this.applyTerrainEdit(r.voxelXYZ, release.shift);
      return;
    }

    // Box-select on drag (play mode only). Shift makes it additive.
    if (dragged && this.mode === 'play') {
      this.boxSelect(release.startX, release.startY, release.endX, release.endY, w, h, release.shift);
      return;
    }

    // Shift + click (no drag) preserves the legacy detonate gesture so the
    // player can still blow up terrain with shift-LMB.
    if (release.shift && this.mode === 'play') {
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (r) this.detonateAt(r.voxelXYZ);
      return;
    }

    if (this.mode === 'plant') {
      // Plant mode: a worker needs to be selected, but the actual assignment
      // runs through the global task board so the same plant order survives
      // if the chosen worker dies / is reassigned. Any free worker will
      // pick it up next tick.
      const selected = this.units.units.find(u => u.selected);
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (!r || !selected || selected.kind !== 'worker') return;
      const wx = r.target.x, wz = r.target.z;
      this.taskBoard.addPlant(wx, wz);
      return;
    }

    if (this.mode === 'waypoint') {
      const b = this.buildings.getSelected();
      const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
      if (b && r) {
        b.rallyPoint = { x: r.target.x, y: r.target.y, z: r.target.z };
        b.rallyStance = this.pendingWaypointStance;
      }
      this.mode = 'play';
      return;
    }

    // Click in play mode. First check if the cursor landed on a unit — a
    // hit selects that unit (replacing the current selection unless shift
    // is held, in which case it toggles).
    const picked = this.pickUnitAt(release.startX, release.startY, w, h);
    if (picked) {
      if (release.shift) {
        picked.selected = !picked.selected;
      } else {
        for (const u of this.units.units) u.selected = false;
        picked.selected = true;
      }
      this.buildings.deselectAll();
      return;
    }

    // Next, check if the cursor landed on a building — selecting a
    // building lets the player issue per-building actions (e.g. queue a
    // training run) and clears any unit selection.
    const pickedBuilding = this.pickBuildingAt(release.startX, release.startY, w, h);
    if (pickedBuilding) {
      this.buildings.deselectAll();
      pickedBuilding.selected = true;
      for (const u of this.units.units) u.selected = false;
      return;
    }

    // Click on terrain → command the current selection to move. Solo
    // selection keeps the per-unit task / earth-mover wiring; multi
    // selection issues a formation move and skips per-unit task pickers.
    // LMB never carries a vertical-drag dig altitude — that gesture lives
    // on RMB now (see handleDigRelease). Tunnelers/worms commanded via LMB
    // dig straight toward the click; they never surface-walk.
    const selected = this.units.units.filter(u => u.selected);
    if (selected.length === 0) {
      // Bare-terrain click with no units selected → drop any building
      // selection so the action panel goes away.
      this.buildings.deselectAll();
      return;
    }
    const lead = selected[0]!;
    const r = this.resolveTarget(release.startX, release.startY, w, h, 0);
    if (!r) return;

    if (selected.length === 1) {
      this.commandSingle(lead, r);
      return;
    }
    const workers = selected.filter(u => u.kind === 'worker');
    if (workers.length > 0 && this.tryCommandWorkersOnTarget(workers, r)) {
      const nonWorkers = selected.filter(u => u.kind !== 'worker');
      if (nonWorkers.length > 0) this.commandFormation(nonWorkers, r.target.x, r.target.z);
      return;
    }
    this.commandFormation(selected, r.target.x, r.target.z);
  }

  /**
   * Single-unit command path — preserves the per-kind tasking we already had:
   * workers chop / mine specific voxels; dozers latch their level Y.
   */
  private commandSingle(
    selected: Unit,
    r: { surface: THREE.Vector3; target: THREE.Vector3; voxelXYZ: { x: number; y: number; z: number; nx: number; ny: number; nz: number } },
    forceSurface = false,
  ): void {
    if (selected.kind === 'worker') {
      if (this.tryCommandWorkersOnTarget([selected], r)) return;
      selected.task = { kind: 'idle' };
    }
    if (selected.kind === 'dozer') {
      selected.levelTargetY = r.voxelXYZ.y;
    }
    void this.routePath(selected, r.target.x, r.target.y, r.target.z, { forceSurface });
  }

  /**
   * If the click landed on a resource or farm, assign matching focus + task to
   * all supplied workers and return true. Returns false when the click has no
   * worker-specific meaning (bare terrain, building wall, etc.).
   */
  private tryCommandWorkersOnTarget(
    workers: Unit[],
    r: { surface: THREE.Vector3; target: THREE.Vector3; voxelXYZ: { x: number; y: number; z: number; nx: number; ny: number; nz: number } },
  ): boolean {
    const m = this.world.get(r.voxelXYZ.x, r.voxelXYZ.y, r.voxelXYZ.z);
    if (m === M_WOOD) {
      const wx = (r.voxelXYZ.x + 0.5) * VOXEL_SIZE;
      const wy = (r.voxelXYZ.y + 0.5) * VOXEL_SIZE;
      const wz = (r.voxelXYZ.z + 0.5) * VOXEL_SIZE;
      for (const u of workers) {
        u.workerFocus = 'chop';
        u.task = { kind: 'chop', wx, wy, wz };
        const ap = approachPos(u.x, u.z, wx, wz, 3);
        void this.routePath(u, ap.x, wy, ap.z);
      }
      return true;
    }
    if (m === M_METAL) {
      const wx = (r.voxelXYZ.x + 0.5) * VOXEL_SIZE;
      const wy = (r.voxelXYZ.y + 0.5) * VOXEL_SIZE;
      const wz = (r.voxelXYZ.z + 0.5) * VOXEL_SIZE;
      for (const u of workers) {
        u.workerFocus = 'mine';
        u.task = { kind: 'mine', wx, wy, wz };
        const ap = approachPos(u.x, u.z, wx, wz, 2);
        void this.routePath(u, ap.x, wy, ap.z);
      }
      return true;
    }
    const farm = this.farmAtVoxel(r.voxelXYZ.x, r.voxelXYZ.z);
    if (farm) {
      const fcx = (farm.ox + farm.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const fcz = (farm.oz + farm.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      for (const u of workers) {
        u.workerFocus = 'farm';
        u.task = { kind: 'farm', buildingId: farm.id };
        u.path = [];
        void this.routePath(u, fcx, u.y, fcz);
      }
      return true;
    }
    return false;
  }

  private farmAtVoxel(vx: number, vz: number): Building | null {
    for (const b of this.buildings.buildings) {
      if (b.spec.kind !== 'farm' || b.destroyed) continue;
      if (vx >= b.ox * NAV_CELL_VOXELS && vx < (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS &&
          vz >= b.oz * NAV_CELL_VOXELS && vz < (b.oz + b.spec.cellsD) * NAV_CELL_VOXELS) {
        return b;
      }
    }
    return null;
  }

  /**
   * Multi-unit command path — generates a formation grid centered on the
   * click and routes each unit to its assigned slot. Earth-mover and
   * harvester per-voxel tasks are skipped (those don't compose well with
   * formations); each unit just walks to its slot.
   */
  private commandFormation(units: Unit[], cx: number, cz: number): void {
    const slots = this.formationSlots(units, cx, cz);
    for (const s of slots) {
      const u = s.unit;
      if (u.kind === 'dozer') u.levelTargetY = null;
      if (u.kind === 'worker') u.task = { kind: 'idle' };
      void this.routePath(u, s.x, u.y, s.z);
    }
  }

  private tryPlaceBuilding(hit: { x: number; z: number }): void {
    if (!this.pathfinder) return;
    const spec = this.activeBuildSpec();
    if (!spec) return;
    const wx = hit.x * VOXEL_SIZE;
    const wz = hit.z * VOXEL_SIZE;
    const cell = this.surfaceCellAt(wx, wz);
    const ox = Math.max(0, Math.min(NAV_W - spec.cellsW, cell.cx - (spec.cellsW >> 1)));
    const oz = Math.max(0, Math.min(NAV_H - spec.cellsD, cell.cz - (spec.cellsD >> 1)));
    const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, spec, ox, oz);
    if (!fp.ok) return;
    this.buildings.place(this.world, spec, ox, oz, fp.floorY);
    const pad = NAV_CELL_METERS;
    const bx0 = ox * NAV_CELL_METERS;
    const bz0 = oz * NAV_CELL_METERS;
    const bx1 = (ox + spec.cellsW) * NAV_CELL_METERS;
    const bz1 = (oz + spec.cellsD) * NAV_CELL_METERS;
    const by0 = fp.floorY * VOXEL_SIZE;
    const by1 = (fp.floorY + spec.headroomVoxels + 4) * VOXEL_SIZE;
    this.requestNavRebuildAround(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad, true);
  }

  private detonateAt(hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number }): void {
    const radiusVoxels = this.explosionRadiusBigMeters / VOXEL_SIZE;
    const cx = hit.x + 0.5 - hit.nx * 0.5;
    const cy = hit.y + 0.5 - hit.ny * 0.5;
    const cz = hit.z + 0.5 - hit.nz * 0.5;
    const result = this.world.damageSphere(cx, cy, cz, radiusVoxels, this.explosionPeak * TERRAIN_DAMAGE_GLOBAL_SCALE);
    if (result.destroyed.length > 0) {
      const sample = result.destroyed[Math.floor(result.destroyed.length / 2)]!;
      const wx = cx * VOXEL_SIZE, wy = cy * VOXEL_SIZE, wz = cz * VOXEL_SIZE;
      const burst = Math.min(160, 20 + result.destroyed.length * 2);
      this.debris.spawnBurst(wx, wy, wz, burst, sample.material);
      const r = NAV_REFRESH_HALF_EXTENT_METERS;
      this.requestNavRebuildAround(wx - r, wy - r, wz - r, wx + r, wy + r, wz + r);
    }
    // Player-triggered explosion also damages units in the blast radius, with
    // the same falloff curve we use for projectile splash. Direct projectile
    // hits still hurt more (no `hitDamage` here — this is pure explosion).
    const wx = cx * VOXEL_SIZE, wy = cy * VOXEL_SIZE, wz = cz * VOXEL_SIZE;
    const blastR = this.explosionRadiusBigMeters;
    for (const u of this.units.units) {
      const torsoY = u.y + Math.max(0.7, u.widthMeters * 0.6);
      const dxu = u.x - wx;
      const dyu = torsoY - wy;
      const dzu = u.z - wz;
      const dist = Math.hypot(dxu, dyu, dzu);
      if (dist >= blastR) continue;
      const falloff = 1 - dist / blastR;
      u.hp -= this.explosionPeak * 0.4 * falloff;
    }
    this.removeDeadUnits();
  }

  /**
   * Sandbox / map-editor terrain edit. Paints (or carves) a sphere of voxels
   * around the picked voxel. The sphere is centred slightly outside the hit
   * face when painting so a click on flat ground stacks new material on top
   * rather than burying half the brush inside the existing surface; carving
   * centres on the hit voxel itself so a click directly removes that voxel.
   * Bedrock is preserved by the underlying VoxelWorld helpers.
   */
  private applyTerrainEdit(
    hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number },
    carve: boolean,
  ): void {
    const radius = this.terrainBrushRadius;
    const offset = carve ? 0 : 0.5;
    const cx = hit.x + 0.5 + hit.nx * offset;
    const cy = hit.y + 0.5 + hit.ny * offset;
    const cz = hit.z + 0.5 + hit.nz * offset;
    const changed = carve
      ? this.world.carveSphere(cx, cy, cz, radius)
      : this.world.fillSphere(cx, cy, cz, radius, TERRAIN_PALETTE[this.terrainPaletteIdx]!.id);
    if (changed > 0) {
      const wx = cx * VOXEL_SIZE, wy = cy * VOXEL_SIZE, wz = cz * VOXEL_SIZE;
      const r = NAV_REFRESH_HALF_EXTENT_METERS;
      // Fill blocks; carve only opens. Replan when fill could invalidate paths.
      this.requestNavRebuildAround(wx - r, wy - r, wz - r, wx + r, wy + r, wz + r, !carve);
    }
  }

  /** Single dispatch for every kind of world edit a unit can request. */
  private handleWorldEdit(req: WorldEditRequest): void {
    switch (req.kind) {
      case 'carve': this.handleCarve(req); return;
      case 'level': this.handleLevel(req); return;
      case 'trample': this.handleTrample(req); return;
    }
  }

  private handleTrample(req: TrampleRequest): void {
    if (this.world.buffers.voxels[worldIndex(req.vx, req.vy, req.vz)] !== M_GRASS) return;
    const isVehicle = req.unitKind === 'tank' || req.unitKind === 'dozer'
      || req.unitKind === 'rocket_truck' || req.unitKind === 'tunneler';
    const threshold = isVehicle ? 2 : 6;
    const ci = req.vx * WORLD_Z + req.vz;
    // Emit only once per frame per cell (counter may be bumped multiple times
    // if a unit straddles a cell edge). Cap at threshold to avoid overflow.
    const next = Math.min(this.trampleCounts[ci]! + 1, threshold);
    this.trampleCounts[ci] = next;
    if (next >= threshold) {
      this.world.set(req.vx, req.vy, req.vz, M_DIRT);
      this.trampleCounts[ci] = 0;
    }
  }

  /** Tunneler asks to clear voxels at the cutter — sphere by default, oriented cylinder when axis is supplied. */
  private handleCarve(req: CarveRequest): void {
    const radiusVoxels = req.radiusMeters / VOXEL_SIZE;
    const cx = req.x / VOXEL_SIZE;
    const cy = req.y / VOXEL_SIZE;
    const cz = req.z / VOXEL_SIZE;
    const minYVoxels = req.floorMeters !== undefined
      ? req.floorMeters / VOXEL_SIZE
      : -Infinity;
    const result = req.axisX !== undefined
      ? this.world.damageOrientedCylinder(
          cx, cy, cz,
          req.axisX, req.axisY!, req.axisZ!,
          (req.halfLengthMeters ?? 0) / VOXEL_SIZE,
          radiusVoxels,
          250,
          minYVoxels,
        )
      : this.world.damageSphere(cx, cy, cz, radiusVoxels, 250);
    if (result.destroyed.length > 0) {
      const sample = result.destroyed[Math.floor(result.destroyed.length / 2)]!;
      this.debris.spawnBurst(req.x, req.y, req.z, 30, sample.material);
      // Carving only opens new space — it never blocks an existing path. Refresh nav so
      // future routes see the tunnel, but skip the replan that would yank live paths.
      const r = NAV_REFRESH_HALF_EXTENT_METERS;
      this.requestNavRebuildAround(
        req.x - r, req.y - r, req.z - r,
        req.x + r, req.y + r, req.z + r,
      );
    }
  }

  /**
   * Dozer asks to level a strip ahead of its blade. We walk every voxel column inside
   * the oriented rectangle, calling editColumnToY on each, and accumulate cut/fill
   * totals into the unit's spoil load. When the load saturates, the surplus is dropped
   * as a M_DIRT mound a few cells behind the unit.
   */
  private handleLevel(req: LevelRequest): void {
    const u = req.unit;
    // Right vector perpendicular to forward in the XZ plane.
    const rx = -req.fz, rz = req.fx;
    // Sample at half-voxel pitch so we hit every column under the rectangle.
    const SAMPLE = VOXEL_SIZE * 0.5;
    const sampledCols = new Set<number>();
    let cutTotal = 0;
    let filledTotal = 0;
    let touched = false;
    for (let a = -req.halfDepthMeters; a <= req.halfDepthMeters; a += SAMPLE) {
      for (let b = -req.halfWidthMeters; b <= req.halfWidthMeters; b += SAMPLE) {
        const wx = req.x + req.fx * a + rx * b;
        const wz = req.z + req.fz * a + rz * b;
        const vx = Math.floor(wx / VOXEL_SIZE);
        const vz = Math.floor(wz / VOXEL_SIZE);
        const key = vz * 100000 + vx;
        if (sampledCols.has(key)) continue;
        sampledCols.add(key);
        const r = this.world.editColumnToY(vx, vz, req.targetVoxY, M_DIRT);
        cutTotal += r.cut;
        filledTotal += r.filled;
        if (r.cut > 0 || r.filled > 0) touched = true;
      }
    }
    // Reconcile the unit's load: cuts add spoil, fills consume it.
    let net = u.spoilLoad + cutTotal - filledTotal;
    let overflow = 0;
    if (net > u.spoilCapacity) {
      overflow = net - u.spoilCapacity;
      net = u.spoilCapacity;
    } else if (net < 0) {
      // Filled more than we had carried — the dozer fabricated dirt out of nowhere.
      // For now we just clamp; gameplay-wise the strip still gets levelled.
      net = 0;
    }
    u.spoilLoad = net;
    if (overflow > 0) {
      // Drop the spoil ~2 m behind the unit in a small disc so it doesn't all
      // stack into a single column. Spread across a 3x3 voxel-column patch.
      const back = 2.0;
      const baseX = u.x - req.fx * back;
      const baseZ = u.z - req.fz * back;
      const perCol = Math.max(1, Math.ceil(overflow / 9));
      let remaining = overflow;
      for (let dz = -1; dz <= 1 && remaining > 0; dz++) {
        for (let dx = -1; dx <= 1 && remaining > 0; dx++) {
          const vx = Math.floor(baseX / VOXEL_SIZE) + dx;
          const vz = Math.floor(baseZ / VOXEL_SIZE) + dz;
          const place = Math.min(perCol, remaining);
          const placed = this.world.dumpColumn(vx, vz, place, M_DIRT);
          remaining -= placed;
          if (placed > 0) touched = true;
        }
      }
    }
    if (touched) {
      const r = NAV_REFRESH_HALF_EXTENT_METERS;
      this.requestNavRebuildAround(
        req.x - r, 0, req.z - r,
        req.x + r, WORLD_Y * VOXEL_SIZE, req.z + r,
      );
    }
  }

  /**
   * Re-derive every nav buffer from the current world state. The new
   * pathfinder runs synchronously, so this is a single in-place pass — no
   * worker round-trip — and the caller can immediately query a fresh path.
   *
   * `replan` triggers a route refresh on every unit currently in motion so
   * a tunnel that just opened up is consumed straight away, vs. the old
   * route still pointing through what used to be solid stone. Callers that
   * know the edit can only widen the navigable space (a digger carving
   * forward) pass `false` to skip the replan.
   *
   * Prefer `requestNavRebuildAround` when the affected world region is
   * known — a full rebuild scans 200+ M voxels and stalls the frame for a
   * single explosion's worth of damage.
   */
  private requestNavRebuild(replan = true): void {
    if (!this.pathfinder || !this.surfaceNav || !this.vnav) return;
    buildSurfaceNav(this.world.buffers.voxels, this.surfaceNav);
    buildVolumeNav(this.world.buffers.voxels, this.vnav);
    // The pathfinder's volume + every per-kind unit grid runs on the worker
    // when SAB is available. We don't await — subsequent findPath requests
    // are queued behind it on the same worker and naturally see the fresh
    // grid; main-thread sync helpers may briefly read pre-rebuild bits.
    if (this.pathWorker) void this.pathWorker.rebuildAll();
    else this.pathfinder.rebuildAll();
    if (replan) this.replanMovingUnits();
  }

  /**
   * Incremental nav refresh bounded to the world-meter AABB
   * `[minX..maxX] × [minY..maxY] × [minZ..maxZ]`. Refreshes only the surface
   * cells in the 2-D footprint, the volume cells in the 3-D box, and each
   * unit grid's matching window. Use this whenever the affected region is
   * known (explosions, projectile impacts, tank track marks, terrain edits)
   * — it's typically 100–1000× cheaper than the full rebuild.
   *
   * Defaults to `replan = false`: pure-carve edits (every voxel goes solid
   * → air) only ever open up navigable space, so existing paths stay valid.
   * Callers whose edit can *block* a path (e.g. terrain fill, building
   * placement) should pass `replan = true`.
   */
  private requestNavRebuildAround(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    replan = false,
  ): void {
    if (!this.pathfinder) return;
    // Merge into an existing pending box only when the incoming box overlaps or
    // is within NAV_MERGE_PAD metres of it.  Boxes from distant clusters (e.g.
    // workers mining at different ore sites) stay separate so we never rebuild
    // one giant AABB that spans the whole map.  `flushNavRebuild` drains the
    // list at the end of each tick.
    const pad = NAV_MERGE_PAD;
    for (const b of this.pendingNavBoxes) {
      if (minX <= b.maxX + pad && maxX >= b.minX - pad &&
          minZ <= b.maxZ + pad && maxZ >= b.minZ - pad) {
        if (minX < b.minX) b.minX = minX;
        if (minY < b.minY) b.minY = minY;
        if (minZ < b.minZ) b.minZ = minZ;
        if (maxX > b.maxX) b.maxX = maxX;
        if (maxY > b.maxY) b.maxY = maxY;
        if (maxZ > b.maxZ) b.maxZ = maxZ;
        if (replan) b.replan = true;
        return;
      }
    }
    this.pendingNavBoxes.push({ minX, minY, minZ, maxX, maxY, maxZ, replan });
  }

  /** Execute all accumulated nav-rebuild boxes from this tick, then clear them. */
  private flushNavRebuild(): void {
    for (const b of this.pendingNavBoxes) {
      this.executeNavRebuildAround(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, b.replan);
    }
    this.pendingNavBoxes.length = 0;
  }

  private executeNavRebuildAround(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    replan = false,
  ): void {
    if (!this.pathfinder || !this.surfaceNav || !this.vnav) return;
    const voxels = this.world.buffers.voxels;
    // Surface nav: 2-D box of NAV_CELL_METERS-sized cells.
    const sx0 = Math.floor(minX / NAV_CELL_METERS);
    const sz0 = Math.floor(minZ / NAV_CELL_METERS);
    const sx1 = Math.floor(maxX / NAV_CELL_METERS);
    const sz1 = Math.floor(maxZ / NAV_CELL_METERS);
    refreshSurfaceNavBox(voxels, this.surfaceNav, sx0, sz0, sx1, sz1);
    // Volume nav alias (Game.vnav is a separate copy of the volume summary
    // from the one Pathfinder owns; both must be kept in sync).
    const c0 = worldToVolumeCell(minX, minY, minZ);
    const c1 = worldToVolumeCell(maxX, maxY, maxZ);
    for (let cy = c0.cy; cy <= c1.cy; cy++) {
      for (let cz = c0.cz; cz <= c1.cz; cz++) {
        for (let cx = c0.cx; cx <= c1.cx; cx++) {
          rebuildVolumeCell(voxels, this.vnav, cx, cy, cz);
        }
      }
    }
    // Pathfinder volume + per-unit-kind grids — dispatched to the worker
    // when SAB is available (zero-copy on the shared bitmaps). FIFO ordering
    // on the worker queue means a follow-up findPath posted after this call
    // observes the rebuilt grid even though we don't await here.
    const rid = this.nextNavRebuildId++;
    this.navRebuildRegions.set(rid, { minX, minY, minZ, maxX, maxY, maxZ, color: 0xffdd00 });
    const navDone = this.pathWorker
      ? this.pathWorker.applyDamage(minX, minY, minZ, maxX, maxY, maxZ)
      : Promise.resolve(this.pathfinder.applyDamage(minX, minY, minZ, maxX, maxY, maxZ));
    void navDone.then(() => this.navRebuildRegions.delete(rid));
    if (replan) this.replanMovingUnits();
  }

  /**
   * Surface-2D cell lookup helper (used by build placement, evade target,
   * tank tracks). Returns the cell containing world (wx, wz) plus an `ok`
   * flag from the surface nav's `blocked` bit — same shape the old
   * PathClient.cellAt exposed.
   */
  private surfaceCellAt(wx: number, wz: number): { cx: number; cz: number; ok: boolean } {
    const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
    const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
    const i = navIndex(cx, cz);
    const ok = this.surfaceNav ? !this.surfaceNav.blocked[i] : true;
    return { cx, cz, ok };
  }

  /**
   * Like surfaceCellAt, but when the requested cell is blocked we expand
   * outward in concentric rings looking for the nearest walkable cell.
   * Disambiguates user clicks that land on a building edge / tree trunk.
   */
  private nearestSurfaceWalkable(wx: number, wz: number, maxRing = 4): { cx: number; cz: number; ok: boolean } {
    const c = this.surfaceCellAt(wx, wz);
    if (c.ok || !this.surfaceNav) return c;
    for (let r = 1; r <= maxRing; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = c.cx + dx, nz = c.cz + dz;
          if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
          if (!this.surfaceNav.blocked[navIndex(nx, nz)]) return { cx: nx, cz: nz, ok: true };
        }
      }
    }
    return c;
  }

  private replanMovingUnits(): void {
    if (!this.pathfinder) return;
    for (const u of this.units.units) {
      if (u.path.length === 0) continue;
      const goal = u.path[u.path.length - 1]!;
      void this.routePath(u, goal.x, goal.y, goal.z);
    }
  }

  /**
   * Plan a route for `unit` to `(wx, wy, wz)`. Uses the unit's pre-built
   * pathfinding grid (per-kind 3D bitmap that already accounts for footprint
   * width and body height); single-cell agile units get Theta* for any-angle
   * paths, wider chassis use plain weighted A*.
   *
   *   - `forceSurface` makes a digger walk on the surface to the target
   *     instead of cutting through whatever's between it and the goal —
   *     same intent as the old surface/volume branch.
   *   - Tunnelers / worms whose target is reachable on a clean straight
   *     line skip the search and head directly: at the speed they grind
   *     through dirt, the graph search is overkill for the common "go
   *     dig over there" command.
   */
  private async routePath(unit: Unit, wx: number, wy: number, wz: number, opts?: { forceSurface?: boolean }): Promise<void> {
    if (!this.pathfinder || !this.pathWorker) return;
    const startSurfaceY = this.surfaceWorldY(unit.x, unit.z);
    const startUnderground = unit.y < startSurfaceY - 0.5;
    const allowSurface = opts?.forceSurface && !startUnderground;

    // Diggers head straight to the goal whenever the unit has solid ground
    // underfoot — it can simply cut through whatever terrain is in the way
    // at any angle. If there is no ground underneath (cliff edge, open air
    // below) fall through to A* so the unit navigates around the void.
    if (unit.canDig && !allowSurface && this.hasGroundUnder(unit)) {
      this.units.setPath(unit, [{ x: wx, y: wy, z: wz }]);
      return;
    }

    const grid = this.pathfinder.getGrid(unit.kind);
    if (!grid) return;
    const start = this.pathfinder.cellAt(unit.x, unit.y, unit.z);
    let goal = this.pathfinder.cellAt(wx, wy, wz);
    // If the click landed on a non-passable cell (carved-out column, building
    // edge, ceiling), pull the goal toward the nearest cell where the unit's
    // body actually fits. Vertical fallback: scan the column from the picked
    // y upward for a passable layer (handles surface clicks in the cave overlay).
    const groundCell = this.pathfinder.groundCellAt(unit.kind, wx, wz);
    if (groundCell && !this.isUnitCellPassable(unit.kind, goal)) {
      goal = groundCell;
    }
    goal = this.pathfinder.nearestPassable(unit.kind, goal, 5);

    // Tag this request so a stale reply (older order superseded by a newer
    // one for the same unit) can't clobber the fresh path on arrival.
    const reqId = (this.latestPathReqByUnit.get(unit.id) ?? 0) + 1;
    this.latestPathReqByUnit.set(unit.id, reqId);

    this.pendingPathRequests.set(unit.id, {
      start: { x: unit.x, y: unit.y, z: unit.z },
      goal: { x: wx, y: wy, z: wz },
    });

    const res = await this.pathWorker.findPath(unit.kind, {
      start, goal,
      // Theta* shortcuts only fire for single-cell footprints; wider chassis
      // fall back to grid A* internally (line-of-sight on a fat footprint
      // becomes its own bottleneck and the path quality difference is tiny).
      anyAngle: unit.footprintRadius <= 1,
      maxExpansions: 30000,
    });
    this.pendingPathRequests.delete(unit.id);
    if (this.latestPathReqByUnit.get(unit.id) !== reqId) return;

    this.lastPathStatsByUnit.set(unit.id, {
      kind: unit.kind,
      start,
      goal,
      reached: res.reached,
      expanded: res.expanded,
      waypointCount: res.waypoints.length,
      timings: res.timings,
      timestamp: Date.now(),
    });

    if (res.waypoints.length === 0 || !res.reached) return;
    this.units.setPath(unit, res.waypoints);
  }

  /** True if the unit's kind grid says (cell) is passable. */
  private isUnitCellPassable(kind: string, c: { cx: number; cy: number; cz: number }): boolean {
    if (!this.pathfinder) return false;
    const grid = this.pathfinder.getGrid(kind);
    if (!grid) return false;
    return getBit(grid.passable, vnavIndex(c.cx, c.cy, c.cz)) === 1;
  }

  /**
   * After every unit tick, re-route any unit that has been blocked long enough to
   * cross the BLOCKED_REPATH_FRAMES threshold. The flag was latched by the unit
   * tick; we consume it here, snapshot the current destination (last waypoint of
   * the surviving path), and request a fresh route with the offending peers as
   * obstacles. If no new route is found the unit just keeps walking the old one
   * until BLOCKED_GIVE_UP_FRAMES drops it for good.
   */
  private servicePendingRepaths(): void {
    if (!this.pathfinder) return;
    for (const u of this.units.units) {
      if (!u.needsRepath) continue;
      u.needsRepath = false;
      if (u.path.length === 0) continue;
      const goal = u.path[u.path.length - 1]!;
      void this.routePath(u, goal.x, goal.y, goal.z);
    }
  }

  /**
   * For every tank that's traveled at least TANK_TRACK_INTERVAL metres since its last
   * mark, fire a small damageSphere under each tread keyed off the surface material.
   * Soft ground (mud) accumulates damage fast and the top voxel disappears within a
   * pass or two, so the tank visibly sinks. Grass takes a few passes before grooves
   * expose dirt below. Stone/wood/etc. are not affected (peak === 0).
   */
  private paintTankTracks(): void {
    if (!this.pathfinder) return;
    const TANK_TRACK_INTERVAL = 0.4;     // m between tread marks
    const TANK_TREAD_OFFSET = 1.20;      // half-spacing between treads, m (matches model)
    const nav = this.surfaceNav!;
    // Union of every tread mark's centre that actually removed voxels this
    // frame. The nav refresh always uses the fixed half-extent, so we only
    // need the centroid bbox to position it.
    let anythingDestroyed = false;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity;
    let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;

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
        if (result.destroyed.length > 0) {
          anythingDestroyed = true;
          const wxc = cxv * VOXEL_SIZE, wyc = cyv * VOXEL_SIZE, wzc = czv * VOXEL_SIZE;
          if (wxc < bx0) bx0 = wxc;
          if (wyc < by0) by0 = wyc;
          if (wzc < bz0) bz0 = wzc;
          if (wxc > bx1) bx1 = wxc;
          if (wyc > by1) by1 = wyc;
          if (wzc > bz1) bz1 = wzc;
        }
      }
    }
    // Only request a nav rebuild when track damage actually removed voxels (changed
    // topY); a no-op pass over compacted grass/dirt just bumps damage counters.
    if (anythingDestroyed) {
      const r = NAV_REFRESH_HALF_EXTENT_METERS;
      this.requestNavRebuildAround(bx0 - r, by0 - r, bz0 - r, bx1 + r, by1 + r, bz1 + r);
    }
  }

  /**
   * True when there is solid terrain within 3 voxels directly below the
   * unit's feet. Used by the tunneler routing decision: a unit with ground
   * underfoot can drive a straight diagonal line to any target (cutting
   * through whatever is in the way); a unit over a void needs A* instead.
   */
  private hasGroundUnder(unit: { x: number; y: number; z: number }): boolean {
    const voxels = this.world.buffers.voxels;
    const vx = Math.floor(unit.x / VOXEL_SIZE);
    const vz = Math.floor(unit.z / VOXEL_SIZE);
    if (vx < 0 || vx >= WORLD_X || vz < 0 || vz >= WORLD_Z) return false;
    const vyFeet = Math.floor(unit.y / VOXEL_SIZE);
    // Probe 20 voxels below — enough to see a tunnel floor even when the
    // cutter has carved a tall open shaft above a solid ledge.
    for (let dy = 1; dy <= 20; dy++) {
      const vy = vyFeet - dy;
      if (vy < 0) return false;
      if (vy >= WORLD_Y) continue;
      if (voxels[worldIndex(vx, vy, vz)] !== AIR) return true;
    }
    return false;
  }

  /** True when the straight-line climb/dive to the goal is within the unit's pitch limit. */
  private findMetalCluster(vx: number, vy: number, vz: number): MetalCluster | null {
    for (const c of this.metalClusters) {
      if (c.destroyed) continue;
      if (Math.abs(vx - c.vx) > c.rxz) continue;
      if (Math.abs(vz - c.vz) > c.rxz) continue;
      if (vy < c.surfaceTop + 1 || vy > c.surfaceTop + 1 + c.ry * 2) continue;
      return c;
    }
    return null;
  }

  /**
   * Find the nearest live M_METAL voxel in `cluster` to the worker standing
   * at (workerX, workerZ), chip 1 metal from it, and destroy it if exhausted.
   * Returns true if a voxel was destroyed, false if chipped, null if no voxel
   * was found within the cluster bounds.
   */
  private onClusterVoxelChipped(
    cluster: MetalCluster,
    workerX: number, workerZ: number,
  ): boolean | null {
    const { vx: cx, vz: cz, rxz, ry, surfaceTop } = cluster;
    const yMin = surfaceTop + 1;
    const yMax = surfaceTop + 1 + ry * 2;
    const voxels = this.world.buffers.voxels;
    let bestKey = -1, bestVx = 0, bestVy = 0, bestVz = 0, bestDist2 = Infinity;
    const workerVx = workerX / VOXEL_SIZE;
    const workerVz = workerZ / VOXEL_SIZE;
    for (let y = yMin; y <= yMax; y++) {
      for (let z = cz - rxz; z <= cz + rxz; z++) {
        for (let x = cx - rxz; x <= cx + rxz; x++) {
          if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
          if (voxels[worldIndex(x, y, z)] !== M_METAL) continue;
          const dx = x - workerVx, dz = z - workerVz;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestDist2) { bestDist2 = d2; bestKey = worldIndex(x, y, z); bestVx = x; bestVy = y; bestVz = z; }
        }
      }
    }
    if (bestKey < 0) return null;
    cluster.totalMetal = Math.max(0, cluster.totalMetal - 1);
    const remaining = (this.metalVoxelRemaining.get(bestKey) ?? METAL_PER_VOXEL) - 1;
    if (remaining <= 0) {
      this.metalVoxelRemaining.delete(bestKey);
      this.world.set(bestVx, bestVy, bestVz, AIR);
      const wx = (bestVx + 0.5) * VOXEL_SIZE;
      const wy = (bestVy + 0.5) * VOXEL_SIZE;
      const wz = (bestVz + 0.5) * VOXEL_SIZE;
      this.requestNavRebuildAround(wx - 1, wy - 1, wz - 1, wx + 1, wy + 1, wz + 1);
      if (cluster.totalMetal <= 0) cluster.destroyed = true;
      return true;
    }
    this.metalVoxelRemaining.set(bestKey, remaining);
    return false;
  }

  private tryClaimClusterSlot(cluster: MetalCluster, unitId: number): number | null {
    // If this unit already holds a slot, return it (re-entry after deliver).
    for (let i = 0; i < cluster.workerSlots.length; i++) {
      if (cluster.workerSlots[i] === unitId) return i;
    }
    for (let i = 0; i < cluster.workerSlots.length; i++) {
      if (cluster.workerSlots[i] === 0) {
        cluster.workerSlots[i] = unitId;
        return i;
      }
    }
    return null; // cluster full
  }

  private releaseClusterSlot(clusterId: number, unitId: number): void {
    const cluster = this.metalClusters.find(c => c.id === clusterId);
    if (!cluster) return;
    for (let i = 0; i < cluster.workerSlots.length; i++) {
      if (cluster.workerSlots[i] === unitId) { cluster.workerSlots[i] = 0; return; }
    }
  }

  private clusterSlotPos(cluster: MetalCluster, slotIndex: number): { x: number; y: number; z: number } {
    const angle = (slotIndex / cluster.maxWorkers) * Math.PI * 2;
    const radius = (cluster.rxz + 2.5) * VOXEL_SIZE;
    return {
      x: cluster.worldX + Math.cos(angle) * radius,
      y: (cluster.surfaceTop + 1) * VOXEL_SIZE,
      z: cluster.worldZ + Math.sin(angle) * radius,
    };
  }

  /** Nearest live cluster with a free worker slot, excluding `excludeId`. Returns a metal voxel target in it. */
  private findAlternateClusterTarget(
    excludeId: number, fromX: number, fromZ: number,
  ): { wx: number; wy: number; wz: number } | null {
    let best: MetalCluster | null = null;
    let bestDist2 = Infinity;
    for (const c of this.metalClusters) {
      if (c.id === excludeId || c.destroyed) continue;
      if (!c.workerSlots.some(s => s === 0)) continue;
      const dx = c.worldX - fromX, dz = c.worldZ - fromZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) { bestDist2 = d2; best = c; }
    }
    if (!best) return null;
    const voxels = this.world.buffers.voxels;
    const yMin = best.surfaceTop + 1;
    const yMax = best.surfaceTop + 1 + best.ry * 2;
    for (let y = yMin; y <= yMax; y++) {
      for (let z = best.vz - best.rxz; z <= best.vz + best.rxz; z++) {
        for (let x = best.vx - best.rxz; x <= best.vx + best.rxz; x++) {
          if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
          if (voxels[worldIndex(x, y, z)] === M_METAL) {
            return { wx: (x + 0.5) * VOXEL_SIZE, wy: (y + 0.5) * VOXEL_SIZE, wz: (z + 0.5) * VOXEL_SIZE };
          }
        }
      }
    }
    return null;
  }

  private tunnelerPitchOk(unit: { x: number; y: number; z: number; maxPitchRad: number }, wx: number, wy: number, wz: number): boolean {
    const dx = wx - unit.x, dy = wy - unit.y, dz = wz - unit.z;
    const horiz = Math.hypot(dx, dz);
    const pitch = horiz < 1e-4 ? Math.PI / 2 : Math.atan2(Math.abs(dy), horiz);
    return pitch <= unit.maxPitchRad;
  }

  /**
   * True when the player is mid-aim with the right mouse button on a
   * weapon-bearing unit. While active, the camera's RMB-yaw input is
   * suppressed and the trajectory preview / impact marker are drawn.
   */
  private isFireAimActive(): boolean {
    if (this.mode !== 'play') return false;
    if (!this.input.rmbHold) return false;
    const sel = this.units.units.find(u => u.selected);
    if (!sel || sel.weapon === null) return false;
    return true;
  }

  /**
   * True when the player is mid-aim with the right mouse button on a
   * tunneler / worm. RMB hold + vertical drag picks the dig target Y; on
   * release the unit is routed to that point via volume-nav (so it digs
   * down through whatever's in the way). Camera RMB-yaw is suppressed
   * while this gesture is active.
   */
  private isDigAimActive(): boolean {
    if (this.mode !== 'play') return false;
    if (!this.input.rmbHold) return false;
    const sel = this.units.units.find(u => u.selected);
    if (!sel || !sel.canDig || sel.weapon !== null) return false;
    return true;
  }

  /**
   * Each frame while RMB is held with a weapon-bearing unit selected, ray-cast
   * from the cursor's start position into the world and use vertical drag to
   * raise/lower the impact altitude. Then ask the projectile manager to
   * predict the actual flight path with full physics, draw it as a dashed arc,
   * and place an impact marker at the predicted landing point.
   */
  private updateFireAim(w: number, h: number): void {
    if (!this.isFireAimActive()) {
      this.trajectoryPreview.update([]);
      this.impactMarker.hide();
      return;
    }
    const hold = this.input.rmbHold!;
    const sel = this.units.units.find(u => u.selected)!;
    const wcfg = WEAPONS[sel.weapon!];
    // Start cursor position is the aim point; vertical drag (down = +pixels)
    // lowers the altitude, drag-up raises it. Same convention as the RMB
    // tunneler dig drag, so the player only learns one gesture.
    const verticalDrag = hold.currentY - hold.startY;
    const r = this.resolveTarget(hold.startX, hold.startY, w, h, verticalDrag);
    if (!r) {
      this.trajectoryPreview.update([]);
      this.impactMarker.hide();
      return;
    }
    const target = r.target;
    // Aim direction from the unit's muzzle to the target. We use the unit's
    // *current* turretYaw / heading to seed the yaw, then we let the target's
    // pitch component drive the elevation. The trajectory we draw is exactly
    // what the projectile will do once fired (matching physics in
    // ProjectileManager.predictTrajectory).
    const dx = target.x - sel.x;
    const dy = target.y - (sel.y + 1.2);
    const dz = target.z - sel.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const dirX = dx / dl, dirY = dy / dl, dirZ = dz / dl;
    const muzzle = muzzleOrigin(sel.x, sel.y, sel.z, dirX, dirY, dirZ, 1.4, 1.2);
    const points = this.projectiles.predictTrajectory(
      wcfg.projectile,
      muzzle.x, muzzle.y, muzzle.z,
      dirX, dirY, dirZ,
      this.world,
      0,
      120, 0.05,
      wcfg.velocityScale,
      sel.launcherMaxStrength,
    );
    this.trajectoryPreview.update(points);
    const last = points[points.length - 1];
    if (last) {
      const pcfg = PROJECTILES[wcfg.projectile];
      const ringRadius = pcfg.explosive ? pcfg.explosionRadiusMeters : 0.6;
      this.impactMarker.show(last.x, last.y, last.z, ringRadius);
    }
  }

  /**
   * On RMB release, commit the aimed target to the unit. The weapon-tick will
   * slew the turret / hull toward the target, then fire when within tolerance.
   * Burst weapons (rifle, MG) consume the target on the first shot and then
   * spray follow-up rounds along the same heading without needing re-aim.
   *
   * For unarmed selections we instead try to interpret the click as a worker
   * command — currently just "RMB on a farm with a worker selected" → assign
   * the worker as the farm's farmer. Anything that isn't a recognised
   * unarmed-RMB gesture falls through silently.
   */
  private handleFireRelease(release: { startX: number; startY: number; endX: number; endY: number; shift: boolean }, w: number, h: number): void {
    this.trajectoryPreview.update([]);
    this.impactMarker.hide();
    if (this.mode !== 'play') return;
    const armed = this.units.units.filter(u => u.selected && u.weapon !== null);
    if (armed.length === 0) {
      // Worker → farm gesture only fires on a short click (no drag), so the
      // existing camera-yaw drag still works for unarmed selections.
      if (this.isDragging(release.startX, release.startY, release.endX, release.endY)) return;
      const worker = this.units.units.find(u => u.selected && u.kind === 'worker');
      if (!worker) return;
      const b = this.pickBuildingAt(release.startX, release.startY, w, h);
      if (!b || b.spec.kind !== 'farm') return;
      // Detach any existing farmer from this farm so the latest assignment
      // wins, then route the new farmer to the field. tickFarm validates the
      // assignment each tick; the worker will start tending on arrival.
      // Also publish a farmTend order on the global board pre-claimed for
      // this worker so the right-side panel reflects the assignment and a
      // stall recovery later releases it cleanly.
      if (b.farmerId !== null && b.farmerId !== worker.id) {
        const prev = this.units.units.find(u => u.id === b.farmerId);
        if (prev && prev.task.kind === 'farm') {
          prev.task = { kind: 'idle' };
          if (prev.claimedOrderId !== 0) {
            this.taskBoard.remove(prev.claimedOrderId);
            prev.claimedOrderId = 0;
          }
        }
      }
      b.farmerId = worker.id;
      worker.task = { kind: 'farm', buildingId: b.id };
      const order = this.taskBoard.addFarmTend(b.id);
      order.claimedBy = worker.id;
      worker.claimedOrderId = order.id;
      const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      void this.routePath(worker, cxw, worker.y, czw);
      return;
    }
    const verticalDrag = release.endY - release.startY;
    const r = this.resolveTarget(release.startX, release.startY, w, h, verticalDrag);
    if (!r) return;
    for (const u of armed) {
      u.firingTarget = { x: r.target.x, y: r.target.y, z: r.target.z };
    }
  }

  /**
   * Each frame while RMB is held with a tunneler / worm selected, render the
   * surface→target marker at the cursor's start position. Vertical drag
   * (down = deeper) shifts the target Y relative to the unit's current Y,
   * clamped by the unit's max-pitch cap. Mirrors the old LMB drag preview
   * but driven by RMB.
   */
  private updateDigAim(w: number, h: number): void {
    if (!this.isDigAimActive()) return;
    const hold = this.input.rmbHold!;
    const sel = this.units.units.find(u => u.selected)!;
    const verticalDrag = hold.currentY - hold.startY;
    const r = this.resolveTarget(
      hold.startX, hold.startY, w, h, verticalDrag,
      sel.y, sel.maxPitchRad, { x: sel.x, z: sel.z },
    );
    if (!r) { this.target.hide(); return; }
    this.target.show(r.surface, r.target);
  }

  /**
   * On RMB release with a tunneler / worm selected, commit the aimed
   * target as a normal route command. The drag's vertical component picks
   * the target Y; routePath sees `canDig` and runs volume-nav so the unit
   * grinds down to the goal.
   */
  private handleDigRelease(release: { startX: number; startY: number; endX: number; endY: number; shift: boolean }, w: number, h: number): void {
    this.target.hide();
    if (this.mode !== 'play') return;
    const sel = this.units.units.find(u => u.selected);
    if (!sel || !sel.canDig || sel.weapon !== null) return;
    const verticalDrag = release.endY - release.startY;
    const r = this.resolveTarget(
      release.startX, release.startY, w, h, verticalDrag,
      sel.y, sel.maxPitchRad, { x: sel.x, z: sel.z },
    );
    if (!r) return;
    this.commandSingle(sel, r);
  }

  /**
   * Ray-vs-unit-sphere hit test for projectile collision. We treat each unit
   * as a vertical bounding sphere centred on the unit's torso and skip the
   * projectile's own owner so a soldier doesn't shoot themselves at point-
   * blank. Returns the closest unit along the swept segment, or null on miss.
   *
   * Used as the `unitHitTest` callback wired into ProjectileManager.tick.
   */
  private unitRayHit(
    fx: number, fy: number, fz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    ownerId: number,
  ): { tMeters: number; unitId: number } | null {
    let bestT = Infinity;
    let bestId = -1;
    for (const u of this.units.units) {
      if (u.id === ownerId) continue;
      if (u.hp <= 0) continue;
      // Bounding sphere — body half-width plus a small pad, centred at torso
      // height (~0.7 m above feet for soldiers, taller for tanks via height
      // scaling). Picked to feel generous without overlapping neighbours.
      const radius = u.widthMeters * 0.55 + 0.35;
      const cx = u.x;
      const cy = u.y + Math.max(0.7, u.widthMeters * 0.6);
      const cz = u.z;
      const ox = fx - cx, oy = fy - cy, oz = fz - cz;
      // |o + t·d - c|^2 = r^2  →  t² + 2(b)t + c = 0  with b = o·d, c = o·o − r²
      const b = ox * dx + oy * dy + oz * dz;
      const cTerm = ox * ox + oy * oy + oz * oz - radius * radius;
      const disc = b * b - cTerm;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = -b - sq;
      // Inside the sphere (t < 0 on the near root) — accept the far root so
      // a projectile spawned partly inside a target's bounding sphere still
      // registers a hit.
      if (t < 0) t = -b + sq;
      if (t < 0 || t > maxDist) continue;
      if (t < bestT) {
        bestT = t;
        bestId = u.id;
      }
    }
    return bestId >= 0 ? { tMeters: bestT, unitId: bestId } : null;
  }

  /**
   * Splice any unit whose HP has dropped to zero out of the manager. Called
   * once per frame after projectile impacts have been applied.
   */
  private removeDeadUnits(): void {
    const arr = this.units.units;
    let w = 0;
    for (let r = 0; r < arr.length; r++) {
      const u = arr[r]!;
      if (u.hp > 0) {
        arr[w++] = u;
      } else {
        // Death VFX — a small debris burst at the unit's torso so the player
        // sees a clear loss event tied to the round that killed them.
        this.debris.spawnBurst(u.x, u.y + 0.6, u.z, 24, M_DIRT);
      }
    }
    arr.length = w;
  }

  /**
   * Resolve a projectile impact: spawn a damage sphere on the world (so the
   * crater + debris pipeline is identical to a player-placed shift-LMB
   * detonation), spawn a fire-flash sphere at the impact point, and start an
   * expanding ring on the ground tuned to the explosion radius. Cluster
   * detonations also kick out submunitions in random downward-tilted
   * directions.
   *
   * Also applies unit damage: a direct projectile hit deals the round's full
   * `hitDamage`, and explosive impacts splash extra (smaller, falloff)
   * damage to every unit within the blast radius. Direct hits hurt more
   * than explosions, by design — landing a clean shot is the decisive play.
   */
  private handleProjectileImpact(imp: ProjectileImpact): void {
    const cfg = PROJECTILES[imp.kind];
    const cx = imp.x / VOXEL_SIZE;
    const cy = imp.y / VOXEL_SIZE;
    const cz = imp.z / VOXEL_SIZE;
    const radiusMeters = imp.explosive ? imp.explosionRadiusMeters : imp.hitRadiusMeters;
    // Terrain damage uses a per-projectile multiplier so a turret round can
    // still hurt enemies at full peak without carving up the surrounding
    // base, plus a global TERRAIN_DAMAGE_GLOBAL_SCALE that softens craters
    // across the board. Unit damage below ignores both scales.
    const terrainPeak = imp.damagePeak * imp.terrainDamageScale * TERRAIN_DAMAGE_GLOBAL_SCALE;
    const result = this.world.damageSphere(cx, cy, cz, radiusMeters / VOXEL_SIZE, terrainPeak);
    if (result.destroyed.length > 0) {
      const sample = result.destroyed[Math.floor(result.destroyed.length / 2)]!;
      const burst = imp.explosive
        ? Math.min(220, 30 + result.destroyed.length * 2)
        : Math.min(20, 4 + result.destroyed.length);
      this.debris.spawnBurst(imp.x, imp.y, imp.z, burst, sample.material);
      const r = NAV_REFRESH_HALF_EXTENT_METERS;
      this.requestNavRebuildAround(
        imp.x - r, imp.y - r, imp.z - r,
        imp.x + r, imp.y + r, imp.z + r,
      );
    }
    // Fire flash — bigger and longer for explosives so the player feels the
    // weight of an RPG / cluster hit. Bullets get a small spark.
    if (imp.explosive) {
      this.impactFlashes.spawn(imp.x, imp.y, imp.z, radiusMeters * 1.6, 0.32, 1.0, 0.55, 0.25);
    } else {
      this.impactFlashes.spawn(imp.x, imp.y, imp.z, radiusMeters * 0.8, 0.14, 1.0, 0.85, 0.45);
    }
    // Expanding shockwave ring — radius scales with the explosion, so a tank
    // shell sweeps a much wider ring than a 9 mm pit.
    const ringRadius = imp.explosive ? imp.explosionRadiusMeters * 1.4 : 0.6;
    const ringLife = imp.explosive ? 0.7 : 0.25;
    this.impactRings.spawn(imp.x, imp.y, imp.z, ringRadius, ringLife, cfg.colorR, cfg.colorG, cfg.colorB);
    // Direct projectile hit on a unit. Apply the round's full `hitDamage`
    // — for non-explosive bullets that's the only damage; explosive rounds
    // additionally splash blast damage below.
    if (imp.directHitUnitId >= 0) {
      const hit = this.units.units.find(u => u.id === imp.directHitUnitId);
      if (hit) hit.hp -= imp.hitDamage;
    }
    // Building damage. Direct-hit (impact lands inside a footprint AABB)
    // takes hitDamage; explosive splash applies falloff to every building
    // whose AABB sits within the blast. Once a building's HP hits zero it
    // flips to `destroyed` — that single source of truth replaces having
    // to wait for the wall-count tick to notice the structure is gone.
    this.buildings.applyImpactDamage(imp);
    // Explosion splash damage to nearby units. Falls off linearly to zero at
    // the blast edge and is capped well below a direct hit (×0.4) so taking
    // a round to the chest hurts more than catching the splash from a near-
    // miss. The directly hit unit, if any, also catches the splash on top of
    // the impact damage — taking a tank shell to the face is supposed to be
    // brutal.
    if (imp.explosive && imp.explosionRadiusMeters > 0) {
      const blastR = imp.explosionRadiusMeters;
      for (const u of this.units.units) {
        const torsoY = u.y + Math.max(0.7, u.widthMeters * 0.6);
        const dx = u.x - imp.x;
        const dy = torsoY - imp.y;
        const dz = u.z - imp.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist >= blastR) continue;
        const falloff = 1 - dist / blastR;
        u.hp -= imp.damagePeak * 0.4 * falloff;
      }
    }
    // Cluster: spawn submunitions in a random downward cone from the burst
    // point, using the projectile catalog's `cluster_submunition` entry.
    if (cfg.clusterSubmunitions > 0) {
      const n = cfg.clusterSubmunitions;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
        const tilt = 0.3 + Math.random() * 0.5;     // 17°–46° outward
        const horiz = Math.cos(tilt);
        const dx = Math.cos(a) * horiz;
        const dz = Math.sin(a) * horiz;
        const dy = -Math.sin(tilt) - 0.2;           // slightly downward
        // Submunitions are anonymous (ownerId = -1) so they can damage any
        // future unit-vs-unit logic without the originating launcher being
        // counted as the shooter.
        this.projectiles.spawn('cluster_submunition', imp.x, imp.y + 0.2, imp.z, dx, dy, dz, -1, 1);
      }
    }
  }

  /** World-space Y (meters) of the topY voxel under the given world-space (x, z). */
  private surfaceWorldY(wx: number, wz: number): number {
    if (!this.pathfinder) return 0;
    const cell = this.surfaceCellAt(wx, wz);
    const i = navIndex(cell.cx, cell.cz);
    const top = this.surfaceNav!.topY[i]!;
    return top < 0 ? 0 : (top + 1) * VOXEL_SIZE;
  }

  /**
   * The hooks actions are allowed to call back into Game with. Kept tiny —
   * actions mutate units / buildings directly; the context is for things
   * that need Game-level mode state (build / plant / play).
   */
  private actionCtx(): ActionContext {
    return {
      enterBuildMode: (): void => {
        this.mode = 'build';
        this.buildSpec = ALL_BUILDINGS[0]!;
        this.ghost.setSpec(this.buildSpec);
      },
      enterPlantMode: (): void => {
        this.mode = 'plant';
        this.ghost.hide();
      },
      cancelMode: (): void => {
        this.mode = 'play';
        this.ghost.hide();
      },
      enterWaypointMode: (stance): void => {
        this.pendingWaypointStance = stance;
        this.mode = 'waypoint';
        this.ghost.hide();
      },
    };
  }

  /** Run a unit action against the currently-selected units. */
  private runUnitAction(action: UnitAction): void {
    const sel = this.units.units.filter(u => u.selected && action.applicable(u));
    if (sel.length === 0) return;
    action.run(sel, this.actionCtx());
  }

  /** Run a building action against the currently-selected building. */
  private runBuildingAction(action: BuildingAction): void {
    const b = this.buildings.getSelected();
    if (!b || !action.applicable(b)) return;
    action.run(b, this.actionCtx());
  }

  /**
   * Read each action's keybind off the current selection's action list and
   * fire any whose key was pressed this frame. Buildings take priority over
   * units when both somehow have selection state — in practice the click
   * handlers keep them mutually exclusive, but we still dispatch only one
   * source per frame to avoid double-fires on a shared key.
   */
  private dispatchActionKeys(): void {
    if (this.input.pressed.size === 0) return;
    const selBuilding = this.buildings.getSelected();
    if (selBuilding) {
      for (const a of buildingActionsFor(selBuilding)) {
        if (this.input.pressed.has(a.key)) this.runBuildingAction(a);
      }
      return;
    }
    const selUnits = this.units.units.filter(u => u.selected);
    if (selUnits.length === 0) return;
    for (const a of unitActionsFor(selUnits)) {
      if (this.input.pressed.has(a.key)) this.runUnitAction(a);
    }
  }

  /**
   * Rebuild the action panel DOM when the selection's actions changed; refresh
   * the live subtitle (e.g. queue length) every frame regardless. The render
   * is keyed on a string signature so we skip DOM work when nothing
   * structural has changed — that keeps existing click handlers attached.
   */
  private renderActionPanel(): void {
    if (!this.actionsEl) return;
    const selBuilding = this.buildings.getSelected();
    const selUnits = this.units.units.filter(u => u.selected);

    if (selBuilding) {
      const acts = buildingActionsFor(selBuilding);
      const key = `b:${selBuilding.id}:${selBuilding.spec.kind}:${acts.map(a => a.id).join(',')}`;
      if (key !== this.actionsRenderedKey) {
        this.buildActionsDom(
          `${selBuilding.spec.label} (#${selBuilding.id})`,
          'Building',
          acts.map(a => ({
            id: a.id, label: a.label, keyLabel: a.keyLabel,
            run: (): void => this.runBuildingAction(a),
          })),
        );
        this.actionsRenderedKey = key;
      }
      const sub = this.actionsEl.querySelector('.actions-sub');
      if (sub) {
        const q = selBuilding.trainQueue;
        const qStr = q.length > 0 ? ` · queue: ${q.join(', ')}` : '';
        const wpStr = selBuilding.rallyPoint
          ? ` · waypoint: ${selBuilding.rallyStance}`
          : '';
        const modeStr = this.mode === 'waypoint' ? ' · click map to set waypoint' : '';
        sub.textContent = `Building${qStr}${wpStr}${modeStr}`;
      }
      this.actionsEl.style.display = 'block';
      return;
    }

    if (selUnits.length > 0) {
      const acts = unitActionsFor(selUnits);
      const lead = selUnits[0]!;
      const key = `u:${selUnits.length}:${lead.id}:${lead.kind}:${acts.map(a => a.id).join(',')}`;
      if (key !== this.actionsRenderedKey) {
        const title = selUnits.length > 1
          ? `${selUnits.length} units selected`
          : `${lead.kind} #${lead.id}`;
        this.buildActionsDom(
          title,
          'Unit',
          acts.map(a => ({
            id: a.id, label: a.label, keyLabel: a.keyLabel,
            run: (): void => this.runUnitAction(a),
          })),
        );
        this.actionsRenderedKey = key;
      }
      // Live subtitle: stance summary so the player can see the current
      // mode without checking the panel twice.
      const sub = this.actionsEl.querySelector('.actions-sub');
      if (sub) {
        const armed = selUnits.filter(u => u.weapon !== null);
        const workers = selUnits.filter(u => u.kind === 'worker');
        if (armed.length > 0) {
          const all = armed.every(u => u.stance === armed[0]!.stance);
          sub.textContent = all
            ? `Unit · stance: ${armed[0]!.stance}`
            : 'Unit · stance: mixed';
        } else if (workers.length > 0) {
          const allSameFocus = workers.every(u => u.workerFocus === workers[0]!.workerFocus);
          sub.textContent = allSameFocus
            ? `Unit · focus: ${workers[0]!.workerFocus}`
            : 'Unit · focus: mixed';
        } else {
          sub.textContent = 'Unit';
        }
      }
      this.actionsEl.style.display = 'block';
      return;
    }

    if (this.actionsRenderedKey !== '') {
      this.actionsEl.innerHTML = '';
      this.actionsRenderedKey = '';
    }
    this.actionsEl.style.display = 'none';
  }

  /** Construct the DOM rows for the actions panel from a list of entries. */
  private buildActionsDom(
    title: string,
    subtitle: string,
    rows: { id: string; label: string; keyLabel: string; run: () => void }[],
  ): void {
    if (!this.actionsEl) return;
    this.actionsEl.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'actions-title';
    t.textContent = title;
    this.actionsEl.appendChild(t);
    const s = document.createElement('div');
    s.className = 'actions-sub';
    s.textContent = subtitle;
    this.actionsEl.appendChild(s);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'action-row';
      empty.textContent = '(no actions available)';
      this.actionsEl.appendChild(empty);
      return;
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'action-row';
      const k = document.createElement('span');
      k.className = 'action-key';
      k.textContent = r.keyLabel;
      const lbl = document.createElement('span');
      lbl.className = 'action-label';
      lbl.textContent = r.label;
      row.appendChild(k);
      row.appendChild(lbl);
      row.addEventListener('click', () => r.run());
      this.actionsEl.appendChild(row);
    }
  }

  /**
   * Rebuild the right-side task panel from the live `WorkerTaskBoard`. Lists
   * orders in execution order (claimed first, then by priority + FIFO seq).
   * Keyed on a string signature so we only re-render the DOM when the
   * displayed order set actually changes.
   */
  private renderTaskPanel(): void {
    if (!this.tasksEl) return;
    const orders = this.taskBoard.snapshot();
    const key = orders
      .map(o => `${o.id}:${o.kind}:${o.claimedBy}:${o.buildingId ?? ''}:${o.wx ?? ''}:${o.wz ?? ''}`)
      .join('|');
    if (key === this.tasksRenderedKey) return;
    this.tasksRenderedKey = key;
    this.tasksEl.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'tasks-title';
    t.textContent = `Worker tasks (${orders.length})`;
    this.tasksEl.appendChild(t);
    if (orders.length === 0) {
      const e = document.createElement('div');
      e.className = 'tasks-empty';
      e.textContent = '(none — workers idle)';
      this.tasksEl.appendChild(e);
      return;
    }
    for (const o of orders) {
      const row = document.createElement('div');
      row.className = `task-row ${o.claimedBy !== 0 ? 'claimed' : 'pending'}`;
      const k = document.createElement('span');
      k.className = 'task-kind';
      k.textContent = o.kind;
      const d = document.createElement('span');
      d.className = 'task-detail';
      d.textContent = describeOrder(o, this.buildings);
      const c = document.createElement('span');
      c.className = 'task-claim';
      c.textContent = o.claimedBy !== 0 ? `→ #${o.claimedBy}` : 'queued';
      row.appendChild(k);
      row.appendChild(d);
      row.appendChild(c);
      this.tasksEl.appendChild(row);
    }
  }

  private renderPathInfo(): void {
    if (!this.pathInfoEl) return;
    const sel = this.units.units.find(u => u.selected);
    if (!sel) { this.pathInfoEl.style.display = 'none'; return; }
    const stats = this.lastPathStatsByUnit.get(sel.id);
    if (!stats) { this.pathInfoEl.style.display = 'none'; return; }
    const t = stats.timings;
    const ageS = Math.floor((Date.now() - stats.timestamp) / 1000);
    const algo = t?.algorithm ?? '?';
    const dur = t ? t.durationMs.toFixed(1) : '?';
    let key = `${sel.id}|${algo}|${dur}|${stats.expanded}|${stats.waypointCount}|${stats.reached}|${ageS}`;
    if (t?.hpaDijkstraMs !== undefined) key += `|${t.hpaDijkstraMs.toFixed(1)}`;
    if (key === (this.pathInfoEl.dataset.key ?? '')) return;
    this.pathInfoEl.dataset.key = key;

    let html = `<b>PATH</b> ${algo} | ${dur}ms | ${stats.expanded} cells | ${stats.waypointCount} wp | ${stats.reached ? 'reached' : 'partial'}`;
    html += `<br>(${stats.start.cx},${stats.start.cy},${stats.start.cz})&rarr;(${stats.goal.cx},${stats.goal.cy},${stats.goal.cz})`;
    if (t?.hpaDijkstraMs !== undefined) {
      html += `<br>dijkstra ${t.hpaDijkstraMs.toFixed(1)}ms &middot; abstract ${(t.hpaAbstractMs ?? 0).toFixed(1)}ms &middot; refine ${(t.hpaRefineMs ?? 0).toFixed(1)}ms (${t.hpaSegments ?? '?'} seg)`;
    }
    if (this.pendingPathRequests.has(sel.id)) {
      html += `<br><span style="color:#4488ff">&#9679; routing&hellip;</span>`;
    } else {
      html += `<br><span style="color:#888">${ageS}s ago</span>`;
    }
    this.pathInfoEl.innerHTML = html;
    this.pathInfoEl.style.display = 'block';
  }

  /**
   * Predict the remaining flight path for every live projectile and push the
   * sample arrays into the dashed-arc renderer. Called once per frame from
   * the tick — the arcs are visualisation only, no game state changes.
   */
  /**
   * Aggressive-stance pipeline. For every armed friendly unit in
   * 'aggressive' mode that isn't already firing, find the nearest enemy in
   * weapon range and either (a) drop a `firingTarget` on it when the
   * trajectory clears, or (b) route the unit toward the enemy when the
   * arc is blocked, so they get into a position they can shoot from.
   *
   * Defensive-stance units are left alone — the player issues their orders
   * via RMB-fire as before.
   */
  /**
   * Evasion pass — when a projectile is closing on a non-firing unit and
   * predicted to land within `EVADE_DANGER_METERS`, snap a perpendicular
   * sidestep path onto the unit so it juke-walks clear. Sidesteps are gated
   * by `evadeCooldown` so the unit doesn't shimmy every frame, and skipped
   * for units that are actively engaging a target (we don't want a tank to
   * abandon its line-up just because a stray bullet flies past).
   */
  private tickEvade(dt: number): void {
    if (!this.pathfinder) return;
    const projectiles = this.projectiles.projectiles;
    if (projectiles.length === 0) return;
    const nav = this.surfaceNav!;
    for (const u of this.units.units) {
      if (u.hp <= 0) continue;
      if (u.evadeCooldown > 0) {
        u.evadeCooldown = Math.max(0, u.evadeCooldown - dt);
        continue;
      }
      // Dodging makes no sense for diggers / dozers / non-mobile units.
      if (u.kind === 'tunneler' || u.kind === 'worm' || u.kind === 'dozer') continue;
      // Don't break a worker out of a job or a unit that's holding an aim.
      if (u.task.kind !== 'idle') continue;
      if (u.firingTarget) continue;

      const torsoY = u.y + Math.max(0.7, u.widthMeters * 0.6);
      for (const p of projectiles) {
        if (p.dead) continue;
        if (p.ownerId === u.id) continue;
        const dx = u.x - p.x;
        const dy = torsoY - p.y;
        const dz = u.z - p.z;
        const v2 = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
        if (v2 < 1e-3) continue;
        const dot = dx * p.vx + dy * p.vy + dz * p.vz;
        if (dot <= 0) continue; // moving away
        const t = dot / v2;
        if (t > EVADE_LOOKAHEAD_SECONDS) continue;
        const cx = p.x + p.vx * t;
        const cy = p.y + p.vy * t;
        const cz = p.z + p.vz * t;
        const miss2 = (cx - u.x) ** 2 + (cy - torsoY) ** 2 + (cz - u.z) ** 2;
        if (miss2 > EVADE_DANGER_METERS * EVADE_DANGER_METERS) continue;

        // Build a perpendicular sidestep target. Use the projectile's XZ
        // direction; perp = (-vz, vx) / |vxz|.
        const horiz = Math.hypot(p.vx, p.vz) || 1;
        const perpX = -p.vz / horiz;
        const perpZ =  p.vx / horiz;
        const dist = EVADE_DISTANCE_METERS;
        // Bias the sidestep to whichever side is already further from the
        // projectile's forecast path so we don't dive INTO the round.
        const offX = u.x - cx;
        const offZ = u.z - cz;
        const sideSign = (offX * perpX + offZ * perpZ) >= 0 ? 1 : -1;
        const tx = u.x + perpX * dist * sideSign;
        const tz = u.z + perpZ * dist * sideSign;
        const cell = this.surfaceCellAt(tx, tz);
        if (!cell.ok) continue;
        const i = navIndex(cell.cx, cell.cz);
        if (nav.headroom[i]! < u.heightVoxels) continue;
        // Surface Y at the sidestep target.
        const top = nav.topY[i]!;
        if (top < 0) continue;
        const ty = (top + 1) * VOXEL_SIZE;
        u.path = [{ x: tx, y: ty, z: tz }];
        u.blockedFrames = 0;
        u.needsRepath = false;
        u.evadeCooldown = EVADE_REARM_SECONDS;
        break;
      }
    }
  }

  private tickAggressiveStance(dt: number): void {
    const liveUnits = this.units.units.filter(u => u.hp > 0);
    const liveBuildings = this.buildings.buildings.filter(b => !b.destroyed);
    for (const u of this.units.units) {
      if (u.weapon === null) continue;
      if (u.stance !== 'aggressive') continue;
      if (u.firingTarget) continue;
      if (u.burstShotsRemaining > 0) continue;
      if (u.autoEngageCooldown > 0) {
        u.autoEngageCooldown = Math.max(0, u.autoEngageCooldown - dt);
        continue;
      }
      const w = WEAPONS[u.weapon];
      const range2 = w.rangeMeters * w.rangeMeters;

      // Priority targeting: enemy turrets first (highest threat), then
      // cross-team units, then other enemy buildings. We pick the best
      // candidate from each tier and only fall through if the tier is empty.
      // Distance is the tiebreaker inside a tier.
      let bestUnit: Unit | null = null;
      let bestUnitD2 = range2;
      for (const e of liveUnits) {
        if (e.team === u.team) continue;
        const dx = e.x - u.x, dz = e.z - u.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestUnitD2) { bestUnitD2 = d2; bestUnit = e; }
      }
      let bestTurret: Building | null = null;
      let bestTurretD2 = range2;
      let bestBuilding: Building | null = null;
      let bestBuildingD2 = range2;
      for (const b of liveBuildings) {
        if (b.team === u.team) continue;
        const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_METERS;
        const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_METERS;
        const dx = cxw - u.x, dz = czw - u.z;
        const d2 = dx * dx + dz * dz;
        if (b.spec.kind === 'turret') {
          if (d2 < bestTurretD2) { bestTurretD2 = d2; bestTurret = b; }
        } else {
          if (d2 < bestBuildingD2) { bestBuildingD2 = d2; bestBuilding = b; }
        }
      }

      const targetUnit = bestTurret ? null : bestUnit;
      const targetBuilding = bestTurret ?? (bestUnit ? null : bestBuilding);
      if (!targetUnit && !targetBuilding) continue;

      // Pick a torso point to aim at. For unit targets that's the torso
      // sphere centre; for buildings we aim slightly above the floor centre
      // so the round lands on the wall, not the roof.
      let tx: number, ty: number, tz: number;
      let buildingBodyR = 0;
      if (targetUnit) {
        tx = targetUnit.x;
        ty = targetUnit.y + Math.max(0.7, targetUnit.widthMeters * 0.6);
        tz = targetUnit.z;
      } else {
        const b = targetBuilding!;
        tx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        tz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        ty = (b.floorY + Math.min(b.spec.headroomVoxels - 2, 8)) * VOXEL_SIZE;
        buildingBodyR = Math.max(b.spec.cellsW, b.spec.cellsD) * NAV_CELL_METERS * 0.5;
      }
      const cfg = PROJECTILES[w.projectile];
      const explosionR = cfg.explosive ? cfg.explosionRadiusMeters : 0;

      const muzzleX = u.x;
      const muzzleY = u.y + 1.2;
      const muzzleZ = u.z;
      const ddx = tx - muzzleX;
      const ddy = ty - muzzleY;
      const ddz = tz - muzzleZ;
      const dl = Math.hypot(ddx, ddy, ddz) || 1;
      const dirX = ddx / dl, dirY = ddy / dl, dirZ = ddz / dl;
      const points = this.projectiles.predictTrajectory(
        w.projectile,
        muzzleX, muzzleY, muzzleZ,
        dirX, dirY, dirZ,
        this.world,
        0,
        96, 0.06,
        w.velocityScale,
        u.launcherMaxStrength,
      );
      const willHit = targetUnit
        ? arcCoversTarget(points, targetUnit, explosionR)
        : arcCoversPoint(points, tx, ty, tz, buildingBodyR + explosionR);
      if (willHit) {
        u.firingTarget = { x: tx, y: ty, z: tz };
        u.autoEngageCooldown = 0.25;
        continue;
      }
      // Trajectory blocked — reposition to a clear firing spot.
      u.autoEngageCooldown = 0.6;
      if (u.path.length > 0) continue;
      const stopRange = w.rangeMeters * AUTO_ENGAGE_STOP_FRACTION;
      const dxToTarget = tx - u.x;
      const dzToTarget = tz - u.z;
      const distToTarget = Math.hypot(dxToTarget, dzToTarget);
      let goalX: number, goalZ: number;
      if (distToTarget > stopRange) {
        // Beyond firing range — advance toward the target, stopping at stopRange.
        const scale = (distToTarget - stopRange) / distToTarget;
        goalX = u.x + dxToTarget * scale;
        goalZ = u.z + dzToTarget * scale;
      } else {
        // Already within firing range but blocked (e.g. around a corner) —
        // route straight to the target so the path system navigates around
        // the obstruction rather than retreating away from the enemy.
        goalX = tx;
        goalZ = tz;
      }
      void this.routePath(u, goalX, u.y, goalZ);
    }
  }

  /**
   * Hotkey handler for the Y-cutoff overlay. `[` and `]` step the cutoff up /
   * down; `\` disables it. Holding shift quadruples the step. The cutoff is
   * clamped against the world's vertical extent (in meters) so the player
   * can't push it negative or past the sky.
   */
  private adjustHideAboveY(): void {
    const shift = this.input.keys.has('ShiftLeft') || this.input.keys.has('ShiftRight');
    const step = shift ? 4 : 1;
    const minY = 0.5;
    // Default seed when the cutoff is currently disabled but the user wants
    // to start cutting in: drop to roughly the ground we're focused on.
    let v = isFinite(this.hideAboveY) ? this.hideAboveY : 24;
    if (this.input.pressed.has('Backslash')) {
      this.hideAboveY = Infinity;
    } else if (this.input.pressed.has('BracketLeft')) {
      v = Math.max(minY, v - step);
      this.hideAboveY = v;
    } else if (this.input.pressed.has('BracketRight')) {
      v = v + step;
      this.hideAboveY = v;
    }
    this.meshes.setHideAboveY(this.hideAboveY);
  }

  /**
   * Voxel-y ceiling for `raycastVoxel`. Returns the integer voxel index at
   * or above which a column reads as AIR for the picker — i.e. the floor
   * `(hideAboveY / VOXEL_SIZE)`. When the cutoff is disabled, returns
   * `undefined` so the raycast keeps its normal behavior.
   */
  private raycastMaxVoxelY(): number | undefined {
    if (!isFinite(this.hideAboveY)) return undefined;
    return Math.max(0, Math.floor(this.hideAboveY / VOXEL_SIZE));
  }

  private updateProjectileArcs(): void {
    const arcs: { points: { x: number; y: number; z: number }[] }[] = [];
    for (const p of this.projectiles.projectiles) {
      // Prefer the arc captured at spawn (full path, mouth-to-impact). Falls
      // back to a live re-predict for projectiles that were spawned without
      // a world reference (e.g. cluster submunitions deflected mid-flight).
      const points = p.arcPoints.length >= 2
        ? p.arcPoints
        : this.projectiles.predictRemaining(p, this.world, 0, 96, 0.06);
      if (points.length >= 2) arcs.push({ points });
    }
    this.projectileArcs.update(arcs);
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.resize(w, h);
    this.camera.resize(w, h);
    this.pendingPathPreview.setResolution(w, h);
  };
}

function isBuildMode(m: Mode): boolean {
  return m === 'build';
}

/**
 * Global multiplier folded into every terrain `damageSphere` peak that comes
 * from a projectile impact or a player-triggered explosion. Scales the crater
 * down 5× from the historical level so explosions still kill units at full
 * peak (unit damage doesn't read this) but stop chewing huge holes in the
 * map. Per-projectile `terrainDamageScale` is applied on top of this.
 */
const TERRAIN_DAMAGE_GLOBAL_SCALE = 0.2;

/**
 * Half-extent (m) of the AABB handed to {@link Game.requestNavRebuildAround}
 * for any voxel-edit event. Decoupling the nav-refresh window from each
 * weapon's voxel-precise blast radius means every explosion / impact /
 * carve refreshes the same fixed 8 m diameter box on the 1 m nav grid,
 * regardless of how far the actual voxel sphere reached. Keeps refresh
 * cost predictable (~10³ volume cells per event) and removes per-callsite
 * per-weapon math.
 *
 * 4 m radius = 8 m diameter = 8 nav cells. Covers a tank shell's full
 * blast (radius 4 m) and is generous for most other events; very large
 * events (silo at 6 m) leave an outer ring stale until the next refresh
 * rolls over those cells, which is acceptable for a rare player-fired
 * weapon.
 */
const NAV_REFRESH_HALF_EXTENT_METERS = 4.0;
/**
 * Two pending nav-rebuild boxes are merged into one only when they are within
 * this many metres of each other (XZ plane).  Larger values coalesce more
 * boxes (fewer `executeNavRebuildAround` calls) but risk producing a giant
 * merged AABB when workers mine at widely separated ore clusters.  16 m is
 * large enough to group adjacent workers at the same cluster but small enough
 * to keep distant clusters' rebuilds independent.
 */
const NAV_MERGE_PAD = 16;

/**
 * When an aggressive-stance unit decides to walk closer to its target (because
 * the trajectory is blocked), we route to a point this fraction of the unit's
 * weapon range away from the enemy rather than to the enemy itself. Keeps the
 * unit at a useful firing distance instead of parking on the enemy's feet.
 */
const AUTO_ENGAGE_STOP_FRACTION = 0.7;

/**
 * Evasion tuning. We project each live projectile to its closest approach to
 * each non-engaged unit; if the predicted miss distance is within
 * `EVADE_DANGER_METERS` and the time-to-closest-approach is shorter than
 * `EVADE_LOOKAHEAD_SECONDS`, the unit kicks a perpendicular sidestep of
 * `EVADE_DISTANCE_METERS`. After dodging, `EVADE_REARM_SECONDS` of cooldown
 * stops the same unit from juking on every frame while it's still under fire.
 */
const EVADE_DANGER_METERS = 3.0;
const EVADE_LOOKAHEAD_SECONDS = 1.4;
const EVADE_DISTANCE_METERS = 2.5;
const EVADE_REARM_SECONDS = 1.2;

/**
 * Decide whether a sampled trajectory `points` would actually affect `target`.
 * For explosive rounds we treat the last sample (impact location) as the
 * blast centre and check the target sits inside an extended explosion radius
 * (target body + explosion). For direct-fire rounds we walk every segment
 * and accept the line if it passes through the target's body sphere.
 *
 * Used by both the unit aggressive-stance pipeline and (in spirit) the
 * building turret hittability gate — they share the same shape because the
 * gameplay intent is identical: don't waste shots that won't reach.
 */
function arcCoversTarget(
  points: { x: number; y: number; z: number }[],
  target: Unit,
  explosionRadiusMeters: number,
): boolean {
  if (points.length < 2) return false;
  const tx = target.x;
  const ty = target.y + Math.max(0.7, target.widthMeters * 0.6);
  const tz = target.z;
  const bodyR = target.widthMeters * 0.55 + 0.35;
  if (explosionRadiusMeters > 0) {
    const r = explosionRadiusMeters + bodyR;
    for (const p of points) {
      const d = Math.hypot(p.x - tx, p.y - ty, p.z - tz);
      if (d <= r) return true;
    }
    return false;
  }
  const r2 = bodyR * bodyR;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
    const ssq = sx * sx + sy * sy + sz * sz;
    if (ssq < 1e-8) continue;
    const txa = tx - a.x, tya = ty - a.y, tza = tz - a.z;
    let t = (txa * sx + tya * sy + tza * sz) / ssq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = a.x + sx * t, cy = a.y + sy * t, cz = a.z + sz * t;
    const dxs = cx - tx, dys = cy - ty, dzs = cz - tz;
    if (dxs * dxs + dys * dys + dzs * dzs <= r2) return true;
  }
  return false;
}

/**
 * Variant of `arcCoversTarget` for non-unit targets: takes a point and a
 * sphere radius. Used by the aggressive-stance pipeline when the target is a
 * building (no Unit struct available).
 */
function arcCoversPoint(
  points: { x: number; y: number; z: number }[],
  tx: number, ty: number, tz: number,
  bodyR: number,
): boolean {
  if (points.length < 2) return false;
  const r2 = bodyR * bodyR;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
    const ssq = sx * sx + sy * sy + sz * sz;
    if (ssq < 1e-8) continue;
    const txa = tx - a.x, tya = ty - a.y, tza = tz - a.z;
    let t = (txa * sx + tya * sy + tza * sz) / ssq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = a.x + sx * t, cy = a.y + sy * t, cz = a.z + sz * t;
    const dxs = cx - tx, dys = cy - ty, dzs = cz - tz;
    if (dxs * dxs + dys * dys + dzs * dzs <= r2) return true;
  }
  return false;
}
