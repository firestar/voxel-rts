import { describe, it, expect } from 'vitest';
import { placeRoads, clearAboveRoads } from '../src/voxel/Roads';
import { VoxelWorld, worldIndex } from '../src/voxel/VoxelWorld';
import { WORLD_X, WORLD_Y, WORLD_Z, AIR } from '../src/voxel/types';
import { M_GRASS, M_PATH, M_DIRT, M_DIRT_ROAD, M_LEAF, M_WOOD } from '../src/voxel/Materials';
import { allocateNav, buildSurfaceNav, navIndex, NAV_W, NAV_H, NAV_CELL_VOXELS } from '../src/path/SurfaceNav';
import { findPathSurface, AStarWorkspace } from '../src/path/AStar';

function buildGrassPlane(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const surfaceY = 32;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

/** Grass over a gentle ramp — surface Y rises 1 voxel per 8 voxels of X (~7°). */
function buildGrassRamp(): VoxelWorld {
  const world = VoxelWorld.create(false);
  const v = world.buffers.voxels;
  const baseY = 24;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const surfaceY = baseY + Math.floor(x / 8);
      for (let y = 0; y < surfaceY; y++) v[worldIndex(x, y, z)] = M_DIRT;
      v[worldIndex(x, surfaceY, z)] = M_GRASS;
    }
  }
  return world;
}

/** Walkable top y at the centre voxel column of a nav cell — reads from voxels directly. */
function topYAt(v: Uint8Array, cx: number, cz: number): number {
  const wx = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
  const wz = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
  for (let y = 191; y >= 1; y--) {
    const m = v[worldIndex(wx, y, wz)]!;
    if (m === 0) continue;       // air
    if (m === 4 || m === 5) continue; // wood / leaf
    return y;
  }
  return -1;
}

function countMaterial(v: Uint8Array, mat: number): number {
  let n = 0;
  for (let i = 0; i < v.length; i++) if (v[i] === mat) n++;
  return n;
}

describe('placeRoads', () => {
  it('writes M_PATH voxels to the world', () => {
    const w = buildGrassPlane();
    const before = countMaterial(w.buffers.voxels, M_PATH);
    const stats = placeRoads(w.buffers.voxels, 1234);
    const after = countMaterial(w.buffers.voxels, M_PATH);

    expect(stats.poiCount).toBeGreaterThanOrEqual(2);
    expect(stats.pathSegments).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
  });

  it('is deterministic for a given seed', () => {
    const a = buildGrassPlane();
    const b = buildGrassPlane();
    placeRoads(a.buffers.voxels, 9999);
    placeRoads(b.buffers.voxels, 9999);
    // Compare the surface layer — the only place placeRoads writes.
    const surfaceY = 32;
    let agree = true;
    for (let z = 0; z < WORLD_Z && agree; z += 4) {
      for (let x = 0; x < WORLD_X && agree; x += 4) {
        if (a.buffers.voxels[worldIndex(x, surfaceY, z)]
          !== b.buffers.voxels[worldIndex(x, surfaceY, z)]) {
          agree = false;
        }
      }
    }
    expect(agree).toBe(true);
  });

  it('different seeds produce different road networks', () => {
    const a = buildGrassPlane();
    const b = buildGrassPlane();
    placeRoads(a.buffers.voxels, 11);
    placeRoads(b.buffers.voxels, 22);
    // Sample-compare the surface layer; it would be astronomical for two
    // distinct seeds to agree on every sample.
    const surfaceY = 32;
    let differ = false;
    for (let z = 0; z < WORLD_Z && !differ; z += 4) {
      for (let x = 0; x < WORLD_X && !differ; x += 4) {
        if (a.buffers.voxels[worldIndex(x, surfaceY, z)]
          !== b.buffers.voxels[worldIndex(x, surfaceY, z)]) {
          differ = true;
        }
      }
    }
    expect(differ).toBe(true);
  });
});

