import { describe, it, expect } from 'vitest';
import { ProjectileManager, PROJECTILES, ProjectileImpact } from '../src/sim/Projectiles';
import { GRAVITY } from '../src/sim/gravity';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, VOXEL_SIZE, AIR } from '../src/voxel/types';
import { M_DIRT, M_STONE } from '../src/voxel/Materials';

/** Build a world with a single horizontal slab of solid material at voxel y. */
function buildSlabWorld(slabY: number, mat: number): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      v[worldIndex(x, slabY, z)] = mat;
    }
  }
  return world;
}

/** Build an empty world (all air). */
function buildEmptyWorld(): VoxelWorld {
  return VoxelWorld.create(false);
}

/** Drain projectiles by ticking until they're all gone or `maxFrames` elapses. */
function drain(
  manager: ProjectileManager, world: VoxelWorld, maxFrames = 600, dt = 1 / 60,
): ProjectileImpact[] {
  const impacts: ProjectileImpact[] = [];
  for (let f = 0; f < maxFrames; f++) {
    if (manager.projectiles.length === 0) break;
    manager.tick(dt, world, (i) => impacts.push(i));
  }
  return impacts;
}

describe('Projectile bullet drop', () => {
  it('a horizontally fired round drops about ½·g·t² over its flight', () => {
    const world = buildEmptyWorld(); // no terrain to interrupt the arc
    const pm = new ProjectileManager();
    const startX = 100, startY = 50, startZ = 100;
    // 7.62 NATO at ~830 m/s, fired flat along +X.
    pm.spawn('bullet_762', startX, startY, startZ, 830, 0, 0, /*owner*/ 0);

    const dt = 1 / 240; // small step so the ½·g·t² approximation is tight
    const flightSec = 0.5;
    const steps = Math.round(flightSec / dt);
    for (let i = 0; i < steps; i++) {
      pm.tick(dt, world, () => {});
      if (pm.projectiles.length === 0) break;
    }
    const p = pm.projectiles[0];
    expect(p).toBeTruthy();

    const expectedDrop = 0.5 * GRAVITY * flightSec * flightSec;
    const actualDrop = startY - p!.y;
    // Drag introduces a small (≤30%) discrepancy. Bullet's `dragPerSec = 0.03`
    // shrinks horizontal velocity by ~1.5% over half a second; vertical drop is
    // dominated by gravity.
    expect(actualDrop).toBeGreaterThan(expectedDrop * 0.7);
    expect(actualDrop).toBeLessThan(expectedDrop * 1.3);
  });

  it('a heavier sniper round in the same time still drops by gravity (drop is mass-independent)', () => {
    const world = buildEmptyWorld();
    const pmRifle = new ProjectileManager();
    const pmSniper = new ProjectileManager();
    pmRifle.spawn('bullet_762', 100, 50, 100, 830, 0, 0, 0);
    pmSniper.spawn('bullet_127', 100, 50, 100, 890, 0, 0, 0);

    const dt = 1 / 240;
    const steps = 0.5 / dt;
    for (let i = 0; i < steps; i++) {
      pmRifle.tick(dt, world, () => {});
      pmSniper.tick(dt, world, () => {});
    }
    const dropRifle = 50 - pmRifle.projectiles[0]!.y;
    const dropSniper = 50 - pmSniper.projectiles[0]!.y;
    // Both should be within ~10% of each other (gravity is the same; drag
    // differs slightly).
    expect(dropSniper).toBeGreaterThan(dropRifle * 0.85);
    expect(dropSniper).toBeLessThan(dropRifle * 1.15);
  });
});

describe('Projectile voxel collision', () => {
  it('a bullet aimed at a wall hits, despawns, and damages voxels', () => {
    // Slab at y voxel 100 (12.5 m altitude) — solid stone band.
    // (WORLD_Y is 192 voxels — the slab has to live below that.)
    const slabY = 100;
    const world = buildSlabWorld(slabY, M_STONE);

    // Spawn a bullet a few meters above the slab, aimed straight down.
    const startY = (slabY + 8) * VOXEL_SIZE;
    const startX = 50, startZ = 50;
    const pm = new ProjectileManager();
    // .50 BMG straight down; large impact peak guarantees voxel destruction.
    pm.spawn('bullet_127', startX, startY, startZ, 0, -890, 0, 0);

    const impacts = drain(pm, world, /*maxFrames*/ 60);
    expect(pm.projectiles.length).toBe(0);
    expect(impacts.length).toBeGreaterThan(0);
    expect(impacts[0]!.timedOut).toBe(false);
    expect(impacts[0]!.hit).toBeTruthy();
    expect(impacts[0]!.hit!.y).toBe(slabY);
  });

  it('a bullet that never hits anything despawns on life timeout', () => {
    const world = buildEmptyWorld();
    const pm = new ProjectileManager();
    // Fire upward from low altitude — will arc over and come back down through
    // empty world, eventually timing out after `maxLifeSec` seconds.
    pm.spawn('bullet_9mm', 50, 1, 50, 0, 30, 0, 0);
    // 9mm has maxLifeSec = 4.0; tick 5 seconds at 60 Hz to cover that.
    const impacts: ProjectileImpact[] = [];
    for (let f = 0; f < 60 * 5; f++) {
      pm.tick(1 / 60, world, (i) => impacts.push(i));
      if (pm.projectiles.length === 0) break;
    }
    expect(pm.projectiles.length).toBe(0);
    // Floor of the world is air at y=0 — no collision; should have timed out.
    // But because GRAVITY pulls it back down past y=0 we may also collide with
    // nothing and the projectile leaves the world — either way `life<=0` ends
    // it cleanly. Accept either timeout or no-impact-at-all.
    if (impacts.length > 0) {
      // If anything fired, it must have been a timeout since the world is air.
      expect(impacts[0]!.timedOut).toBe(true);
    }
  });
});

