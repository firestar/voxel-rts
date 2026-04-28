import { VolumeNavBuffers, vnavIndex, getBit, VNAV_X, VNAV_Y, VNAV_Z } from './VolumeNav';

export const MAX_PLANES_PER_CELL = 8 as const;

export interface CoarsePlane {
  rootBaseCell: number;
  size: number;
  ySum: number;
  surfaceConnected: boolean;
}

export interface CoarseEdge {
  neighbourCellIdx: number;
  neighbourPlaneIdx: number;
  localPlaneIdx: number;
  /** 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z. */
  axis: number;
  cost: number;
}

export interface CoarseSuperCell {
  planes: CoarsePlane[];
  edges: CoarseEdge[];
  bedrockOnly: boolean;
  avgDigCost: number;
}

export interface ResLevel3D {
  factor: number;
  w: number; h: number; d: number;
  count: number;
  cells: CoarseSuperCell[];
  /**
   * Per (super-cell, local linear offset) → planeIdx+1, or 0 if not air / OOB.
   * Length = count * factor³ for k>=1; zero-length for the base level.
   */
  cellPlaneMap: Uint8Array;
}

export interface MultiResNav3D {
  readonly factors: readonly number[];
  readonly levels: ResLevel3D[];
  readonly navW: number;
  readonly navH: number;
  readonly navD: number;
}

export function generateFactors(navW: number, navH: number, navD: number, targetRatio: number = 20): number[] {
  const maxDim = Math.max(navW, navH, navD);
  if (maxDim <= 1) return [1];
  const out: number[] = [1];
  while (out[out.length - 1]! < maxDim) {
    const last = out[out.length - 1]!;
    const next = Math.min(last * targetRatio, maxDim);
    if (next === last) break;
    out.push(next);
  }
  if (out[out.length - 1]! !== maxDim) out.push(maxDim);
  return out;
}

export function allocateMultiResNav3D(navW: number, navH: number, navD: number, factors: readonly number[]): MultiResNav3D {
  const levels: ResLevel3D[] = [];
  for (let li = 0; li < factors.length; li++) {
    const f = factors[li]!;
    if (f === 1) {
      levels.push({
        factor: 1,
        w: navW, h: navH, d: navD,
        count: navW * navH * navD,
        cells: [],
        cellPlaneMap: new Uint8Array(0),
      });
      continue;
    }
    const w = Math.ceil(navW / f);
    const h = Math.ceil(navH / f);
    const d = Math.ceil(navD / f);
    const count = w * h * d;
    const cells: CoarseSuperCell[] = new Array(count);
    for (let i = 0; i < count; i++) {
      cells[i] = { planes: [], edges: [], bedrockOnly: false, avgDigCost: 0 };
    }
    levels.push({
      factor: f,
      w, h, d,
      count,
      cells,
      cellPlaneMap: new Uint8Array(count * f * f * f),
    });
  }
  return { factors: factors.slice(), levels, navW, navH, navD };
}

export function superCellIndex(level: ResLevel3D, sx: number, sy: number, sz: number): number {
  return (sy * level.d + sz) * level.w + sx;
}

export function baseCellToSuperCellCoords(level: ResLevel3D, cx: number, cy: number, cz: number): { sx: number; sy: number; sz: number } {
  const f = level.factor;
  return { sx: (cx / f) | 0, sy: (cy / f) | 0, sz: (cz / f) | 0 };
}

export function baseCellPlane(level: ResLevel3D, cx: number, cy: number, cz: number): number {
  const f = level.factor;
  if (f === 1 || level.cellPlaneMap.length === 0) return -1;
  const sx = (cx / f) | 0;
  const sy = (cy / f) | 0;
  const sz = (cz / f) | 0;
  const lx = cx - sx * f;
  const ly = cy - sy * f;
  const lz = cz - sz * f;
  const sIdx = superCellIndex(level, sx, sy, sz);
  if (sIdx < 0 || sIdx >= level.count) return -1;
  if (level.cells[sIdx]!.planes.length === 0) return -1;
  const off = ((ly * f) + lz) * f + lx;
  const v = level.cellPlaneMap[sIdx * f * f * f + off]!;
  return v === 0 ? -1 : v - 1;
}

