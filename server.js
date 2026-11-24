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
 * page origins, e.g. https://mysite.com), WORDS_FILE, WORDS_URL, MIN_FRAG.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = process.env.ORIGIN || '*';
const WORDS_FILE = process.env.WORDS_FILE || path.join(__dirname, 'words.txt');
const WORDS_URL =
  process.env.WORDS_URL ||
  'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

const CONFIG = {
  MAX_PLAYERS: 8,
  MAX_SPECTATORS: 30,
  BOOM_MS: 2200, // pause after an explosion before the next bomb
  FUSES: { fast: [4, 8], normal: [6, 12], slow: [10, 18] }, // seconds, fresh random fuse every turn
  // Using all of these letters across your words earns a life back (no Q, X, Z).
  BONUS_LETTERS: 'abcdefghijklmnoprstuvwy',
  MAX_LIVES: 5,
  CHAT_KEEP: 60, // messages remembered per room
  GRACE_IDLE_MS: 25000, // how long a dropped player can come back in a lobby
  GRACE_GAME_MS: 60000, // ...and during a game
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
function cleanTitle(s, fallback) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 28);
  return s || fallback;
}
function cleanToken(s) {
  s = String(s == null ? '' : s);
  return /^[A-Za-z0-9_-]{16,64}$/.test(s) ? s : '';
}
function cleanChat(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Cosmetics shop: catalog, saved profiles, name claiming              */
/* ------------------------------------------------------------------ */

const SLOTS = ['frame', 'bomb', 'boom', 'title', 'color'];
const START_COINS = 200;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Prices are set here, on the server. The page only knows how each id looks.
// "exclusive" items cannot be bought: you grant them to specific names from the admin tools.
const CATALOG = [
  { id: 'frame_gold', slot: 'frame', name: 'Gold ring', price: 150, rarity: 'common' },
  { id: 'frame_frost', slot: 'frame', name: 'Frostbite', price: 200, rarity: 'common' },
  { id: 'frame_toxic', slot: 'frame', name: 'Toxic glow', price: 350, rarity: 'rare' },
  { id: 'frame_neon', slot: 'frame', name: 'Neon drift', price: 450, rarity: 'rare' },
  { id: 'frame_flame', slot: 'frame', name: 'Wildfire', price: 900, rarity: 'epic' },
  { id: 'frame_rainbow', slot: 'frame', name: 'Prism', price: 1500, rarity: 'legendary' },
  { id: 'frame_vip', slot: 'frame', name: 'Royal halo', price: 0, rarity: 'exclusive', exclusive: true },

  { id: 'bomb_cartoon', slot: 'bomb', name: 'Cartoon bomb', price: 250, rarity: 'common' },
  { id: 'bomb_pumpkin', slot: 'bomb', name: 'Jack-o-bomb', price: 300, rarity: 'common' },
  { id: 'bomb_cherry', slot: 'bomb', name: 'Cherry bomb', price: 400, rarity: 'rare' },
  { id: 'bomb_disco', slot: 'bomb', name: 'Disco ball', price: 900, rarity: 'epic' },
  { id: 'bomb_void', slot: 'bomb', name: 'Void core', price: 1200, rarity: 'epic' },
  { id: 'bomb_gold', slot: 'bomb', name: 'Solid gold', price: 2000, rarity: 'legendary' },
  { id: 'bomb_dev', slot: 'bomb', name: 'Debug bomb', price: 0, rarity: 'exclusive', exclusive: true },

  { id: 'boom_confetti', slot: 'boom', name: 'Confetti pop', price: 200, rarity: 'common' },
  { id: 'boom_hearts', slot: 'boom', name: 'Heartbreak', price: 250, rarity: 'common' },
  { id: 'boom_stars', slot: 'boom', name: 'Starburst', price: 300, rarity: 'common' },
  { id: 'boom_skulls', slot: 'boom', name: 'Skull storm', price: 500, rarity: 'rare' },
  { id: 'boom_pixel', slot: 'boom', name: 'Pixel burst', price: 700, rarity: 'rare' },
  { id: 'boom_lightning', slot: 'boom', name: 'Lightning', price: 900, rarity: 'epic' },

  { id: 'title_wordsmith', slot: 'title', name: 'Wordsmith', price: 250, rarity: 'common' },
  { id: 'title_fuselord', slot: 'title', name: 'Fuse Lord', price: 300, rarity: 'common' },
  { id: 'title_boommagnet', slot: 'title', name: 'Boom Magnet', price: 350, rarity: 'rare' },
  { id: 'title_lastfuse', slot: 'title', name: 'Last Fuse', price: 400, rarity: 'rare' },
  { id: 'title_dictionary', slot: 'title', name: 'Walking Dictionary', price: 1000, rarity: 'epic' },
  { id: 'title_dev', slot: 'title', name: 'Developer', price: 0, rarity: 'exclusive', exclusive: true },
  { id: 'title_founder', slot: 'title', name: 'Founder', price: 0, rarity: 'exclusive', exclusive: true },

  { id: 'name_mint', slot: 'color', name: 'Mint', price: 150, rarity: 'common' },
  { id: 'name_sky', slot: 'color', name: 'Sky', price: 150, rarity: 'common' },
  { id: 'name_rose', slot: 'color', name: 'Rose', price: 200, rarity: 'common' },
  { id: 'name_gold', slot: 'color', name: 'Gold shimmer', price: 600, rarity: 'rare' },
  { id: 'name_rainbow', slot: 'color', name: 'Rainbow', price: 1400, rarity: 'legendary' },
  { id: 'name_vip', slot: 'color', name: 'Royal', price: 0, rarity: 'exclusive', exclusive: true },
];
const ITEMS = new Map(CATALOG.map((i) => [i.id, i]));

const nameKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
// The default name and one-letter names can't be claimed, so nobody can squat "Player".
const claimable = (s) => { const k = nameKey(s); return k.length >= 2 && k !== 'player'; };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 8; i++) c += A[crypto.randomInt(A.length)];
  return c.slice(0, 4) + '-' + c.slice(4);
}
function newProfile(name, keyHash, code, reserved) {
  return {
    nameKey: nameKey(name), name: cleanName(name), keyHash, recoveryHash: sha(normCode(code)),
    coins: START_COINS, owned: [], equipped: {}, stats: { games: 0, wins: 0, words: 0 }, reserved: !!reserved,
  };
}
const publicProfile = (p) => ({ name: p.name, coins: p.coins, owned: p.owned.slice(), equipped: Object.assign({}, p.equipped), stats: Object.assign({}, p.stats) });
// The cosmetics other players see: only things this profile really owns.
function cosOf(p) {
  const cos = {};
  for (const slot of SLOTS) {
    const id = p.equipped[slot];
    const item = id && ITEMS.get(id);
    if (item && item.slot === slot && p.owned.includes(id)) cos[slot] = id;
  }
  return cos;
}

