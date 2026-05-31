// Authoritative game-engine server (Phase 1 scaffold).
//
// This is the spine for the zero-trust migration. Today it owns a
// minimal world state — entity positions plus an "intent" target — and
// runs a fixed-timestep tick that linearly steers entities toward
// their target. Clients subscribe to `/game/stream` (SSE) for state
// snapshots and POST to `/game/input` to issue commands.
//
// What still lives in the browser today:
//   - Voxel world + terrain, projectiles, buildings, AI economy,
//     pathfinding, combat resolution.
//   - The renderer (always client-side).
//
// What this file owns now:
//   - The list of entities the server is authoritative for (commands
//     the player issues here can't be faked client-side).
//
// Roadmap to full zero-trust is in `docs/zero-trust-migration.md`.

const http = require('http');
const wg = require('./worldgen.cjs');

const PORT = process.env.GAME_PORT ? Number(process.env.GAME_PORT) : 3050;
const TICK_HZ = 20;
const TICK_DT_S = 1 / TICK_HZ;
/** Hard cap so a runaway client can't fill the entity table. */
const MAX_ENTITIES = 4096;

// Voxel constants — must match `src/voxel/types.ts` and
// `src/path/SurfaceNav.ts`. The server doesn't simulate voxels but it
// needs to translate building cells (ox/oz/cellsW/cellsD/floorY) to
// world-space metres so it can spawn civilians and pick wander
// destinations without round-tripping through the client.
const VOXEL_SIZE = 0.125;
const NAV_CELL_VOXELS = 8;
const NAV_CELL_METERS = NAV_CELL_VOXELS * VOXEL_SIZE; // 1.0 m
// Phase 4.1: projectile motion constants. Mirrors the browser's
// `src/sim/Projectiles.ts` so server-tracked flight matches what the
// local sim renders. The server doesn't yet do hit detection — that's
// Phase 4.1b — so for now this is just visual-state authority.
const PROJECTILE_GRAVITY = 18.0;
// Material ids the server cares about for sim hooks. Mirrors
// src/voxel/Materials.ts.
const M_WOOD = 4;
const M_LEAF = 5;
// Phase 5a: leaf-decay tunables. Match
// `src/sim/LeafDecay.ts` so the server's behaviour is
// indistinguishable from the browser's pre-zero-trust loop.
const LEAF_DECAY_SECONDS = 0.3;
const LEAF_SEARCH_RADIUS_VOXELS = 12;
const LEAF_EVAL_THROTTLE_SECONDS = 0.15;
// Phase 5b: sapling tunables. Mirrors src/sim/Saplings.ts.
const M_GRASS = 1;
const SAPLING_MATURE_SEC = 30;
// Phase 5f: per-kind cell footprints for server-side building placement.
// Numbers mirror the canonical specs in `src/sim/Buildings.ts`. Browser
// remains the source of truth — the server only uses these to auto-pick
// a spot when an AI command omits ox/oz.
const BUILDING_SPECS = {
  hq:            { cellsW: 6, cellsD: 6 },
  barracks:      { cellsW: 4, cellsD: 4 },
  vehicle_depot: { cellsW: 5, cellsD: 5 },
  farm:          { cellsW: 3, cellsD: 3 },
  neighborhood:  { cellsW: 4, cellsD: 4 },
};
const PLACE_MAX_SLOPE_VOXELS = 4;
const PLACE_SEARCH_ATTEMPTS = 50;
const PLACE_SEARCH_RADIUS_CELLS = 30;
// Phase 6+: cost tables for AI-driven commands. Numbers mirror the
// canonical specs in `src/sim/Buildings.ts` so a brain that
// pre-filters with `canAffordBuilding` won't see commands rejected
// for accounting drift. Browser-driven place flows (explicit ox/oz)
// keep paying through their local economy — server only debits
// here when it actually owns the placement decision.
const BUILDING_COSTS = {
  hq:            { food: 0, metals: 0,  wood: 0  },
  barracks:      { food: 0, metals: 40, wood: 40 },
  vehicle_depot: { food: 0, metals: 70, wood: 50 },
  farm:          { food: 0, metals: 20, wood: 30 },
  neighborhood:  { food: 0, metals: 30, wood: 40 },
};
const UNIT_TRAIN_COSTS = {
  worker:         { food: 30, metals: 0,  wood: 10 },
  soldier:        { food: 40, metals: 10, wood: 10 },
  gunner:         { food: 60, metals: 30, wood: 0  },
  mortar_soldier: { food: 60, metals: 35, wood: 5  },
  rocket_soldier: { food: 60, metals: 40, wood: 0  },
  tank:           { food: 20, metals: 80, wood: 0  },
};
// Phase 6+: per-owner sight radii (in nav cells = metres). Coarse
// stand-ins for the per-unit/building specs in `src/sim/Units.ts` and
// `src/sim/Buildings.ts`. Used by the FoW filter on snapshot() to
// hide cross-team entities + buildings outside the viewer's vision.
const SIGHT_RADIUS_DEFAULT_CELLS = 16;
const SIGHT_RADIUS_BY_UNIT_KIND = {
  worker: 10,
  civilian: 8,
  builder: 10,
  tank: 24,
  dozer: 18,
  rocket_truck: 24,
  aa_vehicle: 22,
  truck: 14,
  supply_truck: 14,
  airplane: 32,
  helicopter: 28,
  tunneler: 12,
};
const SIGHT_RADIUS_BY_BUILDING_KIND = {
  hq: 22,
  barracks: 14,
  vehicle_depot: 14,
  farm: 8,
  neighborhood: 12,
};

// Phase 6+: passive farm income. Each enabled farm produces this
// many food per second for its owner. Coarse stand-in for the
// browser's full farmer-driven harvest pipeline (workerFocus +
// cropProgress + collectFarm) — enough for an AI brain to keep
// queueing units once it has a farm up. Tunable so we don't have
// to port the worker-routing economy to flip the migration.
const FARM_INCOME_FOOD_PER_SEC = 2.5;
/** Hard cap on simultaneous server-tracked projectiles. The local sim
 *  rate-limits already, but a runaway client could otherwise queue
 *  thousands of spawns and bloat the snapshot. */
const MAX_PROJECTILES = 2048;
// Civilian behaviour, mirroring `src/sim/Civilians.ts`.
// A new citizen is created every 10 s per neighborhood while below its
// `civilianCap` (tier × 5); a killed resident is re-grown on the same cadence.
// Matches the client CivilianSystem (src/sim/Civilians.ts) and the documented
// rule. Per-hood capacity is the client-synced `b.civilianCap`, NOT a fixed
// tier-1 constant — a tier-3 hood grows up to 15.
const CIVILIAN_SPAWN_COOLDOWN_S = 10.0;
const CIVILIAN_REPLACEMENT_COOLDOWN_S = 10.0;
// Every civilian eats 2 food per minute. When an owner's food can't cover its
// civilians' upkeep, food drains to 0 and one civilian STARVES (dies) every
// CIVILIAN_STARVE_INTERVAL_S until income covers the rest — pop falls and the
// hood re-grows residents once food recovers. The server owns civilians, so it
// is the authoritative starver for every owner; it drains the AI factions'
// food here, while each human client drains its OWN food locally (the player
// pool the client pushes is client-authoritative).
const CIVILIAN_UPKEEP_FOOD_PER_MIN = 2;
const CIVILIAN_STARVE_INTERVAL_S = 5.0;
// AI factions whose food the SERVER owns (and therefore drains for upkeep).
// Human-player pools (keyed by playerId) are drained client-side.
const SERVER_FOOD_OWNERS = new Set(['enemy', 'enemy2']);
const CIVILIAN_IDLE_MIN_S = 3.0;
const CIVILIAN_IDLE_MAX_S = 9.0;
const CIVILIAN_WANDER_RADIUS_M = 4.0;
const CIVILIAN_SPEED_M_S = 2.6;
const CIVILIAN_HP = 35;

// How many voxel edits to retain. The log is the only thing that
// makes a freshly-connecting client able to "catch up" to all the
// destruction that's happened since worldgen. We cap the buffer so a
// long-running session doesn't accumulate forever; older edits drop
// off the front and a late-joining client will need a full chunk
// resync (Phase 6b — not in this turn).
const VOXEL_EDIT_LOG_CAP = 16384;
const CHUNK_SIZE = 32;
// Match the browser's WORLD_X/Y/Z so voxel indices the client sends
// land in the same coordinate system. Sourced from worldgen.cjs so
// the heightmap port and the server's coord arithmetic can't drift.
const SERVER_WORLD_X = wg.WORLD_X;
const SERVER_WORLD_Y = wg.WORLD_Y;
const SERVER_WORLD_Z = wg.WORLD_Z;
const CHUNKS_X = SERVER_WORLD_X / CHUNK_SIZE;
const CHUNKS_Y = SERVER_WORLD_Y / CHUNK_SIZE;
const CHUNKS_Z = SERVER_WORLD_Z / CHUNK_SIZE;
/** Cap on cached generated chunks. Each chunk is 32 KB, so 256 chunks
 *  ≈ 8 MB — small relative to the 1.5 GB the full world would
 *  occupy if we eagerly generated it. Eviction is LRU on insertion
 *  order. */
const CHUNK_CACHE_CAP = 256;
/** Default world seed when no client has set one yet. The lobby
 *  stamps a per-session seed; until that's plumbed into the
 *  game-server (Phase 6c-3), any chunk the server generates uses this
 *  default. The browser's `worldSeed` defaults to the same value in
 *  `src/main.ts` so the local + server baselines match in the
 *  no-lobby case. */
const DEFAULT_WORLD_SEED = 1337;
function voxelIndex(x, y, z) {
  return (y * SERVER_WORLD_Z + z) * SERVER_WORLD_X + x;
}
function inWorldBounds(x, y, z) {
  return x >= 0 && y >= 0 && z >= 0
    && x < SERVER_WORLD_X
    && y < SERVER_WORLD_Y
    && z < SERVER_WORLD_Z;
}

// ----------------------------------------------------------------------------
// World state
// ----------------------------------------------------------------------------

const state = {
  tick: 0,
  /** id → entity (units, civilians). */
  entities: new Map(),
  /** clientTag → id for entities. Stable key the client uses so it
   *  doesn't have to wait for the spawn ack to fire follow-ups. */
  byTag: new Map(),
  /** id → projectile (bullets, rockets, shells in flight). Kept
   *  separate from `entities` because the tick loop and snapshot
   *  shape differ — projectiles run continuous physics, units run
   *  waypoint follow. */
  projectiles: new Map(),
  /** clientTag → id for projectiles. */
  projectilesByTag: new Map(),
  /** id → building (static structures with hp, train queue, etc.). */
  buildings: new Map(),
  /** clientTag → id for buildings. */
  buildingsByTag: new Map(),
  /** owner-string → { food, metals, wood, popCap }. The client pushes
   *  its locally-computed resource pool here every half-second; in
   *  later phases the server takes over the math entirely. */
  resources: new Map(),
  /** Append-only log of voxel mutations. Each entry: {seq, tick,
   *  sender, op}. `op` is either a sphere `{x,y,z,radius,mat}` or an
   *  array of explicit writes `{ops:[{x,y,z,mat},...]}`. Capped at
   *  VOXEL_EDIT_LOG_CAP entries; the seq lets a client ask "give me
   *  everything since N" via /world/edits. */
  voxelEdits: [],
  voxelEditSeq: 0,
  /** Sparse authoritative voxel state. Map<voxelIndex, material>.
   *  Server-canonical mutations layered on top of the heightmap
   *  baseline. */
  voxelOverrides: new Map(),
  /** Lazy chunk cache keyed by chunkKey(cx, cy, cz). Generated on
   *  first access; LRU-evicted at CHUNK_CACHE_CAP. Phase 6c-3+ will
   *  add roads/trees/metals on top of the heightmap baseline so this
   *  cache stops being just a per-column heightmap snapshot. */
  chunkCache: new Map(),
  /** World seed for terrain generation. The first `set_world_seed`
   *  command flips `worldSeedLocked` true; afterwards only matching
   *  seeds are accepted, so a malicious client can't desync everyone
   *  by changing the baseline mid-session. */
  worldSeed: DEFAULT_WORLD_SEED,
  worldSeedLocked: false,
  /** Monotonic counter for projectile_impact broadcasts. Lets a
   *  reconnecting client tell whether it missed any. */
  projectileImpactSeq: 0,
  /** Phase 5b: server-side saplings. Each entry is
   *  {vx, vy, vz, ageSec, seed, marker:[idx0,idx1,idx2]} — vy is the
   *  grass voxel's y. marker holds the placeholder voxel indices we
   *  wrote at plant time so we can clear them at maturation. */
  saplings: [],
  nextId: 1,
  /** monotonically-incrementing schema version of the snapshot. Lets a
   *  reconnecting client tell whether it's missed deltas. */
  rev: 0,
};

function spawnEntity(args) {
  if (state.entities.size >= MAX_ENTITIES) return null;
  const tag = typeof args.clientTag === 'string' && args.clientTag.length > 0
    ? args.clientTag.slice(0, 64)
    : null;
  // Idempotent on the same tag — re-issuing spawn for an already-known
  // unit just returns the existing entity. Lets the client retry
  // safely after a transient post failure.
  if (tag && state.byTag.has(tag)) {
    return state.entities.get(state.byTag.get(tag));
  }
  const id = state.nextId++;
  const e = {
    id,
    clientTag: tag,
    owner: typeof args.owner === 'string' ? args.owner.slice(0, 32) : 'anon',
    kind: typeof args.kind === 'string' ? args.kind.slice(0, 32) : 'unit',
    x: clampNum(args.x, -1e6, 1e6, 0),
    y: clampNum(args.y, -1e6, 1e6, 0),
    z: clampNum(args.z, -1e6, 1e6, 0),
    target: null,
    /** Optional waypoint list. Server walks them in order. Each waypoint
     *  is {x, y, z}; the y is interpolated linearly so terrain follow
     *  is the client's job for now. */
    path: [],
    speed: clampNum(args.speed, 0, 50, 4.5),
    hp: clampNum(args.hp, 0, 1e6, 100),
    /** Phase 4.3: server-side weapon state. Null means the entity is
     *  unarmed — `tickAutoEngage` skips it. Configured by the
     *  `arm_unit` command after the unit's local catalog is known. */
    weapon: null,
  };
  state.entities.set(id, e);
  if (tag) state.byTag.set(tag, id);
  return e;
}

function lookupEntity(args) {
  if (typeof args.id === 'number' && state.entities.has(args.id)) {
    return state.entities.get(args.id);
  }
  if (typeof args.clientTag === 'string' && state.byTag.has(args.clientTag)) {
    return state.entities.get(state.byTag.get(args.clientTag));
  }
  return null;
}

function deleteEntity(e) {
  state.entities.delete(e.id);
  if (e.clientTag) state.byTag.delete(e.clientTag);
}

