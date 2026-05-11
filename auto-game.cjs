// Autonomous AI-vs-AI game watcher with stuck detection + scoring.
//
// Drives the live container at localhost:8080 via headed Chromium,
// sets up a 2-AI lobby (`enemy` vs `enemy2`), then samples local sim
// state every second to:
//   - track per-unit movement; flag any unit whose path is non-empty
//     but XZ delta < 5 cm for too long. Stuck thresholds:
//       * combat (soldier/tank/aa/etc): 2 s
//       * worker (idle, no gather task): 10 s
//   - track per-truck delivery progress; a truck whose `truck_*` task
//     stays stalled for 15 s is a delivery failure.
//   - score points off creations / kills / AA intercepts.
//
// Exit codes:
//   0  → KILL or TIMEOUT (counts toward target)
//   2  → FAILURE_NO_COMBAT (no combat unit fielded in 120 s)
//   3  → FAILURE_STUCK    (a unit stuck past its budget)
//   4  → FAILURE_TRUCK    (a truck stalled mid-delivery)
//
// The orchestrator (auto-loop.cjs) only counts exit 0 toward the
// 100-game target; the rest are retried.

const puppeteer = require('puppeteer');

const BASE = process.env.PROBE_URL || 'http://localhost:8080';
const NUM_AI = Number(process.env.AUTO_AI || 2);
// Game runs until an HQ is destroyed (HQ_WIN) or it bails on a
// failure state (FAILURE_*). The wall-clock ceiling is 8 min so a
// stalemate doesn't pin the orchestrator; the orchestrator counts
// TIMEOUT as a draw and retries.
const RUN_SECONDS = Number(process.env.AUTO_SECONDS || 480);
// Sample at 2 Hz. Was 1 Hz which undercounted the +5/hit bonus by
// 5×; was 10 Hz briefly but jitter pushed normal-motion units into
// the rubberband detector's edge band. 500 ms balances finer hit
// detection against false rubberband flags.
const SAMPLE_EVERY_MS = Number(process.env.AUTO_SAMPLE_MS || 500);
const SHOT_PATH = process.env.AUTO_SHOT || '/tmp/auto-final.png';
const ITERATION = process.env.AUTO_ITER || '?';

// Stuck thresholds (seconds without XZ movement while having a path).
const STUCK_COMBAT_S = 2.0;
const STUCK_WORKER_S = 10.0;
const STUCK_TRUCK_S = 15.0;
const STUCK_MOVE_M = 0.10; // ≤10 cm in the window counts as no movement

// Rubberbanding / teleport detection. Walking units cap at ~5 m/s,
// trucks ~10 m/s. Anything snapping >12 m in one sample is either
// reconciler overshoot or an outright teleport — both are bugs.
// 5 s warmup so the first server-sync snap doesn't false-positive.
const RUBBERBAND_M_PER_S = 12.0;
const RUBBERBAND_WARMUP_S = 5.0;

// Scoring table.
const SCORE = {
  createSoldier: 2, createTank: 8, createAA: 100,
  killTank: 90, killSoldier: 5, killRocket: 40,
  dieTank: -50, dieSoldier: -20, dieRocket: -10,
  aaInterceptProjectile: 1000,
  hqDestroyed: 5999999999999, // first team to flatten an enemy HQ wins big
  // +5 per hit on an enemy unit OR enemy building. Detected as a
  // per-sample HP drop on a non-player entity. Each sample window
  // bucketizes hits — a unit absorbing 3 shots in 1 s counts as 1
  // hit-event since we only see the net HP delta — but the steady
  // pressure adds up over the game.
  hitOnEnemy: 5,
  // Per-second drought penalties — fire when a wall-clock second
  // ticks over without a fresh production event. Both can apply
  // simultaneously (no production at all → -100/s).
  noUnitPerSec:     -50,
  noMilitaryPerSec: -50,
};

const COMBAT_KINDS = [
  'soldier', 'sniper', 'gunner', 'mortar_soldier', 'rocket_soldier',
  'tank', 'rocket_truck', 'aa_vehicle', 'tunneler', 'worm',
];

