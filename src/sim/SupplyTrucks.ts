import { Unit, UnitManager } from './Units';
import { Resources } from './Resources';
import { BuildingManager, Building, doorWorldPos, buildingApproachCandidates, buildingBoxDistM, UNIT_TRAIN_COST } from './Buildings';

export const TRUCK_CAPACITY = 100; // max materials per truck

const INTERACT_REACH_M = 4.0;

// Only attempt dispatch at most this often (seconds) to avoid hammering every frame.
const DISPATCH_INTERVAL = 2.0;

// How long (seconds) before a destroyed truck is rebuilt at the HQ.
export const TRUCK_REBUILD_SECS = 15.0;

// Throttle console logs to once every LOG_INTERVAL game-seconds.
const LOG_INTERVAL = 3.0;
let logTimer = 0;

// Maps a dispatched truck's unit ID → HQ building ID that sent it.
// Used to detect combat kills (truck removed from units array without
// going through the normal completion / despawn path).
const activeTruckToHQ = new Map<number, number>();

// Per-HQ rebuild countdowns (seconds remaining). When one reaches 0
// the slot is freed so the dispatch system can send a replacement.
const truckRebuildQueues = new Map<number, number[]>();

// How long (seconds) a truck with an empty path waits before retrying routing.
const REPATH_RETRY_SECS = 2.0;
// Per-truck countdown until next repath retry (only set when path is empty).
const truckRepathTimer = new Map<number, number>();

export interface SupplyTruckDeps {
  units: UnitManager;
  buildings: BuildingManager;
  resources: Resources;
  spawnTruck: (x: number, y: number, z: number) => Unit | null;
  routeTruck: (u: Unit, wx: number, wy: number, wz: number) => void;
  /** Returns true if a supply truck can stand at world (x, z) — nav cell unblocked within truck footprint. */
  isPassable: (x: number, z: number) => boolean;
}

let dispatchTimer = 0;

/** Pick the nearest passable approach point on `b`'s perimeter from `(fromX, fromZ)`. */
function pickApproach(b: Building, fromX: number, fromZ: number, deps: SupplyTruckDeps) {
  const candidates = buildingApproachCandidates(b, fromX, fromZ);
  for (const c of candidates) {
    if (deps.isPassable(c.x, c.z)) return c;
  }
  return candidates[0]!; // unconditional fallback — pathfinder will handle it
}

export function tickSupplyTrucks(dt: number, deps: SupplyTruckDeps): void {
  reconcileCombatKills(deps);
  tickRebuildQueues(dt, deps);
  tickActiveTrucks(deps, dt);

  dispatchTimer -= dt;
  if (dispatchTimer > 0) return;
  dispatchTimer = DISPATCH_INTERVAL;

  dispatchStorageTrucks(deps);
  dispatchResupplyTrucks(deps);
}

/**
 * Detect trucks that were killed by combat this frame (removed from the
 * units array by removeDeadUnits before tickSupplyTrucks runs, so their
 * activeTrucks slot was never freed). Queue a rebuild for each.
 */
function reconcileCombatKills(deps: SupplyTruckDeps): void {
  if (activeTruckToHQ.size === 0) return;
  const alive = new Set(deps.units.units.map(u => u.id));
  for (const [truckId, hqId] of activeTruckToHQ) {
    if (alive.has(truckId)) continue;
    // Truck is gone from the array but wasn't despawned via normal path.
    activeTruckToHQ.delete(truckId);
    truckRepathTimer.delete(truckId);
    const hq = deps.buildings.buildings.find(b => b.id === hqId);
    if (!hq || hq.destroyed) continue;
    hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
    const queue = truckRebuildQueues.get(hqId) ?? [];
    queue.push(TRUCK_REBUILD_SECS);
    truckRebuildQueues.set(hqId, queue);
    console.log(`[REBUILD] Truck #${truckId} destroyed — rebuilding in ${TRUCK_REBUILD_SECS}s at HQ#${hqId}`);
  }
}