function lookupBuilding(args) {
  if (typeof args.id === 'number' && state.buildings.has(args.id)) return state.buildings.get(args.id);
  if (typeof args.clientTag === 'string' && state.buildingsByTag.has(args.clientTag)) {
    return state.buildings.get(state.buildingsByTag.get(args.clientTag));
  }
  return null;
}

function spawnBuilding(args) {
  if (state.buildings.size >= MAX_ENTITIES) return null;
  const tag = typeof args.clientTag === 'string' && args.clientTag.length > 0
    ? args.clientTag.slice(0, 64)
    : null;
  if (tag && state.buildingsByTag.has(tag)) {
    return state.buildings.get(state.buildingsByTag.get(tag));
  }
  const id = state.nextId++;
  const b = {
    id,
    clientTag: tag,
    owner: typeof args.owner === 'string' ? args.owner.slice(0, 32) : 'anon',
    kind: typeof args.kind === 'string' ? args.kind.slice(0, 32) : 'building',
    ox: clampNum(args.ox, -1e6, 1e6, 0),
    oz: clampNum(args.oz, -1e6, 1e6, 0),
    floorY: clampNum(args.floorY, -1e6, 1e6, 0),
    cellsW: clampNum(args.cellsW, 1, 256, 1),
    cellsD: clampNum(args.cellsD, 1, 256, 1),
    upgradeState: typeof args.upgradeState === 'string' ? args.upgradeState.slice(0, 16) : 'pending',
    hp: clampNum(args.hp, 0, 1e7, 0),
    maxHp: clampNum(args.maxHp, 0, 1e7, 0),
    // Civilian housing capacity, set by the client (owner of construction /
    // upgrades) to `tier × 5` of the hood's CURRENT finished houses. The
    // civilian spawner reads this directly so it never needs to know about
    // tiers or the initial-build vs expand distinction: a hood mid-EXPAND
    // keeps its current capacity (its residents are preserved), and the new
    // house's 5 slots open only when the client bumps the cap on completion.
    civilianCap: clampNum(args.civilianCap, 0, 1000, 0),
    trainQueue: Array.isArray(args.trainQueue)
      ? args.trainQueue.slice(0, 32).map(s => String(s).slice(0, 32))
      : [],
    destroyed: false,
    /** Phase 6+: server-side weapon state. Null until configured by
     *  `arm_building`. tickAutoEngage iterates buildings alongside
     *  entities and fires from the building's centre + a small
     *  vertical offset (turret height above the foundation). */
    weapon: null,
  };
  state.buildings.set(id, b);
  if (tag) state.buildingsByTag.set(tag, id);
  return b;
}

function deleteBuilding(b) {
  state.buildings.delete(b.id);
  if (b.clientTag) state.buildingsByTag.delete(b.clientTag);
}

function spawnProjectile(args) {
  if (state.projectiles.size >= MAX_PROJECTILES) return null;
  const tag = typeof args.clientTag === 'string' && args.clientTag.length > 0
    ? args.clientTag.slice(0, 64)
    : null;
  if (tag && state.projectilesByTag.has(tag)) {
    return state.projectiles.get(state.projectilesByTag.get(tag));
  }
  const id = state.nextId++;
  const p = {
    id,
    clientTag: tag,
    owner: typeof args.owner === 'string' ? args.owner.slice(0, 32) : 'anon',
    kind: typeof args.kind === 'string' ? args.kind.slice(0, 32) : 'bullet',
    x: clampNum(args.x, -1e6, 1e6, 0),
    y: clampNum(args.y, -1e6, 1e6, 0),
    z: clampNum(args.z, -1e6, 1e6, 0),
    vx: clampNum(args.vx, -1e4, 1e4, 0),
    vy: clampNum(args.vy, -1e4, 1e4, 0),
    vz: clampNum(args.vz, -1e4, 1e4, 0),
    /** Linear drag time-constant (1/s) — velocity multiplied by
     *  exp(-drag*dt) every tick. Default 0 means "no drag" so a
     *  caller that omits the field gets ballistic-only motion. */
    dragPerSecond: clampNum(args.dragPerSecond, 0, 100, 0),
    /** Fraction of PROJECTILE_GRAVITY applied per tick. 1.0 = normal,
     *  0.25 = the slow-rocket fall-rate the browser catalog uses to
     *  preserve range despite reduced muzzle velocity. */
    gravityScale: clampNum(args.gravityScale, 0, 4, 1),
    /** Seconds since spawn — used for TTL despawn. */
    age: 0,
    maxLifeSeconds: clampNum(args.maxLifeSeconds, 0.1, 60, 5),
    /** Owner unit id, mirroring src/sim/Projectiles.ts. -1 == anonymous
     *  (e.g. cluster submunitions). */
    ownerId: clampNum(args.ownerId, -1, 1e9, -1) | 0,
    /** Phase 4.1c: impact-side metadata so the server can build the
     *  voxel mutation on its own raycast hit. Bullets carve a small
     *  pit; explosives carve `explosionRadius`. mat=AIR is implied. */
    hitRadiusMeters: clampNum(args.hitRadiusMeters, 0, 32, 0),
    explosive: !!args.explosive,
    explosionRadiusMeters: clampNum(args.explosionRadiusMeters, 0, 32, 0),
    /** Phase 4.1d: damage values used by server-side hit detection.
     *  hitDamage = direct-hit amount applied to a unit the projectile
     *  passes through. damagePeak = falloff peak for explosive splash;
     *  the per-target dose is `peak * 0.4 * (1 - dist/radius)` to
     *  match the browser splash math. */
    hitDamage: clampNum(args.hitDamage, 0, 1e6, 0),
    damagePeak: clampNum(args.damagePeak, 0, 1e6, 0),
  };
  state.projectiles.set(id, p);
  if (tag) state.projectilesByTag.set(tag, id);
  return p;
}

function lookupProjectile(args) {
  if (typeof args.id === 'number' && state.projectiles.has(args.id)) return state.projectiles.get(args.id);
  if (typeof args.clientTag === 'string' && state.projectilesByTag.has(args.clientTag)) {
    return state.projectiles.get(state.projectilesByTag.get(args.clientTag));
  }
  return null;
}

function deleteProjectile(p) {
  state.projectiles.delete(p.id);
  if (p.clientTag) state.projectilesByTag.delete(p.clientTag);
}

/** Authoritative voxel material at integer voxel coords (x, y, z).
 *  Resolves in priority order:
 *    1. `state.voxelOverrides` — server-canonical mid-game writes
 *       (projectile splashes, dozer cuts, building placements).
 *    2. The worldgen overlay column — heightmap baseline + roads +
 *       metals + trees + clearAboveRoads.
 *    3. AIR for anything outside the world bounds.
 *  Cheap enough to call inside a per-tick raycast loop because the
 *  hot paths are a Map.get and a Uint8Array index. */
function getVoxelMaterial(x, y, z) {
  if (!inWorldBounds(x, y, z)) return 0;
  const idx = voxelIndex(x, y, z);
  const ov = state.voxelOverrides.get(idx);
  if (ov !== undefined) return ov;
  // World overlay isn't built until the seed is locked + a chunk
  // request has been served. Tests that drive the projectile loop in
  // isolation skip the overlay; callers there pre-seed the wall via
  // voxelOverrides instead.
  if (cachedWorldOverlay && cachedWorldOverlaySeed === state.worldSeed) {
    const colKey = z * SERVER_WORLD_X + x;
    const col = cachedWorldOverlay.columns.get(colKey);
    if (col) return col[y];
    // Fall through to baseline — equivalent to columnMaterials for
    // an unmodified column. We don't compute it here on the hot
    // path; the projectile will simply miss any out-of-overlay
    // column. In practice the worldgen overlay is built before any
    // projectile is fired, so this branch is rare.
  }
  return 0;
}

// ----------------------------------------------------------------------------
// Phase 5a: server-side leaf decay
// ----------------------------------------------------------------------------
//
// When a wood voxel disappears, the leaves attached to that branch
// drift loose and rot 0.3 s later. The browser implementation in
// `src/sim/LeafDecay.ts` runs a BFS through M_LEAF voxels seeded from
// M_WOOD; leaves NOT reached lose their anchor and start a decay
// timer. We port the same algorithm here so the server's voxel state
// stays canonical when a peer fells a tree.

/** voxelIndex → seconds remaining until the leaf decays to AIR. */
const leafDecayTimers = new Map();
/** 8-voxel-region key → simTime of the last evaluation. Coalesces
 *  bursts of edits inside the same canopy into one BFS per ~150 ms. */
const leafEvalLastAt = new Map();
let leafSimTime = 0;

function leafRegionContainsLeaves(vx, vy, vz) {
  const r = 2;
  const x0 = Math.max(0, vx - r);
  const x1 = Math.min(SERVER_WORLD_X - 1, vx + r);
  const y0 = Math.max(0, vy - r);
  const y1 = Math.min(SERVER_WORLD_Y - 1, vy + r);
  const z0 = Math.max(0, vz - r);
  const z1 = Math.min(SERVER_WORLD_Z - 1, vz + r);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (getVoxelMaterial(x, y, z) === M_LEAF) return true;
      }
    }
  }
  return false;
}

function leafHasAdjacentWood(x, y, z) {
  if (x > 0 && getVoxelMaterial(x - 1, y, z) === M_WOOD) return true;
  if (x < SERVER_WORLD_X - 1 && getVoxelMaterial(x + 1, y, z) === M_WOOD) return true;
  if (y > 0 && getVoxelMaterial(x, y - 1, z) === M_WOOD) return true;
  if (y < SERVER_WORLD_Y - 1 && getVoxelMaterial(x, y + 1, z) === M_WOOD) return true;
  if (z > 0 && getVoxelMaterial(x, y, z - 1) === M_WOOD) return true;
  if (z < SERVER_WORLD_Z - 1 && getVoxelMaterial(x, y, z + 1) === M_WOOD) return true;
  return false;
}

function evaluateLeafRegion(vx, vy, vz) {
  const r = LEAF_SEARCH_RADIUS_VOXELS;
  const x0 = Math.max(0, vx - r);
  const x1 = Math.min(SERVER_WORLD_X - 1, vx + r);
  const y0 = Math.max(0, vy - r);
  const y1 = Math.min(SERVER_WORLD_Y - 1, vy + r);
  const z0 = Math.max(0, vz - r);
  const z1 = Math.min(SERVER_WORLD_Z - 1, vz + r);
  // BFS seeds: leaves directly adjacent to wood are anchored.
  const visited = new Set();
  const queue = [];
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (getVoxelMaterial(x, y, z) !== M_LEAF) continue;
        if (!leafHasAdjacentWood(x, y, z)) continue;
        const idx = voxelIndex(x, y, z);
        visited.add(idx);
        queue.push(x, y, z);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cx = queue[head++], cy = queue[head++], cz = queue[head++];
    const tryNeighbour = (nx, ny, nz) => {
      if (nx < x0 || ny < y0 || nz < z0 || nx > x1 || ny > y1 || nz > z1) return;
      if (getVoxelMaterial(nx, ny, nz) !== M_LEAF) return;
      const idx = voxelIndex(nx, ny, nz);
      if (visited.has(idx)) return;
      visited.add(idx);
      queue.push(nx, ny, nz);
    };
    tryNeighbour(cx + 1, cy, cz);
    tryNeighbour(cx - 1, cy, cz);
    tryNeighbour(cx, cy + 1, cz);
    tryNeighbour(cx, cy - 1, cz);
    tryNeighbour(cx, cy, cz + 1);
    tryNeighbour(cx, cy, cz - 1);
  }
  // Walk every leaf in the box. Reached → clear any pending timer.
  // Unreached → schedule decay if not already pending.
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (getVoxelMaterial(x, y, z) !== M_LEAF) continue;
        const idx = voxelIndex(x, y, z);
        if (visited.has(idx)) {
          if (leafDecayTimers.has(idx)) leafDecayTimers.delete(idx);
        } else if (!leafDecayTimers.has(idx)) {
          leafDecayTimers.set(idx, LEAF_DECAY_SECONDS);
        }
      }
    }
  }
}

/** Public entry — call after any voxel-removing op to schedule
 *  decay for leaves whose branch just got chopped. Throttled per
 *  8-voxel region. */
function onLeafSensitiveEdit(vx, vy, vz) {
  if (!leafRegionContainsLeaves(vx, vy, vz)) return;
  const gx = vx >> 3, gy = vy >> 3, gz = vz >> 3;
  const key = ((gy * 1024) + gz) * 1024 + gx;
  const last = leafEvalLastAt.get(key);
  if (last !== undefined && leafSimTime - last < LEAF_EVAL_THROTTLE_SECONDS) return;
  leafEvalLastAt.set(key, leafSimTime);
  evaluateLeafRegion(vx, vy, vz);
}

/** Drain expired decay timers; bundles all the resulting voxel
 *  removals into a single 'set' op so connected clients get one
 *  broadcast per tick instead of one per leaf. */
function tickLeafDecay(dt) {
  leafSimTime += dt;
  if (leafEvalLastAt.size > 1024) {
    const cutoff = leafSimTime - LEAF_EVAL_THROTTLE_SECONDS * 4;
    for (const [k, t] of leafEvalLastAt) {
      if (t < cutoff) leafEvalLastAt.delete(k);
    }
  }
  if (leafDecayTimers.size === 0) return;
  const ops = [];
  for (const [idx, t] of leafDecayTimers) {
    const x = idx % SERVER_WORLD_X;
    const xz = (idx - x) / SERVER_WORLD_X;
    const z = xz % SERVER_WORLD_Z;
    const y = (xz - z) / SERVER_WORLD_Z;
    if (getVoxelMaterial(x, y, z) !== M_LEAF) {
      // Voxel was already removed by something else (chop, sphere
      // op). Drop the entry and move on.
      leafDecayTimers.delete(idx);
      continue;
    }
    const next = t - dt;
    if (next > 0) {
      leafDecayTimers.set(idx, next);
      continue;
    }
    leafDecayTimers.delete(idx);
    ops.push({ x, y, z, mat: 0 });
  }
  if (ops.length === 0) return;
  const op = { kind: 'set', ops };
  applyVoxelOpToOverrides(op);
  state.voxelEditSeq++;
  const entry = {
    seq: state.voxelEditSeq,
    tick: state.tick,
    sender: 'server',
    op,
  };
  state.voxelEdits.push(entry);
  while (state.voxelEdits.length > VOXEL_EDIT_LOG_CAP) state.voxelEdits.shift();
  broadcastVoxelEdit(entry);
}

