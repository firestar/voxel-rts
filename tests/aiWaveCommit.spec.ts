import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Gather-time force-commit (GATHER_MAX_S).
 *
 * The wave gate holds attackers home until WAVE_SIZE (5) are idle-and-ready at
 * once. A team that can't reach 5 — pop-capped, or bleeding to attrition —
 * would otherwise never attack. After GATHER_MAX_S of massing with ≥2 ready,
 * the brain force-commits the wave. This test pins both halves: it HOLDS a
 * sub-WAVE_SIZE pack early, and RELEASES it once the massing timer elapses.
 */

process.env.AI_SERVER_TEST = '1';
delete process.env.AI_GATHER_MAX_S; // use the default (30 s)
delete process.env.AI_STRATEGY_DEFAULT;
delete process.env.AI_STRATEGY_enemy;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ai = require('../ai-server.cjs');

const GATHER_MAX_MS = 30_000;

/** 1 enemy HQ + 3 idle armed soldiers parked away from home (so they read as
 *  attackers, not home defenders), with a player HQ to march on. */
function combatState(): any {
  const soldier = (id: number) => ({
    id, kind: 'soldier', team: 'enemy', x: 160, z: 160, hp: 100,
    armed: true, hasFiringTarget: false, pathLen: 0,
  });
  return {
    enemyHqs: [{ id: 1, team: 'enemy', alive: true, x: 100, z: 100, ox: 100, oz: 100, cellsW: 6, cellsD: 5 }],
    enemyBuildings: [
      { id: 1, kind: 'hq', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0, x: 100, z: 100 },
      { id: 2, kind: 'barracks', team: 'enemy', upgradeState: 'enabled', anchorHqId: 1, trainQueueLen: 0, x: 110, z: 100 },
    ],
    targetBuildings: [{ id: 99, kind: 'hq', team: 'player', x: 300, z: 300, alive: true }],
    playerBuildings: [{ id: 99, kind: 'hq', team: 'player', x: 300, z: 300, alive: true }],
    enemyUnits: [soldier(50), soldier(51), soldier(52)],
    workers: [],
    enemyResources: { food: 500, metals: 500, wood: 500 },
    teamResources: { enemy: { food: 500, metals: 500, wood: 500, popCap: 60 } },
    teamPopUsed: { enemy: 3 }, enemyUnitCount: 3,
  };
}

function soldierRoutes(actions: any[]): any[] {
  return actions.filter(a => a.type === 'route_unit' && [50, 51, 52].includes(a.unitId));
}

let sid = 0;
function freshSession() {
  const id = `wave-${sid++}`;
  const s = ai.ensureSession(id);
  if (s.perHq) s.perHq.clear();
  if (s.strategies) delete s.strategies;
  s.attackRetargetCooldown = 0;
  s.lastTickAt = Date.now() - 2000;
  return { id, s };
}

describe('wave gather-time force-commit', () => {
  beforeEach(() => { delete process.env.AI_STRATEGY_enemy; });

  it('HOLDS a sub-WAVE_SIZE pack (3 < 5) while still massing', () => {
    const { id } = freshSession();
    const actions = ai.decideActions(combatState(), id).actions;
    expect(soldierRoutes(actions).length).toBe(0); // held — not enough for a wave yet
  });

  it('FORCE-COMMITS the pack once it has massed past GATHER_MAX_S', () => {
    const { id, s } = freshSession();
    // Pretend the team has already accumulated GATHER_MAX_S of massing time
    // (seconds). The next attack-cycle pushes it over the threshold.
    s.massingTimeByTeam = { enemy: GATHER_MAX_MS / 1000 };
    const actions = ai.decideActions(combatState(), id).actions;
    const routes = soldierRoutes(actions);
    expect(routes.length).toBe(3);                 // all three committed
    for (const r of routes) {                      // toward the enemy HQ
      expect(r.x).toBeGreaterThan(160);
      expect(r.z).toBeGreaterThan(160);
    }
  });

  it('a full WAVE_SIZE pack still releases immediately (no regression)', () => {
    const { id } = freshSession();
    const st = combatState();
    for (let k = 53; k <= 54; k++) {
      st.enemyUnits.push({ id: k, kind: 'soldier', team: 'enemy', x: 160, z: 160, hp: 100, armed: true, hasFiringTarget: false, pathLen: 0 });
    }
    st.enemyUnitCount = 5;
    const routes = ai.decideActions(st, id).actions
      .filter((a: any) => a.type === 'route_unit' && a.unitId >= 50);
    expect(routes.length).toBe(5); // 5 ready ≥ WAVE_SIZE → immediate release
  });
});
