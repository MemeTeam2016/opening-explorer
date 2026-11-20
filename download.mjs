// Downloads your games from chess.com and Lichess into data/games.json.
//
//   node download.mjs                      uses usernames from config.json
//   node download.mjs --chesscom a --lichess b   (overrides config.json)
//
// Safe to re-run: only new games are added. Existing games are never changed or
// removed, and the previous database is backed up before every save.
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.EXPLORER_DATA_DIR || join(root, 'data');
const dbPath = join(dataDir, 'games.json');
const jsPath = join(dataDir, 'games.js');
const backupDir = join(dataDir, 'backups');
const KEEP_BACKUPS = 5;
const USER_AGENT = 'opening-explorer/1.0 (personal game downloader)';

// ---------- config ----------
function loadConfig() {
  const cfg = { chesscom: [], lichess: [] };
  const file = process.env.EXPLORER_CONFIG || join(root, 'config.json');
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of ['chesscom', 'lichess']) {
      if (raw[k]) cfg[k] = [].concat(raw[k]).filter(Boolean);
    }
  }
  const args = process.argv.slice(2);
  const cli = { chesscom: [], lichess: [] };
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--(chesscom|lichess)$/);
    if (m && args[i + 1]) cli[m[1]].push(args[++i]);
  }
  for (const k of ['chesscom', 'lichess']) if (cli[k].length) cfg[k] = cli[k];
  // Testing aids: --months N (only the latest N chess.com months), --max N (Lichess games).
  const num = (flag) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : 0; };
  cfg.months = num('--months');
  cfg.max = num('--max');
  return cfg;
}

