import { VoxelWorld, worldIndex } from '../voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR, VOXEL_SIZE } from '../voxel/types';
import { M_WOOD, M_METAL } from '../voxel/Materials';
import { Unit, UnitManager } from './Units';
import { Resources } from './Resources';
import { Pile, PileManager } from './Piles';
import { BuildingManager, Building, doorWorldPos } from './Buildings';
import { SaplingManager } from './Saplings';

/**
 * Capacity each worker can carry before they MUST drop / deliver. Mining is
 * paused once total carrying ≥ CARRY_CAP; the worker drops a pile (harvester)
 * or heads to storage (transporter) before resuming.
 */
export const WORKER_CARRY_CAP = 5;

/**
 * How close (in meters, XZ) a worker needs to be to its target voxel before
 * `tickWorkers` starts the chop/mine action. Slightly bigger than 1 cell so
 * the worker doesn't have to land exactly on the voxel below the tree.
 */
const WORK_REACH_M = 1.4;
/** Same idea, but tighter, for pile pickup / storage drop-off. */
const INTERACT_REACH_M = 1.6;

/**
 * Damage applied per second when a worker chops or mines. Per-frame we apply
 * `WORK_DPS * dt`, scaled to integer peak via the existing damageSphere
 * machinery (which clamps to [1, 255]). 60 dps means a wood voxel (hp 60)
 * breaks in ~1 s and a metal voxel (hp 80) in ~1.3 s — fast enough to feel
 * responsive without trivialising harvesting.
 */
const WORK_DPS = 60;
/** Voxel-space radius of each chop/mine swing; small so we hit the target. */
const WORK_RADIUS_VOXELS = 1.4;

/** Squared search radius (m²) for a harvester scanning for nearby resources. */
const SCAN_RADIUS_M = 60;
const SCAN_R2 = SCAN_RADIUS_M * SCAN_RADIUS_M;

/**
 * Per-frame automation for every worker unit. Drives the harvester /
 * transporter task state machines. Movement to targets is delegated back to
 * the caller via `routeWorker`, which the Game wires to its `routePath`.
 *
 * The Worker tick does NOT modify the path itself, only the task field and
 * the carrying buffer. When a task assignment requires routing, we call
 * `routeWorker(u, x, y, z)` and let the existing pathfinding pipeline handle
 * the move; the next tick polls arrival.
 */
export interface WorkerDeps {
  units: UnitManager;
  world: VoxelWorld;
  buildings: BuildingManager;
  piles: PileManager;
  saplings: SaplingManager;
  resources: Resources;
  /**
   * Called when the worker needs to set a path to a world-space target.
   * Implementation lives in Game.ts (uses the existing path client). The
   * tick just supplies the destination — A* still runs asynchronously, so
   * we tolerate the path being empty for a frame after the call.
   */
  routeWorker: (u: Unit, wx: number, wy: number, wz: number) => void;
  /**
   * Called when a worker action mutated the voxel grid (chop / mine), so
   * the Game can request a nav rebuild in the same throttled way the
   * tunneler carve does.
   */
  onVoxelEdit: () => void;
}

export function tickWorkers(dt: number, deps: WorkerDeps): void {
  const { units } = deps;
  for (const u of units.units) {
    if (u.kind !== 'worker') continue;
    if (u.workerRole === 'harvester') tickHarvester(u, dt, deps);
    else tickTransporter(u, dt, deps);
  }
}

// ----------------------------- Harvester -------------------------------------

function tickHarvester(u: Unit, dt: number, deps: WorkerDeps): void {
  const total = u.carrying.wood + u.carrying.metals;
  // Cap reached → drop a pile right where we stand and clear carrying. The
  // dropped pile sits at the worker's feet; a transporter will pick it up.
  if (total >= WORKER_CARRY_CAP) {
    deps.piles.drop(u.x, u.y, u.z, u.carrying.wood, u.carrying.metals);
    u.carrying.wood = 0;
    u.carrying.metals = 0;
    u.task = { kind: 'idle' };
    return;
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
      // Verify the target voxel is still the resource we expected. Trees can
      // be chopped down by another worker; ore can be cleared by tunnelers.
      const vx = Math.floor(tx / VOXEL_SIZE);
      const vy = Math.floor(ty / VOXEL_SIZE);
      const vz = Math.floor(tz / VOXEL_SIZE);
      const m = readVoxel(deps.world.buffers.voxels, vx, vy, vz);
      if (m !== targetMat) {
        u.task = { kind: 'idle' };
        return;
      }

      if (horiz2 > WORK_REACH_M * WORK_REACH_M) {
        // Out of reach — we expect the path to bring us closer; if no path
        // is set (or we somehow drifted), kick a route.
        if (u.path.length === 0) deps.routeWorker(u, tx, ty, tz);
        return;
      }

      // In range. Apply per-frame damage to the target voxel via the same
      // damageSphere primitive the tunneler uses. peak is dps * dt clamped
      // to a sensible per-tick bite so the voxel doesn't shred in one frame
      // unless dt is unusually large.
      const peak = Math.max(1, Math.min(255, Math.round(WORK_DPS * dt)));
      const result = deps.world.damageSphere(
        vx + 0.5, vy + 0.5, vz + 0.5,
        WORK_RADIUS_VOXELS,
        peak,
      );
      if (result.destroyed.length > 0) {
        // Each destroyed voxel of the targeted material adds 1 to carrying;
        // collateral leaf / dirt / etc. counts for nothing (workers don't
        // bag dirt, only the resource they came for).
        for (const d of result.destroyed) {
          if (d.material === M_WOOD) u.carrying.wood++;
          else if (d.material === M_METAL) u.carrying.metals++;
        }
        deps.onVoxelEdit();
        // If the target voxel itself is now air, we're done with it; pick
        // another adjacent voxel of the same kind next frame. The "pick
        // another" lookup happens by going back to idle; the harvester will
        // re-scan and most often pick the same tree's next voxel.
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
          // Plant target is a 2D xz; route via surface Y at that column.
          deps.routeWorker(u, tx, u.y, tz);
        }
        return;
      }
      const seed = (u.id * 0x9e3779b9 + Math.floor(performance.now())) >>> 0;
      const res = deps.saplings.plant(deps.world, tx, tz, seed);
      // Whether or not the plant succeeded, drop the task — failure modes
      // (no grass, too close to existing) shouldn't loop the worker forever.
      if (res.ok) deps.onVoxelEdit();
      u.task = { kind: 'idle' };
      return;
    }

    case 'deliver':
    case 'fetchPile':
      // Harvesters don't deliver / fetch — those are transporter tasks.
      // Reset to idle so the harvester picks up its real job.
      u.task = { kind: 'idle' };
      return;
  }
}

