import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

/**
 * Server-authoritative civilian system (game-server.cjs `tickCivilians` +
 * `tickCivilianUpkeep`). Covers the rules the player reported broken:
 *   - a hood spawns up to its client-synced `civilianCap` (tier × 5), NOT a
 *     fixed tier-1 count of 5 — a tier-3 hood grows to 15;
 *   - a hood mid-EXPAND (upgradeState 'pending' but civilianCap still > 0)
 *     KEEPS its residents — they are not reaped;
 *   - destroying the hood (or capacity → 0) removes its residents;
 *   - each civilian drains 2 food/min from its owner; when food can't cover
 *     it, civilians starve one at a time.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string };
  tick: (dt: number) => void;
  state: {
    tick: number;
    buildings: Map<number, any>;
    buildingsByTag: Map<string, number>;
    resources: Map<string, { food: number; metals: number; wood: number; popCap: number }>;
    entities: Map<number, any>;
    byTag: Map<string, number>;
    projectiles: Map<number, unknown>;
    projectilesByTag: Map<string, number>;
    voxelOverrides: Map<number, number>;
    voxelEdits: unknown[];
    voxelEditSeq: number;
    projectileImpactSeq: number;
    saplings: unknown[];
  };
};

function reset(): void {
  gs.applyCommand({ type: 'reset_state' });
}

function placeHood(tag: string, owner: string, civilianCap: number, upgradeState = 'enabled'): number {
  const r = gs.applyCommand({
    type: 'place_building',
    clientTag: tag, owner, kind: 'neighborhood',
    ox: 100, oz: 100, floorY: 80,
    cellsW: 4, cellsD: 4,
    upgradeState, hp: 100, maxHp: 100,
    civilianCap,
  });
  expect(r.ok).toBe(true);
  return gs.state.buildingsByTag.get(tag)!;
}

function setFood(owner: string, food: number): void {
  gs.applyCommand({ type: 'set_resources', owner, food });
}

function civCount(owner?: string): number {
  let n = 0;
  for (const e of gs.state.entities.values()) {
    if (e.kind !== 'civilian' || e.hp <= 0) continue;
    if (owner && e.owner !== owner) continue;
    n++;
  }
  return n;
}

/** Tick `seconds` in 0.5 s steps so spawn cadences / starve intervals advance
 *  the way they would in the live 20 Hz loop. */
function tickFor(seconds: number): void {
  const steps = Math.round(seconds / 0.5);
  for (let i = 0; i < steps; i++) gs.tick(0.5);
}

describe('server civilians — spawning respects tier × 5', () => {
  beforeEach(reset);

  it('grows a tier-3 hood up to 15 residents, not the old hardcoded 5', () => {
    placeHood('h15', 'enemy', 15);
    setFood('enemy', 100000); // plenty so upkeep never starves the ramp
    // First resident spawns on the first tick; the rest at 10 s cadence.
    // 15 residents → ~140 s. Tick generously and assert it reaches the cap.
    tickFor(160);
    expect(civCount('enemy')).toBe(15);
    // And does not exceed it.
    tickFor(30);
    expect(civCount('enemy')).toBe(15);
  });

  it('a tier-1 hood (cap 5) stops at 5', () => {
    placeHood('h5', 'enemy', 5);
    setFood('enemy', 100000);
    tickFor(60);
    expect(civCount('enemy')).toBe(5);
  });
});

describe('server civilians — residents survive a mid-EXPAND', () => {
  beforeEach(reset);

  it('keeps residents when the hood flips to pending (capacity stays > 0)', () => {
    const id = placeHood('hx', 'enemy', 5);
    setFood('enemy', 100000);
    tickFor(60);
    expect(civCount('enemy')).toBe(5);

    // Player orders an expand: the hood flips to 'pending' while the new house
    // is built, but its current houses still stand so the client keeps
    // civilianCap > 0. The residents must NOT be reaped.
    const b = gs.state.buildings.get(id)!;
    b.upgradeState = 'pending';
    tickFor(5);
    expect(civCount('enemy')).toBe(5);

    // Expand completes: capacity rises to tier 2 (10) and the hood grows the
    // new house's residents on the normal cadence.
    b.upgradeState = 'enabled';
    b.civilianCap = 10;
    tickFor(60);
    expect(civCount('enemy')).toBe(10);
  });

  it('reaps residents when the hood is destroyed', () => {
    const id = placeHood('hd', 'enemy', 5);
    setFood('enemy', 100000);
    tickFor(60);
    expect(civCount('enemy')).toBe(5);
    gs.state.buildings.get(id)!.destroyed = true;
    gs.tick(0.5);
    expect(civCount('enemy')).toBe(0);
  });
});

describe('server civilians — food upkeep + starvation', () => {
  beforeEach(reset);

  it('drains 2 food/min per civilian from an AI owner', () => {
    placeHood('hu', 'enemy', 5);
    setFood('enemy', 100000);
    tickFor(60);                       // grow 5 residents
    expect(civCount('enemy')).toBe(5);
    const r = gs.state.resources.get('enemy')!;
    r.food = 1000;                     // reset to a known level
    // 5 civilians × 2/min = 10 food/min. Over 60 s → ~10 food drained.
    tickFor(60);
    expect(r.food).toBeGreaterThan(985);
    expect(r.food).toBeLessThan(995);  // ~990 (10 drained); never grows
    expect(civCount('enemy')).toBe(5); // well-fed, none starve
  });

  it('starves the population down when food cannot cover upkeep', () => {
    placeHood('hs', 'enemy', 5);
    setFood('enemy', 100000);
    tickFor(60);
    expect(civCount('enemy')).toBe(5);
    setFood('enemy', 0);               // bankrupt → no new spawns + starvation
    // One civilian dies every CIVILIAN_STARVE_INTERVAL_S (5 s) and the bankrupt
    // hood can't re-grow them, so the population falls to 0 within ~30 s.
    tickFor(30);
    expect(civCount('enemy')).toBe(0);
    expect(gs.state.resources.get('enemy')!.food).toBe(0);
  });
});
