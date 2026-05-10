// Run auto-game.cjs until 100 successful HQ_WIN runs are recorded.
// Between each game we:
//   1. Read the outcome + score from the run's stdout.
//   2. Apply a heuristic fix to the source tree (auto-fix.cjs) so the
//      next game runs against a slightly different code path.
//   3. Rebuild the dist + docker image so the patch ships.
//   4. Boot a fresh container and run the next game.
//
// The orchestrator never waits for a human — failures retry and only
// HQ_WIN counts toward the 100 target. Between every game we print
// the score delta vs the previous game so the % improvement is
// visible.

const { spawn } = require('child_process');
const fs = require('fs');
const { applyFix } = require('./auto-fix.cjs');

const TARGET = Number(process.env.AUTO_TARGET || 100);
const PER_ITER_BUDGET = Number(process.env.AUTO_BUDGET || 480);
const MAX_RETRIES_PER_ITER = Number(process.env.AUTO_RETRIES || 30);
const LOG_FILE = process.env.AUTO_LOG || '/tmp/auto-loop.log';

function ts() { return new Date().toISOString().slice(11, 23); }
function append(line) {
  fs.appendFileSync(LOG_FILE, `[${ts()}] ${line}\n`);
  console.log(`[${ts()}]`, line);
}

function execSync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { ...opts, stdio: 'pipe' });
    let out = '', err = '';
    c.stdout.on('data', d => out += d);
    c.stderr.on('data', d => err += d);
    c.on('exit', code => resolve({ code, out, err }));
  });
}

async function rebuildAndRedeploy() {
  const t0 = Date.now();
  const build = await execSync('npx', ['vite', 'build'], { cwd: __dirname });
  if (build.code !== 0) {
    return { ok: false, ms: Date.now() - t0, where: 'vite-build', err: (build.err || '').slice(-2000) };
  }
  const dock = await execSync('docker', ['build', '-t', 'voxel-rts', '.'], { cwd: __dirname });
  if (dock.code !== 0) {
    return { ok: false, ms: Date.now() - t0, where: 'docker-build', err: (dock.err || '').slice(-2000) };
  }
  return { ok: true, ms: Date.now() - t0 };
}

async function resetDocker() {
  await execSync('docker', ['rm', '-f', 'voxel-rts'], { cwd: __dirname });
  await execSync('docker', ['run', '-d', '--name', 'voxel-rts', '-p', '8080:8080', 'voxel-rts'], { cwd: __dirname });
  for (let i = 0; i < 30; i++) {
    const r = await execSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:8080']);
    if (r.out.trim() === '200') return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('docker did not come up within 15s');
}

function runOnce(iter) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      AUTO_ITER: String(iter).padStart(2, '0'),
      AUTO_SECONDS: String(PER_ITER_BUDGET),
      AUTO_SHOT: `/tmp/auto-shot-${String(iter).padStart(2, '0')}.png`,
    };
    const child = spawn('node', ['auto-game.cjs'], { env, cwd: __dirname });
    const lines = [];
    child.stdout.on('data', d => {
      const s = d.toString();
      lines.push(s);
      process.stdout.write(s);
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      lines.push(s);
      process.stderr.write(s);
    });
    child.on('exit', (code) => {
      const text = lines.join('');
      const finalLine = text.split('\n').reverse().find(l => l.includes('FINAL '));
      const outcomeLine = text.split('\n').reverse().find(l => l.includes('OUTCOME '));
      const negLine = text.split('\n').reverse().find(l => l.includes('FAILURE_NEGATIVE_SCORE'));
      let score = null;
      if (finalLine) {
        const m = finalLine.match(/"score":(-?\d+)/);
        if (m) score = parseInt(m[1], 10);
      }
      let dominantNegative = null;
      if (negLine) {
        const m = negLine.match(/dominantNegative=(\S+)/);
        if (m) dominantNegative = m[1];
      }
      resolve({
        code,
        outcome: outcomeLine ? outcomeLine.trim() : '(no outcome)',
        outcomeKind: (outcomeLine && outcomeLine.match(/OUTCOME (\S+)/)?.[1]) || 'UNKNOWN',
        dominantNegative,
        final: finalLine ? finalLine.trim() : '(no final)',
        score,
        text,
      });
    });
  });
}

