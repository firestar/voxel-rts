/**
 * Deterministic pathfinding sandbox world.
 *
 * A compact, hand-authored test scene that exercises the three navigation
 * cases the planner has to get right:
 *
 *   1. Surface routing around obstacles  — a mesa, a wall with a gate, and a
 *      boulder field force units to weave / find the gap instead of walking a
 *      straight line.
 *   2. Surface → cave transition         — a cell-aligned staircase descends
 *      from the grass plain into an underground corridor.
 *   3. Cave traversal                    — a 2 m corridor leads to a branch and
 *      a deep chamber; a rock-sealed pocket can only be reached by a digger.
 *
 * The geometry reuses the exact conventions of `cavesAndTransitions.spec.ts`
 * (which already passes), so the cell math is known-good:
 *
 *   voxel y 0..3    bedrock
 *   voxel y 4..63   stone
 *   voxel y 64..67  dirt
 *   voxel y 68      grass            (surface top solid voxel)
 *   nav cell cy=8   top solid surface cell (voxels 64..71)
 *   stand cy=9      where a ground unit stands on the plain
 *   corridor floor  nav cell cy=1 (solid), air at cy=2..3, stand cy=2
 *
 * One nav cell = 8 voxels = 1 m, so a cell coordinate `c` maps to voxels
 * `[c*8 .. c*8+7]` and to a world-meter centre of `c + 0.5`.
 *
 * The builder writes straight into the voxel buffer (no carveSphere) so the
 * shapes are exact and the build stays cheap. It returns a {@link SandboxLandmarks}
 * record of named start/goal points (in both cells and metres) so tests and the
 * debug page don't hand-roll magic coordinates.
 */
import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from './types';
import { VoxelWorld, worldIndex } from './VoxelWorld';
import { M_GRASS, M_DIRT, M_STONE, M_BEDROCK } from './Materials';

const NAV = 8; // voxels per nav cell

// Terrain band tops, in voxels. Kept identical to the cave spec.
const BEDROCK_TOP = 3;   // y 0..3
const STONE_TOP = 63;    // y 4..63
const DIRT_TOP = 67;     // y 64..67
const GRASS_Y = 68;      // y 68 — surface

/** A point referenced in both nav-cell coordinates and world metres. */
export interface SandboxPoint {
  cx: number; cy: number; cz: number;
  x: number; y: number; z: number;
}

export interface SandboxLandmarks {
  /** Surface-routing scenario: walk start → goal weaving past mesa/wall/boulders. */
  surfaceStart: SandboxPoint;
  surfaceGoal: SandboxPoint;
  /** Surface lip just west of the cave staircase (a ground unit stands here). */
  caveMouth: SandboxPoint;
  /** First standing cell at the bottom of the staircase, inside the corridor. */
  corridorStart: SandboxPoint;
  /** Centre of the deep chamber at the far end of the corridor. */
  chamberCenter: SandboxPoint;
  /** End of the side branch off the main corridor (cave-internal traversal goal). */
  branchEnd: SandboxPoint;
  /** A cell buried in solid rock with no air route — diggers only. */
  tunnelerTarget: SandboxPoint;
}

export interface SandboxOptions {
  /** Build the surface mesa / wall+gate / boulder field. Default true. */
  obstacles?: boolean;
  /** Build the staircase + corridor + branch + chamber. Default true. */
  cave?: boolean;
}

function point(cx: number, cy: number, cz: number): SandboxPoint {
  return { cx, cy, cz, x: cx + 0.5, y: cy + 0.5, z: cz + 0.5 };
}

/**
 * Build the sandbox into `world` and return its landmarks. Caller is
 * responsible for `world.markAllDirty()` if it wants a mesh refresh; tests
 * that only run the pathfinder don't need it (the planner reads the voxel
 * buffer directly via `Pathfinder.attach`).
 */
export function buildSandboxWorld(world: VoxelWorld, opts: SandboxOptions = {}): SandboxLandmarks {
  const obstacles = opts.obstacles ?? true;
  const cave = opts.cave ?? true;
  const v = world.buffers.voxels;

  layBaseTerrain(v);
  if (obstacles) buildSurfaceObstacles(v);
  if (cave) buildCaveSystem(v);

  return {
    surfaceStart: point(32, 9, 100),
    surfaceGoal: point(112, 9, 100),
    caveMouth: point(30, 9, 64),
    corridorStart: point(41, 2, 64),
    chamberCenter: point(76, 2, 63),
    branchEnd: point(56, 2, 74),
    tunnelerTarget: point(92, 2, 40),
  };
}

// ----------------------------------------------------------------------------
// Voxel helpers (all ranges inclusive, in voxels unless named *Cell).
// ----------------------------------------------------------------------------

function setVox(v: Uint8Array, x: number, y: number, z: number, m: number): void {
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return;
  v[worldIndex(x, y, z)] = m;
}

/** Fill an inclusive voxel box with a material. */
function fillVox(
  v: Uint8Array,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  m: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) setVox(v, x, y, z, m);
    }
  }
}

/** Clear an inclusive *nav-cell* box to AIR, preserving any bedrock floor. */
function clearCellBox(
  v: Uint8Array,
  cx0: number, cx1: number, cy0: number, cy1: number, cz0: number, cz1: number,
): void {
  const x0 = cx0 * NAV, x1 = cx1 * NAV + NAV - 1;
  const y0 = cy0 * NAV, y1 = cy1 * NAV + NAV - 1;
  const z0 = cz0 * NAV, z1 = cz1 * NAV + NAV - 1;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) continue;
        const i = worldIndex(x, y, z);
        if (v[i] === M_BEDROCK) continue;
        v[i] = AIR;
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Terrain + features.
// ----------------------------------------------------------------------------

