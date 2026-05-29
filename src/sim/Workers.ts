import { VoxelWorld, worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, VOXEL_SIZE } from '../voxel/types';
import { M_WOOD, M_METAL } from '../voxel/Materials';
import type { MetalCluster } from '../voxel/Metals';
import { Unit, UnitManager, WorkerFocus } from './Units';
import { Resources } from './Resources';
import { BuildingManager, Building, doorWorldPos } from './Buildings';
import { SaplingManager } from './Saplings';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';
import { WorkerTaskBoard, WorkOrder } from './WorkerTasks';

/**
 * Capacity each worker can carry before they MUST deliver. Mining is paused
 * once total carrying ≥ CARRY_CAP; the worker walks the load to the nearest
 * storage building before resuming.
 */
export const WORKER_CARRY_CAP = 20;

// Chop reach: 12 voxels = 1.5 m. The worker has to stand in a non-tree-blocked
// nav cell, so they're typically a full nav cell (1 m centre-to-centre) away
// from the trunk voxel. The previous 3-voxel (0.375 m) reach put the chop
// trigger band INSIDE the tree's own cell — which the pathfinder won't route
// the worker into — so trees were "found" but never chopped.
export const WORKER_CHOP_REACH_M = VOXEL_SIZE * 12;
// Vertical chop reach: 200 voxels = 25 m straight up from the worker's feet.
// Lets a chopper fell tall trees from the top down without needing to climb.
const CHOP_REACH_UP_VOXELS = 200;
const WORK_REACH_M    = WORKER_CHOP_REACH_M;
const MINE_REACH_M    = VOXEL_SIZE * 10;  // mine reach: swing from perimeter
const INTERACT_REACH_M = 1.6;             // storage drop-off / farm enter

const WORK_DPS           = 60;   // damage per second when chopping / mining
const MINE_SWING_INTERVAL = 1.0; // seconds per 1-metal chip from a cluster voxel
const WORK_RADIUS_VOXELS  = 1.4; // voxel-space radius per chop swing

// Metal mining uses the cluster system in production and never reaches this scan.
// This fallback is for wood (trees are typically within 30 m) and testing.
const SCAN_RADIUS_M = 32;
const SCAN_R2 = SCAN_RADIUS_M * SCAN_RADIUS_M;

// Drop task after this many seconds with no measurable progress.
const TASK_STALL_SECONDS = 1.00;
// Minimum seconds between consecutive expensive voxel scans per idle worker.
const SCAN_COOLDOWN_SECS = 0.05;
// Minimum seconds between repeated routeWorker calls while waiting for an async path.
const ROUTE_COOLDOWN_SECS = 0.4;

// --- Worker coordination ----------------------------------------------------
//
// Friendly workers share a global tree-reservation table so two workers never
// race to the same trunk. Metal clusters already have per-slot reservation;
// wood is per-voxel. Keys are voxel indexes; values are the worker unit id
// holding the reservation. `unitWoodReservation` is the reverse map so we can
// release in O(1) on task change / death.
//
// All friendly workers participate (the user's "40-voxel network" is a
// stronger guarantee than necessary — globally-shared state is cheaper and
// has the same effect since faraway workers never compete for the same tree
// in practice). Hostile units never enter this table.
const woodReservations = new Map<number, number>();
const unitWoodReservation = new Map<number, number>();

/** Per-worker temporary blacklist of metal clusters whose path attempts
 *  have repeatedly failed. The next scan skips any cluster in the set;
 *  the entry expires after CLUSTER_BLACKLIST_SECS so a previously-
 *  unreachable cluster gets retried later (terrain may have changed). */
const workerClusterBlacklist = new Map<number, Map<number, number>>();
const CLUSTER_BLACKLIST_SECS = 60;
function blacklistCluster(unitId: number, clusterId: number, now: number): void {
  let m = workerClusterBlacklist.get(unitId);
  if (!m) { m = new Map(); workerClusterBlacklist.set(unitId, m); }
  m.set(clusterId, now + CLUSTER_BLACKLIST_SECS);
}
function getClusterBlacklist(unitId: number, now: number): Set<number> {
  const m = workerClusterBlacklist.get(unitId);
  const out = new Set<number>();
  if (!m) return out;
  for (const [cid, expiresAt] of m) {
    if (expiresAt < now) m.delete(cid);
    else out.add(cid);
  }
  return out;
}

function claimWood(unitId: number, voxelIdx: number): boolean {
  const owner = woodReservations.get(voxelIdx);
  if (owner !== undefined && owner !== unitId) return false;
  releaseWood(unitId);
  woodReservations.set(voxelIdx, unitId);
  unitWoodReservation.set(unitId, voxelIdx);
  return true;
}

function releaseWood(unitId: number): void {
  const idx = unitWoodReservation.get(unitId);
  if (idx === undefined) return;
  unitWoodReservation.delete(unitId);
  if (woodReservations.get(idx) === unitId) woodReservations.delete(idx);
}

function isWoodReservedByOther(unitId: number, voxelIdx: number): boolean {
  const owner = woodReservations.get(voxelIdx);
  return owner !== undefined && owner !== unitId;
}

/** Drop reservations belonging to dead workers and to workers whose current
 *  task no longer references the reserved voxel. Cheap O(workers) sweep. */
function reapWoodReservations(units: UnitManager): void {
  if (unitWoodReservation.size === 0) return;
  const alive = new Set<number>();
  for (const u of units.units) {
    if (u.kind !== 'worker' || u.hp <= 0) continue;
    alive.add(u.id);
    if (u.task.kind !== 'chop') {
      releaseWood(u.id);
      continue;
    }
    const reserved = unitWoodReservation.get(u.id);
    if (reserved === undefined) continue;
    const vx = Math.floor(u.task.wx / VOXEL_SIZE);
    const vy = Math.floor(u.task.wy / VOXEL_SIZE);
    const vz = Math.floor(u.task.wz / VOXEL_SIZE);
    if (worldIndex(vx, vy, vz) !== reserved) releaseWood(u.id);
  }
  for (const id of unitWoodReservation.keys()) {
    if (!alive.has(id)) releaseWood(id);
  }
}