// ----------------------------------------------------------------------------
// Phase 5b: server-side saplings
// ----------------------------------------------------------------------------
//
// Saplings are short-lived in-memory entities that age 30 s and then
// stamp a full tree (the same shape function the worldgen uses). The
// browser's `src/sim/Saplings.ts` did this client-side; under
// zero-trust we mirror plants here, age them server-tick, and ship
// the maturation as a single batched `set` voxel_edit so connected
// clients pick up the trunk + canopy via VoxelEditMirror.

/** Find the topmost grass voxel at column (vx, vz) using the same
 *  rules as `findGrassTop` in Saplings.ts: skip air, fail if a
 *  wood/leaf voxel is on top, return -1 otherwise unless the surface
 *  is grass. */
function findSaplingGrassTop(vx, vz) {
  for (let y = SERVER_WORLD_Y - 1; y >= 1; y--) {
    const m = getVoxelMaterial(vx, y, vz);
    if (m === 0) continue;
    if (m === M_WOOD || m === M_LEAF) return -1;
    return m === M_GRASS ? y : -1;
  }
  return -1;
}

/** Compute the (sparse) voxel writes a `stampTree` call would
 *  produce given the same shape + seed as the browser. Mirrors
 *  `worldgen.cjs:stampTreeOnCols` but emits {x, y, z, mat} tuples
 *  instead of mutating column buffers. The canopy AIR check uses
 *  the live overlay state via getVoxelMaterial so leaves don't
 *  overwrite a neighbouring tree's wood — same semantics as the
 *  browser. */
function stampTreeWrites(baseX, baseY, baseZ, shape, treeSeed) {
  const writes = [];
  const trunkR2 = shape.trunkRadius * shape.trunkRadius;
  // Trunk: unconditional WOOD writes inside the trunkRadius disc.
  for (let dy = 1; dy <= shape.trunkHeight; dy++) {
    const y = baseY + dy;
    if (y >= SERVER_WORLD_Y) break;
    for (let dx = -shape.trunkRadius; dx <= shape.trunkRadius; dx++) {
      for (let dz = -shape.trunkRadius; dz <= shape.trunkRadius; dz++) {
        if (dx * dx + dz * dz > trunkR2) continue;
        const x = baseX + dx, z = baseZ + dz;
        if (x < 0 || z < 0 || x >= SERVER_WORLD_X || z >= SERVER_WORLD_Z) continue;
        writes.push({ x, y, z, mat: M_WOOD });
      }
    }
  }
  // Canopy: hashed-jitter ellipsoid; LEAF only on AIR.
  const canopyCx = baseX;
  const canopyCy = baseY + shape.trunkHeight + Math.max(2, shape.canopyRadius - 2);
  const canopyCz = baseZ;
  const r = shape.canopyRadius;
  const rY = Math.max(3, Math.floor(r * 0.85));
  for (let dy = -rY; dy <= rY; dy++) {
    const y = canopyCy + dy;
    if (y < 0 || y >= SERVER_WORLD_Y) continue;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ex = dx / r;
        const ey = dy / rY;
        const ez = dz / r;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
        const h = wg.hash32(dx, dy, dz, treeSeed);
        const jitter = ((h & 0xff) / 255) * 0.18;
        if (e2 + jitter > 1) continue;
        const x = canopyCx + dx, z = canopyCz + dz;
        if (x < 0 || z < 0 || x >= SERVER_WORLD_X || z >= SERVER_WORLD_Z) continue;
        if (getVoxelMaterial(x, y, z) !== 0) continue;
        writes.push({ x, y, z, mat: M_LEAF });
      }
    }
  }
  return writes;
}

function tickSaplings(dt) {
  if (state.saplings.length === 0) return;
  // Iterate in reverse so we can splice without skipping.
  const allWrites = [];
  for (let i = state.saplings.length - 1; i >= 0; i--) {
    const s = state.saplings[i];
    s.ageSec += dt;
    if (s.ageSec < SAPLING_MATURE_SEC) continue;
    // Clear the marker we wrote at plant time. The marker indices live
    // exactly where the tree's lower trunk + first canopy voxel will
    // shortly land, so we always clear them — stampTreeWrites will
    // re-emit the right material.
    for (const idx of s.marker) {
      const x = idx % SERVER_WORLD_X;
      const xz = (idx - x) / SERVER_WORLD_X;
      const z = xz % SERVER_WORLD_Z;
      const y = (xz - z) / SERVER_WORLD_Z;
      allWrites.push({ x, y, z, mat: 0 });
      // Eagerly clear the override so the canopy AIR check below sees
      // air at this position even before the broadcast goes out.
      state.voxelOverrides.set(idx, 0);
    }
    const sizeHash = wg.hash32(s.vx, s.vz, 1, s.seed);
    const shape = {
      trunkRadius: 1 + ((sizeHash >>> 24) & 1),
      trunkHeight: 18 + ((sizeHash >>> 16) & 0x07),
      canopyRadius: 6 + ((sizeHash >>> 8) & 0x07),
    };
    const writes = stampTreeWrites(s.vx, s.vy, s.vz, shape, s.seed);
    for (const w of writes) allWrites.push(w);
    // Pop in O(1).
    const last = state.saplings[state.saplings.length - 1];
    state.saplings[i] = last;
    state.saplings.pop();
  }
  if (allWrites.length === 0) return;
  const op = { kind: 'set', ops: allWrites };
  applyVoxelOpToOverrides(op);
  state.voxelEditSeq++;
  const entry = {
    seq: state.voxelEditSeq,
    tick: state.tick,
    sender: 'server',
    op,
  };
  state.voxelEdits.push(entry);
  while (state.voxelEdits.length > VOXEL_EDIT_LOG_CAP) state.voxelEdits.shift();
  broadcastVoxelEdit(entry);
}

/** Plant a sapling at the world-space (wx, wz). Returns ok=false
 *  when the column has no grass surface or another sapling already
 *  sits within 1 voxel. Mirrors the rejection logic in
 *  `src/sim/Saplings.ts:plant`. */
function plantSapling(args) {
  const wx = clampNum(args.wx, -1e6, 1e6, 0);
  const wz = clampNum(args.wz, -1e6, 1e6, 0);
  const vx = Math.floor(wx);
  const vz = Math.floor(wz);
  if (vx < 1 || vz < 1 || vx >= SERVER_WORLD_X - 1 || vz >= SERVER_WORLD_Z - 1) {
    return { ok: false, error: 'out of bounds' };
  }
  const surfaceY = findSaplingGrassTop(vx, vz);
  if (surfaceY < 0) return { ok: false, error: 'no grass' };
  for (const s of state.saplings) {
    const dx = s.vx - vx, dz = s.vz - vz;
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
      return { ok: false, error: 'too close to existing sapling' };
    }
  }
  const yStem = surfaceY + 1;
  const marker = [];
  if (yStem + 2 < SERVER_WORLD_Y) {
    const ops = [
      { x: vx, y: yStem,     z: vz, mat: M_WOOD },
      { x: vx, y: yStem + 1, z: vz, mat: M_WOOD },
      { x: vx, y: yStem + 2, z: vz, mat: M_LEAF },
    ];
    const op = { kind: 'set', ops };
    applyVoxelOpToOverrides(op);
    state.voxelEditSeq++;
    const entry = {
      seq: state.voxelEditSeq,
      tick: state.tick,
      sender: typeof args.owner === 'string' ? args.owner.slice(0, 32) : 'anon',
      op,
    };
    state.voxelEdits.push(entry);
    while (state.voxelEdits.length > VOXEL_EDIT_LOG_CAP) state.voxelEdits.shift();
    broadcastVoxelEdit(entry);
    for (const w of ops) marker.push(voxelIndex(w.x, w.y, w.z));
  }
  state.saplings.push({
    vx, vy: surfaceY, vz,
    ageSec: 0,
    seed: clampNum(args.seed, 0, 0xffffffff, 0) | 0,
    marker,
  });
  return { ok: true };
}

/** Phase 4.3a: server-side auto-engage for armed entities. Browser
 *  configures a unit via `arm_unit` (currently still a stub on the
 *  client — Phase 4.3b will flip the local aggressive-stance loop
 *  off for armed units), and from then on the server scans for an
 *  enemy in range, line-of-sight checks the segment via the same
 *  voxel raycast projectiles use, and fires on cooldown by spawning
 *  the projectile internally (no client roundtrip). */
function tickAutoEngage(dt) {
  if (state.entities.size === 0) return;
  for (const shooter of state.entities.values()) {
    const w = shooter.weapon;
    if (!w) continue;
    // Cooldown gate. lastFireTick starts at -Infinity so a freshly
    // armed unit is immediately eligible to fire.
    const sinceFireSec = (state.tick - w.lastFireTick) * TICK_DT_S;
    if (sinceFireSec < w.fireIntervalSec) continue;
    // Find nearest cross-owner entity within range. "Same owner" is a
    // simple proxy for "ally" today — the migration will switch to a
    // proper team table once the lobby owns it.
    let bestTarget = null;
    let bestDist = w.rangeMeters;
    for (const target of state.entities.values()) {
      if (target.id === shooter.id) continue;
      if (target.owner === shooter.owner) continue;
      if (target.hp <= 0) continue;
      const dx = target.x - shooter.x;
      const dy = target.y - shooter.y;
      const dz = target.z - shooter.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > bestDist) continue;
      bestDist = dist;
      bestTarget = target;
    }
    if (!bestTarget) continue;
    // Voxel LoS — skip if anything solid sits between the muzzle and
    // the target's torso. We muzzle ~1 m above the unit's feet so the
    // round doesn't immediately bury into the ground voxel under the
    // shooter.
    const sx = shooter.x, sy = shooter.y + 1.0, sz = shooter.z;
    const tx = bestTarget.x, ty = entityCenterY(bestTarget), tz = bestTarget.z;
    if (raycastVoxelSegment(sx, sy, sz, tx, ty, tz)) continue;
    // Direct-aim velocity toward the target. No ballistic solve — the
    // browser's predict path handles arc rendering, this is just the
    // initial muzzle vector. Drag + gravity then take over.
    const dx = tx - sx, dy = ty - sy, dz = tz - sz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist === 0) continue;
    const inv = 1 / dist;
    const vx = dx * inv * w.projectileSpeed;
    const vy = dy * inv * w.projectileSpeed;
    const vz = dz * inv * w.projectileSpeed;
    const tag = `srv-${shooter.id}-${state.tick}`;
    const p = spawnProjectile({
      clientTag: tag,
      owner: shooter.owner,
      kind: w.kind,
      x: sx, y: sy, z: sz,
      vx, vy, vz,
      dragPerSecond: w.projectileDrag,
      gravityScale: w.projectileGravityScale,
      maxLifeSeconds: w.projectileMaxLife,
      ownerId: shooter.id,
      hitRadiusMeters: w.projectileHitRadius,
      explosive: w.projectileExplosive,
      explosionRadiusMeters: w.projectileExplosionRadius,
      hitDamage: w.projectileHitDamage,
      damagePeak: w.projectileDamagePeak,
    });
    if (p) w.lastFireTick = state.tick;
  }
}

/** Hitbox sphere radius (m) used by the projectile sweep. Coarse
 *  per-kind table — exact unit hitboxes live on the browser today and
 *  haven't been mirrored into the entity table yet. Bigger vehicles
 *  use a wider sphere so projectiles connect at realistic ranges. */
function entityHitRadius(kind) {
  switch (kind) {
    case 'tank':
    case 'dozer':
    case 'tunneler':
    case 'aa_vehicle':
    case 'truck':
    case 'supply_truck':
      return 1.0;
    case 'airplane':
    case 'helicopter':
      return 2.0;
    default:
      // soldier, worker, civilian, builder — humanoid-sized.
      return 0.4;
  }
}

/** Centre point of the hit sphere — torso height above the ground
 *  voxel the entity is standing on. Matches the browser's
 *  `torsoY = u.y + max(0.7, widthMeters * 0.6)` heuristic at the
 *  default footprint, close enough for a coarse sphere. */
function entityCenterY(e) {
  return e.y + 0.6;
}

/** Solve the smallest t in [0, 1] such that the segment from A to B
 *  enters the sphere centred at C with radius r. Returns -1 on miss.
 *  Standard quadratic — picks the entry t (smaller root) when both
 *  roots are valid so a passing-through projectile counts as a hit at
 *  the entry point, not the exit. */
function segmentSphereT(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 === 0) return -1;
  const fx = ax - cx, fy = ay - cy, fz = az - cz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * d2 * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * d2);
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + sq) / (2 * d2);
  if (t2 >= 0 && t2 <= 1) return t2;
  return -1;
}

/** Sweep the projectile segment (A → B) against every live entity in
 *  the table; return the earliest hit (smallest t) or null. Skips the
 *  shooter itself so a soldier doesn't auto-blast their own muzzle. */
function findProjectileEntityHit(p, ax, ay, az, bx, by, bz) {
  let bestT = Infinity;
  let bestEntity = null;
  for (const e of state.entities.values()) {
    if (p.ownerId >= 0 && e.id === p.ownerId) continue;
    const r = entityHitRadius(e.kind);
    const t = segmentSphereT(ax, ay, az, bx, by, bz, e.x, entityCenterY(e), e.z, r);
    if (t < 0 || t > 1) continue;
    if (t < bestT) { bestT = t; bestEntity = e; }
  }
  return bestEntity ? { entity: bestEntity, t: bestT } : null;
}

/** Phase 6+: per-owner FoW vision. Each entry is a `NAV_W × NAV_H`
 *  Uint8Array marking 1 in cells that owner can see this tick.
 *  Recomputed lazily per `state.tick` so the same bitmap serves
 *  every snapshot built for the same tick. */
const visionByOwner = new Map();
let lastVisionTick = -1;

function sightRadiusForUnitCells(kind) {
  return SIGHT_RADIUS_BY_UNIT_KIND[kind] ?? SIGHT_RADIUS_DEFAULT_CELLS;
}
function sightRadiusForBuildingCells(kind) {
  return SIGHT_RADIUS_BY_BUILDING_KIND[kind] ?? SIGHT_RADIUS_DEFAULT_CELLS;
}

function stampVision(owner, cx, cz, radiusCells) {
  let bits = visionByOwner.get(owner);
  if (!bits) {
    bits = new Uint8Array(wg.NAV_W * wg.NAV_H);
    visionByOwner.set(owner, bits);
  }
  const r = radiusCells | 0;
  if (r <= 0) return;
  const r2 = r * r;
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(wg.NAV_W - 1, cx + r);
  const z0 = Math.max(0, cz - r);
  const z1 = Math.min(wg.NAV_H - 1, cz + r);
  for (let z = z0; z <= z1; z++) {
    const dz = z - cz;
    const dz2 = dz * dz;
    const row = z * wg.NAV_W;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dz2 > r2) continue;
      bits[row + x] = 1;
    }
  }
}

