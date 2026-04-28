// Test-only ASCII visualization helpers for the multi-resolution 3D
// pathfinder. Production code must not import this module — it exists so
// `tests/multiResVisual3D.spec.ts` can `console.log` slices of the volume nav
// and the coarse super-cell grids while iterating on the search.

import { ResLevel3D, superCellIndex } from './MultiResNav3D';
import { VolumeNavBuffers, vnavIndex, getBit, VNAV_X, VNAV_Y, VNAV_Z } from './VolumeNav';

interface BaseCell { cx: number; cy: number; cz: number }
interface SuperCell { sx: number; sy: number; sz: number }

const MAX_PRINT_WIDTH = 80;

/** Pick the auto stride so the rendered axis stays under ~80 chars. */
function autoStride(extent: number): number {
  return Math.max(1, Math.ceil(extent / MAX_PRINT_WIDTH));
}

/** Snap an absolute coord onto the nearest sampled column for a given stride. */
function snapToStride(coord: number, stride: number): number {
  return Math.round(coord / stride) * stride;
}

/** Build a Set of "cy*M+cz*K+cx" keys for stickied path cells. */
function pathKeys(
  path: readonly BaseCell[] | undefined,
): Set<number> {
  const out = new Set<number>();
  if (!path) return out;
  for (const p of path) {
    out.add(encodeBase(p.cx, p.cy, p.cz));
  }
  return out;
}

function encodeBase(cx: number, cy: number, cz: number): number {
  // Pack into a single integer key. Volume nav fits within 2^24 cells;
  // multiplying by VNAV_X*VNAV_Z keeps us inside safe integer range.
  return (cy * VNAV_Z + cz) * VNAV_X + cx;
}

function encodeSuper(level: ResLevel3D, sx: number, sy: number, sz: number): number {
  return (sy * level.d + sz) * level.w + sx;
}

function superKeys(
  level: ResLevel3D,
  path: readonly SuperCell[] | undefined,
): Set<number> {
  const out = new Set<number>();
  if (!path) return out;
  for (const p of path) out.add(encodeSuper(level, p.sx, p.sy, p.sz));
  return out;
}

/** Decide the glyph for a base-volume cell at (cx,cy,cz). */
function baseGlyph(
  vnav: VolumeNavBuffers,
  cx: number,
  cy: number,
  cz: number,
  expanded: Uint8Array | null | undefined,
  corridor: Uint8Array | null | undefined,
): string {
  const i = vnavIndex(cx, cy, cz);
  if (getBit(vnav.solid, i) === 1) return '#';
  // Air. Default — sealed.
  let g = '~';
  if (getBit(vnav.surfaceConnected, i) === 1) g = '.';
  if (corridor && getBit(corridor, i) === 1) g = ':';
  if (expanded && getBit(expanded, i) === 1) g = 'o';
  return g;
}

/**
 * Render an XZ slice at a fixed Y from the BASE volume nav.
 *
 * Glyph priority (later overrides earlier):
 *   '#' solid (any solid voxel — bedrock or otherwise)
 *   '~' air, NOT surface-connected
 *   '.' air, surface-connected
 *   ':' air, in corridor (corridorMask flag set)
 *   'o' air, expanded by Dijkstra (expandedMask flag set)
 *   '*' on the path
 *   'S' start cell
 *   'G' goal cell
 */
