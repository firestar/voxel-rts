import { Unit, UnitManager } from './Units';
import { Resources } from './Resources';
import { BuildingManager, Building, doorWorldPos, UNIT_TRAIN_COST } from './Buildings';

const INTERACT_REACH_M = 4.0;
const INTERACT_REACH_M2 = INTERACT_REACH_M * INTERACT_REACH_M;

// Only attempt dispatch at most this often (seconds) to avoid hammering every frame.
const DISPATCH_INTERVAL = 2.0;

export interface SupplyTruckDeps {
  units: UnitManager;
  buildings: BuildingManager;
  resources: Resources;
  spawnTruck: (x: number, y: number, z: number) => Unit | null;
  routeTruck: (u: Unit, wx: number, wy: number, wz: number) => void;
}

let dispatchTimer = 0;

export function tickSupplyTrucks(dt: number, deps: SupplyTruckDeps): void {
  tickActiveTrucks(deps);

  dispatchTimer -= dt;
  if (dispatchTimer > 0) return;
  dispatchTimer = DISPATCH_INTERVAL;

  dispatchStorageTrucks(deps);
  dispatchResupplyTrucks(deps);
}

/** Advance all active supply_truck units through their task state machine. */
function tickActiveTrucks(deps: SupplyTruckDeps): void {
  for (const u of deps.units.units) {
    if (u.kind !== 'supply_truck') continue;
    const task = u.task;

    if (task.kind === 'truck_fetch') {
      const storage = deps.buildings.buildings.find(b => b.id === task.storageId);
      if (!storage || storage.destroyed) { despawn(u, deps); continue; }
      const dpos = doorWorldPos(storage);
      if (dist2(u.x, u.z, dpos.x, dpos.z) <= INTERACT_REACH_M2) {
        const payload = { metals: storage.stockpile.metals, wood: storage.stockpile.wood };
        storage.stockpile.metals = 0;
        storage.stockpile.wood = 0;
        storage.supplyInbound = false;
        const hq = deps.buildings.nearestHQ(u.x, u.z);
        if (!hq) { despawn(u, deps); continue; }
        u.task = { kind: 'truck_deliver_hq', payload };
        u.path = [];
        const hqPos = doorWorldPos(hq);
        deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
      }
    } else if (task.kind === 'truck_deliver_hq') {
      const hq = deps.buildings.nearestHQ(u.x, u.z);
      if (!hq || hq.destroyed) { despawn(u, deps); continue; }
      const hqPos = doorWorldPos(hq);
      if (dist2(u.x, u.z, hqPos.x, hqPos.z) <= INTERACT_REACH_M2) {
        deps.resources.metals += task.payload.metals;
        deps.resources.wood += task.payload.wood;
        hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        u.hp = 0;
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
      const dpos = doorWorldPos(target);
      if (dist2(u.x, u.z, dpos.x, dpos.z) <= INTERACT_REACH_M2) {
        target.supplyInbound = false;
        target.supplyDelivered = true;
        const hq = deps.buildings.nearestHQ(u.x, u.z);
        if (!hq) { despawn(u, deps); continue; }
        u.task = { kind: 'truck_return' };
        u.path = [];
        const hqPos = doorWorldPos(hq);
        deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
      }
    } else if (task.kind === 'truck_return') {
      const hq = deps.buildings.nearestHQ(u.x, u.z);
      if (!hq || hq.destroyed) { despawn(u, deps); continue; }
      const hqPos = doorWorldPos(hq);
      if (dist2(u.x, u.z, hqPos.x, hqPos.z) <= INTERACT_REACH_M2) {
        hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        u.hp = 0;
      }
    }
  }
}

/** Dispatch trucks from HQ to storage buildings that have stockpile > 0. */
function dispatchStorageTrucks(deps: SupplyTruckDeps): void {
  const hqs = deps.buildings.buildings.filter(b => !b.destroyed && b.spec.kind === 'hq');

  for (const hq of hqs) {
    const maxTrucks = hq.spec.maxTrucks ?? 5;
    if (hq.activeTrucks >= maxTrucks) continue;

    const hqPos = doorWorldPos(hq);
    // Find storage with the most stockpile that doesn't have a truck already coming
    let bestStorage: Building | null = null;
    let bestAmount = 0;
    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'storage') continue;
      if (b.supplyInbound) continue;
      const amount = b.stockpile.metals + b.stockpile.wood;
      if (amount > bestAmount) { bestAmount = amount; bestStorage = b; }
    }
    if (!bestStorage || bestAmount === 0) continue;

    bestStorage.supplyInbound = true;
    hq.activeTrucks++;

    const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z);
    if (!truck) { bestStorage.supplyInbound = false; hq.activeTrucks--; continue; }

    truck.task = { kind: 'truck_fetch', storageId: bestStorage.id };
    const sPos = doorWorldPos(bestStorage);
    deps.routeTruck(truck, sPos.x, sPos.y, sPos.z);
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
      const bPos = doorWorldPos(b);
      deps.routeTruck(truck, bPos.x, bPos.y, bPos.z);
    }
  }
}

function despawn(u: Unit, deps: SupplyTruckDeps): void {
  // Decrement activeTrucks on the nearest HQ
  const hq = deps.buildings.nearestHQ(u.x, u.z);
  if (hq) hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
  u.hp = 0;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return (ax - bx) ** 2 + (az - bz) ** 2;
}