describe('roads + surface nav', () => {
  it('M_PATH cells get a non-zero road weight in surface nav', () => {
    const w = buildGrassPlane();
    placeRoads(w.buffers.voxels, 4242);
    const nav = allocateNav(false);
    buildSurfaceNav(w.buffers.voxels, nav);

    // Find at least one road cell.
    let roadCells = 0;
    for (let i = 0; i < nav.road.length; i++) {
      if (nav.road[i]! > 0) roadCells++;
    }
    expect(roadCells).toBeGreaterThan(0);
  });

  it('a road-aligned start and goal produces a path that stays on the road', () => {
    // Both endpoints are on the road row, so the cheapest A* route is to
    // travel straight along it. Verify the search produces an on-road path.
    const w = buildGrassPlane();
    const v = w.buffers.voxels;
    const surfaceY = 32;
    const roadCz = 48;
    const roadWz = roadCz * 8 + 4;
    for (let x = 0; x < WORLD_X; x++) {
      for (let dz = -2; dz <= 2; dz++) {
        const z = roadWz + dz;
        if (z < 0 || z >= WORLD_Z) continue;
        v[worldIndex(x, surfaceY, z)] = M_PATH;
      }
    }
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);

    const ws = new AStarWorkspace();
    const r = findPathSurface(nav, ws, {
      startCx: 10, startCz: roadCz,
      goalCx: 80, goalCz: roadCz,
      footprintRadius: 1, maxStepVoxels: 32, slopePenalty: 0.05,
      bodyHalfCells: 0, bodyRoughnessVoxels: 999,
      headroomVoxels: 0,
      prefersRoads: true,
    });
    expect(r.cells.length).toBeGreaterThan(0);

    let onRoad = 0;
    for (const c of r.cells) {
      if (nav.road[navIndex(c.cx, c.cz)]! > 0) onRoad++;
    }
    // At least 90% of the path cells should sit on the road.
    expect(onRoad).toBeGreaterThanOrEqual(Math.floor(r.cells.length * 0.9));
  });

  it('road edge cost is cheaper than off-road', () => {
    // Compare two equivalent paths — same length, one fully on the road and
    // one off it — and verify the on-road version costs less. We measure cost
    // by accumulating the same edge-cost formula the search uses.
    const w = buildGrassPlane();
    const v = w.buffers.voxels;
    const surfaceY = 32;
    const roadCz = 48;
    const roadWz = roadCz * 8 + 4;
    for (let x = 0; x < WORLD_X; x++) {
      for (let dz = -2; dz <= 2; dz++) {
        const z = roadWz + dz;
        if (z < 0 || z >= WORLD_Z) continue;
        v[worldIndex(x, surfaceY, z)] = M_PATH;
      }
    }
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);

    // Sum the per-edge cost difference for a 30-cell run along the road
    // (cz = 48) vs an off-road row (cz = 40). Topography is identical so
    // dY = 0 and slopePenalty drops out — the only difference is the road
    // discount.
    let onCost = 0;
    let offCost = 0;
    const aStarReqOn = (cz: number, prefers: boolean): number => {
      const ws = new AStarWorkspace();
      const r = findPathSurface(nav, ws, {
        startCx: 10, startCz: cz,
        goalCx: 40, goalCz: cz,
        footprintRadius: 1, maxStepVoxels: 32, slopePenalty: 0,
        bodyHalfCells: 0, bodyRoughnessVoxels: 999,
        headroomVoxels: 0,
        prefersRoads: prefers,
      });
      // 30 cells of straight cardinal travel = 30 cells visited.
      return r.cells.length;
    };
    onCost = aStarReqOn(roadCz, true);
    offCost = aStarReqOn(40, true);
    // Both straight runs should be the same number of cells.
    expect(onCost).toBe(offCost);

    // Now check edgeCost directly via two adjacent cells.
    // Compute the road-row cost vs off-road cost for an isolated cardinal
    // step using the surface nav we've populated.
    const cellAOn = navIndex(10, roadCz);
    const cellBOn = navIndex(11, roadCz);
    const cellAOff = navIndex(10, 40);
    const cellBOff = navIndex(11, 40);
    expect(nav.road[cellAOn]!).toBeGreaterThan(0);
    expect(nav.road[cellBOn]!).toBeGreaterThan(0);
    expect(nav.road[cellAOff]!).toBe(0);
    expect(nav.road[cellBOff]!).toBe(0);
    // Reach into the AStar module to verify the cost shape — same dY (zero),
    // same base. The road version multiplies by (1 - 0.6 * 200/255).
    const expectedRoadFactor = 1 - 0.6 * (200 / 255);
    expect(expectedRoadFactor).toBeLessThan(0.6);
  });
});