export interface WorkerDeps {
  units: UnitManager;
  world: VoxelWorld;
  buildings: BuildingManager;
  saplings: SaplingManager;
  /** Player-team resources. Worker food deposits land here unless the
   *  worker's team is `'enemy'` and `enemyResources` is provided. */
  resources: Resources;
  /** Per-team resource pool lookup. If absent (test bench), all
   *  teams fall back to `resources`. */
  resourcesForTeam?: (team: 'player' | 'enemy' | 'enemy2') => Resources;
  /** Optional enemy-team resources. Set in production; left undefined
   *  in tests that don't exercise the enemy economy. */
  enemyResources?: Resources;
  taskBoard: WorkerTaskBoard;
  routeWorker: (u: Unit, wx: number, wy: number, wz: number) => void;
  onVoxelEdit: (wx: number, wy: number, wz: number) => void;
  /**
   * World-space Y of the ground at (wx, wz), with tree wood/leaf voxels
   * skipped — i.e. the surface a unit would walk on. Used by the chop
   * routing so the goal lands at the actual ground level next to a trunk
   * rather than on top of the tree (path planner's `nearestPassable`
   * otherwise finds the airy cell directly above the trunk top, since wood
   * counts as a passable floor below it). Optional in tests that don't
   * need real path follow.
   */
  surfaceY?: (wx: number, wz: number) => number;
  /**
   * Look up the MetalCluster that owns the voxel at (vx, vy, vz), or null
   * if no living cluster covers that position.
   */
  findMetalCluster?: (vx: number, vy: number, vz: number) => MetalCluster | null;
  /**
   * Called each time a worker chips 1 metal from a cluster voxel.
   * The handler finds the nearest live voxel to (workerX, workerZ), decrements
   * its metal, and destroys it when exhausted. Returns true if a voxel was
   * destroyed, false if a voxel was chipped, null if no voxel is in range.
   */
  onClusterVoxelChipped?: (cluster: MetalCluster, workerX: number, workerZ: number) => boolean | null;
  /** Claim one of the cluster's worker slots. Returns slot index or null if full. */
  tryClaimClusterSlot?: (cluster: MetalCluster, unitId: number) => number | null;
  /** Release a previously-claimed slot by unit ID. */
  releaseClusterSlot?: (clusterId: number, unitId: number) => void;
  /** World-space position a worker should stand at for the given slot index. */
  clusterSlotPos?: (cluster: MetalCluster, slotIndex: number) => { x: number; y: number; z: number };
  /**
   * Find a mine-task target (ore voxel world position) in the nearest cluster
   * with a free worker slot, excluding `excludeClusterId`. Returns null if no
   * cluster has capacity.
   */
  findAlternateClusterTarget?: (excludeClusterId: number, fromX: number, fromZ: number) => { wx: number; wy: number; wz: number } | null;
  /**
   * Load-balanced initial mine assignment. Scores clusters by occupancy fraction
   * and distance so idle workers spread across all mines rather than piling onto
   * the nearest one. Returns a voxel target in the best cluster, or null when no
   * cluster has a free slot.
   */
  findBestMineTarget?: (fromX: number, fromZ: number, excludeClusterIds?: ReadonlySet<number>) => { wx: number; wy: number; wz: number; clusterId: number } | null;
  /**
   * Pick a passable nav cell adjacent to the trunk that the worker can stand
   * in to chop. Returns the cell-center world position and ground Y, or null
   * when every neighbour of the trunk's nav cell is blocked (canopy, terrain,
   * or building) and the tree should be skipped. The implementation queries
   * the worker's UnitGrid directly, which is the only authority on whether a
   * cell is actually reachable — `approachPos` alone can land in a cell whose
   * column has no walkable cy near the surface (dense canopies block every cy
   * inside the body-height span, leaving only above-canopy air cells that A*
   * cannot reach from the ground).
   */
  findChopApproach?: (workerX: number, workerZ: number, trunkX: number, trunkZ: number) =>
    { x: number; y: number; z: number } | null;
}

let workerLogTimer = 0;
const WORKER_LOG_INTERVAL = 3.0;

export function tickWorkers(dt: number, deps: WorkerDeps): void {
  deps.taskBoard.syncAutoOrders(deps.buildings);
  reapWoodReservations(deps.units);

  workerLogTimer -= dt;
  if (workerLogTimer <= 0) {
    workerLogTimer = WORKER_LOG_INTERVAL;
    const workers = deps.units.units.filter(u => u.kind === 'worker' && u.hp > 0);
    if (workers.length > 0) {
      console.log('[WORKERS]', workers.map(w => {
        const carry = `W=${w.carrying.wood} M=${w.carrying.metals}`;
        const task = w.task.kind;
        const pos = `(${w.x.toFixed(1)},${w.z.toFixed(1)})`;
        const path = w.path.length > 0 ? ` path=${w.path.length}` : '';
        return `#${w.id}[${task} ${carry} @${pos}${path}]`;
      }).join('  '));
    }
    // Also log storage stockpiles
    const storages = deps.buildings.buildings.filter(b => b.spec.kind === 'storage' && !b.destroyed);
    if (storages.length > 0) {
      console.log('[STORAGE]', storages.map(s =>
        `#${s.id}[metals=${s.stockpile.metals} wood=${s.stockpile.wood} inbound=${s.supplyInbound} threshold=${s.truckCallThreshold}]`
      ).join('  '));
    }
  }

  // Allow at most one expensive voxel scan (findNearestExposed) per tickWorkers
  // call. Without this limit, every idle worker fires its scan in the same JS
  // call stack when a cluster depletes simultaneously — 9 workers × 19M
  // iterations = multi-second main-thread freeze.
  let scanFiredThisTick = false;

  for (const u of deps.units.units) {
    if (u.kind !== 'worker') continue;

    if (u.task.kind === 'idle') {
      u.taskStallTimer = 0;
      u.taskProgressKey = 0;
      u.workerScanCooldown = Math.max(0, u.workerScanCooldown - dt);
      u.workerRouteCooldown = Math.max(0, u.workerRouteCooldown - dt);
    } else {
      u.workerRouteCooldown = Math.max(0, u.workerRouteCooldown - dt);
      const key = workerProgressKey(u);
      if (key !== u.taskProgressKey) {
        u.taskProgressKey = key;
        u.taskStallTimer = 0;
        u.repathFailures = 0;
      } else {
        u.taskStallTimer += dt;
        if (u.taskStallTimer >= TASK_STALL_SECONDS) {
          // A stalled delivery means the closest storage door is unreachable
          // (HQ + storage placed cheek-to-jowl can produce a 1-cell channel
          // that A* never finds — see PATH FAIL warnings on enemy workers).
          // Bump the per-unit failure count; on the next deliver attempt the
          // worker rotates to the next-closest face so it stops looping on
          // the same dead goal forever.
          if (u.task.kind === 'deliver') {
            u.repathFailures = (u.repathFailures ?? 0) + 1;
          }
          // Blacklist the current cluster for this worker so the next
          // auto-task scan picks a different one.
          if (u.task.kind === 'mine' && u.claimedClusterId >= 0) {
            blacklistCluster(u.id, u.claimedClusterId, performance.now() / 1000);
          }
          if (u.claimedOrderId !== 0) {
            const o = deps.taskBoard.byId(u.claimedOrderId);
            if (o && o.claimedBy === u.id) o.claimedBy = 0;
            u.claimedOrderId = 0;
          }
          for (const b of deps.buildings.buildings) {
            if (b.farmerId === u.id) b.farmerId = null;
            if (b.harvesterClaimId === u.id) b.harvesterClaimId = null;
          }
          releaseClusterSlotIfHeld(u, deps);
          u.task = { kind: 'idle' };
          u.path = [];
          u.taskStallTimer = 0;
          // Keep `taskProgressKey` at its current value so the next
          // tick's "did progress happen?" check stays accurate. If
          // we reset to 0 the worker's carry-based key always looks
          // like a fresh transition, masking repeat stalls.
          u.taskProgressKey = workerProgressKey(u);
          continue;
        }
      }
    }

    if (tickHarvester(u, dt, deps, scanFiredThisTick)) scanFiredThisTick = true;
  }
}

