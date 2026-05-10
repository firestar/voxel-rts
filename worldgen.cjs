// Server-side port of the browser worldgen pipeline.
//
// Phase 6c-1 (this drop): RNG + noise + per-column heightmap (the
// loop body of `src/workers/worldgen.worker.ts`). Roads / Trees /
// Metals are still client-only — they're the bulk of the LOC and
// require their own bit-exact ports.
//
// Bit-exactness with the TS source is critical: server and client
// must produce identical voxel material at every (x, y, z) for the
// same seed, otherwise authoritative chunk diffs would constantly
// flag legitimate terrain as "modified". Every operation here is
// expressed with explicit `| 0` / `>>> 0` / `Math.imul` casts that
// match what V8 emits for the same TS code.

const M_AIR = 0;
const M_GRASS = 1;
const M_DIRT = 2;
const M_STONE = 3;
const M_WOOD = 4;
const M_LEAF = 5;
const M_PATH = 6;
const M_BEDROCK = 7;
const M_MUD = 8;
const M_DIRT_ROAD = 9;
const M_METAL = 10;

const VOXEL_SIZE = 0.125;

// World dimensions — kept in sync with `src/voxel/types.ts` and
// duplicated in `game-server.cjs` so this module can be imported by
// other Node entry points without a circular dep.
const WORLD_X = 3072;
const WORLD_Y = 160;
const WORLD_Z = 3072;

function worldIndex(x, y, z) {
  return (y * WORLD_Z + z) * WORLD_X + x;
}

// ---------- Rng (port of src/util/Rng.ts) -----------------------------------

