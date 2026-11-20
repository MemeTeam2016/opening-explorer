// Position index for the explorer.
//
// Every game is replayed from its UCI moves on a tiny board model (much faster than
// chess.js), and each position it passes is filed under a position key. Games that
// reach the same position by different move orders therefore merge, like the Lichess
// opening explorer. Each game counts once per position (its first visit).

export const MAX_PLY = 50; // index the first 25 moves of each game
const RESULT = { win: 0, draw: 1, loss: 2 };
const FILES = 'abcdefgh';
const START = 'rnbqkbnrpppppppp' + '.'.repeat(32) + 'PPPPPPPPRNBQKBNR'; // a8..h8, ..., a1..h1

const sq = (s) => FILES.indexOf(s[0]) + 8 * (8 - Number(s[1]));
const sqName = (i) => FILES[i % 8] + (8 - Math.floor(i / 8));

export class Board {
  constructor() {
    this.b = START.split('');
    this.white = true;
    this.castle = 'KQkq';
    this.ep = '-';
  }
  key() {
    return this.b.join('') + (this.white ? 'w' : 'b') + this.castle + this.ep;
  }
  // Standard FEN (move counters are not tracked, so they are written as 0 1).
  fen() {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.b[r * 8 + f];
        if (p === '.') { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p;
      }
      rows.push(empty ? row + empty : row);
    }
    return `${rows.join('/')} ${this.white ? 'w' : 'b'} ${this.castle} ${this.ep} 0 1`;
  }
  play(uci) {
    const b = this.b;
    const from = sq(uci.slice(0, 2));
    const to = sq(uci.slice(2, 4));
    const piece = b[from];
    const lower = piece.toLowerCase();
    // en passant capture: pawn moves diagonally to an empty square
    if (lower === 'p' && from % 8 !== to % 8 && b[to] === '.') b[(from - from % 8) + (to % 8)] = '.';
    // castling: king moves two files, so move the rook too
    if (lower === 'k' && Math.abs((to % 8) - (from % 8)) === 2) {
      const row = from - (from % 8);
      if (to % 8 === 6) { b[row + 5] = b[row + 7]; b[row + 7] = '.'; }
      else { b[row + 3] = b[row]; b[row] = '.'; }
    }
    const promo = uci[4];
    b[to] = promo ? (this.white ? promo.toUpperCase() : promo.toLowerCase()) : piece;
    b[from] = '.';
    // castling rights
    let c = this.castle;
    if (piece === 'K') c = c.replace(/[KQ]/g, '');
    if (piece === 'k') c = c.replace(/[kq]/g, '');
    for (const s of [from, to]) {
      if (s === 63) c = c.replace('K', '');
      if (s === 56) c = c.replace('Q', '');
      if (s === 7) c = c.replace('k', '');
      if (s === 0) c = c.replace('q', '');
    }
    this.castle = c || '-';
    // en passant square, only when an enemy pawn stands ready to take
    this.ep = '-';
    if (lower === 'p' && Math.abs(to - from) === 16) {
      const enemy = this.white ? 'p' : 'P';
      const f = to % 8;
      if ((f > 0 && b[to - 1] === enemy) || (f < 7 && b[to + 1] === enemy)) this.ep = sqName((from + to) / 2);
    }
    this.white = !this.white;
  }
}

export function keyAfter(ucis) {
  const board = new Board();
  for (const u of ucis) board.play(u);
  return board.key();
}
export const START_KEY = new Board().key();

export function buildIndex(games) {
  const byKey = new Map(); // key -> { games: number[], next: (string|null)[] }
  const results = new Uint8Array(games.length);

  games.forEach((g, gi) => {
    results[gi] = RESULT[g.result] ?? 1;
    const sans = g.moves ? g.moves.split(' ') : [];
    const ucis = g.uci ? g.uci.split(' ') : [];
    const n = Math.min(sans.length, ucis.length, MAX_PLY);
    const board = new Board();
    for (let ply = 0; ; ply++) {
      const k = board.key();
      let e = byKey.get(k);
      if (!e) byKey.set(k, (e = { games: [], next: [] }));
      // A repeated position within one game is counted only the first time.
      if (e.games[e.games.length - 1] !== gi) {
        e.games.push(gi);
        e.next.push(ply < n ? sans[ply] : null);
      }
      if (ply >= n) break;
      board.play(ucis[ply]);
    }
  });

  function each(key, active, fn) {
    const e = byKey.get(key);
    if (!e) return;
    for (let i = 0; i < e.games.length; i++) {
      if (active[e.games[i]]) fn(e.games[i], e.next[i]);
    }
  }

  return {
    results,
    size: byKey.size,
    each,
    gamesAt(key, active) {
      const out = [];
      each(key, active, (gi) => out.push(gi));
      return out; // already in database (date) order
    },
  };
}

// from / to are inclusive 'YYYY-MM-DD' strings ('' = no limit), compared with g.day
// (the game's local date) or, if missing, the date part of g.date.
export function filterGames(games, { color, source, time, from = '', to = '' }) {
  const out = new Uint8Array(games.length);
  const times = new Set(time);
  games.forEach((g, i) => {
    const day = g.day || (g.date || '').slice(0, 10);
    out[i] = (color === 'both' || g.myColor === color)
      && (source === 'all' || g.source === source)
      && times.has(g.timeClass)
      && (!from || day >= from)
      && (!to || day <= to) ? 1 : 0;
  });
  return out;
}

function blank(san) { return { san, games: 0, win: 0, draw: 0, loss: 0 }; }
function addResult(s, r) {
  s.games++;
  if (r === 0) s.win++; else if (r === 1) s.draw++; else s.loss++;
}

// Next-move statistics for one position, from my side of the board.
export function statsFor(index, key, active) {
  const total = blank('');
  const bySan = new Map();
  index.each(key, active, (gi, san) => {
    const r = index.results[gi];
    addResult(total, r);
    if (!san) return;
    let s = bySan.get(san);
    if (!s) bySan.set(san, (s = blank(san)));
    addResult(s, r);
  });
  const moves = [...bySan.values()].sort((a, b) => b.games - a.games || a.san.localeCompare(b.san));
  return { moves, total };
}
