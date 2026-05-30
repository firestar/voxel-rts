import { describe, it, expect } from 'vitest';
import { CivilianSystem, CivilianDeps } from '../src/sim/Civilians';
import type { Unit } from '../src/sim/Units';
import type { Building } from '../src/sim/Buildings';

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
});