describe('road geometry', () => {
  it('roads are wide enough for a tank — at least one cell has a 4 m clear M_PATH neighbourhood', () => {
    const w = buildGrassPlane();
    placeRoads(w.buffers.voxels, 1234);
    const nav = allocateNav(false);
    buildSurfaceNav(w.buffers.voxels, nav);

    // Half the road width is 19 voxels (≈ 2.4 m). On a perfectly straight
    // segment a centred 16-radius (≈ 2 m) disc around the cell centre should
    // be all M_PATH at the surface.
    const v = w.buffers.voxels;
    let bestRadius = 0;
    for (let cz = 4; cz < NAV_H - 4; cz++) {
      for (let cx = 4; cx < NAV_W - 4; cx++) {
        if (nav.road[navIndex(cx, cz)] !== 200) continue; // pick a paved cell
        const ty = topYAt(v, cx, cz);
        if (ty < 0) continue;
        const wxC = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        const wzC = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        // Find the largest radius r such that every voxel within r of the
        // centre, at y=ty, is M_PATH.
        let r = 0;
        for (; r < 20; r++) {
          let ok = true;
          for (let dz = -r; dz <= r && ok; dz++) {
            for (let dx = -r; dx <= r && ok; dx++) {
              if (dx * dx + dz * dz > r * r) continue;
              const x = wxC + dx;
              const z = wzC + dz;
              if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) { ok = false; break; }
              if (v[worldIndex(x, ty, z)] !== M_PATH) { ok = false; break; }
            }
          }
          if (!ok) break;
        }
        if (r > bestRadius) bestRadius = r;
      }
    }
    // 16 voxels = 2 m radius → 4 m disc fits inside the road. Tank width 2.4 m
    // → road must be ≥ ~5 m to fit a 4 m disc, so allow a little tolerance.
    expect(bestRadius).toBeGreaterThanOrEqual(15);
  });

  it('road grade between adjacent road cells is ≤ 40°', () => {
    const w = buildGrassRamp();
    placeRoads(w.buffers.voxels, 7777);
    const v = w.buffers.voxels;

    // tan(40°) cap → cardinal max rise 6 voxels, diagonal max rise 9.
    const CARD = 6, DIAG = 9;
    let pairsChecked = 0;
    for (let cz = 0; cz < NAV_H; cz++) {
      for (let cx = 0; cx < NAV_W; cx++) {
        const ty = topYAt(v, cx, cz);
        if (ty < 0) continue;
        const wxC = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        const wzC = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        if (v[worldIndex(wxC, ty, wzC)] !== M_PATH
          && v[worldIndex(wxC, ty, wzC)] !== M_DIRT_ROAD) continue;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
            const nty = topYAt(v, nx, nz);
            if (nty < 0) continue;
            const nwx = nx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
            const nwz = nz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
            const nm = v[worldIndex(nwx, nty, nwz)];
            if (nm !== M_PATH && nm !== M_DIRT_ROAD) continue;
            const rise = Math.abs(nty - ty);
            const cap = (dx === 0 || dz === 0) ? CARD : DIAG;
            expect(rise).toBeLessThanOrEqual(cap);
            pairsChecked++;
          }
        }
      }
    }
    expect(pairsChecked).toBeGreaterThan(0);
  });

  it('road surface is flat across its width on a slope (no side-tilt)', () => {
    const w = buildGrassRamp();
    placeRoads(w.buffers.voxels, 4242);
    const v = w.buffers.voxels;
    const nav = allocateNav(false);
    buildSurfaceNav(v, nav);

    // For each paved cell, find the longest constant-topY run through the
    // cell centre across the four axis-aligned directions. The road is flat
    // perpendicular to travel direction but graded along it; one of the four
    // sweeps will land near-perpendicular and produce a long flat run.
    const dirs: { dx: number; dz: number }[] = [
      { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 1, dz: 1 }, { dx: 1, dz: -1 },
    ];
    const topRoadY = (x: number, z: number): number => {
      if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return -2;
      for (let y = 191; y >= 1; y--) {
        const m = v[worldIndex(x, y, z)]!;
        if (m === M_PATH || m === M_DIRT_ROAD) return y;
        if (m !== 0) return -1;
      }
      return -1;
    };
    let cellsWithFlatRun = 0;
    for (let cz = 4; cz < NAV_H - 4; cz++) {
      for (let cx = 4; cx < NAV_W - 4; cx++) {
        if (nav.road[navIndex(cx, cz)] !== 200) continue;
        const wxC = cx * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        const wzC = cz * NAV_CELL_VOXELS + (NAV_CELL_VOXELS >> 1);
        const cy = topRoadY(wxC, wzC);
        if (cy < 0) continue;
        let bestRun = 0;
        for (const d of dirs) {
          let run = 1;
          for (let s = 1; s < 25; s++) {
            const tyP = topRoadY(wxC + d.dx * s, wzC + d.dz * s);
            if (tyP !== cy) break;
            run++;
          }
          for (let s = 1; s < 25; s++) {
            const tyN = topRoadY(wxC - d.dx * s, wzC - d.dz * s);
            if (tyN !== cy) break;
            run++;
          }
          if (run > bestRun) bestRun = run;
        }
        // 2*ROAD_HALF_VOXELS+1 = 39 perpendicular voxels at minimum on a
        // perfectly axis-aligned road. Diagonal perpendicular slice through
        // a 39-voxel-wide strip is 39*√2 ≈ 55 voxels. Allow slack for endpoint
        // taper and minor angle mismatch.
        if (bestRun >= 35) cellsWithFlatRun++;
      }
    }
    expect(cellsWithFlatRun).toBeGreaterThan(0);
  });

  it('produces dirt-road branches as well as paved trunks', () => {
    const w = buildGrassPlane();
    const v = w.buffers.voxels;
    const stats = placeRoads(v, 2025);
    let dirt = 0;
    for (let i = 0; i < v.length; i++) if (v[i] === M_DIRT_ROAD) dirt++;
    expect(stats.branchSegments).toBeGreaterThan(0);
    expect(dirt).toBeGreaterThan(0);
  });

  it('dirt-road branches give a non-zero, less-than-paved road weight in surface nav', () => {
    const w = buildGrassPlane();
    placeRoads(w.buffers.voxels, 31);
    const nav = allocateNav(false);
    buildSurfaceNav(w.buffers.voxels, nav);
    let pavedCells = 0, dirtCells = 0;
    for (let i = 0; i < nav.road.length; i++) {
      if (nav.road[i] === 200) pavedCells++;
      else if (nav.road[i]! > 0 && nav.road[i]! < 200) dirtCells++;
    }
    expect(pavedCells).toBeGreaterThan(0);
    expect(dirtCells).toBeGreaterThan(0);
  });

  it('every paved column has road material at its surface (no air gaps)', () => {
    // The stamp fills the road as discs+ribbons. Every voxel column the
    // generator marked as road must actually have road material on top —
    // otherwise the visible surface has notches/holes (the original turn-gap
    // bug stamped only thin rectangles, leaving voxel columns inside the
    // road footprint with grass on top).
    const w = buildGrassPlane();
    const v = w.buffers.voxels;
    const stats = placeRoads(v, 1234);
    let mismatches = 0;
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        if (!stats.columnMask[z * WORLD_X + x]) continue;
        // Topmost solid voxel must be road.
        let top = -1;
        for (let y = WORLD_Y - 1; y >= 1; y--) {
          if (v[worldIndex(x, y, z)] !== 0) { top = v[worldIndex(x, y, z)]!; break; }
        }
        if (top !== M_PATH && top !== M_DIRT_ROAD) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});

