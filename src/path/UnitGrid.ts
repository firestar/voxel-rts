/**
 * Per-unit-type 3D pathfinding grid.
 *
 * Each unit kind has its own bit-packed bitmap describing every nav cell it
 * could legally stand in given its footprint width and body height. The grid
 * is derived from the shared VolumeGrid, so the expensive voxel scan happens
 * once per world rebuild, then deriving the per-kind grids is a cheap pass
 * over the cell summary.
 *
 * Passability rules per unit kind:
 *   - Footprint: a (2r+1) × (2r+1) horizontal box around (cx, cz) — every cell
 *     in that box, at every level [cy, cy+heightCells), must be air (or
 *     diggable for diggers). r = max(0, footprintRadiusCells - 1).
 *   - Bedrock anywhere in the box rejects the cell unconditionally.
 *   - requiresGround: at least one cell directly below the footprint at level
 *     cy-1 must be solid (or cy === 0, the world floor).
 *   - Step-climb is enforced at search time, not in the bitmap, because it
 *     depends on the *transition* between two cells.
 */
import {
  NAV_CELL_VOXELS, GRID_X, GRID_Y, GRID_Z, GRID_COUNT,
  cellIndex, getBit, setBit, clearBit, allocateBitmap,
} from './Nav';
import { VolumeGrid, rebuildCell } from './VolumeGrid';

export interface UnitProfile {
  /** Stable string id used as the map key (matches UnitKind). */
  kind: string;
  /**
   * Half-extent of the body footprint in nav cells. 1 = single-cell soldier,
   * 2 = 3 m wide tank, 3 = 5 m wide tunneler. 0 is treated as 1 (the unit
   * always occupies its own cell).
   */
  footprintRadiusCells: number;
  /** Body height in nav cells (rounded up from heightVoxels). */
  heightCells: number;
  /** True for tunnelers/worms — stone/dirt cells count as passable (with a dig cost). */
  canDig: boolean;
  /** True for ground-locked units (everyone except hypothetical fliers). */
  requiresGround: boolean;
  /**
   * Maximum vertical voxel-step between adjacent cells the unit can climb.
   * Used by the search to gate transitions where the floor jumps too far.
   * For diggers this is generous — they grind through whatever's in the way.
   */
  maxStepVoxels: number;
  /** Per-voxel slope penalty applied to the edge cost (0 = ignore slope). */
  slopePenalty: number;
}

export interface UnitGrid {
  profile: UnitProfile;
  /** 1 bit per cell — set when the unit can occupy this cell. */
  passable: Uint8Array;
}

export function allocateUnitGrid(useShared: boolean, profile: UnitProfile): UnitGrid {
  return {
    profile,
    passable: allocateBitmap(useShared, GRID_COUNT),
  };
}

/** Half-extent in cells of a unit's footprint. Always >= 0. */
function halfFootprint(p: UnitProfile): number {
  return Math.max(0, p.footprintRadiusCells - 1);
}

/**
 * True when the unit can occupy this cell (footprint + height fits, no
 * bedrock anywhere in the body box, and requiresGround is satisfied if set).
 *
 * For diggers, "fits" means non-bedrock; the digger will carve out any
 * dirt/stone in the box at runtime. For non-diggers, every cell in the
 * footprint+height box must be air-only (vg.solid == 0).
 */
export function isUnitCellPassable(vg: VolumeGrid, p: UnitProfile, cx: number, cy: number, cz: number): boolean {
  const r = halfFootprint(p);
  const h = Math.max(1, p.heightCells);
  if (cx - r < 0 || cz - r < 0 || cx + r >= GRID_X || cz + r >= GRID_Z) return false;
  if (cy < 0 || cy + h - 1 >= GRID_Y) return false;

  for (let dy = 0; dy < h; dy++) {
    const y = cy + dy;
    for (let dz = -r; dz <= r; dz++) {
      const z = cz + dz;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const i = cellIndex(x, y, z);
        if (getBit(vg.bedrock, i)) return false;
        if (!p.canDig && getBit(vg.solid, i)) return false;
      }
    }
  }

  if (p.requiresGround) {
    if (cy === 0) return true; // standing on world floor (bedrock layer below)
    let foundFloor = false;
    const yBelow = cy - 1;
    for (let dz = -r; dz <= r && !foundFloor; dz++) {
      const z = cz + dz;
      for (let dx = -r; dx <= r && !foundFloor; dx++) {
        const x = cx + dx;
        if (getBit(vg.solid, cellIndex(x, yBelow, z)) === 1) foundFloor = true;
      }
    }
    if (!foundFloor) return false;
  }

  return true;
}