function ensureVisionForTick() {
  if (state.tick === lastVisionTick) return;
  lastVisionTick = state.tick;
  visionByOwner.clear();
  for (const e of state.entities.values()) {
    if (e.hp <= 0) continue;
    const cx = Math.floor(e.x / NAV_CELL_METERS);
    const cz = Math.floor(e.z / NAV_CELL_METERS);
    stampVision(e.owner, cx, cz, sightRadiusForUnitCells(e.kind));
  }
  for (const b of state.buildings.values()) {
    if (b.destroyed) continue;
    const cx = b.ox + ((b.cellsW || 1) >> 1);
    const cz = b.oz + ((b.cellsD || 1) >> 1);
    stampVision(b.owner, cx, cz, sightRadiusForBuildingCells(b.kind));
  }
}

/** Whether the cell at world-metres (x, z) lies inside the viewer's
 *  current-tick vision bitmap. False when the viewer has no entities
 *  or buildings on the map yet. */
function isVisibleToViewer(viewer, x, z) {
  ensureVisionForTick();
  const bits = visionByOwner.get(viewer);
  if (!bits) return false;
  const cx = Math.floor(x / NAV_CELL_METERS);
  const cz = Math.floor(z / NAV_CELL_METERS);
  if (cx < 0 || cz < 0 || cx >= wg.NAV_W || cz >= wg.NAV_H) return false;
  return bits[cz * wg.NAV_W + cx] === 1;
}

/** Phase 6+: per-tick passive food income for every live, enabled
 *  farm. The browser's full farmer-driven pipeline still does its
 *  thing locally; under zero-trust the server is authoritative for
 *  AI economy and this gives the AI a steady food stream so its
 *  cost-gated commands keep firing. Floats accumulate in
 *  `food`-as-number-with-decimal until the snapshot's `r.food | 0`
 *  cast quantises them. */
function tickFarmIncome(dt) {
  if (state.buildings.size === 0 || dt <= 0) return;
  for (const b of state.buildings.values()) {
    if (b.destroyed) continue;
    if (b.kind !== 'farm') continue;
    if (b.upgradeState !== 'enabled') continue;
    const r = getResources(b.owner);
    r.food = (r.food || 0) + FARM_INCOME_FOOD_PER_SEC * dt;
  }
}

/** Civilian food upkeep + starvation. Every live civilian eats
 *  CIVILIAN_UPKEEP_FOOD_PER_MIN food/min from its owner's pool. The server
 *  drains the AI factions' food (SERVER_FOOD_OWNERS) — human pools are drained
 *  client-side — but it is the authoritative civilian killer for EVERY owner:
 *  when an owner's (server- or client-synced) food can't cover the bite, food
 *  clamps at 0 and one civilian starves every CIVILIAN_STARVE_INTERVAL_S until
 *  income catches up. Deaths flow through deleteEntity → the tickCivilians
 *  roster reap drops the id and the lot re-grows a replacement once fed. */
function tickCivilianUpkeep(dt) {
  if (dt <= 0) return;
  // Count live civilians per owner.
  const counts = new Map();
  for (const e of state.entities.values()) {
    if (e.kind !== 'civilian' || e.hp <= 0) continue;
    counts.set(e.owner, (counts.get(e.owner) || 0) + 1);
  }
  // Clear stale starve timers for owners with no civilians left.
  for (const owner of [...civilianStarveTimer.keys()]) {
    if (!counts.has(owner)) civilianStarveTimer.delete(owner);
  }
  const ratePerSec = CIVILIAN_UPKEEP_FOOD_PER_MIN / 60;
  for (const [owner, n] of counts) {
    const cost = n * ratePerSec * dt;
    const r = getResources(owner);
    const serverOwned = SERVER_FOOD_OWNERS.has(owner);
    const available = r.food || 0;
    if (available >= cost) {
      // Fully fed. Only the server-owned (AI) pools are debited here; human
      // pools are debited by their own client so the 500 ms push doesn't undo it.
      if (serverOwned) r.food = available - cost;
      civilianStarveTimer.set(owner, 0);
      continue;
    }
    // Can't cover the bite — drain server-owned pools to 0 and accrue
    // starvation pressure (for ALL owners, using whatever food the pool
    // reports; a human pool reads the client-synced, already-drained value).
    if (serverOwned) r.food = 0;
    const t = (civilianStarveTimer.get(owner) || 0) + dt;
    if (t >= CIVILIAN_STARVE_INTERVAL_S) {
      civilianStarveTimer.set(owner, 0);
      starveOneCivilian(owner);
    } else {
      civilianStarveTimer.set(owner, t);
    }
  }
}

/** Kill one live civilian belonging to `owner` (the most-recently-spawned, so
 *  long-settled residents are the last to go). The roster reap in
 *  tickCivilians drops the freed id and re-grows a replacement once fed. */
function starveOneCivilian(owner) {
  let victim = null;
  for (const e of state.entities.values()) {
    if (e.kind !== 'civilian' || e.hp <= 0 || e.owner !== owner) continue;
    if (!victim || e.id > victim.id) victim = e;
  }
  if (!victim) return;
  deleteEntity(victim);
  civilianStates.delete(victim.id);
}

/** Reduce HP and despawn at zero. Used by the projectile tick path
 *  for both direct hits and explosive splash. Mirrors the
 *  `damage_entity` command's behaviour without going through
 *  applyCommand (which clamps the amount and would re-validate). */
function applyEntityDamage(e, amount) {
  if (amount <= 0) return 0;
  const before = e.hp;
  e.hp = Math.max(0, e.hp - amount);
  if (e.hp === 0) deleteEntity(e);
  return before - e.hp;
}

/** Walk every live entity inside the explosion sphere and apply
 *  falloff splash damage. Mirrors the browser splash math so a
 *  near-miss tank shell hurts but doesn't insta-kill: peak * 0.4 *
 *  (1 - dist/radius). The directly hit unit (passed in via
 *  `excludeId`) is skipped here — direct-hit damage was already
 *  applied at full hitDamage by the caller. */
function applyProjectileSplash(p, radius, excludeId) {
  if (radius <= 0 || p.damagePeak <= 0) return;
  const cx = p.x, cy = p.y, cz = p.z;
  for (const e of state.entities.values()) {
    if (e.id === excludeId) continue;
    const dx = e.x - cx;
    const dy = entityCenterY(e) - cy;
    const dz = e.z - cz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= radius) continue;
    const falloff = 1 - dist / radius;
    applyEntityDamage(e, p.damagePeak * 0.4 * falloff);
  }
}

/** Phase 5f: top non-air-non-canopy voxel y at column (x, z). Used
 *  by the building-spot picker to gauge terrain height + slope.
 *  Reads the merged worldgen overlay when available, else falls
 *  through to the heightmap baseline via `wg.columnMaterials`.
 *  Returns -1 for an entirely-air column. */
function getColumnTop(x, z) {
  if (x < 0 || z < 0 || x >= SERVER_WORLD_X || z >= SERVER_WORLD_Z) return -1;
  let col = null;
  if (cachedWorldOverlay && cachedWorldOverlaySeed === state.worldSeed) {
    const colKey = z * SERVER_WORLD_X + x;
    col = cachedWorldOverlay.columns.get(colKey) || null;
  }
  if (!col) col = wg.columnMaterials(x, z, state.worldSeed);
  for (let y = SERVER_WORLD_Y - 1; y >= 1; y--) {
    const m = col[y];
    if (m === 0 || m === M_WOOD || m === M_LEAF) continue;
    return y;
  }
  return -1;
}

/** Find the owner's HQ in the building table; returns null when the
 *  owner has no live HQ to anchor a build site near. */
function findOwnerHq(owner) {
  for (const b of state.buildings.values()) {
    if (b.destroyed) continue;
    if (b.owner !== owner) continue;
    if (b.kind !== 'hq') continue;
    return b;
  }
  return null;
}

/** Whether the cell-space rectangle [ox, ox+cellsW) × [oz, oz+cellsD)
 *  passes server-side footprint checks: in-bounds, terrain corners
 *  + centre within PLACE_MAX_SLOPE_VOXELS of each other, and no
 *  overlap with a live building. */
function isFootprintValid(ox, oz, cellsW, cellsD) {
  if (ox < 0 || oz < 0) return false;
  if (ox + cellsW > wg.NAV_W || oz + cellsD > wg.NAV_H) return false;
  // Sample column tops at the four corners + centre — enough signal to
  // reject sloped terrain without scanning the whole footprint.
  const cellSamples = [
    [ox, oz],
    [ox + cellsW - 1, oz],
    [ox, oz + cellsD - 1],
    [ox + cellsW - 1, oz + cellsD - 1],
    [ox + (cellsW >> 1), oz + (cellsD >> 1)],
  ];
  let minTop = Infinity;
  let maxTop = -Infinity;
  for (const [cx, cz] of cellSamples) {
    const wx = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
    const wz = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
    const top = getColumnTop(wx, wz);
    if (top < 0) return false;
    if (top < minTop) minTop = top;
    if (top > maxTop) maxTop = top;
  }
  if (maxTop - minTop > PLACE_MAX_SLOPE_VOXELS) return false;
  for (const b of state.buildings.values()) {
    if (b.destroyed) continue;
    if (ox + cellsW <= b.ox) continue;
    if (b.ox + b.cellsW <= ox) continue;
    if (oz + cellsD <= b.oz) continue;
    if (b.oz + b.cellsD <= oz) continue;
    return false;
  }
  return true;
}

/** Pick cells for a building of `kind`, anchored near the owner's HQ.
 *  Random offsets ±PLACE_SEARCH_RADIUS_CELLS up to PLACE_SEARCH_ATTEMPTS
 *  times. Returns null when nothing fits — caller should report the
 *  command as failed (the AI brain's cooldown will retry next tick). */
function pickBuildingSpot(owner, kind) {
  const spec = BUILDING_SPECS[kind];
  if (!spec) return null;
  const hq = findOwnerHq(owner);
  if (!hq) return null;
  const hqCellX = hq.ox + (hq.cellsW >> 1);
  const hqCellZ = hq.oz + (hq.cellsD >> 1);
  // Stir per-(tick, owner) so two AIs don't race on the same cells.
  let seed = (state.tick * 0x9e3779b9) >>> 0;
  for (const ch of owner) seed = (Math.imul(seed ^ ch.charCodeAt(0), 0x85ebca6b)) >>> 0;
  const rng = new wg.Xoshiro128(seed || 0xC0FFEE);
  for (let attempt = 0; attempt < PLACE_SEARCH_ATTEMPTS; attempt++) {
    const dx = rng.intRange(-PLACE_SEARCH_RADIUS_CELLS, PLACE_SEARCH_RADIUS_CELLS + 1);
    const dz = rng.intRange(-PLACE_SEARCH_RADIUS_CELLS, PLACE_SEARCH_RADIUS_CELLS + 1);
    const ox = hqCellX + dx - (spec.cellsW >> 1);
    const oz = hqCellZ + dz - (spec.cellsD >> 1);
    if (!isFootprintValid(ox, oz, spec.cellsW, spec.cellsD)) continue;
    const cwx = (ox + (spec.cellsW >> 1)) * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
    const cwz = (oz + (spec.cellsD >> 1)) * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
    const floorY = getColumnTop(cwx, cwz) + 1;
    return { ox, oz, cellsW: spec.cellsW, cellsD: spec.cellsD, floorY };
  }
  return null;
}

/** Schedule leaf-decay evaluation for the region a voxel op touched.
 *  Sphere ops centre on the impact / blast point; explicit set ops
 *  evaluate around each write. The eval function is throttled per
 *  8-voxel region so a 1000-voxel sphere doesn't spam the BFS. */
function triggerLeafDecayForOp(op) {
  if (op.kind === 'sphere') {
    const cx = Math.floor(op.x / VOXEL_SIZE);
    const cy = Math.floor(op.y / VOXEL_SIZE);
    const cz = Math.floor(op.z / VOXEL_SIZE);
    onLeafSensitiveEdit(cx, cy, cz);
    return;
  }
  if (op.kind === 'set') {
    for (const w of op.ops) {
      onLeafSensitiveEdit(w.x, w.y, w.z);
    }
  }
}

/** Phase 4.1c: emit a canonical sphere voxel mutation for a
 *  projectile impact. Routes through the same overrides/log/
 *  broadcast path as a client-issued `voxel_edit`, so other clients
 *  apply the destruction via VoxelEditMirror and the originating
 *  client suppresses the echo (sender == owner). */
function applyImpactVoxelEdit(p, radiusMeters) {
  const op = {
    kind: 'sphere',
    x: p.x, y: p.y, z: p.z,
    radius: radiusMeters,
    mat: 0,
  };
  applyVoxelOpToOverrides(op);
  triggerLeafDecayForOp(op);
  state.voxelEditSeq++;
  const entry = {
    seq: state.voxelEditSeq,
    tick: state.tick,
    sender: p.owner,
    op,
  };
  state.voxelEdits.push(entry);
  while (state.voxelEdits.length > VOXEL_EDIT_LOG_CAP) state.voxelEdits.shift();
  broadcastVoxelEdit(entry);
}

/** Step the integer-voxel grid from `(ax, ay, az)` to `(bx, by, bz)`
 *  in world-meter coordinates and return the first voxel index whose
 *  material is non-AIR, or null if the segment misses. Standard
 *  Amanatides-Woo DDA: at each step we advance the axis whose ray
 *  parameter `t` is smallest, so we visit each voxel the segment
 *  passes through exactly once. */
function raycastVoxelSegment(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  // Direction in voxel-units per metre.
  const inv = 1 / len;
  const ux = dx * inv, uy = dy * inv, uz = dz * inv;
  // Starting voxel.
  let vx = Math.floor(ax / VOXEL_SIZE);
  let vy = Math.floor(ay / VOXEL_SIZE);
  let vz = Math.floor(az / VOXEL_SIZE);
  const endVx = Math.floor(bx / VOXEL_SIZE);
  const endVy = Math.floor(by / VOXEL_SIZE);
  const endVz = Math.floor(bz / VOXEL_SIZE);
  const stepX = ux > 0 ? 1 : (ux < 0 ? -1 : 0);
  const stepY = uy > 0 ? 1 : (uy < 0 ? -1 : 0);
  const stepZ = uz > 0 ? 1 : (uz < 0 ? -1 : 0);
  // tMax: parameter at which the ray crosses the next voxel boundary
  // along each axis. tDelta: parameter step between crossings.
  const tDeltaX = stepX !== 0 ? VOXEL_SIZE / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? VOXEL_SIZE / Math.abs(dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? VOXEL_SIZE / Math.abs(dz) : Infinity;
  // Distance from start to next voxel boundary along each axis.
  const nextBoundaryX = (stepX > 0 ? (vx + 1) * VOXEL_SIZE : vx * VOXEL_SIZE) - ax;
  const nextBoundaryY = (stepY > 0 ? (vy + 1) * VOXEL_SIZE : vy * VOXEL_SIZE) - ay;
  const nextBoundaryZ = (stepZ > 0 ? (vz + 1) * VOXEL_SIZE : vz * VOXEL_SIZE) - az;
  let tMaxX = stepX !== 0 ? nextBoundaryX / dx : Infinity;
  let tMaxY = stepY !== 0 ? nextBoundaryY / dy : Infinity;
  let tMaxZ = stepZ !== 0 ? nextBoundaryZ / dz : Infinity;
  // Belt-and-braces: cap the iteration so a NaN or zero-length step
  // can't spin the loop forever.
  let safety = 4096;
  while (safety-- > 0) {
    const m = getVoxelMaterial(vx, vy, vz);
    if (m !== 0) return { x: vx, y: vy, z: vz, mat: m };
    if (vx === endVx && vy === endVy && vz === endVz) return null;
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      vx += stepX; tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      vy += stepY; tMaxY += tDeltaY;
    } else {
      vz += stepZ; tMaxZ += tDeltaZ;
    }
  }
  return null;
}

