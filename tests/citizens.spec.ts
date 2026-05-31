import { describe, it, expect } from 'vitest';
import { CivilianSystem, CivilianDeps } from '../src/sim/Civilians';
import type { Unit } from '../src/sim/Units';
import { neighborhoodHousing, populationCapsFor, POP_PER_HQ } from '../src/sim/Buildings';
import type { Building, BuildingTeam } from '../src/sim/Buildings';

/**
 * Headless coverage for the neighborhood citizen lifecycle:
 *   - one citizen created every 10 s while below the tier × 5 quota,
 *   - `citizenSpawnProgress` fills 0 → 1 across the 10 s countdown and
 *     drops to -1 once the lot is fully housed,
 *   - a death re-opens a slot so the lot re-grows a replacement.
 *
 * The CivilianSystem only touches a handful of structural fields on units /
 * buildings, so the test feeds it minimal fakes through the same
 * `CivilianDeps` seam `Game` uses.
 */

let nextUnitId = 1;

function makeNeighborhood(overrides: Partial<Building> = {}): Building {
  return {
    id: 42,
    spec: { kind: 'neighborhood', cellsW: 6, cellsD: 6 },
    ox: 0, oz: 0,
    destroyed: false,
    healthRefVoxels: 100,            // initial build finished
    upgradeState: 'enabled',
    upgradeTracks: {},               // tier 1 → 5 housing
    citizenSpawnProgress: -1,
    ...overrides,
  } as unknown as Building;
}

function makeDeps(building: Building): {
  deps: CivilianDeps; units: Unit[]; buildings: Building[];
} {
  const units: Unit[] = [];
  const buildings: Building[] = [building];
  const deps = {
    units: { units } as unknown as CivilianDeps['units'],
    buildings: { buildings } as unknown as CivilianDeps['buildings'],
    spawnCivilian: (x: number, y: number, z: number): Unit => {
      const u = { id: nextUnitId++, kind: 'civilian', hp: 20, x, y, z, path: [] } as unknown as Unit;
      units.push(u);
      return u;
    },
    routeCivilian: (): void => { /* no-op for the headless test */ },
    surfaceY: (): number => 0,
  } satisfies CivilianDeps;
  return { deps, units, buildings };
}

function liveCivilians(units: Unit[]): number {
  return units.filter(u => u.kind === 'civilian' && u.hp > 0).length;
}

describe('neighborhood citizens', () => {
  it('creates one citizen every 10 s up to the tier × 5 quota', () => {
    const sys = new CivilianSystem();
    const b = makeNeighborhood();
    const { deps, units } = makeDeps(b);

    // First tick: the initial countdown is zero, so the first resident is
    // created immediately and the next 10 s cycle begins.
    sys.tick(0.016, deps);
    expect(liveCivilians(units)).toBe(1);
    expect(b.citizenSpawnProgress).toBeCloseTo(0, 2);

    // Halfway through the 10 s cycle the creation bar is ~50 % and no new
    // citizen has appeared yet.
    sys.tick(5, deps);
    expect(liveCivilians(units)).toBe(1);
    expect(b.citizenSpawnProgress).toBeGreaterThan(0.45);
    expect(b.citizenSpawnProgress).toBeLessThan(0.55);

    // The remaining four residents arrive one per 10 s window.
    for (let i = 0; i < 4; i++) sys.tick(10, deps);
    expect(liveCivilians(units)).toBe(5);

    // Quota reached → no citizen in progress, bar hidden.
    sys.tick(1, deps);
    expect(liveCivilians(units)).toBe(5);
    expect(b.citizenSpawnProgress).toBe(-1);
  });

  it('re-grows a replacement after a citizen is killed', () => {
    const sys = new CivilianSystem();
    const b = makeNeighborhood();
    const { deps, units } = makeDeps(b);

    // Fill the lot to its quota of 5.
    sys.tick(0.016, deps);
    for (let i = 0; i < 4; i++) sys.tick(10, deps);
    expect(liveCivilians(units)).toBe(5);

    // Kill one resident — the lot is now below quota again.
    const victim = units.find(u => u.kind === 'civilian')!;
    victim.hp = 0;
    sys.tick(0.016, deps);              // reap the dead resident
    expect(liveCivilians(units)).toBe(4);
    expect(b.citizenSpawnProgress).toBeGreaterThanOrEqual(0); // creating a replacement

    // After the 10 s replacement window the lot is back to full strength.
    sys.tick(10, deps);
    expect(liveCivilians(units)).toBe(5);
  });

  it('keeps existing residents while the hood is mid-expand', () => {
    const sys = new CivilianSystem();
    // A tier-1 hood that has finished its initial build, fully housed.
    const b = makeNeighborhood();
    const { deps, units } = makeDeps(b);
    sys.tick(0.016, deps);
    for (let i = 0; i < 4; i++) sys.tick(10, deps);
    expect(liveCivilians(units)).toBe(5);

    // Player orders an expand: the lot flips to `pending` while the new
    // house is constructed, but the existing houses are still standing
    // (healthRefVoxels stays > 0) and the expand track only bumps on
    // completion. The CivilianSystem must NOT despawn the residents.
    b.upgradeState = 'pending';
    b.activeUpgradeId = 'expand';
    for (let i = 0; i < 5; i++) sys.tick(2, deps);
    expect(liveCivilians(units)).toBe(5); // residents stayed through the upgrade
  });

  it('removes residents only when their neighborhood is destroyed', () => {
    const sys = new CivilianSystem();
    const b = makeNeighborhood();
    const { deps, units } = makeDeps(b);
    sys.tick(0.016, deps);
    for (let i = 0; i < 4; i++) sys.tick(10, deps);
    expect(liveCivilians(units)).toBe(5);

    // Residents must NOT vanish for any benign reason — a quiet tick with the
    // hood fully housed leaves every one of them alive.
    for (let i = 0; i < 10; i++) sys.tick(1, deps);
    expect(liveCivilians(units)).toBe(5);

    // Destroy the neighborhood: its residents go away with it (killed, hp=0),
    // which is one of the only two sanctioned removal triggers.
    b.destroyed = true;
    sys.tick(0.016, deps);
    expect(liveCivilians(units)).toBe(0);
    expect(units.every(u => u.hp <= 0)).toBe(true);
  });
});