export function buildMultiResNav3D(vnav: VolumeNavBuffers, mr: MultiResNav3D): void {
  for (let li = 1; li < mr.levels.length; li++) {
    buildLevel(vnav, mr.levels[li]!, mr.navW, mr.navH, mr.navD);
  }
}

function buildLevel(vnav: VolumeNavBuffers, level: ResLevel3D, navW: number, navH: number, navD: number): void {
  const f = level.factor;
  const f3 = f * f * f;
  const map = level.cellPlaneMap;
  map.fill(0);

  // Reusable BFS scratch sized to one super-cell.
  const queue = new Int32Array(f3);

  for (let sy = 0; sy < level.h; sy++) {
    for (let sz = 0; sz < level.d; sz++) {
      for (let sx = 0; sx < level.w; sx++) {
        const sIdx = superCellIndex(level, sx, sy, sz);
        const cell = level.cells[sIdx]!;
        cell.planes.length = 0;
        cell.edges.length = 0;

        const baseMapOff = sIdx * f3;
        const x0 = sx * f, y0 = sy * f, z0 = sz * f;
        const xMax = Math.min(f, navW - x0);
        const yMax = Math.min(f, navH - y0);
        const zMax = Math.min(f, navD - z0);

        let solidCount = 0;
        let digSum = 0;
        let allBedrock = true;
        let anySolid = false;

        // Pass 1: scan all cells for solid stats.
        for (let ly = 0; ly < yMax; ly++) {
          const cy = y0 + ly;
          for (let lz = 0; lz < zMax; lz++) {
            const cz = z0 + lz;
            for (let lx = 0; lx < xMax; lx++) {
              const cx = x0 + lx;
              const bi = vnavIndex(cx, cy, cz);
              if (getBit(vnav.solid, bi) === 1) {
                anySolid = true;
                solidCount++;
                digSum += vnav.digCost[bi]!;
                if (getBit(vnav.bedrock, bi) === 0) allBedrock = false;
              } else {
                allBedrock = false;
              }
            }
          }
        }

        cell.bedrockOnly = anySolid && allBedrock;
        cell.avgDigCost = solidCount > 0 ? Math.min(255, Math.round(digSum / solidCount)) : 0;

        // Pass 2: flood-fill air components within this super-cell.
        let planeCount = 0;
        for (let ly = 0; ly < yMax; ly++) {
          const cy = y0 + ly;
          for (let lz = 0; lz < zMax; lz++) {
            const cz = z0 + lz;
            for (let lx = 0; lx < xMax; lx++) {
              const cx = x0 + lx;
              const bi = vnavIndex(cx, cy, cz);
              if (getBit(vnav.solid, bi) === 1) continue;
              const off = ((ly * f) + lz) * f + lx;
              if (map[baseMapOff + off]! !== 0) continue;

              // Either start a new plane or merge into the last slot if at cap.
              const isMergeIntoLast = planeCount >= MAX_PLANES_PER_CELL;
              const targetPlaneIdx = isMergeIntoLast ? MAX_PLANES_PER_CELL - 1 : planeCount;
              const stamp = targetPlaneIdx + 1;

              let qhead = 0;
              let qtail = 0;
              queue[qtail++] = off;
              map[baseMapOff + off] = stamp;

              let size = 0;
              let ySum = 0;
              let surfaceConnected = false;
              const rootBaseCell = bi;

              while (qhead < qtail) {
                const cur = queue[qhead++]!;
                const curLx = cur % f;
                const tmp = (cur / f) | 0;
                const curLz = tmp % f;
                const curLy = (tmp / f) | 0;
                const curCx = x0 + curLx;
                const curCy = y0 + curLy;
                const curCz = z0 + curLz;
                const curBi = vnavIndex(curCx, curCy, curCz);

                size++;
                ySum += curCy;
                if (getBit(vnav.surfaceConnected, curBi) === 1) surfaceConnected = true;

                // 6-connected neighbours, restricted to this super-cell block.
                // +X
                if (curLx + 1 < xMax) {
                  const nOff = cur + 1;
                  if (map[baseMapOff + nOff]! === 0) {
                    const nBi = vnavIndex(curCx + 1, curCy, curCz);
                    if (getBit(vnav.solid, nBi) === 0) {
                      map[baseMapOff + nOff] = stamp;
                      queue[qtail++] = nOff;
                    }
                  }
                }
                // -X
                if (curLx > 0) {
                  const nOff = cur - 1;
                  if (map[baseMapOff + nOff]! === 0) {
                    const nBi = vnavIndex(curCx - 1, curCy, curCz);
                    if (getBit(vnav.solid, nBi) === 0) {
                      map[baseMapOff + nOff] = stamp;
                      queue[qtail++] = nOff;
                    }
                  }
                }
                // +Z
                if (curLz + 1 < zMax) {
                  const nOff = cur + f;
                  if (map[baseMapOff + nOff]! === 0) {
                    const nBi = vnavIndex(curCx, curCy, curCz + 1);
                    if (getBit(vnav.solid, nBi) === 0) {
                      map[baseMapOff + nOff] = stamp;
                      queue[qtail++] = nOff;
                    }
                  }
                }
                // -Z
                if (curLz > 0) {
                  const nOff = cur - f;
                  if (map[baseMapOff + nOff]! === 0) {
                    const nBi = vnavIndex(curCx, curCy, curCz - 1);
                    if (getBit(vnav.solid, nBi) === 0) {
                      map[baseMapOff + nOff] = stamp;
                      queue[qtail++] = nOff;
                    }
                  }
                }
                // +Y
                if (curLy + 1 < yMax) {
                  const nOff = cur + f * f;
                  if (map[baseMapOff + nOff]! === 0) {
                    const nBi = vnavIndex(curCx, curCy + 1, curCz);
                    if (getBit(vnav.solid, nBi) === 0) {
                      map[baseMapOff + nOff] = stamp;
                      queue[qtail++] = nOff;
                    }
                  }
                }
                // -Y
                if (curLy > 0) {
                  const nOff = cur - f * f;
                  if (map[baseMapOff + nOff]! === 0) {
                    const nBi = vnavIndex(curCx, curCy - 1, curCz);
                    if (getBit(vnav.solid, nBi) === 0) {
                      map[baseMapOff + nOff] = stamp;
                      queue[qtail++] = nOff;
                    }
                  }
                }
              }

              if (isMergeIntoLast) {
                const merged = cell.planes[targetPlaneIdx]!;
                merged.size += size;
                merged.ySum += ySum;
                merged.surfaceConnected = merged.surfaceConnected || surfaceConnected;
              } else {
                cell.planes.push({ rootBaseCell, size, ySum, surfaceConnected });
                planeCount++;
              }
            }
          }
        }
      }
    }
  }

  // Edge construction (after planes are filled for every super-cell at this level).
  for (let sy = 0; sy < level.h; sy++) {
    for (let sz = 0; sz < level.d; sz++) {
      for (let sx = 0; sx < level.w; sx++) {
        const sIdx = superCellIndex(level, sx, sy, sz);
        const cell = level.cells[sIdx]!;
        if (cell.planes.length === 0) continue;

        // +X face
        if (sx + 1 < level.w) {
          addFaceEdges(level, vnav, sIdx, sx, sy, sz, 1, 0, 0, 0, navW, navH, navD);
        }
        // +Y face
        if (sy + 1 < level.h) {
          addFaceEdges(level, vnav, sIdx, sx, sy, sz, 0, 1, 0, 2, navW, navH, navD);
        }
        // +Z face
        if (sz + 1 < level.d) {
          addFaceEdges(level, vnav, sIdx, sx, sy, sz, 0, 0, 1, 4, navW, navH, navD);
        }
      }
    }
  }
}

