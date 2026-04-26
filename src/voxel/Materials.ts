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
  // Mud — soft and dark, sucks vehicles in. Hp deliberately low so each tread pass
  // chews through it quickly.
  { id: 8, name: 'mud',    hp: 10,  r: 70,  g: 52,  b: 28  },
  // Dirt road — graded, compacted dirt. Warmer/redder than raw dirt so the
  // network is visually distinct from exposed soil.
  { id: 9, name: 'dirt_road', hp: 28, r: 126, g: 92, b: 56 },
];

export const M_AIR = 0;
export const M_GRASS = 1;
export const M_DIRT = 2;
export const M_STONE = 3;
export const M_WOOD = 4;
export const M_LEAF = 5;
export const M_PATH = 6;
export const M_BEDROCK = 7;
export const M_MUD = 8;
export const M_DIRT_ROAD = 9;

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
    case M_MUD:     return 1.3;  // soft, sloppy — easy to push through
    case M_DIRT:    return 1.0;  // baseline
    case M_GRASS:   return 0.95; // grass + topsoil
    case M_DIRT_ROAD: return 0.9; // graded, compacted
    case M_PATH:    return 0.85; // compacted dirt
    case M_WOOD:    return 0.55; // medium
    case M_STONE:   return 0.30; // hard — really slows the dig
    case M_BEDROCK: return 0;    // can't be cut
    default:        return 0.5;  // unknown = play safe
  }
}

/**
 * Per-material multiplier on a surface unit's movement speed. Soft ground (mud)
 * bogs vehicles down; paths give a small bonus. Returns 1.0 for materials that
 * shouldn't matter (air, stone — vehicles aren't on stone surfaces typically).
 */
export function groundSpeedMultiplier(m: MaterialId): number {
  switch (m) {
    case M_MUD:   return 0.4;   // sinks in mud
    case M_GRASS: return 1.0;   // baseline
    case M_DIRT:  return 1.0;
    case M_DIRT_ROAD: return 1.05; // graded dirt road — minor speed bonus
    case M_PATH:  return 1.15;  // fastest — a beaten road
    case M_LEAF:  return 0.9;   // soft canopy underfoot
    case M_STONE: return 0.95;  // bare rock is slightly less grippy
    default:      return 1.0;
  }
}

/**
 * Per-material recipe for a tank tread mark. `peak` feeds damageSphere; voxels
 * accumulate damage across passes and are removed once their HP is exceeded, so
 * a tank rolling over mud actually sinks (top voxel disappears, tank Y drops).
 * radiusMeters is the carve radius. peak === 0 means the material doesn't take
 * track marks (stone, bedrock).
 */
export interface TrackMark { peak: number; radiusMeters: number; }
export function trackDamageFor(m: MaterialId): TrackMark {
  switch (m) {
    // Mud: each pass kills a swathe of voxels — tank quickly sinks in.
    case M_MUD:   return { peak: 14, radiusMeters: 0.4 };
    // Grass: light grooves; takes ~6 passes to expose dirt below.
    case M_GRASS: return { peak: 6,  radiusMeters: 0.3 };
    // Dirt: very faint grooves, ~12 passes.
    case M_DIRT:  return { peak: 3,  radiusMeters: 0.25 };
    // Dirt road: graded, but still loose — slightly more wear than raw dirt.
    case M_DIRT_ROAD: return { peak: 2, radiusMeters: 0.22 };
    // Path: well-trodden, almost no marks.
    case M_PATH:  return { peak: 1,  radiusMeters: 0.2 };
    // Anything else (stone, bedrock, wood, leaf): no track marks.
    default:      return { peak: 0,  radiusMeters: 0 };
  }
}