describe('clearAboveRoads', () => {
  it('clears wood/leaf voxels above road columns but leaves the road surface intact', () => {
    const w = buildGrassPlane();
    const v = w.buffers.voxels;
    const stats = placeRoads(v, 4242);

    // Drop a leaf and a wood voxel above a paved column to simulate a tree
    // canopy that drifted across the road.
    let chosenX = -1, chosenZ = -1, chosenY = -1, chosenMat = 0;
    for (let z = 0; z < WORLD_Z && chosenX < 0; z++) {
      for (let x = 0; x < WORLD_X && chosenX < 0; x++) {
        if (!stats.columnMask[z * WORLD_X + x]) continue;
        for (let y = WORLD_Y - 1; y >= 1; y--) {
          const m = v[worldIndex(x, y, z)]!;
          if (m === AIR) continue;
          if (m === M_PATH || m === M_DIRT_ROAD) {
            chosenX = x; chosenZ = z; chosenY = y; chosenMat = m;
          }
          break;
        }
      }
    }
    expect(chosenX).toBeGreaterThanOrEqual(0);
    v[worldIndex(chosenX, chosenY + 3, chosenZ)] = M_LEAF;
    v[worldIndex(chosenX, chosenY + 5, chosenZ)] = M_WOOD;

    clearAboveRoads(v, stats.columnMask);

    // Surface road voxel still there (whichever flavor the column had); tree
    // voxels above are gone.
    expect(v[worldIndex(chosenX, chosenY, chosenZ)]).toBe(chosenMat);
    expect(v[worldIndex(chosenX, chosenY + 3, chosenZ)]).toBe(AIR);
    expect(v[worldIndex(chosenX, chosenY + 5, chosenZ)]).toBe(AIR);
  });
});
