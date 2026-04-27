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
  /** Cached worker carry signature so the canvas only repaints when the
   *  displayed numbers (or load progress) actually change. */
  lastCarryKey: number;
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
      entry.sprite.position.set(u.x, u.y + entry.yOffset, u.z);
      const hpInt = Math.max(0, Math.ceil(u.hp));
      // Workers (harvesters AND transporters) draw a small carry line under
      // the HP value so the player can see "this worker is holding 3 wood,
      // 1 metal" at a glance, plus a "Loading…" hint while a transporter is
      // mid-pickup. Non-workers leave the field at zero so the cache key
      // for them is constant.
      const carryKey = computeCarryKey(u);
      if (hpInt !== entry.lastHp || max !== entry.lastMax || carryKey !== entry.lastCarryKey) {
        drawBar(entry.canvas, hpInt, max, carryLineFor(u));
        entry.texture.needsUpdate = true;
        entry.lastHp = hpInt;
        entry.lastMax = max;
        entry.lastCarryKey = carryKey;
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
      lastCarryKey: -1,
      yOffset: hpBarYOffset(u),
    };
  }
}

/**
 * Pack the worker's carry state and load timer into a small integer. Any
 * change rotates the key, which is enough for the cache check.
 */
function computeCarryKey(u: Unit): number {
  if (u.kind !== 'worker') return 0;
  // 8-bit wood, 8-bit metals, 8-bit load decisecond — overflow is fine
  // because we only need inequality detection.
  const wood = u.carrying.wood & 0xff;
  const metals = u.carrying.metals & 0xff;
  const load = Math.min(255, Math.round(u.loadTimer * 10)) & 0xff;
  return (wood << 16) | (metals << 8) | load;
}

/**
 * Build the second-line text that appears under the HP value for workers.
 * Empty string → no second line (non-workers, or empty-handed workers).
 */
function carryLineFor(u: Unit): string {
  if (u.kind !== 'worker') return '';
  const parts: string[] = [];
  if (u.carrying.wood > 0) parts.push(`${u.carrying.wood}W`);
  if (u.carrying.metals > 0) parts.push(`${u.carrying.metals}M`);
  if (u.loadTimer > 0) parts.push(`load ${u.loadTimer.toFixed(1)}s`);
  return parts.join(' ');
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

function drawBar(canvas: HTMLCanvasElement, hp: number, max: number, carryLine: string): void {
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

  // Worker carry line — drawn to the right of the HP integer in a smaller
  // font so it doesn't crowd the bar but still reads at typical zoom.
  if (carryLine.length > 0) {
    ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 3;
    ctx.strokeText(carryLine, barX + 28, 4);
    ctx.fillStyle = '#ffe28a';
    ctx.fillText(carryLine, barX + 28, 4);
  }
}