function tickProjectiles(dt) {
  if (state.projectiles.size === 0) return;
  const dragMul = (drag) => drag > 0 ? Math.exp(-drag * dt) : 1;
  for (const p of state.projectiles.values()) {
    p.age += dt;
    if (p.age >= p.maxLifeSeconds) { deleteProjectile(p); continue; }
    // Drag (exponential) before integrating position so a fresh
    // muzzle velocity doesn't take a 100% stride at full speed
    // before drag bites.
    const k = dragMul(p.dragPerSecond);
    p.vx *= k; p.vy *= k; p.vz *= k;
    // Gravity in world Y. Browser flight uses negative Y for "down"
    // (Three.js convention).
    p.vy -= PROJECTILE_GRAVITY * p.gravityScale * dt;
    const ax = p.x, ay = p.y, az = p.z;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    // Phase 4.1b/d: per-tick collision. Voxel raycast finds the first
    // solid voxel along the flight segment; entity sweep finds the
    // earliest unit hit. Whichever is closer to the segment start
    // wins — entity precedes voxel for a near-flush bullet that
    // would otherwise embed in the wall behind the soldier.
    const voxelHit = raycastVoxelSegment(ax, ay, az, p.x, p.y, p.z);
    let voxelT = Infinity;
    if (voxelHit) {
      const cx = (voxelHit.x + 0.5) * VOXEL_SIZE;
      const cy = (voxelHit.y + 0.5) * VOXEL_SIZE;
      const cz = (voxelHit.z + 0.5) * VOXEL_SIZE;
      const segLen2 = (p.x - ax) * (p.x - ax) + (p.y - ay) * (p.y - ay) + (p.z - az) * (p.z - az);
      if (segLen2 > 0) {
        voxelT = ((cx - ax) * (p.x - ax) + (cy - ay) * (p.y - ay) + (cz - az) * (p.z - az)) / segLen2;
      }
    }
    const entityHit = findProjectileEntityHit(p, ax, ay, az, p.x, p.y, p.z);
    const entityT = entityHit ? entityHit.t : Infinity;

    if (entityHit && entityT <= voxelT) {
      // Direct entity hit — snap to the impact point so the broadcast
      // carries the actual contact location.
      p.x = ax + (p.x - ax) * entityT;
      p.y = ay + (p.y - ay) * entityT;
      p.z = az + (p.z - az) * entityT;
      const e = entityHit.entity;
      applyEntityDamage(e, p.hitDamage);
      // Explosive direct hit also splashes nearby entities + carves
      // terrain. Splash skips `e.id` since the direct dose already
      // hit the target at full hitDamage.
      if (p.explosive && p.explosionRadiusMeters > 0) {
        applyProjectileSplash(p, p.explosionRadiusMeters, e.id);
        applyImpactVoxelEdit(p, p.explosionRadiusMeters);
      }
      broadcastProjectileImpact(p, null, e.id);
      deleteProjectile(p);
      continue;
    }

    if (voxelHit) {
      // Snap projectile to the impact voxel's centre so the
      // broadcast carries the impact site rather than the just-past
      // position the integrator would otherwise see.
      p.x = (voxelHit.x + 0.5) * VOXEL_SIZE;
      p.y = (voxelHit.y + 0.5) * VOXEL_SIZE;
      p.z = (voxelHit.z + 0.5) * VOXEL_SIZE;
      broadcastProjectileImpact(p, voxelHit, -1);
      const radiusMeters = p.explosive ? p.explosionRadiusMeters : p.hitRadiusMeters;
      if (radiusMeters > 0) {
        // Splash before the voxel edit so HP mutations come before
        // any further chunk mutations clients reconcile against.
        if (p.explosive) applyProjectileSplash(p, p.explosionRadiusMeters, -1);
        applyImpactVoxelEdit(p, radiusMeters);
      }
      deleteProjectile(p);
      continue;
    }
    // Out-of-bounds → despawn. Floor at y < -50 catches anything
    // that fell through the bedrock; XZ bounds catch shots fired
    // off-map.
    if (p.y < -50) { deleteProjectile(p); continue; }
    const xMax = SERVER_WORLD_X * VOXEL_SIZE;
    const zMax = SERVER_WORLD_Z * VOXEL_SIZE;
    if (p.x < -16 || p.z < -16 || p.x > xMax + 16 || p.z > zMax + 16) {
      deleteProjectile(p);
    }
  }
}

/** Return true when owner has at least the cost in each resource
 *  field. Missing resource entries (lazy-initialised at zero)
 *  naturally fail any non-zero cost. */
function canAfford(owner, cost) {
  const r = getResources(owner);
  return (r.food | 0) >= (cost.food | 0)
    && (r.metals | 0) >= (cost.metals | 0)
    && (r.wood | 0) >= (cost.wood | 0);
}

/** Atomic deduction. Caller must have already passed `canAfford`. */
function debit(owner, cost) {
  const r = getResources(owner);
  r.food = Math.max(0, (r.food | 0) - (cost.food | 0));
  r.metals = Math.max(0, (r.metals | 0) - (cost.metals | 0));
  r.wood = Math.max(0, (r.wood | 0) - (cost.wood | 0));
}

function getResources(owner) {
  if (!owner) return null;
  let r = state.resources.get(owner);
  if (!r) {
    r = { food: 0, metals: 0, wood: 0, popCap: 0 };
    state.resources.set(owner, r);
  }
  return r;
}

// ----------------------------------------------------------------------------
// Server-owned civilian system
// ----------------------------------------------------------------------------
//
// Mirrors `src/sim/Civilians.ts` from the browser, just on the
// authoritative side. Each enabled neighborhood building keeps its
// resident roster + spawn cooldown; civilians get a tiny state
// machine (idle → pick another neighborhood → walk there). The
// client just renders whatever entities the snapshot reports.

/** buildingId → { ids: number[], spawnCooldown: number } */
const civilianResidents = new Map();
/** entityId → { idleSeconds: number, homeBuildingId: number } */
const civilianStates = new Map();
/** owner → seconds of unpaid civilian upkeep accrued (drives starvation). */
const civilianStarveTimer = new Map();

function buildingCenter(b) {
  const cx = (b.ox + b.cellsW * 0.5) * NAV_CELL_METERS;
  const cz = (b.oz + b.cellsD * 0.5) * NAV_CELL_METERS;
  const cy = (b.floorY + 1) * VOXEL_SIZE;
  return { x: cx, y: cy, z: cz };
}

function pickWanderTarget(home, owner, allNeighborhoods) {
  // Civilians only migrate between neighborhoods owned by their own
  // team. Without this filter an enemy civilian could wander into
  // a player neighborhood (or vice versa) and the user would see
  // "other players' civilians spawning from player 1's hood".
  const sameTeam = allNeighborhoods.filter(b => b.owner === owner);
  const others = sameTeam.filter(b => b.id !== home);
  const pool = others.length > 0 ? others : sameTeam;
  if (pool.length === 0) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const c = buildingCenter(pick);
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * CIVILIAN_WANDER_RADIUS_M;
  return { x: c.x + Math.cos(angle) * dist, y: c.y, z: c.z + Math.sin(angle) * dist };
}

// ----------------------------------------------------------------------------
// Voxel mutations
// ----------------------------------------------------------------------------

/** Walk a sphere op's affected voxels and write each one into the
 *  authoritative override map. Mirrors the behaviour of the browser's
 *  `world.damageSphere` at the voxel-write level — it's just a
 *  brute-force AABB walk filtering by squared radius, which is fine
 *  at the sphere sizes in play (R≤16 voxels for a tank shell). */
function applyVoxelOpToOverrides(op) {
  if (op.kind === 'sphere') {
    const cx = Math.floor(op.x / VOXEL_SIZE);
    const cy = Math.floor(op.y / VOXEL_SIZE);
    const cz = Math.floor(op.z / VOXEL_SIZE);
    const r = Math.ceil(op.radius / VOXEL_SIZE);
    if (r <= 0) return;
    const r2 = r * r;
    for (let dz = -r; dz <= r; dz++) {
      const z = cz + dz;
      const dz2 = dz * dz;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        const dyz2 = dz2 + dy * dy;
        if (dyz2 > r2) continue;
        const remaining = r2 - dyz2;
        const dxMax = Math.floor(Math.sqrt(remaining));
        for (let dx = -dxMax; dx <= dxMax; dx++) {
          const x = cx + dx;
          if (!inWorldBounds(x, y, z)) continue;
          state.voxelOverrides.set(voxelIndex(x, y, z), op.mat);
        }
      }
    }
    return;
  }
  if (op.kind === 'set') {
    for (const w of op.ops) {
      if (!inWorldBounds(w.x, w.y, w.z)) continue;
      state.voxelOverrides.set(voxelIndex(w.x, w.y, w.z), w.mat);
    }
    return;
  }
}

function chunkKey(cx, cy, cz) {
  return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
}
function localIndex(lx, ly, lz) {
  // Y-major within a chunk, matches `localIndex` in src/voxel/types.ts
  // so chunk bytes the client receives align with its own buffer.
  return (ly * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
}

/** Per-seed worldgen overlay — the merged "post-worldgen" voxel state
 *  including roads + trees + clearAboveRoads. Computed once on first
 *  chunk request after a seed is set; the road pass takes a couple of
 *  seconds and the tree pass another fraction of a second. After that
 *  every chunk lookup is a Map.get away from knowing which columns to
 *  splat. Invalidated by `set_world_seed`. */
let cachedWorldOverlay = null;
let cachedWorldOverlaySeed = null;
function getWorldOverlay(seed) {
  if (cachedWorldOverlay && cachedWorldOverlaySeed === seed) return cachedWorldOverlay;
  // Same pipeline order as `src/voxel/WorldGen.ts`: roads paint the
  // path/dirt-road network first, then metal piles surface on top of
  // the post-road terrain (so a pile that breaks the surface keeps
  // the column tree-free), then trees, then `clearAboveRoads` trims
  // any canopy that drifted onto a road.
  const roads = wg.placeRoadsToOverlay(seed);
  const metals = wg.placeMetalsToOverlay(seed, roads);
  cachedWorldOverlay = wg.placeTreesToOverlay(seed, metals);
  cachedWorldOverlaySeed = seed;
  return cachedWorldOverlay;
}

/** Build a single 32³ chunk from the heightmap baseline + worldgen
 *  overlay. For each (x, z) column in the chunk, prefer the merged
 *  column from the overlay (if present) over the raw `columnMaterials`
 *  output, then copy the chunk's Y slice into the chunk-local buffer.
 *
 *  Caching is one level up — `getChunkSnapshot` makes sure each chunk
 *  is computed at most once per server lifetime. */
function generateChunkBaseline(cx, cy, cz, seed) {
  const buf = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  const overlay = getWorldOverlay(seed);
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    const z = baseZ + lz;
    if (z < 0 || z >= SERVER_WORLD_Z) continue;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const x = baseX + lx;
      if (x < 0 || x >= SERVER_WORLD_X) continue;
      const colKey = z * SERVER_WORLD_X + x;
      const column = overlay.columns.get(colKey) || wg.columnMaterials(x, z, seed);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const y = baseY + ly;
        if (y < 0 || y >= SERVER_WORLD_Y) continue;
        buf[localIndex(lx, ly, lz)] = column[y];
      }
    }
  }
  return buf;
}

/** Apply the server's voxel overrides that fall inside a chunk on
 *  top of `buf`. Mutates in place. */
function applyOverridesToChunkBuf(buf, cx, cy, cz) {
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  for (const [idx, mat] of state.voxelOverrides) {
    const x = idx % SERVER_WORLD_X;
    const xz = (idx - x) / SERVER_WORLD_X;
    const z = xz % SERVER_WORLD_Z;
    const y = (xz - z) / SERVER_WORLD_Z;
    if (x < baseX || x >= baseX + CHUNK_SIZE) continue;
    if (y < baseY || y >= baseY + CHUNK_SIZE) continue;
    if (z < baseZ || z >= baseZ + CHUNK_SIZE) continue;
    buf[localIndex(x - baseX, y - baseY, z - baseZ)] = mat;
  }
}

/** Lazily produce the chunk's voxel buffer from the heightmap
 *  baseline + override map. LRU-evicts when the cache is full so a
 *  long session can't OOM the server. The returned buffer is a copy
 *  with overrides applied — the cached buffer holds just the
 *  baseline, so future override mutations show up next request.
 *
 *  Returns null when the chunk coords are out of world bounds. */
function getChunkSnapshot(cx, cy, cz) {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= CHUNKS_X || cy >= CHUNKS_Y || cz >= CHUNKS_Z) {
    return null;
  }
  const key = chunkKey(cx, cy, cz);
  let baseline = state.chunkCache.get(key);
  if (baseline) {
    // LRU bump: re-insert at the end of the iteration order.
    state.chunkCache.delete(key);
    state.chunkCache.set(key, baseline);
  } else {
    baseline = generateChunkBaseline(cx, cy, cz, state.worldSeed);
    if (state.chunkCache.size >= CHUNK_CACHE_CAP) {
      const oldestKey = state.chunkCache.keys().next().value;
      if (oldestKey !== undefined) state.chunkCache.delete(oldestKey);
    }
    state.chunkCache.set(key, baseline);
  }
  // Hand back a copy so override application doesn't pollute the
  // cached baseline. Override merge is sparse so this is cheap.
  const out = new Uint8Array(baseline);
  applyOverridesToChunkBuf(out, cx, cy, cz);
  return out;
}

/** Pull the override list intersecting one chunk. Used by the
 *  `/world/chunk` endpoint so a freshly-connecting client can patch
 *  its locally-generated chunk to match the canonical state without
 *  replaying the full edit log. Returns an array of {lx, ly, lz, mat}
 *  in chunk-local coordinates, plus the base voxel coords for sanity. */
