import { describe, it, expect, afterEach } from 'vitest';

/**
 * Digging units + tunnelling (this change).
 *
 * The brain must (1) field a tunneler out of the vehicle depot once it has
 * teched, and (2) route that idle tunneler straight at the enemy HQ so it
 * carves a tunnel to the base. Diggers are unarmed, so the normal armed-
 * attacker pass skips them — a dedicated siege pass drives them.
 *
 * `decideActions` reads strategy from live process.env per call, so we drive
 * the depot-teching strategy via the team env knob.
 */

process.env.AI_SERVER_TEST = '1';
delete process.env.AI_STRATEGY_DEFAULT;
delete process.env.AI_STRATEGY_enemy;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ai = require('../ai-server.cjs');

afterEach(() => { delete process.env.AI_STRATEGY_enemy; });

let sidCounter = 0;

/** State with an enabled depot (+ barracks) and a configurable unit list. */
function depotState(units: any[] = []): any {
  return {
    enemyHqs: [{ id: 1, team: 'enemy', alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
    enemyBuildings: [
      { id: 1, kind: 'hq', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1 },
      { id: 2, kind: 'barracks', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
      { id: 9, kind: 'vehicle_depot', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
    ],
    targetBuildings: [], playerBuildings: [],
    enemyUnits: units,
    workers: Array.from({ length: 6 }, (_, i) => ({ id: 200 + i, team: 'enemy', focus: 'mine', taskKind: 'mine' })),
    enemyResources: { food: 3000, metals: 3000, wood: 3000 },
    teamResources: { enemy: { food: 3000, metals: 3000, wood: 3000, popCap: 60 } },
    teamPopUsed: { enemy: 6 }, enemyUnitCount: units.length + 6,
  };
}

describe('AI digging units (tunneler)', () => {
  it('queues a tunneler from the depot once it has fielded its first vehicle', () => {
    process.env.AI_STRATEGY_enemy = 'balanced'; // depot strategy, DIGGER_TARGET default 1
    const sid = `dig-${sidCounter++}`;
    const s = ai.ensureSession(sid);
    if (s.perHq) s.perHq.clear();
    if (s.strategies) delete s.strategies;

    const depotTrains: string[] = [];
    // Two depot ticks: the first vehicle leads the rotation (depotPickIndex
    // advances), the second slot is the sapper.
    for (let tick = 0; tick < 2; tick++) {
      s.lastTickAt = Date.now() - 5000; // dt → 2 s so cooldowns elapse
      const { actions } = ai.decideActions(depotState(), sid);
      for (const a of actions) {
        if (a.type === 'queue_train' && a.buildingId === 9) depotTrains.push(a.unitKind);
      }
    }
    // Primary armour leads; the tunneler is fielded right after.
    expect(depotTrains[0]).not.toBe('tunneler');
    expect(depotTrains).toContain('tunneler');
  });

  it('stops queuing tunnelers once the live-count target is met', () => {
    process.env.AI_STRATEGY_enemy = 'balanced';
    const sid = `dig-cap-${sidCounter++}`;
    const s = ai.ensureSession(sid);
    if (s.perHq) s.perHq.clear();
    if (s.strategies) delete s.strategies;
    // Pretend the depot already trained its first vehicle so the sapper gate is open.
    const h = ai.ensureSession(sid); void h;
    s.lastTickAt = Date.now() - 5000;
    ai.decideActions(depotState(), sid); // advances depotPickIndex past 0
    // A tunneler is already alive → target (1) met → no further tunneler orders.
    s.lastTickAt = Date.now() - 5000;
    const tunneler = { id: 50, kind: 'tunneler', team: 'enemy', x: 100, z: 100, hp: 100, pathLen: 0, armed: false, hasFiringTarget: false };
    const { actions } = ai.decideActions(depotState([tunneler]), sid);
    const tunnelerTrains = actions.filter(
      (a: any) => a.type === 'queue_train' && a.unitKind === 'tunneler');
    expect(tunnelerTrains.length).toBe(0);
  });

  it('routes an idle tunneler straight at the enemy HQ (a dig order)', () => {
    process.env.AI_STRATEGY_enemy = 'balanced';
    const sid = `dig-route-${sidCounter++}`;
    const s = ai.ensureSession(sid);
    if (s.perHq) s.perHq.clear();
    if (s.strategies) delete s.strategies;
    s.attackRetargetCooldown = 0;
    s.lastTickAt = Date.now() - 5000;

    const tunneler = { id: 50, kind: 'tunneler', team: 'enemy', x: 100, z: 100, hp: 100, pathLen: 0, armed: false, hasFiringTarget: false };
    const state = depotState([tunneler]);
    // Give the army a target: the player HQ across the map.
    state.targetBuildings = [
      { id: 99, kind: 'hq', team: 'player', x: 300, z: 300, alive: true },
    ];

    const { actions } = ai.decideActions(state, sid);
    const route = actions.find((a: any) => a.type === 'route_unit' && a.unitId === 50);
    expect(route).toBeDefined();
    expect(route.x).toBeCloseTo(300);
    expect(route.z).toBeCloseTo(300);
  });

  it('does NOT re-route a tunneler that is already cutting (pathLen > 0)', () => {
    process.env.AI_STRATEGY_enemy = 'balanced';
    const sid = `dig-busy-${sidCounter++}`;
    const s = ai.ensureSession(sid);
    if (s.perHq) s.perHq.clear();
    if (s.strategies) delete s.strategies;
    s.attackRetargetCooldown = 0;
    s.lastTickAt = Date.now() - 5000;

    const digging = { id: 51, kind: 'tunneler', team: 'enemy', x: 150, z: 150, hp: 100, pathLen: 1, armed: false, hasFiringTarget: false };
    const state = depotState([digging]);
    state.targetBuildings = [{ id: 99, kind: 'hq', team: 'player', x: 300, z: 300, alive: true }];

    const { actions } = ai.decideActions(state, sid);
    expect(actions.some((a: any) => a.type === 'route_unit' && a.unitId === 51)).toBe(false);
  });
});
