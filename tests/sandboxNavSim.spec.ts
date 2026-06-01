import { describe, it, expect, beforeAll } from 'vitest';
import { UnitManager, unitConfig, type Unit } from '../src/sim/Units';
import { Pathfinder, profileFromUnit } from '../src/path/Pathfinder';
import { VoxelWorld } from '../src/voxel/VoxelWorld';
import { allocateNav, buildSurfaceNav, SurfaceNavBuffers } from '../src/path/SurfaceNav';
import { allocateVolumeNav, buildVolumeNav, VolumeNavBuffers } from '../src/path/VolumeNav';
import { buildSandboxWorld, SandboxLandmarks } from '../src/voxel/SandboxWorld';

/**
 * Integrated nav harness: drives a real UnitManager (movement + collision +
 * gravity + replan) AND a real Pathfinder (planning) over the sandbox cave.
 * The planner-only sandbox spec proves a path EXISTS; this proves units can
 * actually FOLLOW one — which is where the in-game cave-mouth / clump / stall
 * bugs live.
 *
 * Soldiers/tanks don't mutate terrain, so the world + nav grids are built ONCE
 * in beforeAll (the full-world VolumeGrid build is the expensive part) and
 * shared read-only across every scenario; each test gets a fresh UnitManager.
 */

let world: VoxelWorld;
let lm: SandboxLandmarks;
let nav: SurfaceNavBuffers;
let vnav: VolumeNavBuffers;
let pf: Pathfinder;

function profileFor(kind: string) {
  const c = unitConfig(kind as never);
  return profileFromUnit({
    kind,
    footprintRadius: c.footprintRadius,
    heightVoxels: c.heightVoxels,
    canDig: c.canDig,
    requiresGround: c.requiresGround,
    maxStepVoxels: c.maxStepVoxels,
    slopePenalty: c.slopePenalty,
  });
}

beforeAll(() => {
  world = VoxelWorld.create(false);
  lm = buildSandboxWorld(world, { obstacles: false });
  nav = allocateNav(false);
  buildSurfaceNav(world.buffers.voxels, nav);
  vnav = allocateVolumeNav(false);
  buildVolumeNav(world.buffers.voxels, vnav);
  pf = new Pathfinder(false);
  pf.attach(world);
  pf.registerProfile(profileFor('soldier'));
  pf.registerProfile(profileFor('tank'));
}, 120_000);

function planAndSet(
  um: UnitManager, unit: Unit, kind: string,
  goalCell: { cx: number; cy: number; cz: number },
): boolean {
  const start = pf.nearestPassable(kind, pf.cellAt(unit.x, unit.y, unit.z));
  const res = pf.findPath(kind, { start, goal: goalCell, maxExpansions: 200000 });
  if (res.cells.length === 0) return false;
  um.setPath(unit, pf.pathToWaypoints(res.cells));
  return res.reached;
}

/**
 * Run the sim until `done()` or the tick budget runs out. Mirrors the live game
 * loop: a unit that flags `needsRepath` gets a fresh route, AND a unit whose
 * path has emptied without arriving is re-dispatched (in-game the AI server
 * re-issues the order each tick — without modelling that here, the no-progress
 * give-up that clears `path` would look like a permanent freeze that the real
 * game wouldn't have). `arrivedFn` decides which units no longer need driving.
 */
function runUntil(
  um: UnitManager, units: Unit[], kind: string,
  goalCell: { cx: number; cy: number; cz: number },
  done: () => boolean,
  arrivedFn: (u: Unit) => boolean,
  maxTicks = 3600,
): number {
  const dt = 1 / 60;
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    um.tick(dt, nav, vnav, world.buffers.voxels, () => {});
    for (const u of units) {
      if (arrivedFn(u)) continue;
      // Re-issue when explicitly requested OR when the unit dropped its path
      // short of the goal (give-up). Both are "the host gives me a new route".
      if (u.needsRepath || u.path.length === 0) {
        u.needsRepath = false;
        planAndSet(um, u, kind, goalCell);
      }
    }
    if (done()) break;
  }
  return ticks;
}

