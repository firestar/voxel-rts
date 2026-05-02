import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectileManager } from '../src/sim/Projectiles';

/**
 * Coverage for the anti-air intercept behaviour driven by an aa_missile's
 * detonation. We deterministically seed `Math.random()` so each outcome
 * (silent kill / divert / detonate / miss) is exercised in isolation.
 */
describe('ProjectileManager.applyAaIntercept', () => {
  let pm: ProjectileManager;
  let originalRandom: () => number;
  let nextRandom = 0;

  beforeEach(() => {
    pm = new ProjectileManager();
    originalRandom = Math.random;
    Math.random = (): number => nextRandom;
  });
  afterEach(() => {
    Math.random = originalRandom;
  });

  it('silently kills a projectile inside the burst when the roll is in [0, 0.30)', () => {
    nextRandom = 0.10;
    const target = pm.spawn('rpg', 10, 5, 0, 1, 0, 0, 1);
    pm.applyAaIntercept(10, 5, 0, 4);
    expect(target.dead).toBe(true);
    expect(pm.pendingImpacts.length).toBe(0);
  });

  it('diverts a projectile — alive but velocity changes — when the roll is in [0.30, 0.60)', () => {
    nextRandom = 0.45;
    const target = pm.spawn('rpg', 10, 5, 0, 1, 0, 0, 1);
    const vxBefore = target.vx;
    const vyBefore = target.vy;
    pm.applyAaIntercept(10, 5, 0, 4);
    expect(target.dead).toBe(false);
    expect(target.vx === vxBefore && target.vy === vyBefore).toBe(false);
  });

  it('detonates an explosive projectile in place when the roll is in [0.60, 0.90)', () => {
    nextRandom = 0.75;
    const target = pm.spawn('rpg', 10, 5, 0, 1, 0, 0, 1);
    pm.applyAaIntercept(10, 5, 0, 4);
    expect(target.dead).toBe(true);
    expect(pm.pendingImpacts.length).toBe(1);
    expect(pm.pendingImpacts[0]!.kind).toBe('rpg');
  });

  it('leaves the projectile untouched when the roll is in [0.90, 1.0) — the 10% miss band', () => {
    nextRandom = 0.95;
    const target = pm.spawn('rpg', 10, 5, 0, 1, 0, 0, 1);
    const vxBefore = target.vx;
    const vyBefore = target.vy;
    pm.applyAaIntercept(10, 5, 0, 4);
    expect(target.dead).toBe(false);
    expect(target.vx).toBe(vxBefore);
    expect(target.vy).toBe(vyBefore);
  });

  it('skips aa_missiles (no friendly-fire on the AA itself)', () => {
    nextRandom = 0;
    const missile = pm.spawn('aa_missile', 10, 5, 0, 1, 0, 0, -1000);
    pm.applyAaIntercept(10, 5, 0, 8);
    expect(missile.dead).toBe(false);
  });

  it('only affects projectiles inside the burst sphere', () => {
    nextRandom = 0;
    const inside = pm.spawn('rpg', 10, 5, 0, 1, 0, 0, 1);
    const outside = pm.spawn('rpg', 30, 5, 0, 1, 0, 0, 2);
    pm.applyAaIntercept(10, 5, 0, 4);
    expect(inside.dead).toBe(true);
    expect(outside.dead).toBe(false);
  });
});
