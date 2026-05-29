import { describe, it, expect, vi } from 'vitest';
import { tickSupplyTrucks, resetSupplyTruckState, SupplyTruckDeps } from '../src/sim/SupplyTrucks';

/**
 * Regression for the depot construction-resupply starvation fix (iter68).
 *
 * Before the fix, `dispatchResupplyTrucks` (unit production) ran BEFORE
 * `dispatchUpgradeTrucks` (building construction). Both pull from the same
 * per-HQ truck cap AND the same team metal pool, and resupply runs on a tight
 * backlog, so it drained every metal before a pending building could be
 * funded. Costly late buildings — the vehicle_depot especially — sat at
 * `upgradeState: 'pending'` (hp 0) forever, so the AI never fielded tanks /
 * anti-air / rocket trucks despite queuing them correctly.
 *
 * The fix dispatches construction trucks first. This test pins that priority
 * with a scarce resource pool: there are only enough materials for ONE of
 * {fund the depot, supply a soldier}. Construction must win.
 */

function mkBuilding(over: Record<string, unknown>): any {
  return {
    destroyed: false,
    team: 'player',
    ox: 0, oz: 0,
    trainQueue: [],
    suppliedUnits: 0,
    inboundResupplyTrucks: 0,
    inboundUpgradeTrucks: 0,
    supplyInbound: false,
    activeTrucks: 0,
    upgradeState: 'enabled',
    upgradeStockpile: { metals: 0, wood: 0 },
    upgradeTracks: {},
    stockpile: { metals: 0, wood: 0 },
    truckCallThreshold: 50,
    ...over,
  };
}

describe('supply trucks — construction is dispatched before unit-production resupply', () => {
  it('funds a pending vehicle_depot before a queued soldier when metals are scarce', () => {
    const hq = mkBuilding({
      id: 1, ox: 10, oz: 10,
      spec: { kind: 'hq', cellsW: 6, cellsD: 5, produces: [], maxTrucks: 5 },
    });
    const barracks = mkBuilding({
      id: 2, ox: 20, oz: 10,
      spec: { kind: 'barracks', cellsW: 3, cellsD: 3, produces: ['soldier'] },
      upgradeState: 'enabled',
      trainQueue: ['soldier'],
    });
    const depot = mkBuilding({
      id: 3, ox: 30, oz: 10,
      spec: { kind: 'vehicle_depot', cellsW: 4, cellsD: 4, produces: ['tank', 'aa_vehicle', 'rocket_truck'] },
      upgradeState: 'pending',
      upgradeStockpile: { metals: 0, wood: 0 },
    });
    const allBuildings = [hq, barracks, depot];

    // Just enough for ONE choice: the depot needs 70m/50w; a soldier needs
    // 10m. With 10 metals total, either the depot gets a (partial) funding
    // truck or the soldier gets one — not both. Construction must win.
    const res: any = { food: 500, metals: 10, wood: 10, popCap: 200 };

    const units: any = { units: [] as any[] };
    let nextTruckId = 1000;

    const fakeBuildings: any = {
      buildings: allBuildings,
      hqMaxTrucks: () => 5,
      popHasRoom: () => true,
      upgradeCostFor: (b: any) =>
        b.spec.kind === 'vehicle_depot' ? { metals: 70, wood: 50 } : null,
    };

    const deps = {
      units,
      buildings: fakeBuildings,
      resources: res,
      resourcesForTeam: () => res,
      spawnTruck: (x: number, y: number, z: number, team: string) => {
        const t = { id: nextTruckId++, x, y, z, team, hp: 100, kind: 'supply_truck', task: null, path: [] as any[], heading: 0 };
        units.units.push(t);
        return t;
      },
      routeTruck: (u: any, wx: number, wy: number, wz: number) => { u.path = [{ x: wx, y: wy, z: wz }]; },
      isPassable: () => true,
    } as unknown as SupplyTruckDeps;

    // One dispatch tick (dt > DISPATCH_INTERVAL so dispatch fires).
    tickSupplyTrucks(0.6, deps);

    // Construction won: the depot has an inbound upgrade truck and the
    // scarce metals were spent on it, leaving none for the soldier resupply.
    expect(depot.inboundUpgradeTrucks).toBeGreaterThan(0);
    expect(barracks.inboundResupplyTrucks).toBe(0);
    expect(res.metals).toBe(0);
  });
});

