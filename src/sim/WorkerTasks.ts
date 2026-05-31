/**
 * Global queue of pending work for worker units.
 *
 * Each `WorkOrder` represents a discrete job that any free worker can claim,
 * work on, and complete. The board is the single source of truth for what
 * economy work the player has on the agenda — the UI reads it to draw the
 * right-side task list, the workers read it to pick up jobs without all
 * racing the same target, and stall recovery in `tickWorkers` releases an
 * order back to the board if the assigned worker gets stuck so somebody
 * else can pick it up.
 *
 * What lives on the board:
 *   - `plant`        — player-issued plant order at an XZ.
 *   - `farmTend`     — player-assigned farmer for a specific farm building.
 *   - `harvestFarm`  — auto-published when a farm's crop ripens.
 *
 * What does NOT live here: chop / mine voxel work. Harvesters scan the
 * world directly when no board order is available, because there are far
 * too many candidate voxels to enumerate up front. Their currently-targeted
 * voxel still surfaces in the right-side panel via the per-worker task
 * field, but it isn't a board entry.
 *
 * Orders carry a monotonically-increasing `seq` so the panel can render them
 * in the order they were added (i.e. the order they'll be picked up by free
 * workers). Within the same seq bucket the natural array order wins.
 */

import { Building, BuildingManager } from './Buildings';

export type WorkOrderKind = 'plant' | 'farmTend' | 'harvestFarm';

export interface WorkOrder {
  id: number;
  kind: WorkOrderKind;
  /** Monotonic sequence — orders fire FIFO within the same priority bucket. */
  seq: number;
  /** Unit id currently working this order, or 0 when no one's claimed it. */
  claimedBy: number;
  // Per-kind targets. Only the field that matches `kind` is populated.
  /** plant: world-meters XZ where the sapling should go. */
  wx?: number;
  wz?: number;
  /** farmTend / harvestFarm: building id of the farm. */
  buildingId?: number;
}

/**
 * Priority bucket per order kind. Lower number = picked first. Plant orders
 * jump the queue because they're player-issued and time-sensitive. Among
 * farm orders, harvesting beats tending: ripe crops sit on the field rotting
 * unless someone hauls them in, while a tend stall just delays the next
 * milestone — easier to recover from.
 */
const PRIORITY: Record<WorkOrderKind, number> = {
  plant: 0,
  harvestFarm: 1,
  farmTend: 2,
};

export class WorkerTaskBoard {
  readonly orders: WorkOrder[] = [];
  private nextId = 1;
  private nextSeq = 1;

  /**
   * Add a `plant` order. Returns the new order id.
   *
   * Note: callers are expected to dedupe (e.g. don't push two plant orders
   * for the same XZ); the board itself doesn't gate on duplicates because a
   * second order at the same target is occasionally legitimate (e.g. the
   * first sapling failed and the player wants to try again).
   */
  addPlant(wx: number, wz: number): WorkOrder {
    const o: WorkOrder = {
      id: this.nextId++, kind: 'plant', seq: this.nextSeq++,
      claimedBy: 0, wx, wz,
    };
    this.orders.push(o);
    return o;
  }

  /**
   * Add a `farmTend` order. If an order already exists for this farm we
   * return the existing one rather than stack duplicates — only one farmer
   * is ever needed per farm.
   */
  addFarmTend(buildingId: number): WorkOrder {
    const existing = this.orders.find(o => o.kind === 'farmTend' && o.buildingId === buildingId);
    if (existing) return existing;
    const o: WorkOrder = {
      id: this.nextId++, kind: 'farmTend', seq: this.nextSeq++,
      claimedBy: 0, buildingId,
    };
    this.orders.push(o);
    return o;
  }

