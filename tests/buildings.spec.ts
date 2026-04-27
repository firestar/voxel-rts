import { describe, it, expect } from 'vitest';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Z, AIR } from '../src/voxel/types';
import { M_DIRT, M_GRASS } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import {
  ALL_BUILDINGS, BARRACKS, POWER_PLANT, REFINERY, TECH_LAB, TURRET, SILO,
  BuildingManager, checkFootprint,
} from '../src/sim/Buildings';
import { UnitManager } from '../src/sim/Units';
import { ProjectileManager } from '../src/sim/Projectiles';
import { WEAPONS } from '../src/sim/Weapons';
import { tickWeapons } from '../src/sim/WeaponTick';

/** Flat dirt/grass plane — all four building specs should place anywhere on it. */
function buildFlatWorld(surfaceY = 32): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

describe('building specs', () => {
  it('exposes all kinds via ALL_BUILDINGS in registry order', () => {
    // Two 'turret' specs in a row — the regular building_turret and the
    // anti-air flak turret. Both share `kind: 'turret'` because they reuse
    // the same renderer head; the AA-vs-ground behaviour is keyed off the
    // spec's `weapon` field, not `kind`.
    expect(ALL_BUILDINGS.map(s => s.kind)).toEqual([
      'barracks', 'vehicle_depot', 'farm', 'storage', 'power_plant', 'refinery', 'tech_lab',
      'turret', 'turret', 'silo',
    ]);
  });

  it('only the barracks produces units; the rest are non-producers', () => {
    expect(BARRACKS.produces.length).toBeGreaterThan(0);
    expect(POWER_PLANT.produces.length).toBe(0);
    expect(REFINERY.produces.length).toBe(0);
    expect(TECH_LAB.produces.length).toBe(0);
    expect(TURRET.produces.length).toBe(0);
    expect(SILO.produces.length).toBe(0);
  });

  it('non-producers carry an Infinity production interval (sentinel for the tick guard)', () => {
    expect(POWER_PLANT.productionInterval).toBe(Infinity);
    expect(REFINERY.productionInterval).toBe(Infinity);
    expect(TECH_LAB.productionInterval).toBe(Infinity);
    expect(TURRET.productionInterval).toBe(Infinity);
    expect(SILO.productionInterval).toBe(Infinity);
  });

  it('weapon-bearing buildings declare a launcher max strength and a muzzle height', () => {
    for (const spec of [TURRET, SILO]) {
      expect(spec.weapon, `${spec.kind} should declare a weapon`).toBeDefined();
      expect(spec.launcherMaxStrength!, `${spec.kind} launcher`).toBeGreaterThan(0);
      expect(spec.weaponMuzzleHeight!, `${spec.kind} muzzle height`).toBeGreaterThan(0);
      // Catalog cross-check: each declared weapon must exist in the WEAPONS map.
      expect(WEAPONS[spec.weapon!]).toBeDefined();
    }
  });

  it('silo outranges the turret (silo is the long-arm of the defensive line)', () => {
    expect(WEAPONS[SILO.weapon!].rangeMeters).toBeGreaterThan(WEAPONS[TURRET.weapon!].rangeMeters);
    expect(SILO.launcherMaxStrength!).toBeGreaterThan(TURRET.launcherMaxStrength!);
  });
});

describe('checkFootprint over flat terrain', () => {
  it('passes for every spec on a flat dirt plane', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    for (const spec of ALL_BUILDINGS) {
      const fp = checkFootprint(world.buffers.voxels, nav, spec, 8, 8);
      expect(fp.ok, `expected ${spec.kind} to fit at (8,8): ${fp.reason}`).toBe(true);
      expect(fp.floorY).toBeGreaterThan(0);
    }
  });
});