function addFaceEdges(
  level: ResLevel3D,
  vnav: VolumeNavBuffers,
  sIdx: number,
  sx: number, sy: number, sz: number,
  dsx: number, dsy: number, dsz: number,
  axisLocal: number,
  navW: number, navH: number, navD: number,
): void {
  const f = level.factor;
  const f3 = f * f * f;
  const map = level.cellPlaneMap;

  const nsx = sx + dsx, nsy = sy + dsy, nsz = sz + dsz;
  const nIdx = superCellIndex(level, nsx, nsy, nsz);
  const cellA = level.cells[sIdx]!;
  const cellB = level.cells[nIdx]!;
  if (cellB.planes.length === 0) return;

  const x0a = sx * f, y0a = sy * f, z0a = sz * f;
  const x0b = nsx * f, y0b = nsy * f, z0b = nsz * f;
  const offA = sIdx * f3;
  const offB = nIdx * f3;

  // Local pair-set: localPlane * 16 + neighbourPlane.
  const seen = new Set<number>();

  if (axisLocal === 0) {
    // +X face: lx = f-1 in A, lx = 0 in B; iterate ly, lz.
    const lxA = f - 1;
    if (x0a + lxA >= navW) return;
    if (x0b >= navW) return;
    const yMax = Math.min(f, navH - y0a, navH - y0b);
    const zMax = Math.min(f, navD - z0a, navD - z0b);
    for (let ly = 0; ly < yMax; ly++) {
      for (let lz = 0; lz < zMax; lz++) {
        const biA = vnavIndex(x0a + lxA, y0a + ly, z0a + lz);
        if (getBit(vnav.solid, biA) === 1) continue;
        const biB = vnavIndex(x0b, y0b + ly, z0b + lz);
        if (getBit(vnav.solid, biB) === 1) continue;
        const pa = map[offA + ((ly * f) + lz) * f + lxA]! - 1;
        const pb = map[offB + ((ly * f) + lz) * f + 0]! - 1;
        if (pa < 0 || pb < 0) continue;
        seen.add(pa * 16 + pb);
      }
    }
  } else if (axisLocal === 2) {
    // +Y face: ly = f-1 in A, ly = 0 in B; iterate lx, lz.
    const lyA = f - 1;
    if (y0a + lyA >= navH) return;
    if (y0b >= navH) return;
    const xMax = Math.min(f, navW - x0a, navW - x0b);
    const zMax = Math.min(f, navD - z0a, navD - z0b);
    for (let lx = 0; lx < xMax; lx++) {
      for (let lz = 0; lz < zMax; lz++) {
        const biA = vnavIndex(x0a + lx, y0a + lyA, z0a + lz);
        if (getBit(vnav.solid, biA) === 1) continue;
        const biB = vnavIndex(x0b + lx, y0b, z0b + lz);
        if (getBit(vnav.solid, biB) === 1) continue;
        const pa = map[offA + ((lyA * f) + lz) * f + lx]! - 1;
        const pb = map[offB + ((0 * f) + lz) * f + lx]! - 1;
        if (pa < 0 || pb < 0) continue;
        seen.add(pa * 16 + pb);
      }
    }
  } else {
    // +Z face: lz = f-1 in A, lz = 0 in B; iterate lx, ly.
    const lzA = f - 1;
    if (z0a + lzA >= navD) return;
    if (z0b >= navD) return;
    const xMax = Math.min(f, navW - x0a, navW - x0b);
    const yMax = Math.min(f, navH - y0a, navH - y0b);
    for (let ly = 0; ly < yMax; ly++) {
      for (let lx = 0; lx < xMax; lx++) {
        const biA = vnavIndex(x0a + lx, y0a + ly, z0a + lzA);
        if (getBit(vnav.solid, biA) === 1) continue;
        const biB = vnavIndex(x0b + lx, y0b + ly, z0b);
        if (getBit(vnav.solid, biB) === 1) continue;
        const pa = map[offA + ((ly * f) + lzA) * f + lx]! - 1;
        const pb = map[offB + ((ly * f) + 0) * f + lx]! - 1;
        if (pa < 0 || pb < 0) continue;
        seen.add(pa * 16 + pb);
      }
    }
  }

  if (seen.size === 0) return;

  const axisRemote = axisLocal + 1; // -X, -Y, -Z opposite of +X, +Y, +Z
  for (const key of seen) {
    const pa = (key / 16) | 0;
    const pb = key % 16;
    const planeA = cellA.planes[pa]!;
    const planeB = cellB.planes[pb]!;
    const meanYA = planeA.ySum / planeA.size;
    const meanYB = planeB.ySum / planeB.size;
    const cost = 1 + 0.05 * Math.abs(meanYA - meanYB);
    cellA.edges.push({ neighbourCellIdx: nIdx, neighbourPlaneIdx: pb, localPlaneIdx: pa, axis: axisLocal, cost });
    cellB.edges.push({ neighbourCellIdx: sIdx, neighbourPlaneIdx: pa, localPlaneIdx: pb, axis: axisRemote, cost });
  }
}