/**
 * Tick rebuild timers. When one expires the slot is fully freed so the
 * dispatch system will send a fresh truck on the next dispatch interval.
 */
function tickRebuildQueues(dt: number, deps: SupplyTruckDeps): void {
  for (const [hqId, timers] of truckRebuildQueues) {
    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i]! -= dt;
      if (timers[i]! <= 0) {
        timers.splice(i, 1);
        const hq = deps.buildings.buildings.find(b => b.id === hqId);
        console.log(`[REBUILD] Truck rebuild complete at HQ#${hqId} — slot freed`);
        // activeTrucks was already decremented when the kill was detected;
        // the freed slot is picked up naturally by dispatchStorageTrucks.
        void hq; // referenced for logging; dispatch uses activeTrucks directly
      }
    }
    if (timers.length === 0) truckRebuildQueues.delete(hqId);
  }
}

/** Advance all active supply_truck units through their task state machine. */
function tickActiveTrucks(deps: SupplyTruckDeps, dt: number): void {
  logTimer -= dt;
  const doLog = logTimer <= 0;
  if (doLog) logTimer = LOG_INTERVAL;

  for (const u of deps.units.units) {
    if (u.kind !== 'supply_truck') continue;
    if (u.hp <= 0) continue;
    const task = u.task;

    if (doLog) {
      let distInfo = '';
      if (task.kind === 'truck_fetch') {
        const s = deps.buildings.buildings.find(b => b.id === task.storageId);
        if (s) distInfo = ` dist_to_storage=${buildingBoxDistM(u.x, u.z, s).toFixed(1)}m`;
      } else if (task.kind === 'truck_deliver_hq' || task.kind === 'truck_return') {
        const hq = deps.buildings.nearestHQ(u.x, u.z);
        if (hq) { const d = doorWorldPos(hq); distInfo = ` dist_to_hq=${Math.sqrt((u.x-d.x)**2+(u.z-d.z)**2).toFixed(1)}m`; }
      } else if (task.kind === 'truck_resupply') {
        const b = deps.buildings.buildings.find(b => b.id === task.buildingId);
        if (b) distInfo = ` dist_to_bldg=${buildingBoxDistM(u.x, u.z, b).toFixed(1)}m`;
      }
      console.log(`[TRUCK #${u.id}] task=${task.kind} pos=(${u.x.toFixed(1)},${u.z.toFixed(1)}) path=${u.path.length} waypoints${distInfo}`);
    }

    if (task.kind === 'truck_fetch') {
      const storage = deps.buildings.buildings.find(b => b.id === task.storageId);
      if (!storage || storage.destroyed) { despawn(u, deps); continue; }
      if (buildingBoxDistM(u.x, u.z, storage) <= INTERACT_REACH_M) {
        // Pick up only the pre-allocated portion (capped to what's still there).
        const payload = {
          metals: Math.min(task.payload.metals, storage.stockpile.metals),
          wood:   Math.min(task.payload.wood,   storage.stockpile.wood),
        };
        storage.stockpile.metals -= payload.metals;
        storage.stockpile.wood   -= payload.wood;
        console.log(`[TRUCK #${u.id}] PICKUP from storage#${storage.id}: metals=${payload.metals} wood=${payload.wood}`);
        storage.supplyInbound = false;
        const hq = deps.buildings.nearestHQ(u.x, u.z);
        if (!hq) { despawn(u, deps); continue; }
        u.task = { kind: 'truck_deliver_hq', payload };
        u.path = [];
        truckRepathTimer.delete(u.id);
        const hqPos = doorWorldPos(hq);
        deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const sPos = pickApproach(storage, u.x, u.z, deps);
          deps.routeTruck(u, sPos.x, sPos.y, sPos.z);
        });
      }
    } else if (task.kind === 'truck_deliver_hq') {
      const hq = deps.buildings.nearestHQ(u.x, u.z);
      if (!hq || hq.destroyed) { despawn(u, deps); continue; }
      const hqPos = doorWorldPos(hq);
      const dxHq = u.x - hqPos.x, dzHq = u.z - hqPos.z;
      if (dxHq * dxHq + dzHq * dzHq <= INTERACT_REACH_M * INTERACT_REACH_M) {
        console.log(`[TRUCK #${u.id}] DELIVER to HQ: metals=${task.payload.metals} wood=${task.payload.wood}`);
        deps.resources.metals += task.payload.metals;
        deps.resources.wood += task.payload.wood;
        hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        activeTruckToHQ.delete(u.id);
        u.hp = 0;
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
        });
      }
    } else if (task.kind === 'truck_resupply') {
      const target = deps.buildings.buildings.find(b => b.id === task.buildingId);
      if (!target || target.destroyed) {
        deps.resources.food += task.payload.food;
        deps.resources.metals += task.payload.metals;
        deps.resources.wood += task.payload.wood;
        despawn(u, deps);
        continue;
      }
      if (buildingBoxDistM(u.x, u.z, target) <= INTERACT_REACH_M) {
        console.log(`[TRUCK #${u.id}] RESUPPLY delivered to ${target.spec.kind}#${target.id}`);
        target.supplyInbound = false;
        target.supplyDelivered = true;
        const hq = deps.buildings.nearestHQ(u.x, u.z);
        if (!hq) { despawn(u, deps); continue; }
        u.task = { kind: 'truck_return' };
        u.path = [];
        truckRepathTimer.delete(u.id);
        const hqPos = doorWorldPos(hq);
        deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const bPos = pickApproach(target, u.x, u.z, deps);
          deps.routeTruck(u, bPos.x, bPos.y, bPos.z);
        });
      }
    } else if (task.kind === 'truck_return') {
      const hq = deps.buildings.nearestHQ(u.x, u.z);
      if (!hq || hq.destroyed) { despawn(u, deps); continue; }
      const hqPos = doorWorldPos(hq);
      const dxHq = u.x - hqPos.x, dzHq = u.z - hqPos.z;
      if (dxHq * dxHq + dzHq * dzHq <= INTERACT_REACH_M * INTERACT_REACH_M) {
        console.log(`[TRUCK #${u.id}] RETURNED to HQ, despawning`);
        hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        activeTruckToHQ.delete(u.id);
        u.hp = 0;
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
        });
      }
    }
  }
}