class Xoshiro128 {
  constructor(seed) {
    let x = (seed | 0) || 0x9e3779b9;
    const next = () => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  nextU32() {
    const result = (Math.imul(this._rotl((this.s0 + this.s3) >>> 0, 7), 1) + this.s0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = this._rotl(this.s3, 11);
    return result;
  }

  next() {
    return (this.nextU32() >>> 8) / 0x1000000;
  }

  intRange(lo, hi) {
    return lo + ((this.nextU32() / 0x100000000) * (hi - lo)) | 0;
  }

  _rotl(x, k) {
    return (((x << k) | (x >>> (32 - k))) >>> 0);
  }
}

function hash32(x, y, z, seed) {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h = Math.imul(h ^ (z | 0), 0x9e3779b9);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ---------- Noise (port of src/util/Noise.ts) -------------------------------

function smooth(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gradient2(ix, iy, seed, dx, dy) {
  const h = hash32(ix, iy, 0, seed);
  const a = (h & 7) * (Math.PI / 4);
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

function gradient3(ix, iy, iz, seed, dx, dy, dz) {
  const h = hash32(ix, iy, iz, seed);
  const i = h % 12;
  const gx = (i < 4 ? (i & 1 ? -1 : 1) : (i < 8 ? 0 : (i & 1 ? -1 : 1)));
  const gy = (i < 4 ? (i & 2 ? -1 : 1) : (i < 8 ? (i & 1 ? -1 : 1) : 0));
  const gz = (i < 4 ? 0 : (i & 2 ? -1 : 1));
  return gx * dx + gy * dy + gz * dz;
}

function noise2(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = smooth(fx), v = smooth(fy);
  const n00 = gradient2(ix, iy, seed, fx, fy);
  const n10 = gradient2(ix + 1, iy, seed, fx - 1, fy);
  const n01 = gradient2(ix, iy + 1, seed, fx, fy - 1);
  const n11 = gradient2(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = smooth(fx), v = smooth(fy), w = smooth(fz);
  const n000 = gradient3(ix, iy, iz, seed, fx, fy, fz);
  const n100 = gradient3(ix + 1, iy, iz, seed, fx - 1, fy, fz);
  const n010 = gradient3(ix, iy + 1, iz, seed, fx, fy - 1, fz);
  const n110 = gradient3(ix + 1, iy + 1, iz, seed, fx - 1, fy - 1, fz);
  const n001 = gradient3(ix, iy, iz + 1, seed, fx, fy, fz - 1);
  const n101 = gradient3(ix + 1, iy, iz + 1, seed, fx - 1, fy, fz - 1);
  const n011 = gradient3(ix, iy + 1, iz + 1, seed, fx, fy - 1, fz - 1);
  const n111 = gradient3(ix + 1, iy + 1, iz + 1, seed, fx - 1, fy - 1, fz - 1);
  const x00 = lerp(n000, n100, u);
  const x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u);
  const x11 = lerp(n011, n111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

function fbm2(x, y, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function fbm3(x, y, z, seed, octaves = 3, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function warpedFbm2(x, y, seed) {
  const wx = fbm2(x + 0.0, y + 0.0, seed + 1, 3);
  const wy = fbm2(x + 5.2, y + 1.3, seed + 2, 3);
  return fbm2(x + 4.0 * wx, y + 4.0 * wy, seed, 4);
}

function worley3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let minD = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const h = hash32(cx, cy, cz, seed);
        const fx = (h & 0xff) / 255;
        const fy = ((h >>> 8) & 0xff) / 255;
        const fz = ((h >>> 16) & 0xff) / 255;
        const px = cx + fx, py = cy + fy, pz = cz + fz;
        const ddx = px - x, ddy = py - y, ddz = pz - z;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < minD) minD = d;
      }
    }
  }
  return Math.sqrt(minD);
}

// ---------- Heightmap terrain (port of worldgen.worker.ts) -----------------

// Heightmap tunables. Voxel-scale; mirror the constants in the worker.
const BASE_HEIGHT = 96;
const HEIGHT_AMP = 12;
const HEIGHT_FREQ = 1 / 160;
const DIRT_DEPTH = 12;
const GRASS_DEPTH = 2;
const MOUNTAIN_BAND = 96;
const MOUNTAIN_AMP = 72;
const RIDGE_FREQ = 1 / 48;
const STONE_CAP_TOP = BASE_HEIGHT + HEIGHT_AMP + 16;

/** Fill one (x, z) voxel column of the world's baseline terrain
 *  (bedrock floor, dirt, grass, mountain ring, mud patches). The
 *  caller passes the destination voxel buffer and the column's
 *  position; subsequent worldgen passes (roads / trees / metals)
 *  layer on top. Mirrors worldgen.worker.ts:generate's inner body. */
function generateColumn(voxels, x, z, seed) {
  const w = warpedFbm2(x * HEIGHT_FREQ, z * HEIGHT_FREQ, seed);
  let h = BASE_HEIGHT + w * HEIGHT_AMP;
  const edgeDist = Math.min(x, z, WORLD_X - 1 - x, WORLD_Z - 1 - z);
  const tEdge = Math.max(0, Math.min(1, (MOUNTAIN_BAND - edgeDist) / MOUNTAIN_BAND));
  if (tEdge > 0) {
    const sEdge = tEdge * tEdge * (3 - 2 * tEdge);
    const ridgeN = fbm2(x * RIDGE_FREQ, z * RIDGE_FREQ, seed + 3001, 3);
    const ridge = 0.55 + 0.45 * (ridgeN * 0.5 + 0.5);
    h += sEdge * MOUNTAIN_AMP * ridge;
  }
  const top = Math.max(2, Math.min(WORLD_Y - 1, h | 0));
  const mountainous = top >= STONE_CAP_TOP;
  for (let by = 0; by < 4; by++) voxels[worldIndex(x, by, z)] = M_BEDROCK;
  if (mountainous) {
    for (let y = 4; y <= top; y++) voxels[worldIndex(x, y, z)] = M_STONE;
  } else {
    const grassY = top;
    const dirtTopY = top - GRASS_DEPTH;
    const stoneTopY = dirtTopY - DIRT_DEPTH;
    for (let y = 4; y < top; y++) {
      const idx = worldIndex(x, y, z);
      if (y <= stoneTopY) voxels[idx] = M_STONE;
      else voxels[idx] = M_DIRT;
    }
    voxels[worldIndex(x, grassY, z)] = M_GRASS;
    const elevationT = (h - BASE_HEIGHT) / HEIGHT_AMP;
    const moisture = fbm2(x * (1 / 96), z * (1 / 96), seed + 4099, 3);
    if (elevationT < -0.15 && moisture > 0.05) {
      voxels[worldIndex(x, grassY, z)] = M_MUD;
      const mudDepth = 1 + Math.floor((moisture - 0.05) * 6);
      for (let dy = 1; dy <= mudDepth; dy++) {
        const yy = grassY - dy;
        if (yy <= stoneTopY) break;
        voxels[worldIndex(x, yy, z)] = M_MUD;
      }
    }
  }
  return top;
}

/** Diagnostic helper: produce just the (x, z) column's material
 *  array so we can compare against the browser's worldgen output
 *  byte-for-byte. Returns a Uint8Array of length WORLD_Y. */
function columnMaterials(x, z, seed) {
  // Allocate a tiny buffer just for this column. We can't allocate a
  // full WORLD-sized array at 1.5 GB on a whim; the caller of this
  // helper is the parity test. `generateColumn` writes into a
  // proxy that maps any worldIndex(x, *, z) to its column slot.
  const out = new Uint8Array(WORLD_Y);
  const proxy = new Proxy(out, {
    get(_target, prop) {
      // Numeric-property reads — return the underlying byte. The
      // worldgen body only does writes, but worker.ts reads via
      // `voxels[worldIndex(x, y, z)]` only after writing, so reads
      // map back to the column.
      const idx = Number(prop);
      if (Number.isInteger(idx)) {
        const ly = ((idx / WORLD_X / WORLD_Z) | 0);
        return out[ly] ?? 0;
      }
      return Reflect.get(out, prop);
    },
    set(_target, prop, value) {
      const idx = Number(prop);
      if (Number.isInteger(idx)) {
        const ly = ((idx / WORLD_X / WORLD_Z) | 0);
        out[ly] = value & 0xff;
        return true;
      }
      return Reflect.set(out, prop, value);
    },
  });
  generateColumn(proxy, x, z, seed);
  return out;
}

// ---------- FourAryHeap (port of src/util/Heap.ts) -------------------------
//
// 4-ary min-heap with the same hole-pattern push/pop the browser uses.
// Keys are int32, priorities are float32 — Float32Array storage forces
// the same float-precision truncation on every push, so the heap pop
// order is byte-identical to the TS heap when fed the same priorities.

class FourAryHeap {
  constructor(capacity) {
    this.keys = new Int32Array(capacity);
    this.prio = new Float32Array(capacity);
    this.size = 0;
  }
  get length() { return this.size; }
  clear() { this.size = 0; }
  push(key, priority) {
    if (this.size >= this.keys.length) {
      const newCap = this.keys.length * 2;
      const nk = new Int32Array(newCap);
      const np = new Float32Array(newCap);
      nk.set(this.keys);
      np.set(this.prio);
      this.keys = nk;
      this.prio = np;
    }
    const keys = this.keys;
    const prio = this.prio;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 2;
      const pp = prio[parent];
      if (pp <= priority) break;
      keys[i] = keys[parent];
      prio[i] = pp;
      i = parent;
    }
    keys[i] = key;
    prio[i] = priority;
  }
  pop() {
    if (this.size === 0) return -1;
    const keys = this.keys;
    const prio = this.prio;
    const top = keys[0];
    const n = --this.size;
    if (n > 0) {
      const movedK = keys[n];
      const movedP = prio[n];
      let i = 0;
      while (true) {
        const c0 = (i << 2) + 1;
        if (c0 >= n) break;
        const c1 = c0 + 1;
        const c2 = c0 + 2;
        const c3 = c0 + 3;
        let best = c0;
        let bestP = prio[c0];
        if (c1 < n) { const p = prio[c1]; if (p < bestP) { best = c1; bestP = p; } }
        if (c2 < n) { const p = prio[c2]; if (p < bestP) { best = c2; bestP = p; } }
        if (c3 < n) { const p = prio[c3]; if (p < bestP) { best = c3; bestP = p; } }
        if (movedP <= bestP) break;
        keys[i] = keys[best];
        prio[i] = bestP;
        i = best;
      }
      keys[i] = movedK;
      prio[i] = movedP;
    }
    return top;
  }
  topPriority() { return this.prio[0]; }
}

// ---------- Roads (port of src/voxel/Roads.ts) -----------------------------
//
// Architecture difference from the browser source: the client owns a
// 1.5 GB voxels Uint8Array and stamps roads into it directly. The
// server can't afford that allocation, so this port operates on a
// `Map<colKey, Uint8Array(WORLD_Y)>` of per-column buffers. Each call
// to `getColumnBuf(x, z)` lazily seeds a buffer from `columnMaterials`
// and stashes it; `paveColumnBuf` mutates that buffer in place. After
// the road network is fully stamped we hand the column map back as the
// "road overlay" — `game-server.cjs` reads from it during chunk
// generation, falling through to `columnMaterials` for unmodified
// columns. Bit-exactness with the TS source falls out of (a) the
// noise primitives + Xoshiro128 already proven by parity tests, and
// (b) every numerical operation in the path planner being a literal
// translation of the TS code.

const NAV_CELL_VOXELS = 8;
const NAV_W = WORLD_X / NAV_CELL_VOXELS; // 384
const NAV_H = WORLD_Z / NAV_CELL_VOXELS; // 384

const C = NAV_CELL_VOXELS;
const POI_COUNT = 5;
const POI_MIN_SPACING_CELLS = 20;
const POI_MARGIN_CELLS = 6;
const POI_MAX_LOCAL_SLOPE_VOXELS = 4;
const ROAD_SLOPE_PENALTY = 0.6;
const ROAD_MAX_EXPANSIONS = 50000;
const ROAD_MAX_RISE_CARDINAL = 6;
const ROAD_MAX_RISE_DIAGONAL = 9;
const ROAD_HALF_VOXELS = 19;
const ROAD_DEPTH_VOXELS = 3;
const BRANCH_PER_POI = 2;
const BRANCH_LEN_CELLS_MIN = 6;
const BRANCH_LEN_CELLS_MAX = 14;
const BRANCH_TARGET_ATTEMPTS = 30;

/** Build the coarse 1m road grid (top-walkable Y + surface material per
 *  cell). Reads the heightmap baseline directly via `columnMaterials`,
 *  which is fast — 384×384 = 147 K column generations, each a handful
 *  of fbm calls. */
function buildRoadGrid(seed) {
  const N = NAV_W * NAV_H;
  const topY = new Int16Array(N);
  const surfaceMat = new Uint8Array(N);
  const blocked = new Uint8Array(N);
  for (let cz = 0; cz < NAV_H; cz++) {
    const wz = cz * C + (C >> 1);
    for (let cx = 0; cx < NAV_W; cx++) {
      const wx = cx * C + (C >> 1);
      const col = columnMaterials(wx, wz, seed);
      let top = -1;
      let mat = 0;
      // Skip wood/leaf for parity with the browser even though those
      // materials aren't placed yet at this stage of generation.
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const m = col[y];
        if (m === M_AIR || m === M_WOOD || m === M_LEAF) continue;
        top = y; mat = m;
        break;
      }
      const i = cz * NAV_W + cx;
      topY[i] = top;
      surfaceMat[i] = top >= 0 ? mat : 0;
      blocked[i] = (top < 0 || mat === M_MUD) ? 1 : 0;
    }
  }
  return { topY, surfaceMat, blocked };
}

function pickPOIs(grid, seed) {
  const rng = new Xoshiro128((seed ^ 0xC0FFEE) >>> 0);
  const out = [];
  const minLo = POI_MARGIN_CELLS;
  const maxHi = NAV_W - POI_MARGIN_CELLS;
  const minSpacing2 = POI_MIN_SPACING_CELLS * POI_MIN_SPACING_CELLS;
  for (let attempt = 0; attempt < 600 && out.length < POI_COUNT; attempt++) {
    const cx = rng.intRange(minLo, maxHi);
    const cz = rng.intRange(minLo, NAV_H - POI_MARGIN_CELLS);
    const i = cz * NAV_W + cx;
    if (grid.blocked[i]) continue;
    if (grid.surfaceMat[i] !== M_GRASS) continue;
    const ty = grid.topY[i];
    let okFlat = true;
    for (let dz = -1; dz <= 1 && okFlat; dz++) {
      for (let dx = -1; dx <= 1 && okFlat; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= NAV_W || nz >= NAV_H) continue;
        const ni = nz * NAV_W + nx;
        if (grid.blocked[ni]) { okFlat = false; break; }
        if (Math.abs(grid.topY[ni] - ty) > POI_MAX_LOCAL_SLOPE_VOXELS) okFlat = false;
      }
    }
    if (!okFlat) continue;
    let okSpacing = true;
    for (const p of out) {
      const ddx = p.cx - cx;
      const ddz = p.cz - cz;
      if (ddx * ddx + ddz * ddz < minSpacing2) { okSpacing = false; break; }
    }
    if (!okSpacing) continue;
    out.push({ cx, cz });
  }
  return out;
}

function pickBranchTarget(grid, poi, rng) {
  for (let i = 0; i < BRANCH_TARGET_ATTEMPTS; i++) {
    const dist = BRANCH_LEN_CELLS_MIN + ((rng.nextU32() % (BRANCH_LEN_CELLS_MAX - BRANCH_LEN_CELLS_MIN + 1)) | 0);
    const ang = rng.next() * Math.PI * 2;
    const cx = poi.cx + Math.round(Math.cos(ang) * dist);
    const cz = poi.cz + Math.round(Math.sin(ang) * dist);
    if (cx < POI_MARGIN_CELLS || cz < POI_MARGIN_CELLS) continue;
    if (cx >= NAV_W - POI_MARGIN_CELLS || cz >= NAV_H - POI_MARGIN_CELLS) continue;
    const idx = cz * NAV_W + cx;
    if (grid.blocked[idx]) continue;
    if (grid.surfaceMat[idx] !== M_GRASS) continue;
    return { cx, cz };
  }
  return null;
}

function octileH(ax, az, bx, bz) {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
}

function aStarRoad(grid, sx, sz, gx, gz) {
  const W = NAV_W, H = NAV_H, N = W * H;
  const startI = sz * W + sx;
  const goalI = gz * W + gx;
  if (grid.blocked[startI] || grid.blocked[goalI]) return [];

  const g = new Float32Array(N);
  const came = new Int32Array(N);
  const closed = new Uint8Array(N);
  for (let i = 0; i < N; i++) { g[i] = Infinity; came[i] = -1; }
  g[startI] = 0;

  const open = new FourAryHeap(1024);
  open.push(startI, octileH(sx, sz, gx, gz));

  let expansions = 0;
  let reached = false;
  while (open.length > 0 && expansions < ROAD_MAX_EXPANSIONS) {
    const i = open.pop();
    if (i === goalI) { reached = true; break; }
    if (closed[i]) continue;
    closed[i] = 1;
    expansions++;
    const cx = i % W;
    const cz = (i - cx) / W;
    const ty = grid.topY[i];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const ni = nz * W + nx;
        if (grid.blocked[ni]) continue;
        if (closed[ni]) continue;
        if (dx !== 0 && dz !== 0) {
          const aI = cz * W + nx;
          const bI = nz * W + cx;
          if (grid.blocked[aI] || grid.blocked[bI]) continue;
        }
        const dy = Math.abs(grid.topY[ni] - ty);
        const maxRise = (dx === 0 || dz === 0) ? ROAD_MAX_RISE_CARDINAL : ROAD_MAX_RISE_DIAGONAL;
        if (dy > maxRise) continue;
        const base = (dx === 0 || dz === 0) ? 1 : Math.SQRT2;
        const cost = base + ROAD_SLOPE_PENALTY * dy;
        const ng = g[i] + cost;
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = i;
          open.push(ni, ng + octileH(nx, nz, gx, gz));
        }
      }
    }
  }
  if (!reached) return [];

  const out = [];
  let cur = goalI;
  while (cur !== -1) {
    const cx = cur % W;
    const cz = (cur - cx) / W;
    out.push({ cx, cz });
    if (cur === startI) break;
    cur = came[cur];
  }
  return out.reverse();
}

