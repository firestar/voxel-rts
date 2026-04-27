import { VoxelWorld, worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, VOXEL_SIZE } from '../voxel/types';
import { M_WOOD, M_METAL } from '../voxel/Materials';
import { Unit, UnitManager } from './Units';
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
export const WORKER_CARRY_CAP = 5;

/**
 * How close (in meters, XZ) a worker needs to be to its target voxel before
 * `tickWorkers` starts the chop/mine action. Slightly bigger than 1 cell so
 * the worker doesn't have to land exactly on the voxel below the tree.
 */
const WORK_REACH_M = 1.4;
/** Same idea, but tighter, for storage drop-off. */
const INTERACT_REACH_M = 1.6;

/**
 * Damage applied per second when a worker chops or mines.
 */
const WORK_DPS = 60;
/** Voxel-space radius of each chop/mine swing; small so we hit the target. */
const WORK_RADIUS_VOXELS = 1.4;

/** Squared search radius (m²) for a harvester scanning for nearby resources. */
const SCAN_RADIUS_M = 60;
const SCAN_R2 = SCAN_RADIUS_M * SCAN_RADIUS_M;

/**
 * Seconds a worker can spend on a non-idle task without any progress signal
 * (no path step, no carry change, no voxel chip) before the stall recovery
 * kicks in: the task is dropped to idle, any TaskBoard claim is released,
 * and the worker re-scans next tick. Generous enough that a pathfinder
 * waiting on a long surface route doesn't trip it, but small enough that a
 * truly stuck unit doesn't sit on a job indefinitely.
 */
const TASK_STALL_SECONDS = 8;

/**
 * Per-frame automation for every worker unit. Drives the harvester task
 * state machine through the global `WorkerTaskBoard`:
 *
 *   - Ripe farms and player-issued plant orders become `WorkOrder` entries
 *     on the board.
 *   - Idle workers `claim()` an order from the board.
 *   - Local progress (voxel chip, carry change, path advance) keeps the
 *     stall timer at zero. If a worker can't make progress for
 *     `TASK_STALL_SECONDS`, the task is reset and the order is released.
 *
 * Movement is delegated back to the caller via `routeWorker`, which the
 * Game wires to its `routePath`. A* still runs asynchronously, so we
 * tolerate the path being empty for a frame after the call.
 */
export interface WorkerDeps {
  units: UnitManager;
  world: VoxelWorld;
  buildings: BuildingManager;
  saplings: SaplingManager;
  resources: Resources;
  taskBoard: WorkerTaskBoard;
  routeWorker: (u: Unit, wx: number, wy: number, wz: number) => void;
  onVoxelEdit: () => void;
}

export function tickWorkers(dt: number, deps: WorkerDeps): void {
  // Refresh auto-published orders (newly-ripe farms, removed entries whose
  // target despawned) before any worker reads from the board.
  deps.taskBoard.syncAutoOrders(deps.buildings);

  const { units } = deps;
  for (const u of units.units) {
    if (u.kind !== 'worker') continue;
    // Stall accounting: if a worker on a non-idle task has made no progress
    // since the last tick, age the stall timer; on progress, reset it.
    if (u.task.kind === 'idle') {
      u.taskStallTimer = 0;
      u.taskProgressKey = 0;
    } else {
      const key = workerProgressKey(u);
      if (key !== u.taskProgressKey) {
        u.taskProgressKey = key;
        u.taskStallTimer = 0;
      } else {
        u.taskStallTimer += dt;
        if (u.taskStallTimer >= TASK_STALL_SECONDS) {
          // Stall recovery: drop to idle, release any board claim, kill the
          // path so the next tick gets a fresh route. Do NOT drop carried
          // resources — the worker keeps what they already have so they can
          // still go deliver.
          if (u.claimedOrderId !== 0) {
            const o = deps.taskBoard.byId(u.claimedOrderId);
            if (o && o.claimedBy === u.id) o.claimedBy = 0;
            u.claimedOrderId = 0;
          }
          // If the worker was claimed as a farmer/harvester on a building,
          // release that too so the building doesn't think we're still on it.
          for (const b of deps.buildings.buildings) {
            if (b.farmerId === u.id) b.farmerId = null;
            if (b.harvesterClaimId === u.id) b.harvesterClaimId = null;
          }
          u.task = { kind: 'idle' };
          u.path = [];
          u.taskStallTimer = 0;
          u.taskProgressKey = 0;
          continue;
        }
      }
    }

    tickHarvester(u, dt, deps);
  }
}

/**
 * Cheap signal of whether `u` has made tangible progress on its task since
 * the last tick: packs path length and carry totals into a single number.
 * Any real change rotates the key, which is enough for stall detection.
 */
