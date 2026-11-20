// Analysis view: pick games, evaluate the position after your move N with Stockfish
// (via the local server), and list the positions from worst to best for you.
import { Chess } from 'chess.js';
import { Board } from './explorer.js';

const $ = (id) => document.getElementById(id);
const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];
const SHOW_STEP = 200;
const API_VERSION = 3; // must match serve.mjs
const MIN_SECONDS = 0.1;
const MAX_SECONDS = 600;

const posKey = (fen) => fen.split(' ').slice(0, 4).join(' ');
const fmtInt = (n) => n.toLocaleString('en-US');

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

// White-POV engine entry -> sortable number from my side (higher is better for me).
export function myScore(e, color) {
  let s;
  if (e.mate != null) s = e.mate > 0 ? 100000 - e.mate * 10 : -100000 - e.mate * 10;
  else s = e.cp ?? 0;
  return color === 'white' ? s : -s;
}

function fmtEval(e, color) {
  const sign = color === 'white' ? 1 : -1;
  if (e.over === 'checkmate') return myScore(e, color) > 0 ? 'Mate' : 'Mated';
  if (e.over === 'stalemate') return '½ stalemate';
  if (e.mate != null) {
    const m = e.mate * sign;
    return m > 0 ? `#${m}` : `#−${-m}`;
  }
  const v = ((e.cp ?? 0) * sign) / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
}

function evalClass(score) {
  if (score <= -300) return 'bad3';
  if (score <= -150) return 'bad2';
  if (score <= -60) return 'bad1';
  if (score >= 150) return 'good2';
  if (score >= 60) return 'good1';
  return 'even';
}

