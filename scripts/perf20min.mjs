/**
 * 20-minute browser perf test: workers pathfind to metal nodes.
 * Scenario:
 *   - Full game world (real world-gen, real clusters)
 *   - Barracks placed/queued with workers every 2 min
 *   - Workers spawned near the 2 nearest metal clusters
 *   - Frame-time monitor patches requestAnimationFrame
 *   - Status every 30 s; full spike detail in final report
 *
 * Usage: node scripts/perf20min.mjs
 */

import puppeteer from 'puppeteer';

const BASE_URL = 'http://localhost:5173/';
const WORLD_GEN_TIMEOUT_MS = 180_000;
const TEST_DURATION_MS = 20 * 60 * 1000;   // 20 minutes
const STATUS_INTERVAL_MS = 30_000;          // status line every 30 s
const SPIKE_THRESHOLD_MS = 50;

const browser = await puppeteer.launch({
  headless: false,
  args: ['--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();

// ── Console / error capture ────────────────────────────────────────────────
const allLogs = [];
page.on('console', msg => {
  const text = `[${msg.type()}] ${msg.text()}`;
  allLogs.push({ t: Date.now(), text });
  const interesting = msg.type() === 'error' || msg.type() === 'warning'
    || text.includes('spike') || text.includes('perf') || text.includes('error');
  if (interesting) console.log('BROWSER:', text);
});
page.on('pageerror', err => {
  console.error('PAGE ERROR:', err.message);
  allLogs.push({ t: Date.now(), text: '[pageerror] ' + err.message });
});

console.log('Opening game at', BASE_URL);
await page.goto(BASE_URL, { waitUntil: 'networkidle0' });

console.log('Waiting for world generation…');
await page.waitForFunction(
  () => {
    const p = document.getElementById('progress');
    return p && (p.classList.contains('hidden') || p.style.display === 'none' || p.textContent === '');
  },
  { timeout: WORLD_GEN_TIMEOUT_MS },
);
console.log('World ready. Setting up scenario…');
await new Promise(r => setTimeout(r, 1500));

// ── Patch requestAnimationFrame for frame-time monitoring ─────────────────
await page.evaluate((thresh) => {
  window.__perfData = {
    frames: 0, totalMs: 0, maxMs: 0, spikes: [],
    lastT: performance.now(),
    // ring buffer of last 60 frame times for recent-context reporting
    recent: new Float32Array(60), recentIdx: 0,
  };
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => _raf((t) => {
    const pd = window.__perfData;
    const dt = t - pd.lastT;
    pd.lastT = t;
    pd.frames++;
    pd.totalMs += dt;
    if (dt > pd.maxMs) pd.maxMs = dt;
    pd.recent[pd.recentIdx % 60] = dt;
    pd.recentIdx++;
    if (dt > thresh && pd.frames > 10) {
      // snapshot of recent 10 frame times for context
      const ctx = [];
      const start = Math.max(0, pd.recentIdx - 10);
      for (let i = start; i < pd.recentIdx; i++) ctx.push(+pd.recent[i % 60].toFixed(1));
      pd.spikes.push({ frame: pd.frames, ms: +dt.toFixed(1), recent: ctx });
      console.warn('[perf-spike] frame ' + pd.frames + ': ' + dt.toFixed(1) + 'ms  prev10=' + ctx.join(','));
    }
    return cb(t);
  });
}, SPIKE_THRESHOLD_MS);

// ── Initial scenario setup ─────────────────────────────────────────────────
const setupResult = await page.evaluate(() => {
  const game = window.__game;
  if (!game) return { ok: false, error: 'no __game on window' };

  const clusters = game.metalClusters;
  if (!clusters || clusters.length === 0) return { ok: false, error: 'no metal clusters' };

  const existingWorkers = game.units.units.filter(u => u.kind === 'worker');
  const spawnX = existingWorkers[0]?.x ?? 128;
  const spawnZ = existingWorkers[0]?.z ?? 128;

  const live = clusters.filter(c => !c.destroyed);
  live.sort((a, b) => {
    const da = (a.worldX - spawnX) ** 2 + (a.worldZ - spawnZ) ** 2;
    const db = (b.worldX - spawnX) ** 2 + (b.worldZ - spawnZ) ** 2;
    return da - db;
  });

  const c1 = live[0];
  const c2 = live[1] ?? live[0];
  const c3 = live[2] ?? live[0];
  const dist1 = Math.hypot(c1.worldX - spawnX, c1.worldZ - spawnZ);

  console.log('[perf20] spawn at (' + spawnX.toFixed(1) + ',' + spawnZ.toFixed(1) + ')');
  console.log('[perf20] nearest cluster at (' + c1.worldX.toFixed(1) + ',' + c1.worldZ.toFixed(1) + ') dist=' + dist1.toFixed(1) + 'm');
  console.log('[perf20] live clusters: ' + live.length);

  // Set existing workers to mine mode
  for (const u of existingWorkers) {
    u.workerFocus = 'mine';
    u.task = { kind: 'idle' };
    u.workerScanCooldown = 0;
    u.workerRouteCooldown = 0;
  }

  // Spawn 4 workers near cluster 1
  for (let i = 0; i < 4; i++) {
    const ox = (i % 2 === 0 ? 1 : -1) * (3 + i);
    const oz = (i < 2 ? 1 : -1) * 3;
    const w = game.units.spawn('worker', c1.worldX + ox, c1.worldY + 0.5, c1.worldZ + oz);
    if (w) { w.workerFocus = 'mine'; w.task = { kind: 'idle' }; }
  }

  // Spawn 3 workers near cluster 2
  for (let i = 0; i < 3; i++) {
    const w = game.units.spawn('worker', c2.worldX + (i - 1) * 4, c2.worldY + 0.5, c2.worldZ);
    if (w) { w.workerFocus = 'mine'; w.task = { kind: 'idle' }; }
  }

  // Spawn 2 workers near cluster 3
  for (let i = 0; i < 2; i++) {
    const w = game.units.spawn('worker', c3.worldX + (i - 1) * 4, c3.worldY + 0.5, c3.worldZ);
    if (w) { w.workerFocus = 'mine'; w.task = { kind: 'idle' }; }
  }

  // Queue workers from barracks or note there isn't one
  const barracks = game.buildings.buildings.find(b => b.spec.kind === 'barracks' && !b.destroyed);
  if (barracks) {
    for (let i = 0; i < 5; i++) barracks.trainQueue.push('worker');
    console.log('[perf20] Queued 5 workers in barracks');
  } else {
    console.log('[perf20] No barracks found — workers spawned directly only');
  }

  const workerCount = game.units.units.filter(u => u.kind === 'worker').length;
  console.log('[perf20] Total workers at start: ' + workerCount);
  return {
    ok: true, workerCount, dist1,
    clusterCount: live.length, hasBarracks: !!barracks,
    c1: { x: c1.worldX, z: c1.worldZ },
  };
});

console.log('Setup:', setupResult);
if (!setupResult.ok) {
  console.error('Setup failed:', setupResult.error);
  await browser.close();
  process.exit(1);
}

// ── Monitor loop ───────────────────────────────────────────────────────────
console.log(`\nRunning ${TEST_DURATION_MS / 60000} min — status every ${STATUS_INTERVAL_MS / 1000}s:\n`);

const t0 = Date.now();
let lastWorkerBoost = t0;
const BOOST_INTERVAL_MS = 2 * 60 * 1000;  // add workers every 2 min

while (Date.now() - t0 < TEST_DURATION_MS) {
  await new Promise(r => setTimeout(r, STATUS_INTERVAL_MS));
  const elapsed = Date.now() - t0;

  // Every 2 min: queue more workers from barracks (if present)
  if (elapsed - (lastWorkerBoost - t0) >= BOOST_INTERVAL_MS) {
    lastWorkerBoost = Date.now();
    const boosted = await page.evaluate(() => {
      const game = window.__game;
      if (!game) return 0;
      const barracks = game.buildings.buildings.find(b => b.spec.kind === 'barracks' && !b.destroyed);
      if (!barracks) return 0;
      for (let i = 0; i < 3; i++) barracks.trainQueue.push('worker');
      return 3;
    }).catch(() => 0);
    if (boosted > 0) console.log(`  [boost] queued ${boosted} more workers at t=${(elapsed/1000).toFixed(0)}s`);
  }

  const s = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return null;
    const ws = g.units.units.filter(u => u.kind === 'worker');
    const p = window.__perfData;
    // compute rolling avg of last 60 frames
    let rSum = 0, rCount = Math.min(p.frames, 60);
    for (let i = 0; i < rCount; i++) rSum += p.recent[i];
    const recentAvg = rCount > 0 ? (rSum / rCount).toFixed(1) : '?';
    return {
      workers: ws.length,
      metals: g.resources.metals,
      idle: ws.filter(u => u.task.kind === 'idle').length,
      mine: ws.filter(u => u.task.kind === 'mine').length,
      deliver: ws.filter(u => u.task.kind === 'deliver').length,
      maxMs: p.maxMs.toFixed(1),
      recentAvg,
      spikes: p.spikes.length,
      frames: p.frames,
      liveClusters: g.metalClusters?.filter(c => !c.destroyed).length ?? '?',
    };
  }).catch(() => null);

  if (s) {
    const elapsedS = (elapsed / 1000).toFixed(0);
    const newSpikes = s.spikes;
    const spikeFlag = newSpikes > 0 ? ` ⚠ SPIKES=${newSpikes}` : '';
    console.log(
      `  t=${elapsedS}s` +
      `  workers=${s.workers}(idle=${s.idle} mine=${s.mine} dlv=${s.deliver})` +
      `  metals=${s.metals}` +
      `  clusters=${s.liveClusters}` +
      `  maxFr=${s.maxMs}ms avg60=${s.recentAvg}ms` +
      `  frames=${s.frames}` +
      spikeFlag,
    );
  }
}

// ── Final report ───────────────────────────────────────────────────────────
const r = await page.evaluate(() => {
  const g = window.__game;
  const p = window.__perfData ?? {};
  const ws = g?.units?.units?.filter(u => u.kind === 'worker') ?? [];
  return {
    frames: p.frames ?? 0,
    avgMs: p.frames > 0 ? (p.totalMs / p.frames).toFixed(2) : '?',
    maxMs: p.maxMs?.toFixed(2) ?? '?',
    spikes: p.spikes ?? [],
    workers: ws.length,
    metals: g?.resources?.metals ?? 0,
    states: ws.map(u => u.task.kind),
    liveClusters: g?.metalClusters?.filter(c => !c.destroyed).length ?? '?',
  };
});

const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
console.log('\n══ FINAL REPORT ══════════════════════════════════════════════');
console.log(`Duration : ${elapsedMin} min`);
console.log(`Frames   : ${r.frames}   avg=${r.avgMs}ms   max=${r.maxMs}ms`);
console.log(`Workers  : ${r.workers}   metals=${r.metals}   live clusters=${r.liveClusters}`);
console.log(`States   : ${JSON.stringify(r.states)}`);
console.log(`Spikes (>${SPIKE_THRESHOLD_MS}ms): ${r.spikes.length}`);

if (r.spikes.length > 0) {
  console.log('\nSpike details (first 20):');
  for (const s of r.spikes.slice(0, 20)) {
    console.log(`  frame ${s.frame}: ${s.ms}ms   prev10=[${s.recent?.join(',')}]`);
  }
  const spikelogs = allLogs.filter(l =>
    l.text.includes('spike') || l.text.includes('error') || l.text.toLowerCase().includes('warn'),
  );
  if (spikelogs.length) {
    console.log('\nRelevant browser logs (first 30):');
    for (const l of spikelogs.slice(0, 30)) {
      const age = ((l.t - t0) / 1000).toFixed(0);
      console.log(`  t=${age}s  ${l.text}`);
    }
  }
}

const passed = r.spikes.length === 0 && r.metals >= 0;
console.log('\n' + (passed ? '✓ PASS' : '✗ FAIL — spike count: ' + r.spikes.length));

await new Promise(r => setTimeout(r, 4000));
await browser.close();
process.exit(passed ? 0 : 1);
