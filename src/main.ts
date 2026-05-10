import { Game } from './app/Game';
import { runLobby } from './app/Lobby';
import { GameClient } from './net/GameClient';
import { WorldChunkClient } from './net/WorldChunkClient';
import { verifyServerWorldParity } from './net/verifyServerParity';
import { streamWorldFromServer } from './net/streamWorldFromServer';

async function boot(): Promise<void> {
  const appEl = document.getElementById('app')!;
  const progressEl = document.getElementById('progress')!;

  // Lobby first, before any heavy world / WebGL setup. Once the host
  // hits Start the lobby resolves and we proceed with worldgen. The
  // returned seed is shared across all clients so every player
  // generates the same map.
  let outcome;
  try {
    outcome = await runLobby();
  } catch (err: unknown) {
    progressEl.textContent = `Lobby error: ${(err as Error).message}`;
    return;
  }

  // Now spin up the actual game. The canvas / renderer aren't created
  // until this point so a failed lobby doesn't waste a WebGL context.
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  appEl.appendChild(canvas);

  const statsEl = document.getElementById('stats');
  const game = new Game(canvas, statsEl);
  // Lobby decides how many AI bases get seeded; default 1 if the
  // lobby was skipped (e.g. legacy direct-start path).
  game.numAi = Math.max(0, outcome.settings.aiCount | 0);
  (window as unknown as Record<string, unknown>).__game = game;

  if (!(globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    progressEl.textContent = 'Note: not cross-origin-isolated (SharedArrayBuffer disabled). Falling back to ArrayBuffer.';
    await new Promise(r => setTimeout(r, 400));
  }

  progressEl.classList.remove('hidden');
  // Phase 6d: ?streamWorld=1 swaps the local worldgen pipeline for
  // a server-driven chunk stream. Default is still local generation
  // (faster on first load, no server round-trips).
  const params = new URLSearchParams(location.search);
  const streamWorld = params.get('streamWorld') === '1';
  if (streamWorld) {
    progressEl.textContent = 'Streaming world from server…';
    const worldClient = new WorldChunkClient();
    await game.generate(
      outcome.worldSeed,
      (done, total) => {
        const pct = ((done / total) * 100).toFixed(0);
        progressEl.textContent = `Streaming world… ${pct}%`;
      },
      (world, seed, onProgress) => streamWorldFromServer(world, seed, worldClient, onProgress),
    );
  } else {
    progressEl.textContent = 'Generating world (parallel pillar fill + caves)…';
    await game.generate(outcome.worldSeed, (done, total) => {
      const pct = ((done / total) * 100).toFixed(0);
      progressEl.textContent = `Generating world… ${pct}%`;
    });
  }
  progressEl.textContent = 'Waiting for other players to finish loading…';

  // Connect to the authoritative game-server. Phase 2: every spawned
  // unit is mirrored into the server's entity table and the server's
  // path-walking is the source of truth for positions. The local sim
  // still runs (visual prediction + collision avoidance), but a
  // teleport-cheat client gets snapped back when drift exceeds 2 m.
  const gameClient = new GameClient({ playerId: outcome.selfPlayerId });
  gameClient.connect();
  // Phase 6c-2: tell the server which seed we generated against so
  // its chunk cache produces matching baselines. Idempotent on retry,
  // and the server rejects mid-game seed flips so a malicious client
  // can't desync everyone.
  gameClient.send({ type: 'set_world_seed', seed: outcome.worldSeed });
  game.attachAuthoritativeServer(gameClient);
  (window as unknown as Record<string, unknown>).__gameClient = gameClient;

  // Phase 6c-6: optional sanity check that the server's
  // post-worldgen chunk output matches what the browser generated.
  // Triggered with `?verifyWorld=1` in the URL — kept off by default
  // so a normal join doesn't pay the extra round-trips. Wait briefly
  // so the server has time to apply set_world_seed before we sample.
  // Skipped under ?streamWorld=1 because the chunks themselves came
  // from the same source we'd be checking against.
  if (params.get('verifyWorld') === '1' && !streamWorld) {
    void (async () => {
      await new Promise(r => setTimeout(r, 250));
      const worldClient = new WorldChunkClient();
      await verifyServerWorldParity(game.world, worldClient, outcome.worldSeed);
    })();
  }

  game.start();           // animation/render loop runs immediately…
  await outcome.markLoaded(); // …but tick() stays paused until everyone is loaded.
  game.paused = false;
  progressEl.classList.add('hidden');
}

boot().catch((err: unknown) => {
  console.error(err);
  const p = document.getElementById('progress');
  if (p) p.textContent = 'Boot failed — see console.';
});