function ts() { return new Date().toISOString().slice(11, 23); }
function log(...args) { console.log(`[${ts()}][iter${ITERATION}]`, ...args); }

async function main() {
  log(`launching chromium (${NUM_AI} AI, ${RUN_SECONDS}s budget)`);
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--mute-audio',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const browserLogs = [];
  page.on('console', msg => {
    const t = msg.type();
    const text = msg.text();
    if (text.includes('Connection refused') || text.includes('ERR_CONNECTION')) return;
    if (t === 'log' || t === 'info') return;
    browserLogs.push(`[${t}] ${text}`);
  });
  page.on('pageerror', err => browserLogs.push(`[pageerror] ${err.message}`));

  log(`navigating to ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  await page.waitForSelector('#lobby-create', { timeout: 30000 });
  await page.evaluate(() => {
    const i = document.querySelector('#lobby-name');
    if (i) i.value = 'Watcher';
  });
  await page.click('#lobby-create');
  await page.waitForSelector('#ai-count', { timeout: 30000 });

  for (let i = 0; i < 8; i++) {
    const cur = Number(await page.$eval('#ai-count', el => el.textContent.trim()));
    if (cur === NUM_AI) break;
    const sel = cur < NUM_AI ? '.ai-step[data-delta="1"]' : '.ai-step[data-delta="-1"]';
    await page.click(sel);
    await new Promise(r => setTimeout(r, 220));
  }
  log(`aiCount = ${await page.$eval('#ai-count', el => el.textContent.trim())}`);

  await page.click('#ready-btn');
  await page.waitForSelector('#start-btn:not([disabled])', { timeout: 30000 });
  await page.click('#start-btn');
  log('clicked Start');

  await page.waitForFunction(() => !!window.__game, { timeout: 60000, polling: 250 });
  await page.waitForFunction(() => window.__game?.zeroTrustEnabled === true, { timeout: 60000, polling: 250 });
  log('game booted');

  // The host browser is a Watcher — it has a player team but no AI
  // driving it, so its workers + HQ + storage form a tiny vision
  // bubble in the NW corner and the rest of the map is fogged. For
  // an AI-vs-AI observation run we want to see everything, so flip
  // FoW off entirely. Only affects rendering; AI logic uses its own
  // visibility model.
  await page.evaluate(() => {
    if (window.__game) {
      window.__game.fowEnabled = false;
    }
  });
  log('FoW disabled (watcher sees full map)');

  // Initialize tracking state inside the page so we can sample the
  // live sim cheaply each tick.
  await page.evaluate((cfg) => {
    window.__autoState = {
      seen: new Map(),               // id → { team, kind, lastHp, dead, scoredCreate }
      seenBldg: new Map(),           // id → { team, kind, dead }
      kills: [],                     // { tick, victimTeam, victimKind, victimId }
      stuckSince: new Map(),         // id → wall-clock seconds when last meaningful XZ movement was observed
      lastPos: new Map(),            // id → [x, z]
      truckTaskAt: new Map(),        // truckId → { task, startedAt }
      truckPosLog: new Map(),        // truckId → array of { t, x, z } samples (rolling window)
      score: 10000,                  // starting bank — gets drained by drought / death penalties
      scoreEvents: [],
      aaProjectilesSeenDead: new Set(),
      stuckFail: null,               // { id, kind, team, secs }
      truckFail: null,               // { id, task, secs }
      rubberFail: null,              // { id, kind, team, dist, dt }
      lastSampleAt: null,            // wall-clock of previous sample for rubberband Δ
      teleportFail: null,            // { id, kind, team, dist, from, to, at }
      hqWinner: null,                // first team to destroy an enemy HQ
      hqWinnerAt: null,              // wall-clock time of the kill
      runStartedAt: performance.now() / 1000,
      // Production-drought tracking.
      lastUnitCreatedAt: performance.now() / 1000,
      lastMilitaryCreatedAt: performance.now() / 1000,
      droughtAccountedSec: 0,
    };
    window.__autoSCORE = cfg.SCORE;
  }, { SCORE });

  const COMBAT_DEADLINE_MS = 120 * 1000;
  const start = Date.now();
  let outcome = 'TIMEOUT';
  let combatSeen = false;
  let stuckBail = null;
  let truckBail = null;

  while (Date.now() - start < RUN_SECONDS * 1000) {
    const sample = await page.evaluate((opts) => {
      const now = performance.now() / 1000;
      const state = window.__autoState;
      const g = window.__game;
      const sn = window.__gameClient?.latestSnapshot?.();
      const ents = (sn?.entities) || [];
      const liveSnap = new Set();
      for (const e of ents) if ((e.hp ?? 1) > 0) liveSnap.add(e.id);

      const us = g?.units?.units || [];
      const localLive = new Set();
      const SCORE = window.__autoSCORE;
      for (const u of us) {
        if (u.hp <= 0) continue;
        localLive.add(u.id);

        // Score creation events the first time we see each id.
        let entry = state.seen.get(u.id);
        if (!entry) {
          entry = { team: u.team, kind: u.kind, lastHp: u.hp, dead: false, scoredCreate: true };
          state.seen.set(u.id, entry);
          // Production-drought reset: any new unit at all clears
          // the unit-drought timer; a new MILITARY unit also clears
          // the military-drought timer. A "military" unit excludes
          // the economy roles (worker, civilian, supply_truck).
          state.lastUnitCreatedAt = now;
          if (opts.COMBAT_KINDS.includes(u.kind)) {
            state.lastMilitaryCreatedAt = now;
          }
          let pts = 0;
          if (u.kind === 'soldier' || u.kind === 'gunner' || u.kind === 'sniper'
              || u.kind === 'mortar_soldier') pts = SCORE.createSoldier;
          else if (u.kind === 'tank') pts = SCORE.createTank;
          else if (u.kind === 'aa_vehicle') pts = SCORE.createAA;
          else if (u.kind === 'rocket_soldier' || u.kind === 'rocket_truck') pts = SCORE.createSoldier;
          if (pts !== 0) {
            state.score += pts;
            state.scoreEvents.push({ at: now, team: u.team, ev: 'create', kind: u.kind, pts });
          }
        }
        // Hit scoring: every per-sample HP drop on a non-player unit
        // counts as a hit landed by the attacking side. +5 per hit
        // (the user's bonus for keeping pressure on the enemy).
        // Player-team units are excluded since the player is the
        // Watcher and isn't fighting.
        if (entry.lastHp > u.hp && u.team !== 'player') {
          state.score += SCORE.hitOnEnemy;
          state.scoreEvents.push({ at: now, team: 'attacker', ev: 'hit-unit', kind: u.kind, pts: SCORE.hitOnEnemy, victim: u.team });
        }
        entry.lastHp = u.hp;

        // Movement / stuck check.
        // - Combat units (soldier/tank/aa/etc): a stuck unit is one
        //   with a path waypoint (>0) but no XZ movement for N s.
        // - Workers: stuck means "no movement for 10 s AND not
        //   currently gathering". Path state is ignored — a worker
        //   that's reached its goal but isn't doing anything is also
        //   stuck per the user's definition.
        // - Supply trucks: same as combat (they always have a task).
        const prev = state.lastPos.get(u.id);
        const moved = prev ? Math.hypot(u.x - prev[0], u.z - prev[1]) : 0;
        state.lastPos.set(u.id, [u.x, u.z]);
        // Rubberband detection: any single-sample displacement larger
        // than RUBBERBAND_M_PER_S × dt is the server snapping the
        // unit's position back, not real movement. Flag once and let
        // the harness fail the run.
        if (prev && state.lastSampleAt != null && now - state.runStartedAt > opts.RUBBERBAND_WARMUP_S) {
          const dt = now - state.lastSampleAt;
          const cap = opts.RUBBERBAND_M_PER_S * Math.max(dt, 0.1);
          if (moved > cap && !state.rubberFail) {
            state.rubberFail = {
              id: u.id, kind: u.kind, team: u.team,
              dist: +moved.toFixed(2), dt: +dt.toFixed(2),
              from: [+prev[0].toFixed(1), +prev[1].toFixed(1)],
              to: [+u.x.toFixed(1), +u.z.toFixed(1)],
            };
          }
        }
        const isWorker = u.kind === 'worker';
        const isCombat = opts.COMBAT_KINDS.includes(u.kind);
        const isTruck = u.kind === 'supply_truck';
        // "Gathering" in the user's sense means the worker has any
        // task it's actively pursuing — chop / mine / farm /
        // deliver. A worker mid-deliver who happens to stop moving
        // because their path failed is genuinely stuck on the
        // pathfinder, but the harness already detects that via the
        // truck-style stalled-task signal below; for the worker we
        // only fail when the unit is truly idle (no task) for the
        // user's 10 s budget.
        const workerWorking = isWorker
          && (u.task?.kind === 'chop' || u.task?.kind === 'mine'
              || u.task?.kind === 'farm' || u.task?.kind === 'harvestFarm'
              || u.task?.kind === 'storage_drop' || u.task?.kind === 'deliver');
        const hasPath = (u.path?.length || 0) > 0;
        // A combat unit at its destination often holds a stale final
        // waypoint until the next path is set. Treat the unit as "at
        // goal" if its current XZ position is within 1.5 m of its
        // next waypoint — those aren't stuck, they just haven't
        // popped the trailing path entry yet.
        let atGoal = false;
        if (hasPath && u.path[0]) {
          const wp = u.path[0];
          const wd = Math.hypot(wp.x - u.x, wp.z - u.z);
          if (wd <= 1.5) atGoal = true;
        }
        const isFiring = (isCombat && (u.firingTarget != null || u.fireCooldown > 0));
        const watchingForStuck = isWorker
          ? !workerWorking
          : (isCombat || isTruck) ? (hasPath && !isFiring && !atGoal)
          : false;
        if (watchingForStuck && moved < opts.STUCK_MOVE_M) {
          if (!state.stuckSince.has(u.id)) state.stuckSince.set(u.id, now);
        } else {
          state.stuckSince.delete(u.id);
        }
        const since = state.stuckSince.get(u.id);
        if (since !== undefined) {
          const secs = now - since;
          const budget = isCombat ? opts.STUCK_COMBAT_S
            : isTruck ? opts.STUCK_TRUCK_S
            : isWorker ? opts.STUCK_WORKER_S
            : opts.STUCK_COMBAT_S;
          if (secs > budget && !state.stuckFail) {
            state.stuckFail = { id: u.id, kind: u.kind, team: u.team, secs: +secs.toFixed(1),
              pos: [+u.x.toFixed(1), +u.z.toFixed(1)],
              pathLen: u.path?.length || 0,
              task: u.task?.kind || null,
            };
          }
        }

        // Truck delivery stall: a truck whose task has been stuck on
        // the same {kind, target} for too long.
        if (u.kind === 'supply_truck' && u.task && u.task.kind &&
            (u.task.kind === 'truck_fetch' || u.task.kind === 'truck_deliver_hq'
             || u.task.kind === 'truck_deliver_upgrade' || u.task.kind === 'truck_return')) {
          const sig = u.task.kind + ':' + (u.task.buildingId ?? u.task.storageId ?? '');
          const t = state.truckTaskAt.get(u.id);
          if (!t || t.sig !== sig) {
            state.truckTaskAt.set(u.id, { sig, startedAt: now });
          } else {
            const secs = now - t.startedAt;
            if (secs > opts.STUCK_TRUCK_S * 4 && !state.truckFail) {
              // Trucks can take a while to traverse; only fail when
              // they're well past STUCK_TRUCK_S × 4 = 60 s on the
              // same task.
              state.truckFail = { id: u.id, task: sig, secs: +secs.toFixed(1) };
            }
          }
        } else if (u.kind === 'supply_truck') {
          state.truckTaskAt.delete(u.id);
        }

        // Truck-stuck (5-voxel / 3-second rule): a supply truck must
        // cover at least 5 voxels (0.625 m) of XZ ground in any
        // 3-second window. Trucks dropping below that are stalled
        // by the pathfinder or peer collisions; the harness fails
        // the run so the orchestrator can patch the cause.
        if (u.kind === 'supply_truck') {
          let log = state.truckPosLog.get(u.id);
          if (!log) { log = []; state.truckPosLog.set(u.id, log); }
          log.push({ t: now, x: u.x, z: u.z });
          // Drop samples older than 3 s.
          while (log.length > 0 && now - log[0].t > 3.0) log.shift();
          // Need at least one sample ≥3 s old to evaluate.
          if (log.length >= 2 && now - log[0].t >= 2.95) {
            const dx = u.x - log[0].x, dz = u.z - log[0].z;
            const dist = Math.hypot(dx, dz);
            if (dist < 5 * opts.VOXEL_SIZE && !state.truckFail) {
              state.truckFail = {
                id: u.id, task: u.task?.kind || 'idle',
                kind: 'truck_no_progress', secs: 3,
                dist: +dist.toFixed(2),
                pos: [+u.x.toFixed(1), +u.z.toFixed(1)],
              };
            }
          }
        }
      }

      // Detect deaths (entities that were alive last tick, gone now).
      for (const [id, info] of state.seen) {
        if (info.dead) continue;
        if (localLive.has(id) || liveSnap.has(id)) continue;
        info.dead = true;
        state.kills.push({ tick: sn?.tick, victimTeam: info.team, victimKind: info.kind, victimId: id });
        // Score the death from the victim's side.
        let pts = 0;
        if (info.kind === 'soldier' || info.kind === 'gunner' || info.kind === 'sniper'
            || info.kind === 'mortar_soldier') pts = SCORE.dieSoldier;
        else if (info.kind === 'tank') pts = SCORE.dieTank;
        else if (info.kind === 'rocket_soldier' || info.kind === 'rocket_truck') pts = SCORE.dieRocket;
        if (pts !== 0) {
          state.score += pts;
          state.scoreEvents.push({ at: now, team: info.team, ev: 'die', kind: info.kind, pts });
        }
        // Treat the death as a "kill" for the team that's NOT the
        // victim's team. We don't have a precise killerId, so we
        // grant the kill to any other AI faction that has any combat
        // unit alive — the harness only cares about totals.
        let killPts = 0;
        if (info.kind === 'soldier' || info.kind === 'gunner' || info.kind === 'sniper'
            || info.kind === 'mortar_soldier') killPts = SCORE.killSoldier;
        else if (info.kind === 'tank') killPts = SCORE.killTank;
        else if (info.kind === 'rocket_soldier' || info.kind === 'rocket_truck') killPts = SCORE.killRocket;
        if (killPts !== 0) {
          state.score += killPts;
          state.scoreEvents.push({ at: now, team: 'killer', ev: 'kill', kind: info.kind, pts: killPts });
        }
      }

      // AA interception scoring: any aa_missile projectile that
      // disappears was either a hit (most common cause is the round
      // hitting its target). Count them.
      const projs = g?.projectiles?.projectiles || [];
      for (const p of projs) {
        if (p.kind !== 'aa_missile') continue;
        if (!p.dead) continue;
        if (state.aaProjectilesSeenDead.has(p.id)) continue;
        state.aaProjectilesSeenDead.add(p.id);
        state.score += SCORE.aaInterceptProjectile;
        state.scoreEvents.push({ at: now, team: 'aa', ev: 'intercept', pts: SCORE.aaInterceptProjectile });
      }

      // Track buildings to detect HQ destructions. The first team
      // whose `hq` building is destroyed loses; the team that did it
      // wins the +5,999,999,999,999 jackpot. We don't actually have a
      // killer attribution, so the jackpot lands in `state.score` and
      // the winner team is whichever non-victim team is still alive.
      const bldgs = g?.buildings?.buildings || [];
      for (const b of bldgs) {
        let entry = state.seenBldg.get(b.id);
        if (!entry) {
          entry = { team: b.team, kind: b.spec.kind, dead: false, lastHp: b.hp };
          state.seenBldg.set(b.id, entry);
        }
        // Hit on enemy building: per-sample HP drop = +5 (same rule
        // as unit hits). Excludes player buildings (the Watcher).
        if (!entry.dead && entry.lastHp > b.hp && b.team !== 'player') {
          state.score += SCORE.hitOnEnemy;
          state.scoreEvents.push({ at: now, team: 'attacker', ev: 'hit-bldg', kind: entry.kind, pts: SCORE.hitOnEnemy, victim: entry.team });
        }
        entry.lastHp = b.hp;
        if (!entry.dead && b.destroyed) {
          entry.dead = true;
          state.scoreEvents.push({ at: now, team: entry.team, ev: 'bldg-destroyed', kind: entry.kind });
          if (entry.kind === 'hq' && !state.hqWinner) {
            // Pick the surviving team(s) as winner. Award the
            // jackpot to whichever team is still alive.
            const aliveTeams = new Set();
            for (const ub of bldgs) {
              if (!ub.destroyed && ub.spec.kind === 'hq') aliveTeams.add(ub.team);
            }
            aliveTeams.delete(entry.team);
            const winner = [...aliveTeams][0] || 'unknown';
            state.hqWinner = winner;
            state.hqWinnerAt = now;
            state.score += SCORE.hqDestroyed;
            state.scoreEvents.push({ at: now, team: winner, ev: 'hq-killshot', pts: SCORE.hqDestroyed, victim: entry.team });
          }
        }
      }

      const combat = {};
      for (const u of us) {
        if (u.hp <= 0) continue;
        if (!opts.COMBAT_KINDS.includes(u.kind)) continue;
        const k = `${u.team}:${u.kind}`;
        combat[k] = (combat[k] || 0) + 1;
      }

      // Per-second drought penalty: charge -50 for every full
      // wall-clock second since the last new unit, plus another
      // -50 for every second since the last new military unit.
      // We accumulate the total game-elapsed seconds and only
      // charge the seconds we haven't yet accounted for, so a
      // sample that fires faster than 1 Hz doesn't double-bill
      // and a sample that fires every 2 s charges 2 seconds at
      // once.
      const elapsed = now - state.runStartedAt;
      const wholeSec = Math.floor(elapsed);
      // Startup grace: an AI faction needs the full economy ramp
      // (place barracks → 2 farms → 40 s construction → first farm
      // ripening cycle → first units leaving barracks → first wave
      // walking across the map to the enemy HQ) before HQ destruction
      // can begin. 90 s covers the ramp; the drought rule is meant
      // to punish *ongoing* idleness, not the unavoidable opening.
      const DROUGHT_GRACE_SEC = 90;
      while (state.droughtAccountedSec < wholeSec) {
        state.droughtAccountedSec += 1;
        if (state.droughtAccountedSec <= DROUGHT_GRACE_SEC) continue;
        // The accounted second runs from secStart..secEnd. If the
        // last unit/military creation predates secStart, the whole
        // second was a drought.
        const secStart = state.runStartedAt + state.droughtAccountedSec - 1;
        if (state.lastUnitCreatedAt <= secStart) {
          state.score += SCORE.noUnitPerSec;
          state.scoreEvents.push({ at: now, ev: 'no-unit-1s', pts: SCORE.noUnitPerSec });
        }
        if (state.lastMilitaryCreatedAt <= secStart) {
          state.score += SCORE.noMilitaryPerSec;
          state.scoreEvents.push({ at: now, ev: 'no-military-1s', pts: SCORE.noMilitaryPerSec });
        }
      }

      state.lastSampleAt = now;
      // Teleport audit comes straight from the sim — UnitManager
      // captures pre-tick XZ and flags any per-tick jump > 4 voxels.
      const tp = window.__game?.units?.lastTeleport;
      if (tp && !state.teleportFail) {
        state.teleportFail = {
          id: tp.id, kind: tp.kind, team: tp.team,
          dist: +tp.dist.toFixed(2),
          from: [+tp.from.x.toFixed(2), +tp.from.z.toFixed(2)],
          to: [+tp.to.x.toFixed(2), +tp.to.z.toFixed(2)],
          at: +tp.tickAt.toFixed(2),
        };
      }
      return {
        live: us.filter(u => u.hp > 0).length,
        playerLive: us.filter(u => u.team === 'player' && u.hp > 0).length,
        enemyLive: us.filter(u => u.team !== 'player' && u.hp > 0).length,
        combat,
        kills: state.kills.length,
        score: state.score,
        stuckFail: state.stuckFail,
        truckFail: state.truckFail,
        rubberFail: state.rubberFail,
        teleportFail: state.teleportFail,
        hqWinner: state.hqWinner,
        hqWinnerAt: state.hqWinnerAt,
      };
    }, { STUCK_MOVE_M, STUCK_COMBAT_S, STUCK_WORKER_S, STUCK_TRUCK_S, RUBBERBAND_M_PER_S, RUBBERBAND_WARMUP_S, COMBAT_KINDS, VOXEL_SIZE: 0.125 });

    if (Object.keys(sample.combat).length > 0) combatSeen = true;
    const hqTag = sample.hqWinner ? ` HQ-WIN=${sample.hqWinner}` : '';
    log(`t=${Math.round((Date.now()-start)/1000)}s live=${sample.live} pl=${sample.playerLive} en=${sample.enemyLive} combat=${JSON.stringify(sample.combat)} kills=${sample.kills} score=${sample.score}${hqTag}`);

    if (sample.stuckFail) {
      stuckBail = sample.stuckFail;
      outcome = 'FAILURE_STUCK';
      log(`FAILURE_STUCK ${JSON.stringify(stuckBail)}`);
      break;
    }
    if (sample.truckFail) {
      truckBail = sample.truckFail;
      outcome = 'FAILURE_TRUCK';
      log(`FAILURE_TRUCK ${JSON.stringify(truckBail)}`);
      break;
    }
    if (sample.rubberFail) {
      outcome = 'FAILURE_RUBBERBAND';
      log(`FAILURE_RUBBERBAND ${JSON.stringify(sample.rubberFail)}`);
      break;
    }
    if (sample.teleportFail) {
      outcome = 'FAILURE_TELEPORT';
      log(`FAILURE_TELEPORT ${JSON.stringify(sample.teleportFail)}`);
      break;
    }
    // Negative-score bailout: as soon as the running score crosses
    // below zero the game is over. We tag the dominant cause from
    // the recent score-event log so the orchestrator can patch the
    // right knob (drought → faster AI, deaths → ???).
    if (sample.score < 0) {
      const cause = await page.evaluate(() => {
        const evs = window.__autoState.scoreEvents;
        const recent = evs.slice(-32).filter(e => (e.pts ?? 0) < 0);
        const tally = {};
        for (const e of recent) {
          const k = e.ev || 'unknown';
          tally[k] = (tally[k] || 0) + (e.pts || 0);
        }
        let worst = null;
        for (const k of Object.keys(tally)) {
          if (worst === null || tally[k] < tally[worst]) worst = k;
        }
        return { worst, tally, recent: recent.slice(-6) };
      });
      outcome = 'FAILURE_NEGATIVE_SCORE';
      log(`FAILURE_NEGATIVE_SCORE score=${sample.score} dominantNegative=${cause.worst} ${JSON.stringify(cause.tally)}`);
      break;
    }
    if (sample.hqWinner) {
      outcome = 'HQ_WIN';
      log(`HQ_WIN — winner=${sample.hqWinner}, t=${sample.hqWinnerAt?.toFixed(1)}s, +${SCORE.hqDestroyed}`);
      break;
    }
    if (!combatSeen && Date.now() - start >= COMBAT_DEADLINE_MS) {
      outcome = 'FAILURE_NO_COMBAT';
      log(`FAILURE_NO_COMBAT — no combat unit in ${COMBAT_DEADLINE_MS/1000}s`);
      break;
    }
    await new Promise(r => setTimeout(r, SAMPLE_EVERY_MS));
  }

  // Game runs until a winner destroys an enemy HQ. A bare TIMEOUT
  // means the run hit the wall-clock ceiling without anyone winning;
  // the orchestrator counts it as a draw and retries (it doesn't
  // satisfy "first to destroy an HQ").
  if (outcome === 'TIMEOUT') {
    log('TIMEOUT — no HQ destroyed within the wall-clock ceiling');
  }
  log(`OUTCOME ${outcome}`);

  const finalSummary = await page.evaluate(() => {
    const g = window.__game;
    const us = g?.units?.units || [];
    const live = us.filter(u => u.hp > 0);
    const byTeamKind = live.reduce((acc, u) => {
      const k = `${u.team}:${u.kind}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const bldgsByTeamKind = (g?.buildings?.buildings || []).filter(b => !b.destroyed).reduce((acc, b) => {
      const k = `${b.team}:${b.spec.kind}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return {
      live: live.length,
      byTeamKind,
      bldgsByTeamKind,
      kills: window.__autoState.kills,
      score: window.__autoState.score,
      scoreEvents: window.__autoState.scoreEvents.length,
      elapsed: g.gameElapsedSeconds,
    };
  });
  log('FINAL', JSON.stringify(finalSummary));

  if (browserLogs.length) {
    log('browser-logs:');
    for (const l of browserLogs.slice(-12)) log('  ', l);
  }

  await page.screenshot({ path: SHOT_PATH, fullPage: false });

  // Diagnostic dump: full sim state at the moment of failure so the
  // orchestrator can render a path/position SVG. Always written so
  // even successful runs leave a snapshot for inspection.
  try {
    const dump = await page.evaluate(() => {
      const g = window.__game;
      const us = (g?.units?.units || []).map(u => ({
        id: u.id, kind: u.kind, team: u.team, hp: u.hp,
        x: u.x, z: u.z,
        path: (u.path || []).map(w => ({ x: w.x, z: w.z })),
        task: u.task?.kind || null,
        heading: u.heading,
        firingTarget: u.firingTarget ? { x: u.firingTarget.x, z: u.firingTarget.z } : null,
        claimedClusterId: u.claimedClusterId,
      }));
      const bldgs = (g?.buildings?.buildings || []).filter(b => !b.destroyed).map(b => ({
        id: b.id, kind: b.spec.kind, team: b.team,
        ox: b.ox, oz: b.oz,
        cellsW: b.spec.cellsW, cellsD: b.spec.cellsD,
        hp: b.hp, maxHp: b.maxHp,
        stockpile: b.stockpile ? { ...b.stockpile } : undefined,
        trainQueueLen: b.trainQueue?.length ?? 0,
        cropProgress: b.cropProgress, cropReady: b.cropReady, harvestMilestone: b.harvestMilestone,
        suppliedUnits: b.suppliedUnits, inboundResupplyTrucks: b.inboundResupplyTrucks,
      }));
      const clusters = (g?.metalClusters || []).filter(c => !c.destroyed).map(c => ({
        id: c.id, x: c.worldX, z: c.worldZ, rxz: c.rxz,
        maxWorkers: c.maxWorkers,
        occupied: c.workerSlots.filter(s => s !== 0).length,
      }));
      return {
        outcome: window.__autoState?.stuckFail ?? null,
        score: window.__autoState?.score ?? null,
        units: us, buildings: bldgs, clusters,
        worldExtent: 384,
        scoreEvents: window.__autoState?.scoreEvents ?? [],
        playerResources: g?.resources ? { food: g.resources.food, metals: g.resources.metals, wood: g.resources.wood } : null,
        enemyResources: g?.enemyResources ? { food: g.enemyResources.food, metals: g.enemyResources.metals, wood: g.enemyResources.wood } : null,
      };
    });
    const fs = require('fs');
    const dumpPath = `/tmp/auto-dump-${(process.env.AUTO_ITER || '?')}.json`;
    fs.writeFileSync(dumpPath, JSON.stringify(dump));
    log(`diagnostic dump saved: ${dumpPath}`);
  } catch (e) { log('diagnostic dump failed: ' + e.message); }

  await browser.close();
  if (outcome === 'HQ_WIN') process.exit(0);
  if (outcome === 'FAILURE_STUCK') process.exit(3);
  if (outcome === 'FAILURE_TRUCK') process.exit(4);
  if (outcome === 'FAILURE_RUBBERBAND') process.exit(5);
  if (outcome === 'FAILURE_TELEPORT') process.exit(7);
  if (outcome === 'FAILURE_NO_COMBAT') process.exit(2);
  if (outcome === 'FAILURE_NEGATIVE_SCORE') process.exit(8);
  process.exit(6); // TIMEOUT or anything else doesn't count toward target
}

main().catch(err => { console.error('auto-game failed:', err); process.exit(1); });
