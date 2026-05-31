import { Unit, UnitManager } from './Units';
import { Resources } from './Resources';
import { BuildingManager, Building, BuildingTeam, doorWorldPos, buildingApproachCandidates, buildingBoxDistM, UNIT_TRAIN_COST } from './Buildings';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';

export const TRUCK_CAPACITY = 100; // max materials per truck

// How close the truck must be to a building's expanded approach box (4-voxel
// halo) for delivery to trigger. With a 3-cell-wide chassis, the truck's
// last reachable cell sits ~2 m from the box edge (footprint halo + safety
// for the path planner pulling the goal to nearestPassable). 3.0 m is loose
// enough that the truck always triggers at its geometric stopping point but
// still small relative to the building footprint so it can't deliver from
// across the map.
const INTERACT_REACH_M = 3.0;

// Only attempt dispatch at most this often (seconds) to avoid hammering every
// frame. Per-HQ launch staggering (HQ_LAUNCH_GAP_S) is the real spacing gate;
// keep the dispatch tick brisk so a freed HQ launches its next truck quickly
// once the previous one has cleared the spawn corridor.
const DISPATCH_INTERVAL = 0.5;

// How long (seconds) before a destroyed truck is rebuilt at the HQ.
export const TRUCK_REBUILD_SECS = 15.0;

// Throttle console logs to once every LOG_INTERVAL game-seconds.
const LOG_INTERVAL = 3.0;
let logTimer = 0;

// Maps a dispatched truck's unit ID → HQ building ID that sent it.
// Used to detect combat kills (truck removed from units array without
// going through the normal completion / despawn path).
const activeTruckToHQ = new Map<number, number>();

/** In-flight resupply trucks: payload + target building so a combat kill
 *  can refund the reserved resources and decrement target.inboundResupplyTrucks
 *  rather than locking up the queue with phantom in-flight supplies. */
const activeResupply = new Map<number, { targetId: number; payload: { food: number; metals: number; wood: number } }>();

/** In-flight fetch trucks: storage id so a combat kill can clear the
 *  storage's `supplyInbound` flag and let the dispatcher try again. */
const activeFetch = new Map<number, number>();

/** In-flight UPGRADE-DELIVERY trucks: target building + cargo so a combat
 *  kill can decrement `target.inboundUpgradeTrucks` (otherwise the building
 *  believes a truck is forever inbound and the dispatcher — gated on
 *  `inboundUpgradeTrucks > 0` — never sends a replacement, so the upgrade /
 *  initial build stalls at hp 0 for the rest of the match) and refund the
 *  reserved cargo to the team pool. Mirrors `activeResupply`. Only the
 *  `truck_deliver_upgrade` task is tracked here; `truck_recover_upgrade`
 *  (cancelled-upgrade reclaim) keeps its existing handling untouched. */
const activeUpgrade = new Map<number, { targetId: number; payload: { metals: number; wood: number } }>();

// Per-HQ rebuild countdowns (seconds remaining). When one reaches 0
// the slot is freed so the dispatch system can send a replacement.
const truckRebuildQueues = new Map<number, number[]>();

// How long (seconds) a truck with an empty path waits before retrying routing.
const REPATH_RETRY_SECS = 2.0;
// Per-truck countdown until next repath retry (only set when path is empty).
const truckRepathTimer = new Map<number, number>();

// Minimum seconds between successive truck spawns from the same HQ. When 5
// resupply trucks spawn back-to-back at the same door they cluster up, deflect
// each other, and orbit the spawn pad instead of pulling away cleanly. A 1.5 s
// gap gives the previous truck enough head start (~12 m at 8 m/s) to clear the
// approach corridor before the next one launches.
const HQ_LAUNCH_GAP_S = 1.5;

type HqSide = 'east' | 'west' | 'north' | 'south';
interface HqGateCooldowns { east: number; west: number; north: number; south: number; }

/**
 * Per-HQ, per-cardinal-gate launch cooldown. Trucks heading to different
 * sides of the HQ can spawn simultaneously, but two trucks bound for the
 * same side still have to wait `HQ_LAUNCH_GAP_S` between launches so they
 * don't pile up at the same door.
 */
const hqLaunchCooldown = new Map<number, HqGateCooldowns>();

function getHqCooldowns(hqId: number): HqGateCooldowns {
  let c = hqLaunchCooldown.get(hqId);
  if (!c) {
    c = { east: 0, west: 0, north: 0, south: 0 };
    hqLaunchCooldown.set(hqId, c);
  }
  return c;
}

/**
 * Resolve which cardinal face of `hq` is closest to a target position.
 * Mirrors the side selection in `doorWorldPos(hq, fromX, fromZ)` so the
 * cooldown gate lines up with the door the truck will actually use.
 */
