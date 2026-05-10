// End-to-end probe: drives the live container at localhost:8080 with a
// software-WebGL Chromium so the headless tab can actually render the
// SPA, walks through the lobby, and dumps periodic snapshots of the
// browser-side __game state alongside server-side /game/state.

const puppeteer = require('puppeteer');

const BASE = process.env.PROBE_URL || 'http://localhost:8080';
const RUN_SECONDS = Number(process.env.PROBE_SECONDS || 25);

function ts() { return new Date().toISOString().slice(11, 23); }
function log(...args) { console.log(`[${ts()}]`, ...args); }

async function fetchServerState() {
  const r = await fetch(`${BASE}/game/state`);
  if (!r.ok) throw new Error(`/game/state ${r.status}`);
  return r.json();
}

async function main() {
  log('launching chromium with GPU-backed WebGL (headed)…');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on('console', msg => {
    const t = msg.type();
    const text = msg.text();
    // Print ALL console output so a shader compile error doesn't get
    // filtered out as a low-severity 'log'.
    if (text.includes('Connection refused') || text.includes('ERR_CONNECTION')) return;
    log(`[browser:${t}]`, text);
  });
  page.on('pageerror', err => log(`[browser:pageerror]`, err.message));

  log(`navigating to ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  // Lobby flow without a session in URL: Create session → Ready → Start.
  log('waiting for #lobby-create…');
  await page.waitForSelector('#lobby-create', { timeout: 30000 });
  await page.evaluate(() => {
    const i = document.querySelector('#lobby-name');
    if (i) i.value = 'Probe';
  });
  await page.click('#lobby-create');
  log('created session; waiting for #ready-btn…');
  await page.waitForSelector('#ready-btn', { timeout: 30000 });
  await page.click('#ready-btn');
  log('marked ready; waiting for enabled #start-btn…');
  await page.waitForSelector('#start-btn:not([disabled])', { timeout: 30000 });
  await page.click('#start-btn');
  log('clicked Start');

  // Wait until __game lands on window.
  log('waiting for window.__game…');
  await page.waitForFunction(() => !!window.__game, { timeout: 60000, polling: 250 });
  log('game booted, waiting for zero-trust attach…');
  await page.waitForFunction(() => window.__game?.zeroTrustEnabled === true, { timeout: 60000, polling: 250 });
  log('zero-trust attached');

  // Sample state for RUN_SECONDS — log every sample so we can see
  // the trajectory, not just transitions.
  const start = Date.now();
  let firstWorkerSampled = null;
  while (Date.now() - start < RUN_SECONDS * 1000) {
    const local = await page.evaluate(() => {
      const g = window.__game;
      if (!g) return null;
      const units = g.units?.units || [];
      const live = units.filter(u => u.hp > 0);
      const playerLive = live.filter(u => u.team === 'player');
      const playerWorkers = playerLive.filter(u => u.kind === 'worker');
      const enemyLive = live.filter(u => u.team === 'enemy');
      const sn = window.__gameClient?.latestSnapshot?.();
      const ip = window.__gameClient?.interpolatedSnapshot?.();
      const firstPw = playerWorkers[0];
      return {
        paused: g.paused,
        playerId: window.__gameClient?.playerId,
        live: live.length, playerLive: playerLive.length, playerWorkers: playerWorkers.length, enemyLive: enemyLive.length,
        mirrored: g.mirroredUnitIds?.size,
        acked: g.serverAckedUnitIds?.size,
        sd: g.serverDrivenUnitIds?.size,
        snapTick: sn?.tick,
        snapEnts: sn?.entities?.length,
        snapBldg: sn?.buildings?.length,
        ipEnts: ip?.entities?.length,
        firstPwId: firstPw?.id,
        firstPwHp: firstPw?.hp,
        firstPwPos: firstPw && [Math.round(firstPw.x*10)/10, Math.round(firstPw.y*10)/10, Math.round(firstPw.z*10)/10],
        firstPwPathLen: firstPw?.path?.length,
      };
    });
    const server = await fetchServerState();
    if (firstWorkerSampled === null && local.firstPwId != null) firstWorkerSampled = local.firstPwId;
    log(`local{ live=${local.live} pwk=${local.playerWorkers} mirr=${local.mirrored} ack=${local.acked} sd=${local.sd} } server{ ents=${server.entities.length} bldg=${server.buildings.length} } snap{ t=${local.snapTick} ents=${local.snapEnts} ip=${local.ipEnts} } pw0{ id=${local.firstPwId} hp=${local.firstPwHp} pos=${JSON.stringify(local.firstPwPos)} path=${local.firstPwPathLen} }`);
    await new Promise(r => setTimeout(r, 1500));
  }

  // Diagnostics: do the playerIds match between the client identifier and
  // the entity owners on the server?
  const ids = await page.evaluate(async () => {
    const pid = window.__gameClient?.playerId;
    const sn = window.__gameClient?.latestSnapshot?.();
    const r = await fetch('/game/state');
    const full = await r.json();
    const r2 = await fetch('/game/state?player=' + encodeURIComponent(pid));
    const filtered = await r2.json();
    return {
      pid,
      // Owners observed on the server (unfiltered) and via the
      // ?player= filter from the browser's perspective.
      serverEntOwners: [...new Set(full.entities.map(e => e.owner))],
      serverBldgOwners: [...new Set(full.buildings.map(b => b.owner))],
      serverEntCount: full.entities.length,
      filteredEntCount: filtered.entities.length,
      filteredBldgCount: filtered.buildings.length,
      streamSnapEnts: sn?.entities?.length,
      streamSnapBldg: sn?.buildings?.length,
    };
  });
  log('id-diag:', JSON.stringify(ids));

  // Dump the FoW source uniforms to verify what's actually being
  // packed and whether the shader sees them.
  const fowDiag = await page.evaluate(() => {
    const r = window.__game?.meshes?.fowUniforms;
    if (!r) return { has: false };
    const sources = r.uFowSourcesM.value.slice(0, r.uFowSourceCountM.value).map(v => ({
      x: Math.round(v.x * 10) / 10,
      y: Math.round(v.y * 10) / 10,
      z: Math.round(v.z * 10) / 10,
      rsq: Math.round(v.w * 10) / 10,
      r: Math.round(Math.sqrt(v.w) * 10) / 10,
    }));
    return {
      enabled: r.uFowEnabled.value,
      count: r.uFowSourceCountM.value,
      sources,
    };
  });
  log('fow-diag:', JSON.stringify(fowDiag));

  // Dump the actual fragment shader source the GPU compiled so we
  // can see whether our uFowSourcesM block actually made it in.
  const shaderDiag = await page.evaluate(() => {
    const game = window.__game;
    if (!game) return null;
    // Walk the scene for the chunk material; the registry is private
    // but `meshes.scene` is exposed and chunks share one material.
    let mat = null;
    game.meshes.scene.traverse(o => {
      if (o.isMesh && o.material && /MeshLambert/.test(o.material.type) && o.material.userData?.shader) {
        mat = o.material;
      }
    });
    if (!mat) {
      // Fallback: pull from our private field by name (TypeScript private but JS still exposes).
      for (const k of Object.keys(game.meshes)) {
        if (k === 'material' || k.includes('material')) {
          const v = game.meshes[k];
          if (v && v.fragmentShader) { mat = v; break; }
        }
      }
    }
    if (!mat) return { found: false };
    const ud = mat.userData;
    return { found: true, hasShader: !!ud?.shader, frag: ud?.shader?.fragmentShader?.length, vert: ud?.shader?.vertexShader?.length };
  });
  log('shader-diag:', JSON.stringify(shaderDiag));

  const sceneDiag = await page.evaluate(() => {
    const game = window.__game;
    const scene = game?.meshes?.scene;
    if (!scene) return null;
    // Only count meshes whose material is the SHARED chunk material
    // (the registry stores it on `meshes.material`).
    const chunkMat = game.meshes.material;
    let chunkCount = 0, visibleChunks = 0;
    let sample = null;
    scene.traverse(o => {
      if (!o.isMesh) return;
      if (o.material !== chunkMat) return;
      chunkCount++;
      if (o.visible) visibleChunks++;
      if (!sample) {
        const bs = o.geometry.boundingSphere;
        sample = {
          visible: o.visible,
          frustumCulled: o.frustumCulled,
          scale: o.scale.x,
          worldPos: { x: o.position.x, y: o.position.y, z: o.position.z },
          bs: bs ? { x: bs.center.x, y: bs.center.y, z: bs.center.z, r: bs.radius } : null,
          indexCount: o.geometry.index?.count,
          posCount: o.geometry.attributes.position.count,
        };
      }
    });
    const cam = game.camera?.cam || game.renderer?.camera;
    return {
      chunkCount,
      visibleChunks,
      sample,
      matTransparent: chunkMat.transparent,
      matDepthWrite: chunkMat.depthWrite,
      matVisible: chunkMat.visible,
      camPos: cam?.position && { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      camNear: cam?.near, camFar: cam?.far,
    };
  });
  log('scene-diag:', JSON.stringify(sceneDiag));

  // Sanity test: disable FoW and screenshot. If terrain comes back,
  // the discard logic itself is the issue.
  await page.evaluate(() => { window.__game.fowEnabled = false; });
  await new Promise(r => setTimeout(r, 600));
  const fowOff = await page.evaluate(() => ({
    enabled: window.__game.meshes.fowUniforms.uFowEnabled.value,
    count: window.__game.meshes.fowUniforms.uFowSourceCountM.value,
  }));
  log('fow-off-state:', JSON.stringify(fowOff));
  await page.screenshot({ path: '/tmp/probe-nofow.png', fullPage: false });
  log('screenshot saved: /tmp/probe-nofow.png (fow disabled)');
  // Also: also disable Y-cutoff (set to large) to rule it out.
  await page.evaluate(() => { window.__game.meshes.setHideAboveY(Infinity); });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: '/tmp/probe-nocut.png', fullPage: false });
  log('screenshot saved: /tmp/probe-nocut.png (fow + ycut disabled)');

  // High vantage: lift the camera way up, look straight down at a
  // known spot inside the player's base. If terrain renders at all
  // it should be visible from here.
  await page.evaluate(() => {
    const cam = window.__game.camera?.cam;
    if (!cam) return;
    cam.position.set(192, 600, 192);
    cam.lookAt(192, 0, 192);
    if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: '/tmp/probe-topdown.png', fullPage: false });
  log('screenshot saved: /tmp/probe-topdown.png (top-down whole-world)');

  const renderInfo = await page.evaluate(() => {
    const game = window.__game;
    const r = game?.renderer?.renderer || game?.renderer?.three || game?.renderer;
    const info = r?.info;
    const fragSrc = (() => {
      const mat = game.meshes.material;
      const shader = mat.__patchedShader;
      if (!shader?.fragmentShader) return null;
      const f = shader.fragmentShader;
      // Pull the chunk that contains the FoW discard block.
      const i = f.indexOf('inside');
      const j = f.indexOf('discard');
      return { lenFrag: f.length, insideAt: i, discardAt: j, fowBlock: f.slice(Math.max(0, i - 100), j + 50) };
    })();
    return {
      programs: info?.programs?.length,
      render: info ? { calls: info.render?.calls, triangles: info.render?.triangles, points: info.render?.points } : null,
      memoryGeometries: info?.memory?.geometries,
      memoryTextures: info?.memory?.textures,
      shader: fragSrc,
    };
  });
  log('render-info:', JSON.stringify(renderInfo).slice(0, 1500));
  // Re-enable so the rest of the probe is unaffected.
  await page.evaluate(() => { window.__game.fowEnabled = true; });

  // Issue a move command to a player worker and watch the flow.
  log('--- driving move command on player worker ---');
  const moveResult = await page.evaluate(() => {
    const g = window.__game;
    const u = g.units.units.find(x => x.team === 'player' && x.kind === 'worker' && x.hp > 0);
    if (!u) return { ok: false, error: 'no live player worker' };
    const before = { x: u.x, y: u.y, z: u.z };
    const goalX = u.x + 8;
    const goalZ = u.z + 8;
    void g.routePath?.(u, goalX, u.y, goalZ);
    return { ok: true, id: u.id, before, goal: { x: goalX, z: goalZ } };
  });
  log('move requested:', JSON.stringify(moveResult));

  for (let s = 0; s < 6; s++) {
    await new Promise(r => setTimeout(r, 1000));
    const sample = await page.evaluate((id) => {
      const g = window.__game;
      const u = g.units.units.find(x => x.id === id);
      if (!u) return { gone: true };
      const sn = window.__gameClient?.latestSnapshot?.();
      const e = sn?.entities?.find(x => x.id === id) || sn?.entities?.find(x => x.clientTag === `u-${id}`);
      return { gone: false, hp: u.hp, pos: [Math.round(u.x*10)/10, Math.round(u.y*10)/10, Math.round(u.z*10)/10], pathLen: u.path?.length, serverPos: e && [Math.round(e.x*10)/10, Math.round(e.z*10)/10] };
    }, moveResult.id);
    log(`+${s+1}s after move:`, JSON.stringify(sample));
  }

  // Final summary + screenshot.
  log('final snapshot');
  const final = await page.evaluate(() => {
    const g = window.__game;
    const units = g.units.units.filter(u => u.hp > 0);
    return {
      live: units.length,
      byKindTeam: units.reduce((acc, u) => { const k = `${u.team}:${u.kind}`; acc[k] = (acc[k]||0)+1; return acc; }, {}),
    };
  });
  log('final:', JSON.stringify(final));
  const path = '/tmp/probe-final.png';
  await page.screenshot({ path, fullPage: false });
  log(`screenshot saved: ${path}`);

  await browser.close();
}

main().catch(err => { console.error('probe failed:', err); process.exit(1); });