/*
 * Where profiles are saved:
 *   - Supabase, when SUPABASE_URL and SUPABASE_KEY are set (permanent; see the SQL in the setup notes)
 *   - otherwise a JSON file (PROFILES_FILE, default ./profiles.json). Hosts with temporary disks
 *     (like Render's free tier) lose that file when the service restarts.
 */
function createStore(opts) {
  opts = opts || {};
  const sbUrl = String(opts.supabaseUrl !== undefined ? opts.supabaseUrl : (process.env.SUPABASE_URL || '')).replace(/\/+$/, '');
  const sbKey = opts.supabaseKey !== undefined ? opts.supabaseKey : (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '');
  const file = opts.file !== undefined ? opts.file : (process.env.PROFILES_FILE || path.join(__dirname, 'profiles.json'));
  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const useSb = !!(sbUrl && sbKey && doFetch);
  const table = sbUrl + '/rest/v1/wb_profiles';
  const headers = { apikey: sbKey, Authorization: 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
  const cache = new Map();
  const chains = new Map();

  const toRow = (p) => ({
    name_key: p.nameKey, name: p.name, key_hash: p.keyHash, recovery_hash: p.recoveryHash, coins: p.coins,
    owned: p.owned, equipped: p.equipped, stats: p.stats, reserved: !!p.reserved, updated_at: new Date().toISOString(),
  });
  const fromRow = (r) => ({
    nameKey: r.name_key, name: r.name, keyHash: r.key_hash || null, recoveryHash: r.recovery_hash || null,
    coins: Number(r.coins) || 0, owned: Array.isArray(r.owned) ? r.owned : [],
    equipped: r.equipped && typeof r.equipped === 'object' ? r.equipped : {},
    stats: Object.assign({ games: 0, wins: 0, words: 0 }, r.stats || {}), reserved: !!r.reserved,
  });

  if (!useSb && file) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of Object.keys(obj)) cache.set(k, obj[k]);
    } catch (e) { /* no saved profiles yet */ }
  }

  let fileTimer = null;
  function writeFileSoon() {
    if (useSb || !file || fileTimer) return;
    fileTimer = setTimeout(() => {
      fileTimer = null;
      try {
        const obj = {};
        for (const [k, v] of cache) obj[k] = v;
        fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
        fs.renameSync(file + '.tmp', file);
      } catch (e) { console.error('[wordbomb] could not save profiles:', e.message); }
    }, 400);
  }

  async function persist(p) {
    const res = await doFetch(table, {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, headers),
      body: JSON.stringify(toRow(p)),
    });
    if (!res.ok) throw new Error('Supabase ' + res.status + ' ' + (await res.text().catch(() => '')));
  }

  async function get(nk) {
    if (cache.has(nk)) return cache.get(nk);
    if (!useSb) return null;
    const res = await doFetch(table + '?name_key=eq.' + encodeURIComponent(nk) + '&select=*&limit=1', { headers });
    if (!res.ok) throw new Error('Supabase ' + res.status);
    const rows = await res.json();
    if (!rows.length) return null;
    const p = fromRow(rows[0]);
    cache.set(nk, p);
    return p;
  }

  function save(p) {
    cache.set(p.nameKey, p);
    if (useSb) {
      const prev = chains.get(p.nameKey) || Promise.resolve();
      const next = prev.then(() => persist(p)).catch((e) => console.error('[wordbomb] profile save failed:', e.message));
      chains.set(p.nameKey, next);
      return next;
    }
    writeFileSoon();
    return Promise.resolve();
  }

  // Load a profile, change it with fnc(profile), save it. fnc runs in one go, so two buys can't both spend the same coins.
  async function update(nk, fnc) {
    const p = await get(nk);
    if (!p) return null;
    const result = fnc(p);
    save(p);
    return { p, result };
  }

  return { get, save, update, idle: () => Promise.all([...chains.values()]), backend: useSb ? 'supabase' : (file ? 'file' : 'memory') };
}