/** Mutate `col` (a Uint8Array of WORLD_Y) so the column has `material`
 *  paved at row `ty`, with cleared air above and a sub-base fill below.
 *  Mirrors `paveColumn` from src/voxel/Roads.ts. */
function paveColumnBuf(col, ty, material) {
  if (ty < 1 || ty >= WORLD_Y) return;
  for (let y = ty + 1; y < WORLD_Y; y++) {
    const cur = col[y];
    if (cur === M_AIR) continue;
    if (cur === M_BEDROCK) continue;
    col[y] = M_AIR;
  }
  if (col[ty] !== M_BEDROCK) col[ty] = material;
  for (let dy = 1; dy < ROAD_DEPTH_VOXELS; dy++) {
    const y = ty - dy;
    if (y < 1) break;
    const cur = col[y];
    if (cur === M_BEDROCK) break;
    if (cur === M_AIR) col[y] = material;
  }
}

function stampFlatSection(getColumnBuf, columnMask, cell, ty, tdx, tdz, px, pz, material) {
  const cxw = cell.cx * C + (C >> 1);
  const czw = cell.cz * C + (C >> 1);
  const halfLen = C / 2;
  for (let li = -halfLen; li < halfLen; li++) {
    for (let ni = -ROAD_HALF_VOXELS; ni <= ROAD_HALF_VOXELS; ni++) {
      const wx = Math.round(cxw + tdx * (li + 0.5) + px * ni);
      const wz = Math.round(czw + tdz * (li + 0.5) + pz * ni);
      if (wx < 0 || wz < 0 || wx >= WORLD_X || wz >= WORLD_Z) continue;
      const buf = getColumnBuf(wx, wz);
      paveColumnBuf(buf, ty, material);
      columnMask[wz * WORLD_X + wx] = 1;
    }
  }
}

