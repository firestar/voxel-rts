/**
 * Puppeteer perf test: workers pathfind to metal nodes, barracks queued,
 * extra workers spawned. Monitors frame times for lag spikes.
 *
 * Usage: node scripts/perftest.mjs
 */

import puppeteer from 'puppeteer';

const URL = 'http://localhost:5174/';
const WORLD_GEN_TIMEOUT_MS = 120_000;
const TEST_DURATION_MS = 45_000;
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
  logs.push(text);
  if (msg.type() === 'error' || msg.type() === 'warning' || text.includes('spike') || text.includes('perftest') || text.includes('perf-spike')) {
    console.log('BROWSER:', text);
  }
});
page.on('pageerror', err => {
  console.error('PAGE ERROR:', err.message);
  logs.push('[pageerror] ' + err.message);
});

console.log('Opening game…');
await page.goto(URL, { waitUntil: 'networkidle0' });

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

// ── Inject frame-time monitor before scenario so we capture from t=0 ──────
await page.evaluate((thresh) => {
  window.__perfData = { frames: 0, totalMs: 0, maxMs: 0, spikes: [], lastT: performance.now() };
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => _raf((t) => {
    const dt = t - window.__perfData.lastT;
    window.__perfData.lastT = t;
    window.__perfData.frames++;
    window.__perfData.totalMs += dt;
    if (dt > window.__perfData.maxMs) window.__perfData.maxMs = dt;
    if (dt > thresh && window.__perfData.frames > 10) {
      window.__perfData.spikes.push({ frame: window.__perfData.frames, ms: +dt.toFixed(1) });
      console.warn('[perf-spike] frame ' + window.__perfData.frames + ': ' + dt.toFixed(1) + 'ms');
    }
    return cb(t);
  });
}, SPIKE_THRESHOLD_MS);

// ── Scenario setup ─────────────────────────────────────────────────────────
const setupResult = await page.evaluate(() => {
  const game = window.__game;
  if (!game) return { ok: false, error: 'no __game on window' };

  const clusters = game.metalClusters;
  if (!clusters || clusters.length === 0) return { ok: false, error: 'no metal clusters' };

  // Find spawn position from existing workers
  const existingWorkers = game.units.units.filter(u => u.kind === 'worker');
  const spawnX = existingWorkers[0]?.x ?? 128;
  const spawnZ = existingWorkers[0]?.z ?? 128;

  // Sort clusters by distance from spawn
  const live = clusters.filter(c => !c.destroyed);
  live.sort((a, b) => {
    const da = (a.worldX - spawnX) ** 2 + (a.worldZ - spawnZ) ** 2;
    const db = (b.worldX - spawnX) ** 2 + (b.worldZ - spawnZ) ** 2;
    return da - db;
  });

  const c1 = live[0];
  const c2 = live[1] ?? live[0];
  const dist1 = Math.hypot(c1.worldX - spawnX, c1.worldZ - spawnZ);

  console.log('[perftest] spawn at (' + spawnX.toFixed(1) + ', ' + spawnZ.toFixed(1) + ')');
  console.log('[perftest] nearest cluster: id=' + c1.id + ' at (' + c1.worldX.toFixed(1) + ', ' + c1.worldZ.toFixed(1) + ') dist=' + dist1.toFixed(1) + 'm');
  console.log('[perftest] live clusters: ' + live.length);

  // Set all existing workers to mine focus
  for (const u of existingWorkers) {
    u.workerFocus = 'mine';
    u.task = { kind: 'idle' };
    u.workerScanCooldown = 0;
    u.workerRouteCooldown = 0;
  }

  // Spawn 4 more workers near nearest cluster so they immediately find ore
  for (let i = 0; i < 4; i++) {
    const ox = (i % 2 === 0 ? 1 : -1) * (3 + i);
    const oz = (i < 2 ? 1 : -1) * 3;
    const w = game.units.spawn('worker', c1.worldX + ox, c1.worldY + 0.5, c1.worldZ + oz);
    if (w) { w.workerFocus = 'mine'; w.task = { kind: 'idle' }; }
  }

  // Spawn 2 more workers near second cluster
  for (let i = 0; i < 2; i++) {
    const w = game.units.spawn('worker', c2.worldX + (i - 1) * 4, c2.worldY + 0.5, c2.worldZ);
    if (w) { w.workerFocus = 'mine'; w.task = { kind: 'idle' }; }
  }

  // Queue workers from an existing barracks if one exists
  let barracksFilled = false;
  const barracks = game.buildings.buildings.find(b => b.spec.kind === 'barracks' && !b.destroyed);
  if (barracks) {
    for (let i = 0; i < 3; i++) barracks.trainQueue.push('worker');
    barracksFilled = true;
    console.log('[perftest] Queued 3 workers in existing barracks');
  } else {
    console.log('[perftest] No barracks in world yet — workers spawned directly');
  }

  const workerCount = game.units.units.filter(u => u.kind === 'worker').length;
  console.log('[perftest] Total workers: ' + workerCount);
  return { ok: true, workerCount, dist1, clusterCount: live.length, barracksFilled };
});

