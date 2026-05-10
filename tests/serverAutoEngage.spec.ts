import { describe, it, expect, beforeEach } from 'vitest';

process.env.GAME_SERVER_TEST = '1';

interface ServerEntity {
  id: number; clientTag: string | null;
  kind: string; owner: string;
  x: number; y: number; z: number;
  hp: number;
  weapon: null | {
    kind: string;
    rangeMeters: number;
    fireIntervalSec: number;
    lastFireTick: number;
  };
}

interface ServerStateShape {
  tick: number;
  entities: Map<number, ServerEntity>;
  projectiles: Map<number, { id: number; owner: string; ownerId: number; kind: string; vx: number; vy: number; vz: number }>;
  projectilesByTag: Map<string, number>;
  byTag: Map<string, number>;
  voxelOverrides: Map<number, number>;
  voxelEdits: unknown[];
  voxelEditSeq: number;
  projectileImpactSeq: number;
  worldSeed: number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string; id?: number };
  tick: (dt: number) => void;
  state: ServerStateShape;
};

const SERVER_WORLD_X = 3072;
const SERVER_WORLD_Z = 3072;
function voxelIdx(x: number, y: number, z: number): number {
  return (y * SERVER_WORLD_Z + z) * SERVER_WORLD_X + x;
}

function reset(): void {
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.projectileImpactSeq = 0;
  gs.state.tick = 0;
}

function spawnUnit(args: { tag: string; kind?: string; owner?: string; x: number; y: number; z: number; hp?: number }): ServerEntity {
  const r = gs.applyCommand({
    type: 'spawn_entity',
    clientTag: args.tag,
    kind: args.kind ?? 'soldier',
    owner: args.owner ?? 'red',
    x: args.x, y: args.y, z: args.z,
    hp: args.hp ?? 100,
  });
  expect(r.ok).toBe(true);
  return gs.state.entities.get(gs.state.byTag.get(args.tag)!)!;
}

function arm(tag: string, owner: string, weapon: Partial<{
  rangeMeters: number; fireIntervalSec: number;
  projectileSpeed: number; projectileHitRadius: number;
  projectileHitDamage: number; projectileMaxLife: number;
}> = {}): void {
  const r = gs.applyCommand({
    type: 'arm_unit',
    clientTag: tag,
    owner,
    kind: 'bullet_5_56mm',
    rangeMeters: weapon.rangeMeters ?? 30,
    fireIntervalSec: weapon.fireIntervalSec ?? 0.5,
    projectileSpeed: weapon.projectileSpeed ?? 80,
    projectileMaxLife: weapon.projectileMaxLife ?? 3,
    projectileHitRadius: weapon.projectileHitRadius ?? 0.15,
    projectileHitDamage: weapon.projectileHitDamage ?? 25,
    projectileGravityScale: 0,
    projectileDrag: 0,
  });
  expect(r.ok).toBe(true);
}