// Reference dimensions exported for callers that don't want to import from VolumeNav directly.
export const NAV_DIMS_DEFAULT = { w: VNAV_X, h: VNAV_Y, d: VNAV_Z } as const;

/**
 * Recompute one super-cell's planes, cellPlaneMap slice, bedrockOnly, and avgDigCost.
 * Mirrors the per-cell pass inside buildLevel so the incremental updater can reuse it.
 * Does NOT touch edges — call rebuildSuperCellFaceEdges separately.
 */
export function rebuildSuperCellPlanes(
  vnav: VolumeNavBuffers,
  level: ResLevel3D,
  sx: number, sy: number, sz: number,
  navW: number, navH: number, navD: number,
): void {
  const f = level.factor;
  if (f === 1) return;
  const f3 = f * f * f;
  const sIdx = superCellIndex(level, sx, sy, sz);
  if (sIdx < 0 || sIdx >= level.count) return;
  const cell = level.cells[sIdx]!;
  const map = level.cellPlaneMap;
  const baseMapOff = sIdx * f3;

  // Reset this cell's slice and plane list. Edges are handled separately.
  for (let i = 0; i < f3; i++) map[baseMapOff + i] = 0;
  cell.planes.length = 0;

  const x0 = sx * f, y0 = sy * f, z0 = sz * f;
  const xMax = Math.min(f, navW - x0);
  const yMax = Math.min(f, navH - y0);
  const zMax = Math.min(f, navD - z0);
  if (xMax <= 0 || yMax <= 0 || zMax <= 0) {
    cell.bedrockOnly = false;
    cell.avgDigCost = 0;
    return;
  }

  const queue = new Int32Array(f3);

  let solidCount = 0;
  let digSum = 0;
  let allBedrock = true;
  let anySolid = false;

  for (let ly = 0; ly < yMax; ly++) {
    const cy = y0 + ly;
    for (let lz = 0; lz < zMax; lz++) {
      const cz = z0 + lz;
      for (let lx = 0; lx < xMax; lx++) {
        const cx = x0 + lx;
        const bi = vnavIndex(cx, cy, cz);
        if (getBit(vnav.solid, bi) === 1) {
          anySolid = true;
          solidCount++;
          digSum += vnav.digCost[bi]!;
          if (getBit(vnav.bedrock, bi) === 0) allBedrock = false;
        } else {
          allBedrock = false;
        }
      }
    }
  }

  cell.bedrockOnly = anySolid && allBedrock;
  cell.avgDigCost = solidCount > 0 ? Math.min(255, Math.round(digSum / solidCount)) : 0;

  let planeCount = 0;
  for (let ly = 0; ly < yMax; ly++) {
    const cy = y0 + ly;
    for (let lz = 0; lz < zMax; lz++) {
      const cz = z0 + lz;
      for (let lx = 0; lx < xMax; lx++) {
        const cx = x0 + lx;
        const bi = vnavIndex(cx, cy, cz);
        if (getBit(vnav.solid, bi) === 1) continue;
        const off = ((ly * f) + lz) * f + lx;
        if (map[baseMapOff + off]! !== 0) continue;

        const isMergeIntoLast = planeCount >= MAX_PLANES_PER_CELL;
        const targetPlaneIdx = isMergeIntoLast ? MAX_PLANES_PER_CELL - 1 : planeCount;
        const stamp = targetPlaneIdx + 1;

        let qhead = 0;
        let qtail = 0;
        queue[qtail++] = off;
        map[baseMapOff + off] = stamp;

        let size = 0;
        let ySum = 0;
        let surfaceConnected = false;
        const rootBaseCell = bi;

        while (qhead < qtail) {
          const cur = queue[qhead++]!;
          const curLx = cur % f;
          const tmp = (cur / f) | 0;
          const curLz = tmp % f;
          const curLy = (tmp / f) | 0;
          const curCx = x0 + curLx;
          const curCy = y0 + curLy;
          const curCz = z0 + curLz;
          const curBi = vnavIndex(curCx, curCy, curCz);

          size++;
          ySum += curCy;
          if (getBit(vnav.surfaceConnected, curBi) === 1) surfaceConnected = true;

          if (curLx + 1 < xMax) {
            const nOff = cur + 1;
            if (map[baseMapOff + nOff]! === 0) {
              const nBi = vnavIndex(curCx + 1, curCy, curCz);
              if (getBit(vnav.solid, nBi) === 0) {
                map[baseMapOff + nOff] = stamp;
                queue[qtail++] = nOff;
              }
            }
          }
          if (curLx > 0) {
            const nOff = cur - 1;
            if (map[baseMapOff + nOff]! === 0) {
              const nBi = vnavIndex(curCx - 1, curCy, curCz);
              if (getBit(vnav.solid, nBi) === 0) {
                map[baseMapOff + nOff] = stamp;
                queue[qtail++] = nOff;
              }
            }
          }
          if (curLz + 1 < zMax) {
            const nOff = cur + f;
            if (map[baseMapOff + nOff]! === 0) {
              const nBi = vnavIndex(curCx, curCy, curCz + 1);
              if (getBit(vnav.solid, nBi) === 0) {
                map[baseMapOff + nOff] = stamp;
                queue[qtail++] = nOff;
              }
            }
          }
          if (curLz > 0) {
            const nOff = cur - f;
            if (map[baseMapOff + nOff]! === 0) {
              const nBi = vnavIndex(curCx, curCy, curCz - 1);
              if (getBit(vnav.solid, nBi) === 0) {
                map[baseMapOff + nOff] = stamp;
                queue[qtail++] = nOff;
              }
            }
          }
          if (curLy + 1 < yMax) {
            const nOff = cur + f * f;
            if (map[baseMapOff + nOff]! === 0) {
              const nBi = vnavIndex(curCx, curCy + 1, curCz);
              if (getBit(vnav.solid, nBi) === 0) {
                map[baseMapOff + nOff] = stamp;
                queue[qtail++] = nOff;
              }
            }
          }
          if (curLy > 0) {
            const nOff = cur - f * f;
            if (map[baseMapOff + nOff]! === 0) {
              const nBi = vnavIndex(curCx, curCy - 1, curCz);
              if (getBit(vnav.solid, nBi) === 0) {
                map[baseMapOff + nOff] = stamp;
                queue[qtail++] = nOff;
              }
            }
          }
        }

        if (isMergeIntoLast) {
          const merged = cell.planes[targetPlaneIdx]!;
          merged.size += size;
          merged.ySum += ySum;
          merged.surfaceConnected = merged.surfaceConnected || surfaceConnected;
        } else {
          cell.planes.push({ rootBaseCell, size, ySum, surfaceConnected });
          planeCount++;
        }
      }
    }
  }
}