/** Retry routing for a truck that has no path. Throttled to REPATH_RETRY_SECS. */
function retryRoute(u: { id: number }, _deps: SupplyTruckDeps, dt: number, doRoute: () => void): void {
  const remaining = (truckRepathTimer.get(u.id) ?? REPATH_RETRY_SECS) - dt;
  if (remaining <= 0) {
    truckRepathTimer.set(u.id, REPATH_RETRY_SECS);
    doRoute();
  } else {
    truckRepathTimer.set(u.id, remaining);
  }
}

/** Dispatch trucks from HQ to storage buildings that have stockpile > 0.
 *  Sends Math.ceil(amount / TRUCK_CAPACITY) trucks, each carrying up to
 *  TRUCK_CAPACITY materials. */
function dispatchStorageTrucks(deps: SupplyTruckDeps): void {
  const hqs = deps.buildings.buildings.filter(b => !b.destroyed && b.spec.kind === 'hq');

  for (const hq of hqs) {
    const maxTrucks = hq.spec.maxTrucks ?? 5;
    const hqPos = doorWorldPos(hq);

    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'storage') continue;
      if (b.supplyInbound) continue;
      const amount = b.stockpile.metals + b.stockpile.wood;
      if (amount < b.truckCallThreshold) continue;

      const trucksNeeded = Math.ceil(amount / TRUCK_CAPACITY);
      // Fraction of stockpile each truck should carry (split proportionally).
      const ratio = b.stockpile.metals / (b.stockpile.metals + b.stockpile.wood || 1);

      let dispatched = 0;
      let remainMetals = b.stockpile.metals;
      let remainWood   = b.stockpile.wood;

      for (let t = 0; t < trucksNeeded; t++) {
        if (hq.activeTrucks >= maxTrucks) break;
        const cargoMetals = Math.min(Math.round(TRUCK_CAPACITY * ratio), remainMetals);
        const cargoWood   = Math.min(TRUCK_CAPACITY - cargoMetals, remainWood);
        if (cargoMetals + cargoWood === 0) break;

        const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z);
        if (!truck) break;

        hq.activeTrucks++;
        remainMetals -= cargoMetals;
        remainWood   -= cargoWood;

        truck.task = {
          kind: 'truck_fetch',
          storageId: b.id,
          payload: { metals: cargoMetals, wood: cargoWood },
        };
        activeTruckToHQ.set(truck.id, hq.id);
        const sPos = pickApproach(b, hqPos.x, hqPos.z, deps);
        console.log(`[DISPATCH] STORAGE truck #${truck.id} → storage#${b.id} cargo=(m=${cargoMetals} w=${cargoWood})`);
        deps.routeTruck(truck, sPos.x, sPos.y, sPos.z);
        dispatched++;
      }

      if (dispatched > 0) b.supplyInbound = true;
      else {
        console.log(`[DISPATCH] No storage ready (threshold check). Storages: ${
          deps.buildings.buildings.filter(s => s.spec.kind === 'storage' && !s.destroyed)
            .map(s => `#${s.id}[metals=${s.stockpile.metals} wood=${s.stockpile.wood} inbound=${s.supplyInbound} threshold=${s.truckCallThreshold}]`).join(', ') || 'none'
        }`);
      }
    }
  }
}

/** Dispatch trucks from HQ to production buildings that need materials. */
function dispatchResupplyTrucks(deps: SupplyTruckDeps): void {
  const hqs = deps.buildings.buildings.filter(b => !b.destroyed && b.spec.kind === 'hq');

  for (const hq of hqs) {
    const maxTrucks = hq.spec.maxTrucks ?? 5;
    const hqPos = doorWorldPos(hq);

    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.produces.length === 0) continue;
      if (b.trainQueue.length === 0) continue;
      if (b.productionTimer > 0) continue;
      if (b.supplyInbound || b.supplyDelivered) continue;
      if (hq.activeTrucks >= maxTrucks) break;

      const kind = b.trainQueue[0]!;
      const cost = UNIT_TRAIN_COST[kind];

      // Check if HQ has enough resources
      if (deps.resources.food < cost.food) continue;
      if (deps.resources.metals < cost.metals) continue;
      if (deps.resources.wood < cost.wood) continue;

      // Deduct resources immediately (reserved by this truck)
      deps.resources.food -= cost.food;
      deps.resources.metals -= cost.metals;
      deps.resources.wood -= cost.wood;

      b.supplyInbound = true;
      hq.activeTrucks++;

      console.log(`[DISPATCH] RESUPPLY truck: HQ#${hq.id} → ${b.spec.kind}#${b.id} for ${kind} (food=${cost.food} metals=${cost.metals} wood=${cost.wood})`);
      const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z);
      if (!truck) {
        // Refund and reset
        deps.resources.food += cost.food;
        deps.resources.metals += cost.metals;
        deps.resources.wood += cost.wood;
        b.supplyInbound = false;
        hq.activeTrucks--;
        continue;
      }

      truck.task = {
        kind: 'truck_resupply',
        buildingId: b.id,
        payload: { food: cost.food, metals: cost.metals, wood: cost.wood },
      };
      activeTruckToHQ.set(truck.id, hq.id);
      const bPos = pickApproach(b, hqPos.x, hqPos.z, deps);
      deps.routeTruck(truck, bPos.x, bPos.y, bPos.z);
    }
  }
}

function despawn(u: Unit, deps: SupplyTruckDeps): void {
  const hq = deps.buildings.nearestHQ(u.x, u.z);
  if (hq) hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
  activeTruckToHQ.delete(u.id); // normal despawn — no rebuild
  truckRepathTimer.delete(u.id);
  u.hp = 0;
}

