import * as THREE from 'three';
import { Unit, unitConfig } from '../sim/Units';

/**
 * Per-unit floating HP bar. Each unit gets a screen-aligned Sprite whose
 * texture is a Canvas2D drawing of:
 *   - the integer HP value (top-left of the bar)
 *   - a green/red filled bar showing the remaining HP fraction
 *
 * The Canvas redraws only when a unit's HP or max HP changes, so per-frame
 * cost is just position updates. Sprites for units that no longer exist
 * are disposed at the end of each `update` call.
 */
interface BarEntry {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  lastHp: number;
  lastMax: number;
  yOffset: number;
}

export class HealthBarRenderer {
  readonly group = new THREE.Group();
  private entries = new Map<number, BarEntry>();

  update(units: Unit[]): void {
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      let entry = this.entries.get(u.id);
      const max = unitConfig(u.kind).hp;
      if (!entry) {
        entry = this.createEntry(u);
        this.entries.set(u.id, entry);
        this.group.add(entry.sprite);
      }
      // Position the bar above the unit. The yOffset is set per-kind at
      // creation time so a soldier's bar floats above their helmet, not
      // their belt, and a tank's bar floats above the turret.
      entry.sprite.position.set(u.x, u.y + entry.yOffset, u.z);
      // Repaint only when the displayed integer HP or max HP changed —
      // sub-integer hp drift (from explosion falloff) doesn't repaint.
      const hpInt = Math.max(0, Math.ceil(u.hp));
      if (hpInt !== entry.lastHp || max !== entry.lastMax) {
        drawBar(entry.canvas, hpInt, max);
        entry.texture.needsUpdate = true;
        entry.lastHp = hpInt;
        entry.lastMax = max;
      }
    }
    // Clean up sprites for units that have died / despawned.
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.group.remove(entry.sprite);
      entry.texture.dispose();
      (entry.sprite.material as THREE.SpriteMaterial).dispose();
      this.entries.delete(id);
    }
  }

  private createEntry(u: Unit): BarEntry {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 40;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    // World-space size of the sprite. ~2 m wide reads at typical RTS zoom
    // without dominating the silhouette of small units.
    sprite.scale.set(2.0, 0.625, 1);
    sprite.renderOrder = 1000;
    return {
      sprite,
      canvas,
      texture,
      lastHp: -1,
      lastMax: -1,
      yOffset: hpBarYOffset(u),
    };
  }
}

/**
 * Vertical offset above a unit's feet at which the HP bar floats. Picked
 * per-kind so the bar sits clear of each model's silhouette.
 */
function hpBarYOffset(u: Unit): number {
  switch (u.kind) {
    case 'soldier':      return 2.4;
    case 'worker':       return 2.4;
    case 'tank':         return 3.4;
    case 'tunneler':     return 3.6;
    case 'worm':         return 2.4;
    case 'dozer':        return 3.0;
    case 'hauler':       return 3.4;
    case 'rocket_truck': return 3.6;
  }
}

function drawBar(canvas: HTMLCanvasElement, hp: number, max: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Bar geometry — sits in the bottom 14 px of the canvas, full width minus a
  // few px margin. The HP integer label is drawn above the bar, anchored to
  // its top-left corner.
  const barX = 4;
  const barY = 22;
  const barW = w - 8;
  const barH = 12;

  const frac = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  // Background panel for the bar — semi-transparent so it reads against any
  // ground colour.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(barX, barY, barW, barH);

  // Fill colour shifts from green (full HP) to red (low HP).
  const r = Math.round(255 * (1 - frac));
  const g = Math.round(220 * frac);
  ctx.fillStyle = `rgb(${r}, ${g}, 40)`;
  ctx.fillRect(barX, barY, barW * frac, barH);

  // Border for crispness against busy terrain.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

  // Integer HP value, drawn with a heavy outline so it stays legible against
  // light backdrops. Anchored to the top-left of the HP bar.
  ctx.font = 'bold 18px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const text = `${hp}`;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeText(text, barX, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, barX, 0);
}