console.log('Setup:', setupResult);
if (!setupResult.ok) {
  console.error('Setup failed:', setupResult.error);
  await browser.close();
  process.exit(1);
}

// ── Monitor loop ───────────────────────────────────────────────────────────
console.log('\nRunning ' + (TEST_DURATION_MS / 1000) + 's — status every 5s:');
const t0 = Date.now();
while (Date.now() - t0 < TEST_DURATION_MS) {
  await new Promise(r => setTimeout(r, 5000));
  const s = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return null;
    const ws = g.units.units.filter(u => u.kind === 'worker');
    const p = window.__perfData;
    return {
      workers: ws.length,
      metals: g.resources.metals,
      idle: ws.filter(u => u.task.kind === 'idle').length,
      mine: ws.filter(u => u.task.kind === 'mine').length,
      deliver: ws.filter(u => u.task.kind === 'deliver').length,
      maxMs: p.maxMs.toFixed(1),
      spikes: p.spikes.length,
      frames: p.frames,
    };
  }).catch(() => null);
  if (s) {
    console.log(
      '  t=' + ((Date.now() - t0) / 1000).toFixed(0) + 's' +
      '  workers=' + s.workers +
      ' (idle=' + s.idle + ' mine=' + s.mine + ' deliver=' + s.deliver + ')' +
      '  metals=' + s.metals +
      '  maxFrame=' + s.maxMs + 'ms' +
      '  spikes=' + s.spikes,
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
  };
});

console.log('\n══ FINAL REPORT ══════════════════════════');
console.log('Frames : ' + r.frames + '   avg=' + r.avgMs + 'ms   max=' + r.maxMs + 'ms');
console.log('Workers: ' + r.workers + '   metals collected: ' + r.metals);
console.log('States : ' + JSON.stringify(r.states));
console.log('Spikes (>' + SPIKE_THRESHOLD_MS + 'ms): ' + r.spikes.length);
if (r.spikes.length > 0) {
  for (const s of r.spikes.slice(0, 15)) {
    console.log('  frame ' + s.frame + ': ' + s.ms + 'ms');
  }
  const spikelogs = logs.filter(l =>
    l.includes('spike') || l.includes('perf') || l.includes('error') || l.includes('warn'),
  );
  if (spikelogs.length) {
    console.log('\nRelevant browser logs:');
    for (const l of spikelogs.slice(0, 20)) console.log(' ', l);
  }
}

const passed = r.spikes.length === 0 && r.metals > 0;
console.log('\n' + (passed ? '✓ PASS' : '✗ FAIL') +
  ' — ' + r.spikes.length + ' spikes, ' + r.metals + ' metals mined');

await new Promise(r => setTimeout(r, 4000));
await browser.close();
process.exit(passed ? 0 : 1);
