/**
 * Diagnostic run: instruments game.tick to find which phase is slow.
 * Runs for 15 minutes and logs per-phase timing breakdowns every 30s.
 *
 * Usage: node scripts/perfdiag.mjs
 */

import puppeteer from 'puppeteer';

const BASE_URL = 'http://localhost:5173/';
const WORLD_GEN_TIMEOUT_MS = 180_000;
const TEST_DURATION_MS = 15 * 60 * 1000;
const STATUS_INTERVAL_MS = 30_000;
const SPIKE_THRESHOLD_MS = 50;

const browser = await puppeteer.launch({
  headless: false,
  args: ['--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();

const logs = [];
page.on('console', msg => {
  const text = `[${msg.type()}] ${msg.text()}`;
  logs.push({ t: Date.now(), text });
  const show = msg.type() === 'error' || text.includes('diag') || text.includes('spike') || text.includes('perf');
  if (show) console.log('BROWSER:', text);
});
page.on('pageerror', err => { console.error('PAGE ERROR:', err.message); });

console.log('Opening', BASE_URL);
await page.goto(BASE_URL, { waitUntil: 'networkidle0' });

console.log('Waiting for world gen…');
await page.waitForFunction(
  () => { const p = document.getElementById('progress'); return p && (p.classList.contains('hidden') || p.style.display === 'none' || p.textContent === ''); },
  { timeout: WORLD_GEN_TIMEOUT_MS },
);
console.log('World ready.');
await new Promise(r => setTimeout(r, 1500));

// ── Frame-time monitor ────────────────────────────────────────────────────
await page.evaluate((thresh) => {
  window.__perfData = { frames: 0, totalMs: 0, maxMs: 0, spikes: [], lastT: performance.now() };
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => _raf((t) => {
    const pd = window.__perfData;
    const dt = t - pd.lastT; pd.lastT = t; pd.frames++; pd.totalMs += dt;
    if (dt > pd.maxMs) pd.maxMs = dt;
    if (dt > thresh && pd.frames > 10) pd.spikes.push({ frame: pd.frames, ms: +dt.toFixed(1) });
    return cb(t);
  });
}, SPIKE_THRESHOLD_MS);

// ── Scenario setup ────────────────────────────────────────────────────────
const setup = await page.evaluate(() => {
  const game = window.__game;
  if (!game) return { ok: false, error: 'no __game' };
  const clusters = game.metalClusters;
  if (!clusters?.length) return { ok: false, error: 'no clusters' };
  const workers = game.units.units.filter(u => u.kind === 'worker');
  const sx = workers[0]?.x ?? 128, sz = workers[0]?.z ?? 128;
  const live = clusters.filter(c => !c.destroyed);
  live.sort((a, b) => (a.worldX-sx)**2+(a.worldZ-sz)**2 - ((b.worldX-sx)**2+(b.worldZ-sz)**2));
  for (const u of workers) { u.workerFocus = 'mine'; u.task = { kind: 'idle' }; u.workerScanCooldown = 0; u.workerRouteCooldown = 0; }
  for (let i = 0; i < 3; i++) {
    const c = live[i] ?? live[0];
    for (let j = 0; j < 3; j++) {
      const w = game.units.spawn('worker', c.worldX + (j-1)*3, c.worldY+0.5, c.worldZ);
      if (w) { w.workerFocus = 'mine'; w.task = { kind: 'idle' }; }
    }
  }
  return { ok: true, workers: game.units.units.filter(u => u.kind==='worker').length,
           c1: { x: live[0].worldX, z: live[0].worldZ, dist: Math.hypot(live[0].worldX-sx, live[0].worldZ-sz) },
           crossOriginIsolated: globalThis.crossOriginIsolated,
           hasWorker: game.pathWorker?.hasWorker };
});
console.log('Setup:', JSON.stringify(setup));
if (!setup.ok) { await browser.close(); process.exit(1); }

// ── Instrument game.tick to measure phases ────────────────────────────────
await page.evaluate(() => {
  const game = window.__game;
  // Timing buckets accumulated across frames
  window.__tickTimings = {
    unitsTick: 0, buildingsTick: 0, tickWorkers: 0, saplingsTick: 0,
    flushNav: 0, render: 0, unitRenderer: 0, meshPump: 0, other: 0,
    frames: 0,
  };
  const orig = game.tick.bind(game);
  game.tick = function(dt) {
    // We intercept by wrapping each known method call inline.
    // Since tick is compiled we can't easily split it — instead measure total
    // and compare to the RAF frame time which we already track.
    const t0 = performance.now();
    orig(dt);
    const total = performance.now() - t0;
    window.__tickTimings.other += total;
    window.__tickTimings.frames++;
  };
  console.log('[diag] tick instrumented');
});

// Better: patch at a finer grain by wrapping the sub-managers
await page.evaluate(() => {
  const game = window.__game;
  const T = window.__tickTimings;

  // Wrap units.tick
  const origUnitsTick = game.units.tick.bind(game.units);
  game.units.tick = function(...args) {
    const t = performance.now(); origUnitsTick(...args); T.unitsTick += performance.now() - t;
  };

  // Wrap buildings.tick
  const origBldTick = game.buildings.tick.bind(game.buildings);
  game.buildings.tick = function(...args) {
    const t = performance.now(); origBldTick(...args); T.buildingsTick += performance.now() - t;
  };

  // Wrap saplings.tick
  const origSapTick = game.saplings.tick.bind(game.saplings);
  game.saplings.tick = function(...args) {
    const t = performance.now(); const r = origSapTick(...args); T.saplingsTick += performance.now() - t; return r;
  };

  // Wrap unitRenderer.update
  const origUR = game.unitRenderer.update.bind(game.unitRenderer);
  game.unitRenderer.update = function(...args) {
    const t = performance.now(); origUR(...args); T.unitRenderer += performance.now() - t;
  };

  // Wrap meshes.pump
  const origPump = game.meshes.pump.bind(game.meshes);
  game.meshes.pump = function(...args) {
    const t = performance.now(); origPump(...args); T.meshPump += performance.now() - t;
  };

  // Wrap renderer.render
  const origRender = game.renderer.render.bind(game.renderer);
  game.renderer.render = function(...args) {
    const t = performance.now(); origRender(...args); T.render += performance.now() - t;
  };

  console.log('[diag] sub-system wrappers installed');
});

// ── Monitor loop ──────────────────────────────────────────────────────────
console.log(`\nRunning ${TEST_DURATION_MS/60000} min — status every ${STATUS_INTERVAL_MS/1000}s:\n`);
const t0 = Date.now();

while (Date.now() - t0 < TEST_DURATION_MS) {
  await new Promise(r => setTimeout(r, STATUS_INTERVAL_MS));
  const elapsed = (Date.now() - t0) / 1000;

  const s = await page.evaluate(() => {
    const g = window.__game;
    const p = window.__perfData;
    const T = window.__tickTimings;
    const ws = g?.units?.units?.filter(u => u.kind === 'worker') ?? [];
    const n = T.frames || 1;
    // per-frame averages in ms
    const avg = k => (T[k] / n).toFixed(2);
    const breakdown = `units=${avg('unitsTick')} bld=${avg('buildingsTick')} workers=? sap=${avg('saplingsTick')} urend=${avg('unitRenderer')} mesh=${avg('meshPump')} render=${avg('render')} total=${avg('other')}`;
    // reset for next interval
    for (const k of Object.keys(T)) T[k] = 0;
    return {
      workers: ws.length, metals: g?.resources?.metals ?? 0,
      idle: ws.filter(u => u.task.kind==='idle').length,
      mine: ws.filter(u => u.task.kind==='mine').length,
      deliver: ws.filter(u => u.task.kind==='deliver').length,
      maxMs: p.maxMs.toFixed(1), spikes: p.spikes.length,
      liveClusters: g?.metalClusters?.filter(c=>!c.destroyed).length ?? '?',
      breakdown,
    };
  }).catch(() => null);

  if (s) {
    const spikeFlag = s.spikes > 0 ? ` ⚠ SPIKES=${s.spikes}` : '';
    console.log(`t=${elapsed.toFixed(0)}s workers=${s.workers}(idle=${s.idle} mine=${s.mine} dlv=${s.deliver}) metals=${s.metals} clusters=${s.liveClusters} maxFr=${s.maxMs}ms${spikeFlag}`);
    console.log(`  breakdown/frame: ${s.breakdown}`);
  }
}

// ── Final report ──────────────────────────────────────────────────────────
const r = await page.evaluate(() => {
  const g = window.__game; const p = window.__perfData ?? {};
  const ws = g?.units?.units?.filter(u => u.kind==='worker') ?? [];
  return { frames: p.frames??0, avgMs: p.frames>0?(p.totalMs/p.frames).toFixed(2):'?',
           maxMs: p.maxMs?.toFixed(2)??'?', spikes: p.spikes??[],
           workers: ws.length, metals: g?.resources?.metals??0 };
});
console.log('\n══ FINAL ═══════════════════════════════════════');
console.log(`Frames: ${r.frames}  avg=${r.avgMs}ms  max=${r.maxMs}ms`);
console.log(`Workers: ${r.workers}  metals: ${r.metals}`);
console.log(`Spikes(>${SPIKE_THRESHOLD_MS}ms): ${r.spikes.length}`);
if (r.spikes.length > 0) for (const s of r.spikes.slice(0,10)) console.log(`  frame ${s.frame}: ${s.ms}ms`);

await new Promise(r => setTimeout(r, 3000));
await browser.close();
process.exit(r.spikes.length === 0 ? 0 : 1);