describe('supply trucks — team attribution + cross-match state reset (iter79)', () => {
  function twoTeamDeps() {
    resetSupplyTruckState();
    const enemyHq = mkBuilding({ id: 10, team: 'enemy', ox: 40, oz: 40, spec: { kind: 'hq', cellsW: 6, cellsD: 5, produces: [], maxTrucks: 5 } });
    const enemyDepot = mkBuilding({
      id: 11, team: 'enemy', ox: 50, oz: 40,
      spec: { kind: 'vehicle_depot', cellsW: 4, cellsD: 4, produces: ['tank'] },
      upgradeState: 'pending', upgradeStockpile: { metals: 0, wood: 0 },
    });
    const buildings = [enemyHq, enemyDepot];
    const enemyRes: any = { food: 500, metals: 500, wood: 500, popCap: 60 };
    const playerRes: any = { food: 500, metals: 500, wood: 500, popCap: 60 };
    const units: any = { units: [] as any[] };
    let nextId = 5000;
    const fakeBuildings: any = {
      buildings,
      hqMaxTrucks: () => 5,
      popHasRoom: () => true,
      upgradeCostFor: (b: any) => (b.spec.kind === 'vehicle_depot' ? { metals: 70, wood: 50 } : null),
    };
    const deps = {
      units, buildings: fakeBuildings, resources: playerRes,
      resourcesForTeam: (team: string) => (team === 'enemy' ? enemyRes : playerRes),
      spawnTruck: (x: number, y: number, z: number, team: string) => {
        const t = { id: nextId++, x, y, z, team, hp: 100, kind: 'supply_truck', task: null, path: [] as any[], heading: 0 };
        units.units.push(t); return t;
      },
      routeTruck: (u: any, wx: number, wy: number, wz: number) => { u.path = [{ x: wx, y: wy, z: wz }]; },
      isPassable: () => true,
    } as unknown as SupplyTruckDeps;
    return { deps, enemyDepot, enemyRes, playerRes, units };
  }

  it('refunds a cancelled ENEMY construction truck to the ENEMY pool, not the player', () => {
    const { deps, enemyDepot, enemyRes, playerRes, units } = twoTeamDeps();
    // Tick 1: dispatch an upgrade truck for the enemy depot (debits enemy pool,
    // registers the truck to the enemy HQ).
    tickSupplyTrucks(0.6, deps);
    expect(units.units.length).toBeGreaterThan(0);
    const spentEnemy = 500 - enemyRes.metals;
    expect(spentEnemy).toBeGreaterThan(0);
    const playerBefore = playerRes.metals;
    // Depot destroyed mid-flight → the truck refunds its cargo on the next tick.
    enemyDepot.destroyed = true;
    tickSupplyTrucks(0.6, deps);
    // Refund must land in the ENEMY pool (team attribution), player untouched.
    expect(enemyRes.metals).toBe(500);
    expect(playerRes.metals).toBe(playerBefore);
  });

  it('resetSupplyTruckState clears the registry (a stale truck then misses → player fallback + warns)', () => {
    const { deps, enemyDepot, enemyRes, playerRes, units } = twoTeamDeps();
    tickSupplyTrucks(0.6, deps); // dispatch: registers a truck to the ENEMY HQ
    const truck = units.units[0];
    expect(truck).toBeDefined();
    // Simulate a new match in the same process WITHOUT re-registering this
    // truck: wipe module state. The truck's registry entry is now gone.
    resetSupplyTruckState();
    const playerBefore = playerRes.metals;
    const enemyBefore = enemyRes.metals;
    // Its target vanished, so it refunds its cargo on the next tick. With the
    // registry cleared, truckTeam() misses → falls back to 'player' (the
    // documented hazard the reset exists to prevent), so the refund lands in
    // the PLAYER pool, not enemy — proving reset actually cleared the map.
    enemyDepot.destroyed = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tickSupplyTrucks(0.6, deps);
    const warned = warn.mock.calls.some(c => String(c[0]).includes('registry MISS'));
    warn.mockRestore();
    expect(playerRes.metals).toBeGreaterThan(playerBefore); // refund hit player (fallback)
    expect(enemyRes.metals).toBe(enemyBefore);              // enemy untouched
    expect(warned).toBe(true);
  });
});
