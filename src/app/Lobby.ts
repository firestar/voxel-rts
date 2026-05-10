// Lobby UI for the session/multiplayer landing page. Shown on first
// load before the game starts; talks to `session-server.cjs` over
// HTTP polling.
//
// Public API: `runLobby({ lobbyServerUrl }): Promise<LobbyOutcome>` —
// resolves once the lobby flips to the `playing` phase. The caller
// uses `outcome.worldSeed` to deterministically seed worldgen and
// `outcome.markLoaded()` to tell the server "I've finished rendering"
// once the world is on screen.
//
// The overlay is a single fixed-position div injected into the body;
// it self-removes when the lobby finishes.

const POLL_INTERVAL_MS = 1000;
/** Same-origin base. In dev the vite proxy forwards /lobby → :3040; in
 *  production the nginx in the container does the same. */
const DEFAULT_LOBBY_URL = '';

export type LobbyPhase = 'lobby' | 'loading' | 'playing';

export interface SessionPlayer {
  id: string;
  name: string;
  team: number;
  ready: boolean;
  loaded: boolean;
  isHost: boolean;
}

export interface SessionState {
  id: string;
  phase: LobbyPhase;
  settings: { aiCount: number; teamCount: number };
  players: SessionPlayer[];
  worldSeed?: number;
  updatedAt: number;
}

export interface LobbyOutcome {
  sessionId: string;
  worldSeed: number;
  settings: SessionState['settings'];
  selfPlayerId: string;
  selfPlayerToken: string;
  /** Tell the server we've finished generating + rendering the world. */
  markLoaded: () => Promise<void>;
}

interface LobbyOpts {
  lobbyServerUrl?: string;
}