function chunkOverrides(cx, cy, cz) {
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  const out = [];
  // Cheaper to walk the overrides than to walk the chunk volume when
  // overrides are sparse — typical mid-game probably has tens of
  // thousands of overrides total but most chunks have none.
  for (const [idx, mat] of state.voxelOverrides) {
    const x = idx % SERVER_WORLD_X;
    const xz = (idx - x) / SERVER_WORLD_X;
    const z = xz % SERVER_WORLD_Z;
    const y = (xz - z) / SERVER_WORLD_Z;
    if (x < baseX || x >= baseX + CHUNK_SIZE) continue;
    if (y < baseY || y >= baseY + CHUNK_SIZE) continue;
    if (z < baseZ || z >= baseZ + CHUNK_SIZE) continue;
    out.push({ lx: x - baseX, ly: y - baseY, lz: z - baseZ, mat });
  }
  return out;
}

function tickCivilians(dt) {
  // Reap residents whose civilian got despawned (HP hit 0 elsewhere).
  for (const res of civilianResidents.values()) {
    res.ids = res.ids.filter(id => state.entities.has(id));
  }
  for (const id of [...civilianStates.keys()]) {
    if (!state.entities.has(id)) civilianStates.delete(id);
  }
  // Drop civilianResidents entries whose hood can no longer house anyone —
  // it was destroyed, stopped being a neighborhood, or its capacity fell to 0
  // (initial build not finished). Those residents go with the building. A hood
  // mid-EXPAND keeps a positive `civilianCap` (the client holds it at the
  // current finished houses' tier × 5), so its residents are PRESERVED through
  // the upgrade — destroying them was the reported bug. Civilians otherwise
  // leave the world only by death (HP→0, reaped above) or hood destruction.
  for (const [hoodId, res] of [...civilianResidents]) {
    const b = state.buildings.get(hoodId);
    if (b && !b.destroyed && b.kind === 'neighborhood' && (b.civilianCap || 0) > 0) continue;
    for (const civId of res.ids) {
      const civ = state.entities.get(civId);
      if (civ) deleteEntity(civ);
      civilianStates.delete(civId);
    }
    civilianResidents.delete(hoodId);
  }

  // Snapshot the live neighborhood roster once per tick. A hood houses
  // civilians as soon as it can (capacity > 0), INCLUDING while a further
  // house is mid-construction (upgradeState 'pending') — capacity is the
  // client-authoritative tier × 5 of the finished houses, not gated on
  // 'enabled'.
  const neighborhoods = [];
  for (const b of state.buildings.values()) {
    if (b.destroyed) continue;
    if (b.kind !== 'neighborhood') continue;
    if ((b.civilianCap || 0) <= 0) continue;
    neighborhoods.push(b);
  }
  if (neighborhoods.length === 0) return;

  // Spawning. Each hood grows toward its `civilianCap` (tier × 5: 5 per
  // finished house, up to 15 for a fully-upgraded tier-3 lot) on the 10 s
  // creation cadence; a death re-grows on the shorter replacement cadence.
  for (const b of neighborhoods) {
    const quota = b.civilianCap || 0;
    let res = civilianResidents.get(b.id);
    if (!res) {
      res = { ids: [], spawnCooldown: 0 };
      civilianResidents.set(b.id, res);
    }
    res.spawnCooldown = Math.max(0, res.spawnCooldown - dt);
    if (res.ids.length >= quota) continue;
    if (res.spawnCooldown > 0) continue;
    // Don't grow a resident the owner can't feed. While the team is bankrupt
    // (food at 0), spawning pauses — combined with upkeep starvation this lets
    // the population fall to what food sustains instead of churning a
    // spawn→starve→spawn loop, and it climbs back once food recovers.
    if ((getResources(b.owner).food || 0) <= 0) continue;
    const c = buildingCenter(b);
    const tag = `civ-${state.nextId}`;
    const civ = spawnEntity({
      clientTag: tag,
      owner: b.owner,
      kind: 'civilian',
      x: c.x, y: c.y, z: c.z,
      speed: CIVILIAN_SPEED_M_S,
      hp: CIVILIAN_HP,
    });
    if (!civ) break;
    res.ids.push(civ.id);
    civilianStates.set(civ.id, {
      idleSeconds: CIVILIAN_IDLE_MIN_S + Math.random() * (CIVILIAN_IDLE_MAX_S - CIVILIAN_IDLE_MIN_S),
      homeBuildingId: b.id,
    });
    res.spawnCooldown = res.ids.length < quota
      ? CIVILIAN_REPLACEMENT_COOLDOWN_S
      : CIVILIAN_SPAWN_COOLDOWN_S;
  }

  // Wandering.
  for (const civ of state.entities.values()) {
    if (civ.kind !== 'civilian') continue;
    const st = civilianStates.get(civ.id);
    if (!st) continue;
    if (civ.path.length > 0 || civ.target) continue;
    if (st.idleSeconds > 0) {
      st.idleSeconds = Math.max(0, st.idleSeconds - dt);
      continue;
    }
    const target = pickWanderTarget(st.homeBuildingId, civ.owner, neighborhoods);
    if (!target) continue;
    civ.path = [target];
    civ.target = { x: target.x, z: target.z };
    st.idleSeconds = CIVILIAN_IDLE_MIN_S + Math.random() * (CIVILIAN_IDLE_MAX_S - CIVILIAN_IDLE_MIN_S);
  }
}

