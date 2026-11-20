import { Chessground } from 'chessground';
import { Chess, SQUARES } from 'chess.js';
import { buildIndex, keyAfter, filterGames, statsFor, START_KEY, MAX_PLY } from './explorer.js';

const positionKey = (c) => keyAfter(c.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || '')));

const $ = (id) => document.getElementById(id);
const PREFS_KEY = 'opening-explorer:prefs';
const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

// ---------- data ----------
const data = window.EXPLORER_DATA;
if (!data || !data.games || !data.games.length) {
  document.body.dataset.empty = '1';
  throw new Error('No games loaded. Run: npm run download');
}
const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
const games = data.games.map((row) => {
  const g = {};
  for (const f in F) g[f] = row[F[f]];
  return g;
});
const index = buildIndex(games);

// ---------- prefs ----------
const defaults = { color: 'white', source: 'all', time: TIME_CLASSES.slice() };
let prefs = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  if (saved) prefs = { ...defaults, ...saved };
} catch { /* storage unavailable: use defaults */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// ---------- state ----------
let chess = new Chess();
let history = []; // SANs played from the start
let future = []; // SANs undone with Back, replayed by Forward
let active = filterGames(games, prefs);
let cg;

function setPath(sans) {
  chess = new Chess();
  for (const s of sans) chess.move(s);
  history = sans.slice();
  render();
}

function play(san, { keepFuture = false } = {}) {
  const mv = chess.move(san);
  if (!mv) return;
  history.push(mv.san);
  if (!keepFuture) {
    if (future.length && future[future.length - 1] === mv.san) future.pop();
    else future = [];
  }
  render();
}

function back() {
  if (!history.length) return;
  chess.undo();
  future.push(history.pop());
  render();
}

function forward() {
  if (!future.length) return;
  play(future.pop(), { keepFuture: true });
}

function reset() {
  future = [];
  setPath([]);
}

// ---------- board ----------
function dests() {
  const map = new Map();
  for (const sq of SQUARES) {
    const ms = chess.moves({ square: sq, verbose: true });
    if (ms.length) map.set(sq, ms.map((m) => m.to));
  }
  return map;
}

function lastMoveSquares() {
  const h = chess.history({ verbose: true });
  const m = h[h.length - 1];
  return m ? [m.from, m.to] : undefined;
}

function initBoard() {
  cg = Chessground($('board'), {
    orientation: prefs.color === 'black' ? 'black' : 'white',
    coordinates: true,
    animation: { duration: 160 },
    highlight: { lastMove: true, check: true },
    movable: {
      free: false,
      color: 'both',
      showDests: true,
      events: {
        after: (from, to) => {
          // Promotions from the board default to a queen.
          const mv = chess.moves({ verbose: true }).find((m) => m.from === from && m.to === to && (!m.promotion || m.promotion === 'q'));
          if (mv) play(mv.san); else render();
        },
      },
    },
    draggable: { showGhost: true },
  });
}

function updateBoard() {
  const turn = chess.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: chess.fen(),
    turnColor: turn,
    lastMove: lastMoveSquares(),
    check: chess.inCheck(),
    orientation: prefs.color === 'black' ? 'black' : 'white',
    movable: { color: turn, dests: dests() },
  });
  cg.setAutoShapes([]);
}

function arrowFor(san) {
  const m = new Chess(chess.fen()).move(san);
  if (!m) return;
  cg.setAutoShapes([{ orig: m.from, dest: m.to, brush: 'paleBlue' }]);
}

// ---------- rendering ----------
const pct = (n, total) => (total ? (100 * n) / total : 0);
const fmtPct = (x) => (x >= 10 || x === 0 ? Math.round(x) : x.toFixed(1)) + '%';
const fmtInt = (n) => n.toLocaleString('en-US');

function bar(s) {
  const t = s.win + s.draw + s.loss;
  const seg = (cls, n, label) => {
    const p = pct(n, t);
    if (!n) return '';
    return `<span class="seg-${cls}" style="width:${p}%" title="${label}: ${fmtInt(n)} (${fmtPct(p)})">${p >= 12 ? fmtPct(p) : ''}</span>`;
  };
  return `<div class="wdl">${seg('win', s.win, 'Won')}${seg('draw', s.draw, 'Drawn')}${seg('loss', s.loss, 'Lost')}</div>`;
}

function renderMoves() {
  const { moves, total } = statsFor(index, positionKey(chess), active);
  const body = $('moves-body');
  if (!moves.length) {
    body.innerHTML = `<tr class="none"><td colspan="4">${total.games ? (history.length >= MAX_PLY ? `The explorer stops after move ${MAX_PLY / 2}.` : 'Every game ended here.') : 'No games reached this position.'}</td></tr>`;
  } else {
    body.innerHTML = moves.map((m) => `
      <tr data-san="${m.san}" tabindex="0" role="button" aria-label="Play ${m.san}: ${m.games} games">
        <td class="c-move">${m.san}</td>
        <td class="c-share">${fmtPct(pct(m.games, total.games))}</td>
        <td class="c-games">${fmtInt(m.games)}</td>
        <td class="c-bar">${bar(m)}</td>
      </tr>`).join('');
  }
  $('moves-total').innerHTML = total.games
    ? `<td class="c-move">Σ</td><td class="c-share"></td><td class="c-games">${fmtInt(total.games)}</td><td class="c-bar">${bar(total)}</td>`
    : '';
  return total;
}

