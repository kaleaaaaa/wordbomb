'use strict';
/*
 * Word Bomb server (Node 18+, socket.io 4)
 *
 *   npm install
 *   node server.js
 *
 * On first start it downloads an English word list to ./words.txt (one word per
 * line). If your host has no outbound internet, drop your own words.txt next to
 * this file and it will be used instead.
 *
 * Env vars: PORT (3000), ORIGIN ("*" or a comma-separated list of allowed
 * page origins, e.g. https://mysite.com), WORDS_FILE, WORDS_URL.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = process.env.ORIGIN || '*';
const WORDS_FILE = process.env.WORDS_FILE || path.join(__dirname, 'words.txt');
const WORDS_URL =
  process.env.WORDS_URL ||
  'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

const CONFIG = {
  MAX_PLAYERS: 8,
  BOOM_MS: 2200, // pause after an explosion before the next bomb
  MIN_PASS_MS: 2500, // (unused now: every pass gets a full fresh fuse)
  FUSES: { fast: [4, 8], normal: [6, 12], slow: [10, 18] }, // seconds, random per turn (resets on every pass)
  // Using all of these letters across your words earns a life back (no Q, X, Z).
  BONUS_LETTERS: 'abcdefghijklmnoprstuvwy',
  MAX_LIVES: 5,
};
const DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'];

/* ------------------------------------------------------------------ */
/* Dictionary + prompt fragments                                       */
/* ------------------------------------------------------------------ */

function buildDictionary(text) {
  const words = new Set();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim().toLowerCase();
    if (w.length >= 3 && w.length <= 30 && /^[a-z]+$/.test(w)) words.add(w);
  }
  if (words.size === 0) throw new Error('word list is empty');

  // How many words contain each 2- and 3-letter fragment?
  const counts = new Map();
  for (const w of words) {
    const seen = new Set();
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= w.length; i++) seen.add(w.substr(i, n));
    }
    for (const f of seen) counts.set(f, (counts.get(f) || 0) + 1);
  }

  // Only use fragments that plenty of words contain, then split by how common
  // they are: the most common are "easy", the rarest "hard".
  // Big word lists are full of obscure words, so a rare fragment can still
  // appear in a few dozen of them and feel random. Require a fragment to show up
  // in at least ~0.04% of all words (about 150 words on a 370k list). Override
  // with the MIN_FRAG env var: higher = friendlier prompts, lower = weirder.
  const minCount = Number(process.env.MIN_FRAG) || Math.max(3, Math.floor(words.size / 2500));
  let frags = [...counts].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]);
  if (frags.length < 20) frags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 200); // tiny word lists
  const n = frags.length;
  const cut1 = Math.ceil(n * 0.3);
  const cut2 = Math.ceil(n * 0.7);
  const names = (arr) => arr.map((f) => f[0]);
  return {
    words,
    all: names(frags),
    tiers: {
      easy: names(frags.slice(0, cut1)),
      medium: names(frags.slice(cut1, cut2)),
      hard: names(frags.slice(cut2)),
    },
  };
}

function download(url, dest, redirects = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).href, dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const tmp = dest + '.tmp';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
        out.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function loadDictionary() {
  if (!fs.existsSync(WORDS_FILE)) {
    console.log('[wordbomb] downloading word list…');
    try {
      await download(WORDS_URL, WORDS_FILE);
    } catch (e) {
      throw new Error(
        'No word list at ' + WORDS_FILE + ' and the download failed (' + e.message + ').\n' +
        'Put a words.txt (one word per line) next to server.js and start again.'
      );
    }
  }
  const dict = buildDictionary(fs.readFileSync(WORDS_FILE, 'utf8'));
  console.log('[wordbomb] ' + dict.words.size + ' words, ' + dict.all.length + ' prompt fragments');
  return dict;
}

/* ------------------------------------------------------------------ */
/* Game logic (socket.io wiring lives in createGame)                   */
/* ------------------------------------------------------------------ */

function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || 'Player';
}