/** Flat layered plain over the whole world. */
function layBaseTerrain(v: Uint8Array): void {
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y <= BEDROCK_TOP; y++) v[worldIndex(x, y, z)] = M_BEDROCK;
      for (let y = BEDROCK_TOP + 1; y <= STONE_TOP; y++) v[worldIndex(x, y, z)] = M_STONE;
      for (let y = STONE_TOP + 1; y <= DIRT_TOP; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, GRASS_Y, z)] = M_GRASS;
      // Above grass: air (buffer starts zeroed; nothing to write).
    }
  }
}

/**
 * Surface obstacles along the cz≈100 lane between surfaceStart (cx32) and
 * surfaceGoal (cx112): a tall mesa to route around, a wall with a 3 m gate to
 * funnel through, and a boulder field to weave.
 */
function buildSurfaceObstacles(v: Uint8Array): void {
  const top = GRASS_Y; // 68

  // Mesa: solid stone block rising ~6 m above the plain. Cells cx48..56,
  // cz96..104 → voxels. Impassable; units route around it.
  fillVox(v, 48 * NAV, 56 * NAV + 7, top + 1, top + 48, 96 * NAV, 104 * NAV + 7, M_STONE);

  // Wall with a gate. A stone wall ~2 m tall across the lane at cx70, spanning
  // cz92..108, with a 3-cell gate left open at cz98..100. Units funnel through.
  const wallX0 = 70 * NAV, wallX1 = 71 * NAV + 7;        // 2 cells thick
  fillVox(v, wallX0, wallX1, top + 1, top + 16, 92 * NAV, 97 * NAV + 7, M_STONE);
  fillVox(v, wallX0, wallX1, top + 1, top + 16, 101 * NAV, 108 * NAV + 7, M_STONE);
  // (gate columns cz98..100 are left as plain grass)

  // Boulder field: scattered short stone pillars between the wall and the goal,
  // cx84..104 / cz92..108. Deterministic placement so tests are stable.
  const boulders: Array<[number, number, number]> = [
    // [cx, cz, sizeCells]
    [86, 95, 1], [90, 99, 2], [94, 93, 1], [97, 104, 2],
    [100, 97, 1], [103, 101, 1], [88, 106, 1], [99, 108, 2],
  ];
  for (const [bcx, bcz, s] of boulders) {
    fillVox(
      v, bcx * NAV, (bcx + s - 1) * NAV + 7, top + 1, top + 10,
      bcz * NAV, (bcz + s - 1) * NAV + 7, M_STONE,
    );
  }
}

/**
 * Underground cave: a staircase down from the surface, a 2 m corridor (soldier
 * fits, a 3 m tank does not), a side branch, and a deep chamber. The
 * tunnelerTarget cell is deliberately left buried in solid stone — no air
 * route reaches it, so only a digger can.
 */
function buildCaveSystem(v: Uint8Array): void {
  // Main corridor: stand cy=2, air cells cy2..3 (2 m tall), 2 cells wide in z
  // (cz63..64), running cx41..78. Floor cell cy=1 stays solid stone.
  const corrCz0 = 63, corrCz1 = 64;
  clearCellBox(v, 41, 78, 2, 3, corrCz0, corrCz1);

  // Staircase from the surface (stand cy=8) down to the corridor (stand cy=2),
  // cut as an OPEN descending trench: at each step we clear from that step's
  // floor cell all the way UP to the surface band (cy8), so the cut is open to
  // the sky the whole length — no intact-terrain roof over any pocket.
  //
  // Two properties this geometry must hold, both load-bearing for the tests:
  //   - Open in Y so a descending soldier is never trapped under intact grass.
  //     (An earlier version cleared only [standCy, standCy+2]; once standCy
  //     dropped below 6 the surface cell cy8 stayed solid, roofing the lower
  //     steps — a soldier jostled onto a roof could never descend. Looked like
  //     a stall, was a malformed scene.)
  //   - Only as WIDE in Z as the corridor (2 cells, cz63..64). A 1-cell soldier
  //     fits; a 3-cell tank (footprintRadius 2 → 2r+1 = 3 cells) does not, so
  //     the "tank never descends" invariant holds at the mouth exactly as it
  //     does in the corridor. (Widening the trench to 4 cells let the tank in.)
  //
  // Each step drops the floor by one cell (8 voxels = a soldier's max step) and
  // the bottom step meets the corridor mouth at cx41.
  const stepZ0 = corrCz0, stepZ1 = corrCz1;
  const SURFACE_CY = 8;
  let standCy = SURFACE_CY;
  for (let cx = 34; cx <= 40; cx++) {
    clearCellBox(v, cx, cx, standCy, SURFACE_CY + 1, stepZ0, stepZ1);
    standCy--;
  }

  // Side branch off the corridor toward +z, ending at branchEnd (cx56, cz74).
  // 2 cells wide (cx55..56), air cy2..3, from the corridor wall at cz65 to cz74.
  clearCellBox(v, 55, 56, 2, 3, 65, 74);

  // Deep chamber at the far end: a wide room cx72..80, cz59..67, air cy2..4.
  clearCellBox(v, 72, 80, 2, 4, 59, 67);

  // tunnelerTarget (cx92, cy2, cz40) is intentionally NOT carved — it sits in
  // solid stone, reachable only by a digging unit.
}