function pickHqSide(hq: Building, targetX: number, targetZ: number): HqSide {
  const cx = (hq.ox + hq.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
  const cz = (hq.oz + hq.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
  const dx = targetX - cx;
  const dz = targetZ - cz;
  if (Math.abs(dx) >= Math.abs(dz)) {
    return dx >= 0 ? 'east' : 'west';
  }
  return dz >= 0 ? 'south' : 'north';
}

export interface SupplyTruckDeps {
  units: UnitManager;
  buildings: BuildingManager;
  /** Player-team resources. Truck deliveries land here unless the
   *  participating HQ / building is enemy-team and `enemyResources`
   *  is supplied. */
  resources: Resources;
  /** Per-team resource pool lookup. If absent, all teams fall back
   *  to the player `resources` (test bench). */
  resourcesForTeam?: (team: 'player' | 'enemy' | 'enemy2') => Resources;
  /** Optional enemy-team resources. Wired in production; absent in
   *  tests that only exercise the player economy. */
  enemyResources?: Resources;
  spawnTruck: (x: number, y: number, z: number, team: BuildingTeam) => Unit | null;
  routeTruck: (u: Unit, wx: number, wy: number, wz: number) => void;
  /** Returns true if a supply truck can stand at world (x, z) — nav cell unblocked within truck footprint. */
  isPassable: (x: number, z: number) => boolean;
}

/** Pick the resource pool that belongs to a given team. Falls back to
 *  the player pool when an enemy pool was never wired. */
function teamResources(deps: SupplyTruckDeps, team: BuildingTeam): Resources {
  if (deps.resourcesForTeam) return deps.resourcesForTeam(team as 'player' | 'enemy' | 'enemy2');
  // Legacy fallback: tests that don't wire the team-aware accessor.
  if (team !== 'player' && deps.enemyResources) return deps.enemyResources;
  return deps.resources;
}

/** Resolve the team that owns a given truck via the activeTruckToHQ
 *  registry. Falls back to player when the registry is missing the
 *  truck (truck spawned outside the dispatch flow). */
function truckTeam(truckId: number, deps: SupplyTruckDeps): BuildingTeam {
  const hqId = activeTruckToHQ.get(truckId);
  if (hqId === undefined) {
    // Registry miss — the truck has no recorded owning HQ. This should never
    // happen for a dispatched truck; if it does (e.g. a stale module-level map
    // carried across matches in a reused harness process), the 'player'
    // fallback would route an enemy truck to the PLAYER HQ. Log it loudly so
    // the genuine cross-team routing is visible rather than silent.
    console.warn(`[TRUCK #${truckId}] team registry MISS — falling back to 'player' (possible stale state across matches; call resetSupplyTruckState() at session start)`);
    return 'player';
  }
  const hq = deps.buildings.buildings.find(b => b.id === hqId);
  if (!hq) {
    console.warn(`[TRUCK #${truckId}] owning HQ#${hqId} not found — falling back to 'player'`);
    return 'player';
  }
  return hq.team;
}

/**
 * Clear ALL module-level supply-truck state. The dispatch registries
 * (`activeTruckToHQ`, in-flight payloads, rebuild queues, cooldowns, progress
 * trackers) live at module scope and survive across games in a reused process
 * (e.g. a multi-match harness). Without a reset, a truck id from a previous
 * match can collide with a fresh truck and corrupt team attribution / refunds.
 * Call from `Game` at game-session start.
 */
export function resetSupplyTruckState(): void {
  activeTruckToHQ.clear();
  activeResupply.clear();
  activeFetch.clear();
  activeUpgrade.clear();
  truckRebuildQueues.clear();
  truckRepathTimer.clear();
  hqLaunchCooldown.clear();
  truckProgressTrack.clear();
  dispatchTimer = 0;
  logTimer = 0;
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
  reconcileActiveTruckCount(deps);
  tickRebuildQueues(dt, deps);
  tickActiveTrucks(deps, dt);
  for (const [hqId, c] of hqLaunchCooldown) {
    c.east  = Math.max(0, c.east  - dt);
    c.west  = Math.max(0, c.west  - dt);
    c.north = Math.max(0, c.north - dt);
    c.south = Math.max(0, c.south - dt);
    if (c.east === 0 && c.west === 0 && c.north === 0 && c.south === 0) {
      hqLaunchCooldown.delete(hqId);
    }
  }

  dispatchTimer -= dt;
  if (dispatchTimer > 0) return;
  dispatchTimer = DISPATCH_INTERVAL;

  dispatchStorageTrucks(deps);
  // Construction (upgrade) BEFORE unit-production resupply. Both compete for
  // the same per-HQ truck cap (5) AND the same team metal pool, and resupply
  // runs on a tight backlog (TRAIN_INTERVAL 0.3 s), so when it dispatched
  // first it drained every truck slot + every metal before a pending building
  // could be funded. That left costly late buildings — the vehicle_depot
  // especially (70m/50w) — stuck at hp=0 / 'pending' forever, so the AI never
  // fielded tanks / anti-air / rocket trucks despite queuing them correctly
  // (iter64-67: depots placed, 0 vehicles produced). Finishing a half-built
  // structure is strictly more valuable than pumping one more soldier, and
  // each pending building self-limits its trucks via `outstanding`, so this
  // doesn't starve unit production — it just lets construction complete first.
  dispatchUpgradeTrucks(deps);
  dispatchResupplyTrucks(deps);
  dispatchUpgradeRecoveryTrucks(deps);
}

/**
 * Recompute `hq.activeTrucks` from the live truck fleet each tick. The
 * watchdog no longer despawns stalled trucks (despawn was visible as
 * "trucks randomly disappearing"), so the per-HQ counter could drift
 * upward when a truck got stuck and never reached its decrement path.
 * Counting alive trucks per HQ here is the ground truth the dispatcher
 * cap check needs.
 */
function reconcileActiveTruckCount(deps: SupplyTruckDeps): void {
  const liveByHq = new Map<number, number>();
  for (const u of deps.units.units) {
    if (u.kind !== 'supply_truck' || u.hp <= 0) continue;
    const hqId = activeTruckToHQ.get(u.id);
    if (hqId === undefined) continue;
    liveByHq.set(hqId, (liveByHq.get(hqId) ?? 0) + 1);
  }
  for (const b of deps.buildings.buildings) {
    if (b.spec.kind !== 'hq') continue;
    b.activeTrucks = liveByHq.get(b.id) ?? 0;
  }
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

    // If the truck was carrying a unit-resupply payload, refund the reserved
    // resources to the HQ and unwind the target building's pending count so
    // the dispatcher will send a replacement.
    const resupply = activeResupply.get(truckId);
    if (resupply) {
      activeResupply.delete(truckId);
      const target = deps.buildings.buildings.find(b => b.id === resupply.targetId);
      if (target && !target.destroyed) {
        target.inboundResupplyTrucks = Math.max(0, target.inboundResupplyTrucks - 1);
      }
      const team = truckTeam(truckId, deps);
      const r = teamResources(deps, team);
      r.food += resupply.payload.food;
      r.metals += resupply.payload.metals;
      r.wood += resupply.payload.wood;
    }
    // If the truck was on a storage fetch, clear the storage's inbound flag
    // so the dispatcher will retry.
    const fetchStorage = activeFetch.get(truckId);
    if (fetchStorage !== undefined) {
      activeFetch.delete(truckId);
      const storage = deps.buildings.buildings.find(b => b.id === fetchStorage);
      if (storage) storage.supplyInbound = false;
    }
    // If the truck was delivering an upgrade payload, decrement the target's
    // inbound count so the dispatcher re-sends (otherwise the building stalls
    // at hp 0 forever behind a phantom inbound truck) and refund the cargo to
    // the team pool — the reserved metals/wood were debited at dispatch.
    const upgrade = activeUpgrade.get(truckId);
    if (upgrade) {
      activeUpgrade.delete(truckId);
      const target = deps.buildings.buildings.find(b => b.id === upgrade.targetId);
      if (target && !target.destroyed) {
        target.inboundUpgradeTrucks = Math.max(0, target.inboundUpgradeTrucks - 1);
      }
      // Refund to the OWNING team's pool. Derive the team from the in-scope
      // `hqId` (the loop key) rather than `truckTeam(truckId)` — the registry
      // entry was already deleted above, so a `truckTeam` lookup here would
      // miss and mis-route an enemy truck's refund to the player pool.
      const ownerHq = deps.buildings.buildings.find(b => b.id === hqId);
      const r = teamResources(deps, ownerHq ? ownerHq.team : 'player');
      r.metals += upgrade.payload.metals;
      r.wood   += upgrade.payload.wood;
    }

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

/** Per-truck progress watchdog. Tracks two things:
 *   - sinceS: time since last meaningful XZ progress; when it exceeds
 *     TRUCK_STALL_REPATH_S we clear the path so the per-task block
 *     issues a fresh route.
 *   - taskFirstAt: wall-clock time the current task was first observed.
 *     If the task hasn't completed after TRUCK_TASK_DESPAWN_S we
 *     despawn the truck — the rebuild queue fires a replacement.
 *     Catches the "wandering but never delivering" case where each
 *     small spurt of progress resets a hit-count watchdog forever.
 *  The taskKey identifies the current task so a real task switch
 *  (deliver → return) resets the timer. */
const truckProgressTrack = new Map<number, {
  x: number; z: number; sinceS: number;
  taskKey: string; taskFirstAt: number;
}>();
// A healthy supply truck does 5 m/s. 1 m / 4 s is the "still trying"
// floor — slower means the wheeled-pivot oscillation kicks in.
const TRUCK_STALL_REPATH_S = 4.0;
const TRUCK_PROGRESS_M = 1.0;
// Per-task wall-clock budget. Way under the harness's 60 s
// truckTaskAt failure so we self-heal before the run dies.
const TRUCK_TASK_DESPAWN_S = 25.0;
// If a delivery truck can't reach its target after this much wall
// clock time, give up: refund the cargo to the team pool and head
// home. The building stays pending — the dispatcher will retry on a
// later tick. Without this, an unreachable target hangs the truck
// forever and the harness's 60 s task-stall fails the whole run.
const TRUCK_ABANDON_S = 45.0;
// A truck that's been stuck on truck_return (heading home, no cargo
// remaining) for this long is genuinely lost — wedged in a building
// footprint or against an unreachable HQ approach. Despawn it as a
// "lost in action" event so the harness's 60 s task-stall doesn't
// fail the run. The cargo was already refunded at the abandon step
// above (truck_return is reached AFTER truck_deliver_* abandons).
const TRUCK_RETURN_LOST_S = 50.0;

/** Advance all active supply_truck units through their task state machine. */
function tickActiveTrucks(deps: SupplyTruckDeps, dt: number): void {
  logTimer -= dt;
  const doLog = logTimer <= 0;
  if (doLog) logTimer = LOG_INTERVAL;

  // Sweep dead trucks from the watchdog map.
  if (truckProgressTrack.size > 0) {
    const alive = new Set(deps.units.units.filter(u => u.kind === 'supply_truck' && u.hp > 0).map(u => u.id));
    for (const id of truckProgressTrack.keys()) {
      if (!alive.has(id)) truckProgressTrack.delete(id);
    }
  }

  for (const u of deps.units.units) {
    if (u.kind !== 'supply_truck') continue;
    if (u.hp <= 0) continue;
    const task = u.task;

    // Watchdog: track progress + total time-on-task. A non-zero path
    // that isn't advancing → clear path for a fresh route. A task that
    // takes too long overall → despawn so the HQ rebuild queue tries
    // again with a fresh truck.
    {
      const taskKey = task.kind + ':' + (
        ('buildingId' in task ? task.buildingId : 0) ||
        ('storageId' in task ? task.storageId : 0) || 0
      );
      let track = truckProgressTrack.get(u.id);
      if (!track || track.taskKey !== taskKey) {
        track = { x: u.x, z: u.z, sinceS: 0, taskKey, taskFirstAt: 0 };
        truckProgressTrack.set(u.id, track);
      }
      track.taskFirstAt += dt;
      // Per-task long-stall: only log + clear path; don't despawn.
      // Despawning was visible to the player as trucks "randomly
      // disappearing" mid-route (the despawn just zeros hp without
      // an explosion or animation). Letting the truck keep
      // retrying is less surprising; the harness's task-stall
      // failure (60 s) will still flag a truly stuck task.
      if (track.taskFirstAt > TRUCK_TASK_DESPAWN_S && task.kind !== 'truck_return') {
        if (track.taskFirstAt < TRUCK_TASK_DESPAWN_S + dt + 0.001) {
          console.warn(`[TRUCK #${u.id}] watchdog: ${track.taskFirstAt.toFixed(1)}s on ${task.kind} (${taskKey}) without completing — clearing path (no despawn)`);
        }
        u.path = [];
        truckRepathTimer.delete(u.id);
        track.sinceS = 0;
        track.x = u.x;
        track.z = u.z;
      }
      // Hard abandon: a delivery task that can't complete inside the
      // harness's 60 s budget needs to refund and head home before
      // the harness fails the run. truck_fetch is similar — if the
      // storage is unreachable, the truck would hang waiting forever.
      if (track.taskFirstAt > TRUCK_ABANDON_S
          && (task.kind === 'truck_deliver_upgrade'
              || task.kind === 'truck_recover_upgrade'
              || task.kind === 'truck_resupply'
              || task.kind === 'truck_fetch')) {
        console.warn(`[TRUCK #${u.id}] abandon: ${track.taskFirstAt.toFixed(1)}s on ${task.kind} — refunding cargo and returning to HQ`);
        const team = truckTeam(u.id, deps);
        const r = teamResources(deps, team);
        if (task.kind === 'truck_deliver_upgrade' || task.kind === 'truck_recover_upgrade') {
          if ('payload' in task && task.payload) {
            r.metals += task.payload.metals ?? 0;
            r.wood   += task.payload.wood   ?? 0;
          }
          const target = deps.buildings.buildings.find(b => b.id === task.buildingId);
          if (target) target.inboundUpgradeTrucks = Math.max(0, target.inboundUpgradeTrucks - 1);
          activeUpgrade.delete(u.id);
        } else if (task.kind === 'truck_resupply') {
          r.food   += task.payload.food   ?? 0;
          r.metals += task.payload.metals ?? 0;
          r.wood   += task.payload.wood   ?? 0;
          const target = deps.buildings.buildings.find(b => b.id === task.buildingId);
          if (target) target.inboundResupplyTrucks = Math.max(0, target.inboundResupplyTrucks - 1);
          activeResupply.delete(u.id);
        } else if (task.kind === 'truck_fetch') {
          // The truck never reached the storage to load. Mark the
          // storage as having no inbound truck so a fresh dispatch
          // can retry. No payload was carried, nothing to refund.
          const storage = deps.buildings.buildings.find(b => b.id === task.storageId);
          if (storage) storage.supplyInbound = false;
          activeFetch.delete(u.id);
        }
        u.task = { kind: 'truck_return' };
        u.path = [];
        truckRepathTimer.delete(u.id);
        track.taskKey = 'truck_return:0';
        track.taskFirstAt = 0;
        track.sinceS = 0;
        track.x = u.x;
        track.z = u.z;
      }
      // truck_return abandonment: if the truck can't even make it
      // home after TRUCK_RETURN_LOST_S, kill it. This produces a
      // visible debris burst (removeDeadUnits in Game.ts) so it's
      // not the silent disappearance the user previously called out;
      // it's marked as a lost-in-action despawn.
      if (track.taskFirstAt > TRUCK_RETURN_LOST_S && task.kind === 'truck_return') {
        console.warn(`[TRUCK #${u.id}] lost in action: ${track.taskFirstAt.toFixed(1)}s on truck_return — despawning`);
        const team = truckTeam(u.id, deps);
        const hq = deps.buildings.nearestHQ(u.x, u.z, team);
        if (hq) hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        activeTruckToHQ.delete(u.id);
        truckRepathTimer.delete(u.id);
        truckProgressTrack.delete(u.id);
        u.hp = 0;
      }
      if (u.path.length > 0) {
        const moved = Math.hypot(u.x - track.x, u.z - track.z);
        if (moved > TRUCK_PROGRESS_M) {
          track.x = u.x;
          track.z = u.z;
          track.sinceS = 0;
        } else {
          track.sinceS += dt;
          if (track.sinceS > TRUCK_STALL_REPATH_S) {
            console.warn(`[TRUCK #${u.id}] watchdog: stalled ${track.sinceS.toFixed(1)}s on ${task.kind} pos=(${u.x.toFixed(1)},${u.z.toFixed(1)}) pathLen=${u.path.length} taskAge=${track.taskFirstAt.toFixed(1)}s — clearing path for retry`);
            u.path = [];
            truckRepathTimer.delete(u.id);
            track.sinceS = 0;
            track.x = u.x;
            track.z = u.z;
          }
        }
      }
    }

    // Resolve the truck's owning team up front so BOTH the diagnostic log and
    // the task handlers below use the same team-scoped HQ lookups. Previously
    // this was declared after the log block, so the `truck_deliver_hq` /
    // `truck_return` log called `nearestHQ(x, z)` with NO team arg and printed
    // the distance to whichever HQ was geometrically nearest — on the compact
    // debug map that's frequently the ENEMY HQ, making it look like trucks were
    // routing to enemy bases when dispatch + routing are in fact team-filtered.
    const teamOfTruck = truckTeam(u.id, deps);

    if (doLog) {
      let distInfo = '';
      if (task.kind === 'truck_fetch') {
        const s = deps.buildings.buildings.find(b => b.id === task.storageId);
        if (s) distInfo = ` dist_to_storage=${buildingBoxDistM(u.x, u.z, s).toFixed(1)}m`;
      } else if (task.kind === 'truck_deliver_hq' || task.kind === 'truck_return') {
        const hq = deps.buildings.nearestHQ(u.x, u.z, teamOfTruck);
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
        activeFetch.delete(u.id);
        const hq = deps.buildings.nearestHQ(u.x, u.z, teamOfTruck);
        if (!hq) { despawn(u, deps); continue; }
        u.task = { kind: 'truck_deliver_hq', payload };
        u.path = [];
        truckRepathTimer.delete(u.id);
        const hqPos = doorWorldPos(hq, u.x, u.z);
        deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const sPos = pickApproach(storage, u.x, u.z, deps);
          deps.routeTruck(u, sPos.x, sPos.y, sPos.z);
        });
      }
    } else if (task.kind === 'truck_deliver_hq') {
      const hq = deps.buildings.nearestHQ(u.x, u.z, teamOfTruck);
      if (!hq || hq.destroyed) { despawn(u, deps); continue; }
      const hqDist = buildingBoxDistM(u.x, u.z, hq);
      if (doLog) {
        // Diagnostic: print the geometry whenever a deliver-HQ truck is hovering
        // outside the trigger band. Helps spot a too-narrow INTERACT_REACH_M or
        // a doorWorldPos vs nearestHQ mismatch (multi-HQ build).
        if (hqDist > INTERACT_REACH_M) {
          console.log(`[TRUCK #${u.id}] HQ#${hq.id} box-dist=${hqDist.toFixed(2)}m INTERACT=${INTERACT_REACH_M}m hq.ox=${hq.ox} hq.oz=${hq.oz} cellsW=${hq.spec.cellsW} cellsD=${hq.spec.cellsD}`);
        }
      }
      if (hqDist <= INTERACT_REACH_M) {
        console.log(`[TRUCK #${u.id}] DELIVER to HQ: metals=${task.payload.metals} wood=${task.payload.wood}`);
        const r = teamResources(deps, teamOfTruck);
        r.metals += task.payload.metals;
        r.wood += task.payload.wood;
        hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        activeTruckToHQ.delete(u.id);
        u.hp = 0;
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const hqPos = doorWorldPos(hq, u.x, u.z);
          deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
        });
      }
    } else if (task.kind === 'truck_resupply') {
      const target = deps.buildings.buildings.find(b => b.id === task.buildingId);
      if (!target || target.destroyed) {
        const r = teamResources(deps, teamOfTruck);
        r.food += task.payload.food;
        r.metals += task.payload.metals;
        r.wood += task.payload.wood;
        despawn(u, deps);
        continue;
      }
      if (buildingBoxDistM(u.x, u.z, target) <= INTERACT_REACH_M) {
        console.log(`[TRUCK #${u.id}] RESUPPLY delivered to ${target.spec.kind}#${target.id}`);
        target.inboundResupplyTrucks = Math.max(0, target.inboundResupplyTrucks - 1);
        target.suppliedUnits++;
        activeResupply.delete(u.id);
        const hq = deps.buildings.nearestHQ(u.x, u.z, teamOfTruck);
        if (!hq) { despawn(u, deps); continue; }
        u.task = { kind: 'truck_return' };
        u.path = [];
        truckRepathTimer.delete(u.id);
        const hqPos = doorWorldPos(hq, u.x, u.z);
        deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const bPos = pickApproach(target, u.x, u.z, deps);
          deps.routeTruck(u, bPos.x, bPos.y, bPos.z);
        });
      }
    } else if (task.kind === 'truck_return') {
      const hq = deps.buildings.nearestHQ(u.x, u.z, teamOfTruck);
      if (!hq || hq.destroyed) { despawn(u, deps); continue; }
      // Same fix as truck_deliver_hq: use the box-distance check so the
      // truck despawns when it reaches HQ instead of point-precision.
      if (buildingBoxDistM(u.x, u.z, hq) <= INTERACT_REACH_M) {
        console.log(`[TRUCK #${u.id}] RETURNED to HQ, despawning`);
        hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
        activeTruckToHQ.delete(u.id);
        u.hp = 0;
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const hqPos = doorWorldPos(hq, u.x, u.z);
          deps.routeTruck(u, hqPos.x, hqPos.y, hqPos.z);
        });
      }
    } else if (task.kind === 'truck_deliver_upgrade') {
      const target = deps.buildings.buildings.find(b => b.id === task.buildingId);
      if (!target || target.destroyed) {
        // Target gone — refund the cargo to the truck's HQ team and head home.
        const r = teamResources(deps, teamOfTruck);
        r.metals += task.payload.metals;
        r.wood   += task.payload.wood;
        target && target.inboundUpgradeTrucks > 0 && target.inboundUpgradeTrucks--;
        activeUpgrade.delete(u.id);
        u.task = { kind: 'truck_return' };
        u.path = [];
        continue;
      }
      // Owner cancelled the upgrade while the truck was en route — turn
      // around without dropping. Refund to the truck's HQ team.
      if (target.upgradeState !== 'pending') {
        console.log(`[TRUCK #${u.id}] upgrade for ${target.spec.kind}#${target.id} no longer pending — aborting`);
        const r = teamResources(deps, teamOfTruck);
        r.metals += task.payload.metals;
        r.wood   += task.payload.wood;
        target.inboundUpgradeTrucks = Math.max(0, target.inboundUpgradeTrucks - 1);
        activeUpgrade.delete(u.id);
        u.task = { kind: 'truck_return' };
        u.path = [];
        continue;
      }
      if (buildingBoxDistM(u.x, u.z, target) <= INTERACT_REACH_M) {
        target.upgradeStockpile.metals += task.payload.metals;
        target.upgradeStockpile.wood   += task.payload.wood;
        target.inboundUpgradeTrucks = Math.max(0, target.inboundUpgradeTrucks - 1);
        activeUpgrade.delete(u.id);
        console.log(`[TRUCK #${u.id}] DELIVER upgrade to ${target.spec.kind}#${target.id}: m=${task.payload.metals} w=${task.payload.wood}`);
        u.task = { kind: 'truck_return' };
        u.path = [];
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const bPos = pickApproach(target, u.x, u.z, deps);
          deps.routeTruck(u, bPos.x, bPos.y, bPos.z);
        });
      }
    } else if (task.kind === 'truck_recover_upgrade') {
      const target = deps.buildings.buildings.find(b => b.id === task.buildingId);
      if (!target || target.destroyed) { despawn(u, deps); continue; }
      // Target switched off the cancelled state (e.g. the player re-armed
      // the upgrade) — abandon the recovery and head home empty.
      if (target.upgradeState !== 'cancelled') {
        u.task = { kind: 'truck_return' };
        u.path = [];
        continue;
      }
      if (buildingBoxDistM(u.x, u.z, target) <= INTERACT_REACH_M) {
        const m = target.upgradeStockpile.metals;
        const w = target.upgradeStockpile.wood;
        if (m + w > 0) {
          target.upgradeStockpile.metals = 0;
          target.upgradeStockpile.wood   = 0;
          const r = teamResources(deps, teamOfTruck);
          r.metals += m;
          r.wood   += w;
          console.log(`[TRUCK #${u.id}] RECOVER from ${target.spec.kind}#${target.id}: m=${m} w=${w}`);
        }
        u.task = { kind: 'truck_return' };
        u.path = [];
      } else if (u.path.length === 0) {
        retryRoute(u, deps, dt, () => {
          const bPos = pickApproach(target, u.x, u.z, deps);
          deps.routeTruck(u, bPos.x, bPos.y, bPos.z);
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
    const maxTrucks = deps.buildings.hqMaxTrucks(hq);

    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'storage') continue;
      if (b.team !== hq.team) continue;
      if (b.supplyInbound) continue;
      const amount = b.stockpile.metals + b.stockpile.wood;
      if (amount < b.truckCallThreshold) continue;

      const trucksNeeded = Math.ceil(amount / TRUCK_CAPACITY);
      // Fraction of stockpile each truck should carry (split proportionally).
      const ratio = b.stockpile.metals / (b.stockpile.metals + b.stockpile.wood || 1);

      // Spawn from whichever HQ face is closest to the storage so the truck
      // doesn't always have to wrap around the +X corner of the HQ.
      const targetX = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const targetZ = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const hqPos = doorWorldPos(hq, targetX, targetZ);
      const hqSide = pickHqSide(hq, targetX, targetZ);
      const hqCooldowns = getHqCooldowns(hq.id);

      let dispatched = 0;
      let remainMetals = b.stockpile.metals;
      let remainWood   = b.stockpile.wood;

      for (let t = 0; t < trucksNeeded; t++) {
        if (hq.activeTrucks >= maxTrucks) break;
        if (hqCooldowns[hqSide] > 0) break;
        const cargoMetals = Math.min(Math.round(TRUCK_CAPACITY * ratio), remainMetals);
        const cargoWood   = Math.min(TRUCK_CAPACITY - cargoMetals, remainWood);
        if (cargoMetals + cargoWood === 0) break;

        const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z, hq.team);
        if (!truck) break;

        hq.activeTrucks++;
        hqCooldowns[hqSide] = HQ_LAUNCH_GAP_S;
        remainMetals -= cargoMetals;
        remainWood   -= cargoWood;

        truck.task = {
          kind: 'truck_fetch',
          storageId: b.id,
          payload: { metals: cargoMetals, wood: cargoWood },
        };
        activeTruckToHQ.set(truck.id, hq.id);
        activeFetch.set(truck.id, b.id);
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

/**
 * Dispatch resupply trucks for ALL queued units that don't yet have resources
 * delivered or in-flight. Each truck carries one unit's worth of materials,
 * so a player who queued 5 soldiers gets up to 5 trucks dispatched (limited
 * by the HQ's `maxTrucks` cap and current `activeTrucks`). Production
 * literally won't begin on a unit until its truck has arrived.
 */
function dispatchResupplyTrucks(deps: SupplyTruckDeps): void {
  const hqs = deps.buildings.buildings.filter(b => !b.destroyed && b.spec.kind === 'hq');

  for (const hq of hqs) {
    const maxTrucks = deps.buildings.hqMaxTrucks(hq);
    const r = teamResources(deps, hq.team);

    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.team !== hq.team) continue;
      if (b.spec.produces.length === 0) continue;
      if (b.trainQueue.length === 0) continue;
      // If the head of the queue can't actually spawn because the team
      // is at pop cap, don't keep dispatching trucks. Their cargo would
      // sit at the building reserving resources that the AI needs to
      // build a neighborhood and break out of the cap. Existing trucks
      // already en route finish their delivery; we just stop adding to
      // the convoy.
      const headKind = b.trainQueue[0];
      if (headKind && deps.buildings.popHasRoom && !deps.buildings.popHasRoom(headKind, b)) continue;
      // Pick the HQ face closest to this consumer building so the resupply
      // truck has a short straight run rather than always emerging on +X.
      const targetX = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const targetZ = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const hqPos = doorWorldPos(hq, targetX, targetZ);
      const hqSide = pickHqSide(hq, targetX, targetZ);
      const hqCooldowns = getHqCooldowns(hq.id);

      // How many queued units have neither delivered supplies nor a truck
      // already in flight? That's how many trucks we still need to send.
      let needed = b.trainQueue.length - b.suppliedUnits - b.inboundResupplyTrucks;
      if (needed <= 0) continue;

      // Walk the queue from the first un-supplied unit forward and dispatch
      // a truck per unit until we hit the maxTrucks cap, an out-of-resources
      // condition, or the queue end.
      const startIdx = b.suppliedUnits + b.inboundResupplyTrucks;
      for (let i = 0; i < needed; i++) {
        if (hq.activeTrucks >= maxTrucks) break;
        if (hqCooldowns[hqSide] > 0) break;
        const queueIdx = startIdx + i;
        if (queueIdx >= b.trainQueue.length) break;
        const kind = b.trainQueue[queueIdx]!;
        const cost = UNIT_TRAIN_COST[kind];

        // Reserve resources at the HQ (deducted now; refunded if truck dies).
        if (r.food < cost.food) break;
        if (r.metals < cost.metals) break;
        if (r.wood < cost.wood) break;
        r.food -= cost.food;
        r.metals -= cost.metals;
        r.wood -= cost.wood;

        b.inboundResupplyTrucks++;
        hq.activeTrucks++;
        hqCooldowns[hqSide] = HQ_LAUNCH_GAP_S;

        console.log(`[DISPATCH] RESUPPLY truck: HQ#${hq.id} → ${b.spec.kind}#${b.id} for ${kind} (queued #${queueIdx + 1}/${b.trainQueue.length}; food=${cost.food} metals=${cost.metals} wood=${cost.wood})`);
        const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z, hq.team);
        if (!truck) {
          // Refund + reset: spawn pad blocked.
          r.food += cost.food;
          r.metals += cost.metals;
          r.wood += cost.wood;
          b.inboundResupplyTrucks--;
          hq.activeTrucks--;
          break;
        }

        truck.task = {
          kind: 'truck_resupply',
          buildingId: b.id,
          payload: { food: cost.food, metals: cost.metals, wood: cost.wood },
        };
        activeTruckToHQ.set(truck.id, hq.id);
        activeResupply.set(truck.id, {
          targetId: b.id,
          payload: { food: cost.food, metals: cost.metals, wood: cost.wood },
        });
        const bPos = pickApproach(b, hqPos.x, hqPos.z, deps);
        deps.routeTruck(truck, bPos.x, bPos.y, bPos.z);
      }
    }
  }
}

