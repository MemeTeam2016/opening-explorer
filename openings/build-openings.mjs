// Turns the Lichess opening tables (openings/*.tsv) into src/openings-data.json:
// { "<position key>": "B12 Caro-Kann Defense: Advance Variation", ... }
// Keys are the same position keys the explorer uses (src/explorer.js Board.key()), so a
// game is matched by position, which also catches transpositions.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { Board } from '../src/explorer.js';

const here = dirname(fileURLToPath(import.meta.url));

export function buildOpenings() {
  const out = {};
  let lines = 0, dupes = 0;
  for (const f of ['a', 'b', 'c', 'd', 'e']) {
    const rows = readFileSync(join(here, `${f}.tsv`), 'utf8').split(/\r?\n/).slice(1);
    for (const row of rows) {
      if (!row.trim()) continue;
      const [eco, name, pgn] = row.split('\t');
      const chess = new Chess();
      const board = new Board();
      for (const san of pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/)) {
        const m = chess.move(san); // throws on a bad line, so a broken table fails the build
        board.play(m.from + m.to + (m.promotion || ''));
      }
      const key = board.key();
      lines++;
      if (out[key]) { dupes++; continue; } // same position reached by another move order: keep the first name
      out[key] = `${eco} ${name}`;
    }
  }
  writeFileSync(join(here, '..', 'src', 'openings-data.json'), JSON.stringify(out));
  return { lines, positions: Object.keys(out).length, dupes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(buildOpenings());
}