describe('stamp functions write voxels and produce distinctive shapes', () => {
  it('barracks stamps a hollow box with a door cut on the +X face', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 8, oz = 8;
    const fp = checkFootprint(world.buffers.voxels, nav, BARRACKS, ox, oz);
    const wallVoxels = BARRACKS.stamp(world, ox, oz, fp.floorY);
    expect(wallVoxels).toBeGreaterThan(0);

    // Door cells on +X face should be air at floor level (the door cutout).
    const wxEnd = (ox + BARRACKS.cellsW) * NAV_CELL_VOXELS - 1;
    const wzMid = ((oz + BARRACKS.cellsD * 0.5) * NAV_CELL_VOXELS) | 0;
    expect(world.get(wxEnd, fp.floorY + 2, wzMid - 1)).toBe(AIR);
  });

  it('power plant stamps a parapet + central pylon stub above the main roof', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 12, oz = 12;
    const fp = checkFootprint(world.buffers.voxels, nav, POWER_PLANT, ox, oz);
    const wallVoxels = POWER_PLANT.stamp(world, ox, oz, fp.floorY);
    expect(wallVoxels).toBeGreaterThan(0);

    // The pylon stub is 6 voxels of M_WOOD above (floorY + headroom). Probe the
    // centre column at floorY + headroom + 3 — should be solid (wood).
    const cxv = ((ox + POWER_PLANT.cellsW * 0.5) * NAV_CELL_VOXELS) | 0;
    const czv = ((oz + POWER_PLANT.cellsD * 0.5) * NAV_CELL_VOXELS) | 0;
    const probeY = fp.floorY + POWER_PLANT.headroomVoxels + 3;
    // World.set with center maths uses (cxv-1, cxv, czv-1, czv) for the 2x2 column.
    expect(world.get(cxv - 1, probeY, czv - 1)).not.toBe(AIR);
  });

  it('refinery stack rises at least 24 voxels above the main roof', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 6, oz = 6;
    const fp = checkFootprint(world.buffers.voxels, nav, REFINERY, ox, oz);
    REFINERY.stamp(world, ox, oz, fp.floorY);

    // Chimney column is at the back-left interior corner (offset 2 voxels from
    // each perimeter wall, 2x2 column).
    const wxStart = ox * NAV_CELL_VOXELS;
    const wzStart = oz * NAV_CELL_VOXELS;
    const chimX = wxStart + 2;
    const chimZ = wzStart + 2;
    // Probe well above the main roof — should still be solid stack.
    const stackProbeY = fp.floorY + REFINERY.headroomVoxels + 20;
    expect(world.get(chimX, stackProbeY, chimZ)).not.toBe(AIR);
    expect(world.get(chimX + 1, stackProbeY, chimZ + 1)).not.toBe(AIR);
  });

  it('tech lab dome narrows toward the apex (perimeter solid, centre still solid above)', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const ox = 10, oz = 10;
    const fp = checkFootprint(world.buffers.voxels, nav, TECH_LAB, ox, oz);
    TECH_LAB.stamp(world, ox, oz, fp.floorY);

    // At the dome's first tier the centre is still solid stone, but the corners
    // (where the original perimeter wall sat) should now be air — the dome is
    // inset from the perimeter.
    const wxStart = ox * NAV_CELL_VOXELS;
    const wzStart = oz * NAV_CELL_VOXELS;
    const wxEnd = wxStart + TECH_LAB.cellsW * NAV_CELL_VOXELS;
    const wzEnd = wzStart + TECH_LAB.cellsD * NAV_CELL_VOXELS;
    const tier1Y = fp.floorY + TECH_LAB.headroomVoxels + 2;
    const cxv = ((wxStart + wxEnd) >> 1);
    const czv = ((wzStart + wzEnd) >> 1);
    expect(world.get(cxv, tier1Y, czv)).not.toBe(AIR);
    // Outer-corner column above the perimeter wall is air at the dome height (the
    // dome inset is 4 voxels per tier, so the original corner is no longer covered).
    expect(world.get(wxStart, tier1Y, wzStart)).toBe(AIR);
    // The wood antenna mast above the dome reaches floorY + headroom + 6 + 1.
    const mastY = fp.floorY + TECH_LAB.headroomVoxels + 3 * 2 + 3;
    expect(world.get(cxv, mastY, czv)).not.toBe(AIR);
  });
});