// " · 14 threads, 2 GB hash" (empty for servers that don't report it)
function engineInfo(job) {
  const parts = [];
  if (job.threads) parts.push(`${job.threads} threads`);
  if (job.hash) parts.push(job.hash >= 1024 ? `${job.hash / 1024} GB hash` : `${job.hash} MB hash`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lineHtml(sans) {
  return sans.map((san, i) => (i % 2 === 0 ? `<span class="num">${i / 2 + 1}.</span>` : '') + san).join(' ');
}

export function initAnalysis({ games, prefs, savePrefs, onExplore }) {
  const an = (prefs.an = {
    color: 'white', move: 10, seconds: 10, source: 'all', time: TIME_CLASSES.slice(),
    mode: 'dates', from: '', to: '', last: 100, // mode: 'dates' (date range) or 'last' (last N games)
    ...(prefs.an || {}),
  });
  if (!(Number.isFinite(an.seconds) && an.seconds > 0)) an.seconds = 10;
  if (!(Number.isFinite(an.last) && an.last >= 1)) an.last = 100;
  if (!(Number.isFinite(an.move) && an.move >= 1)) an.move = 10;
  let server = null; // { engine, min, max } once the local server answers
  const movetime = () => Math.round(an.seconds * 1000);
  let groups = []; // [{ key, fen, games: [gi], lines: Map(line -> count) }]
  let selected = { games: 0, short: 0, first: '', lastDay: '' };
  // Game indices from newest to oldest, for "last N games".
  const newestFirst = games.map((_, i) => i).sort((a, b) => (games[a].date < games[b].date ? 1 : games[a].date > games[b].date ? -1 : b - a));
  let evals = {}; // fen -> entry (White POV)
  let job = null;
  let pollTimer = null;
  let lookupSeq = 0;
  let shown = SHOW_STEP;
  const open = new Set();

  // ---------- selection ----------
  function compute() {
    const ply = an.color === 'white' ? 2 * an.move - 1 : 2 * an.move;
    const times = new Set(an.time);
    const byKey = new Map();
    let n = 0, short = 0, first = '', lastDay = '';
    const byLast = an.mode === 'last';
    // "Last N games" walks from the newest game back and takes the first N that reach the move.
    const order = byLast ? newestFirst : games.map((_, i) => i);
    for (const gi of order) {
      if (byLast && n >= an.last) break;
      const g = games[gi];
      if (g.myColor !== an.color || !times.has(g.timeClass)) continue;
      if (an.source !== 'all' && g.source !== an.source) continue;
      if (!byLast && ((an.from && g.day < an.from) || (an.to && g.day > an.to))) continue;
      const ucis = g.uci ? g.uci.split(' ') : [];
      if (ucis.length < ply) { short++; continue; }
      if (!first || g.day < first) first = g.day;
      if (!lastDay || g.day > lastDay) lastDay = g.day;
      const b = new Board();
      for (let i = 0; i < ply; i++) b.play(ucis[i]);
      const fen = b.fen();
      const key = posKey(fen);
      let grp = byKey.get(key);
      if (!grp) byKey.set(key, (grp = { key, fen, games: [], lines: new Map() }));
      grp.games.push(gi);
      const line = g.moves.split(' ').slice(0, ply).join(' ');
      grp.lines.set(line, (grp.lines.get(line) || 0) + 1);
      n++;
    }
    groups = [...byKey.values()];
    for (const grp of groups) {
      grp.line = [...grp.lines.entries()].sort((a, b) => b[1] - a[1])[0][0].split(' ');
      const r = { win: 0, draw: 0, loss: 0 };
      for (const gi of grp.games) r[games[gi].result]++;
      grp.res = r;
    }
    selected = { games: n, short, first, lastDay };
    shown = SHOW_STEP;
    open.clear();
  }

  async function lookup() {
    if (!server) return;
    const seq = ++lookupSeq;
    try {
      const r = await api('/api/lookup', { fens: groups.map((g) => g.fen), movetime: movetime() });
      if (seq !== lookupSeq) return;
      Object.assign(evals, r.evals);
    } catch { /* server went away */ }
    renderSummary();
    renderResults();
  }

  function pending() {
    let pos = 0, gms = 0;
    for (const g of groups) if (!evals[g.fen]) { pos++; gms += g.games.length; }
    return { pos, games: gms };
  }

  // ---------- server ----------
  async function api(path, body) {
    const res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function connect() {
    if (location.protocol === 'file:') { renderEngine(); return; }
    try {
      const s = await api('/api/status');
      // A server started before an update answers without these fields; fall back to defaults.
      const sec = (ms, dflt) => (Number.isFinite(ms) ? ms / 1000 : dflt);
      server = {
        engine: s.engine,
        outdated: s.apiVersion !== API_VERSION,
        min: sec(s.minMovetime, MIN_SECONDS),
        max: sec(s.maxMovetime, MAX_SECONDS),
      };
      $('an-seconds').min = server.min;
      $('an-seconds').max = server.max;
    } catch { server = null; }
    renderEngine();
    if (!server) return;
    try {
      const { job: j } = await api('/api/job');
      if (j) {
        job = j;
        Object.assign(evals, j.results);
        if (j.status === 'running' && j.meta) {
          // Picking up a run that is still going: show its selection.
          Object.assign(an, j.meta);
          savePrefs();
          syncForm();
          compute();
          startPolling();
        }
      }
    } catch { /* ignore */ }
    renderAll();
    lookup();
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1500);
  }

  async function poll() {
    try {
      const { job: j } = await api('/api/job');
      job = j;
      if (j) Object.assign(evals, j.results);
      if (!j || j.status !== 'running') clearInterval(pollTimer);
    } catch {
      clearInterval(pollTimer);
      job = job && { ...job, status: 'error', error: 'Lost connection to the local server.' };
    }
    renderProgress();
    renderSummary();
    renderResults();
  }

  async function start() {
    $('an-confirm').hidden = true;
    const fens = groups.filter((g) => !evals[g.fen]).map((g) => g.fen);
    try {
      const r = await api('/api/job', { fens, meta: { ...an }, movetime: movetime() });
      job = r.job;
      startPolling();
    } catch (e) {
      alert(`Could not start: ${e.message}`);
    }
    renderAll();
  }

  async function stop() {
    try { job = (await api('/api/job/stop', {})).job; } catch { /* ignore */ }
    renderAll();
  }

  // ---------- rendering ----------
  const running = () => job && job.status === 'running';

  function renderEngine() {
    const el = $('an-engine');
    if (location.protocol === 'file:') {
      el.innerHTML = 'Analysis needs the local server, because a page opened from disk can’t run Stockfish. Double-click <b>Open Analysis.cmd</b> (or run <code>npm run serve</code> and open <a href="http://localhost:5175">localhost:5175</a>).';
      el.className = 'an-engine warn';
    } else if (!server) {
      el.textContent = 'Can’t reach the local server. Is it still running?';
      el.className = 'an-engine warn';
    } else if (server.outdated) {
      el.innerHTML = 'The local server is from an older version of this tool. Close the <b>Open Analysis</b> window (or stop <code>npm run serve</code>), start it again, then reload this page.';
      el.className = 'an-engine warn';
    } else if (!server.engine || !server.engine.ok) {
      el.innerHTML = 'Stockfish wasn’t found. Put it in the <code>engine</code> folder or set <code>"stockfish"</code> in config.json, then restart the server.';
      el.className = 'an-engine warn';
    } else {
      el.textContent = server.engine.name;
      el.className = 'an-engine muted';
    }
  }

  function syncForm() {
    for (const b of document.querySelectorAll('[data-an-color]')) b.classList.toggle('on', b.dataset.anColor === an.color);
    for (const b of document.querySelectorAll('[data-an-source]')) b.classList.toggle('on', b.dataset.anSource === an.source);
    for (const b of document.querySelectorAll('[data-an-time]')) b.classList.toggle('on', an.time.includes(b.dataset.anTime));
    $('an-move').value = an.move;
    $('an-seconds').value = an.seconds;
    $('an-from').value = an.from;
    $('an-to').value = an.to;
    $('an-from').max = an.to || '';
    $('an-to').min = an.from || '';
    $('an-last').value = an.last;
    for (const b of document.querySelectorAll('[data-an-mode]')) {
      const on = b.dataset.anMode === an.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const el of document.querySelectorAll('[data-an-only]')) el.hidden = el.dataset.anOnly !== an.mode;
    const locked = running();
    for (const el of document.querySelectorAll('#an-form button, #an-form input')) el.disabled = locked;
  }

  function renderSummary() {
    const p = pending();
    const sec = an.seconds;
    const repeats = selected.games - groups.length;
    let txt;
    if (an.mode === 'last') {
      txt = selected.games < an.last
        ? `Only <b>${fmtInt(selected.games)}</b> of your games reach move ${an.move} with these filters`
        : `Your last <b>${fmtInt(selected.games)}</b> games that reach move ${an.move}`;
      if (selected.games) txt += ` <span class="muted">(${selected.first} to ${selected.lastDay})</span>`;
    } else {
      txt = `<b>${fmtInt(selected.games)}</b> games reach your move ${an.move}`;
    }
    if (selected.games) txt += ` · <b>${fmtInt(groups.length)}</b> different positions`;
    if (repeats > 0) txt += ` (${fmtInt(repeats)} repeats)`;
    if (selected.short) txt += ` · <span class="muted">${fmtInt(selected.short)} ended earlier</span>`;
    $('an-summary').innerHTML = txt;

    const est = p.games * sec; // estimate: games still to analyze × seconds per position
    $('an-est').innerHTML = !selected.games ? ''
      : p.pos === 0 ? 'All of these positions are already analyzed.'
      : `Estimated time: <b>${fmtDuration(est)}</b> <span class="muted">(${fmtInt(p.games)} games × ${sec} s${p.games !== selected.games ? `; ${fmtInt(selected.games - p.games)} already analyzed` : ''}). Repeated positions run once, so it may finish sooner.</span>`;
    const canRun = !!(server && !server.outdated && server.engine && server.engine.ok) && p.pos > 0 && !running();
    $('an-run').disabled = !canRun;
    $('an-go').textContent = `Start · about ${fmtDuration(est)}`;
    $('an-confirm-text').innerHTML = `Stockfish will analyze <b>${fmtInt(p.pos)}</b> positions from <b>${fmtInt(p.games)}</b> games, ${sec} s each. Estimated time: <b>${fmtDuration(est)}</b>. You can stop at any time; finished positions are kept.`;
    if (!canRun) $('an-confirm').hidden = true;
  }

  function renderProgress() {
    const el = $('an-progress');
    if (!job || (job.status !== 'running' && !job.done && job.status !== 'error')) { el.hidden = true; return; }
    el.hidden = false;
    const pctDone = job.total ? (100 * job.done) / job.total : 0;
    $('an-bar').style.width = pctDone + '%';
    const left = (job.total - job.done) * (job.movetime / 1000);
    const elapsed = ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
    const label = {
      running: `Analyzing… ${fmtInt(job.done)} of ${fmtInt(job.total)} positions · ${fmtDuration(elapsed)} elapsed · about ${fmtDuration(left)} left${engineInfo(job)}`,
      done: `Finished: ${fmtInt(job.total)} positions in ${fmtDuration(elapsed)}`,
      stopped: `Stopped after ${fmtInt(job.done)} of ${fmtInt(job.total)} positions`,
      error: `Error: ${job.error || 'unknown'}`,
    }[job.status];
    $('an-progress-text').textContent = label;
    $('an-stop').hidden = job.status !== 'running';
    syncForm();
  }

  function bestSan(fen, uci) {
    if (!uci) return '';
    try {
      const m = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      return m ? m.san : uci;
    } catch { return uci; }
  }

  function renderResults() {
    const color = an.color;
    const rows = groups.filter((g) => evals[g.fen]).map((g) => ({ g, e: evals[g.fen], s: myScore(evals[g.fen], color) }));
    rows.sort((a, b) => a.s - b.s || b.g.games.length - a.g.games.length);
    const gamesDone = rows.reduce((n, r) => n + r.g.games.length, 0);
    $('an-results-head').textContent = rows.length
      ? `${fmtInt(rows.length)} positions (${fmtInt(gamesDone)} games), worst for you first`
      : '';
    $('an-results').hidden = !rows.length;
    const body = rows.slice(0, shown).map(({ g, e, s }, i) => {
      const n = g.games.length;
      const isOpen = open.has(g.key);
      const gamesList = isOpen ? `<tr class="an-games"><td colspan="6">${g.games.slice().reverse().map((gi) => {
        const x = games[gi];
        return `<a class="game ${x.result}" href="${x.url}" target="_blank" rel="noopener noreferrer"><span class="res"></span>
          <span class="g-opp">${escapeHtml(x.opponent || '?')}${x.oppRating ? ` <span class="muted">${x.oppRating}</span>` : ''}</span>
          <span class="muted">${x.day} · ${x.timeClass} · ${x.source === 'lichess' ? 'Lichess' : 'chess.com'}</span></a>`;
      }).join('')}</td></tr>` : '';
      return `<tr class="an-row${isOpen ? ' open' : ''}" data-key="${escapeHtml(g.key)}" tabindex="0" title="Show the games">
        <td class="an-rank">${i + 1}</td>
        <td><span class="ev ${evalClass(s)}">${fmtEval(e, color)}</span></td>
        <td class="an-count">${n > 1 ? `<b>×${n}</b>` : '1'}<span class="an-wdl muted">${g.res.win}–${g.res.draw}–${g.res.loss}</span></td>
        <td class="an-line">${lineHtml(g.line)}</td>
        <td class="an-best">${e.best ? escapeHtml(bestSan(g.fen, e.best)) : ''}<span class="muted">${e.depth ? ` d${e.depth}` : ''}</span></td>
        <td><button class="ghost an-explore" data-explore="${escapeHtml(g.key)}" title="Open this line in the explorer">Explore</button></td>
      </tr>${gamesList}`;
    }).join('');
    $('an-body').innerHTML = body;
    $('an-more').hidden = rows.length <= shown;
    $('an-more').textContent = `Show more (${fmtInt(rows.length - shown)} left)`;
  }

  function renderAll() {
    syncForm();
    renderSummary();
    renderProgress();
    renderResults();
  }

  function changed() {
    savePrefs();
    compute();
    $('an-confirm').hidden = true;
    renderAll();
    lookup();
  }

  // ---------- events ----------
  for (const b of document.querySelectorAll('[data-an-color]')) b.onclick = () => { an.color = b.dataset.anColor; changed(); };
  for (const b of document.querySelectorAll('[data-an-source]')) b.onclick = () => { an.source = b.dataset.anSource; changed(); };
  for (const b of document.querySelectorAll('[data-an-time]')) {
    b.onclick = () => {
      const t = b.dataset.anTime;
      an.time = an.time.includes(t) ? an.time.filter((x) => x !== t) : an.time.concat(t);
      changed();
    };
  }
  $('an-seconds').addEventListener('change', () => {
    const v = Number($('an-seconds').value);
    const lo = server ? server.min : MIN_SECONDS;
    const hi = server ? server.max : MAX_SECONDS;
    // Out-of-range values snap to the limits; an empty or invalid box keeps the old value.
    const clamped = Math.min(hi, Math.max(lo, Math.round(v * 10) / 10));
    if ($('an-seconds').value !== '' && Number.isFinite(clamped)) an.seconds = clamped;
    // Evals are only shown if they were searched at least this long, so look them up again.
    evals = {};
    changed();
  });
  $('an-move').addEventListener('change', () => {
    const v = Math.round(Number($('an-move').value));
    an.move = Math.min(200, Math.max(1, Number.isFinite(v) ? v : 10));
    changed();
  });
  const onDate = () => {
    an.from = $('an-from').value;
    an.to = $('an-to').value;
    if (an.from && an.to && an.from > an.to) [an.from, an.to] = [an.to, an.from];
    changed();
  };
  $('an-from').addEventListener('change', onDate);
  $('an-to').addEventListener('change', onDate);
  $('an-date-clear').onclick = () => { an.from = an.to = ''; changed(); };
  for (const b of document.querySelectorAll('[data-an-mode]')) b.onclick = () => { an.mode = b.dataset.anMode; changed(); };
  $('an-last').addEventListener('change', () => {
    const v = Math.round(Number($('an-last').value));
    if ($('an-last').value !== '' && Number.isFinite(v)) an.last = Math.min(100000, Math.max(1, v));
    changed();
  });

  $('an-run').onclick = () => { $('an-confirm').hidden = false; $('an-go').focus(); };
  $('an-cancel').onclick = () => { $('an-confirm').hidden = true; };
  $('an-go').onclick = start;
  $('an-stop').onclick = stop;
  $('an-more').onclick = () => { shown += SHOW_STEP; renderResults(); };

  $('an-body').addEventListener('click', (e) => {
    const ex = e.target.closest('[data-explore]');
    if (ex) {
      const g = groups.find((x) => x.key === ex.dataset.explore);
      if (g) onExplore(an.color, g.line);
      return;
    }
    if (e.target.closest('a')) return;
    const row = e.target.closest('.an-row');
    if (!row) return;
    const k = row.dataset.key;
    if (open.has(k)) open.delete(k); else open.add(k);
    renderResults();
  });
  $('an-body').addEventListener('keydown', (e) => {
    const row = e.target.closest('.an-row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });

  compute();
  renderAll();
  connect();

  return { refresh: renderAll };
}
