// Inter-game heuristic fixer.
//
// Reads auto-game's outcome + sample log and edits a few tunable
// constants in the source tree before the next game runs. Each fix
// is conservative and clamped so a runaway loop can't push values
// off the rails. Returns a short human-readable summary of what was
// changed (or `null` if no fix applied).

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s); }

// Per-knob value history keyed by file:regex. Each patch logs its
// resulting value so the next call can reject a repeat. Persisted
// to disk so the rotation survives loop restarts (the orchestrator
// also restarts the harness, but the file persists).
const HISTORY_PATH = '/tmp/auto-fix-history.json';
let HISTORY = {};
try { HISTORY = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch (_e) { HISTORY = {}; }
function historyKey(filePath, regex) { return filePath + '::' + regex.toString(); }
function pushHistory(key, value) {
  if (!HISTORY[key]) HISTORY[key] = [];
  HISTORY[key].push(value);
  if (HISTORY[key].length > 12) HISTORY[key].shift();
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(HISTORY));
}
function isRecentValue(key, value) {
  const h = HISTORY[key] || [];
  // Reject any value we've used in the last 6 patches — otherwise
  // we'd just toggle between two values forever.
  return h.slice(-6).some(v => v === value);
}

function patch(filePath, regex, transform, label) {
  const full = path.join(__dirname, filePath);
  const src = read(full);
  const m = src.match(regex);
  if (!m) return { ok: false, label, reason: 'pattern not found' };
  const old = m[0];
  const replaced = transform(m);
  if (old === replaced) return { ok: false, label, reason: 'no change' };
  // Reject a value we've recently used so the orchestrator stops
  // oscillating between two settings of the same knob.
  const key = historyKey(filePath, regex);
  if (isRecentValue(key, replaced)) return { ok: false, label, reason: 'recent value (oscillation)' };
  write(full, src.replace(regex, replaced));
  pushHistory(key, replaced);
  return { ok: true, label, before: old.trim(), after: replaced.trim() };
}

function patchPathBudget(delta) {
  return patch(
    'src/app/Game.ts',
    /maxExpansions: \d+,/,
    (m) => {
      const cur = parseInt(m[0].match(/\d+/)[0], 10);
      const next = Math.max(50000, Math.min(800000, cur + delta));
      return `maxExpansions: ${next},`;
    },
    `pathBudget+${delta}`,
  );
}

function patchTrainInterval(delta) {
  return patch(
    'ai-server.cjs',
    /const TRAIN_INTERVAL_S = [\d.]+;/,
    (m) => {
      const cur = parseFloat(m[0].match(/[\d.]+/)[0]);
      const next = Math.max(0.5, Math.min(15, cur + delta));
      return `const TRAIN_INTERVAL_S = ${next.toFixed(2)};`;
    },
    `trainInterval+${delta}`,
  );
}

function patchPlaceCooldownInitial(delta) {
  return patch(
    'ai-server.cjs',
    /placeCooldown: [\d.]+,/,
    (m) => {
      const cur = parseFloat(m[0].match(/[\d.]+/)[0]);
      const next = Math.max(0.5, Math.min(10, cur + delta));
      return `placeCooldown: ${next.toFixed(2)},`;
    },
    `placeCooldown+${delta}`,
  );
}

function patchWorkerStall(delta) {
  return patch(
    'src/sim/Workers.ts',
    /const TASK_STALL_SECONDS = [\d.]+;/,
    (m) => {
      const cur = parseFloat(m[0].match(/[\d.]+/)[0]);
      const next = Math.max(1, Math.min(15, cur + delta));
      return `const TASK_STALL_SECONDS = ${next.toFixed(2)};`;
    },
    `workerStall+${delta}`,
  );
}

function patchPassableRing(delta) {
  return patch(
    'src/app/Game.ts',
    /const passableRing = unit\.footprintRadius >= 2 \? \d+ : \d+;/,
    (m) => {
      const nums = m[0].match(/\d+/g);
      const wide = parseInt(nums[1], 10);
      const narrow = parseInt(nums[2], 10);
      const newWide = Math.max(4, Math.min(40, wide + delta));
      const newNarrow = Math.max(4, Math.min(80, narrow + delta));
      return `const passableRing = unit.footprintRadius >= 2 ? ${newWide} : ${newNarrow};`;
    },
    `passableRing+${delta}`,
  );
}

function patchAttackStopFraction(delta) {
  return patch(
    'ai-server.cjs',
    /const ATTACK_STOP_FRACTION = [\d.]+;/,
    (m) => {
      const cur = parseFloat(m[0].match(/[\d.]+/)[0]);
      const next = Math.max(0.1, Math.min(0.95, cur + delta));
      return `const ATTACK_STOP_FRACTION = ${next.toFixed(2)};`;
    },
    `attackStopFraction+${delta}`,
  );
}

function patchAttackRetarget(delta) {
  return patch(
    'ai-server.cjs',
    /const ATTACK_RETARGET_S = [\d.]+;/,
    (m) => {
      const cur = parseFloat(m[0].match(/[\d.]+/)[0]);
      const next = Math.max(0.5, Math.min(10, cur + delta));
      return `const ATTACK_RETARGET_S = ${next.toFixed(2)};`;
    },
    `attackRetarget+${delta}`,
  );
}