// ---------- http ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, accept = 'application/json', onLine) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, accept, onLine));
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      let buf = '';
      res.on('data', (chunk) => {
        if (onLine && res.statusCode === 200) {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) onLine(line);
          }
        } else body += chunk;
      });
      res.on('end', () => {
        if (onLine && buf.trim() && res.statusCode === 200) onLine(buf.trim());
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// GET with retries; waits a full minute on HTTP 429 as both APIs ask.
async function getRetry(url, accept, onLine) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await get(url, accept, onLine);
      if (res.status === 429) {
        console.log('  rate limited (429), waiting 60 s...');
        await sleep(60000);
        continue;
      }
      if (res.status >= 500 && attempt < 4) { await sleep(5000 * attempt); continue; }
      return res;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  network error (${e.message}), retrying...`);
      await sleep(5000 * attempt);
    }
  }
}

// ---------- database ----------
function loadDb() {
  if (!existsSync(dbPath)) return { version: 1, games: [], sync: { chesscom: {}, lichess: {} } };
  const db = JSON.parse(readFileSync(dbPath, 'utf8')); // throws (and aborts) if the file is damaged
  if (!Array.isArray(db.games)) throw new Error(`${dbPath} has no games array; refusing to touch it.`);
  db.sync ||= {};
  db.sync.chesscom ||= {};
  db.sync.lichess ||= {};
  return db;
}

function saveDb(db, prevCount) {
  mkdirSync(dataDir, { recursive: true });
  // Safety: the new file must contain at least every game the old one had.
  if (db.games.length < prevCount) throw new Error('Refusing to save: game count would shrink.');
  // Back up the previous file whenever games were added (a run that adds nothing only
  // updates sync bookkeeping, so it doesn't need a 70 MB copy each time).
  if (existsSync(dbPath) && db.games.length > prevCount) {
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(dbPath, join(backupDir, `games-${stamp}.json`));
    const old = readdirSync(backupDir).filter((f) => /^games-.*\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) unlinkSync(join(backupDir, f));
  }
  db.updatedAt = new Date().toISOString();
  const tmp = dbPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(db));
  renameSync(tmp, dbPath);
  writeBrowserData(db);
}

// The explorer page is opened from file://, where fetch() of a JSON file is blocked,
// so the data is also written as a script that sets a global.
function writeBrowserData(db) {
  const fields = ['source', 'id', 'url', 'date', 'timeControl', 'timeClass', 'rated', 'myColor',
    'opponent', 'myRating', 'oppRating', 'result', 'eco', 'opening', 'moves', 'uci'];
  const games = db.games
    .filter((g) => g.variant === 'standard' && g.moves && g.uci)
    .map((g) => fields.map((f) => g[f] ?? null));
  const out = { fields, games, updatedAt: db.updatedAt };
  const tmp = jsPath + '.tmp';
  writeFileSync(tmp, '// Generated by download.mjs. Do not edit.\nwindow.EXPLORER_DATA = ' + JSON.stringify(out) + ';\n');
  renameSync(tmp, jsPath);
}

// ---------- normalizing ----------
function timeClassFromSeconds(base, inc) {
  // Lichess buckets by estimated duration: base + 40 * increment.
  const t = base + 40 * inc;
  if (t < 180) return 'bullet';
  if (t < 480) return 'blitz';
  if (t < 1500) return 'rapid';
  return 'classical';
}

const CHESSCOM_DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

// Returns { moves: 'e4 e5 ...' (SAN), uci: 'e2e4 e7e5 ...' } or empty strings if unreadable.
const toUci = (m) => m.from + m.to + (m.promotion || '');
function fromPgn(pgn) {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const h = chess.history({ verbose: true });
    return { moves: h.map((m) => m.san).join(' '), uci: h.map(toUci).join(' ') };
  } catch { return { moves: '', uci: '' }; }
}
function fromSan(sanList) {
  try {
    const chess = new Chess();
    const h = sanList.split(' ').filter(Boolean).map((s) => chess.move(s));
    return { moves: h.map((m) => m.san).join(' '), uci: h.map(toUci).join(' ') };
  } catch { return { moves: '', uci: '' }; }
}

function fromChessCom(g, user) {
  const lower = user.toLowerCase();
  const myColor = g.white.username.toLowerCase() === lower ? 'white' : 'black';
  const me = g[myColor];
  const opp = g[myColor === 'white' ? 'black' : 'white'];
  const result = me.result === 'win' ? 'win' : CHESSCOM_DRAWS.has(me.result) ? 'draw' : 'loss';
  const termination = result === 'win' ? opp.result : me.result;
  const timeClass = g.time_class; // bullet | blitz | rapid | daily (chess.com has no "classical")
  const pgn = g.pgn || '';
  const header = (name) => (pgn.match(new RegExp(`\\[${name} "([^"]*)"\\]`)) || [])[1];
  const ecoUrl = header('ECOUrl') || g.eco || '';
  const variant = g.rules !== 'chess' ? (g.rules || 'unknown') : header('SetUp') === '1' ? 'fromPosition' : 'standard';
  const { moves, uci } = variant === 'standard' && pgn ? fromPgn(pgn) : { moves: '', uci: '' };
  const id = g.uuid || g.url.split('/').pop();
  return {
    key: `chesscom:${id}`,
    source: 'chesscom',
    id,
    url: g.url,
    account: user,
    date: new Date(g.end_time * 1000).toISOString(),
    timeControl: g.time_control,
    timeClass,
    rated: !!g.rated,
    variant,
    myColor,
    opponent: opp.username,
    myRating: me.rating ?? null,
    oppRating: opp.rating ?? null,
    result,
    termination,
    eco: header('ECO') || null,
    opening: ecoUrl ? decodeURIComponent(ecoUrl.split('/').pop()).replace(/-/g, ' ') : null,
    moves,
    uci,
    pgn: g.pgn,
  };
}

function fromLichess(g, user) {
  const lower = user.toLowerCase();
  const wName = g.players.white.user?.name || '';
  const myColor = wName.toLowerCase() === lower ? 'white' : 'black';
  const me = g.players[myColor];
  const opp = g.players[myColor === 'white' ? 'black' : 'white'];
  const result = !g.winner ? 'draw' : g.winner === myColor ? 'win' : 'loss';
  let timeControl, timeClass;
  if (g.clock) {
    timeControl = `${g.clock.initial}+${g.clock.increment}`;
    timeClass = timeClassFromSeconds(g.clock.initial, g.clock.increment);
  } else {
    timeControl = g.daysPerTurn ? `1/${g.daysPerTurn * 86400}` : '-';
    timeClass = 'daily';
  }
  const variant = g.variant === 'standard' && !g.initialFen ? 'standard' : g.variant;
  const { moves, uci } = variant === 'standard' && g.moves ? fromSan(g.moves) : { moves: '', uci: '' };
  return {
    key: `lichess:${g.id}`,
    source: 'lichess',
    id: g.id,
    url: `https://lichess.org/${g.id}${myColor === 'black' ? '/black' : ''}`,
    account: user,
    date: new Date(g.createdAt).toISOString(),
    createdAt: g.createdAt,
    timeControl,
    timeClass,
    rated: !!g.rated,
    variant,
    myColor,
    opponent: opp.user?.name || (opp.aiLevel ? `Stockfish level ${opp.aiLevel}` : 'Anonymous'),
    myRating: me.rating ?? null,
    oppRating: opp.rating ?? null,
    result,
    termination: g.status,
    eco: g.opening?.eco || null,
    opening: g.opening?.name || null,
    moves,
    uci,
    pgn: g.pgn || null,
  };
}