export async function runLobby(opts: LobbyOpts = {}): Promise<LobbyOutcome> {
  const base = opts.lobbyServerUrl ?? DEFAULT_LOBBY_URL;
  const overlay = mountOverlay();
  const url = new URL(window.location.href);
  const initialSessionId = url.searchParams.get('session') || '';

  type Creds = { sessionId: string; playerId: string; playerToken: string; hostToken?: string };
  let creds: Creds | null = null;

  if (initialSessionId) {
    overlay.show(renderJoin(initialSessionId, async (name) => {
      try {
        const r = await postJSON(`${base}/lobby/sessions/${initialSessionId}/join`, { name }) as { playerId: string; playerToken: string };
        creds = { sessionId: initialSessionId, playerId: r.playerId, playerToken: r.playerToken };
      } catch (e) {
        overlay.flash(`Could not join: ${(e as Error).message}`);
      }
    }));
  } else {
    overlay.show(renderHomepage(async (name) => {
      try {
        const r = await postJSON(`${base}/lobby/sessions`, {}) as {
          sessionId: string; hostToken: string;
          playerId: string; playerToken: string;
        };
        // The host is auto-created with name 'Host' on the server;
        // overwrite with whatever the user typed before polling kicks in.
        creds = {
          sessionId: r.sessionId, playerId: r.playerId,
          playerToken: r.playerToken, hostToken: r.hostToken,
        };
        await postJSON(`${base}/lobby/sessions/${r.sessionId}/players/${r.playerId}`, {
          playerToken: r.playerToken, name,
        });
        // Push ?session=ID so the URL is shareable.
        const u = new URL(window.location.href);
        u.searchParams.set('session', r.sessionId);
        history.replaceState(null, '', u.toString());
      } catch (e) {
        overlay.flash(`Could not create session: ${(e as Error).message}`);
      }
    }));
  }

  // Wait for creds (user finished entering their name).
  while (!creds) await sleep(POLL_INTERVAL_MS / 4);
  const me: Creds = creds; // capture so the closures get a non-nullable ref

  // Poll loop: pull state, render room, handle phase transitions.
  let markedLoaded = false;
  while (true) {
    let state: SessionState;
    try {
      state = await getJSON(`${base}/lobby/sessions/${me.sessionId}`) as SessionState;
    } catch (e) {
      overlay.flash(`Lobby connection lost: ${(e as Error).message}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (state.phase === 'lobby') {
      overlay.show(renderRoom(state, me, base, overlay));
    } else if (state.phase === 'loading') {
      overlay.show(renderLoading(state, me.playerId));
      // Resolve so main.ts can begin world generation. The caller
      // will call markLoaded() once it's done; we keep polling
      // inside markLoaded so the overlay stays accurate until
      // playing.
      const seed = state.worldSeed ?? 1337;
      return {
        sessionId: me.sessionId,
        worldSeed: seed,
        settings: state.settings,
        selfPlayerId: me.playerId,
        selfPlayerToken: me.playerToken,
        markLoaded: async () => {
          if (markedLoaded) return;
          markedLoaded = true;
          await postJSON(`${base}/lobby/sessions/${me.sessionId}/players/${me.playerId}`, {
            playerToken: me.playerToken, loaded: true,
          });
          // Spin until the server flips to playing.
          while (true) {
            await sleep(POLL_INTERVAL_MS);
            let s: SessionState;
            try { s = await getJSON(`${base}/lobby/sessions/${me.sessionId}`) as SessionState; }
            catch { continue; }
            overlay.show(renderLoading(s, me.playerId));
            if (s.phase === 'playing') {
              overlay.unmount();
              return;
            }
          }
        },
      };
    } else if (state.phase === 'playing') {
      // Joined late, no loading required.
      overlay.unmount();
      return {
        sessionId: me.sessionId,
        worldSeed: state.worldSeed ?? 1337,
        settings: state.settings,
        selfPlayerId: me.playerId,
        selfPlayerToken: me.playerToken,
        markLoaded: async () => undefined,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------- DOM helpers -----------------------------------------------------

interface OverlayHandle {
  show: (node: HTMLElement) => void;
  flash: (msg: string) => void;
  unmount: () => void;
}

function mountOverlay(): OverlayHandle {
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(8, 14, 22, 0.95);
    color: #d6d2c0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    z-index: 9999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 24px;
    overflow: auto;
  `;
  const slot = document.createElement('div');
  slot.style.cssText = 'max-width: 640px; width: 100%;';
  const flashEl = document.createElement('div');
  flashEl.style.cssText = `
    position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
    background: rgba(120, 30, 30, 0.9); padding: 8px 12px; border-radius: 4px;
    font-size: 14px; opacity: 0; transition: opacity 0.3s;
    pointer-events: none;
  `;
  root.appendChild(slot);
  root.appendChild(flashEl);
  document.body.appendChild(root);
  let flashTimer: number | undefined;
  return {
    show: (node) => {
      slot.replaceChildren(node);
    },
    flash: (msg) => {
      flashEl.textContent = msg;
      flashEl.style.opacity = '1';
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => { flashEl.style.opacity = '0'; }, 3000);
    },
    unmount: () => { root.remove(); },
  };
}

function renderHomepage(onCreate: (name: string) => Promise<void>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h1 style="margin:0 0 4px 0; font-size: 32px; letter-spacing: 1px;">Voxel RTS</h1>
    <div style="opacity: 0.7; margin-bottom: 24px;">Create a session and share the link with your opponents.</div>
    <label style="display:block; margin-bottom: 8px;">Your name</label>
    <input id="lobby-name" value="Host" style="width:100%; padding:10px; border-radius:4px; border:1px solid #2a3a48; background:#1a2330; color:#d6d2c0; font-size:14px;" />
    <button id="lobby-create" style="margin-top:16px; width:100%; padding:12px; border-radius:4px; border:0; background:#2c5d8b; color:#fff; font-size:14px; font-weight:600; cursor:pointer;">Create session</button>
  `;
  const nameInput = wrap.querySelector<HTMLInputElement>('#lobby-name')!;
  const btn = wrap.querySelector<HTMLButtonElement>('#lobby-create')!;
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Creating…';
    await onCreate(nameInput.value || 'Host');
  });
  return wrap;
}

function renderJoin(sessionId: string, onJoin: (name: string) => Promise<void>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h1 style="margin:0 0 4px 0; font-size: 28px;">Joining session ${sessionId}</h1>
    <div style="opacity: 0.7; margin-bottom: 24px;">Enter a display name to join the lobby.</div>
    <label style="display:block; margin-bottom: 8px;">Your name</label>
    <input id="lobby-name" placeholder="Player" style="width:100%; padding:10px; border-radius:4px; border:1px solid #2a3a48; background:#1a2330; color:#d6d2c0; font-size:14px;" />
    <button id="lobby-join" style="margin-top:16px; width:100%; padding:12px; border-radius:4px; border:0; background:#2c5d8b; color:#fff; font-size:14px; font-weight:600; cursor:pointer;">Join</button>
  `;
  const nameInput = wrap.querySelector<HTMLInputElement>('#lobby-name')!;
  const btn = wrap.querySelector<HTMLButtonElement>('#lobby-join')!;
  nameInput.focus();
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Joining…';
    await onJoin(nameInput.value || 'Player');
  });
  return wrap;
}