describe('server auto-engage', () => {
  beforeEach(reset);

  it('unarmed entity never fires', () => {
    spawnUnit({ tag: 'idle', owner: 'red', x: 50, y: 5, z: 50 });
    spawnUnit({ tag: 'foe', owner: 'blue', x: 53, y: 5, z: 50 });
    for (let i = 0; i < 10; i++) gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('armed entity fires at a cross-owner enemy in range', () => {
    spawnUnit({ tag: 'shooter', owner: 'red', x: 100, y: 5, z: 100 });
    spawnUnit({ tag: 'enemy', owner: 'blue', x: 105, y: 5, z: 100 });
    arm('shooter', 'red', { rangeMeters: 20, fireIntervalSec: 1 });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(1);
    const proj = [...gs.state.projectiles.values()][0]!;
    expect(proj.owner).toBe('red');
    // Direction should be roughly +x (target 5 m east).
    expect(proj.vx).toBeGreaterThan(40);
    expect(Math.abs(proj.vy)).toBeLessThan(30);
    expect(Math.abs(proj.vz)).toBeLessThan(1);
  });

  it('does not fire at out-of-range targets', () => {
    spawnUnit({ tag: 'shooter', owner: 'red', x: 200, y: 5, z: 200 });
    spawnUnit({ tag: 'far', owner: 'blue', x: 230, y: 5, z: 200 });
    arm('shooter', 'red', { rangeMeters: 10 });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('does not fire at same-owner units (no friendly fire)', () => {
    spawnUnit({ tag: 'shooter', owner: 'red', x: 300, y: 5, z: 300 });
    spawnUnit({ tag: 'ally', owner: 'red', x: 305, y: 5, z: 300 });
    arm('shooter', 'red', { rangeMeters: 20 });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('skips a target when a wall blocks line-of-sight', () => {
    spawnUnit({ tag: 'shooter', owner: 'red', x: 400, y: 5, z: 400 });
    spawnUnit({ tag: 'enemy', owner: 'blue', x: 405, y: 5, z: 400 });
    // Wall voxel sitting between muzzle (y ≈ 6) and target torso. The
    // muzzle Y in tickAutoEngage is shooter.y + 1.0 so we plant the
    // wall in column (3216, 48, 3200) — voxels for x ≈ 402 m, y ≈ 6 m,
    // z = 400 m.
    const wallVx = Math.floor(402 / 0.125);
    const wallVy = Math.floor(6 / 0.125);
    const wallVz = Math.floor(400 / 0.125);
    gs.state.voxelOverrides.set(voxelIdx(wallVx, wallVy, wallVz), 3 /* M_STONE */);
    arm('shooter', 'red', { rangeMeters: 30 });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('respects the fire-interval cooldown', () => {
    // Fat target HP — survives many hits — and a 3 m gap so each shot
    // resolves on the same tick as it spawns. Projectile-count is
    // therefore not a stable signal; use projectileImpactSeq to count
    // discrete fires.
    spawnUnit({ tag: 'shooter', owner: 'red', x: 500, y: 5, z: 500 });
    spawnUnit({ tag: 'enemy', owner: 'blue', x: 503, y: 5, z: 500, hp: 100000 });
    arm('shooter', 'red', { rangeMeters: 20, fireIntervalSec: 1.0 });
    gs.tick(0.05);
    expect(gs.state.projectileImpactSeq).toBe(1);
    // 5 more ticks at 50 ms = 0.25 s — still inside the 1 s cooldown.
    for (let i = 0; i < 5; i++) gs.tick(0.05);
    expect(gs.state.projectileImpactSeq).toBe(1);
    // 25 more ticks brings cumulative time to 1.55 s — past cooldown.
    for (let i = 0; i < 25; i++) gs.tick(0.05);
    expect(gs.state.projectileImpactSeq).toBeGreaterThanOrEqual(2);
  });

  it('disarm_unit stops the firing', () => {
    spawnUnit({ tag: 'shooter', owner: 'red', x: 600, y: 5, z: 600 });
    spawnUnit({ tag: 'enemy', owner: 'blue', x: 603, y: 5, z: 600, hp: 100000 });
    arm('shooter', 'red', { rangeMeters: 20, fireIntervalSec: 0.05 });
    gs.tick(0.05);
    expect(gs.state.projectileImpactSeq).toBeGreaterThanOrEqual(1);
    const before = gs.state.projectileImpactSeq;
    gs.applyCommand({ type: 'disarm_unit', clientTag: 'shooter', owner: 'red' });
    for (let i = 0; i < 10; i++) gs.tick(0.05);
    // No new fires after disarm.
    expect(gs.state.projectileImpactSeq).toBe(before);
  });

  it('arm_unit refuses cross-owner attempts', () => {
    spawnUnit({ tag: 'redUnit', owner: 'red', x: 700, y: 5, z: 700 });
    const denied = gs.applyCommand({
      type: 'arm_unit',
      clientTag: 'redUnit',
      owner: 'blue',                 // not the unit's owner
      rangeMeters: 10, fireIntervalSec: 1,
    });
    expect(denied.ok).toBe(false);
  });
});