/**
 * Pick the next harvest task for an idle harvester. Priority:
 *   1. Nearest exposed metal voxel within SCAN_RADIUS_M.
 *   2. Nearest tree voxel within SCAN_RADIUS_M.
 * If neither is available the worker stays idle this frame.
 */
function assignNextHarvestTask(u: Unit, deps: WorkerDeps): void {
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
  // No work in range — stay idle this tick.
}

// ----------------------------- Transporter -----------------------------------

function tickTransporter(u: Unit, dt: number, deps: WorkerDeps): void {
  void dt;
  // Already carrying something → take it to the nearest storage building.
  const carryTotal = u.carrying.wood + u.carrying.metals;
  if (carryTotal > 0) {
    if (u.task.kind !== 'deliver') u.task = { kind: 'deliver' };
    const storage = deps.buildings.nearestStorage(u.x, u.z);
    if (!storage) {
      // No storage exists; idle in place but keep the load.
      return;
    }
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

  // Empty-handed → pursue (or claim) a pile. We may transition idle→fetchPile
  // and then immediately pick up in the same tick when the transporter
  // already sits on the pile (e.g. an idle transporter standing where a
  // harvester just dropped). The idle branch falls through into fetchPile
  // by reassigning u.task and re-entering the same logic.
  if (u.task.kind === 'idle') {
    const pile = deps.piles.nearest(u.x, u.z, u.id);
    if (!pile) return;
    pile.claimedBy = u.id;
    u.task = { kind: 'fetchPile', pileId: pile.id };
    deps.routeWorker(u, pile.x, pile.y, pile.z);
    // fall through into the fetchPile handler below.
  }

  if (u.task.kind === 'fetchPile') {
    const p = lookupPile(deps.piles, u.task.pileId);
    if (!p) {
      u.task = { kind: 'idle' };
      return;
    }
    const dx = p.x - u.x, dz = p.z - u.z;
    if (dx * dx + dz * dz > INTERACT_REACH_M * INTERACT_REACH_M) {
      if (u.path.length === 0) deps.routeWorker(u, p.x, p.y, p.z);
      return;
    }
    u.carrying.wood += p.wood;
    u.carrying.metals += p.metals;
    deps.piles.remove(p.id);
    u.task = { kind: 'deliver' };
    return;
  }

  // chop / mine / plant / deliver-with-empty-hands → reset to idle so the
  // next tick re-picks the right work.
  u.task = { kind: 'idle' };
}

function lookupPile(pm: PileManager, id: number): Pile | null {
  for (const p of pm.piles) if (p.id === id) return p;
  return null;
}

// --------------------------- Voxel scan helpers ------------------------------

interface VoxelHit { vx: number; vy: number; vz: number; }

/**
 * Find the nearest "exposed" voxel of `targetMat` to the worker. Exposed =
 * has at least one orthogonal neighbour that is air. Search is a simple
 * brute-force scan over a bounding box around the worker out to
 * SCAN_RADIUS_M, keeping the closest hit by squared distance.
 *
 * Brute-force is fine for the voxel scale and current map size: at most
 * ~480k cells in the box, and we early-out via a coarse grid stride — we
 * sample every 2nd voxel in each axis, then refine. In practice for the
 * 768³ voxel world a typical scan touches a few thousand cells.
 */
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
  // Coarse stride first: only inspect every 2nd voxel. If we find a target,
  // we still verify its exposure on a fine scan, but the coarse stride keeps
  // the per-frame cost bounded.
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

// Re-export for test convenience.
export { findNearestExposed, isExposed };
// Re-export Building too so callers that build deps don't need a separate import.
export type { Building };