export function renderXZSlice(opts: {
  vnav: VolumeNavBuffers;
  y: number;
  expanded?: Uint8Array | null;
  corridor?: Uint8Array | null;
  path?: readonly BaseCell[];
  start?: BaseCell;
  goal?: BaseCell;
  sampleStride?: number;
  title?: string;
}): string {
  const { vnav, y } = opts;
  const expanded = opts.expanded ?? null;
  const corridor = opts.corridor ?? null;
  const w = VNAV_X;
  const d = VNAV_Z;
  const stride = opts.sampleStride && opts.sampleStride > 0
    ? Math.floor(opts.sampleStride)
    : autoStride(Math.max(w, d));
  const cy = Math.max(0, Math.min(VNAV_Y - 1, Math.floor(y)));

  const pathSet = pathKeys(opts.path);

  const lines: string[] = [];
  if (opts.title) lines.push(opts.title);
  lines.push(`y=${cy} dim=${w}x${d} stride=${stride}`);

  // Pre-snap markers to the grid the stride samples.
  const startSnap = opts.start ? {
    cx: snapToStride(opts.start.cx, stride),
    cz: snapToStride(opts.start.cz, stride),
  } : null;
  const goalSnap = opts.goal ? {
    cx: snapToStride(opts.goal.cx, stride),
    cz: snapToStride(opts.goal.cz, stride),
  } : null;

  // Build path snap set in sampled-coord space so markers are sticky on the
  // exact cells the grid prints.
  const pathSnap = new Set<number>();
  if (opts.path) {
    for (const p of opts.path) {
      // Only include cells on (or near) this Y plane.
      if (p.cy === cy) {
        const sx = snapToStride(p.cx, stride);
        const sz = snapToStride(p.cz, stride);
        if (sx >= 0 && sx < w && sz >= 0 && sz < d) {
          pathSnap.add(sz * w + sx);
        }
      }
    }
  }

  for (let cz = 0; cz < d; cz += stride) {
    let row = '';
    for (let cx = 0; cx < w; cx += stride) {
      let g = baseGlyph(vnav, cx, cy, cz, expanded, corridor);
      // Sticky overrides — path beats expansion, start/goal beat path.
      if (pathSnap.has(cz * w + cx)) g = '*';
      if (pathSet.has(encodeBase(cx, cy, cz))) g = '*';
      if (startSnap && startSnap.cx === cx && startSnap.cz === cz && opts.start && opts.start.cy === cy) g = 'S';
      if (goalSnap && goalSnap.cx === cx && goalSnap.cz === cz && opts.goal && opts.goal.cy === cy) g = 'G';
      row += g;
    }
    lines.push(row);
  }
  return lines.join('\n');
}

/**
 * Render an XY slice at a fixed Z from the BASE volume nav. Same glyph rules.
 * The Y axis runs vertical (top of grid = highest Y).
 */
export function renderXYSlice(opts: {
  vnav: VolumeNavBuffers;
  z: number;
  expanded?: Uint8Array | null;
  corridor?: Uint8Array | null;
  path?: readonly BaseCell[];
  start?: BaseCell;
  goal?: BaseCell;
  sampleStride?: number;
  title?: string;
}): string {
  const { vnav, z } = opts;
  const expanded = opts.expanded ?? null;
  const corridor = opts.corridor ?? null;
  const w = VNAV_X;
  const h = VNAV_Y;
  const stride = opts.sampleStride && opts.sampleStride > 0
    ? Math.floor(opts.sampleStride)
    : autoStride(Math.max(w, h));
  const cz = Math.max(0, Math.min(VNAV_Z - 1, Math.floor(z)));

  const pathSet = pathKeys(opts.path);

  const lines: string[] = [];
  if (opts.title) lines.push(opts.title);
  lines.push(`z=${cz} dim=${w}x${h} stride=${stride} (y=${h - 1}..0)`);

  const startSnap = opts.start ? {
    cx: snapToStride(opts.start.cx, stride),
    cy: snapToStride(opts.start.cy, stride),
  } : null;
  const goalSnap = opts.goal ? {
    cx: snapToStride(opts.goal.cx, stride),
    cy: snapToStride(opts.goal.cy, stride),
  } : null;

  const pathSnap = new Set<number>();
  if (opts.path) {
    for (const p of opts.path) {
      if (p.cz === cz) {
        const sx = snapToStride(p.cx, stride);
        const sy = snapToStride(p.cy, stride);
        if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
          pathSnap.add(sy * w + sx);
        }
      }
    }
  }

  // Iterate from top (highest Y) to bottom (Y=0) so caves draw below sky.
  // We must walk in stride steps starting from the top, anchored to a stride
  // multiple, so the snapped marker coords still land on rendered rows.
  const topCy = Math.floor((h - 1) / stride) * stride;
  for (let cy = topCy; cy >= 0; cy -= stride) {
    let row = '';
    for (let cx = 0; cx < w; cx += stride) {
      let g = baseGlyph(vnav, cx, cy, cz, expanded, corridor);
      if (pathSnap.has(cy * w + cx)) g = '*';
      if (pathSet.has(encodeBase(cx, cy, cz))) g = '*';
      if (startSnap && startSnap.cx === cx && startSnap.cy === cy && opts.start && opts.start.cz === cz) g = 'S';
      if (goalSnap && goalSnap.cx === cx && goalSnap.cy === cy && opts.goal && opts.goal.cz === cz) g = 'G';
      row += g;
    }
    lines.push(row);
  }
  return lines.join('\n');
}

