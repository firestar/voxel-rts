import { Game } from './Game';
import { Unit } from '../sim/Units';
import { Projectile } from '../sim/Projectiles';

/**
 * Side-panel live telemetry for the AI debug page.
 *
 * Reads {@link Game.units} and {@link Game.projectiles} on a throttled
 * cadence (~6 Hz) and renders one HTML row per entity so the user can
 * watch positions, headings, paths, and firing intents update without
 * the noise of the regular game's bottombar / portraits / minimap.
 *
 * The Game instance is assumed to be running in `debugMode = true`,
 * but nothing here depends on that flag — the panel is a pure
 * read-only observer.
 */
export class DebugPanel {
  private readonly game: Game;
  private unitsBody: HTMLElement | null = null;
  private projectilesBody: HTMLElement | null = null;
  private unitsCount: HTMLElement | null = null;
  private projectilesCount: HTMLElement | null = null;
  private aiStatsEl: HTMLElement | null = null;
  private filterEl: HTMLInputElement | null = null;
  private filter = '';
  private rafId = 0;
  /** Wall-clock timestamp (ms) of the last refresh. The body of
   *  `frame()` only runs when 150 ms have elapsed so a 60 Hz render
   *  loop doesn't redraw the panel 60 times per second. */
  private lastRefreshMs = 0;
  private static readonly REFRESH_INTERVAL_MS = 150;

  constructor(game: Game) {
    this.game = game;
  }

