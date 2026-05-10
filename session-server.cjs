// Session / lobby server for voxel-rts.
//
// First-load flow:
//   1. Browser POSTs /lobby/sessions to create a new session. Response
//      carries sessionId + hostToken; the host shares the URL
//      `?session=<id>` so other players can join.
//   2. Joining clients POST /lobby/sessions/:id/join with a player
//      name, get a playerId + playerToken, and start polling
//      GET /lobby/sessions/:id every second.
//   3. Players toggle ready via POST .../ready. Host can change
//      settings (aiCount, teamCount, player→team mapping) and finally
//      hit Start once everyone is ready.
//   4. Phase flips: lobby → loading. Each client renders the world
//      then POSTs .../loaded. When every player is loaded we flip to
//      playing.
//
// HTTP-polling is good enough for lobby cadence (~1 s) — keeps the
// server dependency-free (no `ws` package) while still feeling live.

const http = require('http');

const PORT = process.env.LOBBY_PORT ? Number(process.env.LOBBY_PORT) : 3040;

const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 4;       // 4h: ample for a long match
const SESSION_REAP_INTERVAL_MS = 1000 * 60 * 5;  // sweep every 5min

function makeId(n = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function newSession() {
  const id = makeId();
  const hostToken = makeToken();
  const s = {
    id,
    hostToken,
    phase: 'lobby',                    // lobby | loading | playing
    settings: { aiCount: 1, teamCount: 2 }, // host-tunable
    players: [],                       // [{id, name, team, ready, loaded, token}]
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.set(id, s);
  return s;
}

function sanitize(s) {
  // Strip secrets (tokens) before sending to clients.
  return {
    id: s.id,
    phase: s.phase,
    settings: s.settings,
    players: s.players.map(p => ({
      id: p.id, name: p.name, team: p.team,
      ready: p.ready, loaded: p.loaded,
      isHost: p.isHost,
    })),
    updatedAt: s.updatedAt,
  };
}

function touch(s) { s.updatedAt = Date.now(); }

function findPlayer(s, playerId, token) {
  const p = s.players.find(x => x.id === playerId);
  if (!p) return null;
  if (token !== p.token) return null;
  return p;
}

function isHost(s, token) { return token === s.hostToken; }

function maybeAdvanceLoading(s) {
  if (s.phase !== 'loading') return;
  // Wait until every human player has loaded. AI-only "players" don't
  // exist as records; they're just a count in settings.
  if (s.players.length === 0) return;
  if (s.players.every(p => p.loaded)) {
    s.phase = 'playing';
    touch(s);
  }
}

// ---- routes -----------------------------------------------------------------

function handleCreate(req, res) {
  const s = newSession();
  // Auto-join the creator as the host. They'll specify a name on first
  // poll (PATCH /players/:id) — for now we placeholder.
  const player = {
    id: makeId(4), name: 'Host', team: 1,
    ready: false, loaded: false, token: makeToken(), isHost: true,
  };
  s.players.push(player);
  touch(s);
  json(res, 200, {
    sessionId: s.id,
    hostToken: s.hostToken,
    playerId: player.id,
    playerToken: player.token,
    state: sanitize(s),
  });
}

function handleGet(req, res, id) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: 'session not found' });
  json(res, 200, sanitize(s));
}

function handleJoin(req, res, id, body) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: 'session not found' });
  if (s.phase !== 'lobby') return json(res, 409, { error: 'session already started' });
  const name = (body && typeof body.name === 'string' && body.name.trim())
    ? body.name.trim().slice(0, 24)
    : `Player ${s.players.length + 1}`;
  const team = pickTeamFor(s, body && body.team);
  const player = {
    id: makeId(4), name, team,
    ready: false, loaded: false, token: makeToken(), isHost: false,
  };
  s.players.push(player);
  touch(s);
  json(res, 200, {
    playerId: player.id, playerToken: player.token,
    state: sanitize(s),
  });
}

function pickTeamFor(s, requested) {
  const teams = Math.max(2, Math.min(4, s.settings.teamCount | 0 || 2));
  if (typeof requested === 'number' && requested >= 1 && requested <= teams) return requested | 0;
  // Round-robin assignment so teams stay balanced by default.
  return ((s.players.length) % teams) + 1;
}