function renderPath() {
  const el = $('path');
  if (!history.length) {
    el.innerHTML = '<span class="muted">Starting position</span>';
    return;
  }
  el.innerHTML = history.map((san, i) => {
    const num = i % 2 === 0 ? `<span class="num">${i / 2 + 1}.</span>` : '';
    const cur = i === history.length - 1 ? ' cur' : '';
    return `${num}<button class="mv${cur}" data-ply="${i + 1}">${san}</button>`;
  }).join('');
}

function renderRecent() {
  const list = index.gamesAt(positionKey(chess), active).slice(-8).reverse();
  $('recent-wrap').hidden = !list.length;
  $('recent').innerHTML = list.map((i) => {
    const g = games[i];
    const date = g.date ? g.date.slice(0, 10) : '';
    const src = g.source === 'lichess' ? 'Lichess' : 'chess.com';
    const vs = g.myColor === 'white' ? 'White' : 'Black';
    return `<a class="game ${g.result}" href="${g.url}" target="_blank" rel="noopener noreferrer">
      <span class="res" title="${g.result}"></span>
      <span class="g-main"><span class="g-opp">${escapeHtml(g.opponent || '?')}${g.oppRating ? ` <span class="muted">${g.oppRating}</span>` : ''}</span>
      <span class="g-meta muted">${vs} · ${fmtTime(g)} · ${src} · ${date}</span></span></a>`;
  }).join('');
}

// "600+5" -> "10+5", "1/259200" -> "3 days"
function fmtTime(g) {
  const tc = g.timeControl || '';
  const daily = tc.match(/^1\/(\d+)$/);
  if (daily) {
    const d = Number(daily[1]) / 86400;
    return d === 1 ? '1 day' : `${d} days`;
  }
  const m = tc.match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return g.timeClass || '';
  const base = Number(m[1]) / 60;
  const label = base < 1 ? ({ 15: '¼', 30: '½', 45: '¾' }[m[1]] || (+base.toFixed(2)).toString()) : (+base.toFixed(1)).toString();
  return `${label}+${m[2] || 0} ${g.timeClass}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFilters() {
  for (const b of document.querySelectorAll('[data-color]')) b.classList.toggle('on', b.dataset.color === prefs.color);
  for (const b of document.querySelectorAll('[data-source]')) b.classList.toggle('on', b.dataset.source === prefs.source);
  for (const b of document.querySelectorAll('[data-time]')) b.classList.toggle('on', prefs.time.includes(b.dataset.time));
  let n = 0;
  for (let i = 0; i < active.length; i++) n += active[i];
  $('filter-count').textContent = `${fmtInt(n)} of ${fmtInt(games.length)} games`;
}

function render() {
  updateBoard();
  renderPath();
  renderMoves();
  renderRecent();
  renderFilters();
  $('btn-back').disabled = $('btn-start').disabled = !history.length;
  $('btn-forward').disabled = !future.length;
}

function refilter() {
  active = filterGames(games, prefs);
  savePrefs();
  render();
}

// ---------- events ----------
function wire() {
  $('moves-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-san]');
    if (tr) play(tr.dataset.san);
  });
  $('moves-body').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-san]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); play(tr.dataset.san); }
  });
  $('moves-body').addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-san]');
    if (tr) arrowFor(tr.dataset.san);
  });
  $('moves-body').addEventListener('mouseleave', () => cg.setAutoShapes([]));
  $('path').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ply]');
    if (!b) return;
    const ply = Number(b.dataset.ply);
    future = history.slice(ply).reverse().concat(future);
    setPath(history.slice(0, ply));
  });
  $('btn-start').onclick = () => {
    future = history.slice().reverse().concat(future);
    setPath([]);
  };
  $('btn-back').onclick = back;
  $('btn-forward').onclick = forward;
  $('btn-reset').onclick = reset;
  $('btn-flip').onclick = () => cg.toggleOrientation();

  for (const b of document.querySelectorAll('[data-color]')) {
    b.onclick = () => { prefs.color = b.dataset.color; refilter(); };
  }
  for (const b of document.querySelectorAll('[data-source]')) {
    b.onclick = () => { prefs.source = b.dataset.source; refilter(); };
  }
  for (const b of document.querySelectorAll('[data-time]')) {
    b.onclick = () => {
      const t = b.dataset.time;
      prefs.time = prefs.time.includes(t) ? prefs.time.filter((x) => x !== t) : prefs.time.concat(t);
      refilter();
    };
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); forward(); }
    else if (e.key === 'ArrowUp' || e.key === 'Home') { e.preventDefault(); $('btn-start').click(); }
    else if (e.key === 'f') cg.toggleOrientation();
  });
}

const updated = data.updatedAt ? new Date(data.updatedAt) : null;
$('updated').textContent = updated ? `Updated ${updated.toLocaleDateString()}` : '';
initBoard();
wire();
render();
// Exposed for debugging and tests.
window.explorer = { games, index, get cg() { return cg; }, get active() { return active; }, positionKey: () => positionKey(chess), START_KEY };