/**
 * Dispatch trucks delivering upgrade resources to any building whose
 * `upgradeState === 'pending'`. Each pending building gets at most one truck
 * per dispatch tick (the existing HQ launch cap + per-target inbound counter
 * naturally limit fleets so a slow upgrade still progresses with multiple
 * concurrent buildings). Reserves resources from the global pool the same
 * way `dispatchResupplyTrucks` does so cancelling the upgrade can refund
 * cleanly via the in-flight refund path.
 */
function dispatchUpgradeTrucks(deps: SupplyTruckDeps): void {
  const hqs = deps.buildings.buildings.filter(b => !b.destroyed && b.spec.kind === 'hq');
  for (const hq of hqs) {
    const maxTrucks = deps.buildings.hqMaxTrucks(hq);
    const r = teamResources(deps, hq.team);

    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.team !== hq.team) continue;
      if (b.upgradeState !== 'pending') continue;
      const cost = deps.buildings.upgradeCostFor(b);
      if (!cost) continue;
      // What still needs to arrive: cost minus already-on-site, minus
      // in-flight (we conservatively assume each in-flight truck carries
      // a full TRUCK_CAPACITY share, capped at the remaining shortfall).
      const stillNeededM = Math.max(0, cost.metals - b.upgradeStockpile.metals);
      const stillNeededW = Math.max(0, cost.wood   - b.upgradeStockpile.wood);
      const inFlightShare = b.inboundUpgradeTrucks * TRUCK_CAPACITY;
      const outstanding = (stillNeededM + stillNeededW) - inFlightShare;
      if (outstanding <= 0) continue;
      if (hq.activeTrucks >= maxTrucks) break;
      // Compute target / side first so the cooldown gate is per-side.
      const targetX = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const targetZ = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const hqSide = pickHqSide(hq, targetX, targetZ);
      const hqCooldowns = getHqCooldowns(hq.id);
      if (hqCooldowns[hqSide] > 0) continue;
      // Take what we can from this HQ's resources, capped to TRUCK_CAPACITY.
      const wantM = Math.min(stillNeededM, r.metals);
      const wantW = Math.min(stillNeededW, r.wood);
      if (wantM + wantW === 0) continue; // nothing to ship right now
      const total = Math.min(TRUCK_CAPACITY, wantM + wantW);
      const cargoM = Math.min(wantM, Math.floor(total * (wantM / (wantM + wantW))));
      const cargoW = Math.min(wantW, total - cargoM);
      if (cargoM + cargoW === 0) continue;
      r.metals -= cargoM;
      r.wood   -= cargoW;
      // Spawn from whichever HQ face is closest to the target.
      const hqPos = doorWorldPos(hq, targetX, targetZ);
      const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z, hq.team);
      if (!truck) {
        r.metals += cargoM;
        r.wood   += cargoW;
        break;
      }
      hq.activeTrucks++;
      hqCooldowns[hqSide] = HQ_LAUNCH_GAP_S;
      b.inboundUpgradeTrucks++;
      truck.task = {
        kind: 'truck_deliver_upgrade',
        buildingId: b.id,
        payload: { metals: cargoM, wood: cargoW },
      };
      activeTruckToHQ.set(truck.id, hq.id);
      activeUpgrade.set(truck.id, { targetId: b.id, payload: { metals: cargoM, wood: cargoW } });
      console.log(`[DISPATCH] UPGRADE truck #${truck.id} → ${b.spec.kind}#${b.id} (m=${cargoM} w=${cargoW})`);
      const bPos = pickApproach(b, hqPos.x, hqPos.z, deps);
      deps.routeTruck(truck, bPos.x, bPos.y, bPos.z);
    }
  }
}

