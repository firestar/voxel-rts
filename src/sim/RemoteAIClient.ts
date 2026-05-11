import { Unit, UnitManager, UnitKind } from './Units';
import {
  BuildingManager, Building, BuildingKind, BuildingSpec,
  BARRACKS, FARM, VEHICLE_DEPOT,
  checkFootprint, snapshotBuildingStructure,
  UNIT_TRAIN_COST,
} from './Buildings';
import { Resources } from './Resources';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { SurfaceNavBuffers, NAV_CELL_VOXELS, NAV_CELL_METERS, NAV_W, NAV_H } from '../path/SurfaceNav';
import { VOXEL_SIZE } from '../voxel/types';

/**
 * Browser-side bridge to the backend AI server (ai-server.cjs).
 *
 * The client owns the world and the canonical resource numbers. The
 * server just decides *intent* — "place a barracks", "queue a
 * soldier" — and the client validates + applies it. If the server is
 * offline, requests fail silently and the AI sleeps; the rest of the
 * game keeps working.
 *
 * Protocol — POST /ai/tick:
 *   request:  { sessionId, state: {
 *     enemyHq: {alive, ox, oz, cellsW, cellsD, floorY} | null,
 *     enemyResources: {food, metals, wood},
 *     enemyBuildings: [{id, kind, upgradeState, trainQueueLen}],
 *     enemyUnitCount,
 *   }}
 *   response: { actions: AiAction[] }
 */

export type AiAction =
  | { type: 'place_building'; kind: BuildingKind; anchorHqId?: number }
  | { type: 'queue_train'; buildingId: number; unitKind: UnitKind }
  | { type: 'route_unit'; unitId: number; x: number; z: number };

export interface AIClientDeps {
  units: UnitManager;
  buildings: BuildingManager;
  world: VoxelWorld;
  surfaceNav: SurfaceNavBuffers;
  enemyResources: Resources;
  /** Per-team resource pool lookup. The snapshot publishes one
   *  resource bag per non-player HQ so the brain budgets each AI's
   *  spending independently rather than from a shared pool. */
  resourcesForTeam?: (team: 'player' | 'enemy' | 'enemy2') => Resources;
  spawnEnemy: (kind: UnitKind, x: number, y: number, z: number) => Unit | null;
  surfaceY: (x: number, z: number) => number;
  /** Route a unit to (wx, wy, wz) via the same path worker the rest of
   *  the sim uses. Used by `route_unit` actions to apply server-side
   *  attack-move decisions. */
  routeUnit: (u: Unit, wx: number, wy: number, wz: number) => void;
  /** Hook into Game's nav-rebuild plumbing so a freshly placed enemy
   *  building reflects in the next path query. */
  requestNavRebuildAround: (
    bx0: number, by0: number, bz0: number,
    bx1: number, by1: number, bz1: number,
  ) => void;
}

const TICK_INTERVAL_S = 1.0;
/** Same-origin path. In dev the vite proxy forwards /ai → :3030; in
 *  production the nginx in the container does the same. Override via
 *  the `url` constructor option for one-off setups. */
const DEFAULT_URL = '/ai/tick';
const DEFAULT_SESSION = 'default';

const KNOWN_UNIT_KINDS: ReadonlyArray<UnitKind> = [
  'soldier', 'sniper', 'gunner', 'mortar_soldier', 'rocket_soldier',
  'tank', 'tunneler', 'worm', 'worker', 'dozer',
  'rocket_truck', 'aa_vehicle', 'supply_truck', 'civilian',
];

function isUnitKind(s: unknown): s is UnitKind {
  return typeof s === 'string' && (KNOWN_UNIT_KINDS as readonly string[]).includes(s);
}

const BUILDING_SPECS: Partial<Record<BuildingKind, BuildingSpec>> = {
  barracks: BARRACKS,
  farm: FARM,
  vehicle_depot: VEHICLE_DEPOT,
};

export class RemoteAIClient {
  private cooldown = 0;
  private inflight = false;
  private url: string;
  private sessionId: string;
  /** True after a request fails; we throttle retries so a missing
   *  server doesn't hammer the console with errors. */
  private backoffUntil = 0;

  constructor(opts?: { url?: string; sessionId?: string }) {
    this.url = opts?.url ?? DEFAULT_URL;
    this.sessionId = opts?.sessionId ?? DEFAULT_SESSION;
  }

  /** Called once per game frame. Pulses the server every TICK_INTERVAL_S. */
  tick(dt: number, deps: AIClientDeps): void {
    this.cooldown -= dt;
    if (this.cooldown > 0) return;
    if (this.inflight) return;
    this.cooldown = TICK_INTERVAL_S;
    if (performance.now() < this.backoffUntil) return;
    this.inflight = true;
    void this.pulse(deps).finally(() => { this.inflight = false; });
  }