// ---------- downloaders ----------
async function syncChessCom(db, user, add) {
  const u = encodeURIComponent(user.toLowerCase());
  console.log(`chess.com: ${user}`);
  const res = await getRetry(`https://api.chess.com/pub/player/${u}/games/archives`);
  if (res.status === 404) { console.log('  user not found'); return; }
  if (res.status !== 200) throw new Error(`chess.com archives: HTTP ${res.status}`);
  const archives = JSON.parse(res.body).archives || [];
  const done = (db.sync.chesscom[user.toLowerCase()] ||= { completeMonths: [] });
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (const url of cfg.months ? archives.slice(-cfg.months) : archives) {
    const month = url.split('/').slice(-2).join('/');
    if (done.completeMonths.includes(month)) continue;
    const r = await getRetry(url);
    if (r.status !== 200) { console.log(`  ${month}: HTTP ${r.status}, skipped`); continue; }
    let added = 0;
    let bad = 0;
    for (const g of JSON.parse(r.body).games || []) {
      // One malformed game shouldn't stop the month; it's simply skipped (and retried next run).
      let rec;
      try { rec = fromChessCom(g, user); } catch { bad++; continue; }
      if (add(rec)) added++;
    }
    if (bad) console.log(`  ${month}: ${bad} unreadable game(s) skipped`);
    console.log(`  ${month}: +${added}`);
    // Past months can't gain games, so they're skipped next time. The current one is re-checked.
    if (month < thisMonth && !bad) done.completeMonths.push(month);
    await sleep(300); // serial requests, gently paced
  }
}

async function syncLichess(db, user, add) {
  const key = user.toLowerCase();
  const state = (db.sync.lichess[key] ||= {});
  const since = state.lastCreatedAt ? state.lastCreatedAt + 1 : 0;
  console.log(`lichess: ${user}${since ? ' (new games since ' + new Date(since).toISOString().slice(0, 10) + ')' : ''}`);
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?pgnInJson=true&opening=true&clocks=false&evals=false&sort=dateAsc${cfg.max ? '&max=' + cfg.max : ''}${since ? '&since=' + since : ''}`;
  let added = 0, seen = 0, maxCreated = state.lastCreatedAt || 0;
  const res = await getRetry(url, 'application/x-ndjson', (line) => {
    const g = JSON.parse(line);
    seen++;
    if (add(fromLichess(g, user))) added++;
    if (g.createdAt > maxCreated) maxCreated = g.createdAt;
    if (seen % 500 === 0) console.log(`  ${seen} games read...`);
  });
  if (res.status === 404) { console.log('  user not found'); return; }
  if (res.status !== 200) throw new Error(`lichess: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  state.lastCreatedAt = maxCreated || undefined;
  console.log(`  +${added} (${seen} read)`);
}

// ---------- main ----------
const cfg = loadConfig();
if (!cfg.chesscom.length && !cfg.lichess.length) {
  console.error('No usernames. Copy config.example.json to config.json and fill it in,\nor run: node download.mjs --chesscom NAME --lichess NAME');
  process.exit(1);
}

const db = loadDb();
const prevCount = db.games.length;
const keys = new Set(db.games.map((g) => g.key));
const add = (g) => {
  if (keys.has(g.key)) return false;
  keys.add(g.key);
  db.games.push(g);
  return true;
};

let failed = false;
for (const user of cfg.chesscom) {
  try { await syncChessCom(db, user, add); } catch (e) { failed = true; console.error(`  chess.com ${user} failed: ${e.message}`); }
}
for (const user of cfg.lichess) {
  try { await syncLichess(db, user, add); } catch (e) { failed = true; console.error(`  lichess ${user} failed: ${e.message}`); }
}

db.games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
saveDb(db, prevCount);
const bySource = db.games.reduce((m, g) => ((m[g.source] = (m[g.source] || 0) + 1), m), {});
console.log(`\nAdded ${db.games.length - prevCount} new games. Database: ${db.games.length} games`, bySource);
if (failed) process.exitCode = 1;
