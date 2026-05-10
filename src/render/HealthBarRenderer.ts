import * as THREE from 'three';
import { Unit, unitConfig } from '../sim/Units';
import { Building } from '../sim/Buildings';
import { MetalCluster } from '../voxel/Metals';
import { VOXEL_SIZE } from '../voxel/types';
import { NAV_CELL_VOXELS } from '../path/SurfaceNav';

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
  /** Cached building-status signature (production/reload/crop). Empty for units. */
  lastStatusKey: string;
  yOffset: number;
}

export class HealthBarRenderer {
  readonly group = new THREE.Group();
  private entries = new Map<number, BarEntry>();
  private buildingEntries = new Map<number, BarEntry>();
  private clusterEntries = new Map<number, BarEntry>();

  update(units: Unit[], buildings?: Building[], clusters?: MetalCluster[]): void {
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

    // Building HP bars + status bars (production, reload, crop).
    if (buildings) {
      const seenB = new Set<number>();
      for (const b of buildings) {
        if (b.destroyed) continue;

        // Compute status values — quantised to 1% to throttle redraws.
        const interval = b.spec.productionInterval;
        const prodActive = b.trainQueue.length > 0 && isFinite(interval) && interval > 0;
        const prodPct = prodActive ? Math.round((1 - b.productionTimer / interval) * 100) : -1;
        const prodLabel = prodActive ? `▶ ${b.trainQueue[0]}` : '';
        const reloadSecs = b.spec.weaponReloadSeconds ?? 0;
        const reloadPct = b.weaponReloadTimer > 0 && reloadSecs > 0
          ? Math.round((1 - b.weaponReloadTimer / reloadSecs) * 100) : -1;
        const cropPct = b.spec.kind === 'farm' ? Math.round(b.cropProgress * 100) : -1;
        // Upgrade progress: combined time × resource progress so the bar
        // tracks whichever gate is slowest. Reads `constructionTotal` from
        // the instance so the bar follows whichever upgrade is currently
        // active (initial / range / trucks).
        let upgradePct = -1;
        let upgradeLabel = '';
        if (b.upgradeState !== 'enabled') {
          const cost = b.spec.upgradeCost;
          let resFrac = 1;
          if (cost) {
            const total = cost.metals + cost.wood;
            const onSite = Math.min(b.upgradeStockpile.metals, cost.metals)
                         + Math.min(b.upgradeStockpile.wood,   cost.wood);
            resFrac = total > 0 ? onSite / total : 1;
          }
          const timeFrac = b.constructionTotal > 0
            ? 1 - b.constructionTimer / b.constructionTotal : 1;
          const combined = Math.min(resFrac, timeFrac);
          upgradePct = Math.round(combined * 100);
          upgradeLabel = b.upgradeState === 'cancelled'
            ? `✕ recover ${upgradePct}%`
            : `⚒ build ${upgradePct}%`;
        }

        const hasStatus = prodPct >= 0 || reloadPct >= 0 || cropPct >= 0 || upgradePct >= 0;
        const showBar = b.hp < b.maxHp || b.selected || hasStatus || b.spec.kind === 'hq';
        if (!showBar) continue;

        seenB.add(b.id);
        let entry = this.buildingEntries.get(b.id);
        if (!entry) {
          entry = this.createBuildingEntry(b);
          this.buildingEntries.set(b.id, entry);
          this.group.add(entry.sprite);
        }
        const cx = (b.ox + b.spec.cellsW * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const cz = (b.oz + b.spec.cellsD * 0.5) * NAV_CELL_VOXELS * VOXEL_SIZE;
        const cy = (b.floorY + b.spec.headroomVoxels + 1) * VOXEL_SIZE + entry.yOffset;
        entry.sprite.position.set(cx, cy, cz);

        const hpInt = Math.max(0, Math.ceil(b.hp));
        const truckLine = b.spec.kind === 'hq'
          ? `${b.activeTrucks}/${effectiveMaxTrucks(b)} trucks` : '';
        const statusKey = `${hpInt}:${prodPct}:${prodLabel}:${reloadPct}:${cropPct}:${truckLine}:${upgradePct}:${upgradeLabel}`;
        if (statusKey !== entry.lastStatusKey) {
          drawBuildingBar(entry.canvas, hpInt, b.maxHp, prodPct, prodLabel, reloadPct, cropPct, truckLine, upgradePct, upgradeLabel);
          entry.texture.needsUpdate = true;
          entry.lastHp = hpInt;
          entry.lastMax = b.maxHp;
          entry.lastStatusKey = statusKey;
        }
      }
      for (const [id, entry] of this.buildingEntries) {
        if (seenB.has(id)) continue;
        this.group.remove(entry.sprite);
        entry.texture.dispose();
        (entry.sprite.material as THREE.SpriteMaterial).dispose();
        this.buildingEntries.delete(id);
      }
    }

    // Metal cluster health bars.
    if (clusters) {
      const seenC = new Set<number>();
      for (const c of clusters) {
        if (c.destroyed) continue;
        seenC.add(c.id);
        let entry = this.clusterEntries.get(c.id);
        if (!entry) {
          entry = createClusterEntry();
          this.clusterEntries.set(c.id, entry);
          this.group.add(entry.sprite);
        }
        entry.sprite.position.set(c.worldX, c.worldY + 1.2, c.worldZ);
        const activeWorkers = c.workerSlots.filter(id => id !== 0).length;
        if (c.totalMetal !== entry.lastHp || c.maxMetal !== entry.lastMax || activeWorkers !== entry.lastCarryKey) {
          drawClusterBar(entry.canvas, c.totalMetal, c.maxMetal, c.totalMetal, activeWorkers, c.maxWorkers);
          entry.texture.needsUpdate = true;
          entry.lastHp = c.totalMetal;
          entry.lastMax = c.maxMetal;
          entry.lastCarryKey = activeWorkers;
        }
      }
      for (const [id, entry] of this.clusterEntries) {
        if (seenC.has(id)) continue;
        this.group.remove(entry.sprite);
        entry.texture.dispose();
        (entry.sprite.material as THREE.SpriteMaterial).dispose();
        this.clusterEntries.delete(id);
      }
    }
  }

  private createBuildingEntry(_b: Building): BarEntry {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    // Taller than unit bars to fit HP + up to two status bars (production/reload/crop).
    canvas.height = 62;
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
    sprite.scale.set(3.2, 1.03, 1); // 3.2 m wide; height matches 192×62 aspect
    sprite.renderOrder = 1000;
    return {
      sprite,
      canvas,
      texture,
      lastHp: -1,
      lastMax: -1,
      lastCarryKey: -1,
      lastStatusKey: '',
      yOffset: 1.4, // higher than before to keep extra bars above the roof
    };
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
      lastStatusKey: '',
      yOffset: hpBarYOffset(u),
    };
  }
}

