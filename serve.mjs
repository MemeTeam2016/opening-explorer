// Local server for the explorer plus the Stockfish analysis API.
//   npm run serve            -> http://localhost:5175
//   node serve.mjs --open    -> also opens it in your browser
// Opening index.html from disk works for exploring; analysis needs this server, because a
// web page can't start Stockfish by itself.
//
// Environment (mainly for testing): PORT, EXPLORER_DATA_DIR (where games.js and
// evals.json live). The page chooses the seconds per position for each run.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, findStockfish } from './engine.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.EXPLORER_DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT) || 5175;
// Bump when the API changes, so an open page can tell that this server is out of date.
const API_VERSION = 2;
const DEFAULT_MOVETIME = 10000;
const MIN_MOVETIME = 100;
const MAX_MOVETIME = 600000; // 10 minutes per position
const clampMovetime = (ms) => {
  const n = Math.round(Number(ms));
  return Number.isFinite(n) ? Math.min(MAX_MOVETIME, Math.max(MIN_MOVETIME, n)) : DEFAULT_MOVETIME;
};
const evalsPath = join(dataDir, 'evals.json');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const files = {
  '/index.html': join(root, 'index.html'),
  '/dist/app.js': join(root, 'dist/app.js'),
  '/dist/app.css': join(root, 'dist/app.css'),
  '/data/games.js': join(dataDir, 'games.js'),
};

// ---------- engine + eval cache ----------
let config = {};
try { config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')); } catch { /* optional */ }
const enginePath = findStockfish(config.stockfish, root);
const engine = enginePath ? new Engine(enginePath) : null;

// evals.json only ever grows: one entry per position (FEN without move counters).
let evals = { version: 1, entries: {} };
if (existsSync(evalsPath)) {
  evals = JSON.parse(readFileSync(evalsPath, 'utf8')); // a damaged file stops the server rather than being replaced
  evals.entries ||= {};
}
function saveEvals() {
  mkdirSync(dataDir, { recursive: true });
  const tmp = evalsPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(evals));
  renameSync(tmp, evalsPath);
}
const posKey = (fen) => fen.split(' ').slice(0, 4).join(' ');
// An eval counts if it was searched at least as long as asked for.
const cached = (fen, movetime) => {
  const e = evals.entries[posKey(fen)];
  return e && e.movetime >= movetime ? e : null;
};
const FEN_RE = /^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7} [wb] (-|[KQkq]{1,4}) (-|[a-h][36]) \d{1,3} \d{1,4}$/;

// ---------- the job (one at a time) ----------
let job = null;

function jobView(full) {
  if (!job) return null;
  const v = {
    id: job.id, status: job.status, total: job.fens.length, done: job.done, fromCache: job.fromCache,
    startedAt: job.startedAt, finishedAt: job.finishedAt, movetime: job.movetime, error: job.error || null,
  };
  if (full) {
    v.meta = job.meta;
    v.results = {};
    for (const f of job.fens) { const e = cached(f, job.movetime); if (e) v.results[f] = e; }
  }
  return v;
}

async function runJob() {
  const j = job;
  try {
    for (const fen of j.fens) {
      if (j.status !== 'running') break;
      if (cached(fen, j.movetime)) { j.done++; continue; }
      const r = await engine.analyze(fen, j.movetime);
      if (j.status !== 'running') break; // stopped mid-search: don't keep a half-finished result
      // Only a longer search replaces an existing eval of the same position.
      const old = evals.entries[posKey(fen)];
      if (!old || old.movetime < j.movetime) {
        evals.entries[posKey(fen)] = { ...r, movetime: j.movetime, engine: engine.name, at: new Date().toISOString() };
      }
      saveEvals();
      j.done++;
    }
    if (j.status === 'running') j.status = 'done';
  } catch (e) {
    j.status = 'error';
    j.error = e.message;
  }
  j.finishedAt = Date.now();
}

// ---------- http ----------
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 20e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Only this page may use the API: blocks other websites (and DNS rebinding) from driving it.
function allowed(req) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!hosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.has(origin.replace(/^http:\/\//, ''))) return false;
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  return true;
}

async function api(req, res, path) {
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
  if (path === '/api/status' && req.method === 'GET') {
    if (engine && !engine.name) { try { await engine.start(); } catch { /* reported below */ } }
    return send(res, 200, {
      engine: engine ? { name: engine.name, ok: !!engine.name } : null,
      apiVersion: API_VERSION, defaultMovetime: DEFAULT_MOVETIME, minMovetime: MIN_MOVETIME, maxMovetime: MAX_MOVETIME,
      cachedPositions: Object.keys(evals.entries).length, job: jobView(false),
    });
  }
  if (path === '/api/lookup' && req.method === 'POST') {
    const { fens, movetime } = await readJson(req);
    if (!Array.isArray(fens)) return send(res, 400, { error: 'fens must be an array' });
    const mt = clampMovetime(movetime ?? DEFAULT_MOVETIME);
    const out = {};
    for (const f of fens) { if (typeof f === 'string') { const e = cached(f, mt); if (e) out[f] = e; } }
    return send(res, 200, { evals: out, movetime: mt });
  }
  if (path === '/api/job' && req.method === 'GET') return send(res, 200, { job: jobView(true) });
  if (path === '/api/job' && req.method === 'POST') {
    if (!engine) return send(res, 503, { error: 'Stockfish not found' });
    if (job && job.status === 'running') return send(res, 409, { error: 'An analysis is already running' });
    const { fens, meta, movetime } = await readJson(req);
    const mt = clampMovetime(movetime ?? DEFAULT_MOVETIME);
    if (!Array.isArray(fens) || !fens.length) return send(res, 400, { error: 'no positions' });
    if (!fens.every((f) => typeof f === 'string' && FEN_RE.test(f))) return send(res, 400, { error: 'bad FEN' });
    const unique = [...new Set(fens)];
    job = {
      id: Date.now().toString(36), status: 'running', fens: unique, done: 0, meta: meta ?? null, movetime: mt,
      fromCache: unique.filter((f) => cached(f, mt)).length, startedAt: Date.now(), finishedAt: null,
    };
    runJob();
    return send(res, 200, { job: jobView(false) });
  }
  if (path === '/api/job/stop' && req.method === 'POST') {
    if (job && job.status === 'running') { job.status = 'stopped'; engine.stop(); }
    return send(res, 200, { job: jobView(false) });
  }
  return send(res, 404, { error: 'not found' });
}

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (path === '/') path = '/index.html';
    const file = files[path];
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(path)] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) send(res, path.startsWith('/api/') ? 400 : 404, { error: e.message });
  }
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use: the server is probably already running in another window.`);
    console.error(`Use that one (open http://localhost:${port}), or close it and start this again.`);
  } else {
    console.error(`Server error: ${e.message}`);
  }
  process.exit(1);
}).listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`Opening Explorer: ${url}`);
  console.log(engine ? `Stockfish: ${enginePath}` : 'Stockfish not found: analysis is disabled (see README).');
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});

process.on('SIGINT', () => { engine?.quit(); process.exit(0); });