  private async pulse(deps: AIClientDeps): Promise<void> {
    const state = this.snapshot(deps);
    let data: { actions?: AiAction[] };
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, state }),
      });
      if (!res.ok) { this.backoffUntil = performance.now() + 5000; return; }
      data = await res.json() as { actions?: AiAction[] };
    } catch (_err) {
      this.backoffUntil = performance.now() + 5000;
      return;
    }
    const actions = data?.actions ?? [];
    for (const a of actions) this.applyAction(a, deps);
  }

  private snapshot(deps: AIClientDeps): unknown {
    // EVERY HQ is an independent AI faction now — the host has no
    // human at the controls in this AI-vs-AI loop, so the player
    // team's HQ is just another brain. Each HQ runs the same per-
    // base logic with its own resource pool (resourcesForTeam).
    const hqs = deps.buildings.buildings.filter(
      b => !b.destroyed && b.spec.kind === 'hq' && b.healthRefVoxels > 0,
    );
    let enemyUnitCount = 0;
    const enemyUnits: Array<{
      id: number; kind: string; team: string; x: number; z: number; hp: number;
      armed: boolean; hasFiringTarget: boolean; pathLen: number;
    }> = [];
    for (const u of deps.units.units) {
      if (u.hp <= 0) continue;
      enemyUnitCount++;
      if (u.kind === 'worker' || u.kind === 'civilian' || u.kind === 'supply_truck') continue;
      enemyUnits.push({
        id: u.id, kind: u.kind, team: u.team,
        x: +u.x.toFixed(2), z: +u.z.toFixed(2),
        hp: u.hp,
        armed: u.weapon !== null,
        hasFiringTarget: !!u.firingTarget,
        pathLen: u.path.length,
      });
    }
    // Each enemy building is "claimed" by the closest HQ. The brain
    // uses that to budget per-base placements without a separate
    // owner-tag plumbing pass.
    function nearestHqIdx(bx: number, bz: number): number {
      let best = -1, bestD2 = Infinity;
      for (let i = 0; i < hqs.length; i++) {
        const h = hqs[i]!;
        const hx = (h.ox + h.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const hz = (h.oz + h.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const dx = bx - hx, dz = bz - hz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      return best;
    }
    const enemyHqs = hqs.map(h => ({
      alive: true,
      id: h.id,
      team: h.team,
      ox: h.ox, oz: h.oz,
      cellsW: h.spec.cellsW, cellsD: h.spec.cellsD,
      floorY: h.floorY,
      x: +(((h.ox + h.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE)).toFixed(2),
      z: +(((h.oz + h.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE)).toFixed(2),
    }));
    const enemyBuildings = deps.buildings.buildings
      .filter(b => !b.destroyed)
      .map(b => {
        const bx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const bz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const hi = nearestHqIdx(bx, bz);
        return {
          id: b.id,
          kind: b.spec.kind,
          team: b.team,
          upgradeState: b.upgradeState,
          trainQueueLen: b.trainQueue.length,
          x: +bx.toFixed(2),
          z: +bz.toFixed(2),
          anchorHqId: hi >= 0 ? enemyHqs[hi]!.id : null,
        };
      });
    // Targets from every AI's perspective: all live buildings the AI
    // doesn't own. The brain filters per-base by team so an `enemy2`
    // AI only attacks `player` and `enemy` buildings, never its own.
    const targetBuildings = deps.buildings.buildings
      .filter(b => !b.destroyed && b.healthRefVoxels > 0)
      .map(b => ({
        id: b.id,
        kind: b.spec.kind,
        team: b.team,
        x: +b.aimWX.toFixed(2),
        z: +b.aimWZ.toFixed(2),
        alive: true,
      }));
    // Legacy single-AI brain still reads `playerBuildings` — keep it
    // as a player-only filter for back-compat. New brain prefers
    // `targetBuildings` with team awareness.
    const playerBuildings = targetBuildings.filter(b => b.team === 'player');
    // Per-team resource pools so the brain can budget each AI's
    // spending separately. Falls back to a single shared pool when
    // resourcesForTeam isn't wired (test bench).
    const teamResources: Record<string, { food: number; metals: number; wood: number }> = {};
    for (const h of enemyHqs) {
      const r = deps.resourcesForTeam ? deps.resourcesForTeam(h.team as 'player' | 'enemy' | 'enemy2') : deps.enemyResources;
      teamResources[h.team] = {
        food: r.food | 0,
        metals: r.metals | 0,
        wood: r.wood | 0,
      };
    }
    return {
      enemyHq: enemyHqs[0] ?? null, // legacy: one-HQ brains still receive the first
      enemyHqs,
      enemyBuildings,
      playerBuildings,
      targetBuildings,
      enemyUnits,
      enemyResources: {
        food: deps.enemyResources.food | 0,
        metals: deps.enemyResources.metals | 0,
        wood: deps.enemyResources.wood | 0,
      },
      teamResources,
      enemyUnitCount,
    };
  }

  private applyAction(a: AiAction, deps: AIClientDeps): void {
    switch (a.type) {
      case 'place_building': return this.applyPlaceBuilding(a, deps);
      case 'queue_train': return this.applyQueueTrain(a, deps);
      case 'route_unit': return this.applyRouteUnit(a, deps);
    }
  }

  private applyRouteUnit(
    a: { unitId: number; x: number; z: number },
    deps: AIClientDeps,
  ): void {
    const u = deps.units.units.find(x => x.id === a.unitId);
    if (!u || u.hp <= 0) return;
    if (u.team === 'player') return;
    if (u.firingTarget) return; // sticky: don't override a fresh fire order
    const y = deps.surfaceY(a.x, a.z);
    deps.routeUnit(u, a.x, y, a.z);
  }

  private applyPlaceBuilding(a: { kind: BuildingKind; anchorHqId?: number }, deps: AIClientDeps): void {
    const spec = BUILDING_SPECS[a.kind];
    if (!spec || !spec.upgradeCost) return;
    const cost = spec.upgradeCost;
    let hq = a.anchorHqId !== undefined
      ? deps.buildings.buildings.find(
          b => b.id === a.anchorHqId && !b.destroyed && b.spec.kind === 'hq',
        )
      : undefined;
    if (!hq) {
      hq = deps.buildings.buildings.find(
        b => !b.destroyed && b.spec.kind === 'hq',
      );
    }
    if (!hq) return;
    // Per-team affordability check — each AI faction spends from its
    // own pool. Falls back to enemyResources when the lookup isn't
    // wired (test bench).
    const teamRes = deps.resourcesForTeam
      ? deps.resourcesForTeam(hq.team as 'player' | 'enemy' | 'enemy2')
      : deps.enemyResources;
    if (teamRes.metals < cost.metals || teamRes.wood < cost.wood) return;
    const placeTeam = hq.team;
    // Walk a ring of offsets out from the HQ door (+X face) until we
    // find a footprint the world accepts. Mirrors the player's
    // starter-kit offsets so the AI's first barracks reads as
    // "tucked next to the HQ" rather than dropped on top of it.
    const baseCx = hq.ox + hq.spec.cellsW + 2;
    const baseCz = hq.oz + (hq.spec.cellsD >> 1);
    const offsets: Array<[number, number]> = [
      [0, 0], [0, -3], [0, 3],
      [3, 0], [-3, 0],
      [3, -3], [3, 3], [-3, -3], [-3, 3],
      [6, 0], [0, -6], [0, 6],
    ];
    for (const [dx, dz] of offsets) {
      const ox = Math.max(0, Math.min(NAV_W - spec.cellsW, baseCx + dx - (spec.cellsW >> 1)));
      const oz = Math.max(0, Math.min(NAV_H - spec.cellsD, baseCz + dz - (spec.cellsD >> 1)));
      const fp = checkFootprint(deps.world.buffers.voxels, deps.surfaceNav, spec, ox, oz, deps.buildings.buildings);
      if (!fp.ok) continue;
      // Place the footprint with team='enemy'. Same flow as a player
      // build: pending state, activeUpgradeId='initial'. Supply trucks
      // pick up the delivery from the enemy HQ and the building
      // animates into place over its constructionSeconds. Resource
      // debits happen as trucks dispatch (in SupplyTrucks.ts), not
      // here — the AI plays by the same logistics rules the player
      // does.
      deps.buildings.place(deps.world, spec, ox, oz, fp.floorY, { team: placeTeam });
      const pad = NAV_CELL_METERS;
      const bx0 = ox * NAV_CELL_METERS;
      const bz0 = oz * NAV_CELL_METERS;
      const bx1 = (ox + spec.cellsW) * NAV_CELL_METERS;
      const bz1 = (oz + spec.cellsD) * NAV_CELL_METERS;
      const by0 = fp.floorY * VOXEL_SIZE;
      const by1 = (fp.floorY + spec.headroomVoxels + 4) * VOXEL_SIZE;
      deps.requestNavRebuildAround(bx0 - pad, by0 - pad, bz0 - pad, bx1 + pad, by1 + pad, bz1 + pad);
      return;
    }
    void cost;
    void NAV_CELL_VOXELS;
  }

  private applyQueueTrain(
    a: { buildingId: number; unitKind: UnitKind },
    deps: AIClientDeps,
  ): void {
    if (!isUnitKind(a.unitKind)) return;
    const b = deps.buildings.buildings.find(x => x.id === a.buildingId);
    if (!b || b.destroyed) return;
    if (b.upgradeState !== 'enabled') return;
    if (!b.spec.produces.includes(a.unitKind)) return;
    // Just push onto the train queue. The supply-truck dispatcher
    // will reserve resources from the enemy HQ pool and dispatch a
    // resupply truck to the producer; production only begins once the
    // truck arrives. Same loop the player relies on.
    b.trainQueue.push(a.unitKind);
    void UNIT_TRAIN_COST;
  }
}