describe('neighborhoodHousing', () => {
  it('counts 5 population per standing house and survives a mid-expand', () => {
    // Non-neighborhood → no housing.
    expect(neighborhoodHousing(makeNeighborhood({
      spec: { kind: 'barracks', cellsW: 4, cellsD: 4 },
    } as Partial<Building>) )).toBe(0);

    // Initial build not finished → no houses standing yet.
    expect(neighborhoodHousing(makeNeighborhood({ healthRefVoxels: 0 }))).toBe(0);

    // Destroyed lot → nothing.
    expect(neighborhoodHousing(makeNeighborhood({ destroyed: true }))).toBe(0);

    // Built tier-1 hood → one house → 5 population.
    expect(neighborhoodHousing(makeNeighborhood())).toBe(5);

    // Mid-EXPAND (pending) tier-1 hood → existing house still counts (5),
    // because the expand track only increments on completion. This is the
    // key guarantee: the pop cap doesn't collapse during construction.
    expect(neighborhoodHousing(makeNeighborhood({
      upgradeState: 'pending', activeUpgradeId: 'expand',
    }))).toBe(5);

    // Completed expand → two houses → 10 population.
    expect(neighborhoodHousing(makeNeighborhood({
      upgradeTracks: { expand: 1 },
    }))).toBe(10);
  });
});

describe('populationCapsFor', () => {
  const TEAMS: BuildingTeam[] = ['player', 'enemy', 'enemy2'];

  function hq(team: BuildingTeam, overrides: Partial<Building> = {}): Building {
    return { id: 1, team, spec: { kind: 'hq', cellsW: 6, cellsD: 6 }, ox: 0, oz: 0,
      destroyed: false, healthRefVoxels: 100, upgradeState: 'enabled',
      upgradeTracks: {}, ...overrides } as unknown as Building;
  }
  function hood(team: BuildingTeam, overrides: Partial<Building> = {}): Building {
    return makeNeighborhood({ team, ...overrides } as Partial<Building>);
  }

  it('starts every team at the base cap with only an HQ', () => {
    const caps = populationCapsFor([hq('player')], new Map(), false, TEAMS);
    expect(caps.get('player')).toBe(POP_PER_HQ);   // 10
    expect(caps.get('enemy')).toBe(POP_PER_HQ);     // no buildings → assumed 1 HQ
    expect(caps.get('enemy2')).toBe(POP_PER_HQ);
  });

  it('adds tier × 5 housing per neighborhood off the buildings when civilians are not simulated', () => {
    // AI-vs-AI / server world: civSystemActive=false → housing read directly.
    const buildings = [
      hq('enemy'),
      hood('enemy'),                                   // tier 1 → +5
      hood('enemy', { id: 43, upgradeTracks: { expand: 2 } }), // tier 3 → +15
    ];
    const caps = populationCapsFor(buildings, new Map(), false, TEAMS);
    expect(caps.get('enemy')).toBe(POP_PER_HQ + 5 + 15); // 30
  });

  it('does NOT collapse the cap while a hood is mid-EXPAND', () => {
    // The exact bug: a pending expand used to drop the hood's housing to 0,
    // crashing the cap to the base 10. neighborhoodHousing still counts the
    // standing houses, so the cap holds at base + current housing.
    const enabled = populationCapsFor(
      [hq('player'), hood('player')], new Map(), false, TEAMS);
    const midExpand = populationCapsFor(
      [hq('player'), hood('player', { upgradeState: 'pending', activeUpgradeId: 'expand' } as Partial<Building>)],
      new Map(), false, TEAMS);
    expect(enabled.get('player')).toBe(POP_PER_HQ + 5);   // 15
    expect(midExpand.get('player')).toBe(POP_PER_HQ + 5); // still 15, not 10
  });

  it('tracks live citizens clamped to housing when the civilian system is active', () => {
    // Campaign world: civSystemActive=true → min(civilians, housing).
    const buildings = [hq('player'), hood('player', { upgradeTracks: { expand: 1 } })]; // housing 10
    // Only 3 citizens grown so far → cap = 10 base + 3.
    expect(populationCapsFor(buildings, new Map([['player', 3]]), true, TEAMS).get('player'))
      .toBe(POP_PER_HQ + 3);
    // Fully housed (10 citizens) → cap = 10 base + 10, never more than housing.
    expect(populationCapsFor(buildings, new Map([['player', 20]]), true, TEAMS).get('player'))
      .toBe(POP_PER_HQ + 10);
  });

  it('scales the base cap with multiple HQs and ignores destroyed buildings', () => {
    const buildings = [
      hq('enemy2'), hq('enemy2', { id: 2 }),                 // 2 HQs → 20 base
      hood('enemy2'),                                         // +5
      hood('enemy2', { id: 44, destroyed: true }),            // destroyed → 0
    ];
    expect(populationCapsFor(buildings, new Map(), false, TEAMS).get('enemy2'))
      .toBe(POP_PER_HQ * 2 + 5); // 25
  });
});
