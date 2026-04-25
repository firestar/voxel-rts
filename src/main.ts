import { Game } from './app/Game';

async function boot(): Promise<void> {
  const appEl = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  appEl.appendChild(canvas);

  const statsEl = document.getElementById('stats');
  const progressEl = document.getElementById('progress')!;

  const game = new Game(canvas, statsEl);

  if (!(globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    progressEl.textContent = 'Note: not cross-origin-isolated (SharedArrayBuffer disabled). Falling back to ArrayBuffer.';
    await new Promise(r => setTimeout(r, 400));
  }

  progressEl.textContent = 'Generating world (parallel pillar fill + caves)…';
  await game.generate(1337, (done, total) => {
    const pct = ((done / total) * 100).toFixed(0);
    progressEl.textContent = `Generating world… ${pct}%`;
  });
  progressEl.classList.add('hidden');

  game.start();
}

boot().catch((err: unknown) => {
  console.error(err);
  const p = document.getElementById('progress');
  if (p) p.textContent = 'Boot failed — see console.';
});