function handlePatchPlayer(req, res, id, pid, body) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: 'session not found' });
  const p = findPlayer(s, pid, body && body.playerToken);
  if (!p) return json(res, 403, { error: 'bad token' });
  if (typeof body.name === 'string') p.name = body.name.trim().slice(0, 24) || p.name;
  if (typeof body.team === 'number' && body.team >= 1 && body.team <= 4) p.team = body.team | 0;
  if (typeof body.ready === 'boolean' && s.phase === 'lobby') p.ready = body.ready;
  if (typeof body.loaded === 'boolean' && s.phase === 'loading') {
    p.loaded = body.loaded;
    maybeAdvanceLoading(s);
  }
  touch(s);
  json(res, 200, sanitize(s));
}

function handlePatchSettings(req, res, id, body) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: 'session not found' });
  if (!isHost(s, body && body.hostToken)) return json(res, 403, { error: 'host only' });
  if (s.phase !== 'lobby') return json(res, 409, { error: 'cannot change settings after start' });
  if (typeof body.aiCount === 'number') s.settings.aiCount = Math.max(0, Math.min(7, body.aiCount | 0));
  if (typeof body.teamCount === 'number') {
    s.settings.teamCount = Math.max(2, Math.min(4, body.teamCount | 0));
    // Clamp existing player team values to the new max.
    for (const p of s.players) {
      if (p.team > s.settings.teamCount) p.team = s.settings.teamCount;
    }
  }
  touch(s);
  json(res, 200, sanitize(s));
}

function handleStart(req, res, id, body) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: 'session not found' });
  if (!isHost(s, body && body.hostToken)) return json(res, 403, { error: 'host only' });
  if (s.phase !== 'lobby') return json(res, 409, { error: 'already started' });
  if (s.players.length === 0) return json(res, 409, { error: 'no players' });
  if (!s.players.every(p => p.ready)) return json(res, 409, { error: 'players not ready' });
  s.phase = 'loading';
  // Snapshot world seed so every client generates the same map. Random
  // 31-bit number — small enough to round-trip cleanly through any
  // worldgen seed slot.
  s.worldSeed = Math.floor(Math.random() * 0x7FFFFFFF);
  touch(s);
  json(res, 200, sanitize(s));
}

// ---- helpers ----------------------------------------------------------------

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const ROUTES = [
  { method: 'POST', re: /^\/lobby\/sessions$/,                                 fn: (req, res, _m, b) => handleCreate(req, res, b) },
  { method: 'GET',  re: /^\/lobby\/sessions\/([A-Z0-9]+)$/,                    fn: (req, res, m)    => handleGet(req, res, m[1]) },
  { method: 'POST', re: /^\/lobby\/sessions\/([A-Z0-9]+)\/join$/,              fn: (req, res, m, b) => handleJoin(req, res, m[1], b) },
  { method: 'POST', re: /^\/lobby\/sessions\/([A-Z0-9]+)\/players\/([A-Z0-9]+)$/, fn: (req, res, m, b) => handlePatchPlayer(req, res, m[1], m[2], b) },
  { method: 'POST', re: /^\/lobby\/sessions\/([A-Z0-9]+)\/settings$/,          fn: (req, res, m, b) => handlePatchSettings(req, res, m[1], b) },
  { method: 'POST', re: /^\/lobby\/sessions\/([A-Z0-9]+)\/start$/,             fn: (req, res, m, b) => handleStart(req, res, m[1], b) },
  { method: 'GET',  re: /^\/health$/,                                           fn: (req, res)       => json(res, 200, { ok: true, sessions: sessions.size }) },
];

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  for (const r of ROUTES) {
    if (req.method !== r.method) continue;
    const m = (req.url || '').match(r.re);
    if (!m) continue;
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { error: 'bad json' }); }
    }
    try { return r.fn(req, res, m, body); }
    catch (e) { return json(res, 500, { error: String(e) }); }
  }
  res.writeHead(404); res.end();
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, SESSION_REAP_INTERVAL_MS).unref();

server.listen(PORT, () => process.stderr.write(`session-server listening on :${PORT}\n`));

module.exports = { newSession, sanitize, sessions };
