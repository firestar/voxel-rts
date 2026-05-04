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
const WORK_REACH_M    = VOXEL_SIZE * 12;
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
const TASK_STALL_SECONDS = 8;
// Minimum seconds between consecutive expensive voxel scans per idle worker.
const SCAN_COOLDOWN_SECS = 0.5;
// Minimum seconds between repeated routeWorker calls while waiting for an async path.
const ROUTE_COOLDOWN_SECS = 0.4;

export interface WorkerDeps {
  units: UnitManager;
  world: VoxelWorld;
  buildings: BuildingManager;
  saplings: SaplingManager;
  resources: Resources;
  taskBoard: WorkerTaskBoard;
  routeWorker: (u: Unit, wx: number, wy: number, wz: number) => void;
  onVoxelEdit: (wx: number, wy: number, wz: number) => void;
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
  findBestMineTarget?: (fromX: number, fromZ: number) => { wx: number; wy: number; wz: number } | null;
}

let workerLogTimer = 0;
const WORKER_LOG_INTERVAL = 3.0;

export function tickWorkers(dt: number, deps: WorkerDeps): void {
  deps.taskBoard.syncAutoOrders(deps.buildings);

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
      } else {
        u.taskStallTimer += dt;
        if (u.taskStallTimer >= TASK_STALL_SECONDS) {
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
          u.taskProgressKey = 0;
          continue;
        }
      }
    }

    if (tickHarvester(u, dt, deps, scanFiredThisTick)) scanFiredThisTick = true;
  }
}

function workerProgressKey(u: Unit): number {
  const carry = u.carrying.wood * 31 + u.carrying.metals + u.carrying.food * 7;
  const path = u.path.length;
  return ((carry & 0xffff) << 16) ^ (path & 0xff) ^ ((u.miningTicks & 0xff) << 8);
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
      const tx = u.task.wx, ty = u.task.wy, tz = u.task.wz;
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

      if (u.task.kind === 'mine' && deps.findMetalCluster) {
        const cluster = deps.findMetalCluster(vx, vy, vz);
        if (cluster) {
          if (u.claimedClusterId !== cluster.id) {
            const cdx = cluster.worldX - u.x, cdz = cluster.worldZ - u.z;
            const approachR = (cluster.rxz + 8) * VOXEL_SIZE;
            if (cdx * cdx + cdz * cdz > approachR * approachR) {
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
            u.path = [];
            // Snap to the slot immediately — worker is already inside the approach
            // radius so the teleport is at most a few voxels.
            if (deps.clusterSlotPos) {
              const sp = deps.clusterSlotPos(cluster, slot);
              u.x = sp.x; u.y = sp.y; u.z = sp.z;
              u.blockedFrames = 0;
            }
          }
          // Re-snap if the separation pass or physics nudged the worker off their spot.
          if (deps.clusterSlotPos) {
            const sp = deps.clusterSlotPos(cluster, u.claimedSlotIndex);
            const sdx = sp.x - u.x, sdz = sp.z - u.z;
            if (sdx * sdx + sdz * sdz > WORK_REACH_M * WORK_REACH_M) {
              u.x = sp.x; u.y = sp.y; u.z = sp.z;
              u.path = []; u.blockedFrames = 0;
            }
          }
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
            // Route directly to the ore voxel; the pathfinder's nearestPassable
            // snaps the goal to the nearest walkable cell adjacent to the ore pile,
            // keeping the worker within MINE_REACH_M.
            routeIfDue(u, deps, tx, ty, tz);
          } else {
            const ap = approachPos(u.x, u.z, tx, tz, 10);
            routeIfDue(u, deps, ap.x, ty, ap.z);
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
      const storage = deps.buildings.nearestStorage(u.x, u.z);
      if (!storage) return false;
      const dpos = doorWorldPos(storage, u.x, u.z);
      const dx = dpos.x - u.x, dz = dpos.z - u.z;
      if (dx * dx + dz * dz <= INTERACT_REACH_M * INTERACT_REACH_M) {
        storage.stockpile.wood += u.carrying.wood;
        storage.stockpile.metals += u.carrying.metals;
        // Food goes directly to the global resource pool — it's perishable and
        // doesn't wait for a truck run.
        deps.resources.food += u.carrying.food;
        u.carrying.wood = 0;
        u.carrying.metals = 0;
        u.carrying.food = 0;
        u.task = { kind: 'idle' };
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
  const order = deps.taskBoard.claim(u.id, (o) => isHarvesterOrderForFocus(o, focus));
  if (order) {
    u.claimedOrderId = order.id;
    u.workerScanCooldown = 0;
    u.workerRouteCooldown = 0;
    applyOrderToHarvester(u, order, deps);
    return false;
  }
  if (focus === 'farm') return false;

  // Voxel scans are expensive (~19M iterations each). Rate-limit per worker
  // AND globally: at most one scan fires per tickWorkers call so that when an
  // entire cluster depletes and every worker goes idle simultaneously, they
  // don't all scan in the same JS frame (which would freeze the main thread
  // for several seconds).
  if (u.workerScanCooldown > 0 || scanFiredThisTick) return false;
  u.workerScanCooldown = SCAN_COOLDOWN_SECS;

  if (focus !== 'chop') {
    if (deps.findBestMineTarget) {
      // Cluster-aware load-balanced assignment: cheap, so multiple workers can
      // be assigned in the same tick without triggering scanFiredThisTick.
      const target = deps.findBestMineTarget(u.x, u.z);
      if (target) {
        u.task = { kind: 'mine', wx: target.wx, wy: target.wy, wz: target.wz };
        u.workerRouteCooldown = 0;
        deps.routeWorker(u, target.wx, target.wy, target.wz);
        return false; // cheap — don't block other workers from assigning this tick
      }
    } else {
      // Fallback: expensive full-world voxel scan when cluster metadata is absent.
      const ore = findNearestExposed(deps.world.buffers.voxels, u.x, u.y, u.z, M_METAL);
      if (ore) {
        u.task = { kind: 'mine', wx: (ore.vx + 0.5) * VOXEL_SIZE, wy: (ore.vy + 0.5) * VOXEL_SIZE, wz: (ore.vz + 0.5) * VOXEL_SIZE };
        u.workerRouteCooldown = 0;
        deps.routeWorker(u, u.task.wx, u.task.wy, u.task.wz);
        return true; // expensive scan fired — suppress further scans this tick
      }
    }
  }

  if (focus !== 'mine') {
    const wood = findNearestExposed(deps.world.buffers.voxels, u.x, u.y, u.z, M_WOOD);
    if (wood) {
      u.task = { kind: 'chop', wx: (wood.vx + 0.5) * VOXEL_SIZE, wy: (wood.vy + 0.5) * VOXEL_SIZE, wz: (wood.vz + 0.5) * VOXEL_SIZE };
      // Approach offset = 10 voxels (1.25 m) so the goal lands in a nav cell
      // adjacent to the trunk, not inside the tree's own (blocked) cell.
      const ap = approachPos(u.x, u.z, u.task.wx, u.task.wz, 10);
      u.workerRouteCooldown = 0;
      deps.routeWorker(u, ap.x, u.task.wy, ap.z);
      return true;
    }
  }
  return true; // scan ran, found nothing — still counts as fired so we don't pile on
}

function isHarvesterOrderForFocus(o: WorkOrder, focus: WorkerFocus): boolean {
  // Farm-focused workers are the only ones that touch farms. Miners /
  // choppers / auto-focus workers ignore farmTend and harvestFarm — the
  // player has to dedicate a worker to "farm" focus before any tending
  // happens. Auto workers still pick up plant orders.
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
