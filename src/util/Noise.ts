import { hash32 } from './Rng';

// Lightweight value-noise + fbm + 3D Worley, sufficient for terrain at the slice scale.
// Not OpenSimplex2 — Phase 2 uses these directly; SOTA noise is a drop-in upgrade later
// behind the same Noise interface.

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10); // quintic Hermite
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gradient2(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const h = hash32(ix, iy, 0, seed);
  // Map to one of 8 directions (avoid axis-aligned bias).
  const a = (h & 7) * (Math.PI / 4);
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

function gradient3(ix: number, iy: number, iz: number, seed: number, dx: number, dy: number, dz: number): number {
  const h = hash32(ix, iy, iz, seed);
  // 12 cube-edge gradients (Perlin's classic set).
  const i = h % 12;
  const gx = (i < 4 ? (i & 1 ? -1 : 1) : (i < 8 ? 0 : (i & 1 ? -1 : 1)));
  const gy = (i < 4 ? (i & 2 ? -1 : 1) : (i < 8 ? (i & 1 ? -1 : 1) : 0));
  const gz = (i < 4 ? 0 : (i & 2 ? -1 : 1));
  return gx * dx + gy * dy + gz * dz;
}

/** Perlin-style gradient noise in [-1, 1]. */
export function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = smooth(fx), v = smooth(fy);
  const n00 = gradient2(ix, iy, seed, fx, fy);
  const n10 = gradient2(ix + 1, iy, seed, fx - 1, fy);
  const n01 = gradient2(ix, iy + 1, seed, fx, fy - 1);
  const n11 = gradient2(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

export function noise3(x: number, y: number, z: number, seed: number): number {
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

/** Fractal Brownian Motion — sum octaves of noise2. Returns ~[-1, 1]. */
export function fbm2(x: number, y: number, seed: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** FBM3 — fbm of 3D noise. Used for caves. */
export function fbm3(x: number, y: number, z: number, seed: number, octaves = 3, lacunarity = 2.0, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Domain-warped fbm2 (Iñigo Quílez). Gives plausible mountain ridges/valleys cheaply. */
export function warpedFbm2(x: number, y: number, seed: number): number {
  const wx = fbm2(x + 0.0, y + 0.0, seed + 1, 3);
  const wy = fbm2(x + 5.2, y + 1.3, seed + 2, 3);
  return fbm2(x + 4.0 * wx, y + 4.0 * wy, seed, 4);
}

/** 3D Worley (cellular) F1 distance, normalized roughly to [0, 1]. */
export function worley3(x: number, y: number, z: number, seed: number): number {
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
  return Math.sqrt(minD); // ~0..~1.7
}
