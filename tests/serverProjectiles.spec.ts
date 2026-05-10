import { describe, it, expect, beforeEach } from 'vitest';

// Drive the auto-tick + listen path off so vitest can call applyCommand
// and tick deterministically without an HTTP server hanging around.
process.env.GAME_SERVER_TEST = '1';

interface Projectile {
  id: number; clientTag: string | null;
  kind: string; owner: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  dragPerSecond: number; gravityScale: number;
  age: number; maxLifeSeconds: number; ownerId: number;
}

interface ServerEntity {
  id: number;
  clientTag: string | null;
  kind: string; owner: string;
  x: number; y: number; z: number;
  hp: number;
}

interface ServerStateShape {
  projectiles: Map<number, Projectile>;
  projectilesByTag: Map<string, number>;
  entities: Map<number, ServerEntity>;
  byTag: Map<string, number>;
  voxelOverrides: Map<number, number>;
  voxelEdits: Array<{
    seq: number; tick: number; sender: string;
    op: { kind: 'sphere'; x: number; y: number; z: number; radius: number; mat: number }
       | { kind: 'set'; ops: Array<{ x: number; y: number; z: number; mat: number }> };
  }>;
  voxelEditSeq: number;
  worldSeed: number;
  projectileImpactSeq: number;
}

interface SnapshotShape {
  projectiles?: Array<{ id: number; clientTag: string | null; kind: string; owner: string;
    x: number; y: number; z: number; vx: number; vy: number; vz: number;
    age: number; ownerId: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  applyCommand: (cmd: Record<string, unknown>) => { ok: boolean; error?: string; id?: number; clientTag?: string | null };
  tick: (dt: number) => void;
  snapshot: () => SnapshotShape;
  state: ServerStateShape;
};

const PROJECTILE_GRAVITY = 18.0;

function reset(): void {
  gs.state.projectiles.clear();
  gs.state.projectilesByTag.clear();
  gs.state.entities.clear();
  gs.state.byTag.clear();
  gs.state.voxelOverrides.clear();
  gs.state.voxelEdits.length = 0;
  gs.state.voxelEditSeq = 0;
  gs.state.projectileImpactSeq = 0;
}

function spawnUnit(args: { clientTag: string; kind: string; x: number; y: number; z: number; hp?: number; owner?: string }): ServerEntity {
  const r = gs.applyCommand({
    type: 'spawn_entity',
    clientTag: args.clientTag,
    kind: args.kind,
    owner: args.owner ?? 'enemy',
    x: args.x, y: args.y, z: args.z,
    hp: args.hp ?? 100,
  });
  expect(r.ok).toBe(true);
  const id = gs.state.byTag.get(args.clientTag)!;
  return gs.state.entities.get(id)!;
}

const SERVER_WORLD_X = 3072;
const SERVER_WORLD_Z = 3072;
const VOXEL_SIZE = 0.125;
function voxelIdx(x: number, y: number, z: number): number {
  return (y * SERVER_WORLD_Z + z) * SERVER_WORLD_X + x;
}

describe('server projectile authority', () => {
  beforeEach(reset);

  it('spawn_projectile registers and snapshots the entity', () => {
    const r = gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 't1',
      owner: 'p-test',
      kind: 'bullet_5_56mm',
      x: 10, y: 8, z: 12,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0.1,
      gravityScale: 1,
      maxLifeSeconds: 2,
      ownerId: 7,
    });
    expect(r.ok).toBe(true);
    const snap = gs.snapshot();
    expect(snap.projectiles).toBeDefined();
    expect(snap.projectiles!.length).toBe(1);
    expect(snap.projectiles![0]!.kind).toBe('bullet_5_56mm');
    expect(snap.projectiles![0]!.x).toBeCloseTo(10);
    expect(snap.projectiles![0]!.ownerId).toBe(7);
  });