function createGame(io, dict) {
  const rooms = new Map(); // code -> room
  const roomOf = new Map(); // socket id -> room code
  const noop = () => {};
  const fn = (f) => (typeof f === 'function' ? f : noop);

  function makeCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let c;
    do {
      c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
    } while (rooms.has(c));
    return c;
  }

  function newRoom(code) {
    return {
      code,
      hostId: null,
      phase: 'lobby', // lobby | playing | boom | over
      settings: { lives: 3, fuse: 'normal', difficulty: 'mixed' },
      players: [],
      turn: -1,
      prompt: '',
      used: new Set(),
      recent: [],
      fuseTotal: 0,
      fuseEnd: 0,
      timer: null,
      nextTimer: null,
      solo: false,
      winnerId: null,
      seq: 0,
      lastEvent: null,
    };
  }

  const active = (room) => room.players.filter((p) => !p.left);
  const aliveCount = (room) => room.players.filter((p) => p.alive && !p.left).length;
  const isOver = (room) => (room.solo ? aliveCount(room) === 0 : aliveCount(room) <= 1);

  function event(room, e) {
    room.seq++;
    room.lastEvent = e;
  }

  function snapshot(room) {
    const holder = room.phase === 'playing' || room.phase === 'boom' ? room.players[room.turn] : null;
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      settings: room.settings,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        alive: p.alive,
        left: p.left,
        words: p.words,
        letters: [...p.letters].join(''),
      })),
      turnId: holder ? holder.id : null,
      prompt: room.phase === 'playing' || room.phase === 'boom' ? room.prompt : '',
      msLeft: room.phase === 'playing' ? Math.max(0, room.fuseEnd - Date.now()) : 0,
      fuseTotal: room.fuseTotal,
      winnerId: room.winnerId,
      solo: room.solo,
      usedCount: room.used.size,
      bonusLetters: CONFIG.BONUS_LETTERS,
      maxPlayers: CONFIG.MAX_PLAYERS,
      seq: room.seq,
      lastEvent: room.lastEvent,
    };
  }

  function broadcast(room) {
    io.to(room.code).emit('state', snapshot(room));
  }

  function nextAlive(room, from) {
    const n = room.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      const p = room.players[idx];
      if (p.alive && !p.left) return idx; // in solo play this comes back to the same player
    }
    return -1;
  }

  function pickPrompt(room) {
    let tier = room.settings.difficulty;
    if (tier === 'mixed') {
      const r = Math.random();
      tier = r < 0.4 ? 'easy' : r < 0.8 ? 'medium' : 'hard';
    }
    let pool = dict.tiers[tier];
    if (!pool || !pool.length) pool = dict.all;
    let f = pool[0];
    for (let i = 0; i < 25; i++) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      if (!room.recent.includes(c)) { f = c; break; }
    }
    room.recent.push(f);
    if (room.recent.length > 12) room.recent.shift();
    return f;
  }

  function armFuse(room, ms) {
    clearTimeout(room.timer);
    room.fuseEnd = Date.now() + ms;
    room.timer = setTimeout(() => explode(room), ms);
  }

  // Every turn gets a fresh random fuse, so the timer resets whenever the bomb is passed.
  function freshFuse(room) {
    const [lo, hi] = CONFIG.FUSES[room.settings.fuse] || CONFIG.FUSES.normal;
    room.fuseTotal = (lo + Math.random() * (hi - lo)) * 1000;
    armFuse(room, room.fuseTotal);
  }

  function startRound(room, idx) {
    room.phase = 'playing';
    room.turn = idx;
    room.prompt = pickPrompt(room);
    freshFuse(room);
    broadcast(room);
  }

  function passBomb(room, fromIdx) {
    room.turn = nextAlive(room, fromIdx);
    room.prompt = pickPrompt(room);
    freshFuse(room);
  }

  function explode(room) {
    if (room.phase !== 'playing') return;
    const idx = room.turn;
    const p = room.players[idx];
    p.lives = Math.max(0, p.lives - 1);
    if (p.lives === 0) p.alive = false;
    room.phase = 'boom';
    event(room, { type: 'boom', id: p.id, eliminated: !p.alive });
    broadcast(room);
    clearTimeout(room.nextTimer);
    room.nextTimer = setTimeout(() => {
      if (!rooms.has(room.code) || room.phase !== 'boom') return;
      if (isOver(room)) return finish(room);
      startRound(room, nextAlive(room, idx));
    }, CONFIG.BOOM_MS);
  }

  function finish(room) {
    clearTimeout(room.timer);
    clearTimeout(room.nextTimer);
    room.phase = 'over';
    const survivors = room.players.filter((p) => p.alive && !p.left);
    room.winnerId = !room.solo && survivors.length === 1 ? survivors[0].id : null;
    event(room, { type: 'over' });
    broadcast(room);
  }

  function resetPlayers(room) {
    room.players = room.players.filter((p) => !p.left);
    for (const p of room.players) {
      p.lives = room.settings.lives;
      p.alive = true;
      p.letters = new Set();
      p.words = 0;
    }
  }

  function startGame(room) {
    resetPlayers(room);
    if (!room.players.length) return;
    room.used = new Set();
    room.recent = [];
    room.winnerId = null;
    room.solo = room.players.length === 1;
    event(room, { type: 'start' });
    startRound(room, Math.floor(Math.random() * room.players.length));
  }

  function destroy(room) {
    clearTimeout(room.timer);
    clearTimeout(room.nextTimer);
    rooms.delete(room.code);
  }

  function addPlayer(room, socket, name) {
    let base = cleanName(name);
    let n = base;
    let i = 2;
    while (active(room).some((p) => p.name.toLowerCase() === n.toLowerCase())) {
      n = base.slice(0, 13) + ' ' + i++;
    }
    room.players.push({
      id: socket.id,
      name: n,
      lives: room.settings.lives,
      alive: room.phase !== 'over',
      letters: new Set(),
      words: 0,
      left: false,
    });
    if (!room.hostId) room.hostId = socket.id;
    socket.join(room.code);
    roomOf.set(socket.id, room.code);
  }

  function leave(socket) {
    const code = roomOf.get(socket.id);
    roomOf.delete(socket.id);
    const room = code && rooms.get(code);
    if (!room) return;
    socket.leave(code);
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return;
    const inGame = room.phase === 'playing' || room.phase === 'boom';

    if (inGame) {
      room.players[idx].left = true;
      room.players[idx].alive = false;
      room.players[idx].lives = 0;
    } else {
      room.players.splice(idx, 1);
    }

    if (active(room).length === 0) return destroy(room);
    if (room.hostId === socket.id) room.hostId = active(room)[0].id;

    if (room.phase === 'playing') {
      if (isOver(room)) return finish(room);
      if (idx === room.turn) passBomb(room, idx);
    }
    broadcast(room);
  }

  const roomFor = (socket) => rooms.get(roomOf.get(socket.id));
  const hostRoom = (socket) => {
    const r = roomFor(socket);
    return r && r.hostId === socket.id ? r : null;
  };

  io.on('connection', (socket) => {
    socket.on('room:create', (data, ack) => {
      const reply = fn(ack);
      leave(socket);
      const room = newRoom(makeCode());
      rooms.set(room.code, room);
      addPlayer(room, socket, data && data.name);
      reply({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('room:join', (data, ack) => {
      const reply = fn(ack);
      const code = String((data && data.code) || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return reply({ ok: false, reason: 'Room not found' });
      if (roomOf.get(socket.id) === code) return reply({ ok: true, code });
      if (room.phase === 'playing' || room.phase === 'boom') {
        return reply({ ok: false, reason: 'That game is already in progress' });
      }
      if (active(room).length >= CONFIG.MAX_PLAYERS) return reply({ ok: false, reason: 'Room is full' });
      leave(socket);
      addPlayer(room, socket, data && data.name);
      reply({ ok: true, code });
      broadcast(room);
    });

    socket.on('room:leave', () => leave(socket));
    socket.on('disconnect', () => leave(socket));

    socket.on('room:settings', (s) => {
      const room = hostRoom(socket);
      if (!room || room.phase !== 'lobby' || !s || typeof s !== 'object') return;
      const lives = Math.round(Number(s.lives));
      if (lives >= 1 && lives <= CONFIG.MAX_LIVES) room.settings.lives = lives;
      if (CONFIG.FUSES[s.fuse]) room.settings.fuse = s.fuse;
      if (DIFFICULTIES.includes(s.difficulty)) room.settings.difficulty = s.difficulty;
      for (const p of room.players) p.lives = room.settings.lives;
      broadcast(room);
    });

    socket.on('game:start', () => {
      const room = hostRoom(socket);
      if (!room || (room.phase !== 'lobby' && room.phase !== 'over')) return;
      startGame(room);
    });

    socket.on('game:lobby', () => {
      const room = hostRoom(socket);
      if (!room || room.phase !== 'over') return;
      room.phase = 'lobby';
      room.winnerId = null;
      room.prompt = '';
      resetPlayers(room);
      broadcast(room);
    });

    socket.on('typing', (text) => {
      const room = roomFor(socket);
      if (!room || room.phase !== 'playing') return;
      const p = room.players[room.turn];
      if (!p || p.id !== socket.id) return;
      const t = String(text == null ? '' : text).toLowerCase().replace(/[^a-z]/g, '').slice(0, 30);
      socket.to(room.code).emit('typing', { id: socket.id, text: t });
    });

    socket.on('word:submit', (raw, ack) => {
      const reply = fn(ack);
      const room = roomFor(socket);
      if (!room || room.phase !== 'playing') return reply({ ok: false, reason: 'No bomb right now' });
      const idx = room.turn;
      const p = room.players[idx];
      if (!p || p.id !== socket.id) return reply({ ok: false, reason: 'Not your turn' });

      const now = Date.now();
      if (now - (socket.data && socket.data.lastSubmit || 0) < 120) return reply({ ok: false, reason: 'Slow down' });
      if (socket.data) socket.data.lastSubmit = now;

      const w = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!/^[a-z]+$/.test(w) || w.length < 3) return reply({ ok: false, reason: 'Too short' });
      if (!w.includes(room.prompt)) return reply({ ok: false, reason: 'Must contain ' + room.prompt.toUpperCase() });
      if (!dict.words.has(w)) return reply({ ok: false, reason: 'Not in the dictionary' });
      if (room.used.has(w)) return reply({ ok: false, reason: 'Already used' });

      room.used.add(w);
      p.words++;
      let bonus = false;
      for (const ch of w) if (CONFIG.BONUS_LETTERS.includes(ch)) p.letters.add(ch);
      if (p.letters.size >= CONFIG.BONUS_LETTERS.length) {
        p.letters = new Set();
        if (p.lives < Math.max(CONFIG.MAX_LIVES, room.settings.lives)) {
          p.lives++;
          bonus = true;
        }
      }
      event(room, { type: 'word', id: p.id, word: w, bonus });
      passBomb(room, idx);
      reply({ ok: true });
      broadcast(room);
    });
  });

  return { rooms, snapshot };
}

/* ------------------------------------------------------------------ */

async function main() {
  const dict = await loadDictionary();
  const page = path.join(__dirname, 'wordbomb.html');
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    // Convenience: if wordbomb.html sits next to this file it is served at /
    if ((url === '/' || url === '/wordbomb.html') && fs.existsSync(page)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(page).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Word Bomb server');
  });
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: { origin: ORIGIN === '*' ? '*' : ORIGIN.split(',').map((s) => s.trim()) },
  });
  createGame(io, dict);
  server.listen(PORT, () => console.log('[wordbomb] listening on :' + PORT));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { createGame, buildDictionary, CONFIG };
