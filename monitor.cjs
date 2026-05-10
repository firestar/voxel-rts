/**
 * Monitor: captures all TRUCK, DISPATCH, PATH, SUPPLY, REBUILD logs
 * and also reads truck state directly from the game's unit array every 5s.
 */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const logs = [];

  page.on('console', msg => {
    const text = msg.text();
    if (/TRUCK|DISPATCH|PATH|SUPPLY|REBUILD|DELIVER|PICKUP|RETURN|RESUPPLY|RESOURCES/i.test(text)) {
      const ts = (Date.now() / 1000).toFixed(2);
      const line = `[${ts}] ${msg.type().toUpperCase()}: ${text}`;
      logs.push(line);
      process.stdout.write(line + '\n');
    }
  });

  page.on('pageerror', err => process.stdout.write(`[PAGE ERROR] ${err.message}\n`));

  console.log('Opening http://localhost:5174 ...');
  try {
    await page.goto('http://localhost:5174', { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    console.log('goto note:', e.message);
  }
  console.log('Monitoring for 120 seconds...\n');

  // Poll truck state directly every 5 seconds
  const pollInterval = setInterval(async () => {
    try {
      const state = await page.evaluate(() => {
        const g = window._game;
        if (!g) return null;
        const trucks = g.units?.units
          ?.filter(u => u.kind === 'supply_truck' && u.hp > 0)
          .map(u => ({
            id: u.id,
            task: u.task?.kind,
            path: u.path?.length ?? 0,
            x: Math.round(u.x * 10) / 10,
            z: Math.round(u.z * 10) / 10,
            hp: u.hp,
          })) ?? [];
        const resources = g.resources ?? {};
        return { trucks, metals: resources.metals, wood: resources.wood, food: resources.food };
      });
      if (state) {
        const ts = (Date.now() / 1000).toFixed(2);
        process.stdout.write(
          `[${ts}] POLL: metals=${state.metals} wood=${state.wood} food=${state.food} trucks=[${
            state.trucks.map(t => `#${t.id}:${t.task}:path${t.path}@(${t.x},${t.z})`).join(', ')
          }]\n`
        );
      }
    } catch (_) {}
  }, 5000);

  await new Promise(r => setTimeout(r, 120000));
  clearInterval(pollInterval);

  console.log('\n=== SUMMARY ===');
  const fails = logs.filter(l => /PATH.FAIL/i.test(l));
  const oks   = logs.filter(l => /PATH.OK/i.test(l));
  const dispatches = logs.filter(l => /DISPATCH/i.test(l));
  console.log(`Dispatches: ${dispatches.length}  PathOK: ${oks.length}  PathFail: ${fails.length}`);
  if (fails.length > 0) {
    console.log('\nFirst 5 PATH FAIL lines:');
    fails.slice(0, 5).forEach(l => console.log(' ', l));
  }

  await browser.close();
})();
