import { Unit, UnitManager } from './Units';
import { BuildingManager, Building } from './Buildings';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';

/**
 * Civilians are auto-spawned by neighborhoods and wander between city
 * buildings — they're flavour, not combatants. The neighborhood-side
 * spawning logic and the per-civilian "pick a destination" AI both live
 * here so the rest of the sim doesn't need to know about civilians.
 *
 * Spawning: each enabled neighborhood targets `tier × 5` resident
 * civilians. We track the residents per neighborhood with a Map; once
 * the population is below quota and the per-building cooldown elapses,
 * one more civilian is spawned at the building's door. The popCap that
 * Game.ts exposes is derived from the live civilian count, so this
 * spawn loop directly controls how fast the player's pop ramps up — and
 * the death-triggered shorter `REPLACEMENT_COOLDOWN_S` is what makes a
 * lost civilian queue a quick replacement (down 1 → back up 1).
 *
 * Wandering: each civilian runs a tiny state machine — when idle they
 * pause for a few seconds, then pick a random target spot near a random
 * neighborhood (preferring ones other than their home), and route there.
 */

const SPAWN_COOLDOWN_S = 6.0;          // seconds between civilian spawns per neighborhood
const REPLACEMENT_COOLDOWN_S = 2.0;    // shorter cooldown when a death drops the count below quota
const IDLE_BETWEEN_TRIPS_S = [3.0, 9.0]; // random pause range between routes
const WANDER_RADIUS_M = 4.0;            // jitter applied to the destination so civilians don't all stop on the same dot

interface NeighborhoodResidents {
  /** ids of civilians the neighborhood spawned that are still alive. */
  ids: number[];
  /** seconds remaining before the next spawn attempt. */
  spawnCooldown: number;
}

/** Per-civilian wandering state — separate from the unit so the unit type
 *  doesn't need a new task variant. */
interface CivilianState {
  /** seconds remaining on idle pause; 0 = ready to pick a new target. */
  idleSeconds: number;
  /** building id this civilian was spawned by (so it has somewhere to go home to). */
  homeBuildingId: number;
}

export interface CivilianDeps {
  units: UnitManager;
  buildings: BuildingManager;
  /** Spawn a civilian at world (x, y, z). Returns null if spawn was rejected. */
  spawnCivilian: (x: number, y: number, z: number) => Unit | null;
  /** Issue a path request through the same async pipeline regular units use. */
  routeCivilian: (u: Unit, wx: number, wy: number, wz: number) => void;
  /** World-space surface Y for civilians to anchor wander targets at. */
  surfaceY: (wx: number, wz: number) => number;
}

export class CivilianSystem {
  private residents = new Map<number, NeighborhoodResidents>();
  private civilians = new Map<number, CivilianState>();
  /**
   * Civilians the player has manually assigned to a workplace (via
   * RMB-on-building). Mapped to the building id they're working at. The
   * wandering AI skips assigned civilians; selecting them and clicking
   * somewhere else clears the assignment.
   */
  private assignedWork = new Map<number, number>();

  /**
   * Bind a set of civilians to a workplace building. Used by Game when
   * the player RMBs a refinery with civilian(s) selected. The civilians
   * are routed there by the caller; this just records the assignment so
   * the wandering AI doesn't override the player's order.
   */
  assignToWorkplace(civilianIds: number[], buildingId: number): void {
    for (const id of civilianIds) this.assignedWork.set(id, buildingId);
  }

  /** Drop a civilian's workplace assignment (e.g. building destroyed). */
  clearAssignment(civilianId: number): void {
    this.assignedWork.delete(civilianId);
  }

  tick(dt: number, deps: CivilianDeps): void {
    this.reapDeadResidents(deps);
    this.tickSpawning(dt, deps);
    this.tickWandering(dt, deps);
  }

  private reapDeadResidents(deps: CivilianDeps): void {
    const alive = new Set<number>();
    for (const u of deps.units.units) {
      if (u.kind === 'civilian' && u.hp > 0) alive.add(u.id);
    }
    for (const [bid, res] of this.residents) {
      const before = res.ids.length;
      res.ids = res.ids.filter(id => alive.has(id));
      // A death below quota queues a replacement on a short cooldown, so
      // the popCap that tracks live civilians visibly drops by 1 and then
      // climbs back up over a couple of seconds.
      if (res.ids.length < before) {
        res.spawnCooldown = Math.min(res.spawnCooldown, REPLACEMENT_COOLDOWN_S);
      }
      if (res.ids.length === 0 && !deps.buildings.buildings.some(b => b.id === bid && !b.destroyed)) {
        this.residents.delete(bid);
      }
    }
    for (const id of this.civilians.keys()) {
      if (!alive.has(id)) this.civilians.delete(id);
    }
  }