describe('sandboxNavSim', () => {
  it('a soldier descends from the cave mouth into the deep chamber', () => {
    const um = new UnitManager();
    const s = um.spawn('soldier', lm.caveMouth.x, lm.caveMouth.y, lm.caveMouth.z);
    const goal = pf.nearestPassable('soldier', { cx: lm.chamberCenter.cx, cy: lm.chamberCenter.cy, cz: lm.chamberCenter.cz });
    expect(goal.cy).toBeLessThan(8);
    expect(planAndSet(um, s, 'soldier', goal)).toBe(true);

    const gx = goal.cx + 0.5, gz = goal.cz + 0.5;
    let minD = Infinity;
    const reached1 = (u: Unit) => Math.hypot(u.x - gx, u.z - gz) < 1.5 && u.y < 8;
    runUntil(um, [s], 'soldier', goal, () => {
      const d = Math.hypot(s.x - gx, s.z - gz);
      if (d < minD) minD = d;
      return reached1(s);
    }, reached1);
    const diag = { minD: +minD.toFixed(2), finalY: +s.y.toFixed(2) };
    expect(minD < 1.5 && s.y < 8, JSON.stringify(diag)).toBe(true);
  });

  // Regression for the cave-mouth "clump & freeze". Root cause (traced, then
  // fixed in separateOverlappingUnits): when two queued soldiers descending the
  // tunnel overlapped, the post-separation surface-snap lifted BOTH up to the
  // local `surfaceWorldY` — which, inside the covered corridor, is the ROOF
  // metres above their feet, not the cave floor. So pairs teleported out of the
  // tunnel onto the surface and stranded. The fix bounds that snap to the
  // unit's step height, so a genuine "pushed into a rise" burial still lifts but
  // an underground cave unit is left where it belongs.
  it('a squad of 6 soldiers all reach the chamber through the narrow corridor', () => {
    const um = new UnitManager();
    const goal = pf.nearestPassable('soldier', { cx: lm.chamberCenter.cx, cy: lm.chamberCenter.cy, cz: lm.chamberCenter.cz });
    const squad: Unit[] = [];
    // Spawn a single-file column trailing back along the approach lane, centred
    // on the trench (cz = caveMouth.z), 1.4 m apart. This is the realistic
    // "march a column through a cave mouth" case: units queue into the 2 m
    // trench one behind another. (A 3×2 block rammed into a 2-cell slot instead
    // tests dense-crowd rim contact, where collision pushes flank units onto
    // the un-trenched rim — a separate, harder avoidance case, not cave nav.)
    for (let i = 0; i < 6; i++) {
      const sx = lm.caveMouth.x - 4 - i * 1.4;
      const u = um.spawn('soldier', sx, lm.caveMouth.y, lm.caveMouth.z);
      planAndSet(um, u, 'soldier', goal);
      squad.push(u);
    }
    const gx = goal.cx + 0.5, gz = goal.cz + 0.5;
    const arrived = new Set<number>();
    const reachedSquad = (u: Unit) => {
      const ok = Math.hypot(u.x - gx, u.z - gz) < 2.5 && u.y < 8;
      if (ok) arrived.add(u.id);
      return ok;
    };
    runUntil(um, squad, 'soldier', goal,
      () => { squad.forEach(reachedSquad); return arrived.size === squad.length; },
      reachedSquad, 7200);
    const stragglers = squad.filter(u => !arrived.has(u.id))
      .map(u => ({ id: u.id, x: +u.x.toFixed(1), z: +u.z.toFixed(1), y: +u.y.toFixed(1),
        path: u.path.length, blocked: u.blockedFrames, noProg: u.noProgressFrames }));
    expect(arrived.size, `stragglers=${JSON.stringify(stragglers)}`).toBe(squad.length);
  });

  it('a tank routes across the surface without ever entering the 2 m corridor', () => {
    const um = new UnitManager();
    const t = um.spawn('tank', lm.caveMouth.x, lm.caveMouth.y, lm.caveMouth.z);
    const goal = pf.nearestPassable('tank', { cx: lm.chamberCenter.cx, cy: lm.chamberCenter.cy, cz: lm.chamberCenter.cz });
    planAndSet(um, t, 'tank', goal);
    let everDeep = false;
    runUntil(um, [t], 'tank', goal,
      () => { if (t.y < 5) everDeep = true; return false; },
      () => false, 1800);
    expect(everDeep, `tank dipped underground: finalY=${t.y.toFixed(2)}`).toBe(false);
  });
});
