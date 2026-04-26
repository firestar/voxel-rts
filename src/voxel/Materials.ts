import { MaterialId } from './types';

export interface Material {
  id: MaterialId;
  name: string;
  hp: number;        // 0 = indestructible (e.g. air sentinel, bedrock)
  r: number; g: number; b: number; // 0..255
}

// Order matters: id == index.
export const MATERIALS: Material[] = [
  { id: 0, name: 'air',    hp: 0,   r: 0,   g: 0,   b: 0   },
  { id: 1, name: 'grass',  hp: 30,  r: 74,  g: 138, b: 58  },
  { id: 2, name: 'dirt',   hp: 25,  r: 107, g: 74,  b: 42  },
  { id: 3, name: 'stone',  hp: 120, r: 138, g: 138, b: 138 },
  { id: 4, name: 'wood',   hp: 60,  r: 106, g: 74,  b: 42  },
  { id: 5, name: 'leaf',   hp: 15,  r: 47,  g: 106, b: 42  },
  { id: 6, name: 'path',   hp: 35,  r: 184, g: 160, b: 106 },
  { id: 7, name: 'bedrock', hp: 0,  r: 40,  g: 40,  b: 50  },
];

export const M_AIR = 0;
export const M_GRASS = 1;
export const M_DIRT = 2;
export const M_STONE = 3;
export const M_WOOD = 4;
export const M_LEAF = 5;
export const M_PATH = 6;
export const M_BEDROCK = 7;

// Flat RGBA palette (length = MATERIALS.length * 4) for fast worker lookup.
export function materialColors(): Uint8Array {
  const out = new Uint8Array(MATERIALS.length * 4);
  for (let i = 0; i < MATERIALS.length; i++) {
    const m = MATERIALS[i]!;
    out[i * 4 + 0] = m.r;
    out[i * 4 + 1] = m.g;
    out[i * 4 + 2] = m.b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function isSolid(m: MaterialId): boolean {
  return m !== 0;
}

/**
 * Per-material multiplier on the tunneler's base digging speed. 1.0 = normal soil
 * (dirt baseline), <1.0 = harder material that slows the cutter, >1.0 = soft material
 * the cutter rips through. Indestructible materials return 0; air is 1.0 since the
 * cutter just spins through it without resistance.
 */
export function digSpeedMultiplier(m: MaterialId): number {
  switch (m) {
    case M_AIR:     return 1.0;
    case M_LEAF:    return 1.4;  // very soft
    case M_DIRT:    return 1.0;  // baseline
    case M_GRASS:   return 0.95; // grass + topsoil
    case M_PATH:    return 0.85; // compacted dirt
    case M_WOOD:    return 0.55; // medium
    case M_STONE:   return 0.30; // hard — really slows the dig
    case M_BEDROCK: return 0;    // can't be cut
    default:        return 0.5;  // unknown = play safe
  }
}
