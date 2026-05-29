import { describe, it, expect, afterEach } from 'vitest';

/**
 * Goal D — build-order variation. Each AI strategy (wired to AI_STRATEGY_<team>
 * / AI_STRATEGY_DEFAULT, or a per-session seed-random fallback) must produce a
 * visibly different opening. `strategyForTeam` reads AI_STRATEGY_<team> from
 * live process.env per call, so we drive variants by setting the team env knob
 * — no module reload needed.
 *
 * The key distinguishing behaviour is WHEN the vehicle depot is placed:
 *  - tech_air rushes it (depotFarmReq 1) so its 75 s construction timer
 *    finishes inside a normal match and the team actually fields tanks / AA /
 *    rocket trucks;
 *  - balanced waits for 2 farms; econ_boom for 3; military_rush never techs.
 */

// Load once with a clean strategy env so STRATEGY_DEFAULT is empty (the
// seed-random fallback path) and per-team knobs drive each test.
process.env.AI_SERVER_TEST = '1';
delete process.env.AI_STRATEGY_DEFAULT;
delete process.env.AI_STRATEGY_enemy;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ai = require('../ai-server.cjs');

function stateWith(kinds: string[]): any {
  const enemyBuildings: any[] = [
    { id: 1, kind: 'hq', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1 },
  ];
  let id = 2;
  for (const k of kinds) {
    enemyBuildings.push({ id: id++, kind: k, team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 });
  }
  return {
    enemyHqs: [{ id: 1, team: 'enemy', alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
    enemyBuildings,
    targetBuildings: [], playerBuildings: [], enemyUnits: [],
    workers: Array.from({ length: 6 }, (_, i) => ({ id: 300 + i, team: 'enemy', focus: 'mine', taskKind: 'mine' })),
    enemyResources: { food: 1000, metals: 1000, wood: 1000 },
    teamResources: { enemy: { food: 1000, metals: 1000, wood: 1000, popCap: 60 } },
    teamPopUsed: { enemy: 6 },
    enemyUnitCount: 6,
  };
}

let sidCounter = 0;
/** Run one brain cycle with cooldowns elapsed; return placed building kinds. */
function nextPlacement(strategy: string | null, state: any): string[] {
  if (strategy) process.env.AI_STRATEGY_enemy = strategy;
  else delete process.env.AI_STRATEGY_enemy;
  const sid = `bo-${sidCounter++}`;
  const s = ai.ensureSession(sid);
  if (s.perHq) s.perHq.clear();
  if (s.strategies) delete s.strategies;
  s.lastTickAt = Date.now() - 5000; // force dt→2s so placeCooldown elapses
  const { actions } = ai.decideActions(state, sid);
  return actions.filter((a: any) => a.type === 'place_building').map((a: any) => a.kind);
}

afterEach(() => { delete process.env.AI_STRATEGY_enemy; });

describe('AI build-order strategies (goal D)', () => {
  it('tech_air rushes the vehicle depot after just 1 farm + 1 hood', () => {
    expect(nextPlacement('tech_air', stateWith(['barracks', 'farm', 'neighborhood']))).toContain('vehicle_depot');
  });

  it('balanced does NOT depot at 1 farm (builds a 2nd farm first), then depots at 2 farms', () => {
    const at1 = nextPlacement('balanced', stateWith(['barracks', 'farm', 'neighborhood']));
    expect(at1).not.toContain('vehicle_depot');
    expect(at1).toContain('farm');
    const at2 = nextPlacement('balanced', stateWith(['barracks', 'farm', 'farm', 'neighborhood']));
    expect(at2).toContain('vehicle_depot');
  });

  it('econ_boom defers the depot past 2 farms (still building economy)', () => {
    const at2 = nextPlacement('econ_boom', stateWith(['barracks', 'farm', 'farm', 'neighborhood']));
    expect(at2).not.toContain('vehicle_depot');
    expect(at2).toContain('farm');
  });

  it('military_rush never techs to a depot — expands barracks instead', () => {
    const placed = nextPlacement('military_rush', stateWith(['barracks', 'farm', 'neighborhood']));
    expect(placed).not.toContain('vehicle_depot');
    expect(placed).toContain('barracks');
  });

  it('tech_air leads its depot rotation with the aa_vehicle (its namesake fields reliably)', () => {
    process.env.AI_STRATEGY_enemy = 'tech_air';
    const state: any = {
      enemyHqs: [{ id: 1, team: 'enemy', alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
      enemyBuildings: [
        { id: 1, kind: 'hq', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1 },
        { id: 2, kind: 'barracks', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
        { id: 9, kind: 'vehicle_depot', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0 },
      ],
      targetBuildings: [], playerBuildings: [], enemyUnits: [],
      workers: Array.from({ length: 6 }, (_, i) => ({ id: 200 + i, team: 'enemy', focus: 'mine', taskKind: 'mine' })),
      enemyResources: { food: 2000, metals: 3000, wood: 2000 },
      teamResources: { enemy: { food: 2000, metals: 3000, wood: 2000, popCap: 60 } },
      teamPopUsed: { enemy: 6 }, enemyUnitCount: 6,
    };
    const sid = 'tech-depot';
    const s = ai.ensureSession(sid);
    if (s.perHq) s.perHq.clear();
    if (s.strategies) delete s.strategies;
    s.lastTickAt = Date.now() - 5000;
    const { actions } = ai.decideActions(state, sid);
    const depotTrains = actions
      .filter((a: any) => a.type === 'queue_train' && a.buildingId === 9)
      .map((a: any) => a.unitKind);
    expect(depotTrains[0]).toBe('aa_vehicle');
  });

  it('seed-random fallback assigns a valid strategy per team when no env override', () => {
    const sid = `rand-${sidCounter++}`;
    delete process.env.AI_STRATEGY_enemy;
    const s = ai.ensureSession(sid);
    if (s.strategies) delete s.strategies;
    s.lastTickAt = Date.now() - 5000;
    ai.decideActions(stateWith(['barracks', 'farm', 'neighborhood']), sid);
    expect(s.strategies).toBeDefined();
    expect(['balanced', 'econ_boom', 'military_rush', 'tech_air']).toContain(s.strategies.enemy);
  });
});