/**
 * Render a coarse super-cell grid for one ResLevel3D as an XZ slice at a
 * fixed super-cell Y. One glyph per super-cell, no sampling.
 *
 * Glyphs:
 *   '#' bedrockOnly OR planeCount=0 (totally solid)
 *   '.' has planes, surface-connected
 *   '~' has planes, NONE surface-connected (sealed cavity)
 *   ':' on the corridor mask (if provided)
 *   'o' on the expanded mask (if provided)
 *   '*' on the path (if provided)
 *   'S'/'G' start/goal (super-cell coords)
 */
export function renderLevelSliceXZ(opts: {
  level: ResLevel3D;
  sy: number;
  expanded?: Uint8Array | null;
  corridor?: Uint8Array | null;
  path?: readonly SuperCell[];
  start?: SuperCell;
  goal?: SuperCell;
  title?: string;
}): string {
  const { level, sy } = opts;
  const expanded = opts.expanded ?? null;
  const corridor = opts.corridor ?? null;
  const safeSy = Math.max(0, Math.min(level.h - 1, Math.floor(sy)));

  const pathSet = superKeys(level, opts.path);

  const lines: string[] = [];
  if (opts.title) lines.push(opts.title);
  lines.push(`level f=${level.factor} sy=${safeSy} dim=${level.w}x${level.d}`);

  for (let sz = 0; sz < level.d; sz++) {
    let row = '';
    for (let sx = 0; sx < level.w; sx++) {
      const sIdx = superCellIndex(level, sx, safeSy, sz);
      const cell = level.cells[sIdx]!;
      let g: string;
      if (cell.bedrockOnly || cell.planes.length === 0) {
        g = '#';
      } else {
        let anySurface = false;
        for (const pl of cell.planes) {
          if (pl.surfaceConnected) { anySurface = true; break; }
        }
        g = anySurface ? '.' : '~';
      }
      if (corridor && corridor[sIdx] === 1) g = ':';
      if (expanded && expanded[sIdx] === 1) g = 'o';
      if (pathSet.has(sIdx)) g = '*';
      if (opts.start && opts.start.sx === sx && opts.start.sy === safeSy && opts.start.sz === sz) g = 'S';
      if (opts.goal && opts.goal.sx === sx && opts.goal.sy === safeSy && opts.goal.sz === sz) g = 'G';
      row += g;
    }
    lines.push(row);
  }
  return lines.join('\n');
}

/**
 * Format a comparison table:
 *
 *   variant      | reached | expanded | path-cells
 *   baseline     | true    | 18342    | 142
 *   single-corr  | true    | 9201     | 142
 *   multi-res    | true    | 4123     | 144
 */
export function formatComparison(
  rows: readonly { name: string; reached: boolean; expanded: number; pathCells: number }[],
): string {
  const headers = { name: 'variant', reached: 'reached', expanded: 'expanded', pathCells: 'path-cells' };
  let nameW = headers.name.length;
  let reachedW = headers.reached.length;
  let expandedW = headers.expanded.length;
  let pathW = headers.pathCells.length;
  for (const r of rows) {
    if (r.name.length > nameW) nameW = r.name.length;
    const rs = r.reached ? 'true' : 'false';
    if (rs.length > reachedW) reachedW = rs.length;
    const es = String(r.expanded);
    if (es.length > expandedW) expandedW = es.length;
    const ps = String(r.pathCells);
    if (ps.length > pathW) pathW = ps.length;
  }

  const pad = (s: string, n: number): string => {
    if (s.length >= n) return s;
    return s + ' '.repeat(n - s.length);
  };

  const lines: string[] = [];
  lines.push(
    `${pad(headers.name, nameW)} | ${pad(headers.reached, reachedW)} | ${pad(headers.expanded, expandedW)} | ${pad(headers.pathCells, pathW)}`,
  );
  for (const r of rows) {
    lines.push(
      `${pad(r.name, nameW)} | ${pad(r.reached ? 'true' : 'false', reachedW)} | ${pad(String(r.expanded), expandedW)} | ${pad(String(r.pathCells), pathW)}`,
    );
  }
  return lines.join('\n');
}