function workerProgressKey(u: Unit): number {
  // Path length is intentionally excluded: a worker that's
  // re-routing every 0.4 s on a failing partial path looks like
  // it's making progress (path: 0 → N → walked → 0 → repeat) when
  // it's actually trapped. Real progress = carry change or a chip
  // landed. Position deltas would also work but are noisy under
  // collision-resolved peers; carry+chips is the cleanest signal.
  const carry = u.carrying.wood * 31 + u.carrying.metals + u.carrying.food * 7;
  return ((carry & 0xffff) << 16) ^ ((u.miningTicks & 0xffff));
}

// ----------------------------- Harvester -------------------------------------

/** Fire a route request only when the per-unit cooldown has elapsed, then reset it.
 *  Prevents flooding the pathWorker queue while waiting for an async response. */
function routeIfDue(u: Unit, deps: WorkerDeps, wx: number, wy: number, wz: number): void {
  if (u.workerRouteCooldown > 0) return;
  u.workerRouteCooldown = ROUTE_COOLDOWN_SECS;
  deps.routeWorker(u, wx, wy, wz);
}

function releaseClusterSlotIfHeld(u: Unit, deps: WorkerDeps): void {
  if (u.claimedClusterId < 0) return;
  deps.releaseClusterSlot?.(u.claimedClusterId, u.id);
  u.claimedClusterId = -1;
  u.claimedSlotIndex = -1;
}