describe('BuildingManager — turret + silo weapon firing', () => {
  it('a turret auto-fires at a nearby enemy soldier', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    const bm = new BuildingManager();
    const pm = new ProjectileManager();
    bm.projectiles = pm;
    // Place a turret at a known footprint, then drop an enemy soldier within
    // its 90 m range so the auto-target pipeline picks them up immediately.
    const fp = checkFootprint(world.buffers.voxels, nav, TURRET, 8, 8);
    expect(fp.ok, fp.reason).toBe(true);
    const t = bm.place(world, TURRET, 8, 8, fp.floorY);
    // Turret centre in world meters → place enemy 20 m down +X.
    const cxw = (t.ox + t.spec.cellsW * 0.5) * NAV_CELL_VOXELS * 0.125;
    const czw = (t.oz + t.spec.cellsD * 0.5) * NAV_CELL_VOXELS * 0.125;
    um.spawn('soldier', cxw + 20, (fp.floorY + 1) * 0.125, czw, { team: 'enemy' });
    // Run several seconds of ticks — well past the turret's slew + cooldown.
    for (let i = 0; i < 600; i++) bm.tick(1 / 60, world, um);
    expect(pm.projectiles.length).toBeGreaterThan(0);
    // The first round in flight should be the turret's catalog projectile.
    expect(pm.projectiles[0]!.kind).toBe(WEAPONS[TURRET.weapon!].projectile);
  });

  it("a turret with no enemies in range never fires", () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    // A friendly soldier nearby — same-team, must not be targeted.
    const fp = checkFootprint(world.buffers.voxels, nav, TURRET, 10, 10);
    expect(fp.ok).toBe(true);
    const t = new BuildingManager();
    const pm = new ProjectileManager();
    t.projectiles = pm;
    const b = t.place(world, TURRET, 10, 10, fp.floorY);
    const cxw = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * 0.125;
    const czw = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * 0.125;
    um.spawn('soldier', cxw + 5, (fp.floorY + 1) * 0.125, czw); // friendly!
    for (let i = 0; i < 600; i++) t.tick(1 / 60, world, um);
    expect(pm.projectiles.length).toBe(0);
  });

  it('a silo launches its heavy missile at the catalog speed (well under its launcher cap)', () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    const bm = new BuildingManager();
    const pm = new ProjectileManager();
    bm.projectiles = pm;
    const fp = checkFootprint(world.buffers.voxels, nav, SILO, 4, 4);
    expect(fp.ok, fp.reason).toBe(true);
    const s = bm.place(world, SILO, 4, 4, fp.floorY);
    const cxw = (s.ox + s.spec.cellsW * 0.5) * NAV_CELL_VOXELS * 0.125;
    const czw = (s.oz + s.spec.cellsD * 0.5) * NAV_CELL_VOXELS * 0.125;
    // Plant an enemy 80 m out so the silo definitely engages.
    um.spawn('tank', cxw + 80, (fp.floorY + 1) * 0.125, czw, { team: 'enemy' });
    // Run enough ticks for slew + the silo's long cooldown to finish at least
    // one shot. 16 s @ 60 fps = 960 ticks.
    for (let i = 0; i < 1500; i++) {
      bm.tick(1 / 60, world, um);
      if (pm.projectiles.length > 0) break;
    }
    expect(pm.projectiles.length).toBeGreaterThan(0);
    const p = pm.projectiles[0]!;
    // Silo missiles spawn with a vertical-ascent boost phase first, then
    // tip over to the catalog speed (~90 m/s). Tick until the missile exits
    // the boost so the speed assertion sees the real launch speed.
    for (let i = 0; i < 60 && p.boostMetersRemaining > 0; i++) {
      pm.tick(1 / 60, world);
    }
    // Silo launcher cap (220 m/s) is comfortably above the silo missile's
    // catalog speed (90 m/s), so the actual launch speed is the catalog
    // value. Confirm the spawn used min(catalog, cap) = catalog and the
    // missile is moving (drag bleeds a tiny bit per tick).
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    expect(speed).toBeGreaterThan(70);
    expect(speed).toBeLessThan(SILO.launcherMaxStrength!);
  });
});

describe('Launcher strength cap (per-unit)', () => {
  it('a soldier with a sniper has its 7.62mm muzzle speed clamped down to the soldier launcher cap', () => {
    // Sniper round catalog speed (95) > soldier launcher cap (80), so the
    // spawned projectile must come out at the soldier's cap, not the
    // catalog's catalog speed. Demonstrates that swapping a heavier weapon
    // onto a soldier doesn't grant them tank-level range.
    const um = new UnitManager();
    const sol = um.spawn('soldier', 0, 1, 0, { weapon: 'sniper' });
    const pm = new ProjectileManager();
    sol.firingTarget = { x: 30, y: 1, z: 0 };
    sol.heading = Math.atan2(-30, 0); // skip the slew time
    sol.turretYaw = sol.heading;
    // Step the weapon tick a few times so the shot leaves the muzzle.
    for (let i = 0; i < 30; i++) {
      tickWeapons(1 / 60, um, pm, { onMuzzleFlash: (): void => {} });
      if (pm.projectiles.length > 0) break;
    }
    expect(pm.projectiles.length).toBe(1);
    const p = pm.projectiles[0]!;
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    // Catalog says 95 but soldier caps at 80 — speed should equal the cap
    // (within one tick of drag).
    expect(speed).toBeLessThanOrEqual(80 + 0.01);
    expect(speed).toBeGreaterThan(70);
  });
});

describe('BuildingManager.tick', () => {
  it("doesn't crash or spawn for non-producer buildings", () => {
    const world = buildFlatWorld();
    const nav = allocateNav(false);
    buildSurfaceNav(world.buffers.voxels, nav);
    const um = new UnitManager();
    const bm = new BuildingManager();
    let spawned = 0;
    bm.spawner = () => { spawned++; return null; };
    // Place each spec on its own patch of the flat world so successive stamps don't
    // overlap (the first stamp raises topY in its cells; the next would fail
    // checkFootprint there).
    let cursor = 4;
    for (const spec of [POWER_PLANT, REFINERY, TECH_LAB]) {
      const fp = checkFootprint(world.buffers.voxels, nav, spec, cursor, 4);
      expect(fp.ok, `${spec.kind} at (${cursor},4): ${fp.reason}`).toBe(true);
      bm.place(world, spec, cursor, 4, fp.floorY);
      cursor += spec.cellsW + 2;
    }
    // Run far longer than any conceivable production interval — non-producers
    // should never call the spawner.
    for (let i = 0; i < 1000; i++) bm.tick(0.1, world, um);
    expect(spawned).toBe(0);
  });
});