// name + this device's key -> the profile, a brand-new claim, or "guest" (name belongs to someone else)
async function identify(store, name, key, create) {
  if (!claimable(name)) return { guest: true, reason: 'unclaimable' };
  key = cleanToken(key);
  if (!key) return { guest: true, reason: 'nokey' };
  const nk = nameKey(name);
  const kh = sha(key);
  const p = await store.get(nk);
  if (!p) {
    if (!create) return { guest: true, reason: 'noprofile' };
    const code = genCode();
    const np = newProfile(name, kh, code, false);
    store.save(np);
    return { profile: np, fresh: true, recovery: code };
  }
  if (p.reserved || !p.keyHash) return { guest: true, reason: 'reserved' };
  if (p.keyHash === kh) return { profile: p };
  return { guest: true, reason: 'taken' };
}

function createGame(io, dict, store) {
  store = store || createStore();
  const rooms = new Map(); // code -> room
  const sockRoom = new Map(); // socket id -> room code
  const sessions = new Map(); // secret token -> room code (for reconnecting)
  const noop = () => {};
  const fn = (f) => (typeof f === 'function' ? f : noop);
  const live = (room) => room.phase === 'playing' || room.phase === 'boom';

  /* ---------- room list (the public lobby browser) ---------- */

  let lastPub = '';
  let pubTimer = null;
  function listRooms() {
    return [...rooms.values()]
      .map((r) => {
        const host = r.players.find((p) => p.id === r.hostId);
        return {
          code: r.code,
          title: r.title,
          host: host ? host.name : '',
          players: active(r).length,
          max: CONFIG.MAX_PLAYERS,
          specs: r.specs.length,
          phase: r.phase,
          lives: r.settings.lives,
        };
      })
      .sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.players - a.players);
  }
  function publishRooms() {
    if (pubTimer) return;
    pubTimer = setTimeout(() => {
      pubTimer = null;
      const list = listRooms();
      const json = JSON.stringify(list);
      if (json === lastPub) return;
      lastPub = json;
      io.to('browse').emit('rooms', list);
    }, 200);
  }

  /* ---------- helpers ---------- */

  function makeCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let c;
    do {
      c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
    } while (rooms.has(c));
    return c;
  }

  function newRoom(code, title) {
    return {
      code,
      title,
      hostId: null,
      phase: 'lobby', // lobby | playing | boom | over
      settings: { lives: 3, fuse: 'normal', difficulty: 'mixed' },
      players: [],
      specs: [], // spectators: they join as players when the next game starts
      chat: [],
      turn: -1,
      prompt: '',
      used: new Set(),
      recent: [],
      fuseTotal: 0,
      fuseEnd: 0,
      timer: null,
      nextTimer: null,
      solo: false,
      awarded: false,
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
    const inGame = live(room);
    const holder = inGame ? room.players[room.turn] : null;
    return {
      code: room.code,
      title: room.title,
      hostId: room.hostId,
      phase: room.phase,
      settings: room.settings,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        alive: p.alive,
        left: p.left,
        offline: p.offline,
        words: p.words,
        letters: [...p.letters].join(''),
        cos: p.cos || {},
      })),
      specs: room.specs.map((s) => ({ id: s.id, name: s.name, offline: s.offline })),
      turnId: holder ? holder.id : null,
      prompt: inGame ? room.prompt : '',
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
    publishRooms();
  }

  function pushChat(room, m) {
    room.chat.push(m);
    if (room.chat.length > CONFIG.CHAT_KEEP) room.chat.shift();
    io.to(room.code).emit('chat', m);
  }
  const sysChat = (room, text) => pushChat(room, { kind: 'sys', text, t: Date.now() });

  /* ---------- turns, fuse, explosions ---------- */

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
    awardCoins(room);
    broadcast(room);
  }

  // Coins for everyone with a saved name: a little for playing, more for words, a lot for winning. Solo runs earn nothing.
  function awardCoins(room) {
    if (room.solo || room.awarded) return;
    room.awarded = true;
    const ranked = room.players.filter((p) => !p.left).sort((a, b) => (b.alive - a.alive) || (b.words - a.words));
    if (ranked.length < 2) return;
    ranked.forEach((p, i) => {
      if (!p.pkey) return;
      const won = p.id === room.winnerId;
      if (p.words < 1 && !won) return;
      const coins = 5 + Math.min(p.words, 20) * 2 + (won ? 25 : i === 1 ? 10 : 0);
      store.update(p.pkey, (q) => { q.coins += coins; q.stats.games++; q.stats.words += p.words; if (won) q.stats.wins++; return null; })
        .then((out) => { if (out && p.sid) io.to(p.sid).emit('earned', { coins, total: out.p.coins, won }); })
        .catch((e) => console.error('[wordbomb] coin award failed:', e.message));
    });
  }

  /* ---------- players and spectators ---------- */

  function resetPlayers(room) {
    room.players = room.players.filter((p) => !p.left);
    for (const p of room.players) {
      p.lives = room.settings.lives;
      p.alive = true;
      p.letters = new Set();
      p.words = 0;
    }
  }

  // Spectators take a seat when there is room (called when a game starts or the room returns to the lobby).
  function promoteSpecs(room) {
    while (room.specs.length && active(room).length < CONFIG.MAX_PLAYERS) {
      room.players.push(room.specs.shift());
    }
  }

  function startGame(room) {
    promoteSpecs(room);
    resetPlayers(room);
    if (!room.players.length) return;
    room.used = new Set();
    room.recent = [];
    room.winnerId = null;
    room.awarded = false;
    room.solo = room.players.length === 1;
    event(room, { type: 'start' });
    startRound(room, Math.floor(Math.random() * room.players.length));
  }

  function resetToLobby(room) {
    clearTimeout(room.timer);
    clearTimeout(room.nextTimer);
    room.phase = 'lobby';
    room.winnerId = null;
    room.prompt = '';
    promoteSpecs(room);
    resetPlayers(room);
    const first = active(room)[0];
    if (!active(room).some((p) => p.id === room.hostId)) room.hostId = first ? first.id : null;
  }

  function destroy(room) {
    clearTimeout(room.timer);
    clearTimeout(room.nextTimer);
    rooms.delete(room.code);
    publishRooms();
  }

  function makeEntry(room, socket, name, token, prof) {
    const base = cleanName(name);
    let n = base;
    let i = 2;
    const taken = (x) => active(room).concat(room.specs).some((p) => p.name.toLowerCase() === x.toLowerCase());
    while (taken(n)) n = base.slice(0, 13) + ' ' + i++;
    return {
      id: crypto.randomBytes(4).toString('hex'), // public id (safe to show everyone)
      token, // secret, only the owner knows it; used to reconnect
      sid: socket.id,
      name: n,
      offline: false,
      graceTimer: null,
      lastChat: 0,
      lastSubmit: 0,
      lives: room.settings.lives,
      alive: room.phase !== 'over',
      letters: new Set(),
      words: 0,
      left: false,
      pkey: prof ? prof.nameKey : null, // saved-profile key (never sent to other players)
      cos: prof ? cosOf(prof) : {}, // cosmetics everyone can see
    };
  }

  function attach(room, socket, entry, asSpec) {
    (asSpec ? room.specs : room.players).push(entry);
    if (!asSpec && !room.hostId) room.hostId = entry.id;
    sessions.set(entry.token, room.code);
    sockRoom.set(socket.id, room.code);
    socket.leave('browse');
    socket.join(room.code);
    socket.emit('you', { id: entry.id, token: entry.token, code: room.code, spec: asSpec });
    socket.emit('chat:history', room.chat.slice());
    sysChat(room, entry.name + (asSpec ? ' is watching' : ' joined'));
  }

  function locate(socket) {
    const room = rooms.get(sockRoom.get(socket.id));
    if (!room) return {};
    const player = room.players.find((p) => p.sid === socket.id);
    if (player) return { room, player };
    const spec = room.specs.find((p) => p.sid === socket.id);
    return spec ? { room, spec } : {};
  }

  // Take a player or spectator out of a room for good.
  function removeEntry(room, entry) {
    clearTimeout(entry.graceTimer);
    if (sessions.get(entry.token) === room.code) sessions.delete(entry.token);
    if (entry.sid && sockRoom.get(entry.sid) === room.code) sockRoom.delete(entry.sid);
    entry.sid = null;

    if (room.specs.includes(entry)) {
      room.specs = room.specs.filter((s) => s !== entry);
      sysChat(room, entry.name + ' left');
      return broadcast(room);
    }
    const idx = room.players.indexOf(entry);
    if (idx === -1) return;
    const inGame = live(room);
    if (inGame) {
      entry.left = true;
      entry.alive = false;
      entry.lives = 0;
    } else {
      room.players.splice(idx, 1);
    }
    sysChat(room, entry.name + ' left');

    if (active(room).length === 0) {
      if (room.specs.length) {
        resetToLobby(room); // the spectators become the new players
        return broadcast(room);
      }
      return destroy(room);
    }
    if (room.hostId === entry.id) {
      const next = active(room).find((p) => !p.offline) || active(room)[0];
      room.hostId = next.id;
    }
    if (room.phase === 'lobby') promoteSpecs(room);
    if (room.phase === 'playing') {
      if (isOver(room)) return finish(room);
      if (idx === room.turn) passBomb(room, idx);
    }
    broadcast(room);
  }

  // Remove whoever this secret token currently is, wherever they are (used before joining something new).
  function dropToken(token) {
    const room = rooms.get(sessions.get(token));
    sessions.delete(token);
    if (!room) return;
    const e = room.players.find((p) => p.token === token && !p.left) || room.specs.find((s) => s.token === token);
    if (e) removeEntry(room, e);
  }

  function leave(socket) {
    const { room, player, spec } = locate(socket);
    const entry = player || spec;
    if (!entry) return;
    socket.leave(room.code);
    removeEntry(room, entry);
    socket.join('browse');
    socket.emit('rooms', listRooms());
  }

  // Connection dropped: keep their seat for a while so they can come back.
  function goOffline(socket) {
    const { room, player, spec } = locate(socket);
    sockRoom.delete(socket.id);
    const entry = player || spec;
    if (!entry) return;
    entry.sid = null;
    entry.offline = true;
    clearTimeout(entry.graceTimer);
    entry.graceTimer = setTimeout(() => {
      if (rooms.has(room.code) && entry.offline) removeEntry(room, entry);
    }, live(room) ? CONFIG.GRACE_GAME_MS : CONFIG.GRACE_IDLE_MS);
    if (player && room.hostId === entry.id) {
      const other = active(room).find((p) => !p.offline && p !== entry);
      if (other) room.hostId = other.id;
    }
    broadcast(room);
  }

  const hostRoom = (socket) => {
    const { room, player } = locate(socket);
    return room && player && room.hostId === player.id ? room : null;
  };

  /* ---------- socket events ---------- */

  /* ---------- shop helpers ---------- */

  const shopT = new Map();
  const throttle = (socket, ms, ev) => {
    const k = socket.id + ':' + ev;
    const now = Date.now();
    if (now - (shopT.get(k) || 0) < ms) return true;
    shopT.set(k, now);
    return false;
  };
  async function identSafe(name, key, create) {
    try { return await identify(store, name, key, create); }
    catch (e) { console.error('[wordbomb] profile lookup failed:', e.message); return { guest: true, reason: 'error' }; }
  }
  // Show a changed loadout to everyone already sitting in a room with this profile.
  function syncLive(p) {
    const cos = cosOf(p);
    for (const room of rooms.values()) {
      let changed = false;
      for (const e of room.players.concat(room.specs)) if (e.pkey === p.nameKey) { e.cos = cos; changed = true; }
      if (changed) broadcast(room);
    }
  }

  io.on('connection', (socket) => {
    socket.join('browse');
    socket.emit('rooms', listRooms());

    socket.on('rooms:list', () => socket.emit('rooms', listRooms()));

    /* ---------- shop: saved names, buying, equipping ---------- */

    socket.on('profile:open', async (d, ack) => {
      const reply = fn(ack);
      d = d || {};
      if (throttle(socket, 150, 'open')) return reply({ ok: false, reason: 'Slow down' });
      const r = await identSafe(d.name, d.key, !!d.claim); // only an explicit claim creates a profile
      if (r.guest) return reply({ ok: true, guest: true, reason: r.reason, catalog: CATALOG });
      reply({ ok: true, guest: false, profile: publicProfile(r.profile), fresh: !!r.fresh, recovery: r.recovery || null, catalog: CATALOG });
    });

    socket.on('profile:buy', async (d, ack) => {
      const reply = fn(ack);
      d = d || {};
      if (throttle(socket, 250, 'buy')) return reply({ ok: false, reason: 'Slow down' });
      const r = await identSafe(d.name, d.key, false);
      if (r.guest) return reply({ ok: false, reason: 'Pick a saved name first' });
      const item = ITEMS.get(String(d.id));
      if (!item) return reply({ ok: false, reason: 'Unknown item' });
      if (item.exclusive) return reply({ ok: false, reason: 'This item is reserved for certain names' });
      const out = await store.update(r.profile.nameKey, (p) => {
        if (p.owned.includes(item.id)) return 'You already own this';
        if (p.coins < item.price) return 'Not enough coins';
        p.coins -= item.price;
        p.owned.push(item.id);
        p.equipped[item.slot] = item.id; // equip right away
        return null;
      });
      if (!out) return reply({ ok: false, reason: 'Profile not found' });
      if (out.result) return reply({ ok: false, reason: out.result });
      syncLive(out.p);
      reply({ ok: true, profile: publicProfile(out.p) });
    });

    socket.on('profile:equip', async (d, ack) => {
      const reply = fn(ack);
      d = d || {};
      if (throttle(socket, 120, 'equip')) return reply({ ok: false, reason: 'Slow down' });
      const r = await identSafe(d.name, d.key, false);
      if (r.guest) return reply({ ok: false, reason: 'Pick a saved name first' });
      const slot = String(d.slot);
      if (!SLOTS.includes(slot)) return reply({ ok: false, reason: 'Unknown slot' });
      const id = d.id == null ? null : String(d.id);
      const out = await store.update(r.profile.nameKey, (p) => {
        if (id === null) { delete p.equipped[slot]; return null; }
        const item = ITEMS.get(id);
        if (!item || item.slot !== slot) return 'Unknown item';
        if (!p.owned.includes(id)) return "You don't own that yet";
        p.equipped[slot] = id;
        return null;
      });
      if (!out) return reply({ ok: false, reason: 'Profile not found' });
      if (out.result) return reply({ ok: false, reason: out.result });
      syncLive(out.p);
      reply({ ok: true, profile: publicProfile(out.p) });
    });

    // Use a name on a new device (or claim a name an admin reserved for you) with its recovery code.
    socket.on('profile:recover', async (d, ack) => {
      const reply = fn(ack);
      d = d || {};
      if (throttle(socket, 1000, 'recover')) return reply({ ok: false, reason: 'Wait a second and try again' });
      const key = cleanToken(d.key);
      if (!key || !claimable(d.name)) return reply({ ok: false, reason: 'Enter your name first' });
      const nk = nameKey(d.name);
      let p;
      try { p = await store.get(nk); } catch (e) { return reply({ ok: false, reason: 'Could not reach the profile database' }); }
      if (!p || !p.recoveryHash || sha(normCode(d.code)) !== p.recoveryHash) return reply({ ok: false, reason: 'That code does not match this name' });
      const out = await store.update(nk, (q) => { q.keyHash = sha(key); q.reserved = false; return null; });
      reply({ ok: true, profile: publicProfile(out.p) });
    });

    socket.on('profile:newcode', async (d, ack) => {
      const reply = fn(ack);
      d = d || {};
      if (throttle(socket, 500, 'newcode')) return reply({ ok: false, reason: 'Slow down' });
      const r = await identSafe(d.name, d.key, false);
      if (r.guest) return reply({ ok: false, reason: 'Pick a saved name first' });
      const code = genCode();
      await store.update(r.profile.nameKey, (q) => { q.recoveryHash = sha(normCode(code)); return null; });
      reply({ ok: true, recovery: code });
    });

    // Owner tools: give (or take back) an item or coins for a specific name. A name nobody has used yet becomes
    // a reserved profile: only someone with the recovery code returned here can claim it.
    socket.on('admin:grant', async (d, ack) => {
      const reply = fn(ack);
      d = d || {};
      if (throttle(socket, 300, 'grant')) return reply({ ok: false, reason: 'Slow down' });
      if (!ADMIN_KEY) return reply({ ok: false, reason: 'ADMIN_KEY is not set on the server' });
      if (!safeEqual(d.adminKey, ADMIN_KEY)) return reply({ ok: false, reason: 'Wrong admin key' });
      if (!claimable(d.name)) return reply({ ok: false, reason: 'Enter a name (2+ letters, and not "Player")' });
      const item = d.item ? ITEMS.get(String(d.item)) : null;
      if (d.item && !item) return reply({ ok: false, reason: 'Unknown item' });
      const coins = Math.max(-100000, Math.min(100000, Math.round(Number(d.coins) || 0)));
      const nk = nameKey(d.name);
      let p;
      try { p = await store.get(nk); } catch (e) { return reply({ ok: false, reason: 'Could not reach the profile database' }); }
      let recovery = null;
      if (!p) {
        recovery = genCode();
        p = newProfile(d.name, null, recovery, true);
        store.save(p);
      }
      const out = await store.update(nk, (q) => {
        if (item) {
          if (d.revoke) {
            q.owned = q.owned.filter((x) => x !== item.id);
            if (q.equipped[item.slot] === item.id) delete q.equipped[item.slot];
          } else if (!q.owned.includes(item.id)) q.owned.push(item.id);
        }
        if (coins) q.coins = Math.max(0, q.coins + coins);
        if (d.resetCode) { recovery = genCode(); q.recoveryHash = sha(normCode(recovery)); }
        return null;
      });
      syncLive(out.p);
      reply({ ok: true, recovery, reserved: !!out.p.reserved, coins: out.p.coins, owned: out.p.owned.length });
    });

    socket.on('room:create', async (data, ack) => {
      const reply = fn(ack);
      data = data || {};
      const token = cleanToken(data.token) || crypto.randomBytes(12).toString('hex');
      const prof = (await identSafe(data.name, data.key, false)).profile || null;
      leave(socket);
      dropToken(token);
      const name = cleanName(data.name);
      const room = newRoom(makeCode(), cleanTitle(data.title, name + "'s room"));
      rooms.set(room.code, room);
      attach(room, socket, makeEntry(room, socket, name, token, prof), false);
      reply({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('room:join', async (data, ack) => {
      const reply = fn(ack);
      data = data || {};
      const code = String(data.code || '').trim().toUpperCase();
      if (!rooms.get(code)) return reply({ ok: false, reason: 'That room no longer exists' });
      if (sockRoom.get(socket.id) === code) return reply({ ok: true, code });
      const token = cleanToken(data.token) || crypto.randomBytes(12).toString('hex');
      const prof = (await identSafe(data.name, data.key, false)).profile || null;
      const room = rooms.get(code);
      if (!room) return reply({ ok: false, reason: 'That room no longer exists' });
      if (sockRoom.get(socket.id) === code) return reply({ ok: true, code });
      const asSpec = live(room) || active(room).length >= CONFIG.MAX_PLAYERS;
      if (asSpec && room.specs.length >= CONFIG.MAX_SPECTATORS) return reply({ ok: false, reason: 'Room is full' });
      leave(socket);
      dropToken(token);
      attach(room, socket, makeEntry(room, socket, data.name, token, prof), asSpec);
      reply({ ok: true, code, spec: asSpec });
      broadcast(room);
    });

    // Come back after a dropped connection or a page refresh.
    socket.on('session:resume', (data, ack) => {
      const reply = fn(ack);
      const token = cleanToken(data && data.token);
      const room = token && rooms.get(sessions.get(token));
      if (!room) return reply({ ok: false });
      let entry = room.players.find((p) => p.token === token && !p.left);
      let asSpec = false;
      if (!entry) {
        entry = room.specs.find((s) => s.token === token);
        asSpec = true;
      }
      if (!entry) return reply({ ok: false });
      if (entry.sid && entry.sid !== socket.id && sockRoom.get(entry.sid) === room.code) sockRoom.delete(entry.sid);
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
      entry.offline = false;
      entry.sid = socket.id;
      sockRoom.set(socket.id, room.code);
      socket.leave('browse');
      socket.join(room.code);
      socket.emit('you', { id: entry.id, token, code: room.code, spec: asSpec });
      socket.emit('chat:history', room.chat.slice());
      reply({ ok: true });
      broadcast(room);
    });

    socket.on('room:leave', () => leave(socket));
    socket.on('disconnect', () => { for (const k of [...shopT.keys()]) if (k.startsWith(socket.id + ':')) shopT.delete(k); goOffline(socket); });

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
      resetToLobby(room);
      broadcast(room);
    });

    socket.on('chat', (text) => {
      const { room, player, spec } = locate(socket);
      const who = player || spec;
      if (!who) return;
      const now = Date.now();
      if (now - who.lastChat < 600) return;
      const t = cleanChat(text);
      if (!t) return;
      who.lastChat = now;
      pushChat(room, { kind: 'msg', id: who.id, name: who.name, spec: !!spec, text: t, t: now });
    });

    socket.on('typing', (text) => {
      const { room, player } = locate(socket);
      if (!room || !player || room.phase !== 'playing' || room.players[room.turn] !== player) return;
      const t = String(text == null ? '' : text).toLowerCase().replace(/[^a-z]/g, '').slice(0, 30);
      socket.to(room.code).emit('typing', { id: player.id, text: t });
    });

    socket.on('word:submit', (raw, ack) => {
      const reply = fn(ack);
      const { room, player: p } = locate(socket);
      if (!room || room.phase !== 'playing') return reply({ ok: false, reason: 'No bomb right now' });
      const idx = room.turn;
      if (!p || room.players[idx] !== p) return reply({ ok: false, reason: 'Not your turn' });

      const now = Date.now();
      if (now - p.lastSubmit < 120) return reply({ ok: false, reason: 'Slow down' });
      p.lastSubmit = now;

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

  return { rooms, sessions, snapshot, listRooms, store };
}

/* ------------------------------------------------------------------ */

async function main() {
  const dict = await loadDictionary();
  const page = path.join(__dirname, 'wordbomb.html');
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
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
    pingInterval: 10000,
    pingTimeout: 10000,
  });
  const store = createStore();
  console.log('[wordbomb] profiles saved to: ' + store.backend);
  if (store.backend === 'file') console.warn('[wordbomb] Profiles are in a file. On hosts with temporary disks (Render free tier) they are lost on restart. Set SUPABASE_URL and SUPABASE_KEY to keep them permanently.');
  if (!ADMIN_KEY) console.warn('[wordbomb] ADMIN_KEY is not set, so the admin grant tools are disabled.');
  createGame(io, dict, store);
  server.listen(PORT, () => console.log('[wordbomb] listening on :' + PORT));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { createGame, createStore, buildDictionary, CONFIG, CATALOG, ITEMS, nameKey };
