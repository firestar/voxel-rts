import { describe, it, expect } from 'vitest';
import { assignAAInterceptors, AAVehicleInput, AAProjectileInput } from '../src/sim/AATargeting';

/**
 * Goal B — anti-air targeting (iter80). Before the fix, AA interception ran
 * ONLY for the player, so AI anti-air vehicles never fired; and the friendly
 * check was player-centric. These tests pin the corrected pure rules.
 */

function veh(over: Partial<AAVehicleInput> & { id: number; team: string }): AAVehicleInput {
  return { x: 0, y: 0, z: 0, rangeMeters: 150, ...over };
}
function proj(over: Partial<AAProjectileInput> & { id: number; ownerTeam: string | null }): AAProjectileInput {
  return { dead: false, kind: 'tank_shell', x: 0, y: 10, z: 0, ...over };
}

describe('AA interceptor assignment (goal B)', () => {
  it('an AI (enemy) AA vehicle intercepts an enemy-of-it (player) round — not player-only', () => {
    const v = [veh({ id: 1, team: 'enemy', x: 0, y: 0, z: 0 })];
    const p = [proj({ id: 100, ownerTeam: 'player', x: 5, y: 8, z: 0 })];
    const out = assignAAInterceptors(v, p);
    expect(out.get(1)).toBe(100);
  });

  it('never intercepts an own-team round (no friendly fire)', () => {
    const v = [veh({ id: 1, team: 'enemy' })];
    const p = [proj({ id: 100, ownerTeam: 'enemy', x: 3, y: 8, z: 0 })];
    expect(assignAAInterceptors(v, p).size).toBe(0);
  });

  it('ignores rounds beyond range and dead/aa_missile rounds', () => {
    const v = [veh({ id: 1, team: 'enemy', rangeMeters: 10 })];
    const far = proj({ id: 1, ownerTeam: 'player', x: 100, y: 8, z: 0 });
    const dead = proj({ id: 2, ownerTeam: 'player', x: 2, y: 8, z: 0, dead: true });
    const interceptor = proj({ id: 3, ownerTeam: 'player', x: 2, y: 8, z: 0, kind: 'aa_missile' });
    expect(assignAAInterceptors(v, [far, dead, interceptor]).size).toBe(0);
  });

  it('skips rounds with no known owner team (building / un-owned)', () => {
    const v = [veh({ id: 1, team: 'enemy' })];
    const p = [proj({ id: 100, ownerTeam: null, x: 2, y: 8, z: 0 })];
    expect(assignAAInterceptors(v, p).size).toBe(0);
  });

  it('each vehicle takes only its single nearest threat (no double-spend)', () => {
    const v = [veh({ id: 1, team: 'enemy', x: 0, y: 0, z: 0 })];
    const near = proj({ id: 100, ownerTeam: 'player', x: 2, y: 8, z: 0 });
    const farther = proj({ id: 101, ownerTeam: 'player', x: 40, y: 8, z: 0 });
    const out = assignAAInterceptors(v, [farther, near]);
    expect(out.size).toBe(1);
    expect(out.get(1)).toBe(100);
  });

  it('two vehicles split two threats rather than both chasing one', () => {
    const v = [
      veh({ id: 1, team: 'enemy', x: 0, y: 0, z: 0 }),
      veh({ id: 2, team: 'enemy', x: 50, y: 0, z: 0 }),
    ];
    const a = proj({ id: 100, ownerTeam: 'player', x: 1, y: 8, z: 0 });   // nearest v1
    const b = proj({ id: 101, ownerTeam: 'player', x: 49, y: 8, z: 0 });  // nearest v2
    const out = assignAAInterceptors(v, [a, b]);
    expect(out.get(1)).toBe(100);
    expect(out.get(2)).toBe(101);
  });
});