function stampDisc(getColumnBuf, columnMask, cell, ty, material) {
  const cxw = cell.cx * C + (C >> 1);
  const czw = cell.cz * C + (C >> 1);
  const r = ROAD_HALF_VOXELS;
  const r2 = r * r;
  for (let dz = -r; dz <= r; dz++) {
    const wz = czw + dz;
    if (wz < 0 || wz >= WORLD_Z) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r2) continue;
      const wx = cxw + dx;
      if (wx < 0 || wx >= WORLD_X) continue;
      const buf = getColumnBuf(wx, wz);
      paveColumnBuf(buf, ty, material);
      columnMask[wz * WORLD_X + wx] = 1;
    }
  }
}

function stampRoadFlat(getColumnBuf, columnMask, grid, cells, material) {
  const n = cells.length;
  if (n < 2) return;
  const targetY = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const c = cells[k];
    targetY[k] = grid.topY[c.cz * NAV_W + c.cx];
  }
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Int32Array(n);
    tmp[0] = targetY[0];
    tmp[n - 1] = targetY[n - 1];
    for (let k = 1; k < n - 1; k++) {
      tmp[k] = Math.round((targetY[k - 1] + 2 * targetY[k] + targetY[k + 1]) / 4);
    }
    for (let k = 0; k < n; k++) targetY[k] = tmp[k];
    for (let k = 1; k < n; k++) {
      const a = cells[k - 1], b = cells[k];
      const dx = b.cx - a.cx, dz = b.cz - a.cz;
      const maxRise = (dx === 0 || dz === 0) ? ROAD_MAX_RISE_CARDINAL : ROAD_MAX_RISE_DIAGONAL;
      const diff = targetY[k] - targetY[k - 1];
      if (diff > maxRise) targetY[k] = targetY[k - 1] + maxRise;
      else if (diff < -maxRise) targetY[k] = targetY[k - 1] - maxRise;
    }
    for (let k = n - 2; k >= 0; k--) {
      const a = cells[k], b = cells[k + 1];
      const dx = b.cx - a.cx, dz = b.cz - a.cz;
      const maxRise = (dx === 0 || dz === 0) ? ROAD_MAX_RISE_CARDINAL : ROAD_MAX_RISE_DIAGONAL;
      const diff = targetY[k] - targetY[k + 1];
      if (diff > maxRise) targetY[k] = targetY[k + 1] + maxRise;
      else if (diff < -maxRise) targetY[k] = targetY[k + 1] - maxRise;
    }
  }
  for (let k = 0; k < n; k++) {
    const cell = cells[k];
    const prev = k > 0 ? cells[k - 1] : cell;
    const next = k < n - 1 ? cells[k + 1] : cell;
    let tdx = next.cx - prev.cx;
    let tdz = next.cz - prev.cz;
    const tlen = Math.hypot(tdx, tdz) || 1;
    tdx /= tlen; tdz /= tlen;
    const px = -tdz, pz = tdx;
    stampFlatSection(getColumnBuf, columnMask, cell, targetY[k], tdx, tdz, px, pz, material);
    stampDisc(getColumnBuf, columnMask, cell, targetY[k], material);
  }
}

