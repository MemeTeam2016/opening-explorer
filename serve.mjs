// Optional: tiny static server (no dependencies). `npm run serve` -> http://localhost:5175
// Opening index.html directly from disk works too; this is just an alternative.
// EXPLORER_DATA_DIR serves games.js from another folder (used for testing on copies).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.EXPLORER_DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT) || 5175;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const files = {
  '/index.html': join(root, 'index.html'),
  '/dist/app.js': join(root, 'dist/app.js'),
  '/dist/app.css': join(root, 'dist/app.css'),
  '/data/games.js': join(dataDir, 'games.js'),
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = files[path];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(path)] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Opening Explorer: http://localhost:${port}`));