function renderRoom(
  state: SessionState,
  creds: { sessionId: string; playerId: string; playerToken: string; hostToken?: string },
  base: string,
  overlay: OverlayHandle,
): HTMLElement {
  const me = state.players.find(p => p.id === creds.playerId);
  const isHost = !!creds.hostToken && !!me?.isHost;
  const allReady = state.players.length > 0 && state.players.every(p => p.ready);

  const wrap = document.createElement('div');
  const inviteUrl = `${window.location.origin}${window.location.pathname}?session=${state.id}`;
  wrap.innerHTML = `
    <div style="display:flex; align-items:baseline; gap:12px; margin-bottom: 8px;">
      <h1 style="margin:0; font-size: 24px;">Lobby ${state.id}</h1>
      <div style="opacity:0.6; font-size: 12px;">${state.players.length} player(s)</div>
    </div>
    <div style="background:#162028; padding:10px 12px; border-radius:4px; margin-bottom:20px; display:flex; align-items:center; gap:8px;">
      <span style="opacity:0.7; font-size:13px;">Invite link</span>
      <input readonly value="${inviteUrl}" style="flex:1; padding:6px 8px; background:#0c1218; color:#d6d2c0; border:1px solid #2a3a48; border-radius:3px; font-size:12px;" />
      <button id="lobby-copy" style="padding:6px 10px; border:0; border-radius:3px; background:#2a3a48; color:#fff; cursor:pointer; font-size:12px;">Copy</button>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom: 20px;">
      <div>
        <div style="font-size:12px; opacity:0.7; margin-bottom:6px;">AI opponents</div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="ai-step" data-delta="-1" ${isHost ? '' : 'disabled'}>−</button>
          <span id="ai-count" style="display:inline-block; min-width:24px; text-align:center; font-weight:600;">${state.settings.aiCount}</span>
          <button class="ai-step" data-delta="1" ${isHost ? '' : 'disabled'}>+</button>
        </div>
      </div>
      <div>
        <div style="font-size:12px; opacity:0.7; margin-bottom:6px;">Teams</div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="team-step" data-delta="-1" ${isHost ? '' : 'disabled'}>−</button>
          <span id="team-count" style="display:inline-block; min-width:24px; text-align:center; font-weight:600;">${state.settings.teamCount}</span>
          <button class="team-step" data-delta="1" ${isHost ? '' : 'disabled'}>+</button>
        </div>
      </div>
    </div>

    <div style="font-size:12px; opacity:0.7; margin-bottom:6px;">Players</div>
    <div id="player-list" style="display:flex; flex-direction:column; gap:6px; margin-bottom: 24px;"></div>

    <div style="display:flex; gap:8px;">
      <button id="ready-btn" style="flex:1; padding:12px; border:0; border-radius:4px; background:${me?.ready ? '#3a8a3a' : '#2c5d8b'}; color:#fff; font-weight:600; cursor:pointer;">${me?.ready ? '✓ Ready' : 'I’m Ready'}</button>
      ${isHost ? `<button id="start-btn" style="flex:1; padding:12px; border:0; border-radius:4px; background:${allReady ? '#a85432' : '#3a3a3a'}; color:#fff; font-weight:600; cursor:${allReady ? 'pointer' : 'not-allowed'};" ${allReady ? '' : 'disabled'}>Start Game</button>` : ''}
    </div>
  `;
  const listEl = wrap.querySelector<HTMLDivElement>('#player-list')!;
  for (const p of state.players) {
    const row = document.createElement('div');
    row.style.cssText = `
      display:flex; align-items:center; gap:8px;
      padding:8px 10px; background:#162028; border-radius:4px;
    `;
    const teamColor = ['#5a8ec5', '#c97050', '#7ab87a', '#b878c0'][p.team - 1] || '#888';
    row.innerHTML = `
      <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${teamColor};"></span>
      <span style="flex:1;">${p.name}${p.isHost ? ' <span style="font-size:10px; opacity:0.6;">(host)</span>' : ''}${p.id === creds.playerId ? ' <span style="font-size:10px; opacity:0.6;">(you)</span>' : ''}</span>
      <span style="font-size:11px; opacity:0.7;">team ${p.team}</span>
      <span style="font-size:11px; padding:2px 6px; border-radius:3px; background:${p.ready ? '#3a8a3a' : '#3a3a3a'};">${p.ready ? 'ready' : 'not ready'}</span>
    `;
    listEl.appendChild(row);
  }

  // Handlers.
  wrap.querySelector<HTMLButtonElement>('#lobby-copy')!.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteUrl); overlay.flash('Link copied'); }
    catch { overlay.flash('Copy blocked — select and copy manually'); }
  });
  for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.ai-step')) {
    btn.addEventListener('click', async () => {
      const delta = Number(btn.dataset.delta || '0');
      await postJSON(`${base}/lobby/sessions/${state.id}/settings`, {
        hostToken: creds.hostToken, aiCount: state.settings.aiCount + delta,
      }).catch(e => overlay.flash(String((e as Error).message)));
    });
  }
  for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.team-step')) {
    btn.addEventListener('click', async () => {
      const delta = Number(btn.dataset.delta || '0');
      await postJSON(`${base}/lobby/sessions/${state.id}/settings`, {
        hostToken: creds.hostToken, teamCount: state.settings.teamCount + delta,
      }).catch(e => overlay.flash(String((e as Error).message)));
    });
  }
  wrap.querySelector<HTMLButtonElement>('#ready-btn')!.addEventListener('click', async () => {
    await postJSON(`${base}/lobby/sessions/${state.id}/players/${creds.playerId}`, {
      playerToken: creds.playerToken, ready: !me?.ready,
    }).catch(e => overlay.flash(String((e as Error).message)));
  });
  if (isHost) {
    wrap.querySelector<HTMLButtonElement>('#start-btn')!.addEventListener('click', async () => {
      await postJSON(`${base}/lobby/sessions/${state.id}/start`, {
        hostToken: creds.hostToken,
      }).catch(e => overlay.flash(String((e as Error).message)));
    });
  }
  return wrap;
}