/** Build the per-seed road overlay as a column map. Returns:
 *    columns:    Map<colKey, Uint8Array(WORLD_Y)>  // paved columns
 *    columnMask: Uint8Array(WORLD_X * WORLD_Z)     // 1 where paved
 *    pois:       Array<{cx,cz}>
 *    stats:      { poiCount, pathSegments, pathCells, branchSegments, branchCells }
 *
 *  The column map IS the overlay — a chunk-baseline generator can
 *  prefer `columns.get(z*WORLD_X+x)` over `columnMaterials(x, z, seed)`
 *  to splat the road network onto the heightmap. */
function placeRoadsToOverlay(seed) {
  const grid = buildRoadGrid(seed);
  const columnMask = new Uint8Array(WORLD_X * WORLD_Z);
  const pois = pickPOIs(grid, seed);
  const columns = new Map();
  if (pois.length < 2) {
    return {
      columns, columnMask, pois,
      stats: { poiCount: pois.length, pathSegments: 0, pathCells: 0, branchSegments: 0, branchCells: 0 },
    };
  }

  function getColumnBuf(x, z) {
    const k = z * WORLD_X + x;
    let buf = columns.get(k);
    if (!buf) {
      // Lazy seed from heightmap baseline. Subsequent paveColumnBuf
      // calls into this column accumulate writes; the final state is
      // what the chunk-gen layer reads.
      buf = columnMaterials(x, z, seed);
      columns.set(k, buf);
    }
    return buf;
  }

  let segments = 0;
  let cells = 0;
  for (let k = 0; k + 1 < pois.length; k++) {
    const a = pois[k], b = pois[k + 1];
    const cellsPath = aStarRoad(grid, a.cx, a.cz, b.cx, b.cz);
    if (cellsPath.length < 2) continue;
    stampRoadFlat(getColumnBuf, columnMask, grid, cellsPath, M_PATH);
    segments++;
    cells += cellsPath.length;
  }
  const branchRng = new Xoshiro128((seed ^ 0xBADBEEF) >>> 0);
  let branchSegs = 0;
  let branchCells = 0;
  for (const poi of pois) {
    for (let b = 0; b < BRANCH_PER_POI; b++) {
      const target = pickBranchTarget(grid, poi, branchRng);
      if (!target) continue;
      const cellsPath = aStarRoad(grid, poi.cx, poi.cz, target.cx, target.cz);
      if (cellsPath.length < 2) continue;
      stampRoadFlat(getColumnBuf, columnMask, grid, cellsPath, M_DIRT_ROAD);
      branchSegs++;
      branchCells += cellsPath.length;
    }
  }

  return {
    columns, columnMask, pois,
    stats: {
      poiCount: pois.length,
      pathSegments: segments, pathCells: cells,
      branchSegments: branchSegs, branchCells,
    },
  };
}