/**
 * Dispatch trucks to fetch upgrade resources back from buildings whose
 * upgrade was cancelled with materials still sitting on site. The
 * returned cargo goes back into the global pool. One truck per cancelled
 * building per dispatch tick — the per-target stockpile is capped at one
 * upgrade cost so a single trip clears it.
 */
function dispatchUpgradeRecoveryTrucks(deps: SupplyTruckDeps): void {
  const hqs = deps.buildings.buildings.filter(b => !b.destroyed && b.spec.kind === 'hq');
  for (const hq of hqs) {
    const maxTrucks = deps.buildings.hqMaxTrucks(hq);
    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.team !== hq.team) continue;
      if (b.upgradeState !== 'cancelled') continue;
      const stash = b.upgradeStockpile.metals + b.upgradeStockpile.wood;
      if (stash <= 0) continue;
      // Already a recovery truck on the way? Skip — the inbound counter is
      // shared between deliver and recover so we don't double-up.
      if (b.inboundUpgradeTrucks > 0) continue;
      if (hq.activeTrucks >= maxTrucks) break;
      const targetX = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const targetZ = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const hqSide = pickHqSide(hq, targetX, targetZ);
      const hqCooldowns = getHqCooldowns(hq.id);
      if (hqCooldowns[hqSide] > 0) continue;
      const hqPos = doorWorldPos(hq, targetX, targetZ);
      const truck = deps.spawnTruck(hqPos.x, hqPos.y, hqPos.z, hq.team);
      if (!truck) break;
      hq.activeTrucks++;
      hqCooldowns[hqSide] = HQ_LAUNCH_GAP_S;
      b.inboundUpgradeTrucks++;
      truck.task = { kind: 'truck_recover_upgrade', buildingId: b.id };
      activeTruckToHQ.set(truck.id, hq.id);
      console.log(`[DISPATCH] RECOVER truck #${truck.id} → ${b.spec.kind}#${b.id} (cancelled upgrade)`);
      const bPos = pickApproach(b, hqPos.x, hqPos.z, deps);
      deps.routeTruck(truck, bPos.x, bPos.y, bPos.z);
    }
  }
}

