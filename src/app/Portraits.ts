// Compact pixel-art portraits for unit kinds, used in the HUD's selection
// panel and as click-to-train targets in building panels. The visual is
// SVG-driven so it scales crisply at any HUD size and so the unit's voxel
// silhouette is recognisable without rendering the full 3D model into a
// thumbnail every frame.
//
// Each portrait is a fixed-size SVG string with a coloured base swatch + a
// glyph that hints at the unit's role. Building portraits use a similar
// style but read the building's spec for label/colours.

import type { UnitKind } from '../sim/Units';
import type { Building } from '../sim/Buildings';

interface PortraitSpec {
  /** Human-readable label shown beneath the portrait. */
  label: string;
  /** Background tint (3-channel hex). */
  bg: string;
  /** Foreground glyph fill. */
  fg: string;
  /** SVG path data drawn at 32×32 inside the swatch. */
  glyph: string;
}

const UNIT_PORTRAITS: Record<UnitKind, PortraitSpec> = {
  worker:       { label: 'Worker',  bg: '#7a5a2c', fg: '#f0d68c',
                  glyph: 'M16 6 L20 14 L28 14 L21 19 L24 27 L16 22 L8 27 L11 19 L4 14 L12 14 Z' },
  soldier:      { label: 'Soldier', bg: '#3d5a3a', fg: '#cde6c0',
                  glyph: 'M14 4 H18 V12 H22 L24 28 H8 L10 12 H14 Z' },
  sniper:       { label: 'Sniper',  bg: '#3a4a52', fg: '#d4e2ea',
                  glyph: 'M4 14 H22 L26 12 L26 18 L22 18 H4 Z M14 6 H18 V14 H14 Z' },
  gunner:       { label: 'Gunner',  bg: '#5a3a3a', fg: '#f0c4a0',
                  glyph: 'M6 12 H22 V18 H6 Z M22 14 H28 V16 H22 Z M10 18 V26 H18 V18 Z' },
  mortar_soldier: { label: 'Mortar', bg: '#3a4a2a', fg: '#cfe6a0',
                  // Tube tilted up at ~70° + a falling shell over a target dot.
                  glyph: 'M8 26 L18 12 L22 14 L12 28 Z M22 6 L24 6 L24 10 L22 10 Z M14 4 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0' },
  rocket_soldier: { label: 'Rocket', bg: '#5a2a2a', fg: '#f8a070',
                  // Shoulder tube + warhead tip + fins.
                  glyph: 'M4 14 H20 V18 H4 Z M20 12 L26 16 L20 20 Z M2 12 H4 V20 H2 Z M4 18 H8 V22 H4 Z' },
  tank:         { label: 'Tank',    bg: '#2a3a52', fg: '#a8c4e0',
                  glyph: 'M4 18 H28 V24 H4 Z M10 12 H22 V18 H10 Z M14 6 H28 V12 H14 Z' },
  tunneler:     { label: 'Tunneler',bg: '#4a3a22', fg: '#d8b078',
                  glyph: 'M6 12 H22 V20 H6 Z M22 10 L30 16 L22 22 Z' },
  worm:         { label: 'Worm',    bg: '#4a2a4a', fg: '#e0a8d8',
                  glyph: 'M4 14 Q10 6 16 14 Q22 22 28 14 V20 Q22 28 16 20 Q10 12 4 20 Z' },
  dozer:        { label: 'Dozer',   bg: '#5a4a1a', fg: '#f0d860',
                  glyph: 'M4 18 H22 V24 H4 Z M22 14 H30 V24 H22 Z M2 12 H6 V24 H2 Z' },
  rocket_truck: { label: 'Rockets', bg: '#5a2a2a', fg: '#f08c70',
                  glyph: 'M4 16 H20 V22 H4 Z M14 8 L20 14 L14 14 Z M22 10 H28 V20 H22 Z' },
  aa_vehicle:   { label: 'AA',      bg: '#3a4a5a', fg: '#bcd4e8',
                  glyph: 'M4 18 H24 V24 H4 Z M12 6 V18 M16 4 V18 M20 6 V18' },
  supply_truck: { label: 'Truck',   bg: '#3a3a3a', fg: '#c0c0c0',
                  glyph: 'M4 14 H18 V22 H4 Z M18 16 H26 V22 H18 Z M6 22 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M20 22 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0' },
  civilian:     { label: 'Civilian', bg: '#5a3a5a', fg: '#f0c8e8',
                  glyph: 'M16 6 a4 4 0 1 0 0 8 a4 4 0 1 0 0 -8 M10 28 V18 H22 V28 Z' },
};

function svgPortrait(spec: PortraitSpec, size = 32): string {
  return `
    <svg viewBox="0 0 32 32" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="32" height="32" rx="4" fill="${spec.bg}"/>
      <rect x="0" y="0" width="32" height="32" rx="4" fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="2"/>
      <path d="${spec.glyph}" fill="${spec.fg}"/>
    </svg>`;
}

/**
 * Returns an HTML <button> for the given unit kind, sized as a
 * portrait tile. The caller wires in click + key-hint behaviour.
 */