// ---------- Metals (port of src/voxel/Metals.ts) ---------------------------
//
// Metal-ore piles sit on top of the existing terrain. The TS source
// scans two coarse grids (small frequent piles + sparse large
// clusters) and stamps a hashed-jitter ellipsoid of M_METAL voxels
// above each surviving candidate's surface. Order in the worldgen
// pipeline is roads → metals → trees → clearAboveRoads, so this pass
// reads the post-road column state for `findSurfaceTop` and tree
// placement reads the post-metal state. We keep the same column-buffer
// overlay the road pass produced, mutating it in place.

const METAL_GRID_SPACING_VOXELS = 64;
const METAL_DENSITY_FREQ = 1 / 160;
const METAL_DENSITY_THRESHOLD = 0.05;
const LARGE_GRID_SPACING_VOXELS = 256;
const LARGE_DENSITY_FREQ = 1 / 512;
const LARGE_DENSITY_THRESHOLD = 0.35;
const METAL_PER_VOXEL = 40;

/** Stamp one ellipsoidal pile of M_METAL onto AIR voxels above the
 *  terrain surface at `(cx, surfaceTop, cz)`. Returns the count of
 *  voxels written — clusters with `count > 0` are surfaced for the
 *  game's worker-mining system. */
function stampSurfacePile(getCol, cx, surfaceTop, cz, rxz, ry, pileSeed) {
  const cy = surfaceTop + ry;
  let count = 0;
  for (let dy = 0; dy <= ry * 2; dy++) {
    const y = surfaceTop + 1 + dy;
    if (y >= WORLD_Y) break;
    for (let dz = -rxz; dz <= rxz; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= WORLD_Z) continue;
      for (let dx = -rxz; dx <= rxz; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= WORLD_X) continue;
        const ex = dx / rxz;
        const ey = (y - cy) / ry;
        const ez = dz / rxz;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
        const h = hash32(dx, dy, dz, pileSeed);
        const jitter = ((h & 0xff) / 255) * 0.25;
        if (e2 + jitter > 1) continue;
        const col = getCol(x, z);
        if (col[y] === M_AIR) {
          col[y] = M_METAL;
          count++;
        }
      }
    }
  }
  return count;
}

function findSurfaceTopOnCol(col) {
  for (let y = WORLD_Y - 1; y >= 0; y--) {
    if (col[y] !== M_AIR) return y;
  }
  return -1;
}

function makeMetalCluster(id, vx, surfaceTop, vz, rxz, ry, voxelCount) {
  const vy = surfaceTop + ry;
  const worldX = (vx + 0.5) * VOXEL_SIZE;
  const worldY = (surfaceTop + 1 + ry * 2 + 1) * VOXEL_SIZE;
  const worldZ = (vz + 0.5) * VOXEL_SIZE;
  return {
    id, vx, vy, vz, rxz, ry, surfaceTop,
    worldX, worldY, worldZ,
    voxelCount,
    totalMetal: voxelCount * METAL_PER_VOXEL,
    maxMetal: voxelCount * METAL_PER_VOXEL,
    destroyed: false,
    maxWorkers: Math.max(2, Math.floor(rxz / 2)),
  };
}

/** Mutates `prevOverlay.columns` in place: stamps small + large metal
 *  piles on top of whatever's already in the overlay (roads). Returns
 *  the same overlay object, augmented with `clusters` so the game can
 *  hand them to its worker-mining bookkeeping. */