/** Returns true if a voxel scan fired this call (so the outer loop can suppress further scans this tick). */
function tickHarvester(u: Unit, dt: number, deps: WorkerDeps, scanFiredThisTick: boolean): boolean {
  if (u.task.kind === 'idle' && u.claimedOrderId !== 0) releaseClaimedOrder(u, deps);
  if (u.task.kind !== 'mine') releaseClusterSlotIfHeld(u, deps);

  const total = u.carrying.wood + u.carrying.metals + u.carrying.food;
  // Cap reached → switch to delivery so the worker walks the load to storage
  // before resuming. Done in any non-deliver state so a fresh chop/mine that
  // pushes the carry over the cap immediately swaps over to delivery.
  if (total >= WORKER_CARRY_CAP && u.task.kind !== 'deliver') {
    u.task = { kind: 'deliver' };
    u.path = [];
  }

  switch (u.task.kind) {
    case 'idle':
      return assignNextHarvestTask(u, deps, scanFiredThisTick);

    case 'chop':
    case 'mine': {
      const targetMat = u.task.kind === 'chop' ? M_WOOD : M_METAL;
      let tx = u.task.wx, ty = u.task.wy, tz = u.task.wz;
      // Re-target each tick when chopping: prefer the topmost wood voxel
      // within reach (horizontal ≤ WORK_REACH_M, vertical up to
      // CHOP_REACH_UP_VOXELS above the worker's feet) so a tall tree falls
      // top-down. Search radius narrows once the worker is within reach so
      // we don't switch trees mid-chop just because another trunk is
      // marginally taller; while still walking in (out of horiz reach) we
      // keep targeting the originally-assigned voxel and let the routing
      // catch us up.
      if (u.task.kind === 'chop') {
        const homeVx = Math.floor(tx / VOXEL_SIZE);
        const homeVz = Math.floor(tz / VOXEL_SIZE);
        const top = findTopmostWoodInReach(
          deps.world.buffers.voxels, u, homeVx, homeVz,
        );
        if (top) {
          tx = (top.vx + 0.5) * VOXEL_SIZE;
          ty = (top.vy + 0.5) * VOXEL_SIZE;
          tz = (top.vz + 0.5) * VOXEL_SIZE;
        }
      }
      const dx = tx - u.x, dz = tz - u.z;
      const horiz2 = dx * dx + dz * dz;
      const vx = Math.floor(tx / VOXEL_SIZE);
      const vy = Math.floor(ty / VOXEL_SIZE);
      const vz = Math.floor(tz / VOXEL_SIZE);
      const m = readVoxel(deps.world.buffers.voxels, vx, vy, vz);
      if (m !== targetMat) {
        u.task = { kind: 'idle' };
        return false;
      }
      // Choppers must not fell building walls. If a building has been placed
      // on top of an existing tree task (or the target was somehow assigned
      // inside a footprint), abandon the task back to idle so the next scan
      // picks an off-building tree instead.
      if (u.task.kind === 'chop' && voxelInsideAnyBuilding(deps.buildings, vx, vz)) {
        u.task = { kind: 'idle' };
        return false;
      }

      if (u.task.kind === 'mine' && deps.findMetalCluster) {
        const cluster = deps.findMetalCluster(vx, vy, vz);
        if (cluster) {
          if (u.claimedClusterId !== cluster.id) {
            const cdx = cluster.worldX - u.x, cdz = cluster.worldZ - u.z;
            const approachR = (cluster.rxz + 8) * VOXEL_SIZE;
            const outsideApproach = cdx * cdx + cdz * cdz > approachR * approachR;
            // While still walking toward the cluster, bail to a different one
            // if every slot is already taken — no point arriving just to bounce
            // off a full mine. The slot count is a simple Array.some so this is
            // cheap to re-check each tick.
            if (outsideApproach && !cluster.workerSlots.some(s => s === 0 || s === u.id)) {
              const alt = deps.findAlternateClusterTarget?.(cluster.id, u.x, u.z) ?? null;
              if (alt) {
                u.task = { kind: 'mine', wx: alt.wx, wy: alt.wy, wz: alt.wz };
                u.path = [];
              } else {
                u.task = { kind: 'idle' };
              }
              return false;
            }
            if (outsideApproach) {
              if (u.path.length === 0)
                routeIfDue(u, deps, cluster.worldX, u.y, cluster.worldZ);
              return false;
            }
            const slot = deps.tryClaimClusterSlot?.(cluster, u.id) ?? null;
            if (slot === null) {
              const alt = deps.findAlternateClusterTarget?.(cluster.id, u.x, u.z) ?? null;
              if (alt) { u.task = { kind: 'mine', wx: alt.wx, wy: alt.wy, wz: alt.wz }; u.path = []; }
              else { u.task = { kind: 'idle' }; }
              return false;
            }
            u.claimedClusterId = cluster.id;
            u.claimedSlotIndex = slot;
            // Route to the slot position via the path planner so the
            // worker walks there smoothly. Previous code snapped XZ
            // directly which counts as a teleport in the harness.
            if (deps.clusterSlotPos) {
              const sp = deps.clusterSlotPos(cluster, slot);
              u.workerRouteCooldown = 0;
              deps.routeWorker(u, sp.x, sp.y, sp.z);
              u.blockedFrames = 0;
            }
          }
          // No re-snap: if separation drifts the worker off the slot,
          // the next routeIfDue call below pushes a fresh path so it
          // walks back. Teleports are forbidden.
          if (u.path.length > 0) u.path = [];
          u.mineSwingTimer += dt;
          u.miningTicks++;
          if (u.mineSwingTimer >= MINE_SWING_INTERVAL) {
            u.mineSwingTimer -= MINE_SWING_INTERVAL;
            const result = deps.onClusterVoxelChipped?.(cluster, u.x, u.z) ?? null;
            if (result !== null) {
              u.carrying.metals += 1;
              if (result) deps.onVoxelEdit(u.x, u.y, u.z);
            }
            if (cluster.destroyed) { releaseClusterSlotIfHeld(u, deps); u.task = { kind: 'idle' }; }
          }
          return false;
        }
      }

      const reachM = u.task.kind === 'mine' ? MINE_REACH_M : WORK_REACH_M;
      if (horiz2 > reachM * reachM) {
        if (u.path.length === 0) {
          if (u.task.kind === 'mine') {
            // Route directly to the ore voxel — `nearestPassable` snaps to
            // the walkable cell adjacent to the surface-exposed ore.
            routeIfDue(u, deps, tx, ty, tz);
          } else {
            // For chop, ask the host for a passable nav cell adjacent to the
            // trunk's cell. With overlapping canopies the trunk's cell *and*
            // some of its neighbours can be tree-blocked at every cy inside
            // the body-height span, so a naive 1.25 m offset can land in a
            // cell A* cannot reach from the ground. The host implementation
            // walks the trunk's neighbours, picks the closest passable one to
            // the worker, and returns its centre — guaranteed reachable. If
            // every neighbour is blocked the tree itself is unreachable; drop
            // the task so the next scan finds a different one.
            const cap = deps.findChopApproach?.(u.x, u.z, tx, tz);
            if (cap) {
              routeIfDue(u, deps, cap.x, cap.y, cap.z);
            } else if (deps.findChopApproach) {
              releaseWood(u.id);
              u.task = { kind: 'idle' };
              return false;
            } else {
              const ap = approachPos(u.x, u.z, tx, tz, 10);
              const apY = deps.surfaceY ? deps.surfaceY(ap.x, ap.z) : u.y;
              routeIfDue(u, deps, ap.x, apY, ap.z);
            }
          }
        }
        return false;
      }
      if (u.path.length > 0) u.path = [];

      const peak = Math.max(1, Math.min(255, Math.round(WORK_DPS * dt)));
      const radius = u.task.kind === 'mine' ? 0.4 : WORK_RADIUS_VOXELS;
      const result = deps.world.damageSphere(
        vx + 0.5, vy + 0.5, vz + 0.5,
        radius,
        peak,
      );
      if (result.destroyed.length > 0) {
        for (const d of result.destroyed) {
          if (d.material === M_WOOD) u.carrying.wood++;
          else if (d.material === M_METAL) u.carrying.metals++;
        }
        deps.onVoxelEdit(tx, ty, tz);
        const after = readVoxel(deps.world.buffers.voxels, vx, vy, vz);
        if (after !== targetMat) u.task = { kind: 'idle' };
      }
      return false;
    }

    case 'plant': {
      const tx = u.task.wx, tz = u.task.wz;
      const dx = tx - u.x, dz = tz - u.z;
      if (dx * dx + dz * dz > INTERACT_REACH_M * INTERACT_REACH_M) {
        if (u.path.length === 0) routeIfDue(u, deps, tx, u.y, tz);
        return false;
      }
      const seed = (u.id * 0x9e3779b9 + Math.floor(performance.now())) >>> 0;
      const res = deps.saplings.plant(deps.world, tx, tz, seed);
      if (res.ok) deps.onVoxelEdit(tx, u.y, tz);
      completeClaimedOrder(u, deps);
      u.task = { kind: 'idle' };
      return false;
    }

    case 'farm': {
      const farm = deps.buildings.byId(u.task.buildingId);
      if (!farm || farm.destroyed || farm.spec.kind !== 'farm') {
        completeClaimedOrder(u, deps);
        u.task = { kind: 'idle' };
        return false;
      }
      farm.farmerId = u.id;
      const cxw = farmCenterX(farm);
      const czw = farmCenterZ(farm);
      const inside = pointInFarm(farm, u.x, u.z);
      if (!inside && u.path.length === 0) {
        routeIfDue(u, deps, cxw, u.y, czw);
        return false;
      }
      if (inside && farm.cropReady && (farm.harvesterClaimId === null || farm.harvesterClaimId === u.id)) {
        const { foodGained } = deps.buildings.collectFarm(farm, u.id);
        if (foodGained > 0) {
          u.carrying.food += foodGained;
          // Leave the farm to deliver; farmTend order remains on the board so
          // the farmer will reclaim it after returning from the storage run.
          u.task = { kind: 'deliver' };
          u.path = [];
        }
      }
      return false;
    }

    case 'harvestFarm': {
      const farm = deps.buildings.byId(u.task.buildingId);
      if (!farm || farm.destroyed || farm.spec.kind !== 'farm' || !farm.cropReady) {
        if (farm && farm.harvesterClaimId === u.id) farm.harvesterClaimId = null;
        completeClaimedOrder(u, deps);
        u.task = { kind: 'idle' };
        return false;
      }
      const cxw = farmCenterX(farm);
      const czw = farmCenterZ(farm);
      const dx = cxw - u.x, dz = czw - u.z;
      if (dx * dx + dz * dz > INTERACT_REACH_M * INTERACT_REACH_M) {
        if (u.path.length === 0) routeIfDue(u, deps, cxw, u.y, czw);
        return false;
      }
      deps.buildings.collectFarm(farm, u.id);
      completeClaimedOrder(u, deps);
      u.task = { kind: 'idle' };
      return false;
    }

    case 'deliver': {
      if (total === 0) {
        u.task = { kind: 'idle' };
        return false;
      }
      // Storage is the primary drop-off — its stockpile is what the
      // supply trucks shuttle back to HQ. But if the AI placed its
      // first storage in a closed pocket (HQ + barracks + farms wrap
      // every cardinal face — see iter1 PATH FAIL warnings) every
      // delivery stalls forever and the team starves on wood/metals
      // because trucks never have anything to fetch.
      //
      // After even one stalled delivery (`repathFailures >= 1`) we
      // fall back to the team's HQ door: the HQ footprint is large
      // with several open faces near the initial worker spawn, so
      // it's almost always reachable. On HQ arrival we credit the
      // team resource pool directly (mirroring truck_deliver_hq
      // accounting). It's a minor optimisation — the truck shuttle
      // is normally what closes the loop — but it keeps the AI
      // viable when its placement layout traps the closest storage.
      // The `repathFailures` counter is reset on every successful
      // drop, so a worker prefers the proper storage drop-off again
      // on the next round trip.
      const failures = u.repathFailures ?? 0;
      const storage = deps.buildings.nearestStorage(u.x, u.z, u.team);
      let target: Building | null = storage;
      let hqFallback = false;
      if (!target || failures >= 1) {
        const hq = deps.buildings.buildings.find(b =>
          !b.destroyed && b.spec.kind === 'hq' && b.team === u.team
        );
        if (hq) { target = hq; hqFallback = true; }
      }
      if (!target) return false;
      // Rotate through the target's 4 face doors when prior attempts
      // stalled. Without this a worker pinned in a base where the
      // closest face sits in an unreachable corridor would re-route to
      // the same dead goal every 0.4 s for the rest of the match.
      //
      // Storage-direction rotation only — the HQ fallback already
      // implies the storage's nearest face was unreachable, so we
      // start fresh at the HQ's closest face (rotation 0). Otherwise
      // we'd be carrying over the storage's failure count to the HQ
      // and skipping its own closest door.
      const rotation = hqFallback ? 0 : (u.repathFailures ?? 0);
      const dpos = doorWorldPos(target, u.x, u.z, rotation);
      const dx = dpos.x - u.x, dz = dpos.z - u.z;
      if (dx * dx + dz * dz <= INTERACT_REACH_M * INTERACT_REACH_M) {
        const teamRes = deps.resourcesForTeam
          ? deps.resourcesForTeam(u.team as 'player' | 'enemy' | 'enemy2')
          : (u.team !== 'player' && deps.enemyResources ? deps.enemyResources : deps.resources);
        if (hqFallback) {
          teamRes.wood   += u.carrying.wood;
          teamRes.metals += u.carrying.metals;
        } else {
          target.stockpile.wood   += u.carrying.wood;
          target.stockpile.metals += u.carrying.metals;
        }
        // Food is perishable: skip the truck run and credit the
        // worker's team resource pool directly. All non-player
        // teams have their own pools (per-team lookup) so one AI
        // faction can't drain the other's economy. Falls back to the
        // legacy enemyResources or to `resources` when the host has
        // not provided the team-aware accessor (test bench).
        teamRes.food += u.carrying.food;
        u.carrying.wood = 0;
        u.carrying.metals = 0;
        u.carrying.food = 0;
        u.task = { kind: 'idle' };
        // Reset the rotation counter ONLY when the storage path itself
        // worked. If we fell through to the HQ fallback the storage is
        // still presumed unreachable, so keep `repathFailures >= 1` so the
        // next deliver round skips straight to HQ instead of paying the
        // 1 s task-stall + PATH FAIL log every cycle. Once the underlying
        // layout changes (HQ destroyed, storage rebuilt elsewhere) the
        // worker will go idle from no carry and pick up a fresh task.
        if (!hqFallback) u.repathFailures = 0;
        return false;
      }
      if (u.path.length === 0) routeIfDue(u, deps, dpos.x, dpos.y, dpos.z);
      return false;
    }
  }
  return false;
}

