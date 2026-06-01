import { Game } from './app/Game';
import { GameClient } from './net/GameClient';
import { generateDebugWorld } from './voxel/DebugWorldGen';
import { generateSandboxWorld } from './voxel/SandboxWorld';
import { DebugPanel } from './app/DebugPanel';

/**
 * Boot script for `debug.html`. Mirrors {@link main.ts} but skips the
 * lobby and uses {@link generateDebugWorld} to produce a flat plain
 * with sparse trees + ore so the AI brain has minimal terrain
 * variance to navigate. The Game runs in `debugMode` (wireframe
 * materials, no FoW, no civilians / leaf decay / saplings); the side
 * panel mounted at the end reads per-frame unit + projectile state
 * and renders it as scrollable rows.
 *
 * URL params:
 *   ai=N          number of AI bases to seed (1..7, default 3)
 *   speed=N       sim-speed multiplier (1/2/4/8, default 1)
 *   seed=N        worldgen seed (default = random)
 *   aiPulseMs=N   ms between AI-server pulses (default 250 = 4 Hz)
 */
async function boot(): Promise<void> {
  const appEl = document.getElementById('app')!;
  const progressEl = document.getElementById('progress')!;
  const statsEl = document.getElementById('stats');

  const params = new URLSearchParams(location.search);
  const aiCount = clamp(intParam(params, 'ai', 3), 1, 7);
  const speed = pickFromList(intParam(params, 'speed', 1), [1, 2, 4, 8]);
  const seed = intParam(params, 'seed', (Date.now() & 0xffff) | 1);
  const aiPulseMs = clamp(intParam(params, 'aiPulseMs', 250), 50, 5000);

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  appEl.appendChild(canvas);

  progressEl.textContent = `Booting AI debug (seed=${seed}, ai=${aiCount}, ${speed}×)…`;

  const game = new Game(canvas, statsEl, { debugMode: true });
  game.numAi = aiCount;
  game.simSpeedMultiplier = speed;
  game.aiClient.tickIntervalSeconds = aiPulseMs / 1000;
  (window as unknown as Record<string, unknown>).__game = game;

  // `?scene=cave` boots the pathfinding sandbox (obstacles + cave with a
  // staircase mouth, corridor, branch and deep chamber) instead of the flat
  // AI plain, so the cave/obstacle pathfinding can be demoed in the real app.
  const scene = params.get('scene');
  const provider = scene === 'cave' ? generateSandboxWorld : generateDebugWorld;
  const worldLabel = scene === 'cave' ? 'cave sandbox' : 'flat world';
  progressEl.textContent = `Generating ${worldLabel} (${seed})…`;
  await game.generate(
    seed,
    (done, total) => {
      const pct = ((done / total) * 100).toFixed(0);
      progressEl.textContent = `Generating ${worldLabel}… ${pct}%`;
    },
    provider,
  );

  // Authoritative server — same wiring as the main page. If the
  // game-server isn't running the client just retries silently in
  // the background; debug mode is still usable single-player.
  const gameClient = new GameClient({ playerId: `debug-${Math.random().toString(36).slice(2, 6)}` });
  gameClient.connect();
  gameClient.send({ type: 'set_world_seed', seed });
  game.attachAuthoritativeServer(gameClient);
  (window as unknown as Record<string, unknown>).__gameClient = gameClient;

  // Wire the speed <select> + pause checkbox to game state. Both
  // present in debug.html; harmless when the elements aren't found.
  const speedSel = document.getElementById('dh-speed') as HTMLSelectElement | null;
  if (speedSel) {
    speedSel.value = String(speed);
    speedSel.addEventListener('change', () => {
      const v = pickFromList(parseInt(speedSel.value, 10) || 1, [1, 2, 4, 8]);
      game.simSpeedMultiplier = v;
    });
  }
  const pauseChk = document.getElementById('dh-pause') as HTMLInputElement | null;
  if (pauseChk) {
    pauseChk.addEventListener('change', () => {
      game.paused = pauseChk.checked;
    });
  }

  // Mount the live telemetry panel before the game ticks — it owns
  // its own throttled refresh loop, so attaching late wouldn't break
  // anything but is just more code to read.
  const panel = new DebugPanel(game);
  panel.attach();

  game.start();
  game.paused = false;
  progressEl.classList.add('hidden');
}

function intParam(params: URLSearchParams, key: string, def: number): number {
  const v = params.get(key);
  if (v == null) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pickFromList<T>(v: T, allowed: T[]): T {
  return allowed.includes(v) ? v : allowed[0]!;
}

boot().catch((err: unknown) => {
  console.error(err);
  const p = document.getElementById('progress');
  if (p) p.textContent = `Boot failed — ${(err as Error)?.message ?? 'see console'}`;
});