async function main() {
  fs.writeFileSync(LOG_FILE, `=== auto-loop start, target=${TARGET} ===\n`);
  let successes = 0;
  let lastScore = null;
  const failTally = Object.create(null);
  let totalAttempts = 0;
  const reason = (code) => ({
    0:'HQ_WIN', 1:'HARNESS', 2:'NO_COMBAT', 3:'STUCK',
    4:'TRUCK', 5:'RUBBERBAND', 6:'TIMEOUT', 7:'TELEPORT',
    8:'NEGATIVE_SCORE',
  })[code] || `EXIT(${code})`;

  // Initial build + container so the first game has something to play.
  append('initial build + docker reset');
  const initBuild = await rebuildAndRedeploy();
  if (!initBuild.ok) { append(`initial build failed at ${initBuild.where}: ${initBuild.err}`); process.exit(1); }
  await resetDocker().catch(e => { append('docker reset failed: ' + e.message); process.exit(1); });

  for (let iter = 1; iter <= TARGET; iter++) {
    let attempt = 1;
    let result;
    while (attempt <= MAX_RETRIES_PER_ITER) {
      totalAttempts++;
      append(`=== iter ${iter} attempt ${attempt} (totalAttempts=${totalAttempts}) ===`);
      result = await runOnce(iter);
      const code = result.code;
      append(`iter ${iter} attempt ${attempt} → exit=${code} (${reason(code)}) score=${result.score}`);
      // Score delta vs previous game.
      if (lastScore !== null && result.score !== null) {
        const delta = result.score - lastScore;
        const denom = Math.max(1, Math.abs(lastScore));
        const pct = (delta / denom) * 100;
        append(`Δscore vs prior = ${delta >= 0 ? '+' : ''}${delta} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
      }
      if (result.score !== null) lastScore = result.score;

      if (code === 0) break;

      // Failure: tally + apply heuristic fix + rebuild + reset docker.
      const r = reason(code);
      failTally[r] = (failTally[r] || 0) + 1;
      const fix = applyFix(result.outcomeKind, failTally, result.dominantNegative);
      // Always render the diagnostic SVG so we can spot stuck units
      // and disconnected nav components in the failed run.
      try {
        const iterStr = String(iter).padStart(2, '0');
        await execSync('node', ['auto-svg.cjs', `/tmp/auto-dump-${iterStr}.json`, `/tmp/auto-dump-${iterStr}.svg`]);
        append(`  svg: /tmp/auto-dump-${iterStr}.svg`);
      } catch (e) { append('  svg render failed: ' + e.message); }

      if (fix && fix.applied?.length > 0) {
        for (const f of fix.applied) append(`  fix: ${f.label}  ${f.before}  →  ${f.after}`);
        const build = await rebuildAndRedeploy();
        if (!build.ok) { append(`build failed at ${build.where}: ${build.err}`); break; }
      } else {
        // Rule: do not start a new game without a real change or
        // plan. Auto-fixer exhausted every tunable in its toolbox,
        // so the orchestrator writes a plan file (the SVG + the
        // most recent failure mode) and halts the loop. The plan
        // documents what was tried and what's left to investigate.
        const iterStr = String(iter).padStart(2, '0');
        const planPath = `/tmp/auto-plan-${iterStr}-${attempt}.md`;
        const planLines = [];
        planLines.push(`# Auto-fix exhausted on iter ${iter} attempt ${attempt}`);
        planLines.push('');
        planLines.push(`Outcome: ${result.outcome}`);
        planLines.push(`Score: ${result.score}`);
        planLines.push(`Dominant negative event: ${result.dominantNegative ?? 'n/a'}`);
        planLines.push(`SVG: /tmp/auto-dump-${iterStr}.svg`);
        planLines.push('');
        planLines.push('## Tunables tried this loop');
        for (const r of (fix?.skipped ?? [])) planLines.push(`- ${r.label} → ${r.reason}`);
        planLines.push('');
        planLines.push('## Suggested next investigation');
        planLines.push('1. Open the SVG: identify clusters of stuck units and disconnected nav regions.');
        planLines.push('2. Look for unit ids that appear stuck across multiple iters — those are deterministic failure modes.');
        planLines.push('3. Add a new dimension to auto-fix.cjs (a knob, or a structural patch like adjusting unit footprint, separation radius, or A* heuristic weight).');
        planLines.push('4. Re-run the loop after the new patch.');
        const fs = require('fs');
        fs.writeFileSync(planPath, planLines.join('\n'));
        append(`  ⚠ NO FIX APPLIED — plan written: ${planPath}; halting loop until a manual change lands`);
        return; // halt the entire orchestrator
      }
      try { await resetDocker(); }
      catch (e) { append('docker reset failed: ' + e.message); break; }
      attempt++;
    }
    if (result && result.code === 0) {
      successes++;
      append(`✓ iter ${iter} OK (${successes}/${TARGET})  ${result.final}`);
    } else {
      append(`✗ iter ${iter} exhausted retries; counting as failure`);
    }
  }
  append(`=== auto-loop done. successes=${successes}/${TARGET} attempts=${totalAttempts} fails=${JSON.stringify(failTally)} ===`);
  process.exit(successes === TARGET ? 0 : 1);
}

main().catch(err => { append('orchestrator failed: ' + err.message); process.exit(1); });
