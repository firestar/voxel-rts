// Render a top-down SVG of the game-state dump auto-game.cjs writes
// on every game end. Visualizes unit positions, paths, building
// footprints, and metal-cluster slots so we can spot stuck units,
// disconnected nav components, etc.

const fs = require('fs');

const TEAM_COLOR = {
  player: '#5a8ec5',
  enemy:  '#c97050',
  enemy2: '#7a8ec0',
};
function teamFill(t) { return TEAM_COLOR[t] || '#888888'; }

function render(dump) {
  const W = dump.worldExtent || 384;
  const SCALE = 2; // 2 px per metre → 768×768 image
  const W_PX = W * SCALE;
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W_PX} ${W_PX}" style="background:#1a2228;font-family:monospace;font-size:8px">`);

  // Buildings.
  for (const b of (dump.buildings || [])) {
    const x = b.ox * SCALE;
    const z = b.oz * SCALE;
    const w = b.cellsW * SCALE;
    const h = b.cellsD * SCALE;
    const fill = teamFill(b.team);
    const dashed = b.hp < b.maxHp ? ` stroke-dasharray="3,2"` : '';
    lines.push(`<rect x="${x}" y="${z}" width="${w}" height="${h}" fill="${fill}" fill-opacity="0.35" stroke="${fill}"${dashed}/>`);
    if (b.kind === 'hq') {
      lines.push(`<text x="${x + w/2}" y="${z + h/2 + 3}" text-anchor="middle" fill="white">HQ</text>`);
    }
  }

  // Clusters.
  for (const c of (dump.clusters || [])) {
    const cx = c.x * SCALE, cz = c.z * SCALE;
    const r = (c.rxz + 2) * SCALE;
    const fillOp = c.occupied / Math.max(1, c.maxWorkers);
    lines.push(`<circle cx="${cx}" cy="${cz}" r="${r}" fill="#d4af37" fill-opacity="${0.2 + fillOp * 0.6}" stroke="#d4af37"/>`);
    lines.push(`<text x="${cx}" y="${cz + 3}" text-anchor="middle" fill="black">${c.occupied}/${c.maxWorkers}</text>`);
  }

  // Unit paths first (so circles render on top).
  for (const u of (dump.units || [])) {
    if (!u.path || u.path.length === 0) continue;
    const stroke = teamFill(u.team);
    const pts = [`${u.x * SCALE},${u.z * SCALE}`];
    for (const w of u.path) pts.push(`${w.x * SCALE},${w.z * SCALE}`);
    lines.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-opacity="0.5" stroke-width="0.5"/>`);
  }

  // Units.
  for (const u of (dump.units || [])) {
    const cx = u.x * SCALE, cz = u.z * SCALE;
    const fill = teamFill(u.team);
    const isCombat = ['soldier','sniper','gunner','mortar_soldier','rocket_soldier','tank','aa_vehicle','rocket_truck','tunneler','worm'].includes(u.kind);
    const r = u.kind === 'worker' ? 1.4 : isCombat ? 2.0 : u.kind === 'supply_truck' ? 2.6 : 1.6;
    lines.push(`<circle cx="${cx}" cy="${cz}" r="${r * SCALE * 0.5}" fill="${fill}" stroke="white" stroke-width="0.3"/>`);
    if (u.task && u.task !== 'idle') {
      lines.push(`<text x="${cx}" y="${cz - r * SCALE * 0.5 - 1}" text-anchor="middle" fill="white" font-size="6">${u.task}</text>`);
    }
  }

  // Title strip.
  lines.push(`<rect x="0" y="0" width="${W_PX}" height="14" fill="black" fill-opacity="0.5"/>`);
  const head = `iter ${process.env.AUTO_ITER || '?'} score=${dump.score} units=${(dump.units||[]).length} bldgs=${(dump.buildings||[]).length} clusters=${(dump.clusters||[]).length}`;
  lines.push(`<text x="4" y="10" fill="white">${head}</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}

if (require.main === module) {
  const inPath = process.argv[2] || `/tmp/auto-dump-${process.env.AUTO_ITER || '?'}.json`;
  const outPath = process.argv[3] || inPath.replace(/\.json$/, '.svg');
  if (!fs.existsSync(inPath)) { console.error('no dump at', inPath); process.exit(1); }
  const dump = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  fs.writeFileSync(outPath, render(dump));
  console.log('svg written:', outPath);
}

module.exports = { render };
