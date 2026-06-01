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

  // Wireframe toggle: the debug page renders wireframe-only by default (greedy
  // mesh edges over a dark background). Press `W` — or click the on-screen
  // button — to flip between that and solid flat-shaded terrain, so you can see
  // the actual voxel surfaces instead of just their edges.
  mountWireframeToggle(game);

  // Self-driving cave demo: on `?scene=cave` spawn a soldier squad at the cave
  // mouth, route it to the deep chamber, frame the camera over the trench, and
  // respawn a fresh wave each time the squad arrives — so opening the URL in a
  // browser shows the cave/obstacle pathfinding running on a loop with no
  // external driver. No-op for the flat AI scene.
  if (scene === 'cave') startCaveDemo(game);
}

/**
 * Drive the cave pathfinding demo from inside the page. Reads the sandbox
 * landmarks off `window.__sandbox` (set by {@link generateSandboxWorld}), spawns
 * a 6-soldier column at the mouth, plans each route to the chamber via the live
 * Pathfinder, and loops: when all have arrived it clears them and spawns again.
 */
function startCaveDemo(game: Game): void {
  const lm = (window as unknown as Record<string, unknown>).__sandbox as
    | { caveMouth: { x: number; y: number; z: number };
        chamberCenter: { cx: number; cy: number; cz: number; x: number; z: number } }
    | undefined;
  const pf = game.pathfinder;
  if (!lm || !pf) return;

  // Camera. Two modes:
  //   default      — follow-cam: track the lead soldier (deepest into the cave)
  //                   up close, so you ride the descent into the corridor.
  //   ?cam=overview — static angled view framing the whole trench.
  // Either way we pin the target through a closure var so the idle camera loop
  // can't drift it; `camTarget` is updated by the interval below in follow mode.
  // Overview is the default — it reliably frames the whole trench (surface +
  // staircase + corridor) in one shot. `?cam=follow` opts into the close
  // chase-cam that rides the lead soldier down (rougher framing in the small
  // wireframe debug view, but a fun ride).
  const follow = new URLSearchParams(location.search).get('cam') === 'follow';
  const cam = game.camera;
  const camTarget = { x: 53, z: 64 };
  const origUpdate = cam.update.bind(cam);
  cam.update = (input, dt): void => { cam.target.x = camTarget.x; cam.target.z = camTarget.z; origUpdate(input, dt); };
  cam.target.set(camTarget.x, 0, camTarget.z);
  // Default look-at height = the surface (~8.6 m). Follow mode eases this down
  // toward the lead soldier's Y as it descends, so the units stay centred.
  cam.targetY = 8.6;
  // The shared camera always looks at a fixed height (~18 m) regardless of
  // target, so an aggressive low-angle close-up leaves the underground units
  // (y≈2 m) projecting near the bottom of the frame, detached from the surface
  // terrain above. A steeper, slightly pulled-back framing keeps both the
  // trench surface and the descending units in view. Follow mode then just
  // slides this framing along the lead soldier's XZ.
  if (follow) { cam.yaw = 0.5; cam.pitch = -0.85; cam.distance = 34; }
  else { cam.yaw = 0.35; cam.pitch = -1.0; cam.distance = 40; }

  const goal = pf.nearestPassable('soldier', { cx: lm.chamberCenter.cx, cy: lm.chamberCenter.cy, cz: lm.chamberCenter.cz });
  const gx = lm.chamberCenter.x, gz = lm.chamberCenter.z;

  const spawnWave = (): void => {
    for (let i = 0; i < 6; i++) {
      const sx = lm.caveMouth.x - 4 - i * 1.4;
      const u = game.units.spawn('soldier', sx, lm.caveMouth.y, lm.caveMouth.z, { team: 'player' });
      const start = pf.nearestPassable('soldier', pf.cellAt(u.x, u.y, u.z));
      const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });
      if (res.cells.length) game.units.setPath(u, pf.pathToWaypoints(res.cells));
    }
  };
  spawnWave();

  // Re-dispatch units that drop their path short, and respawn a wave once the
  // whole squad reaches the chamber. Runs on a light interval, not per-frame.
  window.setInterval(() => {
    const squad = game.units.units.filter(u => u.kind === 'soldier' && u.team === 'player' && u.hp > 0);
    if (squad.length === 0) { spawnWave(); return; }
    let arrived = 0;
    for (const u of squad) {
      if (Math.hypot(u.x - gx, u.z - gz) < 4 && u.y < 8) { arrived++; continue; }
      if (u.needsRepath || u.path.length === 0) {
        u.needsRepath = false;
        const start = pf.nearestPassable('soldier', pf.cellAt(u.x, u.y, u.z));
        const res = pf.findPath('soldier', { start, goal, maxExpansions: 200000 });
        if (res.cells.length) game.units.setPath(u, pf.pathToWaypoints(res.cells));
      }
    }
    if (arrived >= squad.length) {
      for (const u of squad) u.hp = 0; // clear the arrived squad
      spawnWave();
    }
  }, 1000);

  // Follow-cam: every animation frame, ease the pinned target toward the lead
  // soldier — the one furthest along the route (max x; the corridor runs +x).
  // Smoothed so the view glides rather than snapping between units as the lead
  // changes. Skipped in overview mode (target stays at the trench centre).
  if (follow) {
    const tick = (): void => {
      const squad = game.units.units.filter(u => u.kind === 'soldier' && u.team === 'player' && u.hp > 0);
      if (squad.length > 0) {
        let lead = squad[0]!;
        for (const u of squad) if (u.x > lead.x) lead = u;
        // Ease toward the lead's XZ (15% per frame ≈ a smooth chase) and toward
        // its Y so the look-at descends with the squad into the corridor.
        camTarget.x += (lead.x - camTarget.x) * 0.15;
        camTarget.z += (lead.z - camTarget.z) * 0.15;
        const wantY = lead.y + 1.5; // aim a touch above the unit's feet
        cam.targetY = (cam.targetY ?? wantY) + (wantY - (cam.targetY ?? wantY)) * 0.1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/**
 * Add a wireframe on/off control to the debug page: a fixed-position button in
 * the top bar plus the `W` hotkey. Both call {@link Game.toggleWireframe} and
 * reflect the resulting state in the button label.
 */
function mountWireframeToggle(game: Game): void {
  const btn = document.createElement('button');
  btn.textContent = game.wireframeOn ? 'Wireframe: ON (W)' : 'Wireframe: OFF (W)';
  btn.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:1000;' +
    'padding:4px 10px;font:12px monospace;background:#1b2530;color:#cfe;' +
    'border:1px solid #3a4a5a;border-radius:4px;cursor:pointer;';
  const sync = (on: boolean): void => {
    btn.textContent = on ? 'Wireframe: ON (W)' : 'Wireframe: OFF (W)';
  };
  btn.addEventListener('click', () => sync(game.toggleWireframe()));
  document.body.appendChild(btn);
  window.addEventListener('keydown', (e) => {
    // Ignore when typing in the unit-filter input etc.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'w' || e.key === 'W') sync(game.toggleWireframe());
  });
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