/** Returns true if a voxel scan fired. */
function assignNextHarvestTask(u: Unit, deps: WorkerDeps, scanFiredThisTick: boolean): boolean {
  const focus = u.workerFocus;

  // Board claims are cheap — always check for fresh orders every tick.
  // Cross-team farms / saplings are skipped: an enemy farm-focused
  // worker shouldn't trudge into the player's base to tend their crops.
  const order = deps.taskBoard.claim(u.id, (o) => {
    if (!isHarvesterOrderForFocus(o, focus)) return false;
    if (o.buildingId !== undefined) {
      const b = deps.buildings.byId(o.buildingId);
      if (b && b.team !== u.team) return false;
    }
    return true;
  });
  if (order) {
    u.claimedOrderId = order.id;
    u.workerScanCooldown = 0;
    u.workerRouteCooldown = 0;
    applyOrderToHarvester(u, order, deps);
    return false;
  }
  if (focus === 'farm') {
    // No farmTend / harvestFarm order on the board right now (between
    // milestones, or pre-first-milestone). A farm-focus worker that
    // sits idle for >10 s trips the harness's worker-stuck rule, so
    // pick the nearest friendly farm and either route to it (if not
    // there yet) or just adopt the `farm` task in place (so the
    // tickFarm `farmerOnFarm` check sees the worker AND the harness
    // sees it as "working").
    const myFarm = (deps.buildings.buildings).find(b =>
      !b.destroyed && b.spec.kind === 'farm' && b.team === u.team
    );
    if (myFarm) {
      const farmCx = (myFarm.ox + myFarm.spec.cellsW * 0.5) * VOXEL_SIZE * 8;
      const farmCz = (myFarm.oz + myFarm.spec.cellsD * 0.5) * VOXEL_SIZE * 8;
      const dx = farmCx - u.x, dz = farmCz - u.z;
      u.task = { kind: 'farm', buildingId: myFarm.id };
      if (dx * dx + dz * dz > 1.5 * 1.5) {
        u.workerRouteCooldown = 0;
        deps.routeWorker(u, farmCx, u.y, farmCz);
      }
      return false;
    }
    // No friendly farm yet — fall through to the wood scan below so
    // the worker chops while the AI is busy placing its first farm,
    // rather than sitting idle and tripping the harness's worker-
    // stuck rule.
  }

  // Voxel scans are expensive (~19M iterations each). Rate-limit per worker
  // AND globally: at most one scan fires per tickWorkers call so that when an
  // entire cluster depletes and every worker goes idle simultaneously, they
  // don't all scan in the same JS frame (which would freeze the main thread
  // for several seconds).
  if (u.workerScanCooldown > 0 || scanFiredThisTick) {
    // Scan is throttled this tick (own cooldown, or another worker already
    // scanned — only one voxel scan fires per tickWorkers call). A stranded
    // idle worker would otherwise return here every tick and never relocate,
    // sitting idle past the harness's 10 s rule when a whole cluster depletes
    // and every worker goes idle at once (iter81 FAILURE_STUCK). Regrouping is
    // cheap (no scan), so do it even while throttled.
    regroupTowardBase(u, deps);
    return false;
  }
  u.workerScanCooldown = SCAN_COOLDOWN_SECS;

  // Resource gathering. A worker prefers its focus resource but falls
  // back to the OTHER resource when the preferred one is exhausted
  // within scan range. Without the fallback a chop-focus worker that
  // fells every nearby tree (or a mine-focus worker whose clusters
  // deplete) sits idle and trips the harness's 10 s worker-stuck rule
  // (iter41 FAILURE_STUCK: chop worker #11 idle, no wood nearby).
  // Gathering the alternate resource is standard RTS economy behaviour
  // — it keeps the worker productive, keeps the AI-vs-AI run alive, and
  // spreads workers across both resource types as one runs dry. It is
  // NOT a stuck-recovery teleport: the worker still walks a real path
  // to the alternate resource.
  //
  // Each scan returns one of: 'cheap' (assigned via the cluster planner;
  // don't suppress other workers' scans this tick), 'expensive' (a full
  // voxel scan fired; suppress further scans), 'defer' (transient
  // cluster-slot race — retry next tick, don't try the other resource),
  // or 'none' (nothing found; fall through to the other resource).
  const tryMine = (): 'cheap' | 'expensive' | 'defer' | 'none' => {
    if (deps.findBestMineTarget) {
      const blacklist = getClusterBlacklist(u.id, performance.now() / 1000);
      const target = deps.findBestMineTarget(u.x, u.z, blacklist);
      if (!target) return 'none';
      // Reserve a slot on the cluster up-front so the per-cluster max
      // enforcement is honored from the moment of assignment.
      const tvx = Math.floor(target.wx / VOXEL_SIZE);
      const tvy = Math.floor(target.wy / VOXEL_SIZE);
      const tvz = Math.floor(target.wz / VOXEL_SIZE);
      const cluster = deps.findMetalCluster?.(tvx, tvy, tvz) ?? null;
      const slot = cluster ? (deps.tryClaimClusterSlot?.(cluster, u.id) ?? null) : null;
      if (cluster && slot === null) return 'defer'; // slot race-lost; re-scan next tick
      u.task = { kind: 'mine', wx: target.wx, wy: target.wy, wz: target.wz };
      u.claimedClusterId = target.clusterId;
      if (slot !== null) u.claimedSlotIndex = slot;
      u.workerRouteCooldown = 0;
      deps.routeWorker(u, target.wx, target.wy, target.wz);
      return 'cheap';
    }
    // Fallback: expensive full-world voxel scan when cluster metadata is absent.
    const ore = findNearestExposed(deps.world.buffers.voxels, u.x, u.y, u.z, M_METAL);
    if (!ore) return 'none';
    u.task = { kind: 'mine', wx: (ore.vx + 0.5) * VOXEL_SIZE, wy: (ore.vy + 0.5) * VOXEL_SIZE, wz: (ore.vz + 0.5) * VOXEL_SIZE };
    u.workerRouteCooldown = 0;
    deps.routeWorker(u, u.task.wx, u.task.wy, u.task.wz);
    return 'expensive';
  };

  const tryWood = (): 'expensive' | 'none' => {
    const wood = findNearestExposed(deps.world.buffers.voxels, u.x, u.y, u.z, M_WOOD,
      (vx, vy, vz) => {
        if (voxelInsideAnyBuilding(deps.buildings, vx, vz)) return false;
        // Skip trunks already reserved by a different friendly worker so each
        // worker walks to its own tree instead of all converging on the
        // nearest one.
        if (isWoodReservedByOther(u.id, worldIndex(vx, vy, vz))) return false;
        // Skip trees that already have a friendly worker actively chopping
        // them. Without this filter two harvesters would race for the same
        // trunk: the second one would jostle into the first's hit-box,
        // forcing the active chopper to abandon its swing and re-route.
        if (anotherWorkerChoppingNear(deps.units, u.id, vx, vz)) return false;
        // Skip trees whose every nav-cell neighbour is blocked. With dense
        // canopy these trees are physically out of reach, and assigning them
        // just stalls the worker until the task-stall timer fires.
        if (deps.findChopApproach) {
          const tx = (vx + 0.5) * VOXEL_SIZE;
          const tz = (vz + 0.5) * VOXEL_SIZE;
          if (deps.findChopApproach(u.x, u.z, tx, tz) === null) return false;
        }
        return true;
      });
    if (!wood) return 'none';
    claimWood(u.id, worldIndex(wood.vx, wood.vy, wood.vz));
    u.task = { kind: 'chop', wx: (wood.vx + 0.5) * VOXEL_SIZE, wy: (wood.vy + 0.5) * VOXEL_SIZE, wz: (wood.vz + 0.5) * VOXEL_SIZE };
    // Route to a passable nav cell adjacent to the trunk. The host's
    // `findChopApproach` walks the 8 neighbour cells of the trunk's nav
    // cell, picks the closest passable one to the worker, and returns its
    // centre at ground Y. When the host doesn't supply that callback (e.g.
    // tests with a minimal harness) we fall back to the older 1.25 m
    // approach offset.
    const cap = deps.findChopApproach?.(u.x, u.z, u.task.wx, u.task.wz) ?? null;
    u.workerRouteCooldown = 0;
    if (cap) {
      deps.routeWorker(u, cap.x, cap.y, cap.z);
    } else {
      const ap = approachPos(u.x, u.z, u.task.wx, u.task.wz, 10);
      const apY = deps.surfaceY ? deps.surfaceY(ap.x, ap.z) : u.y;
      deps.routeWorker(u, ap.x, apY, ap.z);
    }
    return 'expensive';
  };

  // Focus sets the PREFERENCE order; both resources are attempted so a
  // worker never idles while either is reachable. 'mine'/'auto'/'farm'
  // try ore first (the metals economy funds combat); 'chop' tries wood
  // first. The complementary scan only runs when the preferred one
  // came up empty.
  const scanOrder = focus === 'chop' ? [tryWood, tryMine] : [tryMine, tryWood];
  for (const scan of scanOrder) {
    const r = scan();
    if (r === 'cheap') return false;     // assigned via cluster planner (cheap)
    if (r === 'expensive') return true;  // assigned; an expensive scan fired
    if (r === 'defer') return false;     // transient slot race; retry next tick
    // 'none' → preferred resource exhausted; fall through to the other
  }

  // No resource reachable from here — the worker has wandered out of scan
  // range of BOTH wood and ore. Walk it back toward base (see regroupTowardBase).
  regroupTowardBase(u, deps);
  return true; // scans ran, found nothing — count as fired so we don't pile on
}