function patchPlaceCooldownAfter(delta) {
  return patch(
    'ai-server.cjs',
    /h\.placeCooldown = (\d+\.\d+);/g,
    (m) => {
      const cur = parseFloat(m[1]);
      const next = Math.max(1.0, Math.min(20, cur + delta));
      return `h.placeCooldown = ${next.toFixed(2)};`;
    },
    `placeCooldownAfter+${delta}`,
  );
}

function patchScanCooldown(delta) {
  return patch(
    'src/sim/Workers.ts',
    /const SCAN_COOLDOWN_SECS = [\d.]+;/,
    (m) => {
      const cur = parseFloat(m[0].match(/[\d.]+/)[0]);
      const next = Math.max(0.05, Math.min(5, cur + delta));
      return `const SCAN_COOLDOWN_SECS = ${next.toFixed(2)};`;
    },
    `scanCooldown+${delta}`,
  );
}

/**
 * Decide what to patch based on the previous game's outcome (string
 * matching auto-game's `OUTCOME ...` line) and a small per-failure
 * tally that lets the fixer escalate.
 */
function applyFix(outcome, tally, dominantNegative) {
  const fixes = [];
  switch (outcome) {
    case 'FAILURE_NEGATIVE_SCORE': {
      // Diagnose the dominant negative event the harness latched
      // and apply the matching code-side correction. Game rules
      // are preserved — we only tune AI pacing/cooldowns.
      switch (dominantNegative) {
        case 'no-military-1s':
        case 'no-unit-1s':
          fixes.push(patchTrainInterval(-0.5));
          fixes.push(patchPlaceCooldownInitial(-0.5));
          break;
        case 'die-soldier':
        case 'die-tank':
        case 'die-rocket':
          // Units dying too fast: pull combat units back from the
          // engagement edge so they don't get focus-fired before
          // they can fire back. Larger stop fraction means they
          // hold further from targets.
          fixes.push(patchAttackStopFraction(+0.05));
          break;
        default:
          // Unknown cause — bump production speed as a default fix.
          fixes.push(patchTrainInterval(-0.25));
          break;
      }
      break;
    }
    case 'FAILURE_STUCK': {
      // Worker / combat trapped: bump path budget + worker stall
      // recovery so the per-worker blacklist kicks in faster.
      fixes.push(patchPathBudget(+50000));
      if ((tally.STUCK || 0) >= 2) fixes.push(patchWorkerStall(-0.25));
      if ((tally.STUCK || 0) >= 4) fixes.push(patchPassableRing(+5));
      break;
    }
    case 'FAILURE_TRUCK': {
      fixes.push(patchPathBudget(+50000));
      break;
    }
    case 'FAILURE_TELEPORT':
    case 'FAILURE_RUBBERBAND': {
      // No teleport hacks remain in the source — these failures mean
      // a real teleport site we haven't found yet. Bump path budget
      // so the pathfinder doesn't fall back to a partial path
      // (which previously was what the snap-recovery fixed).
      fixes.push(patchPathBudget(+50000));
      break;
    }
    case 'FAILURE_NO_COMBAT': {
      // AI didn't field combat units. Speed up production.
      fixes.push(patchTrainInterval(-0.5));
      fixes.push(patchPlaceCooldownInitial(-0.5));
      break;
    }
    case 'TIMEOUT': {
      // Game stalemated. Push AIs to be more aggressive.
      fixes.push(patchTrainInterval(-0.25));
      fixes.push(patchAttackStopFraction(-0.05));
      break;
    }
    case 'HQ_WIN':
    default:
      return null; // no fix on success
  }
  const ok = fixes.filter(f => f.ok);
  if (ok.length > 0) return { applied: ok, skipped: fixes.filter(f => !f.ok) };

  // Fallback rotation — the primary tunables hit their caps, but
  // the rule is: every failure must produce a code change. Rotate
  // through alternate dimensions until one of them lands a real
  // edit. The rotation index is the count of total failures so far
  // (sum across the tally) so we don't fire the same fallback twice
  // in a row.
  const totalFailures = Object.values(tally).reduce((a, b) => a + b, 0);
  const fallbacks = [
    () => patchAttackRetarget(-0.25),
    () => patchAttackStopFraction(+0.05),
    () => patchAttackStopFraction(-0.05),
    () => patchPlaceCooldownAfter(-1.0),
    () => patchScanCooldown(-0.05),
    () => patchTrainInterval(-0.5),
    () => patchPlaceCooldownInitial(-0.5),
    () => patchPathBudget(-50000), // try unwinding if going up didn't help
  ];
  for (let i = 0; i < fallbacks.length; i++) {
    const idx = (totalFailures + i) % fallbacks.length;
    const r = fallbacks[idx]();
    if (r.ok) return { applied: [r], skipped: fixes, rotation: idx };
  }
  // Truly nothing left to tune — return the skip list so the
  // orchestrator at least logs that we tried.
  return { applied: [], skipped: fixes };
}

module.exports = { applyFix };

if (require.main === module) {
  // CLI for quick manual testing: `node auto-fix.cjs FAILURE_STUCK '{"STUCK":3}'`
  const [, , outcome, tallyJson] = process.argv;
  const tally = tallyJson ? JSON.parse(tallyJson) : {};
  console.log(JSON.stringify(applyFix(outcome, tally), null, 2));
}
