import { describe, it, expect } from 'vitest';
import { VoxelWorld } from '../src/voxel/VoxelWorld';
import { ProjectileManager, PROJECTILES, UnitHitTest } from '../src/sim/Projectiles';
import { UnitManager } from '../src/sim/Units';

/**
 * Sphere-vs-ray hit test mirroring the production callback in Game.unitRayHit.
 * Iterates every live unit, treats each as a vertical bounding sphere centred
 * on the torso, and returns the closest hit along the swept segment.
 */
function makeUnitHitTest(units: UnitManager): UnitHitTest {
  return (fx, fy, fz, dx, dy, dz, maxDist, ownerId) => {
    let bestT = Infinity;
    let bestId = -1;
    for (const u of units.units) {
      if (u.id === ownerId) continue;
      if (u.hp <= 0) continue;
      const radius = u.widthMeters * 0.55 + 0.35;
      const cx = u.x;
      const cy = u.y + Math.max(0.7, u.widthMeters * 0.6);
      const cz = u.z;
      const ox = fx - cx, oy = fy - cy, oz = fz - cz;
      const b = ox * dx + oy * dy + oz * dz;
      const cTerm = ox * ox + oy * oy + oz * oz - radius * radius;
      const disc = b * b - cTerm;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = -b - sq;
      if (t < 0) t = -b + sq;
      if (t < 0 || t > maxDist) continue;
      if (t < bestT) { bestT = t; bestId = u.id; }
    }
    return bestId >= 0 ? { tMeters: bestT, unitId: bestId } : null;
  };
}

describe('projectile direct-hit damage', () => {
  it('a bullet aimed at a soldier reports a direct hit on the impact', () => {
    const world = VoxelWorld.create(false);  // empty world — no voxel geometry
    const um = new UnitManager();
    // Stand the target close enough that the catalog-tuned bullet drop (with
    // the deliberately-low muzzle velocities + bumped projectile gravity)
    // still puts the round inside the soldier's body sphere by the time it
    // arrives. The tunable here is the test fixture, not the catalog.
    const target = um.spawn('soldier', 8, 1, 0);
    const startHp = target.hp;
    const pm = new ProjectileManager();
    // Fire a 5.56 mm bullet from x=0 along +X straight at the target's torso
    // height. Owner id = -1 so the target isn't filtered out.
    const muzzleY = target.y + 0.7;
    pm.spawn('bullet_5_56mm', 0, muzzleY, 0, 1, 0, 0, -1);

    const dt = 1 / 240;
    let imp = null;
    for (let i = 0; i < 600 && imp === null; i++) {
      pm.tick(dt, world, makeUnitHitTest(um));
      if (pm.pendingImpacts.length > 0) imp = pm.pendingImpacts[0]!;
    }
    expect(imp).not.toBeNull();
    expect(imp!.directHitUnitId).toBe(target.id);
    expect(imp!.hitDamage).toBe(PROJECTILES.bullet_5_56mm.hitDamage);

    // Apply the damage the same way Game does.
    target.hp -= imp!.hitDamage;
    expect(target.hp).toBeLessThan(startHp);
    expect(target.hp).toBe(startHp - PROJECTILES.bullet_5_56mm.hitDamage);
  });

  it('a bullet that misses every unit reports directHitUnitId = -1', () => {
    const world = VoxelWorld.create(false);
    const um = new UnitManager();
    // Place a soldier far off the firing axis so the swept segment never
    // crosses their bounding sphere.
    um.spawn('soldier', 30, 1, 50);
    const pm = new ProjectileManager();
    pm.spawn('bullet_5_56mm', 0, 1, 0, 1, 0, 0, -1);

    const dt = 1 / 240;
    let imp = null;
    for (let i = 0; i < 1200 && imp === null; i++) {
      pm.tick(dt, world, makeUnitHitTest(um));
      if (pm.pendingImpacts.length > 0) imp = pm.pendingImpacts[0]!;
    }
    // Bullet expires by maxLife in open air — no impact emitted for non-
    // explosive expirations. Or it leaves the world below y=0; same deal.
    // Either way, no direct unit hit.
    if (imp !== null) {
      expect(imp.directHitUnitId).toBe(-1);
    }
  });

  it('the projectile owner is never counted as a direct hit', () => {
    const world = VoxelWorld.create(false);
    const um = new UnitManager();
    const shooter = um.spawn('soldier', 0, 1, 0);
    const pm = new ProjectileManager();
    // Fire from the shooter's own muzzle along +X. The unit hit test must
    // skip the owner so the round doesn't immediately register a self-hit.
    pm.spawn('bullet_5_56mm', shooter.x + 1.4, shooter.y + 1.2, shooter.z, 1, 0, 0, shooter.id);

    const dt = 1 / 240;
    for (let i = 0; i < 60; i++) {
      pm.tick(dt, world, makeUnitHitTest(um));
      // No impact should fire on frame 0 from self-hit.
      if (pm.pendingImpacts.length > 0) {
        expect(pm.pendingImpacts[0]!.directHitUnitId).not.toBe(shooter.id);
      }
    }
    expect(shooter.hp).toBe(80); // unchanged
  });
});