/**
 * Rebuild every face-edge incident to (sx,sy,sz). Clears existing edges from
 * the cell and from each of its 6 neighbours that point back, then re-runs
 * addFaceEdges across all 6 axes. Caller must have already rebuilt planes for
 * this cell AND every neighbour whose plane table might have shifted.
 */
export function rebuildSuperCellFaceEdges(
  vnav: VolumeNavBuffers,
  level: ResLevel3D,
  sx: number, sy: number, sz: number,
  navW: number, navH: number, navD: number,
): void {
  if (level.factor === 1) return;
  const sIdx = superCellIndex(level, sx, sy, sz);
  if (sIdx < 0 || sIdx >= level.count) return;
  const cell = level.cells[sIdx]!;

  // Collect neighbour indices that exist; -1 for OOB.
  const negX = sx > 0 ? superCellIndex(level, sx - 1, sy, sz) : -1;
  const posX = sx + 1 < level.w ? superCellIndex(level, sx + 1, sy, sz) : -1;
  const negY = sy > 0 ? superCellIndex(level, sx, sy - 1, sz) : -1;
  const posY = sy + 1 < level.h ? superCellIndex(level, sx, sy + 1, sz) : -1;
  const negZ = sz > 0 ? superCellIndex(level, sx, sy, sz - 1) : -1;
  const posZ = sz + 1 < level.d ? superCellIndex(level, sx, sy, sz + 1) : -1;

  // Drop any edge from this cell into one of the 6 neighbours.
  cell.edges = cell.edges.filter(e =>
    e.neighbourCellIdx !== negX &&
    e.neighbourCellIdx !== posX &&
    e.neighbourCellIdx !== negY &&
    e.neighbourCellIdx !== posY &&
    e.neighbourCellIdx !== negZ &&
    e.neighbourCellIdx !== posZ,
  );
  // And drop neighbour edges that point back at us.
  if (negX >= 0) level.cells[negX]!.edges = level.cells[negX]!.edges.filter(e => e.neighbourCellIdx !== sIdx);
  if (posX >= 0) level.cells[posX]!.edges = level.cells[posX]!.edges.filter(e => e.neighbourCellIdx !== sIdx);
  if (negY >= 0) level.cells[negY]!.edges = level.cells[negY]!.edges.filter(e => e.neighbourCellIdx !== sIdx);
  if (posY >= 0) level.cells[posY]!.edges = level.cells[posY]!.edges.filter(e => e.neighbourCellIdx !== sIdx);
  if (negZ >= 0) level.cells[negZ]!.edges = level.cells[negZ]!.edges.filter(e => e.neighbourCellIdx !== sIdx);
  if (posZ >= 0) level.cells[posZ]!.edges = level.cells[posZ]!.edges.filter(e => e.neighbourCellIdx !== sIdx);

  if (cell.planes.length === 0) {
    // Still want neighbour-side faces touching us cleared (done above) — nothing to add.
    return;
  }

  // Re-emit edges on +X, +Y, +Z faces of this cell, and on the +X/+Y/+Z faces of the
  // 3 negative-direction neighbours (whose +faces touch our -face). addFaceEdges pushes
  // to both sides, so this covers all 6 faces of (sx,sy,sz).
  if (posX >= 0) addFaceEdges(level, vnav, sIdx, sx, sy, sz, 1, 0, 0, 0, navW, navH, navD);
  if (posY >= 0) addFaceEdges(level, vnav, sIdx, sx, sy, sz, 0, 1, 0, 2, navW, navH, navD);
  if (posZ >= 0) addFaceEdges(level, vnav, sIdx, sx, sy, sz, 0, 0, 1, 4, navW, navH, navD);
  if (negX >= 0 && level.cells[negX]!.planes.length > 0) {
    addFaceEdges(level, vnav, negX, sx - 1, sy, sz, 1, 0, 0, 0, navW, navH, navD);
  }
  if (negY >= 0 && level.cells[negY]!.planes.length > 0) {
    addFaceEdges(level, vnav, negY, sx, sy - 1, sz, 0, 1, 0, 2, navW, navH, navD);
  }
  if (negZ >= 0 && level.cells[negZ]!.planes.length > 0) {
    addFaceEdges(level, vnav, negZ, sx, sy, sz - 1, 0, 0, 1, 4, navW, navH, navD);
  }
}