function despawn(u: Unit, deps: SupplyTruckDeps): void {
  const team = truckTeam(u.id, deps);
  const hq = deps.buildings.nearestHQ(u.x, u.z, team);
  if (hq) hq.activeTrucks = Math.max(0, hq.activeTrucks - 1);
  // Refund any payload still attached to the truck — its target won't get
  // its delivery.
  const resupply = activeResupply.get(u.id);
  if (resupply) {
    activeResupply.delete(u.id);
    const target = deps.buildings.buildings.find(b => b.id === resupply.targetId);
    if (target && !target.destroyed) {
      target.inboundResupplyTrucks = Math.max(0, target.inboundResupplyTrucks - 1);
    }
    const r = teamResources(deps, team);
    r.food += resupply.payload.food;
    r.metals += resupply.payload.metals;
    r.wood += resupply.payload.wood;
  }
  const fetchStorage = activeFetch.get(u.id);
  if (fetchStorage !== undefined) {
    activeFetch.delete(u.id);
    const storage = deps.buildings.buildings.find(b => b.id === fetchStorage);
    if (storage) storage.supplyInbound = false;
  }
  const upgrade = activeUpgrade.get(u.id);
  if (upgrade) {
    activeUpgrade.delete(u.id);
    const target = deps.buildings.buildings.find(b => b.id === upgrade.targetId);
    if (target && !target.destroyed) {
      target.inboundUpgradeTrucks = Math.max(0, target.inboundUpgradeTrucks - 1);
    }
    const r = teamResources(deps, team);
    r.metals += upgrade.payload.metals;
    r.wood   += upgrade.payload.wood;
  }
  activeTruckToHQ.delete(u.id); // normal despawn — no rebuild
  truckRepathTimer.delete(u.id);
  u.hp = 0;
}