function renderLoading(state: SessionState, selfId: string): HTMLElement {
  const wrap = document.createElement('div');
  const loaded = state.players.filter(p => p.loaded).length;
  const total = state.players.length;
  wrap.innerHTML = `
    <h1 style="margin:0 0 8px 0; font-size: 24px;">Loading…</h1>
    <div style="opacity:0.7; margin-bottom: 24px;">Generating world. Game starts when every player has finished loading.</div>
    <div style="display:flex; flex-direction:column; gap:6px;">
      ${state.players.map(p => `
        <div style="display:flex; align-items:center; gap:8px; padding:8px 10px; background:#162028; border-radius:4px;">
          <span style="flex:1;">${p.name}${p.id === selfId ? ' <span style="font-size:10px; opacity:0.6;">(you)</span>' : ''}</span>
          <span style="font-size:11px; padding:2px 6px; border-radius:3px; background:${p.loaded ? '#3a8a3a' : '#3a3a3a'};">${p.loaded ? 'loaded' : 'loading'}</span>
        </div>`).join('')}
    </div>
    <div style="margin-top:16px; opacity:0.6; font-size:12px;">${loaded} / ${total} ready</div>
  `;
  return wrap;
}

// ---------- network helpers -------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function getJSON(url: string): Promise<unknown> {
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function postJSON(url: string, body: unknown): Promise<{ [k: string]: unknown } & Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as Record<string, unknown>;
}