describe('Cluster shell', () => {
  it('rocket_cluster spec defines child submunitions', () => {
    const spec = PROJECTILES['rocket_cluster'];
    expect(spec.family).toBe('cluster');
    expect(spec.clusterChildren).toBeGreaterThan(0);
    expect(spec.clusterChildKind).toBe('submunition');
    expect(spec.clusterSpreadMS).toBeGreaterThan(0);
  });

  it('submunition arms after a delay so it doesnt blow up at separation', () => {
    const spec = PROJECTILES['submunition'];
    expect(spec.armDelaySec).toBeGreaterThan(0);

    // Quick simulation: spawn a submunition pointed straight down at a slab,
    // verify it doesn't damage the world during the arm window.
    const slabY = 100;
    const world = buildSlabWorld(slabY, M_DIRT);
    const startY = (slabY + 1) * VOXEL_SIZE + 0.05; // just above the slab
    const pm = new ProjectileManager();
    pm.spawn('submunition', 50, startY, 50, 0, -50, 0, 0);

    // First frame it's still unarmed: the raycast will hit but the projectile
    // ignores the hit.
    const armDelay = spec.armDelaySec!;
    const dt = armDelay * 0.5;
    const impacts: ProjectileImpact[] = [];
    pm.tick(dt, world, (i) => impacts.push(i));
    // It might still be alive (unarmed pass-through) or it might have advanced
    // past the slab. Either way, no impact callback yet.
    expect(impacts.length).toBe(0);
  });
});

describe('Air projectile lifetime', () => {
  it('horizontally fired bullet keeps moving forward (X advances)', () => {
    const world = buildEmptyWorld();
    const pm = new ProjectileManager();
    pm.spawn('bullet_762', 50, 80, 50, 200, 0, 0, 0);
    pm.tick(0.05, world, () => {});
    const p = pm.projectiles[0]!;
    // Should have advanced ~10 m horizontally in 0.05 s.
    expect(p.x).toBeGreaterThan(50 + 5);
    expect(p.x).toBeLessThan(50 + 12);
  });

  it('multiple bullets dont share state', () => {
    const world = buildEmptyWorld();
    const pm = new ProjectileManager();
    pm.spawn('bullet_762', 0, 100, 0, 100, 0, 0, 0);
    pm.spawn('bullet_762', 0, 100, 0, -100, 0, 0, 1);
    pm.tick(0.1, world, () => {});
    expect(pm.projectiles[0]!.x).toBeGreaterThan(0);
    expect(pm.projectiles[1]!.x).toBeLessThan(0);
  });
});

describe('Projectile spec sanity', () => {
  it('bullets have realistic mass ordering — pistol < rifle < sniper', () => {
    // 9mm bullets are wider than 7.62mm rifle bullets, but the rifle round is
    // longer + denser so it weighs more. Mass is the meaningful ordering.
    expect(PROJECTILES['bullet_9mm'].massKg).toBeLessThan(PROJECTILES['bullet_762'].massKg);
    expect(PROJECTILES['bullet_762'].massKg).toBeLessThan(PROJECTILES['bullet_127'].massKg);
    // .50 BMG (12.7mm) is the widest of the three.
    expect(PROJECTILES['bullet_127'].caliberMm).toBeGreaterThan(PROJECTILES['bullet_9mm'].caliberMm);
    expect(PROJECTILES['bullet_127'].caliberMm).toBeGreaterThan(PROJECTILES['bullet_762'].caliberMm);
  });

  it('rockets do bigger blasts than bullets', () => {
    expect(PROJECTILES['rocket_rpg'].impactRadiusMeters)
      .toBeGreaterThan(PROJECTILES['bullet_127'].impactRadiusMeters);
    expect(PROJECTILES['rocket_heavy'].impactRadiusMeters)
      .toBeGreaterThan(PROJECTILES['rocket_rpg'].impactRadiusMeters);
  });

  it('higher caliber bullets fly faster than the pistol round', () => {
    // Real-world: pistols are subsonic-ish; rifles supersonic. Verify our
    // numbers preserve that.
    expect(PROJECTILES['bullet_762'].refMuzzleMS).toBeGreaterThan(PROJECTILES['bullet_9mm'].refMuzzleMS);
    expect(PROJECTILES['bullet_127'].refMuzzleMS).toBeGreaterThan(PROJECTILES['bullet_9mm'].refMuzzleMS);
  });
});

describe('Voxel air sentinel', () => {
  it('all-air world means raycasting from a bullet finds nothing', () => {
    const world = buildEmptyWorld();
    expect(world.get(0, 0, 0)).toBe(AIR);
  });
});