function workerProgressKey(u: Unit): number {
  const carry = u.carrying.wood * 31 + u.carrying.metals;
  const path = u.path.length;
  return ((carry & 0xffff) << 16) ^ (path & 0xff);
}

// ----------------------------- Harvester -------------------------------------

function tickHarvester(u: Unit, dt: number, deps: WorkerDeps): void {
  // External cancel (e.g. the player hit X) leaves the worker idle but with
  // a stale `claimedOrderId`. Release the claim back to the board so a
  // different worker can pick the order up — we don't `remove()` it because
  // the player only cancelled this worker, not the order itself.
  if (u.task.kind === 'idle' && u.claimedOrderId !== 0) {
    releaseClaimedOrder(u, deps);
  }
  const total = u.carrying.wood + u.carrying.metals;
  // Cap reached → switch to delivery so the worker walks the load to storage
  // before resuming. Done in any non-deliver state so a fresh chop/mine that
  // pushes the carry over the cap immediately swaps over to delivery.
  if (total >= WORKER_CARRY_CAP && u.task.kind !== 'deliver') {
    u.task = { kind: 'deliver' };
    u.path = [];
  }

  switch (u.task.kind) {
    case 'idle':
      assignNextHarvestTask(u, deps);
      return;

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
        return;
      }
      // Metal must be reachable on a voxel face — interior ore can't be picked
      // out without first exposing it (e.g. by demolishing the stone shell).
      // Wood doesn't get this gate; tree trunks intentionally splinter from a
      // single hit on the column edge. We re-check every swing because spoil
      // can bury ore between tasks.
      if (u.task.kind === 'mine'
          && !isExposed(deps.world.buffers.voxels, vx, vy, vz)) {
        u.task = { kind: 'idle' };
        return;
      }

      if (horiz2 > WORK_REACH_M * WORK_REACH_M) {
        if (u.path.length === 0) deps.routeWorker(u, tx, ty, tz);
        return;
      }

      const peak = Math.max(1, Math.min(255, Math.round(WORK_DPS * dt)));
      // Mining narrows the damage sphere to the single target voxel so the
      // surrounding (potentially un-exposed) ore never gets chipped via
      // sphere falloff. Chopping keeps the wider radius so a swing that
      // overlaps two adjacent trunk voxels still progresses both.
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
        deps.onVoxelEdit();
        const after = readVoxel(deps.world.buffers.voxels, vx, vy, vz);
        if (after !== targetMat) u.task = { kind: 'idle' };
      }
      return;
    }

    case 'plant': {
      const tx = u.task.wx, tz = u.task.wz;
      const dx = tx - u.x, dz = tz - u.z;
      if (dx * dx + dz * dz > INTERACT_REACH_M * INTERACT_REACH_M) {
        if (u.path.length === 0) {
          deps.routeWorker(u, tx, u.y, tz);
        }
        return;
      }
      const seed = (u.id * 0x9e3779b9 + Math.floor(performance.now())) >>> 0;
      const res = deps.saplings.plant(deps.world, tx, tz, seed);
      if (res.ok) deps.onVoxelEdit();
      // Plant orders complete win-or-lose; remove the board entry.
      completeClaimedOrder(u, deps);
      u.task = { kind: 'idle' };
      return;
    }

    case 'farm': {
      const farm = deps.buildings.byId(u.task.buildingId);
      if (!farm || farm.destroyed || farm.spec.kind !== 'farm') {
        completeClaimedOrder(u, deps);
        u.task = { kind: 'idle' };
        return;
      }
      farm.farmerId = u.id;
      const cxw = farmCenterX(farm);
      const czw = farmCenterZ(farm);
      const inside = pointInFarm(farm, u.x, u.z);
      if (!inside && u.path.length === 0) {
        deps.routeWorker(u, cxw, u.y, czw);
        return;
      }
      if (inside && farm.cropReady && (farm.harvesterClaimId === null || farm.harvesterClaimId === u.id)) {
        deps.buildings.collectFarm(farm, u.id);
      }
      return;
    }

    case 'harvestFarm': {
      const farm = deps.buildings.byId(u.task.buildingId);
      if (!farm || farm.destroyed || farm.spec.kind !== 'farm' || !farm.cropReady) {
        if (farm && farm.harvesterClaimId === u.id) farm.harvesterClaimId = null;
        completeClaimedOrder(u, deps);
        u.task = { kind: 'idle' };
        return;
      }
      const cxw = farmCenterX(farm);
      const czw = farmCenterZ(farm);
      const dx = cxw - u.x, dz = czw - u.z;
      if (dx * dx + dz * dz > INTERACT_REACH_M * INTERACT_REACH_M) {
        if (u.path.length === 0) deps.routeWorker(u, cxw, u.y, czw);
        return;
      }
      deps.buildings.collectFarm(farm, u.id);
      completeClaimedOrder(u, deps);
      u.task = { kind: 'idle' };
      return;
    }

    case 'deliver': {
      // Empty-handed deliver state shouldn't happen, but if it does drop to
      // idle so the next tick re-picks real work.
      if (total === 0) {
        u.task = { kind: 'idle' };
        return;
      }
      const storage = deps.buildings.nearestStorage(u.x, u.z);
      if (!storage) return;
      const dpos = doorWorldPos(storage);
      const dx = dpos.x - u.x, dz = dpos.z - u.z;
      if (dx * dx + dz * dz <= INTERACT_REACH_M * INTERACT_REACH_M) {
        deps.resources.wood += u.carrying.wood;
        deps.resources.metals += u.carrying.metals;
        u.carrying.wood = 0;
        u.carrying.metals = 0;
        u.task = { kind: 'idle' };
        return;
      }
      if (u.path.length === 0) deps.routeWorker(u, dpos.x, dpos.y, dpos.z);
      return;
    }
  }
}

