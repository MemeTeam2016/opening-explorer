// Minimal UCI wrapper around a native Stockfish binary.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, homedir } from 'node:os';
import { Chess } from 'chess.js';

// Finds Stockfish: config path first, then ./engine, then ~/Downloads (as unzipped from
// the official stockfishchess.org download).
export function findStockfish(configured, root) {
  if (configured && existsSync(configured)) return configured;
  const isEngine = (f) => /^stockfish.*\.exe$/i.test(f) || /^stockfish[^.]*$/i.test(f);
  const search = (dir, depth) => {
    if (depth < 0 || !existsSync(dir)) return null;
    let entries;
    try { entries = readdirSync(dir); } catch { return null; }
    for (const f of entries) {
      const p = join(dir, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile() && isEngine(f)) return p;
    }
    for (const f of entries) {
      if (!/stockfish|engine/i.test(f)) continue;
      const p = join(dir, f);
      try { if (statSync(p).isDirectory()) { const r = search(p, depth - 1); if (r) return r; } } catch { /* skip */ }
    }
    return null;
  };
  return search(join(root, 'engine'), 3) || search(join(homedir(), 'Downloads'), 3);
}

export class Engine {
  constructor(path) {
    this.path = path;
    this.name = null;
    this.proc = null;
    this.buf = '';
    this.listeners = [];
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        for (const l of this.listeners.slice()) l(line);
      }
    });
    this.proc.on('exit', () => { this.proc = null; });
    this.send('uci');
    await this.waitFor((l) => {
      const m = l.match(/^id name (.+)/);
      if (m) this.name = m[1];
      return l === 'uciok';
    });
    // Leave a couple of cores free so the computer stays responsive.
    const threads = Math.max(1, cpus().length - 2);
    this.send(`setoption name Threads value ${threads}`);
    this.send('setoption name Hash value 512');
    this.send('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  send(cmd) { this.proc.stdin.write(cmd + '\n'); }

  waitFor(pred) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (pred(line)) { this.listeners.splice(this.listeners.indexOf(fn), 1); resolve(line); }
      };
      this.listeners.push(fn);
    });
  }

  // Analyzes one position. Score is from White's point of view.
  async analyze(fen, movetime) {
    // Game already over: no search needed.
    const c = new Chess(fen);
    if (c.isCheckmate()) return { best: null, depth: 0, cp: c.turn() === 'w' ? -100000 : 100000, mate: null, pv: [], over: 'checkmate' };
    if (c.isStalemate()) return { best: null, depth: 0, cp: 0, mate: null, pv: [], over: 'stalemate' };
    await this.start();
    let last = null;
    const onInfo = (l) => {
      if (l.startsWith('info ') && l.includes(' score ') && l.includes(' pv ') && !l.includes(' multipv 2')) last = l;
    };
    this.listeners.push(onInfo);
    this.send(`position fen ${fen}`);
    this.send(`go movetime ${movetime}`);
    const done = await this.waitFor((l) => l.startsWith('bestmove'));
    this.listeners.splice(this.listeners.indexOf(onInfo), 1);
    const best = done.split(' ')[1];
    const whiteToMove = fen.split(' ')[1] === 'w';
    const sign = whiteToMove ? 1 : -1;
    const out = { best: best && best !== '(none)' ? best : null, depth: null, cp: null, mate: null, pv: [] };
    if (last) {
      const depth = last.match(/ depth (\d+)/);
      const cp = last.match(/ score cp (-?\d+)/);
      const mate = last.match(/ score mate (-?\d+)/);
      const pv = last.match(/ pv (.+)$/);
      out.depth = depth ? Number(depth[1]) : null;
      if (cp) out.cp = sign * Number(cp[1]);
      if (mate) out.mate = sign * Number(mate[1]);
      if (pv) out.pv = pv[1].split(' ').slice(0, 8);
    }
    return out;
  }

  stop() { if (this.proc) this.send('stop'); }

  quit() { if (this.proc) { this.send('quit'); this.proc = null; } }
}
