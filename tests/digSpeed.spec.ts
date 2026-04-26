import { describe, it, expect } from 'vitest';
import { digSpeedMultiplier, M_AIR, M_DIRT, M_GRASS, M_PATH, M_WOOD, M_STONE, M_LEAF, M_BEDROCK } from '../src/voxel/Materials';

/**
 * The per-material multiplier table is what makes the tunneler feel like a TBM
 * rather than a uniform cell-eater. A regression here would silently change the
 * "stone takes forever, dirt is fast" gameplay feel, so lock the ordering down.
 */
describe('digSpeedMultiplier', () => {
  it('orders softer materials above harder ones', () => {
    expect(digSpeedMultiplier(M_LEAF)).toBeGreaterThan(digSpeedMultiplier(M_DIRT));
    expect(digSpeedMultiplier(M_DIRT)).toBeGreaterThan(digSpeedMultiplier(M_GRASS));
    expect(digSpeedMultiplier(M_GRASS)).toBeGreaterThan(digSpeedMultiplier(M_PATH));
    expect(digSpeedMultiplier(M_PATH)).toBeGreaterThan(digSpeedMultiplier(M_WOOD));
    expect(digSpeedMultiplier(M_WOOD)).toBeGreaterThan(digSpeedMultiplier(M_STONE));
  });

  it('returns 0 for indestructible materials and 1 for air', () => {
    expect(digSpeedMultiplier(M_BEDROCK)).toBe(0);
    expect(digSpeedMultiplier(M_AIR)).toBe(1);
  });

  it('keeps stone substantially slower than dirt (≥3× difference)', () => {
    const stone = digSpeedMultiplier(M_STONE);
    const dirt = digSpeedMultiplier(M_DIRT);
    expect(stone).toBeGreaterThan(0);
    expect(dirt / stone).toBeGreaterThanOrEqual(3);
  });

  it('returns a sensible default for an unknown material id', () => {
    const v = digSpeedMultiplier(99);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