function placeMetalsToOverlay(seed, prevOverlay) {
  const cols = prevOverlay.columns;
  const clusters = [];
  let patches = 0;
  let totalVoxels = 0;

  function getCol(x, z) {
    const k = z * WORLD_X + x;
    let buf = cols.get(k);
    if (!buf) {
      buf = columnMaterials(x, z, seed);
      cols.set(k, buf);
    }
    return buf;
  }

  // Small frequent piles.
  for (let cz = 0; cz < WORLD_Z; cz += METAL_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += METAL_GRID_SPACING_VOXELS) {
      const j = hash32(cx, cz, 7, seed + 23173);
      const jx = ((j & 0xff) / 255) * (METAL_GRID_SPACING_VOXELS - 16) + 8;
      const jz = (((j >>> 8) & 0xff) / 255) * (METAL_GRID_SPACING_VOXELS - 16) + 8;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 8 || wz < 8 || wx >= WORLD_X - 8 || wz >= WORLD_Z - 8) continue;

      const dens = fbm2(wx * METAL_DENSITY_FREQ, wz * METAL_DENSITY_FREQ, seed + 4242, 3);
      if (dens < METAL_DENSITY_THRESHOLD) continue;

      const surfaceTop = findSurfaceTopOnCol(getCol(wx, wz));
      if (surfaceTop < 0) continue;

      const sizeHash = hash32(wx, wz, 11, seed + 0x51001);
      const rxz = 3 + ((sizeHash >>> 16) & 0x03);
      const ry  = 2 + ((sizeHash >>> 20) & 0x01);
      const stamped = stampSurfacePile(getCol, wx, surfaceTop, wz, rxz, ry, seed + patches);
      if (stamped > 0) {
        clusters.push(makeMetalCluster(clusters.length, wx, surfaceTop, wz, rxz, ry, stamped));
        patches++;
        totalVoxels += stamped;
      }
    }
  }

  // Large rare clusters.
  for (let cz = 0; cz < WORLD_Z; cz += LARGE_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += LARGE_GRID_SPACING_VOXELS) {
      const j = hash32(cx, cz, 13, seed + 0xbeef42);
      const jx = ((j & 0xff) / 255) * (LARGE_GRID_SPACING_VOXELS - 32) + 16;
      const jz = (((j >>> 8) & 0xff) / 255) * (LARGE_GRID_SPACING_VOXELS - 32) + 16;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 24 || wz < 24 || wx >= WORLD_X - 24 || wz >= WORLD_Z - 24) continue;

      const dens = fbm2(wx * LARGE_DENSITY_FREQ, wz * LARGE_DENSITY_FREQ, seed + 0x7777, 4);
      if (dens < LARGE_DENSITY_THRESHOLD) continue;

      const surfaceTop = findSurfaceTopOnCol(getCol(wx, wz));
      if (surfaceTop < 0) continue;

      const sizeHash = hash32(wx, wz, 17, seed + 0xc0ffee);
      const rxz = 12 + ((sizeHash >>> 16) & 0x07);
      const ry  =  6 + ((sizeHash >>> 20) & 0x03);
      const stamped = stampSurfacePile(getCol, wx, surfaceTop, wz, rxz, ry, seed + 0x1000 + patches);
      if (stamped > 0) {
        clusters.push(makeMetalCluster(clusters.length, wx, surfaceTop, wz, rxz, ry, stamped));
        patches++;
        totalVoxels += stamped;
      }
    }
  }

  return {
    columns: cols,
    columnMask: prevOverlay.columnMask,
    pois: prevOverlay.pois,
    clusters,
    stats: {
      ...prevOverlay.stats,
      metalPatches: patches,
      metalVoxels: totalVoxels,
    },
  };
}

// ---------- Trees (port of src/voxel/Trees.ts) -----------------------------
//
// Trees stack on top of the road overlay. The TS source iterates a
// jittered grid of candidates and stamps each one straight into the
// 1.5 GB voxel buffer; here we mutate the same column-buffer overlay
// the road pass produced, lazy-cloning unmodified columns from the
// heightmap baseline as needed. After all trees are placed we run
// `clearAboveRoads` against the road column mask to trim canopies that
// drifted onto a road. The resulting overlay is the merged
// "post-worldgen" world state — chunk gen reads from it directly.

const TREE_GRID_SPACING_VOXELS = 24;
const TREE_DENSITY_FREQ = 1 / 96;
const TREE_DENSITY_THRESHOLD = 0.10;

/** Stamp one tree (trunk cylinder + canopy ellipsoid with hashed
 *  jitter) into the column overlay. AIR check on canopy mirrors the
 *  TS source so two trees that overlap don't have the second's leaves
 *  overwrite the first's wood. */
function stampTreeOnCols(getCol, baseX, baseY, baseZ, shape, treeSeed) {
  const trunkR2 = shape.trunkRadius * shape.trunkRadius;
  for (let dy = 1; dy <= shape.trunkHeight; dy++) {
    const y = baseY + dy;
    if (y >= WORLD_Y) break;
    for (let dx = -shape.trunkRadius; dx <= shape.trunkRadius; dx++) {
      for (let dz = -shape.trunkRadius; dz <= shape.trunkRadius; dz++) {
        if (dx * dx + dz * dz > trunkR2) continue;
        const x = baseX + dx, z = baseZ + dz;
        if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) continue;
        getCol(x, z)[y] = M_WOOD;
      }
    }
  }
  const canopyCx = baseX;
  const canopyCy = baseY + shape.trunkHeight + Math.max(2, shape.canopyRadius - 2);
  const canopyCz = baseZ;
  const r = shape.canopyRadius;
  const rY = Math.max(3, Math.floor(r * 0.85));
  for (let dy = -rY; dy <= rY; dy++) {
    const y = canopyCy + dy;
    if (y < 0 || y >= WORLD_Y) continue;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ex = (dx / r);
        const ey = (dy / rY);
        const ez = (dz / r);
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 > 1) continue;
        const h = hash32(dx, dy, dz, treeSeed);
        const jitter = ((h & 0xff) / 255) * 0.18;
        if (e2 + jitter > 1) continue;
        const x = canopyCx + dx, z = canopyCz + dz;
        if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) continue;
        const col = getCol(x, z);
        if (col[y] === M_AIR) col[y] = M_LEAF;
      }
    }
  }
}

