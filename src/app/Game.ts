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
import { syncTreeMask } from '../path/VolumeGrid';
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
  unitConfig, UNIT_KINDS, UNIT_POP_COST, UNIT_THREAT, Team,
} from '../sim/Units';
import { UnitRenderer } from '../render/UnitRenderer';
import {
  trackDamageFor,
  M_DIRT, M_WOOD, M_LEAF, M_METAL, M_FARM,
  M_GRASS, M_STONE, M_PATH, M_MUD,
} from '../voxel/Materials';
import type { MaterialId } from '../voxel/types';
import { BuildingManager, BARRACKS, STORAGE, HQ, ALL_BUILDINGS, BuildingSpec, Building, checkFootprint, buildingThreatLevel, doorWorldPos } from '../sim/Buildings';
import { BuildingGhost } from '../render/BuildingGhost';
import { ConstructionOverlay } from '../render/ConstructionOverlay';
import { BuildingRenderer } from '../render/BuildingRenderer';
import { BuildingRangeIndicator } from '../render/BuildingRangeIndicator';
import { UnitRangeIndicator } from '../render/UnitRangeIndicator';
import { PathPreview } from '../render/PathPreview';
import { PendingPathPreview } from '../render/PendingPathPreview';
import { ProcessingBoxOverlay, ProcessBox } from '../render/ProcessingBoxOverlay';
import { TargetMarker } from '../render/TargetMarker';
import { Resources } from '../sim/Resources';
import { SaplingManager } from '../sim/Saplings';
import { LeafDecay } from '../sim/LeafDecay';
import { CivilianSystem } from '../sim/Civilians';
import { RemoteAIClient } from '../sim/RemoteAIClient';
import { tickWorkers, approachPos, WORKER_CHOP_REACH_M } from '../sim/Workers';
import { tickSupplyTrucks } from '../sim/SupplyTrucks';
import { PathTracer } from '../sim/PathTracer';
import { WorkerTaskBoard, describeOrder } from '../sim/WorkerTasks';
import { ProjectileManager, PROJECTILES, PROJECTILE_GRAVITY, muzzleOrigin, ProjectileImpact } from '../sim/Projectiles';
import { WEAPONS, WeaponKind } from '../sim/Weapons';
import { tickWeapons } from '../sim/WeaponTick';
import {
  ProjectileRenderer, FlashPool, ImpactRingPool, TrajectoryPreview, ImpactMarker,
  ProjectileArcPool,
} from '../render/ProjectileRenderer';
import { HealthBarRenderer } from '../render/HealthBarRenderer';
import { RallyMarkerRenderer } from '../render/RallyMarker';
import { MinimapRenderer } from '../render/MinimapRenderer';
import { PowerLineRenderer } from '../render/PowerLineRenderer';
import { MetalCluster, METAL_PER_VOXEL } from '../voxel/Metals';
import {
  ActionContext, BuildingAction, UnitAction,
  buildingActionsFor, unitActionsFor,
} from './Actions';
import { makeUnitPortraitButton, makeUnitPortraitTile, makeBuildingPortraitTile, makeUpgradePortraitButton } from './Portraits';
import { upgradeOptionById } from '../sim/Buildings';

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
  readonly constructionOverlay = new ConstructionOverlay();
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
  /** Per-AI-faction resource pools, mirroring the player's. Each AI
   *  team accumulates/spends out of its own pool so two AI factions
   *  actually compete for resources rather than sharing one bank
   *  (which lets the more-efficient AI starve the other). */
  readonly enemyResources = new Resources();
  readonly enemy2Resources = new Resources();
  /** Map team name → its Resources pool. Centralised so worker /
   *  truck / foodSink lookups don't have to branch on every team. */
  resourcesForTeam(team: import('../sim/Buildings').BuildingTeam): Resources {
    if (team === 'enemy') return this.enemyResources;
    if (team === 'enemy2') return this.enemy2Resources;
    return this.resources;
  }
  readonly saplings = new SaplingManager();
  readonly taskBoard = new WorkerTaskBoard();
  readonly leafDecay = new LeafDecay();
  readonly civilians = new CivilianSystem();
  /** Bridge to the standalone AI server (`ai-server.cjs`). When the
   *  server is offline this stays dormant — the rest of the game works
   *  unchanged. */
  readonly aiClient = new RemoteAIClient();
  /** How many AI opponents to seed at game start. Set by main.ts from
   *  the lobby's `aiCount` setting before `generate()` runs. */
  numAi = 1;
  /** Phase 2 of the zero-trust migration: when true, every spawned
   *  unit is mirrored into the authoritative `game-server` and its
   *  position is reconciled against the server's snapshot every
   *  frame. Off by default until `attachAuthoritativeServer` runs so
   *  legacy single-player paths keep working. */
  zeroTrustEnabled = false;
  /** The authoritative-server bridge (set by main.ts). Null when the
   *  game is running in pure single-player mode. */
  gameClient: import('../net/GameClient').GameClient | null = null;
  /** Mirrors authoritative voxel-edit deltas from the server into the
   *  local voxel buffer. Lazy-loaded inside `attachAuthoritativeServer`
   *  so the import only fires when zero-trust mode is on. */
  private voxelEditMirror: import('../net/VoxelEditMirror').VoxelEditMirror | null = null;
  /** Throttle for the periodic mirror-push of building state +
   *  resources. Pushed at this interval rather than on every change
   *  because building HP / resources tick at 60 Hz and we don't need
   *  the network volume that implies. */
  private bridgePushTimer = 0;
  private static readonly BRIDGE_PUSH_INTERVAL_S = 0.5;
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
  readonly minimap = new MinimapRenderer();
  readonly powerLines = new PowerLineRenderer();
  /** Off by default; enabled with `?trace=1` query param. Records every unit's
   *  position over time and dumps a top-down PNG on page-unload so the user
   *  can verify pathfinding visually. */
  readonly pathTracer = new PathTracer();
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
  private resFoodEl: HTMLElement | null = null;
  private resMetalsEl: HTMLElement | null = null;
  private resWoodEl: HTMLElement | null = null;
  private resPopEl: HTMLElement | null = null;
  private ageMedallionEl: HTMLElement | null = null;
  private ageNameEl: HTMLElement | null = null;
  private ageTimeEl: HTMLElement | null = null;
  private selPanelEl: HTMLElement | null = null;
  private selPortraitEl: HTMLElement | null = null;
  private selNameEl: HTMLElement | null = null;
  private selSubEl: HTMLElement | null = null;
  private selStatsEl: HTMLElement | null = null;
  private selRenderedKey = '';
  private gameElapsedSeconds = 0;
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
   * actually visible underneath.
   *
   * Defaults to the world's top in metres so `[` immediately steps a metre
   * below the highest possible voxel — the player sees the full map until
   * they start trimming. `]` raises the cutoff back toward the world top
   * (clamped); `\` resets it to the world top (= effectively no cut).
   */
  private hideAboveY = WORLD_Y * VOXEL_SIZE;
  /** Fog-of-war: chunk fragments outside every player unit / building
   *  sphere are discarded. Default unit radius is 100-voxel diameter
   *  → 50-voxel radius → 6.25 m at the world's 0.125 m/voxel.
   *  Building radius is per-kind, computed from the building's
   *  footprint half-diagonal + a per-kind sight bonus so a 6×6 HQ
   *  reveals its full footprint plus a generous ring around it. */
  fowEnabled = true;
  fowUnitRadiusMeters = 50 * VOXEL_SIZE;
  /** Per-kind sight bonus (cells = metres at NAV_CELL_METERS = 1)
   *  added on top of each building's footprint half-diagonal. Tuned
   *  to match `SIGHT_RADIUS_BY_BUILDING_KIND` on the server so the
   *  visual disc roughly matches the server's per-viewer entity
   *  visibility filter. */
  static readonly FOW_BUILDING_SIGHT_BY_KIND: Record<string, number> = {
    hq: 42, barracks: 18, vehicle_depot: 18, farm: 10,
    neighborhood: 16, storage: 16,
  };
  /** Reused flat (x, y, z, radius) Float32Array for FoW vision
   *  sources. Capacity matches ChunkMeshRegistry.MAX_FOW_SOURCES to
   *  avoid per-frame growth; only the prefix [0..4*count) is
   *  meaningful each frame. */
  private fowFlatBuf = new Float32Array(ChunkMeshRegistry.MAX_FOW_SOURCES * 4);
  /** Sticky 1-byte-per-cell map: a bit is set the first time any
   *  player vision source covers that XZ nav cell, and never cleared.
   *  Drives the chunk shader's "was seen → grey fog" branch. The
   *  matching THREE.DataTexture wraps this buffer directly so the
   *  GPU sees writes after we flag `needsUpdate`. Sized to
   *  NAV_W × NAV_H. */
  private exploredXZ = new Uint8Array(NAV_W * NAV_H);
  private exploredTex: THREE.DataTexture | null = null;
  private exploredDirty = false;
  /** Per-frame visibility test: world XZ → currently inside any FoW
   *  source. Used to hide enemy units / buildings that the player has
   *  no live vision on. The matching `fowSourcePackedXyzR` array is a
   *  rebuild of `fowFlatBuf` snapshotted at the end of each frame's
   *  pack so probe code, unit renderer, etc can query the same set. */
  private currentFowFlat = new Float32Array(ChunkMeshRegistry.MAX_FOW_SOURCES * 4);
  private currentFowCount = 0;
  private readonly explosionRadiusBigMeters = 3.0;
  private readonly explosionPeak = 90;

  /**
   * Returns true when world position (wx, wz) is inside any of the
   * player's current vision spheres. Caller decides what y to use; we
   * test against the source's recorded y so a worker on the surface
   * doesn't reveal a unit hovering 30 m above. Cheap O(MAX_FOW_SOURCES).
   */
  isInsideCurrentFoW(wx: number, wy: number, wz: number): boolean {
    const buf = this.currentFowFlat;
    const n = this.currentFowCount;
    for (let i = 0; i < n; i++) {
      const sx = buf[i * 4]!;
      const sy = buf[i * 4 + 1]!;
      const sz = buf[i * 4 + 2]!;
      const rsq = buf[i * 4 + 3]!;
      const dx = wx - sx, dy = wy - sy, dz = wz - sz;
      if (dx * dx + dy * dy + dz * dz <= rsq) return true;
    }
    return false;
  }

  /**
   * Per-frame: pack the player's live vision sources (units +
   * buildings) into the FoW uniform buffer, push to the chunk
   * material, snapshot for cross-system queries, and OR each source's
   * XZ disc into the sticky `exploredXZ` bitmap. The snapshot's
   * `.w` slot holds radius² so subsequent distance tests in
   * `isInsideCurrentFoW` skip the per-source square.
   */
  private packFoWAndExplored(): void {
    const cap = ChunkMeshRegistry.MAX_FOW_SOURCES;
    const buf = this.fowFlatBuf;
    let n = 0;
    for (const u of this.units.units) {
      if (u.team !== 'player') continue;
      if (u.hp <= 0) continue;
      if (n >= cap) break;
      const i = n * 4;
      buf[i] = u.x;
      buf[i + 1] = u.y + 0.5;
      buf[i + 2] = u.z;
      buf[i + 3] = this.fowUnitRadiusMeters;
      n++;
    }
    for (const b of this.buildings.buildings) {
      if (b.team !== 'player') continue;
      if (b.destroyed) continue;
      if (n >= cap) break;
      const i = n * 4;
      const cellsW = b.spec.cellsW;
      const cellsD = b.spec.cellsD;
      const cx = (b.ox + cellsW * 0.5) * NAV_CELL_METERS;
      const cz = (b.oz + cellsD * 0.5) * NAV_CELL_METERS;
      const cy = (b.floorY + 4) * VOXEL_SIZE;
      const halfDiag = Math.hypot(cellsW * 0.5, cellsD * 0.5) * NAV_CELL_METERS;
      const sight = Game.FOW_BUILDING_SIGHT_BY_KIND[b.spec.kind] ?? 14;
      buf[i] = cx;
      buf[i + 1] = cy;
      buf[i + 2] = cz;
      buf[i + 3] = halfDiag + sight;
      n++;
    }
    this.meshes.setFow(this.fowEnabled, buf, n);

    // Snapshot the packed sources with `w` swapped from radius to
    // radius² so `isInsideCurrentFoW` can do a single dot-vs-rsq
    // compare per source instead of squaring inside the loop.
    this.currentFowCount = n;
    for (let i = 0; i < n; i++) {
      const r = buf[i * 4 + 3]!;
      this.currentFowFlat[i * 4]     = buf[i * 4]!;
      this.currentFowFlat[i * 4 + 1] = buf[i * 4 + 1]!;
      this.currentFowFlat[i * 4 + 2] = buf[i * 4 + 2]!;
      this.currentFowFlat[i * 4 + 3] = r * r;
    }

    if (this.fowEnabled && this.exploredTex) {
      const map = this.exploredXZ;
      let dirty = false;
      for (let s = 0; s < n; s++) {
        const sx = buf[s * 4]!;
        const sz = buf[s * 4 + 2]!;
        const r = buf[s * 4 + 3]!;
        const r2 = r * r;
        const cxF = sx / NAV_CELL_METERS;
        const czF = sz / NAV_CELL_METERS;
        const rCell = Math.ceil(r / NAV_CELL_METERS) + 1;
        const cx0 = Math.max(0, Math.floor(cxF - rCell));
        const cx1 = Math.min(NAV_W - 1, Math.floor(cxF + rCell));
        const cz0 = Math.max(0, Math.floor(czF - rCell));
        const cz1 = Math.min(NAV_H - 1, Math.floor(czF + rCell));
        for (let cz = cz0; cz <= cz1; cz++) {
          const wcz = (cz + 0.5) * NAV_CELL_METERS;
          const dz = wcz - sz;
          for (let cx = cx0; cx <= cx1; cx++) {
            const wcx = (cx + 0.5) * NAV_CELL_METERS;
            const dx = wcx - sx;
            if (dx * dx + dz * dz > r2) continue;
            const idx = cz * NAV_W + cx;
            if (map[idx] === 0) {
              map[idx] = 255;
              dirty = true;
            }
          }
        }
      }
      if (dirty) this.exploredTex.needsUpdate = true;
    }
  }

  constructor(canvas: HTMLCanvasElement, statsEl: HTMLElement | null) {
    // Relay console.log / console.warn / console.error to the local log
    // server so terminal monitoring works.
    const relay = (prefix: string, args: unknown[]): void => {
      const line = prefix + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
      navigator.sendBeacon('http://localhost:4444/log', line);
    };
    const _log = console.log.bind(console);
    const _warn = console.warn.bind(console);
    const _err = console.error.bind(console);
    console.log = (...args) => { _log(...args); relay('', args); };
    console.warn = (...args) => { _warn(...args); relay('WARN ', args); };
    console.error = (...args) => { _err(...args); relay('ERROR ', args); };

    this.renderer = new Renderer(canvas);
    this.camera = new RTSCamera();
    this.input = new Input();
    this.input.attach(window);

    // Path-trace mode: `?trace=1` records every unit's positions and dumps a
    // PNG on unload. Bound here because the listener must be installed
    // synchronously during the first frame so a refresh-while-loading dumps
    // whatever was captured.
    const traceParam = new URLSearchParams(window.location.search).get('trace');
    if (traceParam === '1' || traceParam === 'true') {
      this.pathTracer.enabled = true;
      const dump = () => {
        if (!this.pathTracer.enabled) return;
        const wx = WORLD_X * VOXEL_SIZE;
        const wz = WORLD_Z * VOXEL_SIZE;
        // Beacon the PNG to log-server (writes to /tmp on disk) — reliable
        // even when the page is unloading. Also kick off a download as a
        // user-visible fallback; browsers may suppress this from beforeunload
        // but it works when triggered manually via the console.
        this.pathTracer.saveViaBeacon(wx, wz);
        this.pathTracer.saveAsDownload(wx, wz);
      };
      window.addEventListener('beforeunload', dump);
      window.addEventListener('pagehide', dump);
      // Expose for manual triggering from devtools console.
      (window as unknown as { savePathTrace: () => void }).savePathTrace = dump;
    }

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
    this.renderer.scene.add(this.constructionOverlay.group);
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
    this.renderer.scene.add(this.powerLines.group);
    this.ghost.setSpec(this.buildSpec);

    this.exploredTex = new THREE.DataTexture(
      this.exploredXZ, NAV_W, NAV_H, THREE.RedFormat, THREE.UnsignedByteType,
    );
    this.exploredTex.minFilter = THREE.LinearFilter;
    this.exploredTex.magFilter = THREE.LinearFilter;
    this.exploredTex.wrapS = THREE.ClampToEdgeWrapping;
    this.exploredTex.wrapT = THREE.ClampToEdgeWrapping;
    this.exploredTex.needsUpdate = true;
    const worldExtentX = NAV_W * NAV_CELL_METERS;
    const worldExtentZ = NAV_H * NAV_CELL_METERS;
    this.meshes.setExplored(true, this.exploredTex, worldExtentX, worldExtentZ);

    this.buildings.spawner = (kind, x, y, z, b): Unit | null => this.spawnUnit(kind, x, y, z, b.team);
    this.buildings.popHasRoom = (kind, b): boolean => {
      // Every team — player, enemy, enemy2 — is rate-gated by its own
      // population cap. The cap comes from neighborhoods (via the
      // civilians they spawn); no other building type contributes.
      const cost = UNIT_POP_COST[kind] ?? 1;
      let used = 0;
      for (const u of this.units.units) {
        if (u.team !== b.team || u.hp <= 0) continue;
        used += UNIT_POP_COST[u.kind] ?? 1;
      }
      const cap = this.resourcesForTeam(b.team).popCap ?? 0;
      return used + cost <= cap;
    };
    this.buildings.afterSpawn = (unit, building): void => {
      if (!building.rallyPoint) return;
      const rp = building.rallyPoint;
      if (unit.weapon !== null) unit.stance = building.rallyStance;
      void this.routePath(unit, rp.x, rp.y, rp.z, { forceSurface: true });
    };
    // Farms feed the resource counter via the manager's foodSink hook so the
    // sim doesn't have to know about Resources directly. Routes food to
    // the producing farm's team so an enemy farm fills the AI's pool.
    this.buildings.foodSink = (amount, b): void => {
      this.resourcesForTeam(b.team).food += amount;
    };
    // Buildings with weapons (turret, silo) drop their projectiles into the
    // shared manager and route their muzzle flashes into the same FlashPool
    // unit shots use, so the visual feels uniform.
    this.buildings.projectiles = this.projectiles;
    this.buildings.onBuildingMuzzleFlash = (x, y, z, radius, life, color): void => {
      this.muzzleFlashes.spawn(x, y, z, radius, life, color.r, color.g, color.b);
    };
    // Mark each building's footprint as off-limits in the path system so units
    // never path on top of a roof or through the interior; clear the mask on
    // destruction so rubble becomes traversable again. The mask lives on the
    // shared VolumeGrid (SAB) so the path worker sees the same bits.
    this.buildings.onBuildingPlaced = (b): void => this.applyBuildingFootprintMask(b, true);
    this.buildings.onBuildingDestroyed = (b): void => this.applyBuildingFootprintMask(b, false);
    // Destruction-ring explosions: fired several times per killed building.
    // Carve voxels via the same `damageSphere` path projectiles use, and
    // spawn a flash so the player sees each pop. We also rebuild nav
    // around the affected area so units immediately path through the
    // freshly-blown rubble.
    this.buildings.onBuildingExplosion = (vx, vy, vz, radiusVoxels, peakDamage): void => {
      const result = this.world.damageSphere(vx, vy, vz, radiusVoxels, peakDamage);
      const cx = vx * VOXEL_SIZE;
      const cy = vy * VOXEL_SIZE;
      const cz = vz * VOXEL_SIZE;
      const flashR = radiusVoxels * VOXEL_SIZE * 1.2;
      this.impactFlashes.spawn(cx, cy, cz, flashR, 0.28, 1.0, 0.55, 0.20);
      this.muzzleFlashes.spawn(cx, cy, cz, flashR * 0.55, 0.10, 1.0, 0.85, 0.45);
      // Refresh nav around the crater so units stop pathing through the
      // wreckage on stale data. AABB widened by the blast radius + 2 m so
      // the surface nav passes pick up the new topY readings.
      const r = radiusVoxels * VOXEL_SIZE + 2.0;
      this.requestNavRebuildAround(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r, false);
      void result;
    };

    this.fpsEl = statsEl;
    this.modeEl = document.getElementById('mode');
    this.selBoxEl = document.getElementById('selbox');
    this.actionsEl = document.getElementById('actions');
    this.tasksEl = document.getElementById('tasks');
    this.pathInfoEl = document.getElementById('pathinfo');
    this.resFoodEl   = document.getElementById('res-food');
    this.resMetalsEl = document.getElementById('res-metals');
    this.resWoodEl   = document.getElementById('res-wood');
    this.resPopEl    = document.getElementById('res-pop');
    this.ageMedallionEl = document.getElementById('age-medallion');
    this.ageNameEl      = document.getElementById('age-name');
    this.ageTimeEl      = document.getElementById('age-time');
    this.selPanelEl     = document.getElementById('selection-panel');
    this.selPortraitEl  = document.getElementById('sel-portrait');
    this.selNameEl      = document.getElementById('sel-name');
    this.selSubEl       = document.getElementById('sel-sub');
    this.selStatsEl     = document.getElementById('sel-stats');
    // Dock the minimap inside the bottom-bar slot. Fall back to <body> if the
    // slot is missing so existing unit tests / older HTML still work.
    const miniSlot = document.getElementById('bottombar-mini');
    (miniSlot ?? document.body).appendChild(this.minimap.canvas);
    this.minimap.onPan((wx, wz) => { this.camera.target.set(wx, 0, wz); });

    this.onResize();
    window.addEventListener('resize', this.onResize);
  }

  async generate(
    seed: number,
    onProgress?: (done: number, total: number) => void,
    /** Pluggable worldgen source. Default is the local browser pipeline
     *  (`src/voxel/WorldGen.ts:generateWorld`). Phase 6d wires
     *  `streamWorldFromServer` here when the lobby launches with
     *  `?streamWorld=1`. */
    provider?: (world: VoxelWorld, seed: number, onProgress?: (p: { done: number; total: number }) => void) => Promise<MetalCluster[]>,
  ): Promise<void> {
    const gen = provider ?? generateWorld;
    this.metalClusters = await gen(this.world, seed, p => onProgress?.(p.done, p.total));
    const useShared = sharedBuffersAvailable();
    // Surface projection — used by buildings, render code, Y-snap. Independent
    // of the per-unit-type 3D pathfinding grids below.
    this.surfaceNav = allocateNav(useShared);
    buildSurfaceNav(this.world.buffers.voxels, this.surfaceNav);
    // Pathfinder is allocated below — defer the treeMask sync until after.
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
    // Mirror SurfaceNav's tree-blocked columns into the volume grid so unit
    // grids reject any cy in a tree column for non-diggers (they walk at
    // surface Y; a path "above the canopy" is unreachable in practice).
    syncTreeMask(this.pathfinder.volume, this.surfaceNav.treeBlocked, 0, 0, NAV_W - 1, NAV_H - 1);
    this.pathfinder.rebuildAllUnitGrids();
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
    this.minimap.buildTerrain(this.world.buffers.voxels);
    this.spawnInitialUnits();
  }

  /**
   * Search a square window of `radius` nav cells around (cx, cz) for the
   * unblocked cell with the highest `flatness`. Falls back to the
   * window centre when every cell in the window is blocked, so the
   * caller still has a coordinate to feed into `checkFootprint`.
   */
  private findFlatSpawnCell(cx: number, cz: number, radius: number): { cx: number; cz: number } {
    const nav = this.surfaceNav!;
    let best = { cx, cz };
    let bestFlat = -1;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= NAV_W || z >= NAV_H) continue;
        const i = navIndex(x, z);
        if (nav.blocked[i]) continue;
        const f = nav.flatness[i]!;
        if (f > bestFlat) { bestFlat = f; best = { cx: x, cz: z }; }
      }
    }
    return best;
  }

  private spawnInitialUnits(): void {
    if (!this.pathfinder) return;
    const nav = this.surfaceNav!;
    // Pick the player's spawn cell from the NW corner of the map. The
    // enemy HQ ends up in the opposite (SE) corner via `placeEnemyHQ`,
    // so the two factions start at the long-diagonal extremes.
    const found = this.findFlatSpawnCell(
      Math.floor(NAV_W * 0.10),
      Math.floor(NAV_H * 0.10),
      Math.floor(NAV_W * 0.20),
    );
    const c = navCenter(nav, found.cx, found.cz);
    // Six workers to seed the economy loop, mirroring the AI seed:
    //   - 2 auto, 2 farm (food economy), 2 chop (wood for builds).
    // Per game rule, only farm-focus workers can tend farm plots.
    const playerSeed: Array<{ pos: [number, number, number]; focus: 'auto' | 'farm' | 'chop' }> = [
      { pos: [c.x - 2.0, c.y, c.z + 1.0], focus: 'auto' },
      { pos: [c.x - 2.5, c.y, c.z - 1.0], focus: 'auto' },
      { pos: [c.x - 1.5, c.y, c.z + 2.5], focus: 'farm' },
      { pos: [c.x + 2.0, c.y, c.z + 1.0], focus: 'farm' },
      { pos: [c.x + 2.5, c.y, c.z - 1.0], focus: 'chop' },
      { pos: [c.x + 1.5, c.y, c.z - 2.5], focus: 'chop' },
    ];
    for (const { pos, focus } of playerSeed) {
      const w = this.spawnWorker(pos[0], pos[1], pos[2]);
      if (w) w.workerFocus = focus;
    }

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
      const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, STORAGE, ox, oz, this.buildings.buildings);
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
    // Place the HQ. Try a ring of offsets further out so it doesn't overlap units.
    const hqOffsets: [number, number][] = [[-8, 0], [8, 0], [0, -8], [0, 8], [-8, -8], [8, 8]];
    for (const [dx, dz] of hqOffsets) {
      const ox = Math.max(0, Math.min(NAV_W - HQ.cellsW, startCx + dx - (HQ.cellsW >> 1)));
      const oz = Math.max(0, Math.min(NAV_H - HQ.cellsD, startCz + dz - (HQ.cellsD >> 1)));
      const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, HQ, ox, oz, this.buildings.buildings);
      if (fp.ok) {
        this.buildings.place(this.world, HQ, ox, oz, fp.floorY);
        const pad = NAV_CELL_METERS;
        const bx0 = ox * NAV_CELL_METERS;
        const bz0 = oz * NAV_CELL_METERS;
        const bx1 = (ox + HQ.cellsW) * NAV_CELL_METERS;
        const bz1 = (oz + HQ.cellsD) * NAV_CELL_METERS;
        const by0 = fp.floorY * VOXEL_SIZE;
        const by1 = (fp.floorY + HQ.headroomVoxels + 4) * VOXEL_SIZE;
        this.requestNavRebuildAround(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad, false);
        break;
      }
    }

    // Place enemy bases on the opposite side of the map. The lobby
    // sets `numAi`; we lay one HQ down at each pre-defined "AI corner"
    // until the count is satisfied. If every candidate footprint
    // fails on a particular spot (rare on rough terrain) we just
    // skip — the EnemyAI tick is a no-op when no enemy HQ is alive.
    this.placeEnemyBases(this.numAi);

    this.camera.target.set(c.x, 0, c.z);
    // Compute power-line routes now that HQ is placed.
    this.recomputePowerLinePaths();

    // Seed the economy so the player can queue units immediately.
    this.resources.food    = 200;
    this.resources.metals  = 100;
    this.resources.wood    = 100;
  }

  /**
   * Find a flat cell roughly 60 % of the map diagonal away from the
   * player's spawn and stamp an enemy HQ there. Falls back through
   * progressively closer offsets so worlds with extreme terrain still
   * end up with a valid enemy footprint somewhere.
   */
  /** Pre-defined AI corner / edge anchors expressed as fractions of the
   *  nav grid. We pick the first `count` of these — they're sorted by
   *  distance from the player's NW spawn, so a 1-AI game gets the
   *  classic SE diagonal opponent and adding more AIs spreads them
   *  around the perimeter. The list is long enough (8 entries) for
   *  the `MAX_AI = 7` cap the lobby surfaces. */
  private static AI_BASE_RATIOS: ReadonlyArray<readonly [number, number]> = [
    [0.90, 0.90],
    [0.90, 0.10],
    [0.10, 0.90],
    [0.90, 0.50],
    [0.50, 0.90],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.65, 0.65],
  ];

  private placeEnemyBases(count: number): void {
    if (!this.surfaceNav || count <= 0) return;
    const search = Math.max(8, Math.floor(NAV_W * 0.10));
    for (let i = 0; i < Math.min(count, Game.AI_BASE_RATIOS.length); i++) {
      const [rx, rz] = Game.AI_BASE_RATIOS[i]!;
      const targetCx = Math.floor(NAV_W * rx);
      const targetCz = Math.floor(NAV_H * rz);
      const best = this.findFlatSpawnCell(targetCx, targetCz, search);
      const offsets: [number, number][] = [
        [0, 0], [-4, 0], [4, 0], [0, -4], [0, 4],
        [-8, 0], [8, 0], [0, -8], [0, 8],
        [-8, -8], [8, 8], [-8, 8], [8, -8],
      ];
      // Alternate teams so multiple AIs are hostile to each other.
      // Index 0 is plain 'enemy' (the legacy single-AI team), index 1+
      // becomes 'enemy2'. The targeting pass already keys off
      // `team !== mine.team` so any pair across these labels engages.
      const baseTeam: Team = i % 2 === 0 ? 'enemy' : 'enemy2';
      let placed = false;
      for (const [dx, dz] of offsets) {
        const ox = Math.max(0, Math.min(NAV_W - HQ.cellsW, best.cx + dx - (HQ.cellsW >> 1)));
        const oz = Math.max(0, Math.min(NAV_H - HQ.cellsD, best.cz + dz - (HQ.cellsD >> 1)));
        const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, HQ, ox, oz, this.buildings.buildings);
        if (!fp.ok) continue;
        this.buildings.place(this.world, HQ, ox, oz, fp.floorY, { team: baseTeam });
        const pad = NAV_CELL_METERS;
        const bx0 = ox * NAV_CELL_METERS;
        const bz0 = oz * NAV_CELL_METERS;
        const bx1 = (ox + HQ.cellsW) * NAV_CELL_METERS;
        const bz1 = (oz + HQ.cellsD) * NAV_CELL_METERS;
        const by0 = fp.floorY * VOXEL_SIZE;
        const by1 = (fp.floorY + HQ.headroomVoxels + 4) * VOXEL_SIZE;
        this.requestNavRebuildAround(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad, false);
        this.seedEnemyEconomy(ox, oz, fp.floorY, baseTeam);
        placed = true;
        break;
      }
      if (!placed) {
        // Couldn't fit a base at this anchor — log and skip; remaining
        // AIs still get their shot at later anchors.
        console.warn(`[ai] could not place enemy HQ #${i + 1} at (${rx}, ${rz})`);
      }
    }
  }

  /**
   * Stamp an enemy storage near the just-placed enemy HQ and spawn the
   * starter worker squad. Mirrors the player's `spawnInitialUnits`
   * starter kit so the AI begins with a comparable economy.
   *
   * The storage gets a try-list of cardinal offsets just like the
   * player's. If every footprint fails on rough terrain we silently
   * skip — the AI can still build later, the workers will just stand
   * idle until a delivery target exists.
   */
  private seedEnemyEconomy(hqOx: number, hqOz: number, hqFloorY: number, baseTeam: Team = 'enemy'): void {
    if (!this.surfaceNav) return;
    const startCx = hqOx + (HQ.cellsW >> 1);
    const startCz = hqOz + (HQ.cellsD >> 1);
    const offsets: [number, number][] = [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, -4]];
    for (const [dx, dz] of offsets) {
      const ox = Math.max(0, Math.min(NAV_W - STORAGE.cellsW, startCx + dx - (STORAGE.cellsW >> 1)));
      const oz = Math.max(0, Math.min(NAV_H - STORAGE.cellsD, startCz + dz - (STORAGE.cellsD >> 1)));
      const fp = checkFootprint(this.world.buffers.voxels, this.surfaceNav!, STORAGE, ox, oz, this.buildings.buildings);
      if (!fp.ok) continue;
      this.buildings.place(this.world, STORAGE, ox, oz, fp.floorY, { team: baseTeam });
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
    // Spawn 4 enemy workers a couple of cells off the HQ door so they
    // don't collide with the structure's footprint at frame 0. Two are
    // dedicated farmers (focus = 'farm') so the AI's farms get tended
    // and harvested without the brain having to issue per-worker
    // commands. The other two stay on auto so they keep grinding the
    // metal economy.
    const cxw = (hqOx + HQ.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const czw = (hqOz + HQ.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
    const halfW = HQ.cellsW * NAV_CELL_VOXELS * VOXEL_SIZE * 0.5;
    // Six AI workers per base, dedicated by focus:
    //   - 2 auto (mine ore by default, opportunistic plant orders)
    //   - 2 chop (wood for barracks/farms)
    //   - 2 farm (per game rule, only farm-focus workers can tend
    //     plots; without dedicated farmers the food economy stalls
    //     at the 20% milestone forever)
    const seed: Array<{ wx: number; wz: number; focus: 'auto' | 'farm' | 'chop' | 'mine' }> = [
      { wx: cxw + halfW + 2, wz: czw - 2, focus: 'auto' },
      { wx: cxw + halfW + 2, wz: czw + 2, focus: 'auto' },
      { wx: cxw + halfW + 4, wz: czw - 1, focus: 'farm' },
      { wx: cxw + halfW + 4, wz: czw + 1, focus: 'farm' },
      { wx: cxw + halfW + 3, wz: czw - 3, focus: 'chop' },
      { wx: cxw + halfW + 3, wz: czw + 3, focus: 'chop' },
    ];
    for (const { wx, wz, focus } of seed) {
      const wy = this.surfaceWorldY(wx, wz);
      const safe = this.safeSpawnXZ(wx, wz);
      const w = this.units.spawn('worker', safe.x, wy, safe.z, { team: baseTeam, stance: 'defensive' });
      if (w) w.workerFocus = focus;
    }
    // Seed each AI faction's resource pool individually. Production
    // beyond the seed must come from real gathering — workers mining
    // metals, chopping wood, harvesting farms — same rule the player
    // operates under. Splitting per-team prevents one AI from
    // draining the other's economy.
    const seedR = this.resourcesForTeam(baseTeam);
    seedR.food   += 200;
    seedR.metals += 100;
    seedR.wood   += 100;
    void hqFloorY;
  }

  /**
   * Push (x, z) outside any live building's footprint. If the point is inside
   * a building, it's ejected to the nearest face + one nav-cell margin so the
   * unit spawns on clear ground rather than snapping to the building roof.
   */
  private safeSpawnXZ(x: number, z: number): { x: number; z: number } {
    const margin = NAV_CELL_VOXELS * VOXEL_SIZE; // 1 nav cell = 1 m
    for (const b of this.buildings.buildings) {
      if (b.destroyed) continue;
      const wx0 = b.ox * NAV_CELL_VOXELS * VOXEL_SIZE;
      const wx1 = (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const wz0 = b.oz * NAV_CELL_VOXELS * VOXEL_SIZE;
      const wz1 = (b.oz + b.spec.cellsD) * NAV_CELL_VOXELS * VOXEL_SIZE;
      if (x < wx0 || x >= wx1 || z < wz0 || z >= wz1) continue;
      // Inside this building's footprint — eject to nearest face.
      const dLeft  = x - wx0;
      const dRight = wx1 - x;
      const dBack  = z - wz0;
      const dFront = wz1 - z;
      const minD   = Math.min(dLeft, dRight, dBack, dFront);
      if (minD === dLeft)  return { x: wx0 - margin, z };
      if (minD === dRight) return { x: wx1 + margin, z };
      if (minD === dBack)  return { x, z: wz0 - margin };
      return { x, z: wz1 + margin };
    }
    return { x, z };
  }

  /**
   * Set or clear the path system's building-footprint mask for `b`. With the
   * bits set, every nav column inside the footprint is treated as off-limits
   * by ground units' grid construction (no walking on roofs or through
   * interiors). With bits cleared (on destruction) the rubble becomes
   * traversable again.
   *
   * Farms are EXCLUDED — they're an open field with a low rail, not a sealed
   * building. Units (workers especially) need to walk across the planted
   * rows, so the footprint stays passable.
   */
  private applyBuildingFootprintMask(b: import('../sim/Buildings').Building, blocked: boolean): void {
    if (!this.pathfinder) return;
    if (b.spec.kind === 'farm') return;
    const bm = this.pathfinder.volume.buildingMask;
    const cx0 = b.ox;
    const cz0 = b.oz;
    const cx1 = b.ox + b.spec.cellsW;
    const cz1 = b.oz + b.spec.cellsD;
    for (let cz = cz0; cz < cz1; cz++) {
      const zOff = cz * NAV_W;
      for (let cx = cx0; cx < cx1; cx++) {
        bm[zOff + cx] = blocked ? 1 : 0;
      }
    }
  }

  private spawnUnit(kind: UnitKind, x: number, y: number, z: number, team: Team = 'player'): Unit | null {
    ({ x, z } = this.safeSpawnXZ(x, z));
    // Enemy production rolls out in aggressive stance so the unit
    // immediately starts auto-engaging once it leaves the door.
    const stance = team !== 'player' ? 'aggressive' : 'defensive';
    return this.units.spawn(kind, x, y, z, { team, stance });
  }

  private spawnWorker(x: number, y: number, z: number): Unit | null {
    ({ x, z } = this.safeSpawnXZ(x, z));
    return this.units.spawn('worker', x, y, z);
  }

  /** Total UNIT_POP_COST for one team's alive non-truck units. Supply
   *  trucks are infrastructure and don't count against the cap. */
  private populationUsedFor(team: import('../sim/Buildings').BuildingTeam): number {
    let used = 0;
    for (const u of this.units.units) {
      if (u.team !== team || u.hp <= 0) continue;
      used += UNIT_POP_COST[u.kind] ?? 1;
    }
    return used;
  }

  /** Recompute popCap for every team. The only contribution beyond the
   *  10-unit bootstrap is +1 per alive civilian — civilians spawn from
   *  neighborhood houses (tier × 5 per neighborhood), so neighborhoods
   *  are the only building type that raises the cap. Barracks etc. do
   *  NOT add population — they only train units. */
  private recomputePopulationCaps(): void {
    const teams: ReadonlyArray<import('../sim/Buildings').BuildingTeam> =
      ['player', 'enemy', 'enemy2'];
    const civiliansBy = new Map<string, number>();
    for (const u of this.units.units) {
      if (u.hp <= 0) continue;
      if (u.kind !== 'civilian') continue;
      civiliansBy.set(u.team, (civiliansBy.get(u.team) ?? 0) + 1);
    }
    for (const team of teams) {
      const r = this.resourcesForTeam(team);
      r.popCap = 10 + (civiliansBy.get(team) ?? 0);
    }
  }

  private debugLogTimer = 0;
  private debugLogResources(dt: number): void {
    this.debugLogTimer -= dt;
    if (this.debugLogTimer > 0) return;
    this.debugLogTimer = 5.0;
    const r = this.resources;
    const trucks = this.units.units.filter(u => u.kind === 'supply_truck' && u.hp > 0);
    const hqs = this.buildings.buildings.filter(b => b.spec.kind === 'hq' && !b.destroyed);
    console.log(`[RESOURCES] food=${r.food.toFixed(0)} metals=${r.metals.toFixed(0)} wood=${r.wood.toFixed(0)} | active_trucks=${trucks.length} | HQ activeTrucks=${hqs.map(h => `${h.activeTrucks}/${this.buildings.hqMaxTrucks(h)}`).join(',')}`);
  }

  /** When false, the tick loop renders the world but does not advance
   *  any sim systems — units freeze, AI sleeps, projectiles hold. The
   *  lobby flips this true once every player has reported `loaded`. */
  paused = true;

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

    if (this.pathfinder && !this.paused) {
      this.units.tick(dt, this.surfaceNav!, this.vnav!, this.world.buffers.voxels, (req) => this.handleWorldEdit(req));
      this.pathTracer.tick(dt, this.units.units);
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
      // Enemy hunt-and-attack lives on the AI server now — see
      // `aiClient.tick` below. The server emits route_unit actions
      // for idle enemies and the client just executes them.
      // AA vehicles: lock onto incoming enemy projectiles and emit a
      // lead-solved firingTarget so tickWeapons fires the flak gun this
      // frame. Runs after aggressive stance (which targets ground units) so
      // a fresh AA lock overrides any stale ground target.
      this.tickAAVehicles();
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
      // Phase 2 zero-trust: snap local positions to the server's
      // authoritative snapshot when drift exceeds the threshold. Runs
      // after the local sim has finished its frame so we correct the
      // most-recent local prediction, not an intermediate state.
      this.reconcileFromAuthoritativeSnapshot();
      // Phase 3 zero-trust: mirror building state + resources up to
      // the server on a fixed cadence so other clients (and any
      // future server-side validators) see a consistent canonical
      // pool.
      this.pushBridgeMirror(dt);
      // Worker automation: drive harvesters / transporters. Routing is
      // delegated back to routePath via the routeWorker callback so the
      // existing path client is reused unchanged.
      tickWorkers(dt, {
        units: this.units,
        world: this.world,
        buildings: this.buildings,
        saplings: this.saplings,
        resources: this.resources,
        enemyResources: this.enemyResources,
        resourcesForTeam: (team) => this.resourcesForTeam(team),
        taskBoard: this.taskBoard,
        routeWorker: (u, wx, wy, wz): void => { void this.routePath(u, wx, wy, wz); },
        onVoxelEdit: (wx: number, wy: number, wz: number): void => {
          // Use incremental rebuild around the edited voxel rather than a
          // full world rescan — a single mine event only affects a small region.
          const r = 2;
          this.requestNavRebuildAround(wx - r, wy - r, wz - r, wx + r, wy + r, wz + r, false);
          // Tell the leaf-decay system about the edit; if a wood voxel was
          // just felled, leaves attached to that branch will lose their
          // connection and start rotting.
          // Phase 5a: under zero-trust the server runs leaf decay
          // off its own voxel-edit + projectile-impact triggers and
          // broadcasts the canopy removal as a `set` voxel_edit, so
          // we'd be doing duplicate work to also schedule it locally.
          if (!this.zeroTrustEnabled) {
            const VS = 0.125;
            this.leafDecay.onVoxelRemoved(
              this.world,
              Math.floor(wx / VS),
              Math.floor(wy / VS),
              Math.floor(wz / VS),
            );
          }
        },
        surfaceY: (wx, wz) => this.surfaceWorldY(wx, wz),
        findMetalCluster: (vx, vy, vz) => this.findMetalCluster(vx, vy, vz),
        onClusterVoxelChipped: (c, wx, wz) => this.onClusterVoxelChipped(c, wx, wz),
        tryClaimClusterSlot: (c, uid) => this.tryClaimClusterSlot(c, uid),
        releaseClusterSlot: (cid, uid) => this.releaseClusterSlot(cid, uid),
        clusterSlotPos: (c, si) => this.clusterSlotPos(c, si),
        findAlternateClusterTarget: (excl, fx, fz) => this.findAlternateClusterTarget(excl, fx, fz),
        findBestMineTarget: (fx, fz, exclude) => this.findBestMineTarget(fx, fz, exclude),
        findChopApproach: (wx, wz, tx, tz) => this.findChopApproach(wx, wz, tx, tz),
      });
      tickSupplyTrucks(dt, {
        units: this.units,
        buildings: this.buildings,
        resources: this.resources,
        enemyResources: this.enemyResources,
        resourcesForTeam: (team) => this.resourcesForTeam(team),
        spawnTruck: (x, y, z, team) => { ({ x, z } = this.safeSpawnXZ(x, z)); return this.units.spawn('supply_truck', x, y, z, { team, stance: 'defensive' }); },
        routeTruck: (u, wx, wy, wz) => { void this.routePath(u, wx, wy, wz); },
        isPassable: (x, z) => {
          const nav = this.surfaceNav;
          if (!nav) return true;
          const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(x / NAV_CELL_METERS)));
          const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(z / NAV_CELL_METERS)));
          // Truck footprintRadius=2 → halfFootprint=1, so the truck centred at
          // (cx, cz) only occupies the 3×3 box. Checking r=1 matches the
          // pathfinder's own passability geometry; r=2 was pessimistic and made
          // every approach point near a building wall fail this gate.
          const r = 1;
          // Building mask blocks any cell touching a live building's footprint.
          const bm = this.pathfinder?.volume.buildingMask;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              const nx = cx + dx; const nz = cz + dz;
              if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) return false;
              const i = navIndex(nx, nz);
              if (nav.blocked[i]) return false;
              if (bm && bm[i]) return false;
            }
          }
          return true;
        },
      });
      this.recomputePopulationCaps();
      this.debugLogResources(dt);
      // Phase 5b: server is canonical for sapling maturation under
      // zero-trust; the broadcast voxel_edit lands in our voxel
      // buffer via VoxelEditMirror and the renderer picks up dirty
      // chunks the same way. Skip the local mature step so we don't
      // double-stamp the canopy.
      let matured = 0;
      if (!this.zeroTrustEnabled) {
        const grow = this.saplings.tick(dt, this.world);
        matured = grow.matured;
      }
      if (matured > 0) this.requestNavRebuild(false);
      // Disconnected leaves rot at 0.3 s per voxel — when this fires it
      // edits world voxels, so refresh the nav around any chop site that
      // was active this frame.
      // Phase 5a: server is canonical for leaf decay under zero-trust;
      // the timer drain + voxel removal land here via the
      // VoxelEditMirror's broadcast handler, so our local tick is a
      // no-op (and would otherwise spawn duplicate timers from any
      // pre-attach trees the local sim still tracked).
      const decayBefore = this.leafDecay.size();
      if (!this.zeroTrustEnabled) {
        this.leafDecay.tick(this.world, dt);
      }
      // City life — civilian spawning + wandering. Phase 5 of the
      // zero-trust migration moved this to the authoritative server,
      // so we skip the local tick when zero-trust is on; civilians
      // arrive via snapshot reconciliation.
      if (!this.zeroTrustEnabled) {
        this.civilians.tick(dt, {
          units: this.units,
          buildings: this.buildings,
          spawnCivilian: (x, y, z): import('../sim/Units').Unit | null => this.units.spawn('civilian', x, y, z),
          routeCivilian: (u, wx, wy, wz): void => { void this.routePath(u, wx, wy, wz); },
          surfaceY: (wx, wz): number => this.surfaceWorldY(wx, wz),
        });
      }
      // Enemy AI: pulses the backend AI server (ai-server.cjs) with
      // the enemy state and applies whatever actions come back. The
      // `tickEnemyAttackMove` pass earlier in the frame handles their
      // movement once they exist; the server just decides production.
      //
      // The host browser drives the AI brain (single AI source per
      // session). Mutations made by `applyAction` flow back through
      // the server via the `onBuildingPlaced` / `pushBridgeMirror`
      // hooks. Server-to-server AI is the long-term plan; until that
      // lands, gating this off entirely meant the AI never produced
      // anything in zero-trust mode.
      if (this.surfaceNav) {
        this.aiClient.tick(dt, {
          units: this.units,
          buildings: this.buildings,
          world: this.world,
          surfaceNav: this.surfaceNav,
          enemyResources: this.enemyResources,
        resourcesForTeam: (team) => this.resourcesForTeam(team),
          spawnEnemy: (kind, x, y, z) => this.units.spawn(kind, x, y, z, { team: 'enemy', stance: 'aggressive' }),
          surfaceY: (wx, wz) => this.surfaceWorldY(wx, wz),
          routeUnit: (u, wx, wy, wz) => { void this.routePath(u, wx, wy, wz); },
          requestNavRebuildAround: (bx0, by0, bz0, bx1, by1, bz1) =>
            this.requestNavRebuildAround(bx0, by0, bz0, bx1, by1, bz1, false),
        });
      }
      if (decayBefore > 0 && this.leafDecay.size() < decayBefore) {
        // Cheap way to re-mesh: the voxel set already marked chunks dirty,
        // and the surface nav refresh box is already widened by the worker
        // edit hooks. Nothing more to do here.
      }
      // Drain the per-tick accumulated nav-rebuild AABB: one sync main-thread
      // refresh + one applyDamage to the worker, regardless of how many
      // impacts / tracks triggered requestNavRebuildAround this frame.
      this.flushNavRebuild();
    }
    // Pack FoW sources / explored-map BEFORE the renderer updates so
    // the unit + building cull predicates can use this frame's
    // visibility data instead of last frame's stale snapshot.
    this.packFoWAndExplored();
    const enemyHidden = (u: Unit): boolean =>
      u.team !== 'player' && !this.isInsideCurrentFoW(u.x, u.y, u.z);
    const enemyBuildingHidden = (b: import('../sim/Buildings').Building): boolean => {
      if (b.team !== 'enemy') return false;
      const cx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_METERS;
      const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_METERS;
      const cy = (b.floorY + 4) * VOXEL_SIZE;
      return !this.isInsideCurrentFoW(cx, cy, cz);
    };
    this.unitRenderer.update(this.units, enemyHidden);
    this.healthBars.update(this.units.units, this.buildings.buildings, this.metalClusters);
    this.constructionOverlay.update(this.buildings.buildings);
    this.rallyMarkers.update(this.buildings.buildings);
    this.minimap.update(this.units.units, this.buildings.buildings, this.metalClusters, this.camera);
    this.buildingRenderer.update(this.buildings.buildings, enemyBuildingHidden);
    // Power lines are recomputed lazily (on building place/destroy), not every frame.
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
    if (!this.paused) this.gameElapsedSeconds += dt;
    if (this.fpsTimer >= 0.5 && this.fpsEl) {
      const fps = this.fpsCount / this.fpsAcc;
      const r = this.resources;
      const traceTag = this.pathTracer.enabled
        ? ` · trace ${this.pathTracer.unitCount()}u/${this.pathTracer.sampleCount()}s`
        : '';
      this.fpsEl.textContent = `FPS ${fps.toFixed(0)} · meshed ${this.meshes.getMeshCount()} · units ${this.units.units.length} · bldgs ${this.buildings.buildings.length}${traceTag}`;
      // Resource cells refresh on the same cadence as the stats line.
      if (this.resFoodEl)   this.resFoodEl.textContent   = `${r.food | 0}`;
      if (this.resMetalsEl) this.resMetalsEl.textContent = `${r.metals | 0}`;
      if (this.resWoodEl)   this.resWoodEl.textContent   = `${r.wood | 0}`;
      if (this.resPopEl) {
        const friendly = this.populationUsedFor('player');
        const cap = this.resources.popCap ?? 0;
        this.resPopEl.textContent = `${friendly} / ${cap}`;
      }
      // Top-right age cluster: HQ tier as Roman numeral + a flavour name +
      // elapsed game time (HH:MM:SS).
      const liveHq = this.buildings.buildings.find(b => !b.destroyed && b.spec.kind === 'hq');
      const ageRomans = ['I', 'II', 'III', 'IV', 'V', 'VI'];
      const ageNames = ['Founding Age', 'Settled Age', 'Industrial Age', 'Modern Age', 'Atomic Age', 'Future Age'];
      const tier = liveHq ? Math.min(5, liveHq.tier ?? 0) : 0;
      if (this.ageMedallionEl) this.ageMedallionEl.textContent = ageRomans[tier]!;
      if (this.ageNameEl)      this.ageNameEl.textContent      = ageNames[tier]!;
      if (this.ageTimeEl) {
        const tSec = Math.floor(this.gameElapsedSeconds);
        const hh = Math.floor(tSec / 3600);
        const mm = Math.floor((tSec % 3600) / 60);
        const ss = tSec % 60;
        const pad = (n: number): string => n < 10 ? `0${n}` : `${n}`;
        this.ageTimeEl.textContent = hh > 0
          ? `${pad(hh)}:${pad(mm)}:${pad(ss)}`
          : `${pad(mm)}:${pad(ss)}`;
      }
      // Selection portrait pane — refreshes only when the lead selected
      // entity changes (or its kind changes).
      this.renderSelectionPortrait();
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
      const cutDesc = ` | Y-cutoff: ${this.hideAboveY.toFixed(1)} m ([/] adjust, \\ reset)`;
      this.modeEl.textContent = `${buildDesc} | selected: ${selDesc}${weaponDesc}${cutDesc}`;
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
    const { x: sx, z: sz } = this.safeSpawnXZ(r.surface.x, r.surface.z);
    if (ctrl) {
      this.units.spawn('soldier', sx, r.surface.y, sz, {
        team: 'enemy', stance: 'aggressive', weapon: 'rpg_launcher',
      });
      return;
    }
    if (alt) {
      const weapon: WeaponKind = shift ? 'rocket_pod' : 'cluster_pod';
      this.units.spawn('rocket_truck', sx, r.surface.y, sz, {
        team: 'enemy', stance: 'aggressive', weapon,
      });
      return;
    }
    const kind: UnitKind = shift ? 'tank' : 'soldier';
    this.units.spawn(kind, sx, r.surface.y, sz, {
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
    const arr = this.units.units.filter(u => u.kind !== 'supply_truck');
    if (arr.length === 0) return;
    const idx = arr.findIndex(u => u.selected);
    this.units.units.forEach(u => u.selected = false);
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
    const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
    const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
    const ox = Math.max(0, Math.min(NAV_W - spec.cellsW, cx - (spec.cellsW >> 1)));
    const oz = Math.max(0, Math.min(NAV_H - spec.cellsD, cz - (spec.cellsD >> 1)));
    // Underground placement when the picker pierced the cutoff and landed
    // below the local surface — use the hit voxel y as the floor.
    const surfaceTop = this.surfaceNav!.topY[navIndex(cx, cz)]!;
    const underground = surfaceTop > 0 && hit.y < surfaceTop - 1;
    const fp = underground
      ? checkFootprint(this.world.buffers.voxels, this.surfaceNav!, spec, ox, oz, this.buildings.buildings, hit.y)
      : checkFootprint(this.world.buffers.voxels, this.surfaceNav!, spec, ox, oz, this.buildings.buildings);
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
      if (u.kind === 'supply_truck') continue; // fully automated, not player-controlled
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
      if (u.kind === 'supply_truck') continue; // fully automated
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

  private tryPlaceBuilding(hit: { x: number; y: number; z: number }): void {
    if (!this.pathfinder) return;
    const spec = this.activeBuildSpec();
    if (!spec) return;
    const wx = hit.x * VOXEL_SIZE;
    const wz = hit.z * VOXEL_SIZE;
    const cx = Math.max(0, Math.min(NAV_W - 1, Math.floor(wx / NAV_CELL_METERS)));
    const cz = Math.max(0, Math.min(NAV_H - 1, Math.floor(wz / NAV_CELL_METERS)));
    const ox = Math.max(0, Math.min(NAV_W - spec.cellsW, cx - (spec.cellsW >> 1)));
    const oz = Math.max(0, Math.min(NAV_H - spec.cellsD, cz - (spec.cellsD >> 1)));
    // Underground placement when the picker pierced the cutoff and landed
    // well below the local surface — use the hit voxel y as the floor.
    const surfaceTop = this.surfaceNav!.topY[navIndex(cx, cz)]!;
    const underground = surfaceTop > 0 && hit.y < surfaceTop - 1;
    const fp = underground
      ? checkFootprint(this.world.buffers.voxels, this.surfaceNav!, spec, ox, oz, this.buildings.buildings, hit.y)
      : checkFootprint(this.world.buffers.voxels, this.surfaceNav!, spec, ox, oz, this.buildings.buildings);
    if (!fp.ok) return;

    // Enforce HQ build range: proposed center must be within range of a live HQ.
    const liveHQs = this.buildings.buildings.filter(b => b.spec.kind === 'hq' && !b.destroyed);
    if (liveHQs.length > 0) {
      const propCx = (ox + spec.cellsW * 0.5) * NAV_CELL_METERS;
      const propCz = (oz + spec.cellsD * 0.5) * NAV_CELL_METERS;
      const inRange = liveHQs.some(hq => {
        const hqCx = (hq.ox + hq.spec.cellsW * 0.5) * NAV_CELL_METERS;
        const hqCz = (hq.oz + hq.spec.cellsD * 0.5) * NAV_CELL_METERS;
        // Per-track scaling: each "Increase range" upgrade extends the
        // perimeter by 50% so the player can claim more ground after
        // investing in that specific track.
        const range = this.buildings.hqBuildRange(hq);
        return Math.hypot(propCx - hqCx, propCz - hqCz) <= range;
      });
      if (!inRange) return;
    }
    this.buildings.place(this.world, spec, ox, oz, fp.floorY);
    const pad = NAV_CELL_METERS;
    const bx0 = ox * NAV_CELL_METERS;
    const bz0 = oz * NAV_CELL_METERS;
    const bx1 = (ox + spec.cellsW) * NAV_CELL_METERS;
    const bz1 = (oz + spec.cellsD) * NAV_CELL_METERS;
    const by0 = fp.floorY * VOXEL_SIZE;
    const by1 = (fp.floorY + spec.headroomVoxels + 4) * VOXEL_SIZE;
    this.requestNavRebuildAround(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad, true);
    // Synchronously refresh the main-thread Pathfinder's per-unit grids over
    // the affected cells so `recomputePowerLinePaths` (which calls
    // pathfinder.findPath synchronously) sees the new building blocking the
    // soldier grid. Without this the worker rebuild is queued behind the
    // current frame and the line routes through the new building.
    this.pathfinder?.applyDamage(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad);
    // Recompute power-line routes so new buildings that are energy sources
    // or HQs appear, and existing routes deflect around the new building.
    this.recomputePowerLinePaths();
  }

  private detonateAt(hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number }): void {
    const radiusVoxels = this.explosionRadiusBigMeters / VOXEL_SIZE;
    const cx = hit.x + 0.5 - hit.nx * 0.5;
    const cy = hit.y + 0.5 - hit.ny * 0.5;
    const cz = hit.z + 0.5 - hit.nz * 0.5;
    const result = this.world.damageSphere(cx, cy, cz, radiusVoxels, this.explosionPeak * TERRAIN_DAMAGE_GLOBAL_SCALE);
    this.mirrorVoxelSphere(cx * VOXEL_SIZE, cy * VOXEL_SIZE, cz * VOXEL_SIZE, this.explosionRadiusBigMeters, AIR);
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
      const dmg = this.explosionPeak * 0.4 * falloff;
      u.hp -= dmg;
      this.mirrorEntityDamage(u.id, dmg);
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
    // Tree-blocked surface columns must propagate into the unit-grid mask
    // (otherwise a tree felled at runtime keeps blocking paths, or a sapling
    // grown after generation never starts blocking). Slop one cell on each
    // side to match the surface refresh's slope-pass widening.
    syncTreeMask(this.pathfinder.volume, this.surfaceNav.treeBlocked,
      sx0 - 1, sz0 - 1, sx1 + 1, sz1 + 1);
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
  private async routePath(unit: Unit, wx: number, wy: number, wz: number, opts?: { forceSurface?: boolean; fallbackToHq?: boolean }): Promise<void> {
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
    // Snap start to nearest passable cell — the spawn y may not align exactly
    // with the unit-kind grid, causing A* to fail from a blocked start. The
    // search ring is widened for wide-footprint units (trucks, vehicles) so a
    // spawn next to a thick wall / building cluster can still find a clear
    // standing cell within reach.
    // Search ring for the start-cell snap. The default 5 cells was
    // too tight for workers whose physical position lands inside a
    // tree-blocked column (the unit walked there, then the column got
    // marked impassable on a later refresh). 30 cells still snaps to
    // the unit's local neighbourhood, but lets the pathfinder hop
    // over a 2-3-cell tree line before giving up.
    const passableRing = unit.footprintRadius >= 2 ? 40 : 80;
    let start = this.pathfinder.cellAt(unit.x, unit.y, unit.z);
    // Cap the search ceiling at ~1 nav cell above the unit's current y so
    // columns whose only passable cell lives above the canopy don't snap the
    // start onto an unreachable air cell. Same reasoning as the goal cap
    // below — the unit walks at the real surface, so its start cell must be
    // at surface level, not on top of nearby leaves.
    const startGround = this.pathfinder.groundCellAt(unit.kind, unit.x, unit.z, unit.y + NAV_CELL_METERS);
    if (startGround && !this.isUnitCellPassable(unit.kind, start)) {
      start = startGround;
    }
    start = this.pathfinder.nearestPassable(unit.kind, start, passableRing);
    let goal = this.pathfinder.cellAt(wx, wy, wz);
    // If the click landed on a non-passable cell (carved-out column, building
    // edge, ceiling), pull the goal toward the nearest cell where the unit's
    // body actually fits. Vertical fallback: scan the column from the picked
    // y upward for a passable layer (handles surface clicks in the cave overlay).
    // Cap the search ceiling at ~1 nav cell above the requested wy so columns
    // whose only passable cell lives ABOVE a tree canopy don't escape upward
    // (the worker can't actually reach a cell above the leaves; A* would
    // exhaust its expansion budget trying to climb to it).
    const groundCell = this.pathfinder.groundCellAt(unit.kind, wx, wz, wy + NAV_CELL_METERS);
    if (groundCell && !this.isUnitCellPassable(unit.kind, goal)) {
      goal = groundCell;
    }
    goal = this.pathfinder.nearestPassable(unit.kind, goal, passableRing);

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
      maxExpansions: 750000,
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

    if (res.waypoints.length === 0 || !res.reached) {
      if (unit.kind === 'supply_truck' || unit.kind === 'worker') {
        const startOk = this.isUnitCellPassable(unit.kind, start);
        const goalOk  = this.isUnitCellPassable(unit.kind, goal);
        console.warn(
          `[PATH FAIL] ${unit.kind}#${unit.id} ` +
          `pos=(${unit.x.toFixed(1)},${unit.y.toFixed(1)},${unit.z.toFixed(1)}) ` +
          `start=(${start.cx},${start.cy},${start.cz}){pass=${startOk}} ` +
          `goal=(${goal.cx},${goal.cy},${goal.cz}){pass=${goalOk}} ` +
          `reached=${res.reached} expanded=${res.expanded}`,
        );
      }
      return;
    }
    if (unit.kind === 'supply_truck') {
      const last = res.waypoints[res.waypoints.length - 1]!;
      console.log(`[PATH OK] truck#${unit.id} ${res.waypoints.length} waypoints, goal=(${last.x.toFixed(1)},${last.z.toFixed(1)}) expanded=${res.expanded}`);
    }
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

  /**
   * Compute A*-based surface paths from every live power plant to its nearest
   * live HQ, then pass the resulting waypoints to the power-line renderer so
   * lines follow the terrain rather than cutting straight through hills.
   * Called once after world gen and again whenever a building is placed.
   */
  private recomputePowerLinePaths(): void {
    if (!this.pathfinder) return;
    const hqs = this.buildings.buildings.filter(b => b.spec.kind === 'hq' && !b.destroyed);
    if (hqs.length === 0) { this.powerLines.setRoutes([]); return; }

    const routes: { waypoints: { x: number; y: number; z: number }[] }[] = [];

    for (const src of this.buildings.buildings) {
      if (!src.spec.isEnergySource || src.destroyed) continue;

      const sx = (src.ox + src.spec.cellsW * 0.5) * NAV_CELL_METERS;
      const sz = (src.oz + src.spec.cellsD * 0.5) * NAV_CELL_METERS;
      const sy = this.surfaceWorldY(sx, sz);

      let nearest = hqs[0]!;
      let nearestDist = Infinity;
      for (const hq of hqs) {
        const hx = (hq.ox + hq.spec.cellsW * 0.5) * NAV_CELL_METERS;
        const hz = (hq.oz + hq.spec.cellsD * 0.5) * NAV_CELL_METERS;
        const d = Math.hypot(sx - hx, sz - hz);
        if (d < nearestDist) { nearestDist = d; nearest = hq; }
      }

      const hx = (nearest.ox + nearest.spec.cellsW * 0.5) * NAV_CELL_METERS;
      const hz = (nearest.oz + nearest.spec.cellsD * 0.5) * NAV_CELL_METERS;
      const hy = this.surfaceWorldY(hx, hz);

      const rawStart = this.pathfinder.cellAt(sx, sy, sz);
      const rawGoal  = this.pathfinder.cellAt(hx, hy, hz);
      const start = this.pathfinder.nearestPassable('soldier', rawStart, 8);
      const goal  = this.pathfinder.nearestPassable('soldier', rawGoal, 8);

      const res = this.pathfinder.findPath('soldier', {
        start, goal, anyAngle: false, maxExpansions: 10000,
      });

      if (res.cells.length > 0) {
        routes.push({ waypoints: this.pathfinder.pathToWaypoints(res.cells) });
      } else {
        // Fallback: straight line if pathfinding fails (isolated terrain).
        routes.push({ waypoints: [{ x: sx, y: sy, z: sz }, { x: hx, y: hy, z: hz }] });
      }
    }

    this.powerLines.setRoutes(routes);
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

  /**
   * Score function shared by initial and fallback cluster selection.
   * Balances occupancy (spread workers evenly) against distance (avoid huge detours).
   * occupancy weight 0.65 means we strongly prefer emptier clusters while still
   * penalising very distant ones.
   */
  private clusterScore(c: MetalCluster, fromX: number, fromZ: number): number {
    const REF_DIST = 100.0; // metres — normalises distance into [0,~2] for typical maps
    const OCC_W = 0.65;
    const occupancy = 1 - c.workerSlots.filter(s => s === 0).length / c.maxWorkers;
    const dx = c.worldX - fromX, dz = c.worldZ - fromZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    return occupancy * OCC_W + (dist / REF_DIST) * (1 - OCC_W);
  }

  private clusterVoxelTarget(c: MetalCluster): { wx: number; wy: number; wz: number } | null {
    const voxels = this.world.buffers.voxels;
    const yMin = c.surfaceTop + 1;
    const yMax = c.surfaceTop + 1 + c.ry * 2;
    for (let y = yMin; y <= yMax; y++) {
      for (let z = c.vz - c.rxz; z <= c.vz + c.rxz; z++) {
        for (let x = c.vx - c.rxz; x <= c.vx + c.rxz; x++) {
          if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue;
          if (voxels[worldIndex(x, y, z)] === M_METAL) {
            return { wx: (x + 0.5) * VOXEL_SIZE, wy: (y + 0.5) * VOXEL_SIZE, wz: (z + 0.5) * VOXEL_SIZE };
          }
        }
      }
    }
    return null;
  }

  /**
   * Load-balanced initial mine assignment. Called by idle workers before they
   * have walked anywhere. Picks the cluster that minimises the combined
   * occupancy+distance score so workers naturally spread across all mines rather
   * than piling onto the nearest one.
   */
  private findBestMineTarget(
    fromX: number, fromZ: number,
    excludeClusterIds?: ReadonlySet<number>,
  ): { wx: number; wy: number; wz: number; clusterId: number } | null {
    // Count en-route assignees per cluster — workers that have set
    // `claimedClusterId` but haven't yet reached the cluster and
    // claimed a slot. Otherwise multiple idle workers all pick the
    // same cluster on the same tick, then arrive together and have
    // to redirect once the slots fill up. Counting both occupied
    // slots AND en-route workers enforces the per-cluster max
    // immediately at assignment time.
    const enRoute = new Map<number, number>();
    for (const u of this.units.units) {
      if (u.kind !== 'worker' || u.hp <= 0) continue;
      if (u.claimedClusterId < 0) continue;
      enRoute.set(u.claimedClusterId, (enRoute.get(u.claimedClusterId) ?? 0) + 1);
    }
    let best: MetalCluster | null = null;
    let bestScore = Infinity;
    for (const c of this.metalClusters) {
      if (c.destroyed) continue;
      if (excludeClusterIds && excludeClusterIds.has(c.id)) continue;
      const occupied = c.workerSlots.filter(s => s !== 0).length;
      const inbound = enRoute.get(c.id) ?? 0;
      // Inbound includes workers already holding a slot — don't double-count.
      const totalCommitted = Math.max(occupied, inbound);
      if (totalCommitted >= c.maxWorkers) continue;
      const score = this.clusterScore(c, fromX, fromZ);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;
    const target = this.clusterVoxelTarget(best);
    return target ? { ...target, clusterId: best.id } : null;
  }

  /** Load-balanced fallback when a worker reaches a full cluster and needs redirection. */
  private findAlternateClusterTarget(
    excludeId: number, fromX: number, fromZ: number,
  ): { wx: number; wy: number; wz: number } | null {
    const enRoute = new Map<number, number>();
    for (const u of this.units.units) {
      if (u.kind !== 'worker' || u.hp <= 0) continue;
      if (u.claimedClusterId < 0) continue;
      enRoute.set(u.claimedClusterId, (enRoute.get(u.claimedClusterId) ?? 0) + 1);
    }
    let best: MetalCluster | null = null;
    let bestScore = Infinity;
    for (const c of this.metalClusters) {
      if (c.id === excludeId || c.destroyed) continue;
      const occupied = c.workerSlots.filter(s => s !== 0).length;
      const inbound = enRoute.get(c.id) ?? 0;
      if (Math.max(occupied, inbound) >= c.maxWorkers) continue;
      const score = this.clusterScore(c, fromX, fromZ);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best ? this.clusterVoxelTarget(best) : null;
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
      // Civilian → refinery gesture (and worker → farm below) only fires on
      // a short click so the camera-yaw drag still works for unarmed
      // selections.
      if (this.isDragging(release.startX, release.startY, release.endX, release.endY)) return;
      const civilians = this.units.units.filter(u => u.selected && u.kind === 'civilian');
      if (civilians.length > 0) {
        const b = this.pickBuildingAt(release.startX, release.startY, w, h);
        if (b && b.spec.kind === 'refinery' && b.upgradeState === 'enabled') {
          // Route every selected civilian to the refinery's centre. They
          // arrive, idle there, and the wandering AI is suspended for
          // assigned civilians until the user re-selects them and clicks
          // somewhere else.
          this.civilians.assignToWorkplace(civilians.map(c => c.id), b.id);
          const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
          const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
          for (const c of civilians) void this.routePath(c, cxw, c.y, czw);
          return;
        }
      }
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
  /**
   * Wire the authoritative game-server into the local sim. After this
   * runs every `units.spawn(...)` mirrors into the server's entity
   * table, every new path is forwarded as a `set_path` command, and
   * dead units issue a `despawn_entity`. The per-frame reconciliation
   * (`reconcileFromAuthoritativeSnapshot`) snaps a unit back to the
   * server's position when the local sim drifts more than a couple
   * of metres — a teleport-cheat client gets visibly corrected.
   *
   * Idempotent: calling it twice replaces the hooks; single-player
   * paths that never call it still run unchanged.
   */
  attachAuthoritativeServer(client: import('../net/GameClient').GameClient): void {
    this.gameClient = client;
    this.zeroTrustEnabled = true;

    // Phase 4.2: subscribe to the server's voxel_edit broadcast so
    // peer destruction lands in our local voxel buffer in real time.
    // Echoes of our own writes are filtered by playerId inside the
    // mirror, so the local sim's own damageSphere isn't double-applied.
    void (async () => {
      const { VoxelEditMirror } = await import('../net/VoxelEditMirror');
      this.voxelEditMirror = new VoxelEditMirror(this.world, client.playerId);
      this.voxelEditMirror.attach(client);
    })();

    // Phase 5b: mirror sapling plants to the server. The local plant
    // (above) draws the placeholder marker for snappy feedback;
    // server is authoritative for both the marker (re-broadcast as a
    // voxel_edit) and the eventual maturation, both of which arrive
    // back to the local voxel buffer via VoxelEditMirror.
    this.saplings.onAfterPlant = (wx, wz, seed) => {
      if (!this.zeroTrustEnabled || !this.gameClient) return;
      this.gameClient.send({
        type: 'plant_sapling',
        owner: this.gameClient.playerId,
        wx, wz, seed,
      });
    };

    // Phase 4.1: mirror projectile spawns to the server so its entity
    // table tracks the same in-flight rounds the local sim renders.
    // Hit detection still resolves client-side; the server-tracked
    // copy is the foundation for future authoritative impact gating.
    this.projectiles.onAfterSpawn = (p) => {
      if (!this.zeroTrustEnabled || !this.gameClient) return;
      const cfg = PROJECTILES[p.kind];
      this.gameClient.send({
        type: 'spawn_projectile',
        clientTag: `proj-${this.gameClient.playerId}-${p.id}`,
        owner: this.gameClient.playerId,
        kind: p.kind,
        x: p.x, y: p.y, z: p.z,
        vx: p.vx, vy: p.vy, vz: p.vz,
        dragPerSecond: p.dragPerSecond,
        gravityScale: cfg.gravityScale ?? 1,
        maxLifeSeconds: p.maxLifeSeconds,
        ownerId: p.ownerId,
        // Phase 4.1c — server uses these on raycast hit to emit the
        // canonical voxel sphere op for crater + pit destruction.
        hitRadiusMeters: cfg.hitRadiusMeters,
        explosive: cfg.explosive,
        explosionRadiusMeters: cfg.explosionRadiusMeters,
        // Phase 4.1d — direct-hit / splash damage values used by the
        // server's per-tick entity sweep.
        hitDamage: cfg.hitDamage,
        damagePeak: cfg.explosive ? cfg.explosionPeak : cfg.hitDamage,
      });
    };

    this.units.onAfterSpawn = (u) => {
      if (!this.zeroTrustEnabled || !this.gameClient) return;
      const tag = this.unitClientTag(u.id);
      this.mirroredUnitIds.add(u.id);
      this.localUnitsByTag.set(tag, u.id);
      this.gameClient.send({
        type: 'spawn_entity',
        clientTag: tag,
        owner: u.team !== 'player' ? u.team : this.gameClient.playerId,
        kind: u.kind,
        x: u.x, y: u.y, z: u.z,
        speed: u.speed,
        hp: u.hp,
      });
    };

    this.units.onSetPath = (u) => {
      if (!this.zeroTrustEnabled || !this.gameClient) return;
      this.gameClient.send({
        type: 'set_path',
        clientTag: this.unitClientTag(u.id),
        owner: u.team !== 'player' ? u.team : this.gameClient.playerId,
        waypoints: u.path.map(w => ({ x: w.x, y: w.y, z: w.z })),
      });
    };

    // Pre-existing units (e.g. starter workers spawned before attach)
    // get back-filled so the server learns about everyone alive. The
    // owner must reflect the unit's team — seeded enemy workers are
    // owned by their AI faction, not the watcher.
    for (const u of this.units.units) {
      if (u.hp <= 0) continue;
      const tag = this.unitClientTag(u.id);
      this.mirroredUnitIds.add(u.id);
      this.localUnitsByTag.set(tag, u.id);
      client.send({
        type: 'spawn_entity',
        clientTag: tag,
        owner: u.team !== 'player' ? u.team : client.playerId,
        kind: u.kind,
        x: u.x, y: u.y, z: u.z,
        speed: u.speed,
        hp: u.hp,
      });
      if (u.path.length > 0) {
        client.send({
          type: 'set_path',
          clientTag: this.unitClientTag(u.id),
          owner: client.playerId,
          waypoints: u.path.map(w => ({ x: w.x, y: w.y, z: w.z })),
        });
      }
    }

    // Building lifecycle: place / destroy ride existing
    // BuildingManager hooks. Non-destructive composition — if Game
    // already wired these we keep the previous handler running so the
    // path-system mask updates aren't lost.
    const prevPlaced = this.buildings.onBuildingPlaced;
    this.buildings.onBuildingPlaced = (b) => {
      try { prevPlaced?.(b); } catch (_e) { /* ignore */ }
      if (!this.zeroTrustEnabled || !this.gameClient) return;
      this.gameClient.send({
        type: 'place_building',
        clientTag: this.buildingClientTag(b.id),
        owner: b.team !== 'player' ? b.team : this.gameClient.playerId,
        kind: b.spec.kind,
        ox: b.ox, oz: b.oz, floorY: b.floorY,
        cellsW: b.spec.cellsW, cellsD: b.spec.cellsD,
        upgradeState: b.upgradeState,
        hp: b.hp, maxHp: b.maxHp,
        trainQueue: b.trainQueue,
      });
    };
    const prevDestroyed = this.buildings.onBuildingDestroyed;
    this.buildings.onBuildingDestroyed = (b) => {
      try { prevDestroyed?.(b); } catch (_e) { /* ignore */ }
      if (!this.zeroTrustEnabled || !this.gameClient) return;
      this.gameClient.send({
        type: 'update_building',
        clientTag: this.buildingClientTag(b.id),
        owner: b.team !== 'player' ? b.team : this.gameClient.playerId,
        hp: 0,
        destroyed: true,
      });
    };

    // Back-fill existing buildings so the server learns about the
    // starter HQ / storage / enemy bases that placed before attach.
    for (const b of this.buildings.buildings) {
      if (b.destroyed) continue;
      client.send({
        type: 'place_building',
        clientTag: this.buildingClientTag(b.id),
        owner: b.team !== 'player' ? b.team : client.playerId,
        kind: b.spec.kind,
        ox: b.ox, oz: b.oz, floorY: b.floorY,
        cellsW: b.spec.cellsW, cellsD: b.spec.cellsD,
        upgradeState: b.upgradeState,
        hp: b.hp, maxHp: b.maxHp,
        trainQueue: b.trainQueue,
      });
    }
  }

  /** Push building state + per-team resource pools to the server on a
   *  fixed interval. HP / queues / resources tick locally at 60 Hz —
   *  re-mirroring everything every frame would flood the proxy.
   *  500 ms is fine-grained enough that another connected player sees
   *  base state moving with their attacks. */
  private pushBridgeMirror(dt: number): void {
    if (!this.zeroTrustEnabled || !this.gameClient) return;
    this.bridgePushTimer -= dt;
    if (this.bridgePushTimer > 0) return;
    this.bridgePushTimer = Game.BRIDGE_PUSH_INTERVAL_S;
    const pid = this.gameClient.playerId;
    for (const b of this.buildings.buildings) {
      if (b.destroyed) continue;
      this.gameClient.send({
        type: 'update_building',
        clientTag: this.buildingClientTag(b.id),
        owner: b.team !== 'player' ? b.team : pid,
        hp: b.hp,
        upgradeState: b.upgradeState,
        trainQueue: b.trainQueue,
      });
    }
    this.gameClient.send({
      type: 'set_resources',
      owner: pid,
      food: this.resources.food | 0,
      metals: this.resources.metals | 0,
      wood: this.resources.wood | 0,
      popCap: this.resources.popCap | 0,
    });
    // Phase 6+: under zero-trust, the server is authoritative for
    // the AI's economy — it debits cost on `place_building` /
    // `queue_train` and accrues `tickFarmIncome` per tick. Mirroring
    // the browser's static `enemyResources` would clobber those
    // server-side mutations every BRIDGE_PUSH_INTERVAL_S. Future
    // work: stop tracking enemyResources locally entirely and let
    // the snapshot drive any UI that reads it.
  }

  /** Phase 4.3b: ship the local unit's WEAPONS + PROJECTILES catalog
   *  values to the server as a single arm_unit. Sender is gated by
   *  `zeroTrustEnabled` upstream, so by the time we get here we know
   *  there's a live GameClient. */
  private sendArmUnit(u: Unit): void {
    if (!this.gameClient || u.weapon === null) return;
    const w = WEAPONS[u.weapon];
    const cfg = PROJECTILES[w.projectile];
    this.gameClient.send({
      type: 'arm_unit',
      clientTag: this.unitClientTag(u.id),
      owner: this.gameClient.playerId,
      kind: w.projectile,
      rangeMeters: w.rangeMeters,
      fireIntervalSec: w.fireInterval,
      projectileSpeed: cfg.muzzleVelocity * w.velocityScale,
      projectileDrag: cfg.dragPerSecond,
      projectileGravityScale: cfg.gravityScale ?? 1,
      projectileMaxLife: cfg.maxLifeSeconds,
      projectileHitRadius: cfg.hitRadiusMeters,
      projectileHitDamage: cfg.hitDamage,
      projectileExplosive: cfg.explosive,
      projectileExplosionRadius: cfg.explosionRadiusMeters,
      projectileDamagePeak: cfg.explosive ? cfg.explosionPeak : cfg.hitDamage,
    });
  }

  /** Push an authoritative damage event for `unitId`. Server reduces
   *  HP; if the entity vanishes from the snapshot the next reconcile
   *  will kill the local unit too. */
  private mirrorEntityDamage(unitId: number, amount: number): void {
    if (!this.zeroTrustEnabled || !this.gameClient) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.gameClient.send({
      type: 'damage_entity',
      clientTag: this.unitClientTag(unitId),
      amount,
    });
  }

  /** Phase 6: log a sphere voxel mutation with the server so the
   *  authoritative edit log captures every projectile crater. We
   *  send the sphere centre + radius (cheap O(1) bytes) rather than
   *  the per-voxel diff because a single tank shell can edit
   *  hundreds of voxels. The server replays this against connecting
   *  clients via /world/edits. */
  private mirrorVoxelSphere(wx: number, wy: number, wz: number, radiusMeters: number, mat: number): void {
    if (!this.zeroTrustEnabled || !this.gameClient) return;
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return;
    this.gameClient.send({
      type: 'voxel_edit',
      owner: this.gameClient.playerId,
      x: wx, y: wy, z: wz,
      radius: radiusMeters,
      mat,
    });
  }

  /** Reconcile local units against the authoritative snapshot. Three
   *  flavours of behaviour:
   *
   *   - Server-driven units (server originated, e.g. civilians): the
   *     local unit is just a render proxy. Position is *always*
   *     copied — no drift threshold.
   *   - Client-driven mirrored units (the player's own units that
   *     ran through the spawn hook): drift > 2 m snaps to server.
   *     HP is monotonic-down. A despawn on the server kills the
   *     local unit.
   *   - Pre-attach / never-mirrored units: untouched.
   *
   *  This is also the only place server-only entities (those with no
   *  matching local unit) get adopted into the local sim. */
  private reconcileFromAuthoritativeSnapshot(): void {
    if (!this.zeroTrustEnabled || !this.gameClient) return;
    // Cross-cutting Phase: use the interpolation buffer for visual
    // positions and the latest snapshot for discrete state (hp,
    // liveness). The interpolated snapshot is ~100 ms behind the
    // wall clock, which hides SSE jitter without smearing damage
    // ticks or delaying death + drift detection.
    const latest = this.gameClient.latestSnapshot();
    if (!latest) return;
    const interp = this.gameClient.interpolatedSnapshot() ?? latest;
    const interpById = new Map<number, typeof latest.entities[number]>();
    for (const e of interp.entities) interpById.set(e.id, e);
    const DRIFT_M = 2.0;
    const drift2 = DRIFT_M * DRIFT_M;
    const liveLocalIds = new Set<number>();
    for (const e of latest.entities) {
      const tag = e.clientTag;
      if (!tag) continue;
      let localId = this.localUnitsByTag.get(tag);
      let u = localId !== undefined ? this.units.units.find(x => x.id === localId) : undefined;
      if (!u) {
        // If the tag is already mapped to a local id but the unit is
        // no longer in `this.units.units`, the local unit died and
        // was swept. Do NOT resurrect — the server's stale entity
        // would otherwise come back as a fresh, idle proxy and
        // accumulate (e.g. supply trucks finishing a delivery and
        // leaking back as task=idle phantoms past the per-HQ cap).
        if (localId !== undefined) continue;
        // Server-originated entity — adopt with the spawn hook
        // suppressed so we don't echo a duplicate spawn back.
        u = this.adoptServerEntity(e) ?? undefined;
        if (!u) continue;
        localId = u.id;
      }
      liveLocalIds.add(u.id);
      // Server has now reported this unit at least once — eligible for
      // the "missing from snapshot" kill loop below. Until ack, the
      // local unit stays alive even when the snapshot says nothing
      // about it (back-fill POSTs are still in flight).
      this.serverAckedUnitIds.add(u.id);
      if (e.hp < u.hp) u.hp = e.hp;
      const serverDriven = this.serverDrivenUnitIds.has(u.id);
      if (serverDriven) {
        // Full server proxy — no local sim. Render via the
        // interpolated position so 20 Hz tick boundaries don't show
        // up as visible jitter; fall back to `latest` for entities
        // that just appeared (no bracketing snapshot has them yet).
        const pos = interpById.get(e.id) ?? e;
        u.x = pos.x;
        u.y = pos.y;
        u.z = pos.z;
      } else {
        // Client-mirrored unit — the local 60 Hz sim is the source
        // of truth for position. Server reconciliation must respect
        // the 1-voxel-per-tick rule, so instead of snapping the unit
        // to `e.{x,y,z}` (which would visually teleport it across
        // up to 2 m of drift), we nudge by at most VOXEL_SIZE each
        // tick along the correction vector. Over a few seconds the
        // local position lerps onto the server's value without ever
        // violating the voxel-by-voxel rule.
        const dx = e.x - u.x, dz = e.z - u.z;
        const driftSq = dx * dx + dz * dz;
        if (driftSq > drift2) {
          const drift = Math.sqrt(driftSq);
          const step = Math.min(drift, VOXEL_SIZE);
          const s = step / drift;
          u.x += dx * s;
          u.z += dz * s;
          // Drive `distanceWalked` so the renderer's per-frame walk
          // animation sees the reconciler nudge as movement and
          // plays the leg swing.
          u.distanceWalked += step;
          // Face the direction we're being nudged so the unit isn't
          // moonwalking sideways during reconciliation.
          u.heading = Math.atan2(-dx, -dz);
          // y is allowed to snap (terrain follow handles small Y
          // changes anyway, and the rule is voxel-by-voxel in XZ).
          u.y = e.y;
        }
      }
    }
    // Per game rule: a unit only disappears when its HP reaches 0
    // from actual damage. The previous reconcile-kill silently
    // zeroed HP for any locally-mirrored unit the server's snapshot
    // had dropped — that path produced "units randomly disappearing"
    // for the user since there was no explosion / death animation.
    // For the AI-vs-AI loop the local sim is the source of truth;
    // the server reconcile is now non-destructive.
  }

  /** Build a local Unit for a server-spawned entity. Subsequent ticks
   *  treat the unit as server-driven (always sync from snapshot,
   *  never echo commands back). */
  private adoptServerEntity(e: { id: number; clientTag: string | null; kind: string; owner: string; x: number; y: number; z: number; hp: number }): Unit | null {
    if (!e.clientTag) return null;
    if (!UNIT_KINDS.includes(e.kind as Unit['kind'])) return null;
    // Supply trucks are dispatcher-spawned client-side only. The server
    // never originates one, so any "missing locally" truck in a snapshot
    // is a stale entity from a delivery that just hp=0'd locally — the
    // server hasn't processed our despawn_entity yet. Adopting that
    // entity would resurrect the truck as a fresh task=idle proxy, and
    // the player team would accumulate dozens of phantom trucks past
    // the per-HQ cap.
    if (e.kind === 'supply_truck') return null;
    const team: Team = e.owner === 'enemy' ? 'enemy' : e.owner === 'enemy2' ? 'enemy2' : 'player';
    const stance = team !== 'player' ? 'aggressive' : 'defensive';
    const u = this.units.spawn(
      e.kind as Unit['kind'],
      e.x, e.y, e.z,
      { team, stance, weapon: null, noHook: true },
    );
    this.localUnitsByTag.set(e.clientTag, u.id);
    this.serverDrivenUnitIds.add(u.id);
    return u;
  }

  /** Tracks the set of unit ids the server has acknowledged at least
   *  once. Without this, the very first snapshot (which arrives before
   *  the back-fill spawn POST has been processed) would mark every
   *  local unit as dead. */
  private mirroredUnitIds = new Set<number>();
  /** Subset of `mirroredUnitIds` whose existence has been confirmed
   *  by at least one snapshot from the server. Without this, the
   *  reconciler's "missing from the snapshot → kill" loop fires
   *  before back-fill `spawn_entity` POSTs round-trip, killing every
   *  starter unit. */
  private serverAckedUnitIds = new Set<number>();
  private serverHasSeenUnit(id: number): boolean {
    return this.mirroredUnitIds.has(id);
  }
  /** Stable, per-player clientTag for a local unit. The server's
   *  entity table is shared across every lobby that ever connected,
   *  so two sessions both spawning a unit with local id `1` would
   *  collide on the bare `u-1` tag — `spawnEntity`'s idempotency
   *  check would hand the second session the first session's
   *  entity, and FoW would then drop everything from the new
   *  player's snapshot. Prefixing with the playerId keeps tags
   *  globally unique across the game-server's lifetime. */
  private unitClientTag(id: number): string {
    const pid = this.gameClient?.playerId ?? 'anon';
    return `u-${pid}-${id}`;
  }
  private buildingClientTag(id: number): string {
    const pid = this.gameClient?.playerId ?? 'anon';
    return `b-${pid}-${id}`;
  }
  /** Phase 4.3b: ids of mirrored units we've sent `arm_unit` for. The
   *  reconciler in `tickAggressiveStance` keeps this in sync with the
   *  unit's local stance + weapon, sending `disarm_unit` when the
   *  player flips to hold-fire or the unit gets a `null` weapon. */
  private serverArmedUnitIds = new Set<number>();
  /** clientTag → local unit id, used by the snapshot reconciler to
   *  match server entities back to local units in O(1). */
  private localUnitsByTag = new Map<string, number>();
  /** Local unit ids whose authoritative source is the server (e.g.
   *  civilians spawned by `tickCivilians` server-side). Reconciliation
   *  always copies position from the snapshot for these — they never
   *  ran the local sim, so there's no prediction to preserve. */
  private serverDrivenUnitIds = new Set<number>();

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
        // Tell the authoritative server the entity is gone so its
        // table doesn't grow without bound.
        if (this.gameClient && this.zeroTrustEnabled) {
          const tag = this.unitClientTag(u.id);
          // Drop stale tag → id mapping so the reconciler doesn't
          // re-adopt this entity from the next snapshot if the
          // server's despawn round-trip is in flight.
          this.localUnitsByTag.delete(tag);
          this.mirroredUnitIds.delete(u.id);
          this.serverArmedUnitIds.delete(u.id);
          // The owner here MUST match what was sent at spawn; the
          // server rejects despawns whose owner doesn't match the
          // entity's recorded owner.
          this.gameClient.send({
            type: 'despawn_entity',
            clientTag: tag,
            owner: u.team !== 'player' ? u.team : this.gameClient.playerId,
          });
        }
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
    const radiusVoxels = radiusMeters / VOXEL_SIZE;
    const result = this.world.damageSphere(cx, cy, cz, radiusVoxels, terrainPeak);
    // Phase 4.1c: under zero-trust the server runs its own raycast
    // against this projectile and emits the canonical voxel_edit on
    // impact. The local damageSphere above stays as a prediction so
    // the firing player sees the crater on the same frame, but
    // mirroring our own sphere would produce a duplicate broadcast.
    // Pre-zero-trust path keeps the explicit mirror so single-player
    // and earlier migrations stay observable to the server log.
    if (!this.zeroTrustEnabled) {
      this.mirrorVoxelSphere(imp.x, imp.y, imp.z, radiusMeters, AIR);
    }
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
    //
    // Under zero-trust the server runs its own per-tick segment-vs-
    // entity sweep and applies the canonical hp damage; deducting
    // here would double-count when the snapshot reconciliation
    // arrives. Visual effects above (flash, ring, debris) still play
    // for snappy feedback.
    if (imp.directHitUnitId >= 0 && !this.zeroTrustEnabled) {
      const hit = this.units.units.find(u => u.id === imp.directHitUnitId);
      if (hit) {
        hit.hp -= imp.hitDamage;
        this.mirrorEntityDamage(hit.id, imp.hitDamage);
      }
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
    if (imp.explosive && imp.explosionRadiusMeters > 0 && !this.zeroTrustEnabled) {
      const blastR = imp.explosionRadiusMeters;
      for (const u of this.units.units) {
        const torsoY = u.y + Math.max(0.7, u.widthMeters * 0.6);
        const dx = u.x - imp.x;
        const dy = torsoY - imp.y;
        const dz = u.z - imp.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist >= blastR) continue;
        const falloff = 1 - dist / blastR;
        const dmg = imp.damagePeak * 0.4 * falloff;
        u.hp -= dmg;
        this.mirrorEntityDamage(u.id, dmg);
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
   * Pick a passable nav cell adjacent to the trunk's nav cell so a worker can
   * chop without needing the path planner to land inside a tree-blocked
   * column. Walks the 8 neighbours (and a 5×5 fallback ring), filters by
   * `groundCellAt` constrained to ~1 m above the local surface so the
   * candidate is at ground level rather than above the canopy, and picks the
   * one nearest the worker. Returns null when every candidate is blocked —
   * the caller should drop the trunk and find another tree.
   */
  private findChopApproach(
    workerX: number, workerZ: number, trunkX: number, trunkZ: number,
  ): { x: number; y: number; z: number } | null {
    if (!this.pathfinder) return null;
    const tcx = Math.max(0, Math.min(NAV_W - 1, Math.floor(trunkX / NAV_CELL_METERS)));
    const tcz = Math.max(0, Math.min(NAV_H - 1, Math.floor(trunkZ / NAV_CELL_METERS)));
    let best: { x: number; y: number; z: number } | null = null;
    let bestD = Infinity;
    const reach = WORKER_CHOP_REACH_M;
    const reach2 = reach * reach;
    for (let ring = 1; ring <= 2 && best === null; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const ncx = tcx + dx, ncz = tcz + dz;
          if (ncx < 0 || ncz < 0 || ncx >= NAV_W || ncz >= NAV_H) continue;
          const cellX = (ncx + 0.5) * NAV_CELL_METERS;
          const cellZ = (ncz + 0.5) * NAV_CELL_METERS;
          // Cell must be within chop reach of the trunk so the worker can
          // actually swing once it arrives. Past ring 1 most diagonals
          // already fail this gate, but the explicit check makes the intent
          // clear and keeps the function correct if reach changes.
          const tdx = cellX - trunkX, tdz = cellZ - trunkZ;
          if (tdx * tdx + tdz * tdz > reach2) continue;
          const sy = this.surfaceWorldY(cellX, cellZ);
          const ground = this.pathfinder.groundCellAt('worker', cellX, cellZ, sy + NAV_CELL_METERS);
          if (!ground) continue;
          const wdx = cellX - workerX, wdz = cellZ - workerZ;
          const d = wdx * wdx + wdz * wdz;
          if (d < bestD) {
            bestD = d;
            // Return the *ground cell's* y-centre, not the surface metres,
            // so `cellAt(wx, wy, wz)` resolves to the same cy `groundCellAt`
            // already proved passable. Otherwise `nearestPassable` snaps the
            // goal to a different cy and the worker lands in a cell that
            // happens to be passable but isn't adjacent to the trunk.
            best = { x: cellX, y: (ground.cy + 0.5) * NAV_CELL_METERS, z: cellZ };
          }
        }
      }
    }
    return best;
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
  /**
   * Refresh the AoE3-style selection portrait panel between the action
   * grid and the task list. Shows the lead-selected unit / building's
   * portrait, name, and a small stat block. The panel is keyed on (lead
   * id, lead kind, hp) so it only re-renders when the visible content
   * actually changes.
   */
  private renderSelectionPortrait(): void {
    const panel = this.selPanelEl;
    if (!panel) return;
    const selBuilding = this.buildings.getSelected();
    const selUnits = this.units.units.filter(u => u.selected);
    const lead: Building | Unit | null =
      selBuilding ?? (selUnits.length > 0 ? selUnits[0]! : null);
    if (!lead) {
      if (this.selRenderedKey !== 'empty') {
        panel.classList.add('empty');
        this.selRenderedKey = 'empty';
      }
      return;
    }
    const isBuilding = 'spec' in lead && 'maxHp' in lead && 'wallVoxelsAtBuild' in (lead as Building);
    const hpInt = Math.max(0, Math.ceil((lead as { hp: number }).hp));
    const maxHp = (lead as { maxHp: number }).maxHp ?? 0;
    const id = (lead as { id: number }).id;
    const kindOrLabel = isBuilding ? (lead as Building).spec.kind : (lead as Unit).kind;
    const groupCount = isBuilding ? 1 : selUnits.length;
    const key = `${isBuilding ? 'b' : 'u'}:${id}:${kindOrLabel}:${groupCount}:${hpInt}:${maxHp}`;
    if (key === this.selRenderedKey) return;
    this.selRenderedKey = key;
    panel.classList.remove('empty');

    // Portrait artwork.
    if (this.selPortraitEl) {
      this.selPortraitEl.innerHTML = '';
      if (isBuilding) {
        this.selPortraitEl.appendChild(makeBuildingPortraitTile(lead as Building));
      } else {
        // Reuse the static portrait tile (no key label, just the SVG).
        this.selPortraitEl.appendChild(makeUnitPortraitTile((lead as Unit).kind));
      }
    }

    // Name + subtitle.
    if (this.selNameEl) {
      this.selNameEl.textContent = isBuilding
        ? `${(lead as Building).spec.label} #${id}`
        : groupCount > 1
          ? `${groupCount} ${kindOrLabel}s`
          : `${kindOrLabel} #${id}`;
    }
    if (this.selSubEl) {
      if (isBuilding) {
        const b = lead as Building;
        const stateBits: string[] = [];
        if (b.upgradeState !== 'enabled') stateBits.push(b.upgradeState);
        if (b.spec.kind === 'hq') stateBits.push(`tier ${b.tier}`);
        this.selSubEl.textContent = stateBits.join(' · ') || 'operational';
      } else {
        const u = lead as Unit;
        const armed = u.weapon !== null;
        this.selSubEl.textContent = armed
          ? `stance: ${u.stance}`
          : u.kind === 'worker' ? `focus: ${u.workerFocus}` : 'civilian';
      }
    }

    // Stat block.
    if (this.selStatsEl) {
      this.selStatsEl.innerHTML = '';
      const addStat = (k: string, v: string): void => {
        const ke = document.createElement('span');
        ke.className = 'sel-stat-key';
        ke.textContent = k;
        const ve = document.createElement('span');
        ve.className = 'sel-stat-val';
        ve.textContent = v;
        this.selStatsEl!.appendChild(ke);
        this.selStatsEl!.appendChild(ve);
      };
      addStat('HP', `${hpInt} / ${maxHp}`);
      if (isBuilding) {
        const b = lead as Building;
        if (b.spec.kind === 'hq') addStat('Trucks', `${b.activeTrucks} / ${this.buildings.hqMaxTrucks(b)}`);
        if (b.spec.kind === 'storage') addStat('Stock', `M${b.stockpile.metals} W${b.stockpile.wood}`);
        if (b.spec.produces.length > 0 && b.trainQueue.length > 0) addStat('Queue', b.trainQueue.length.toString());
        if (b.upgradeState === 'pending' && b.constructionTotal > 0) {
          const pct = Math.round((1 - b.constructionTimer / b.constructionTotal) * 100);
          addStat('Build', `${pct}%`);
        }
      } else {
        const u = lead as Unit;
        if (u.weapon !== null) addStat('Weapon', u.weapon);
        if (u.kind === 'worker') {
          const carry = u.carrying.wood + u.carrying.metals + u.carrying.food;
          if (carry > 0) addStat('Carry', `${u.carrying.wood}W ${u.carrying.metals}M ${u.carrying.food}F`);
        }
      }
    }
  }

  private renderActionPanel(): void {
    if (!this.actionsEl) return;
    const selBuilding = this.buildings.getSelected();
    const selUnits = this.units.units.filter(u => u.selected);

    if (selBuilding) {
      if (selBuilding.spec.kind === 'storage') {
        // Storage gets a custom panel: live stockpile readout + threshold slider.
        const key = `b:${selBuilding.id}:storage`;
        if (key !== this.actionsRenderedKey) {
          this.buildStorageDom(selBuilding);
          this.actionsRenderedKey = key;
        }
        // Update live stockpile numbers every frame.
        const sp = selBuilding.stockpile;
        const total = sp.metals + sp.wood;
        const stockEl = this.actionsEl.querySelector('.storage-stockpile');
        if (stockEl) stockEl.textContent = `Metals: ${sp.metals} · Wood: ${sp.wood} · Total: ${total}`;
        this.actionsEl.style.display = 'block';
        return;
      }

      const acts = buildingActionsFor(selBuilding);
      // Cache key includes per-track tiers so completing a range/trucks
      // upgrade re-renders the panel with the bumped "+1" badge instead of
      // serving a stale snapshot.
      const trackKey = Object.entries(selBuilding.upgradeTracks ?? {}).map(([k, v]) => `${k}=${v}`).sort().join(',');
      const key = `b:${selBuilding.id}:${selBuilding.spec.kind}:${selBuilding.upgradeState}:${trackKey}:${acts.map(a => a.id).join(',')}`;
      if (key !== this.actionsRenderedKey) {
        this.buildActionsDom(
          `${selBuilding.spec.label} (#${selBuilding.id})`,
          'Building',
          acts.map(a => ({
            id: a.id, label: a.label, keyLabel: a.keyLabel,
            run: (): void => this.runBuildingAction(a),
          })),
          { upgradeBuilding: selBuilding },
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
      // Include the kind composition in the cache key so a swap from a
      // soldier-only selection to soldier+sniper re-renders the portrait
      // grid.
      const kindKey = selUnits.map(u => u.kind).sort().join('|');
      const key = `u:${selUnits.length}:${lead.id}:${kindKey}:${acts.map(a => a.id).join(',')}`;
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
          {
            selectionPortraits: selUnits.length > 1
              ? selUnits.map(u => ({ kind: u.kind, id: u.id }))
              : undefined,
          },
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

    // Empty selection — render a quiet placeholder rather than hiding the
    // panel. The bottom command bar always shows the same three regions
    // (minimap / selection / tasks) so the layout doesn't jump when the
    // player clicks empty terrain.
    if (this.actionsRenderedKey !== 'empty') {
      this.actionsEl.innerHTML = '';
      const t = document.createElement('div');
      t.className = 'actions-title';
      t.textContent = 'No selection';
      this.actionsEl.appendChild(t);
      const s = document.createElement('div');
      s.className = 'actions-sub';
      s.textContent = 'Click a unit or building.';
      this.actionsEl.appendChild(s);
      this.actionsRenderedKey = 'empty';
    }
    this.actionsEl.style.display = 'block';
  }

  /** Construct the DOM rows for the actions panel from a list of entries. */
  private buildActionsDom(
    title: string,
    subtitle: string,
    rows: { id: string; label: string; keyLabel: string; run: () => void }[],
    opts: {
      selectionPortraits?: { kind: import('../sim/Units').UnitKind; id: number }[];
      upgradeBuilding?: import('../sim/Buildings').Building;
    } = {},
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

    // Selection portraits (multi-unit). Renders one tile per selected unit
    // so the player gets a quick visual census without expanding the panel.
    if (opts.selectionPortraits && opts.selectionPortraits.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'portrait-grid';
      // Cap at 24 tiles so a giant select doesn't blow out the panel; the
      // textual title already says "N units selected".
      const cap = 24;
      const list = opts.selectionPortraits.slice(0, cap);
      for (const u of list) {
        grid.appendChild(makeUnitPortraitTile(u.kind, undefined));
      }
      if (opts.selectionPortraits.length > cap) {
        const more = document.createElement('div');
        more.className = 'portrait-tile portrait-tile-static';
        more.textContent = `+${opts.selectionPortraits.length - cap}`;
        grid.appendChild(more);
      }
      this.actionsEl.appendChild(grid);
    }

    // Split actions into three buckets — portrait-style train and upgrade
    // sections, plus the legacy keyrow list for everything else. Action id
    // prefixes drive the routing: `train-*` → train portraits, `upgrade-*`
    // → upgrade portraits (skipping the dedicated cancel button which
    // stays in the keyrow), all others → keyrow.
    const trainRows = rows.filter(r => r.id.startsWith('train-'));
    const upgradeRows = rows.filter(r => r.id.startsWith('upgrade-') && r.id !== 'upgrade-cancel');
    const otherRows = rows.filter(r => !r.id.startsWith('train-') && !(r.id.startsWith('upgrade-') && r.id !== 'upgrade-cancel'));
    if (trainRows.length > 0) {
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'portrait-section-title';
      sectionTitle.textContent = 'Train';
      this.actionsEl.appendChild(sectionTitle);
      const grid = document.createElement('div');
      grid.className = 'portrait-grid';
      for (const r of trainRows) {
        const kind = r.id.slice('train-'.length) as import('../sim/Units').UnitKind;
        const btn = makeUnitPortraitButton(kind, { keyLabel: r.keyLabel });
        btn.addEventListener('click', r.run);
        grid.appendChild(btn);
      }
      this.actionsEl.appendChild(grid);
    }

    if (upgradeRows.length > 0) {
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'portrait-section-title';
      sectionTitle.textContent = 'Upgrades';
      this.actionsEl.appendChild(sectionTitle);
      const grid = document.createElement('div');
      grid.className = 'portrait-grid';
      for (const r of upgradeRows) {
        const optId = r.id.slice('upgrade-'.length);
        const opt = upgradeOptionById(optId);
        if (!opt) continue;
        const tier = opts.upgradeBuilding?.upgradeTracks[opt.id] ?? 0;
        const cost = opts.upgradeBuilding ? this.buildings.upgradeCostFor({
          ...opts.upgradeBuilding, activeUpgradeId: opt.id,
        } as import('../sim/Buildings').Building) ?? undefined : undefined;
        const btn = makeUpgradePortraitButton({
          label: opt.label, keyLabel: r.keyLabel,
          portrait: opt.portrait, description: opt.description,
          tier, cost,
        });
        btn.addEventListener('click', r.run);
        grid.appendChild(btn);
      }
      this.actionsEl.appendChild(grid);
    }

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'action-row';
      empty.textContent = '(no actions available)';
      this.actionsEl.appendChild(empty);
      return;
    }
    for (const r of otherRows) {
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

  /** Build the custom DOM panel for a selected storage building. */
  private buildStorageDom(b: Building): void {
    if (!this.actionsEl) return;
    this.actionsEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'actions-title';
    title.textContent = `Storage (#${b.id})`;
    this.actionsEl.appendChild(title);

    const stockEl = document.createElement('div');
    stockEl.className = 'actions-sub storage-stockpile';
    const sp = b.stockpile;
    stockEl.textContent = `Metals: ${sp.metals} · Wood: ${sp.wood} · Total: ${sp.metals + sp.wood}`;
    this.actionsEl.appendChild(stockEl);

    // Threshold slider row
    const row = document.createElement('div');
    row.className = 'action-row storage-threshold-row';
    row.style.cssText = 'flex-direction:column;align-items:flex-start;gap:4px;padding:6px 8px;';

    const lbl = document.createElement('div');
    lbl.className = 'action-label';
    lbl.style.marginBottom = '2px';
    lbl.textContent = 'Call truck when ≥';
    row.appendChild(lbl);

    const sliderWrap = document.createElement('div');
    sliderWrap.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '200';
    slider.step = '5';
    slider.value = String(b.truckCallThreshold);
    slider.style.cssText = 'flex:1;cursor:pointer;';

    const valEl = document.createElement('span');
    valEl.className = 'action-label';
    valEl.style.cssText = 'min-width:32px;text-align:right;font-weight:bold;';
    valEl.textContent = String(b.truckCallThreshold);

    slider.addEventListener('input', () => {
      b.truckCallThreshold = Number(slider.value);
      valEl.textContent = slider.value;
    });

    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(valEl);
    row.appendChild(sliderWrap);
    this.actionsEl.appendChild(row);
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

  /**
   * Per-frame anti-air targeting for friendly `aa_vehicle` units. Walks every
   * live enemy projectile (skipping AA missiles to avoid an interception
   * loop), assigns each one to the nearest in-range AA vehicle, and emits a
   * lead-solved firing target — same lead pipeline as the static AA turret,
   * just per-unit. The vehicle's flak gun (`aa_flak`) takes it from there
   * via `tickWeapons`.
   *
   * Skipped silently when there are no friendly AA vehicles, no enemy
   * projectiles, or the unit already holds a target this frame (the player
   * may have manually issued one).
   */
  private tickAAVehicles(): void {
    const projectiles = this.projectiles.projectiles;
    if (projectiles.length === 0) return;
    type AAEntry = { u: Unit; r2: number; flak: number };
    const aaUnits: AAEntry[] = [];
    for (const u of this.units.units) {
      if (u.kind !== 'aa_vehicle' || u.hp <= 0) continue;
      if (u.team !== 'player') continue;
      if (u.weapon === null) continue;
      if (u.firingTarget) continue;
      if (u.fireCooldown > 0) continue;
      const w = WEAPONS[u.weapon];
      const flak = Math.min(
        PROJECTILES[w.projectile].muzzleVelocity * w.velocityScale,
        u.launcherMaxStrength,
      );
      aaUnits.push({ u, r2: w.rangeMeters * w.rangeMeters, flak });
    }
    if (aaUnits.length === 0) return;

    // Per-vehicle "best assigned projectile" pass. Each projectile attaches
    // to the nearest in-range AA vehicle so two vehicles never waste shots
    // on the same threat.
    const assignedToVehicle = new Map<number, { p: typeof projectiles[number]; d2: number }>();
    for (const p of projectiles) {
      if (p.dead) continue;
      if (p.kind === 'aa_missile') continue;
      // Friendly-fire gate: only engage rounds owned by enemies.
      if (p.ownerId >= 0) {
        const owner = this.units.units.find(o => o.id === p.ownerId);
        if (owner && owner.team === 'player') continue;
      } else if (p.ownerId !== -1) {
        continue; // negative non-(-1) = friendly building
      }

      let bestIdx = -1;
      let bestD2 = Infinity;
      for (let i = 0; i < aaUnits.length; i++) {
        const { u, r2 } = aaUnits[i]!;
        const dx = p.x - u.x, dy = p.y - (u.y + 1.6), dz = p.z - u.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      if (bestIdx < 0) continue;
      const u = aaUnits[bestIdx]!.u;
      const prev = assignedToVehicle.get(u.id);
      if (!prev || bestD2 < prev.d2) assignedToVehicle.set(u.id, { p, d2: bestD2 });
    }

    for (const [unitId, { p }] of assignedToVehicle) {
      const u = aaUnits.find(e => e.u.id === unitId)!.u;
      const flak = aaUnits.find(e => e.u.id === unitId)!.flak;
      const muzzleY = u.y + 1.6;
      const dxNow = p.x - u.x;
      const dyNow = p.y - muzzleY;
      const dzNow = p.z - u.z;
      const distNow = Math.hypot(dxNow, dyNow, dzNow);
      const tof = Math.max(0.05, distNow / Math.max(20, flak));
      const targetGrav = PROJECTILE_GRAVITY * (PROJECTILES[p.kind].gravityScale ?? 1);
      const leadX = p.x + p.vx * tof;
      const leadY = Math.max(0.5, p.y + p.vy * tof - 0.5 * targetGrav * tof * tof - 1.0);
      const leadZ = p.z + p.vz * tof;
      u.firingTarget = { x: leadX, y: leadY, z: leadZ };
    }
  }

  private tickAggressiveStance(dt: number): void {
    const liveUnits = this.units.units.filter(u => u.hp > 0);
    const liveBuildings = this.buildings.buildings.filter(b => !b.destroyed);
    // Phase 4.3b: reconcile server-side weapon arming for every
    // mirrored unit. If the unit is in aggressive stance and has a
    // weapon, the server should be firing it; we send arm_unit on
    // first transition. Hold-fire / no-weapon → disarm_unit. Issued
    // only on transitions, so steady-state cost is zero.
    if (this.zeroTrustEnabled && this.gameClient) {
      for (const u of this.units.units) {
        if (!this.mirroredUnitIds.has(u.id)) continue;
        // Server-side firing currently only fires for player-team
        // entities. Letting enemy AI units be added to
        // `serverArmedUnitIds` makes the local engage pass skip them
        // (it expects the server to fire), but the server won't.
        // Net: enemy aggression silently dies.  Keep enemies on the
        // local firing path.
        if (u.team !== 'player') continue;
        const eligible = u.hp > 0 && u.weapon !== null && u.stance === 'aggressive';
        const armed = this.serverArmedUnitIds.has(u.id);
        if (eligible && !armed) {
          this.sendArmUnit(u);
          this.serverArmedUnitIds.add(u.id);
        } else if (!eligible && armed) {
          this.gameClient.send({
            type: 'disarm_unit',
            clientTag: this.unitClientTag(u.id),
            owner: this.gameClient.playerId,
          });
          this.serverArmedUnitIds.delete(u.id);
        }
      }
    }
    for (const u of this.units.units) {
      if (u.weapon === null) continue;
      if (u.stance !== 'aggressive') continue;
      // Phase 4.3b: server is firing this unit. Local target picking
      // + projectile spawn is suppressed for armed mirrored units —
      // visuals come from the server's projectile snapshot stream.
      if (this.zeroTrustEnabled && this.serverArmedUnitIds.has(u.id)) continue;
      if (u.firingTarget) continue;
      if (u.burstShotsRemaining > 0) continue;
      if (u.autoEngageCooldown > 0) {
        u.autoEngageCooldown = Math.max(0, u.autoEngageCooldown - dt);
        continue;
      }
      const w = WEAPONS[u.weapon];
      const range2 = w.rangeMeters * w.rangeMeters;

      // Threat-based target picking with a proximity bonus folded in.
      // Score = baseThreat + PROXIMITY_BONUS_MAX × (1 − dist/range), so:
      //   - a touching target gets a +PROXIMITY_BONUS_MAX boost,
      //   - a target at the edge of range gets +0,
      //   - the linear falloff is small enough that a higher-threat
      //     target still wins when the threat gap exceeds the
      //     proximity gap (e.g. a far-but-in-range tank beats a
      //     touching worker; an in-your-face soldier beats a far one
      //     of the same kind).
      const range = w.rangeMeters;
      const PROXIMITY_BONUS_MAX = 20;
      let targetUnit: Unit | null = null;
      let targetBuilding: Building | null = null;
      let bestScore = -Infinity;
      for (const e of liveUnits) {
        if (e.team === u.team) continue;
        const dx = e.x - u.x, dz = e.z - u.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > range2) continue;
        const proximity = PROXIMITY_BONUS_MAX * Math.max(0, 1 - Math.sqrt(d2) / range);
        const score = (UNIT_THREAT[e.kind] ?? 30) + proximity;
        if (score > bestScore) {
          bestScore = score;
          targetUnit = e; targetBuilding = null;
        }
      }
      for (const b of liveBuildings) {
        if (b.team === u.team) continue;
        const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_METERS;
        const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_METERS;
        const dx = cxw - u.x, dz = czw - u.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > range2) continue;
        const proximity = PROXIMITY_BONUS_MAX * Math.max(0, 1 - Math.sqrt(d2) / range);
        const score = buildingThreatLevel(b) + proximity;
        if (score > bestScore) {
          bestScore = score;
          targetBuilding = b; targetUnit = null;
        }
      }
      if (!targetUnit && !targetBuilding) continue;

      // Pick a torso point to aim at. For unit targets that's the torso
      // sphere centre; for buildings we aim at the structure's voxel
      // centroid so the round actually lands on a wall / roof.
      let tx: number, ty: number, tz: number;
      // Tolerance the trajectory needs to come within to count as
      // "reaching" the target. For units that's the body sphere; for
      // buildings we use the AABB half-diagonal so any voxel the
      // trajectory clips counts as a hit (a near wall belongs to the
      // building too).
      let reachR: number;
      if (targetUnit) {
        tx = targetUnit.x;
        ty = targetUnit.y + Math.max(0.7, targetUnit.widthMeters * 0.6);
        tz = targetUnit.z;
        reachR = targetUnit.widthMeters * 0.55 + 0.35;
      } else {
        const b = targetBuilding!;
        tx = b.aimWX;
        ty = b.aimWY;
        tz = b.aimWZ;
        const halfW = b.spec.cellsW * NAV_CELL_METERS * 0.5;
        const halfD = b.spec.cellsD * NAV_CELL_METERS * 0.5;
        reachR = Math.hypot(halfW, halfD);
      }
      const cfg = PROJECTILES[w.projectile];
      const explosionR = cfg.explosive ? cfg.explosionRadiusMeters : 0;

      // Predict the projectile's actual trajectory (gravity, drag) and
      // see whether it clips the target sphere anywhere along the arc.
      // If yes, fire. If the round arcs short — typical for a
      // launcher pointed at the edge of its range — we step a little
      // closer and try again next tick. The body sphere covers the
      // building's footprint so a shot that's going to hit a wall
      // counts as reach: that's still damage to the structure.
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
      const reaches = arcReachesPoint(points, tx, ty, tz, reachR + explosionR);
      if (reaches) {
        u.firingTarget = { x: tx, y: ty, z: tz };
        u.autoEngageCooldown = 0.25;
        continue;
      }
      // Arc fell short. Step closer and retry — don't fire a wasted
      // shot. We move ~25 % of the remaining gap (min 2 m), capped so a
      // single step never overshoots the target. The 0.6 s cooldown
      // gives the path time to resolve before the next reach check.
      u.autoEngageCooldown = 0.6;
      if (u.path.length > 0) continue;
      const distToTarget = Math.hypot(tx - u.x, tz - u.z);
      const step = Math.min(distToTarget - 1, Math.max(2, distToTarget * 0.25));
      if (step <= 0) continue;
      const scale = step / distToTarget;
      const goalX = u.x + (tx - u.x) * scale;
      const goalZ = u.z + (tz - u.z) * scale;
      void this.routePath(u, goalX, u.y, goalZ);
    }
  }

  /**
   * Hotkey handler for the Y-cutoff overlay. `[` lowers the cutoff (more
   * terrain hidden above it), `]` raises it (more terrain visible), `\`
   * snaps it back to the world top. Holding shift quadruples the step. The
   * cutoff is clamped between 0.5 m and the world top so the player can't
   * push it negative or beyond the sky.
   */
  private adjustHideAboveY(): void {
    const shift = this.input.keys.has('ShiftLeft') || this.input.keys.has('ShiftRight');
    const step = shift ? 4 : 1;
    const minY = 0.5;
    const maxY = WORLD_Y * VOXEL_SIZE;
    let v = this.hideAboveY;
    if (this.input.pressed.has('Backslash')) {
      v = maxY;
    } else if (this.input.pressed.has('BracketLeft')) {
      v = Math.max(minY, v - step);
    } else if (this.input.pressed.has('BracketRight')) {
      v = Math.min(maxY, v + step);
    }
    this.hideAboveY = v;
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
 * Does any segment of the predicted projectile arc come within `tol` of
 * the target point? Used by the aggressive-stance pipeline to decide
 * whether the round will physically reach — if the arc dies short
 * (gravity dropping the round on a closer voxel, drag stopping it
 * before the target), the unit advances rather than wasting ammo.
 *
 * For explosive rounds the caller should pass `bodyR + explosionRadius`
 * as `tol` so a near-miss inside the blast still counts as reach.
 */
function arcReachesPoint(
  points: { x: number; y: number; z: number }[],
  tx: number, ty: number, tz: number,
  tol: number,
): boolean {
  if (points.length < 2) return false;
  const tol2 = tol * tol;
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
    if (dxs * dxs + dys * dys + dzs * dzs <= tol2) return true;
  }
  return false;
}

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

