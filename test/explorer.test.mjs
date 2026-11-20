// Checks the position index against a brute-force replay of every game.
// Usage: node test/explorer.test.mjs [path/to/games.js]   (defaults to data/games.js)
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { buildIndex, filterGames, statsFor, keyAfter, MAX_PLY, START_KEY } from '../src/explorer.js';

const fenKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

const file = process.argv[2] || new URL('../data/games.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const data = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;$/, ''));
const games = data.games.map((r) => Object.fromEntries(data.fields.map((f, i) => [f, r[i]])));

let t = Date.now();
const index = buildIndex(games);
console.log(`${games.length} games indexed in ${Date.now() - t} ms`);

// Brute force with chess.js: FEN key -> Map(gameIdx -> next SAN of first visit),
// plus one UCI path to each position to look it up in the index.
t = Date.now();
const brute = new Map();
const pathTo = new Map();
games.forEach((g, gi) => {
  const c = new Chess();
  const path = [];
  const sans = g.moves ? g.moves.split(' ') : [];
  for (let ply = 0; ; ply++) {
    const k = fenKey(c.fen());
    if (!brute.has(k)) { brute.set(k, new Map()); pathTo.set(k, path.slice()); }
    const m = brute.get(k);
    const san = ply < MAX_PLY ? sans[ply] : undefined;
    let mv = null;
    if (san) { try { mv = c.move(san); } catch {} }
    if (!m.has(gi)) m.set(gi, mv ? mv.san : null);
    if (mv) path.push(mv.from + mv.to + (mv.promotion || ''));
    if (!mv) break;
  }
});
console.log(`brute force in ${Date.now() - t} ms, ${brute.size} positions (index has ${index.size})`);

let fails = 0, checked = 0;
for (const prefs of [
  { color: 'both', source: 'all', time: ['bullet', 'blitz', 'rapid', 'classical', 'daily'] },
  { color: 'white', source: 'all', time: ['bullet', 'blitz', 'rapid', 'classical', 'daily'] },
  { color: 'black', source: 'lichess', time: ['blitz', 'rapid'] },
]) {
  const active = filterGames(games, prefs);
  for (const [k, m] of brute) {
    const exp = { total: [0, 0, 0], moves: new Map() };
    for (const [gi, san] of m) {
      if (!active[gi]) continue;
      const r = { win: 0, draw: 1, loss: 2 }[games[gi].result];
      exp.total[r]++;
      if (san) {
        if (!exp.moves.has(san)) exp.moves.set(san, [0, 0, 0]);
        exp.moves.get(san)[r]++;
      }
    }
    const got = statsFor(index, keyAfter(pathTo.get(k)), active);
    const same = (s, e) => s.win === e[0] && s.draw === e[1] && s.loss === e[2] && s.games === e[0] + e[1] + e[2];
    let ok = same(got.total, exp.total) && got.moves.length === exp.moves.size;
    for (const mv of got.moves) ok = ok && exp.moves.has(mv.san) && same(mv, exp.moves.get(mv.san));
    checked++;
    if (!ok && fails++ < 5) console.log('MISMATCH', k, JSON.stringify(got), JSON.stringify([...exp.moves]));
  }
}
const s = statsFor(index, START_KEY, filterGames(games, { color: 'both', source: 'all', time: ['bullet', 'blitz', 'rapid', 'classical', 'daily'] }));
console.log('start position:', s.total, s.moves.slice(0, 3));
console.log(fails ? `FAIL: ${fails} of ${checked} position checks differ` : `OK: ${checked} position checks match`);
process.exitCode = fails ? 1 : 0;