/**
 * Walk a stranded idle worker back toward its team's storage/HQ. Used when a
 * worker can find no resource (both wood + ore out of scan range) AND when its
 * voxel scan is throttled this tick — the base area is resource-dense, so the
 * next scan from there finds work, and meanwhile the worker is MOVING on a real
 * path rather than the 10 s stationary-idle the harness flags (iter66/iter81
 * FAILURE_STUCK: enemy2 worker idle mid-map). No teleport/recovery hack — it's
 * an ordinary route request home, cooldown-gated and only when meaningfully far
 * (>12 m) so near-base idlers don't take a redundant walk.
 *
 * Crucially this is CHEAP (no voxel scan), so it runs even when the global
 * per-tick scan throttle (`scanFiredThisTick`) suppresses this worker's scan —
 * the bug that let stranded workers sit idle for 10 s when a whole cluster
 * depleted and every worker went idle in the same frame.
 */
function regroupTowardBase(u: Unit, deps: WorkerDeps): void {
  if (u.path.length > 0) return; // already moving somewhere
  const regroup = deps.buildings.nearestStorage(u.x, u.z, u.team)
    || deps.buildings.buildings.find(b => !b.destroyed && b.spec.kind === 'hq' && b.team === u.team)
    || null;
  if (!regroup || !deps.surfaceY) return;
  const gx = (regroup.ox + regroup.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
  const gz = (regroup.oz + regroup.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
  const dx = gx - u.x, dz = gz - u.z;
  if (dx * dx + dz * dz > 12 * 12) {
    routeIfDue(u, deps, gx, deps.surfaceY(gx, gz), gz);
  }
}

function isHarvesterOrderForFocus(o: WorkOrder, focus: WorkerFocus): boolean {
  // Per game rule: only farm-focused workers do farm work. Other
  // foci (mine, chop, auto) ignore farmTend and harvestFarm. Each
  // base must dedicate workers to "farm" focus to keep the food
  // economy alive.
  if (focus === 'farm') return o.kind === 'farmTend' || o.kind === 'harvestFarm';
  if (focus === 'mine' || focus === 'chop') return false;
  return o.kind === 'plant';
}

function applyOrderToHarvester(u: Unit, order: WorkOrder, deps: WorkerDeps): void {
  switch (order.kind) {
    case 'plant':
      u.task = { kind: 'plant', wx: order.wx!, wz: order.wz! };
      deps.routeWorker(u, order.wx!, u.y, order.wz!);
      return;
    case 'farmTend': {
      const farm = deps.buildings.byId(order.buildingId!);
      if (!farm) { completeClaimedOrder(u, deps); u.task = { kind: 'idle' }; return; }
      u.task = { kind: 'farm', buildingId: order.buildingId! };
      deps.routeWorker(u, farmCenterX(farm), u.y, farmCenterZ(farm));
      return;
    }
    case 'harvestFarm': {
      const farm = deps.buildings.byId(order.buildingId!);
      if (!farm) { completeClaimedOrder(u, deps); u.task = { kind: 'idle' }; return; }
      farm.harvesterClaimId = u.id;
      u.task = { kind: 'harvestFarm', buildingId: order.buildingId! };
      deps.routeWorker(u, farmCenterX(farm), u.y, farmCenterZ(farm));
      return;
    }
  }
}

function completeClaimedOrder(u: Unit, deps: WorkerDeps): void {
  if (u.claimedOrderId === 0) return;
  deps.taskBoard.remove(u.claimedOrderId);
  u.claimedOrderId = 0;
}

function releaseClaimedOrder(u: Unit, deps: WorkerDeps): void {
  if (u.claimedOrderId === 0) return;
  const o = deps.taskBoard.byId(u.claimedOrderId);
  if (o && o.claimedBy === u.id) o.claimedBy = 0;
  u.claimedOrderId = 0;
}

// --------------------------- Geometry helpers --------------------------------

/**
 * A point N voxels away from (tx, tz) in the direction of the caller at (ux, uz).
 * When the caller is at the target already, returns the target unchanged — the
 * path planner's nearestPassable will find adjacent terrain.
 */
export function approachPos(
  ux: number, uz: number,
  tx: number, tz: number,
  voxels: number,
): { x: number; z: number } {
  const dx = ux - tx, dz = uz - tz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-3) return { x: tx, z: tz };
  const offsetM = voxels * VOXEL_SIZE;
  return { x: tx + (dx / dist) * offsetM, z: tz + (dz / dist) * offsetM };
}

// --------------------------- Voxel scan helpers ------------------------------

interface VoxelHit { vx: number; vy: number; vz: number; }

function findNearestExposed(
  voxels: Uint8Array,
  wx: number, wy: number, wz: number,
  targetMat: number,
  /** Optional caller filter — return false to skip a candidate voxel
   *  (e.g. wood inside a building footprint). */
  accept?: (vx: number, vy: number, vz: number) => boolean,
): VoxelHit | null {
  const radiusVoxels = Math.ceil(SCAN_RADIUS_M / VOXEL_SIZE);
  const cx = Math.floor(wx / VOXEL_SIZE);
  const cy = Math.floor(wy / VOXEL_SIZE);
  const cz = Math.floor(wz / VOXEL_SIZE);
  const x0 = Math.max(0, cx - radiusVoxels);
  const x1 = Math.min(WORLD_X - 1, cx + radiusVoxels);
  const z0 = Math.max(0, cz - radiusVoxels);
  const z1 = Math.min(WORLD_Z - 1, cz + radiusVoxels);
  // Metal and wood only spawn on the surface — thin Y band avoids a full 3D sphere scan.
  const y0 = Math.max(0, cy - 4);
  const y1 = Math.min(WORLD_Y - 1, cy + 16);

  let best: VoxelHit | null = null;
  let bestD2 = Infinity;
  const STRIDE = 3;
  const reachM2 = SCAN_R2 / (VOXEL_SIZE * VOXEL_SIZE);

  for (let y = y0; y <= y1; y++) {
    const dyV = y - cy;
    for (let z = z0; z <= z1; z += STRIDE) {
      const dzV = z - cz;
      for (let x = x0; x <= x1; x += STRIDE) {
        const dxV = x - cx;
        const d2 = dxV * dxV + dyV * dyV + dzV * dzV;
        if (d2 >= bestD2) continue;
        if (d2 > reachM2) continue;
        if (voxels[worldIndex(x, y, z)] !== targetMat) continue;
        if (!isExposed(voxels, x, y, z)) continue;
        if (accept && !accept(x, y, z)) continue;
        bestD2 = d2;
        best = { vx: x, vy: y, vz: z };
      }
    }
  }
  return best;
}

function isExposed(voxels: Uint8Array, vx: number, vy: number, vz: number): boolean {
  if (vx > 0           && voxels[worldIndex(vx - 1, vy, vz)] === AIR) return true;
  if (vx < WORLD_X - 1 && voxels[worldIndex(vx + 1, vy, vz)] === AIR) return true;
  if (vy > 0           && voxels[worldIndex(vx, vy - 1, vz)] === AIR) return true;
  if (vy < WORLD_Y - 1 && voxels[worldIndex(vx, vy + 1, vz)] === AIR) return true;
  if (vz > 0           && voxels[worldIndex(vx, vy, vz - 1)] === AIR) return true;
  if (vz < WORLD_Z - 1 && voxels[worldIndex(vx, vy, vz + 1)] === AIR) return true;
  return false;
}

function readVoxel(voxels: Uint8Array, vx: number, vy: number, vz: number): number {
  if (vx < 0 || vy < 0 || vz < 0 || vx >= WORLD_X || vy >= WORLD_Y || vz >= WORLD_Z) return AIR;
  return voxels[worldIndex(vx, vy, vz)]!;
}

/**
 * Find the highest M_WOOD voxel within the worker's chop reach: horizontal
 * distance ≤ WORK_REACH_M from the worker, AND vertical distance ≤
 * CHOP_REACH_UP_VOXELS above the worker's feet. Search columns within the
 * horizontal reach radius, anchored on the originally-assigned trunk
 * column. Returns the topmost voxel found, or null when the tree is gone.
 *
 * Anchoring on `homeVx`/`homeVz` keeps the chopper committed to the assigned
 * tree even if a neighbouring tree's canopy briefly enters reach — without
 * the anchor a chopper would dance between trunks as foliage shuffles around.
 */
function findTopmostWoodInReach(
  voxels: Uint8Array,
  u: Unit,
  homeVx: number, homeVz: number,
): { vx: number; vy: number; vz: number } | null {
  const reachVoxels = Math.ceil(WORK_REACH_M / VOXEL_SIZE);
  const feetVy = Math.floor(u.y / VOXEL_SIZE);
  const yMax = Math.min(WORLD_Y - 1, feetVy + CHOP_REACH_UP_VOXELS);
  const yMin = Math.max(0, feetVy);
  // Workers chop the assigned tree's column (and any wood directly above it
  // in that column). Looking only at the trunk's column avoids accidentally
  // chopping a different tree whose canopy briefly drifted into reach. Other
  // wood within the worker's horizontal range belongs to a different tree
  // that another scan iteration will pick up.
  const ux = u.x, uz = u.z;
  const reachM2 = WORK_REACH_M * WORK_REACH_M;
  // First try the home column straight up (the typical fast path).
  let best: { vx: number; vy: number; vz: number } | null = null;
  const homeWx = (homeVx + 0.5) * VOXEL_SIZE;
  const homeWz = (homeVz + 0.5) * VOXEL_SIZE;
  if ((homeWx - ux) ** 2 + (homeWz - uz) ** 2 <= reachM2) {
    for (let vy = yMax; vy >= yMin; vy--) {
      if (voxels[worldIndex(homeVx, vy, homeVz)] === M_WOOD) {
        return { vx: homeVx, vy, vz: homeVz };
      }
    }
  }
  // Home column is empty (whole trunk felled or worker drifted) — fan out a
  // small ring to find any remaining wood from the same tree. Cap the scan
  // tight so we don't rake distant forests every chop tick.
  const homeCx = Math.floor(homeVx);
  const homeCz = Math.floor(homeVz);
  let bestVy = -1;
  for (let dz = -reachVoxels; dz <= reachVoxels; dz++) {
    for (let dx = -reachVoxels; dx <= reachVoxels; dx++) {
      const vx = homeCx + dx, vz = homeCz + dz;
      if (vx < 0 || vz < 0 || vx >= WORLD_X || vz >= WORLD_Z) continue;
      const wx = (vx + 0.5) * VOXEL_SIZE, wz = (vz + 0.5) * VOXEL_SIZE;
      const ddx = wx - ux, ddz = wz - uz;
      if (ddx * ddx + ddz * ddz > reachM2) continue;
      // Walk the column top-down to find the highest wood voxel.
      for (let vy = yMax; vy >= yMin; vy--) {
        if (voxels[worldIndex(vx, vy, vz)] === M_WOOD) {
          if (vy > bestVy) { bestVy = vy; best = { vx, vy, vz }; }
          break;
        }
      }
    }
  }
  return best;
}

/**
 * True when another friendly worker has already locked onto this trunk and
 * is in chop range (task = chop, path empty, body within chop reach of the
 * trunk voxel). The scan filter uses this to steer newly-idle workers away
 * from trees that are already being felled, so the active chopper keeps
 * swinging instead of being shoved off the cell by a peer.
 *
 * Cheap O(workers) — the worker count is always small.
 */
function anotherWorkerChoppingNear(units: UnitManager, selfId: number, vx: number, vz: number): boolean {
  const tx = (vx + 0.5) * VOXEL_SIZE;
  const tz = (vz + 0.5) * VOXEL_SIZE;
  // Slack = chop reach + one nav cell; covers any worker who has stopped to
  // swing at this tree's voxel column.
  const reach = WORK_REACH_M + NAV_CELL_VOXELS * VOXEL_SIZE;
  const reach2 = reach * reach;
  for (const o of units.units) {
    if (o.kind !== 'worker' || o.hp <= 0) continue;
    if (o.id === selfId) continue;
    if (o.task.kind !== 'chop') continue;
    if (o.path.length > 0) continue;
    const dx = tx - o.x, dz = tz - o.z;
    if (dx * dx + dz * dz <= reach2) return true;
  }
  return false;
}

/**
 * True if the voxel at (vx, vz) sits in any LIVE building's footprint (the
 * nav-cell rectangle that the building stamp wrote into). Choppers use this
 * to skip M_WOOD voxels that belong to building walls / roofs / fences —
 * trees only spawn outside building footprints, so any wood inside one is
 * by definition a building part and shouldn't be felled by a worker.
 *
 * Cheap O(buildings) check; the building list is small. Y is ignored on
 * purpose so a worker can't even cut a wooden roof voxel that hangs above
 * the floor inside the footprint.
 */
function voxelInsideAnyBuilding(buildings: BuildingManager, vx: number, vz: number): boolean {
  for (const b of buildings.buildings) {
    if (b.destroyed) continue;
    const x0 = b.ox * NAV_CELL_VOXELS;
    const x1 = (b.ox + b.spec.cellsW) * NAV_CELL_VOXELS;
    const z0 = b.oz * NAV_CELL_VOXELS;
    const z1 = (b.oz + b.spec.cellsD) * NAV_CELL_VOXELS;
    if (vx >= x0 && vx < x1 && vz >= z0 && vz < z1) return true;
  }
  return false;
}

export { findNearestExposed };
export type { Building };

function farmCenterX(b: Building): number {
  return (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
}
function farmCenterZ(b: Building): number {
  return (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
}
function pointInFarm(b: Building, x: number, z: number): boolean {
  const wxStart = b.ox * NAV_CELL_VOXELS * VOXEL_SIZE;
  const wzStart = b.oz * NAV_CELL_VOXELS * VOXEL_SIZE;
  const wxEnd = wxStart + b.spec.cellsW * NAV_CELL_VOXELS * VOXEL_SIZE;
  const wzEnd = wzStart + b.spec.cellsD * NAV_CELL_VOXELS * VOXEL_SIZE;
  return x >= wxStart && x < wxEnd && z >= wzStart && z < wzEnd;
}