  private tickSpawning(dt: number, deps: CivilianDeps): void {
    for (const b of deps.buildings.buildings) {
      if (b.destroyed) continue;
      if (b.spec.kind !== 'neighborhood') continue;
      if (b.healthRefVoxels <= 0) continue;        // initial build hasn't finished
      const tier = 1 + (b.upgradeTracks.expand ?? 0);
      const target = tier * 5;
      let res = this.residents.get(b.id);
      if (!res) {
        res = { ids: [], spawnCooldown: 0 };
        this.residents.set(b.id, res);
      }
      res.spawnCooldown = Math.max(0, res.spawnCooldown - dt);
      if (res.ids.length >= target) continue;
      if (res.spawnCooldown > 0) continue;
      // Spawn at the lot centre's surface — we use surfaceY so the unit lands
      // on top of whatever floor the neighborhood stamped.
      const cx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const cy = deps.surfaceY(cx, cz);
      const u = deps.spawnCivilian(cx, cy, cz);
      if (!u) continue;
      res.ids.push(u.id);
      res.spawnCooldown = SPAWN_COOLDOWN_S;
      this.civilians.set(u.id, {
        idleSeconds: IDLE_BETWEEN_TRIPS_S[0]! + Math.random() * (IDLE_BETWEEN_TRIPS_S[1]! - IDLE_BETWEEN_TRIPS_S[0]!),
        homeBuildingId: b.id,
      });
    }
  }

  private tickWandering(dt: number, deps: CivilianDeps): void {
    if (this.civilians.size === 0) return;
    const cityBuildings: Building[] = deps.buildings.buildings.filter(b =>
      !b.destroyed && b.spec.kind === 'neighborhood' && b.healthRefVoxels > 0,
    );
    if (cityBuildings.length === 0) return;
    for (const u of deps.units.units) {
      if (u.kind !== 'civilian' || u.hp <= 0) continue;
      // Player-assigned to a workplace? Don't override their orders —
      // they walk to the workplace once (set elsewhere) and idle there.
      if (this.assignedWork.has(u.id)) continue;
      const state = this.civilians.get(u.id);
      if (!state) continue;
      // Already walking somewhere? Let it finish.
      if (u.path.length > 0) continue;
      // Pause between trips.
      if (state.idleSeconds > 0) {
        state.idleSeconds = Math.max(0, state.idleSeconds - dt);
        continue;
      }
      // Pick a target neighborhood — bias away from the home so civilians
      // visibly travel between blocks rather than orbit their own house.
      let target: Building | undefined;
      if (cityBuildings.length === 1) target = cityBuildings[0];
      else {
        const others = cityBuildings.filter(b => b.id !== state.homeBuildingId);
        const pool = others.length > 0 ? others : cityBuildings;
        target = pool[Math.floor(Math.random() * pool.length)];
      }
      if (!target) continue;
      // Aim at the target lot's centre with a small wander jitter so a
      // batch of civilians arriving at the same lot fan out instead of
      // colliding on the centre dot.
      const baseX = (target.ox + target.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const baseZ = (target.oz + target.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
      const jitterAngle = Math.random() * Math.PI * 2;
      const jitterDist = Math.random() * WANDER_RADIUS_M;
      const tx = baseX + Math.cos(jitterAngle) * jitterDist;
      const tz = baseZ + Math.sin(jitterAngle) * jitterDist;
      const ty = deps.surfaceY(tx, tz);
      deps.routeCivilian(u, tx, ty, tz);
      // Once the route resolves the civilian walks; on arrival their
      // path empties and we drop into the idle phase again.
      state.idleSeconds = IDLE_BETWEEN_TRIPS_S[0]! + Math.random() * (IDLE_BETWEEN_TRIPS_S[1]! - IDLE_BETWEEN_TRIPS_S[0]!);
    }
  }
}