/**
 * Pack the worker's carry state into a small integer. Any change rotates
 * the key, which is enough for the cache check.
 */
function computeCarryKey(u: Unit): number {
  if (u.kind !== 'worker') return 0;
  // 8-bit wood, 8-bit metals — overflow is fine because we only need
  // inequality detection.
  const wood = u.carrying.wood & 0xff;
  const metals = u.carrying.metals & 0xff;
  return (wood << 8) | metals;
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
  return parts.join(' ');
}

/**
 * Vertical offset above a unit's feet at which the HP bar floats. Picked
 * per-kind so the bar sits clear of each model's silhouette.
 */
function hpBarYOffset(u: Unit): number {
  switch (u.kind) {
    case 'soldier':        return 2.4;
    case 'sniper':         return 2.4;
    case 'gunner':         return 2.6;
    case 'mortar_soldier': return 2.6;
    case 'rocket_soldier': return 2.6;
    case 'worker':         return 2.4;
    case 'tank':           return 3.4;
    case 'tunneler':       return 3.6;
    case 'worm':           return 2.4;
    case 'dozer':          return 3.0;
    case 'rocket_truck':   return 3.6;
    case 'aa_vehicle':     return 3.6;
    case 'supply_truck':   return 2.8;
    case 'civilian':       return 2.4;
  }
}

/**
 * Draw HP bar + optional production/reload/crop status bars for a building.
 * Canvas is 192×62; unused lower rows stay transparent.
 *
 * prodPct / reloadPct / cropPct: 0..100 when active, -1 when inactive.
 */