/** Update the bitmap entry for a single cell from the latest VolumeGrid. */
export function refreshUnitCell(vg: VolumeGrid, grid: UnitGrid, cx: number, cy: number, cz: number): void {
  const i = cellIndex(cx, cy, cz);
  if (isUnitCellPassable(vg, grid.profile, cx, cy, cz)) setBit(grid.passable, i);
  else clearBit(grid.passable, i);
}

export function buildUnitGrid(vg: VolumeGrid, grid: UnitGrid): void {
  grid.passable.fill(0);
  for (let cy = 0; cy < GRID_Y; cy++) {
    for (let cz = 0; cz < GRID_Z; cz++) {
      for (let cx = 0; cx < GRID_X; cx++) {
        refreshUnitCell(vg, grid, cx, cy, cz);
      }
    }
  }
}

/**
 * Refresh every cell whose passability could be affected by a change in the
 * volume cell at (vx, vy, vz). Because passability checks a (2r+1)² × heightCells
 * box, a single cell change ripples to neighbours up to `r` cells in xz and
 * `heightCells - 1` cells below in y. We re-evaluate that whole window.
 */
export function refreshUnitNeighborhood(vg: VolumeGrid, grid: UnitGrid, vx: number, vy: number, vz: number): void {
  const p = grid.profile;
  const r = halfFootprint(p);
  const h = Math.max(1, p.heightCells);
  const x0 = Math.max(0, vx - r);
  const x1 = Math.min(GRID_X - 1, vx + r);
  const z0 = Math.max(0, vz - r);
  const z1 = Math.min(GRID_Z - 1, vz + r);
  // Vertical: a change at vy affects every cell whose body box contains vy,
  // i.e. cy in [vy - h + 1, vy]. Also a change at vy affects requiresGround
  // for the cell at vy + 1 (floor below). Cover both.
  const y0 = Math.max(0, vy - h + 1);
  const y1 = Math.min(GRID_Y - 1, vy + 1);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        refreshUnitCell(vg, grid, cx, cy, cz);
      }
    }
  }
}

/**
 * Apply a list of dirty volume cells to a unit grid: re-evaluate the affected
 * neighbourhood for each. The callsite is expected to have already refreshed
 * those cells in the VolumeGrid (so vg reflects the new world).
 */
export function refreshUnitGridDirty(vg: VolumeGrid, grid: UnitGrid, dirtyCells: ReadonlyArray<number>): void {
  for (let k = 0; k < dirtyCells.length; k++) {
    const i = dirtyCells[k]!;
    const cx = i % GRID_X;
    const tmp = (i / GRID_X) | 0;
    const cz = tmp % GRID_Z;
    const cy = (tmp / GRID_Z) | 0;
    refreshUnitNeighborhood(vg, grid, cx, cy, cz);
  }
}

/**
 * Convenience: rebuild every cell affected by a chunk-aligned dirty box.
 * Updates the volume grid in-place over the box, then re-derives unit cells
 * from it. Returns true when at least one cell changed.
 */
export function applyDirtyVoxelBox(
  voxels: Uint8Array,
  vg: VolumeGrid,
  cellX0: number, cellY0: number, cellZ0: number,
  cellX1: number, cellY1: number, cellZ1: number,
): number[] {
  const dirty: number[] = [];
  const x0 = Math.max(0, cellX0);
  const y0 = Math.max(0, cellY0);
  const z0 = Math.max(0, cellZ0);
  const x1 = Math.min(GRID_X - 1, cellX1);
  const y1 = Math.min(GRID_Y - 1, cellY1);
  const z1 = Math.min(GRID_Z - 1, cellZ1);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        rebuildCell(voxels, vg, cx, cy, cz);
        dirty.push(cellIndex(cx, cy, cz));
      }
    }
  }
  return dirty;
}

export function isPassable(grid: UnitGrid, cx: number, cy: number, cz: number): boolean {
  if (cx < 0 || cy < 0 || cz < 0 || cx >= GRID_X || cy >= GRID_Y || cz >= GRID_Z) return false;
  return getBit(grid.passable, cellIndex(cx, cy, cz)) === 1;
}