/**
 * Pick the next task for an idle harvester. The board is checked first so
 * player-issued plant orders and ripe farms (auto-published) get picked up
 * before any local scan-for-trees work. If the board has nothing for us,
 * fall back to scanning for the nearest exposed metal or wood voxel within
 * `SCAN_RADIUS_M`.
 */
function assignNextHarvestTask(u: Unit, deps: WorkerDeps): void {
  const order = deps.taskBoard.claim(u.id, isHarvesterOrder);
  if (order) {
    u.claimedOrderId = order.id;
    applyOrderToHarvester(u, order, deps);
    return;
  }
  // No board work — fall back to the local voxel scan. Ore beats wood
  // because metal is the rarer resource in the early economy.
  const ore = findNearestExposed(deps.world.buffers.voxels, u.x, u.y, u.z, M_METAL);
  if (ore) {
    u.task = {
      kind: 'mine',
      wx: (ore.vx + 0.5) * VOXEL_SIZE,
      wy: (ore.vy + 0.5) * VOXEL_SIZE,
      wz: (ore.vz + 0.5) * VOXEL_SIZE,
    };
    deps.routeWorker(u, u.task.wx, u.task.wy, u.task.wz);
    return;
  }
  const wood = findNearestExposed(deps.world.buffers.voxels, u.x, u.y, u.z, M_WOOD);
  if (wood) {
    u.task = {
      kind: 'chop',
      wx: (wood.vx + 0.5) * VOXEL_SIZE,
      wy: (wood.vy + 0.5) * VOXEL_SIZE,
      wz: (wood.vz + 0.5) * VOXEL_SIZE,
    };
    deps.routeWorker(u, u.task.wx, u.task.wy, u.task.wz);
  }
}

/** Order kinds a harvester is willing to take from the board. */
function isHarvesterOrder(o: WorkOrder): boolean {
  return o.kind === 'plant' || o.kind === 'farmTend' || o.kind === 'harvestFarm';
}

/**
 * Translate a freshly-claimed `WorkOrder` into the matching per-worker
 * task and kick a route. Keeps the harvester switch happy with the same
 * task shape the rest of the file already understands.
 */
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

/** Drop the unit's claimed order from the board (if any). */
function completeClaimedOrder(u: Unit, deps: WorkerDeps): void {
  if (u.claimedOrderId === 0) return;
  deps.taskBoard.remove(u.claimedOrderId);
  u.claimedOrderId = 0;
}

/** Release the unit's claim on its order back to the pool, but leave the
 *  order on the board so another worker can pick it up. */
function releaseClaimedOrder(u: Unit, deps: WorkerDeps): void {
  if (u.claimedOrderId === 0) return;
  const o = deps.taskBoard.byId(u.claimedOrderId);
  if (o && o.claimedBy === u.id) o.claimedBy = 0;
  u.claimedOrderId = 0;
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
  const y0 = Math.max(0, cy - radiusVoxels);
  const z0 = Math.max(0, cz - radiusVoxels);
  const x1 = Math.min(WORLD_X - 1, cx + radiusVoxels);
  const y1 = Math.min(WORLD_Y - 1, cy + radiusVoxels);
  const z1 = Math.min(WORLD_Z - 1, cz + radiusVoxels);

  let best: VoxelHit | null = null;
  let bestD2 = Infinity;
  const STRIDE = 2;
  const reachM2 = SCAN_R2 / (VOXEL_SIZE * VOXEL_SIZE);

  for (let y = y0; y <= y1; y += STRIDE) {
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

export { findNearestExposed, isExposed };
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
