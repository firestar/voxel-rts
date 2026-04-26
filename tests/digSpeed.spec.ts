import { describe, it, expect } from 'vitest';
import {
  digSpeedMultiplier, groundSpeedMultiplier, trackDamageFor,
  M_AIR, M_DIRT, M_GRASS, M_PATH, M_WOOD, M_STONE, M_LEAF, M_BEDROCK, M_MUD,
} from '../src/voxel/Materials';

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

  it('mud is the fastest material to dig (no resistance)', () => {
    expect(digSpeedMultiplier(M_MUD)).toBeGreaterThan(digSpeedMultiplier(M_DIRT));
  });
});

describe('groundSpeedMultiplier', () => {
  it('paths are the fastest, mud is the slowest', () => {
    expect(groundSpeedMultiplier(M_PATH)).toBeGreaterThan(groundSpeedMultiplier(M_GRASS));
    expect(groundSpeedMultiplier(M_GRASS)).toBeGreaterThan(groundSpeedMultiplier(M_MUD));
  });

  it('mud cuts speed roughly in half or worse', () => {
    expect(groundSpeedMultiplier(M_MUD)).toBeLessThanOrEqual(0.5);
    expect(groundSpeedMultiplier(M_MUD)).toBeGreaterThan(0);
  });
});

describe('trackDamageFor', () => {
  it('mud takes the heaviest tracks; dirt+path much less', () => {
    const mud = trackDamageFor(M_MUD);
    const grass = trackDamageFor(M_GRASS);
    const dirt = trackDamageFor(M_DIRT);
    const path = trackDamageFor(M_PATH);
    expect(mud.peak).toBeGreaterThan(grass.peak);
    expect(grass.peak).toBeGreaterThan(dirt.peak);
    expect(dirt.peak).toBeGreaterThan(path.peak);
  });

  it('hard surfaces leave no track marks', () => {
    expect(trackDamageFor(M_STONE).peak).toBe(0);
    expect(trackDamageFor(M_WOOD).peak).toBe(0);
    expect(trackDamageFor(M_LEAF).peak).toBe(0);
    expect(trackDamageFor(M_BEDROCK).peak).toBe(0);
  });
});