export function makeUnitPortraitButton(
  kind: UnitKind,
  opts: { keyLabel?: string; size?: number; subtitle?: string } = {},
): HTMLButtonElement {
  const spec = UNIT_PORTRAITS[kind];
  const btn = document.createElement('button');
  btn.className = 'portrait-tile';
  btn.title = opts.subtitle ? `${spec.label} — ${opts.subtitle}` : spec.label;
  btn.innerHTML = `
    <span class="portrait-art">${svgPortrait(spec, opts.size ?? 36)}</span>
    <span class="portrait-meta">
      <span class="portrait-label">${spec.label}</span>
      ${opts.keyLabel ? `<span class="portrait-key">${opts.keyLabel}</span>` : ''}
    </span>`;
  return btn;
}

/**
 * A read-only portrait (no button) used for selection grids — one tile per
 * selected unit, sized small so a band of 12 fits in the side panel.
 */
export function makeUnitPortraitTile(kind: UnitKind, badge?: string): HTMLDivElement {
  const spec = UNIT_PORTRAITS[kind];
  const tile = document.createElement('div');
  tile.className = 'portrait-tile portrait-tile-static';
  tile.title = spec.label;
  tile.innerHTML = `
    <span class="portrait-art">${svgPortrait(spec, 28)}</span>
    ${badge !== undefined ? `<span class="portrait-badge">${badge}</span>` : ''}`;
  return tile;
}

/** Display label for a building portrait (used in selection panels). */
export function portraitLabelForUnit(kind: UnitKind): string {
  return UNIT_PORTRAITS[kind].label;
}

/**
 * Building portrait — small swatch keyed by the building's spec kind.
 * Returns an HTMLDivElement with the same .portrait-tile class so styling
 * stays consistent with unit portraits.
 */
const BUILDING_GLYPHS: Record<string, { bg: string; fg: string; glyph: string; label: string }> = {
  hq:       { label: 'HQ',       bg: '#3a4a6a', fg: '#d4e0f0',
              glyph: 'M6 26 V14 L16 6 L26 14 V26 Z M14 26 V18 H18 V26 Z' },
  barracks: { label: 'Barracks', bg: '#5a4a2a', fg: '#e8c890',
              glyph: 'M4 26 V12 L16 6 L28 12 V26 Z M10 26 V18 H14 V26 Z M18 26 V18 H22 V26 Z' },
  storage:  { label: 'Storage',  bg: '#4a3a1a', fg: '#d8b070',
              glyph: 'M6 24 V12 H26 V24 Z M6 12 L10 8 H22 L26 12 M14 14 H18 V20 H14 Z' },
  farm:     { label: 'Farm',     bg: '#3a5a2a', fg: '#a0d870',
              glyph: 'M4 24 H28 V26 H4 Z M8 24 V14 L16 8 L24 14 V24 M14 24 V18 H18 V24 Z' },
  factory:  { label: 'Factory',  bg: '#4a3a4a', fg: '#d4a8d4',
              glyph: 'M4 26 V14 H10 V20 L16 14 V20 L22 14 V26 Z M12 22 H14 V26 H12 Z M18 22 H20 V26 H18 Z' },
  turret:   { label: 'Turret',   bg: '#4a2a2a', fg: '#f0a890',
              glyph: 'M12 26 V18 H20 V26 Z M14 18 V12 H18 V18 Z M16 12 V6 M14 8 H18' },
  neighborhood: { label: 'Neighborhood', bg: '#3a5a3a', fg: '#cfeac0',
              glyph: 'M4 24 V14 L8 10 L12 14 V24 Z M14 24 V14 L18 10 L22 14 V24 Z M2 26 H30' },
};

export function makeBuildingPortraitTile(b: Building): HTMLDivElement {
  const spec = BUILDING_GLYPHS[b.spec.kind] ?? BUILDING_GLYPHS.barracks!;
  const tile = document.createElement('div');
  tile.className = 'portrait-tile portrait-tile-static';
  tile.title = spec.label;
  tile.innerHTML = `<span class="portrait-art">${svgPortrait(spec, 36)}</span>`;
  return tile;
}

/**
 * Portrait button for one upgrade option. Used in the building selection
 * panel — each clickable tile triggers the matching action's runner. The
 * `tier` argument is rendered as a small badge (e.g. "+1" / "+2") so the
 * player can see how many times a track has already been upgraded.
 */
export function makeUpgradePortraitButton(
  opts: {
    label: string; keyLabel: string;
    portrait: { bg: string; fg: string; glyph: string };
    description: string;
    tier?: number;
    cost?: { metals: number; wood: number };
  },
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'portrait-tile';
  const costStr = opts.cost ? `· ${opts.cost.metals}M ${opts.cost.wood}W` : '';
  btn.title = `${opts.label} — ${opts.description} ${costStr}`;
  const portraitSpec: PortraitSpec = { ...opts.portrait, label: opts.label };
  btn.innerHTML = `
    <span class="portrait-art">${svgPortrait(portraitSpec, 36)}</span>
    <span class="portrait-meta">
      <span class="portrait-label">${opts.label}</span>
      <span class="portrait-key">${opts.keyLabel}</span>
    </span>
    ${opts.tier && opts.tier > 0 ? `<span class="portrait-badge">+${opts.tier}</span>` : ''}`;
  return btn;
}