  /**
   * Auto-publish helper run from `tickWorkers`. Walks `buildings` and
   * ensures the board has exactly one `harvestFarm` order per ripe farm.
   * Cleans up stale entries whose targets disappeared.
   */
  syncAutoOrders(buildings: BuildingManager): void {
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i]!;
      if (o.kind === 'harvestFarm') {
        const b = buildings.byId(o.buildingId!);
        if (!b || b.destroyed || !b.cropReady) {
          this.orders.splice(i, 1);
          continue;
        }
      }
      if (o.kind === 'farmTend') {
        const b = buildings.byId(o.buildingId!);
        if (!b || b.destroyed || b.spec.kind !== 'farm') {
          this.orders.splice(i, 1);
          continue;
        }
      }
    }
    // Add a harvestFarm order for any newly-ripe farm.
    for (const b of buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'farm') continue;
      if (!b.cropReady) continue;
      if (this.orders.some(o => o.kind === 'harvestFarm' && o.buildingId === b.id)) continue;
      this.orders.push({
        id: this.nextId++, kind: 'harvestFarm', seq: this.nextSeq++,
        claimedBy: b.harvesterClaimId ?? 0, buildingId: b.id,
      });
    }
    // Add a farmTend order for any non-ripe farm that currently has NO farmer
    // standing on it (`farmerId` null). The crop only grows while a farmer
    // tends it, so an untended farm needs one dispatched. The order is claimed
    // by a farm-focus worker who routes to the plot and sticks there; it's
    // dropped below once the farmer actually arrives (farmerId set) or the
    // crop ripens.
    for (const b of buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'farm') continue;
      if (b.cropReady) continue;
      if (b.farmerId !== null) continue; // already tended
      if (this.orders.some(o => o.kind === 'farmTend' && o.buildingId === b.id)) continue;
      this.orders.push({
        id: this.nextId++, kind: 'farmTend', seq: this.nextSeq++,
        claimedBy: 0, buildingId: b.id,
      });
    }
    // Drop a farmTend order once its farm is tended (a farmer arrived) or ripe.
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i]!;
      if (o.kind !== 'farmTend') continue;
      const b = buildings.byId(o.buildingId!);
      if (!b || b.cropReady || b.farmerId !== null) {
        this.orders.splice(i, 1);
      }
    }
  }

  /**
   * Pick the highest-priority unclaimed order for which `accept` returns
   * true, claim it for `unitId`, and return it. Returns null when nothing
   * suitable is available.
   */
  claim(unitId: number, accept: (o: WorkOrder) => boolean): WorkOrder | null {
    let best: WorkOrder | null = null;
    let bestRank = Infinity;
    for (const o of this.orders) {
      if (o.claimedBy !== 0) continue;
      if (!accept(o)) continue;
      // Composite rank: priority bucket dominates, seq breaks ties (FIFO).
      const rank = PRIORITY[o.kind] * 1e9 + o.seq;
      if (rank < bestRank) { bestRank = rank; best = o; }
    }
    if (!best) return null;
    best.claimedBy = unitId;
    return best;
  }

  /**
   * Drop any orders this unit had claimed (reset claimedBy to 0). Called when
   * a worker dies, switches role, or stalls out — so somebody else can pick
   * the order up. Does NOT remove the order; only releases it.
   */
  releaseAllClaimsBy(unitId: number): void {
    for (const o of this.orders) if (o.claimedBy === unitId) o.claimedBy = 0;
  }

  /** Look up an order by id. */
  byId(id: number): WorkOrder | null {
    for (const o of this.orders) if (o.id === id) return o;
    return null;
  }

  /** Remove an order by id (called when the work completes). */
  remove(id: number): void {
    for (let i = 0; i < this.orders.length; i++) {
      if (this.orders[i]!.id === id) {
        this.orders.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Snapshot of orders in execution order (claimed first, then unclaimed by
   * priority + seq). Used by the right-side panel UI; safe to iterate even
   * while orders mutate next tick because it's a fresh array.
   */
  snapshot(): WorkOrder[] {
    const arr = this.orders.slice();
    arr.sort((a, b) => {
      // Claimed orders surface first so the player sees what's actively
      // being executed at the top of the list.
      const ca = a.claimedBy !== 0 ? 0 : 1;
      const cb = b.claimedBy !== 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const pa = PRIORITY[a.kind], pb = PRIORITY[b.kind];
      if (pa !== pb) return pa - pb;
      return a.seq - b.seq;
    });
    return arr;
  }
}

/**
 * Pretty-print an order for the right-side UI panel. Resolves farm
 * references through the supplied manager so the line reads naturally
 * ("Tend farm #3" instead of just "farmTend #7"). Falls back to a minimal
 * label when the target has been despawned mid-frame.
 */
export function describeOrder(
  o: WorkOrder,
  buildings: BuildingManager,
): string {
  switch (o.kind) {
    case 'plant':
      return `Plant @ (${o.wx!.toFixed(0)}, ${o.wz!.toFixed(0)})`;
    case 'farmTend': {
      const b = buildings.byId(o.buildingId!);
      return b ? `Tend farm #${b.id}` : `Tend farm`;
    }
    case 'harvestFarm': {
      const b = buildings.byId(o.buildingId!);
      return b ? `Harvest farm #${b.id}` : `Harvest farm`;
    }
  }
}

// Re-export Building so call-sites don't need to import them just for the type.
export type { Building };