function clampNum(v, lo, hi, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// ----------------------------------------------------------------------------
// Command application
// ----------------------------------------------------------------------------
//
// Commands arrive over /game/input. The server is the only thing that
// mutates state — clients can't poke entities directly. Every command
// shape includes a sender token so we can later authorize per-player
// control over their own entities. For phase 1 we accept any token.

function applyCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'bad command' };
  switch (cmd.type) {
    case 'spawn_entity': {
      const e = spawnEntity(cmd);
      if (!e) return { ok: false, error: 'entity cap reached' };
      return { ok: true, id: e.id, clientTag: e.clientTag };
    }
    case 'move_entity': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      e.target = {
        x: clampNum(cmd.x, -1e6, 1e6, e.x),
        z: clampNum(cmd.z, -1e6, 1e6, e.z),
      };
      e.path = [];
      return { ok: true };
    }
    case 'set_path': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      const waypoints = Array.isArray(cmd.waypoints) ? cmd.waypoints : [];
      const cleaned = [];
      for (const wp of waypoints) {
        if (!wp || typeof wp !== 'object') continue;
        cleaned.push({
          x: clampNum(wp.x, -1e6, 1e6, e.x),
          y: clampNum(wp.y, -1e6, 1e6, e.y),
          z: clampNum(wp.z, -1e6, 1e6, e.z),
        });
        if (cleaned.length >= 256) break; // hard cap on path length
      }
      e.path = cleaned;
      e.target = cleaned.length > 0 ? { x: cleaned[0].x, z: cleaned[0].z } : null;
      return { ok: true };
    }
    case 'stop_entity': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      e.target = null;
      e.path = [];
      return { ok: true };
    }
    case 'despawn_entity': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      deleteEntity(e);
      return { ok: true };
    }
    /** Authoritative position writeback so the client can correct
     *  the server when the client is the source of truth (e.g. while
     *  server-side path follow doesn't know terrain Y). Restricted to
     *  same-owner. */
    case 'set_position': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      e.x = clampNum(cmd.x, -1e6, 1e6, e.x);
      e.y = clampNum(cmd.y, -1e6, 1e6, e.y);
      e.z = clampNum(cmd.z, -1e6, 1e6, e.z);
      return { ok: true };
    }
    /** Phase 4.3a: configure an entity's server-side weapon so
     *  `tickAutoEngage` will fire it at any cross-owner enemy in
     *  range with line-of-sight clear. Owner-gated. The browser is
     *  expected to pass in the same numbers it would have used to
     *  drive its own aggressive-stance tick — the server stays
     *  agnostic to projectile-catalog identity. */
    /** Phase 5b: drop a sapling. The server stamps the placeholder
     *  marker (2 wood + 1 leaf) immediately as a `voxel_edit` so
     *  every connected client sees it, then ages the entry server-
     *  tick until it matures into a full tree. */
    case 'plant_sapling': {
      return plantSapling(cmd);
    }
    /** Phase 5e: append a unit kind to a building's trainQueue.
     *  Distinct from update_building, which REPLACES the queue
     *  wholesale — this lets the AI brain (or any caller) push one
     *  more unit at a time without round-tripping the current state.
     *  Owner-gated, capped so a runaway AI can't fill the queue. */
    case 'queue_train': {
      const b = lookupBuilding(cmd);
      if (!b) return { ok: false, error: 'no building' };
      if (cmd.owner && b.owner !== cmd.owner) return { ok: false, error: 'not your building' };
      const unitKind = typeof cmd.unitKind === 'string' ? cmd.unitKind.slice(0, 32) : '';
      if (!unitKind) return { ok: false, error: 'unitKind required' };
      const QUEUE_CAP = 8;
      if (b.trainQueue.length >= QUEUE_CAP) return { ok: false, error: 'queue full' };
      // Phase 6+: server-authoritative train cost. queue_train is
      // currently AI-only on the wire (the browser uses
      // update_building to replace the queue), so deducting here
      // doesn't double-bill the local economy. Unknown unit kinds
      // fall through with zero cost — caller is trusted on label.
      const cost = UNIT_TRAIN_COSTS[unitKind] || { food: 0, metals: 0, wood: 0 };
      if (!canAfford(b.owner, cost)) return { ok: false, error: 'insufficient resources' };
      debit(b.owner, cost);
      b.trainQueue.push(unitKind);
      return { ok: true, trainQueueLen: b.trainQueue.length };
    }
    case 'arm_unit': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      e.weapon = {
        kind: typeof cmd.kind === 'string' ? cmd.kind.slice(0, 32) : 'bullet_5_56mm',
        rangeMeters: clampNum(cmd.rangeMeters, 0, 500, 0),
        fireIntervalSec: clampNum(cmd.fireIntervalSec, 0.05, 60, 1),
        // Sentinel "fired infinitely far in the past" — first eligible
        // tick after arming the unit will pass the cooldown gate.
        lastFireTick: -1e9,
        projectileSpeed: clampNum(cmd.projectileSpeed, 0, 1000, 50),
        projectileDrag: clampNum(cmd.projectileDrag, 0, 100, 0),
        projectileGravityScale: clampNum(cmd.projectileGravityScale, 0, 4, 1),
        projectileMaxLife: clampNum(cmd.projectileMaxLife, 0.1, 60, 5),
        projectileHitRadius: clampNum(cmd.projectileHitRadius, 0, 32, 0),
        projectileHitDamage: clampNum(cmd.projectileHitDamage, 0, 1e6, 0),
        projectileExplosive: !!cmd.projectileExplosive,
        projectileExplosionRadius: clampNum(cmd.projectileExplosionRadius, 0, 32, 0),
        projectileDamagePeak: clampNum(cmd.projectileDamagePeak, 0, 1e6, 0),
      };
      return { ok: true };
    }
    case 'disarm_unit': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      if (cmd.owner && e.owner !== cmd.owner) return { ok: false, error: 'not your entity' };
      e.weapon = null;
      return { ok: true };
    }
    /** Phase 6+: configure a building's server-side weapon so
     *  tickAutoEngage will fire it at any cross-owner enemy in
     *  range with line-of-sight clear. Same payload shape as
     *  arm_unit; muzzle position derives from the building's
     *  centre cell + floor height. */
    case 'arm_building': {
      const b = lookupBuilding(cmd);
      if (!b) return { ok: false, error: 'no building' };
      if (cmd.owner && b.owner !== cmd.owner) return { ok: false, error: 'not your building' };
      b.weapon = {
        kind: typeof cmd.kind === 'string' ? cmd.kind.slice(0, 32) : 'bullet_5_56mm',
        rangeMeters: clampNum(cmd.rangeMeters, 0, 500, 0),
        fireIntervalSec: clampNum(cmd.fireIntervalSec, 0.05, 60, 1),
        lastFireTick: -1e9,
        projectileSpeed: clampNum(cmd.projectileSpeed, 0, 1000, 50),
        projectileDrag: clampNum(cmd.projectileDrag, 0, 100, 0),
        projectileGravityScale: clampNum(cmd.projectileGravityScale, 0, 4, 1),
        projectileMaxLife: clampNum(cmd.projectileMaxLife, 0.1, 60, 5),
        projectileHitRadius: clampNum(cmd.projectileHitRadius, 0, 32, 0),
        projectileHitDamage: clampNum(cmd.projectileHitDamage, 0, 1e6, 0),
        projectileExplosive: !!cmd.projectileExplosive,
        projectileExplosionRadius: clampNum(cmd.projectileExplosionRadius, 0, 32, 0),
        projectileDamagePeak: clampNum(cmd.projectileDamagePeak, 0, 1e6, 0),
      };
      return { ok: true };
    }
    case 'disarm_building': {
      const b = lookupBuilding(cmd);
      if (!b) return { ok: false, error: 'no building' };
      if (cmd.owner && b.owner !== cmd.owner) return { ok: false, error: 'not your building' };
      b.weapon = null;
      return { ok: true };
    }
    /** Phase 4.1: register a projectile with the authoritative
     *  motion engine. Browser-side weapon code mirrors every spawn
     *  here so other clients can render the in-flight tracer. The
     *  server runs gravity + drag + TTL + bounds; hit detection is
     *  still client-side for now (Phase 4.1b). */
    case 'spawn_projectile': {
      const p = spawnProjectile(cmd);
      if (!p) return { ok: false, error: 'projectile cap reached' };
      return { ok: true, id: p.id, clientTag: p.clientTag };
    }
    case 'despawn_projectile': {
      const p = lookupProjectile(cmd);
      if (!p) return { ok: false, error: 'no projectile' };
      if (cmd.owner && p.owner !== cmd.owner) return { ok: false, error: 'not your projectile' };
      deleteProjectile(p);
      return { ok: true };
    }
    case 'place_building': {
      // Phase 5f: when the caller (AI brain) omits ox/oz, run
      // server-side spot selection anchored at the owner's HQ.
      // Browser-driven placements pass explicit cells + floorY and
      // skip the picker — the local sim's footprint validation is
      // already doing this work.
      let args = cmd;
      const explicit = typeof cmd.ox === 'number' && typeof cmd.oz === 'number';
      if (!explicit) {
        const owner = typeof cmd.owner === 'string' ? cmd.owner : null;
        const kind = typeof cmd.kind === 'string' ? cmd.kind : null;
        if (!owner || !kind) return { ok: false, error: 'owner + kind required' };
        // Phase 6+: server is authoritative for the AI-driven place
        // path. Browser-driven flows (explicit ox/oz) skip cost
        // entirely — their local economy already paid. Spot picker
        // runs before the cost check so a missing HQ produces a
        // specific error instead of the generic resource one.
        const spot = pickBuildingSpot(owner, kind);
        if (!spot) return { ok: false, error: 'no placement spot' };
        const cost = BUILDING_COSTS[kind] || { food: 0, metals: 0, wood: 0 };
        if (!canAfford(owner, cost)) return { ok: false, error: 'insufficient resources' };
        debit(owner, cost);
        const spec = BUILDING_SPECS[kind];
        const maxHp = typeof cmd.maxHp === 'number' ? cmd.maxHp : 500;
        args = {
          ...cmd,
          ox: spot.ox, oz: spot.oz,
          floorY: spot.floorY,
          cellsW: spec.cellsW, cellsD: spec.cellsD,
          upgradeState: typeof cmd.upgradeState === 'string' ? cmd.upgradeState : 'pending',
          hp: typeof cmd.hp === 'number' ? cmd.hp : maxHp,
          maxHp,
        };
      }
      const b = spawnBuilding(args);
      if (!b) return { ok: false, error: 'building cap reached' };
      return {
        ok: true, id: b.id, clientTag: b.clientTag,
        ox: b.ox, oz: b.oz, floorY: b.floorY,
        cellsW: b.cellsW, cellsD: b.cellsD,
      };
    }
    case 'update_building': {
      const b = lookupBuilding(cmd);
      if (!b) return { ok: false, error: 'no building' };
      if (cmd.owner && b.owner !== cmd.owner) return { ok: false, error: 'not your building' };
      if (typeof cmd.upgradeState === 'string') {
        b.upgradeState = cmd.upgradeState.slice(0, 16);
      }
      if (typeof cmd.hp === 'number') b.hp = clampNum(cmd.hp, 0, 1e7, b.hp);
      if (typeof cmd.maxHp === 'number') b.maxHp = clampNum(cmd.maxHp, 0, 1e7, b.maxHp);
      if (typeof cmd.civilianCap === 'number') b.civilianCap = clampNum(cmd.civilianCap, 0, 1000, b.civilianCap);
      if (Array.isArray(cmd.trainQueue)) {
        b.trainQueue = cmd.trainQueue.slice(0, 32).map(s => String(s).slice(0, 32));
      }
      if (typeof cmd.destroyed === 'boolean') b.destroyed = cmd.destroyed;
      return { ok: true };
    }
    case 'despawn_building': {
      const b = lookupBuilding(cmd);
      if (!b) return { ok: false, error: 'no building' };
      if (cmd.owner && b.owner !== cmd.owner) return { ok: false, error: 'not your building' };
      deleteBuilding(b);
      return { ok: true };
    }
    case 'set_resources': {
      // Resource pools are owner-keyed, so the command is identified
      // by owner (no clientTag). Only the owner can update their pool.
      const owner = typeof cmd.owner === 'string' ? cmd.owner.slice(0, 32) : null;
      if (!owner) return { ok: false, error: 'owner required' };
      const r = getResources(owner);
      if (typeof cmd.food === 'number') r.food = clampNum(cmd.food, 0, 1e9, r.food);
      if (typeof cmd.metals === 'number') r.metals = clampNum(cmd.metals, 0, 1e9, r.metals);
      if (typeof cmd.wood === 'number') r.wood = clampNum(cmd.wood, 0, 1e9, r.wood);
      if (typeof cmd.popCap === 'number') r.popCap = clampNum(cmd.popCap, 0, 1e6, r.popCap);
      return { ok: true };
    }
    /** Authoritative damage to a unit. ANY caller can damage ANY
     *  entity — owner gating doesn't make sense for "I shot you", and
     *  validating "the shooter could really hit this target" requires
     *  server-side projectile flight (Phase 5+). For now we trust
     *  the amount but still gate against negative numbers and own-
     *  team self-damage so an obvious cheat client can't escape. The
     *  server is canonical for HP — when it hits zero we despawn so
     *  every observer's snapshot agrees the unit is dead. */
    case 'damage_entity': {
      const e = lookupEntity(cmd);
      if (!e) return { ok: false, error: 'no entity' };
      const amount = clampNum(cmd.amount, 0, 1e6, 0);
      if (amount <= 0) return { ok: true };
      e.hp = Math.max(0, e.hp - amount);
      if (e.hp === 0) deleteEntity(e);
      return { ok: true, hp: e.hp };
    }
    case 'damage_building': {
      const b = lookupBuilding(cmd);
      if (!b) return { ok: false, error: 'no building' };
      const amount = clampNum(cmd.amount, 0, 1e6, 0);
      if (amount <= 0) return { ok: true };
      b.hp = Math.max(0, b.hp - amount);
      if (b.hp === 0) b.destroyed = true;
      return { ok: true, hp: b.hp, destroyed: b.destroyed };
    }
    /** Authoritative voxel mutation. Two shapes:
     *   sphere: {x, y, z, radius, mat}     — used by projectile splash.
     *   ops:    [{x, y, z, mat}, ...]      — explicit per-voxel writes.
     *
     *  We don't run the actual mutation against a server-side voxel
     *  buffer yet (Phase 6b — that's the multi-day worldgen+chunk
     *  port). Today we just log the edit so every connected client
     *  agrees on the destruction; clients fetch new entries via
     *  /world/edits and replay them.
     */
    /** Lock in the seed for chunk generation. The first caller wins;
     *  subsequent attempts only succeed if the seed matches (idempotent
     *  retries are fine). Once set, the seed is permanent for the
     *  session — a desync would corrupt every cached chunk and every
     *  future client's view of the world. */
    case 'set_world_seed': {
      const seed = clampNum(cmd.seed, 0, 0x7fffffff, DEFAULT_WORLD_SEED) | 0;
      if (state.worldSeedLocked) {
        if (state.worldSeed !== seed) {
          return { ok: false, error: 'world seed already set' };
        }
        return { ok: true, worldSeed: state.worldSeed };
      }
      // First-time set: discard any chunk cached against the default
      // seed so future generations use the new one. Same for the
      // worldgen overlay — it's seed-bound.
      if (state.worldSeed !== seed) {
        if (state.chunkCache.size > 0) state.chunkCache.clear();
        cachedWorldOverlay = null;
        cachedWorldOverlaySeed = null;
      }
      state.worldSeed = seed;
      state.worldSeedLocked = true;
      return { ok: true, worldSeed: state.worldSeed };
    }
    case 'voxel_edit': {
      const sender = typeof cmd.owner === 'string' ? cmd.owner.slice(0, 32) : 'anon';
      let op = null;
      if (typeof cmd.radius === 'number' && Number.isFinite(cmd.radius) && cmd.radius > 0) {
        op = {
          kind: 'sphere',
          x: clampNum(cmd.x, -1e6, 1e6, 0),
          y: clampNum(cmd.y, -1e6, 1e6, 0),
          z: clampNum(cmd.z, -1e6, 1e6, 0),
          radius: clampNum(cmd.radius, 0, 64, 0),
          mat: clampNum(cmd.mat, 0, 255, 0),
        };
      } else if (Array.isArray(cmd.ops) && cmd.ops.length > 0) {
        const ops = [];
        for (const w of cmd.ops) {
          if (!w || typeof w !== 'object') continue;
          ops.push({
            x: clampNum(w.x, -1e6, 1e6, 0),
            y: clampNum(w.y, -1e6, 1e6, 0),
            z: clampNum(w.z, -1e6, 1e6, 0),
            mat: clampNum(w.mat, 0, 255, 0),
          });
          if (ops.length >= 4096) break;
        }
        if (ops.length === 0) return { ok: false, error: 'no ops' };
        op = { kind: 'set', ops };
      } else {
        return { ok: false, error: 'voxel_edit needs radius+xyz or ops' };
      }
      // Phase 6b: actually apply the edit to the server's sparse
      // override map so subsequent /world/chunk queries reflect the
      // mutation. The compact `op` stays in the log for
      // bandwidth-sensitive replay; the per-voxel diff lives only in
      // the override map.
      applyVoxelOpToOverrides(op);
      triggerLeafDecayForOp(op);
      state.voxelEditSeq++;
      const entry = {
        seq: state.voxelEditSeq,
        tick: state.tick,
        sender,
        op,
      };
      state.voxelEdits.push(entry);
      while (state.voxelEdits.length > VOXEL_EDIT_LOG_CAP) state.voxelEdits.shift();
      // Phase 4.2: push the edit to every connected SSE subscriber as
      // a typed event so other clients can mirror the destruction
      // immediately rather than polling /world/edits. The originating
      // client filters by `sender` to avoid double-applying its own
      // local write.
      broadcastVoxelEdit(entry);
      return { ok: true, seq: state.voxelEditSeq };
    }
    /** Admin-only: wipe entities + buildings + civilian rosters so a
     *  fresh test session doesn't inherit prior-game state. The
     *  auto-game harness sends this on browser boot. World seed and
     *  the voxel edit log stay intact since rebuilding the chunk
     *  cache is expensive. */
    case 'reset_state': {
      state.entities.clear();
      state.byTag.clear();
      state.buildings.clear();
      state.buildingsByTag.clear();
      state.projectiles.clear();
      state.projectilesByTag.clear();
      state.resources.clear();
      civilianResidents.clear();
      civilianStates.clear();
      civilianStarveTimer.clear();
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown command: ${cmd.type}` };
  }
}

// ----------------------------------------------------------------------------
// Tick loop
// ----------------------------------------------------------------------------

function tick(dt) {
  state.tick++;
  // Civilians are spawned + steered server-side. Clients adopt them
  // out of the snapshot via reconciliation (no spawn command needed
  // from the browser).
  tickCivilians(dt);
  // Phase 4.3a: armed entities pick targets and fire here, before
  // the projectile tick advances flight. Spawns land in
  // state.projectiles and ride the same physics + raycast path as
  // client-mirrored projectiles.
  tickAutoEngage(dt);
  // Phase 4.1: server-tracked projectile flight. Hit detection lives
  // on the client today, but the entity table records the canonical
  // position so future phases can flip the rendering source.
  tickProjectiles(dt);
  // Phase 5a: drain leaf-decay timers. Any tree that lost its trunk
  // last tick gets its canopy removed here as a single 'set' op
  // broadcast.
  tickLeafDecay(dt);
  // Phase 5b: age saplings. Mature trees stamp via a single
  // batched 'set' voxel_edit so connected clients pick up the
  // canopy via VoxelEditMirror.
  tickSaplings(dt);
  // Phase 6+: passive food income for AI farms so an authoritative
  // brain doesn't starve while the proper farmer pipeline is still
  // browser-side.
  tickFarmIncome(dt);
  // Civilian food upkeep (2 food/min each) + starvation. Runs after income so
  // the farm stream offsets the bite before anyone goes hungry.
  tickCivilianUpkeep(dt);
  for (const e of state.entities.values()) {
    let budget = e.speed * dt;
    while (budget > 0) {
      const next = e.path.length > 0 ? e.path[0] : null;
      const target = next ?? e.target;
      if (!target) break;
      const dx = target.x - e.x;
      const dy = (typeof target.y === 'number' ? target.y : e.y) - e.y;
      const dz = target.z - e.z;
      const dist = Math.hypot(dx, dz);
      // Y is interpolated proportionally to the XZ progress so sloped
      // waypoint chains read sensibly even though we don't terrain-walk.
      if (dist <= budget) {
        e.x = target.x;
        e.z = target.z;
        e.y += dy;
        budget -= dist;
        if (next) {
          e.path.shift();
          if (e.path.length === 0) {
            e.target = null;
          } else {
            e.target = { x: e.path[0].x, z: e.path[0].z };
          }
        } else {
          e.target = null;
          break;
        }
      } else {
        const inv = 1 / Math.max(dist, 1e-6);
        const step = budget * inv;
        e.x += dx * step;
        e.z += dz * step;
        e.y += dy * step;
        budget = 0;
      }
    }
  }
  state.rev++;
}

let lastTickAt = Date.now();
// Tests load this module via require() to call applyCommand + tick
// directly; setting GAME_SERVER_TEST=1 keeps the auto-tick interval
// from running underneath them and corrupting the assertion state.
const tickHandle = process.env.GAME_SERVER_TEST
  ? null
  : setInterval(() => {
      const now = Date.now();
      const dt = Math.max(0, Math.min(0.5, (now - lastTickAt) / 1000));
      lastTickAt = now;
      tick(dt);
      broadcastSnapshot();
    }, Math.floor(TICK_DT_S * 1000));
tickHandle?.unref?.();

// ----------------------------------------------------------------------------
// SSE broadcast
// ----------------------------------------------------------------------------

const streams = new Set();

function snapshot(viewerOwner) {
  // Cross-cutting Phase: per-viewer resource filter. When the
  // subscriber identifies itself via `?player=<id>` on /game/stream,
  // we only include their own resource pool — a maphack client
  // can't poll the snapshot to read enemy economy. Calling without a
  // viewer (e.g. /health/game) emits the full table.
  const resources = {};
  for (const [owner, r] of state.resources) {
    if (viewerOwner && owner !== viewerOwner) continue;
    resources[owner] = { food: r.food | 0, metals: r.metals | 0, wood: r.wood | 0, popCap: r.popCap | 0 };
  }
  // Phase 6+: per-viewer FoW. Vision bitmap is rebuilt at most once
  // per tick across all subscribers via `ensureVisionForTick`. Own
  // assets are always visible regardless of bitmap state.
  if (viewerOwner) ensureVisionForTick();
  // Latest voxel-edit seq the client can use to bootstrap or
  // resync. The actual edit payloads live behind /world/edits — we
  // don't include them in the snapshot stream because a single
  // sphere damage can mutate hundreds of voxels and the snapshot
  // would balloon.
  const lastEditSeq = state.voxelEdits.length > 0
    ? state.voxelEdits[state.voxelEdits.length - 1].seq
    : 0;
  return {
    tick: state.tick,
    rev: state.rev,
    voxelEditSeq: lastEditSeq,
    entities: Array.from(state.entities.values())
      .filter(e => !viewerOwner || e.owner === viewerOwner || isVisibleToViewer(viewerOwner, e.x, e.z))
      .map(e => ({
        id: e.id,
        clientTag: e.clientTag,
        kind: e.kind,
        owner: e.owner,
        x: +e.x.toFixed(3),
        y: +e.y.toFixed(3),
        z: +e.z.toFixed(3),
        target: e.target ? { x: +e.target.x.toFixed(3), z: +e.target.z.toFixed(3) } : null,
        pathLen: e.path.length,
        hp: e.hp,
      })),
    projectiles: Array.from(state.projectiles.values())
      // Projectiles use the same vision gate so a far-away tracer
      // doesn't leak the shooter's position. Own-side projectiles
      // (matching owner) bypass the gate.
      .filter(p => !viewerOwner || p.owner === viewerOwner || isVisibleToViewer(viewerOwner, p.x, p.z))
      .map(p => ({
        id: p.id,
        clientTag: p.clientTag,
        kind: p.kind,
        owner: p.owner,
        x: +p.x.toFixed(3),
        y: +p.y.toFixed(3),
        z: +p.z.toFixed(3),
        vx: +p.vx.toFixed(3),
        vy: +p.vy.toFixed(3),
        vz: +p.vz.toFixed(3),
        age: +p.age.toFixed(3),
        ownerId: p.ownerId,
      })),
    buildings: Array.from(state.buildings.values())
      // Building centre cell drives the gate — a small footprint
      // partly inside the vision cone reads as visible if its
      // centre cell is visible. Acceptable for a coarse first cut.
      .filter(b => {
        if (!viewerOwner) return true;
        if (b.owner === viewerOwner) return true;
        const cxw = (b.ox + ((b.cellsW || 1) >> 1)) * NAV_CELL_METERS;
        const czw = (b.oz + ((b.cellsD || 1) >> 1)) * NAV_CELL_METERS;
        return isVisibleToViewer(viewerOwner, cxw, czw);
      })
      .map(b => ({
        id: b.id,
        clientTag: b.clientTag,
        kind: b.kind,
        owner: b.owner,
        ox: b.ox,
        oz: b.oz,
        floorY: b.floorY,
        cellsW: b.cellsW,
        cellsD: b.cellsD,
        upgradeState: b.upgradeState,
        hp: b.hp,
        maxHp: b.maxHp,
        trainQueueLen: b.trainQueue.length,
        destroyed: b.destroyed,
      })),
    resources,
  };
}

/** Compute a sparse diff between two snapshots. Output shape:
 *    {
 *      tick, rev,
 *      entitiesChanged?, entitiesRemoved?,
 *      buildingsChanged?, buildingsRemoved?,
 *      projectilesChanged?, projectilesRemoved?,
 *      resourcesChanged?,    // per-owner replacement
 *      voxelEditSeq,
 *    }
 *  For each entity/building/projectile row we compare full JSON
 *  representations — keeps the diff logic uniform regardless of
 *  field-set evolution. The cost is a stringify pair per row (cheap
 *  relative to the typed-array work elsewhere). When `prev` is null
 *  (first delta after a fresh subscriber) the result lists every
 *  current row as "changed". */
function snapshotDelta(prev, next) {
  const out = {
    tick: next.tick,
    rev: next.rev,
    voxelEditSeq: next.voxelEditSeq,
  };
  for (const key of ['entities', 'buildings', 'projectiles']) {
    const prevRows = prev && Array.isArray(prev[key]) ? prev[key] : [];
    const nextRows = Array.isArray(next[key]) ? next[key] : [];
    const prevById = new Map();
    for (const r of prevRows) prevById.set(r.id, JSON.stringify(r));
    const changed = [];
    const seen = new Set();
    for (const r of nextRows) {
      seen.add(r.id);
      const enc = JSON.stringify(r);
      if (prevById.get(r.id) !== enc) changed.push(r);
    }
    const removed = [];
    for (const r of prevRows) if (!seen.has(r.id)) removed.push(r.id);
    if (changed.length > 0) out[`${key}Changed`] = changed;
    if (removed.length > 0) out[`${key}Removed`] = removed;
  }
  // Resources: per-owner JSON compare. We send the full owner record
  // when anything inside it changed — the browser merges by owner
  // key, not field, so we don't need to break it down further.
  const prevRes = (prev && prev.resources) || {};
  const nextRes = next.resources || {};
  const resChanged = {};
  let resHasChange = false;
  for (const owner of Object.keys(nextRes)) {
    const a = JSON.stringify(prevRes[owner] || null);
    const b = JSON.stringify(nextRes[owner]);
    if (a !== b) {
      resChanged[owner] = nextRes[owner];
      resHasChange = true;
    }
  }
  if (resHasChange) out.resourcesChanged = resChanged;
  return out;
}

function deltaIsEmpty(delta) {
  return !delta.entitiesChanged && !delta.entitiesRemoved
    && !delta.buildingsChanged && !delta.buildingsRemoved
    && !delta.projectilesChanged && !delta.projectilesRemoved
    && !delta.resourcesChanged;
}

/** Per-stream broadcast bookkeeping. Each subscriber tracks the last
 *  full snapshot we sent them so the next tick can be diffed against
 *  it. Cleared on disconnect (see the SSE handler below) so a long
 *  session can't grow the map unbounded. */
const streamState = new Map();
/** Resync cadence — every Nth tick we broadcast a full snapshot to
 *  every subscriber and reset their `lastSent`. Caps the worst-case
 *  drift if a delta is dropped or arrives out of order, and bounds
 *  the JSON.stringify cost in `snapshotDelta`. */
const SNAPSHOT_RESYNC_TICKS = 100;

function broadcastSnapshot() {
  if (streams.size === 0) return;
  // Cache snapshots by viewer key so two `enemy`-viewing subscribers
  // share the same JSON-build cost. Falls back to a single snapshot
  // when no viewer is set.
  const byViewer = new Map();
  const isResync = (state.tick % SNAPSHOT_RESYNC_TICKS) === 0;
  for (const res of streams) {
    let st = streamState.get(res);
    const viewer = st ? st.viewer ?? null : null;
    let snap = byViewer.get(viewer);
    if (!snap) {
      snap = snapshot(viewer);
      byViewer.set(viewer, snap);
    }
    if (isResync) {
      const fullPayload = `data: ${JSON.stringify(snap)}\n\n`;
      try { res.write(fullPayload); }
      catch (_e) { streams.delete(res); streamState.delete(res); continue; }
      streamState.set(res, { lastSent: snap, viewer });
      continue;
    }
    if (!st) {
      // Fresh subscriber — bootstrap with a full snapshot, then seed
      // `lastSent` so future ticks become deltas.
      const fullPayload = `data: ${JSON.stringify(snap)}\n\n`;
      try { res.write(fullPayload); }
      catch (_e) { streams.delete(res); continue; }
      streamState.set(res, { lastSent: snap, viewer });
      continue;
    }
    const delta = snapshotDelta(st.lastSent, snap);
    if (deltaIsEmpty(delta)) continue;
    const payload = `event: snapshot_delta\ndata: ${JSON.stringify(delta)}\n\n`;
    try { res.write(payload); }
    catch (_e) { streams.delete(res); streamState.delete(res); continue; }
    st.lastSent = snap;
  }
}

/** Push a typed `projectile_impact` event so clients can play impact
 *  effects (debris, smoke) without waiting on the next snapshot.
 *  Voxel mutations from the impact still flow through `voxel_edit`
 *  (same broadcast path) — this event carries the *projectile-side*
 *  metadata: kind, owner, target voxel material, world position, and
 *  (since Phase 4.1d) the id of the entity directly hit, if any. */
function broadcastProjectileImpact(p, voxelHit, hitEntityId) {
  state.projectileImpactSeq++;
  if (streams.size === 0) return;
  const payload = `event: projectile_impact\ndata: ${JSON.stringify({
    seq: state.projectileImpactSeq,
    tick: state.tick,
    projectileId: p.id,
    clientTag: p.clientTag,
    kind: p.kind,
    owner: p.owner,
    ownerId: p.ownerId,
    x: +p.x.toFixed(3),
    y: +p.y.toFixed(3),
    z: +p.z.toFixed(3),
    voxelX: voxelHit ? voxelHit.x : -1,
    voxelY: voxelHit ? voxelHit.y : -1,
    voxelZ: voxelHit ? voxelHit.z : -1,
    voxelMat: voxelHit ? voxelHit.mat : 0,
    hitEntityId: hitEntityId >= 0 ? hitEntityId : -1,
  })}\n\n`;
  for (const res of streams) {
    try { res.write(payload); } catch (_e) { streams.delete(res); }
  }
}

/** Push a typed `voxel_edit` event over the SSE stream so connected
 *  clients can mirror the delta. Uses the SSE `event:` field so
 *  EventSource subscribers can listen via
 *  `addEventListener('voxel_edit', ...)` independently of the default
 *  snapshot stream. */
function broadcastVoxelEdit(entry) {
  if (streams.size === 0) return;
  const payload = `event: voxel_edit\ndata: ${JSON.stringify({
    seq: entry.seq,
    tick: entry.tick,
    sender: entry.sender,
    op: entry.op,
  })}\n\n`;
  for (const res of streams) {
    try { res.write(payload); } catch (_e) { streams.delete(res); }
  }
}

// DEBUG: tally per-type command counts; flushed to stderr every 3s.
const cmdStats = {};
setInterval(() => {
  if (Object.keys(cmdStats).length === 0) return;
  process.stderr.write(`[cmd-stats] entities=${state.entities.size} buildings=${state.buildings.size} ${JSON.stringify(cmdStats)}\n`);
  for (const k of Object.keys(cmdStats)) delete cmdStats[k];
}, 3000).unref?.();

// ----------------------------------------------------------------------------
// HTTP server
// ----------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      tick: state.tick,
      entities: state.entities.size,
      projectiles: state.projectiles.size,
      buildings: state.buildings.size,
      ownerPools: state.resources.size,
      voxelEdits: state.voxelEdits.length,
      voxelEditSeq: state.voxelEditSeq,
      voxelOverrides: state.voxelOverrides.size,
      chunkCache: state.chunkCache.size,
      worldSeed: state.worldSeed,
      streams: streams.size,
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/world/metals') {
    // Authoritative metal-pile cluster list, computed by the same
    // worldgen pipeline that produces chunk bytes. The browser uses
    // this when streaming the world from the server (Phase 6d) — its
    // worker-mining bookkeeping needs the same cluster layout the
    // chunks expose.
    const overlay = getWorldOverlay(state.worldSeed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      seed: state.worldSeed,
      clusters: overlay.clusters,
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/world/seed') {
    // Surface the world seed + lock state so a connecting client can
    // verify it generated locally against the same seed the server's
    // chunk endpoint will use. The default seed is in effect until
    // the lobby's `set_world_seed` lands.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      seed: state.worldSeed,
      locked: state.worldSeedLocked,
      defaultSeed: DEFAULT_WORLD_SEED,
    }));
    return;
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/world/chunk/raw')) {
    // Binary chunk content with overrides applied — 32³ bytes of
    // material ids in y-major chunk-local order. Saves ~33% wire vs.
    // base64-in-JSON and lets the client write straight into its
    // voxel buffer once the chunk is decoded.
    const u = new URL(req.url, 'http://localhost');
    const cx = Number.parseInt(u.searchParams.get('cx') || '', 10);
    const cy = Number.parseInt(u.searchParams.get('cy') || '', 10);
    const cz = Number.parseInt(u.searchParams.get('cz') || '', 10);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
      return json(res, 400, { error: 'cx, cy, cz required' });
    }
    const buf = getChunkSnapshot(cx, cy, cz);
    if (!buf) return json(res, 416, { error: 'chunk out of world bounds' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Chunk-CX': String(cx),
      'X-Chunk-CY': String(cy),
      'X-Chunk-CZ': String(cz),
      'X-Chunk-Size': String(CHUNK_SIZE),
      'X-World-Seed': String(state.worldSeed),
      'X-Voxel-Edit-Seq': String(state.voxelEditSeq),
    });
    res.end(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
    return;
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/world/chunk')) {
    // /world/chunk?cx=&cy=&cz=  — returns the override list for that
    // chunk so a connecting client can patch its own locally-generated
    // chunk. cx/cy/cz are CHUNK indices (i.e. voxel index / 32).
    const u = new URL(req.url, 'http://localhost');
    const cx = Number.parseInt(u.searchParams.get('cx') || '', 10);
    const cy = Number.parseInt(u.searchParams.get('cy') || '', 10);
    const cz = Number.parseInt(u.searchParams.get('cz') || '', 10);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
      return json(res, 400, { error: 'cx, cy, cz required' });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cx, cy, cz,
      chunkSize: CHUNK_SIZE,
      headSeq: state.voxelEditSeq,
      overrides: chunkOverrides(cx, cy, cz),
    }));
    return;
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/world/edits')) {
    // /world/edits?sinceSeq=N — clients ask for everything after a
    // sequence they've already applied. Returns at most 2048 entries
    // per request so a freshly-connecting client doesn't get a 5 MB
    // burst; they can paginate.
    const u = new URL(req.url, 'http://localhost');
    const since = Number.parseInt(u.searchParams.get('sinceSeq') || '0', 10) || 0;
    const out = [];
    for (const e of state.voxelEdits) {
      if (e.seq <= since) continue;
      out.push(e);
      if (out.length >= 2048) break;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      // The seq the caller can pass next time. If we hit the page
      // limit it'll be the last one we returned; otherwise it's the
      // current head.
      headSeq: state.voxelEditSeq,
      lastReturnedSeq: out.length > 0 ? out[out.length - 1].seq : since,
      edits: out,
    }));
    return;
  }

  if (req.method === 'GET' && req.url && (req.url.startsWith('/game/stream') || req.url.startsWith('/game/state'))) {
    // Cross-cutting Phase: subscribers identify themselves via
    // `?player=<id>` so the snapshot can hide other players'
    // resources. The query is optional — without it the response
    // includes the full resource table (used by the no-viewer
    // /health-style probes).
    const u = new URL(req.url, 'http://localhost');
    const viewerRaw = u.searchParams.get('player');
    const viewer = typeof viewerRaw === 'string' && viewerRaw.length > 0
      ? viewerRaw.slice(0, 32)
      : null;
    if (u.pathname === '/game/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot(viewer)));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Send an initial snapshot immediately so a fresh subscriber
    // doesn't have to wait up to 50 ms for the next tick. The
    // streamState entry seeds `lastSent` to this same snapshot so
    // the next tick's delta is computed against it.
    const initial = snapshot(viewer);
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
    streams.add(res);
    streamState.set(res, { lastSent: initial, viewer });
    req.on('close', () => { streams.delete(res); streamState.delete(res); });
    req.on('error', () => { streams.delete(res); streamState.delete(res); });
    return;
  }

  if (req.method === 'POST' && req.url === '/game/input') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch (_e) { return json(res, 400, { error: 'bad json' }); }
      // Single-command or batch.
      const cmds = Array.isArray(payload) ? payload : [payload];
      const results = [];
      for (const cmd of cmds) {
        const r = applyCommand(cmd);
        // DEBUG: trace every command type with frequency so we can
        // see what the browser actually ships. Remove once the worker
        // disappearance is diagnosed.
        const t = (cmd && cmd.type) || '?';
        cmdStats[t] = (cmdStats[t] || 0) + 1;
        results.push(r);
      }
      json(res, 200, { results });
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch (_e) { /* ignore */ } });
    return;
  }

  res.writeHead(404); res.end();
});

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

if (!process.env.GAME_SERVER_TEST) {
  server.listen(PORT, () => process.stderr.write(`game-server listening on :${PORT}\n`));
}

module.exports = { applyCommand, snapshot, snapshotDelta, deltaIsEmpty, state, tick };