function drawBuildingBar(
  canvas: HTMLCanvasElement,
  hp: number, maxHp: number,
  prodPct: number, prodLabel: string,
  reloadPct: number,
  cropPct: number,
  truckLine = '',
  upgradePct = -1,
  upgradeLabel = '',
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  ctx.clearRect(0, 0, W, canvas.height);
  const BX = 4, BW = W - 8;

  // HP value text (left) + optional truck count (right)
  ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#ffffff';
  const hpText = `${hp}`;
  ctx.textAlign = 'left';
  ctx.strokeText(hpText, BX, 1);
  ctx.fillText(hpText, BX, 1);
  if (truckLine) {
    ctx.textAlign = 'right';
    ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.strokeText(truckLine, W - BX, 1);
    ctx.fillStyle = '#88ddff';
    ctx.fillText(truckLine, W - BX, 1);
  }

  // HP bar
  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const r = Math.round(255 * (1 - hpFrac));
  const g = Math.round(220 * hpFrac);
  miniBar(ctx, BX, 16, BW, 8, hpFrac, `rgb(${r},${g},40)`, '');

  // Secondary status bars
  let nextY = 28;
  if (upgradePct >= 0) {
    // Construction bar: amber gradient + ⚒ glyph so the under-construction
    // state is unmistakable next to the slim red HP bar above. Drawn first
    // so a building under construction can still surface its production /
    // reload status (currently impossible since pending buildings can't
    // train, but kept consistent for the paused-then-resumed case).
    miniBar(ctx, BX, nextY, BW, 10, upgradePct / 100, '#ffaa33', upgradeLabel);
    nextY += 14;
  }
  if (prodPct >= 0) {
    miniBar(ctx, BX, nextY, BW, 10, prodPct / 100, '#ffe55a', prodLabel);
    nextY += 14;
  } else if (cropPct >= 0) {
    const cropLabel = cropPct >= 100 ? 'crop ready ✓' : `crop ${cropPct}%`;
    miniBar(ctx, BX, nextY, BW, 10, cropPct / 100, '#55dd33', cropLabel);
    nextY += 14;
  }
  if (reloadPct >= 0) {
    miniBar(ctx, BX, nextY, BW, 10, reloadPct / 100, '#ff8833', `reload ${reloadPct}%`);
  }
}

function miniBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  frac: number,
  fillColor: string,
  label: string,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fillColor;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (label) {
    ctx.font = `bold ${h <= 8 ? 8 : 9}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(label, x + 3, y + h / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 3, y + h / 2);
  }
}

function createClusterEntry(): BarEntry {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 48;
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
  sprite.scale.set(3.2, 0.8, 1);
  sprite.renderOrder = 1000;
  return { sprite, canvas, texture, lastHp: -1, lastMax: -1, lastCarryKey: -1, lastStatusKey: '', yOffset: 0 };
}

function drawClusterBar(canvas: HTMLCanvasElement, hp: number, maxHp: number, metalYield: number, workers: number, maxWorkers: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  ctx.clearRect(0, 0, W, canvas.height);
  const BX = 4, BW = W - 8;

  ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';

  // Left: remaining metal yield.
  const metalLabel = `⛏ ${metalYield}M`;
  ctx.strokeText(metalLabel, BX, 1);
  ctx.fillStyle = '#ffe55a';
  ctx.fillText(metalLabel, BX, 1);

  // Right: worker count / max.
  const workerLabel = `👷 ${workers}/${maxWorkers}`;
  ctx.textAlign = 'right';
  ctx.strokeText(workerLabel, W - BX, 1);
  ctx.fillStyle = workers >= maxWorkers ? '#ff9944' : '#aaffaa';
  ctx.fillText(workerLabel, W - BX, 1);

  // Metal bar.
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const r = Math.round(255 * (1 - frac));
  const g = Math.round(220 * frac);
  miniBar(ctx, BX, 18, BW, 10, frac, `rgb(${r},${g},40)`, '');
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

/**
 * Effective max-truck count for an HQ — base + the per-track upgrade
 * counter (5 trucks per "Add 5 trucks" upgrade). Mirrors
 * `BuildingManager.hqMaxTrucks` but kept inline here so the renderer
 * doesn't need a manager reference.
 */
function effectiveMaxTrucks(b: Building): number {
  const base = b.spec.maxTrucks ?? 5;
  const tier = b.upgradeTracks?.trucks ?? 0;
  return base + tier * 5;
}