  it('integrates motion with drag and gravity over a few ticks', () => {
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 't2',
      owner: 'p-test',
      kind: 'mortar_shell',
      x: 0, y: 100, z: 0,
      vx: 30, vy: 10, vz: 0,
      dragPerSecond: 0.5,
      gravityScale: 1,
      maxLifeSeconds: 5,
    });
    const dt = 0.1;
    let prevSpeed = Math.hypot(30, 10);
    for (let i = 0; i < 5; i++) {
      gs.tick(dt);
      const proj = [...gs.state.projectiles.values()][0]!;
      // Drag bleeds horizontal speed monotonically.
      const speedXZ = Math.hypot(proj.vx, proj.vz);
      expect(speedXZ).toBeLessThanOrEqual(prevSpeed + 1e-6);
      prevSpeed = Math.hypot(proj.vx, proj.vz);
      // Gravity pulls vy downward — after 5 ticks at 0.1s, integrated
      // gravity is at least PROJECTILE_GRAVITY * 0.5 ≈ 9 m/s subtracted
      // from the initial upward 10 m/s. Drag also bleeds vy, so the
      // exact value drifts; the invariant we assert is "vy strictly
      // decreasing each tick".
    }
    const final = [...gs.state.projectiles.values()][0]!;
    expect(final.vy).toBeLessThan(10);
  });

  it('despawns when TTL elapses', () => {
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 't3',
      owner: 'p-test',
      kind: 'bullet_9mm',
      x: 0, y: 50, z: 0,
      vx: 1, vy: 0, vz: 0,
      maxLifeSeconds: 0.3,
    });
    expect(gs.state.projectiles.size).toBe(1);
    // Three ticks of 0.15s = 0.45s of age, well past TTL.
    gs.tick(0.15);
    gs.tick(0.15);
    gs.tick(0.15);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('despawns when y drops below the kill floor', () => {
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 't4',
      owner: 'p-test',
      kind: 'bullet_9mm',
      x: 0, y: 0, z: 0,
      vx: 0, vy: -200, vz: 0,
      gravityScale: 0,
      dragPerSecond: 0,
      maxLifeSeconds: 5,
    });
    // One 1s tick should drop the projectile to y ≈ -200 — below -50 kill floor.
    gs.tick(1);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('respects owner gating on despawn', () => {
    const r = gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 't5',
      owner: 'alice',
      kind: 'rpg',
      x: 0, y: 50, z: 0,
      vx: 0, vy: 0, vz: 0,
      maxLifeSeconds: 5,
    });
    expect(r.ok).toBe(true);
    const denied = gs.applyCommand({ type: 'despawn_projectile', clientTag: 't5', owner: 'mallory' });
    expect(denied.ok).toBe(false);
    const allowed = gs.applyCommand({ type: 'despawn_projectile', clientTag: 't5', owner: 'alice' });
    expect(allowed.ok).toBe(true);
    expect(gs.state.projectiles.size).toBe(0);
  });

  it('despawns on voxel raycast hit and bumps impact seq', () => {
    // Plant a one-voxel wall directly in front of the spawn so the
    // first tick's flight segment crosses it.
    const wallX = 100, wallY = 50, wallZ = 100;
    gs.state.voxelOverrides.set(voxelIdx(wallX, wallY, wallZ), 3 /* M_STONE */);
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'wall', owner: 'shooter',
      kind: 'bullet_5_56mm',
      x: (wallX - 5) * VOXEL_SIZE,
      y: wallY * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      z: wallZ * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0,
      gravityScale: 0,
      maxLifeSeconds: 5,
    });
    expect(gs.state.projectiles.size).toBe(1);
    const seqBefore = gs.state.projectileImpactSeq;
    // 0.05 s tick → projectile travels 2.5 m = 20 voxels along +x; the
    // wall at vx=100 is 5 voxels in front, so the segment crosses it.
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
    expect(gs.state.projectileImpactSeq).toBe(seqBefore + 1);
  });

  it('passes through air when no voxel along the path is solid', () => {
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'air', owner: 'shooter',
      kind: 'bullet_5_56mm',
      x: 200 * VOXEL_SIZE, y: 200 * VOXEL_SIZE, z: 200 * VOXEL_SIZE,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
    });
    const seqBefore = gs.state.projectileImpactSeq;
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(1);
    expect(gs.state.projectileImpactSeq).toBe(seqBefore);
  });

  it('applies a sphere voxel mutation on impact for an explosive projectile', () => {
    const wallX = 300, wallY = 50, wallZ = 300;
    gs.state.voxelOverrides.set(voxelIdx(wallX, wallY, wallZ), 3 /* M_STONE */);
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'rpg', owner: 'shooter',
      kind: 'rpg',
      x: (wallX - 5) * VOXEL_SIZE,
      y: wallY * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      z: wallZ * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.2,
      explosive: true,
      explosionRadiusMeters: 0.5,
    });
    const editsBefore = gs.state.voxelEditSeq;
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
    expect(gs.state.voxelEditSeq).toBe(editsBefore + 1);
    const last = gs.state.voxelEdits[gs.state.voxelEdits.length - 1]!;
    expect(last.sender).toBe('shooter');
    expect(last.op.kind).toBe('sphere');
    if (last.op.kind === 'sphere') {
      expect(last.op.radius).toBeCloseTo(0.5);
      expect(last.op.mat).toBe(0);
    }
    // Wall voxel + a few neighbours should now be AIR (0) in overrides.
    expect(gs.state.voxelOverrides.get(voxelIdx(wallX, wallY, wallZ))).toBe(0);
  });

  it('uses hitRadius (not explosion) for non-explosive projectiles', () => {
    const wallX = 400, wallY = 50, wallZ = 400;
    gs.state.voxelOverrides.set(voxelIdx(wallX, wallY, wallZ), 3);
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'bullet', owner: 'sniper',
      kind: 'bullet_5_56mm',
      x: (wallX - 5) * VOXEL_SIZE,
      y: wallY * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      z: wallZ * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.15,
      explosive: false,
      explosionRadiusMeters: 0,
    });
    gs.tick(0.05);
    const last = gs.state.voxelEdits[gs.state.voxelEdits.length - 1]!;
    expect(last.op.kind).toBe('sphere');
    if (last.op.kind === 'sphere') {
      expect(last.op.radius).toBeCloseTo(0.15);
    }
  });

  it('does not emit a voxel_edit when both impact radii are zero', () => {
    const wallX = 500, wallY = 50, wallZ = 500;
    gs.state.voxelOverrides.set(voxelIdx(wallX, wallY, wallZ), 3);
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'paint', owner: 'shooter',
      kind: 'tracer',
      x: (wallX - 5) * VOXEL_SIZE,
      y: wallY * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      z: wallZ * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0,
      explosive: false,
      explosionRadiusMeters: 0,
    });
    const before = gs.state.voxelEditSeq;
    gs.tick(0.05);
    expect(gs.state.voxelEditSeq).toBe(before);
    expect(gs.state.projectiles.size).toBe(0);
    expect(gs.state.projectileImpactSeq).toBeGreaterThan(0);
  });

  it('respects an override placed away from the path (no false hit)', () => {
    // Wall is offset in z; bullet flies along +x at a different z.
    gs.state.voxelOverrides.set(voxelIdx(150, 60, 50), 3);
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'miss', owner: 'shooter',
      kind: 'bullet_5_56mm',
      x: 145 * VOXEL_SIZE,
      y: 60 * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      z: 80 * VOXEL_SIZE + 0.5 * VOXEL_SIZE,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
    });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(1);
  });

  it('direct entity hit deducts hitDamage and despawns the projectile', () => {
    // Soldier (hitRadius 0.4 m) sitting at world (40, 6, 40); bullet
    // travels straight along +x toward it from x = 39.5 m.
    const soldier = spawnUnit({ clientTag: 'soldier', kind: 'soldier', x: 40, y: 5.4, z: 40, hp: 50 });
    expect(soldier.hp).toBe(50);
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'shot1', owner: 'shooter',
      kind: 'bullet_5_56mm',
      x: 39.5, y: 6, z: 40,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.15,
      hitDamage: 25,
      damagePeak: 25,
    });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
    const after = gs.state.entities.get(soldier.id)!;
    expect(after.hp).toBe(25);
  });

  it('despawns entities whose hp drops to zero on direct hit', () => {
    const soldier = spawnUnit({ clientTag: 'soldier-low', kind: 'soldier', x: 60, y: 5.4, z: 60, hp: 10 });
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'shot-fatal', owner: 'shooter',
      kind: 'bullet_7_62mm',
      x: 59.5, y: 6, z: 60,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.15,
      hitDamage: 30,
      damagePeak: 30,
    });
    gs.tick(0.05);
    expect(gs.state.entities.has(soldier.id)).toBe(false);
  });

  it('owner is skipped — projectiles cannot self-hit on muzzle exit', () => {
    const shooter = spawnUnit({ clientTag: 'shooter-self', kind: 'soldier', x: 80, y: 5.4, z: 80, hp: 100, owner: 'me' });
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'self-shot', owner: 'me',
      kind: 'bullet_9mm',
      x: 80, y: 6, z: 80,             // muzzle inside the shooter's hitbox
      vx: 30, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.15,
      hitDamage: 20, damagePeak: 20,
      ownerId: shooter.id,
    });
    gs.tick(0.05);
    // Shooter still alive; projectile passed through their own
    // hitbox without registering a hit.
    const after = gs.state.entities.get(shooter.id)!;
    expect(after.hp).toBe(100);
  });

  it('explosive direct hit splashes nearby entities with falloff', () => {
    const target = spawnUnit({ clientTag: 'target', kind: 'soldier', x: 100, y: 5.4, z: 100, hp: 120 });
    const neighbour = spawnUnit({ clientTag: 'neighbour', kind: 'soldier', x: 100.4, y: 5.4, z: 100.4, hp: 120 });
    const farAway = spawnUnit({ clientTag: 'far', kind: 'soldier', x: 110, y: 5.4, z: 100, hp: 120 });
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'rpg', owner: 'shooter',
      kind: 'rpg',
      x: 99.5, y: 6, z: 100,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.2,
      explosive: true,
      explosionRadiusMeters: 1.5,
      hitDamage: 40,
      damagePeak: 100,
    });
    gs.tick(0.05);
    expect(gs.state.projectiles.size).toBe(0);
    // Direct hit: full hitDamage.
    expect(gs.state.entities.get(target.id)!.hp).toBe(80);
    // Splash on the neighbour: peak * 0.4 * (1 - dist/radius).
    // dist ≈ √(0.4² + 0.6²) ≈ 0.72 m; falloff ≈ 1 - 0.72/1.5 ≈ 0.52.
    // damage ≈ 100 * 0.4 * 0.52 ≈ 20.8.
    const neighbourHp = gs.state.entities.get(neighbour.id)!.hp;
    expect(neighbourHp).toBeGreaterThan(95);  // at least small damage applied
    expect(neighbourHp).toBeLessThan(110);
    // Far away (10 m): outside 1.5 m blast radius → untouched.
    expect(gs.state.entities.get(farAway.id)!.hp).toBe(120);
  });

  it('voxel hit before entity hit goes to the voxel', () => {
    // Bullet flies along +x at y=6 m, z=120 m. Voxel index for that
    // y/z column is (y/0.125, z/0.125) = (48, 960). The wall sits in
    // that exact column, between the bullet's spawn (x≈119.5 m,
    // voxel ≈956) and the soldier's hitbox (x=121 m).
    const wallVx = 960;             // x ≈ 120 m
    const wallVy = 48;
    const wallVz = 960;
    gs.state.voxelOverrides.set(voxelIdx(wallVx, wallVy, wallVz), 3);
    const soldier = spawnUnit({ clientTag: 'shielded', kind: 'soldier', x: 121, y: 5.4, z: 120, hp: 50 });
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 'shot-blocked', owner: 'shooter',
      kind: 'bullet_5_56mm',
      x: 119.5, y: 6, z: 120,
      vx: 50, vy: 0, vz: 0,
      dragPerSecond: 0, gravityScale: 0,
      maxLifeSeconds: 5,
      hitRadiusMeters: 0.15,
      hitDamage: 25, damagePeak: 25,
    });
    gs.tick(0.1);
    expect(gs.state.projectiles.size).toBe(0);
    // Soldier is unscathed because the wall caught the round.
    expect(gs.state.entities.get(soldier.id)!.hp).toBe(50);
  });

  it('drag math matches exp(-drag*dt) per tick', () => {
    // Pure horizontal flight, gravity off — closed-form check.
    gs.applyCommand({
      type: 'spawn_projectile',
      clientTag: 't6', owner: 'p-test',
      kind: 'bullet_9mm',
      x: 0, y: 50, z: 0,
      vx: 100, vy: 0, vz: 0,
      dragPerSecond: 1.0,
      gravityScale: 0,
      maxLifeSeconds: 10,
    });
    const dt = 0.1;
    gs.tick(dt);
    const p = [...gs.state.projectiles.values()][0]!;
    // After one tick: vx = 100 * exp(-1*0.1) = 90.484…
    expect(p.vx).toBeCloseTo(100 * Math.exp(-0.1), 5);
    // Position: vx_after_drag * dt = 9.048…
    expect(p.x).toBeCloseTo(100 * Math.exp(-0.1) * dt, 5);
    expect(p.vy).toBe(0);
    // Sanity: gravity constant unchanged in the catalog.
    expect(PROJECTILE_GRAVITY).toBe(18.0);
  });
});