  attach(): void {
    this.unitsBody = document.getElementById('dp-units');
    this.projectilesBody = document.getElementById('dp-projectiles');
    this.unitsCount = document.getElementById('dp-units-count');
    this.projectilesCount = document.getElementById('dp-projectiles-count');
    this.aiStatsEl = document.getElementById('dp-aistats');
    this.filterEl = document.getElementById('dp-filter') as HTMLInputElement | null;
    if (this.filterEl) {
      this.filterEl.addEventListener('input', () => {
        this.filter = (this.filterEl?.value || '').trim().toLowerCase();
        // Skip the throttle so the user gets immediate feedback on
        // each keystroke — much nicer than waiting up to 150 ms for
        // the next scheduled refresh.
        this.refresh();
      });
    }
    const loop = (t: number): void => {
      if (t - this.lastRefreshMs >= DebugPanel.REFRESH_INTERVAL_MS) {
        this.lastRefreshMs = t;
        this.refresh();
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  detach(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private refresh(): void {
    this.renderUnits();
    this.renderProjectiles();
    this.renderAIStats();
  }

  private renderUnits(): void {
    const body = this.unitsBody;
    if (!body) return;
    const filter = this.filter;
    // Snapshot + sort: team alphabetical first (player → enemy →
    // enemy2 lands naturally), id ascending second. Keeps row order
    // stable across refreshes so the eye can track an entity.
    const live = this.game.units.units
      .filter(u => u.hp > 0)
      .filter(u => filter === '' || matchUnit(u, filter))
      .sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : a.id - b.id));
    if (this.unitsCount) this.unitsCount.textContent = String(live.length);
    if (live.length === 0) {
      body.className = 'dp-body empty';
      body.textContent = filter ? 'no units match filter' : 'no units';
      return;
    }
    body.className = 'dp-body';
    const html: string[] = [];
    for (const u of live) {
      html.push(formatUnitRow(u));
    }
    body.innerHTML = html.join('');
  }

  private renderProjectiles(): void {
    const body = this.projectilesBody;
    if (!body) return;
    const live = this.game.projectiles.projectiles.filter(p => !p.dead);
    if (this.projectilesCount) this.projectilesCount.textContent = String(live.length);
    if (live.length === 0) {
      body.className = 'dp-body empty';
      body.textContent = 'no projectiles in flight';
      return;
    }
    body.className = 'dp-body';
    const html: string[] = [];
    for (const p of live) {
      html.push(formatProjectileRow(p));
    }
    body.innerHTML = html.join('');
  }

  private renderAIStats(): void {
    const el = this.aiStatsEl;
    if (!el) return;
    const s = this.game.aiClient.stats;
    const total = s.placed + s.trained + s.routed + s.focused + s.upgraded + s.workerFocus;
    el.textContent =
      `AI actions  total=${total}  placed=${s.placed}  trained=${s.trained}  ` +
      `routed=${s.routed}  focused=${s.focused}  upgraded=${s.upgraded}  ` +
      `wkrFocus=${s.workerFocus}  ` +
      `pulse=${(this.game.aiClient.tickIntervalSeconds * 1000).toFixed(0)}ms  ` +
      `simSpeed=${this.game.simSpeedMultiplier}×`;
    // Reset counters AFTER reading so the next refresh shows a
    // per-interval count rather than ever-growing totals.
    s.placed = 0; s.trained = 0; s.routed = 0;
    s.focused = 0; s.upgraded = 0; s.workerFocus = 0;
  }
}

function matchUnit(u: Unit, filter: string): boolean {
  if (u.kind.toLowerCase().includes(filter)) return true;
  if (u.team.toLowerCase().includes(filter)) return true;
  if (String(u.id) === filter) return true;
  return false;
}

function formatUnitRow(u: Unit): string {
  const teamCls = `team-${u.team}`;
  const firing = u.firingTarget !== null;
  const cls = `row ${teamCls}${firing ? ' firing' : ''}${u.path.length === 0 && !firing ? ' muted' : ''}`;
  const pos = `(${fixed(u.x)}, ${fixed(u.y)}, ${fixed(u.z)})`;
  const hdg = `${(u.heading * 180 / Math.PI).toFixed(0).padStart(4)}°`;
  const speed = `${u.speed.toFixed(1)}m/s`;
  // path[N→(x,z)] shows queue depth + next waypoint XZ. y is omitted
  // because most waypoints land at surface y, so the extra column is
  // noise.
  const next = u.path[0];
  const path = u.path.length === 0
    ? 'path[]'
    : `path[${u.path.length}→(${fixed(next!.x)},${fixed(next!.z)})]`;
  const fire = u.firingTarget
    ? `fire@(${fixed(u.firingTarget.x)},${fixed(u.firingTarget.y)},${fixed(u.firingTarget.z)})`
    : '';
  const atk = u.focusFireTargetId > 0 ? `atk:#${u.focusFireTargetId}` : '';
  const stance = u.weapon !== null ? u.stance : '';
  const cells: string[] = [
    `#${String(u.id).padStart(4)}`,
    pad(u.team, 6),
    pad(u.kind, 14),
    pad(pos, 30),
    hdg,
    pad(speed, 8),
    pad(path, 24),
    pad(fire, 28),
    pad(atk, 9),
    stance,
  ];
  return `<div class="${cls}">${escapeHtml(cells.join(' '))}</div>`;
}

function formatProjectileRow(p: Projectile): string {
  const pos = `(${fixed(p.x)}, ${fixed(p.y)}, ${fixed(p.z)})`;
  const vel = `v=(${fixed(p.vx)},${fixed(p.vy)},${fixed(p.vz)})`;
  const speed = Math.hypot(p.vx, p.vy, p.vz);
  const speedStr = `|v|=${speed.toFixed(1)}`;
  const age = `t=${p.age.toFixed(2)}/${p.maxLifeSeconds.toFixed(1)}`;
  const owner = p.ownerId >= 0 ? `owner:#${p.ownerId}` : 'owner:—';
  const cells: string[] = [
    `#${String(p.id).padStart(4)}`,
    pad(p.kind, 20),
    pad(pos, 30),
    pad(vel, 30),
    pad(speedStr, 10),
    pad(age, 18),
    owner,
  ];
  return `<div class="row">${escapeHtml(cells.join(' '))}</div>`;
}

function fixed(n: number): string {
  // 2-decimal-place fixed-width number with a leading space for
  // positive values, so columns visually align across rows.
  const s = n.toFixed(2);
  return n >= 0 ? ' ' + s : s;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
