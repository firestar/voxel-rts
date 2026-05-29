import { describe, it, expect, vi } from 'vitest';
import { RemoteAIClient } from '../src/sim/RemoteAIClient';

/**
 * Regression for the firingTarget route short-circuit / stranding fix (iter84,
 * RemoteAIClient.applyRouteUnit). A vehicle that perpetually re-acquires an
 * in-range chaff target used to ignore EVERY attack-move command (its
 * firingTarget was always set), so it stranded trading shots instead of
 * advancing. The skip is now honoured only for near (hold/micro) goals; a far
 * ADVANCE goal routes anyway (the unit fires while it moves).
 */

function mkDeps(unit: any, routeUnit: any) {
  return { units: { units: [unit] }, surfaceY: () => 0, routeUnit } as any;
}

describe('RemoteAIClient.applyRouteUnit — sticky-fire vs stranding (iter84)', () => {
  it('routes a firing unit when commanded to a FAR objective (advance, not stranded)', () => {
    const client = new RemoteAIClient();
    const unit = { id: 1, kind: 'tank', hp: 100, x: 0, z: 0, firingTarget: { x: 2, y: 0, z: 0 } };
    const routeUnit = vi.fn();
    (client as any).applyRouteUnit({ unitId: 1, x: 100, z: 100 }, mkDeps(unit, routeUnit));
    expect(routeUnit).toHaveBeenCalledTimes(1);
  });

  it('skips routing a firing unit for a NEARBY goal (hold position + keep firing)', () => {
    const client = new RemoteAIClient();
    const unit = { id: 1, kind: 'tank', hp: 100, x: 0, z: 0, firingTarget: { x: 2, y: 0, z: 0 } };
    const routeUnit = vi.fn();
    (client as any).applyRouteUnit({ unitId: 1, x: 3, z: 0 }, mkDeps(unit, routeUnit)); // <16 m
    expect(routeUnit).not.toHaveBeenCalled();
  });

  it('routes a unit with NO firing target regardless of distance', () => {
    const client = new RemoteAIClient();
    const unit = { id: 1, kind: 'tank', hp: 100, x: 0, z: 0, firingTarget: null };
    const routeUnit = vi.fn();
    (client as any).applyRouteUnit({ unitId: 1, x: 3, z: 0 }, mkDeps(unit, routeUnit));
    expect(routeUnit).toHaveBeenCalledTimes(1);
  });
});