/** Mutates `roadOverlay.columns` in place: stamps trees on top of the
 *  road-and-heightmap state, then runs clearAboveRoads. Returns a
 *  merged-overlay object that supersedes the road overlay — callers
 *  should treat the road overlay as consumed.
 *
 *  Trees stamped in scan order (cz outer, cx inner) so the per-tree
 *  treeSeed (= seed + count) and the canopy AIR check land in the same
 *  order the browser uses, keeping the column-buffer state byte-
 *  identical to a hypothetical full-world `placeTrees(voxels, seed)`. */
function placeTreesToOverlay(seed, roadOverlay) {
  const cols = roadOverlay.columns;
  const trees = [];

  function getCol(x, z) {
    const k = z * WORLD_X + x;
    let buf = cols.get(k);
    if (!buf) {
      buf = columnMaterials(x, z, seed);
      cols.set(k, buf);
    }
    return buf;
  }

  let count = 0;
  for (let cz = 0; cz < WORLD_Z; cz += TREE_GRID_SPACING_VOXELS) {
    for (let cx = 0; cx < WORLD_X; cx += TREE_GRID_SPACING_VOXELS) {
      const j = hash32(cx, cz, 0, seed + 31337);
      const jx = ((j & 0xff) / 255) * (TREE_GRID_SPACING_VOXELS - 4) + 2;
      const jz = (((j >>> 8) & 0xff) / 255) * (TREE_GRID_SPACING_VOXELS - 4) + 2;
      const wx = (cx + jx) | 0;
      const wz = (cz + jz) | 0;
      if (wx < 4 || wz < 4 || wx >= WORLD_X - 4 || wz >= WORLD_Z - 4) continue;

      // findGrassTop: walk the live column (which already includes
      // road mods + any prior tree's writes) top-down for the first
      // non-AIR voxel; tree only places if that voxel is grass.
      const col = getCol(wx, wz);
      let surfaceY = -1;
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const m = col[y];
        if (m === M_AIR) continue;
        surfaceY = m === M_GRASS ? y : -1;
        break;
      }
      if (surfaceY < 0) continue;

      const n = fbm2(wx * TREE_DENSITY_FREQ, wz * TREE_DENSITY_FREQ, seed + 7777, 3);
      if (n < TREE_DENSITY_THRESHOLD) continue;

      const sizeHash = hash32(wx, wz, 1, seed + 12345);
      const shape = {
        trunkRadius: 1 + ((sizeHash >>> 24) & 1),
        trunkHeight: 18 + ((sizeHash >>> 16) & 0x07),
        canopyRadius: 6 + ((sizeHash >>> 8) & 0x07),
      };
      const treeSeed = seed + count;
      trees.push({ wx, wz, surfaceY, shape, treeSeed });
      stampTreeOnCols(getCol, wx, surfaceY, wz, shape, treeSeed);
      count++;
    }
  }

  // clearAboveRoads — for any tree-touched road column, find the road
  // surface y (skipping wood/leaf) and clear wood/leaf above it. Iterate
  // only the columns we have buffers for; non-tree-touched road columns
  // already have AIR above the road surface from paveColumnBuf and
  // don't need a sweep.
  const columnMask = roadOverlay.columnMask;
  for (const [colKey, buf] of cols) {
    if (!columnMask[colKey]) continue;
    let surfY = -1;
    for (let y = WORLD_Y - 1; y >= 1; y--) {
      const m = buf[y];
      if (m === M_AIR || m === M_WOOD || m === M_LEAF) continue;
      surfY = y;
      break;
    }
    if (surfY < 0) continue;
    for (let y = surfY + 1; y < WORLD_Y; y++) {
      const m = buf[y];
      if (m === M_WOOD || m === M_LEAF) buf[y] = M_AIR;
    }
  }

  return {
    columns: cols,
    columnMask,
    pois: roadOverlay.pois,
    clusters: roadOverlay.clusters,
    trees,
    stats: {
      ...roadOverlay.stats,
      treeCount: trees.length,
    },
  };
}

module.exports = {
  // Constants
  M_AIR, M_GRASS, M_DIRT, M_STONE, M_WOOD, M_LEAF, M_PATH, M_BEDROCK, M_MUD, M_DIRT_ROAD, M_METAL,
  VOXEL_SIZE,
  WORLD_X, WORLD_Y, WORLD_Z,
  NAV_CELL_VOXELS, NAV_W, NAV_H,
  worldIndex,
  // RNG
  Xoshiro128, hash32,
  // Noise
  smooth, lerp,
  noise2, noise3,
  fbm2, fbm3,
  warpedFbm2,
  worley3,
  // Terrain
  BASE_HEIGHT, HEIGHT_AMP, HEIGHT_FREQ, MOUNTAIN_BAND, MOUNTAIN_AMP,
  generateColumn,
  columnMaterials,
  // Roads
  FourAryHeap,
  buildRoadGrid, pickPOIs, pickBranchTarget,
  aStarRoad, octileH,
  paveColumnBuf,
  placeRoadsToOverlay,
  // Metals
  METAL_GRID_SPACING_VOXELS, METAL_DENSITY_FREQ, METAL_DENSITY_THRESHOLD,
  LARGE_GRID_SPACING_VOXELS, LARGE_DENSITY_FREQ, LARGE_DENSITY_THRESHOLD,
  METAL_PER_VOXEL,
  stampSurfacePile,
  placeMetalsToOverlay,
  // Trees
  TREE_GRID_SPACING_VOXELS, TREE_DENSITY_FREQ, TREE_DENSITY_THRESHOLD,
  stampTreeOnCols,
  placeTreesToOverlay,
};
