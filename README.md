# Opening Explorer

A local tool for exploring the openings in **your own games**. It downloads all your games
from chess.com and Lichess into one local database. A Lichess-style explorer then shows, for
any position, which moves were played in your games, how often, and how they turned out for
you (won / drawn / lost). An **Analysis** view runs Stockfish on your games and ranks the
positions you reached from worst to best for you.

Everything runs on your computer, with no CDN. The explorer needs no server. Analysis uses a
small local server, because a web page can't start Stockfish on its own. The downloader talks
only to the public chess.com and Lichess APIs.

## Setup (once)

Needs [Node.js](https://nodejs.org) 16 or newer.

```bash
npm install
```

Copy `config.example.json` to `config.json` and put in your usernames. Each site takes a
list, so several accounts work too:

```json
{
  "chesscom": ["your-chess.com-name"],
  "lichess": ["your-lichess-name"],
  "stockfish": "C:/path/to/stockfish-windows-x86-64-avx2.exe"
}
```

`stockfish` is only needed for analysis. Get the official build from
[stockfishchess.org/download](https://stockfishchess.org/download/). If you leave `stockfish`
out, the server looks for a `stockfish*.exe` inside an `engine/` folder here, then inside
a `stockfish…` folder in your Downloads.

## 1. Download your games

```bash
npm run download
```

Or double-click **`Download Games.cmd`**. You can also skip `config.json` and pass names
directly: `node download.mjs --chesscom NAME --lichess NAME`.

**From the page:** with the local server running (`Open Analysis.cmd`, see below), the
**Download** tab lets you edit your usernames (saved to `config.json`; other settings in that
file are kept) and click **Download latest games**. The downloader's output appears in the
page as it runs, and when new games were added a **Reload** button brings them in. Before you
have any games, the page opens straight to this section.

- The first run downloads everything. That can take a few minutes, because Lichess streams
  about 20–30 games per second.
- **Re-running only adds new games.** Games are keyed by site and game id, so nothing is
  ever duplicated. Existing games are never changed or deleted.
- Before each save, the previous database is copied to `data/backups/` (the last 5 are kept; runs that add nothing make no backup).
  If `data/games.json` can't be read, the downloader stops rather than overwriting it.
- Rate limits: requests are sent one at a time. On HTTP 429 the downloader waits a full minute
  before retrying, as both sites ask. chess.com months that are already complete are skipped
  on later runs. Lichess resumes from your newest stored game.
- Requests carry a generic `User-Agent` with no personal details.

### The database

`data/games.json` holds one record per game:

| Field | Meaning |
|---|---|
| `key` | `chesscom:<id>` or `lichess:<id>` (unique) |
| `source`, `id`, `url`, `account` | Site, game id, link, and which of your accounts played it |
| `date` | ISO date (chess.com: end time, Lichess: start time) |
| `timeControl` | `600+5` (seconds + increment), or `1/86400` for daily/correspondence |
| `timeClass` | `bullet`, `blitz`, `rapid`, `classical` or `daily` |
| `rated`, `variant` | Rated flag; `standard` for normal chess (other variants are kept but not explored) |
| `myColor`, `opponent`, `myRating`, `oppRating` | From your point of view |
| `result`, `termination` | `win` / `draw` / `loss` for you, and how the game ended |
| `eco`, `opening` | Opening code and name as reported by the site |
| `moves`, `uci` | The moves in SAN (`e4 e5 Nf3`) and UCI (`e2e4 e7e5 g1f3`) |
| `pgn` | The original PGN |

The downloader also writes `data/games.js`, a compact copy for the explorer page. A page
opened from disk can't `fetch()` a JSON file, but it can load a script.

## 2. Explore

```bash
npm run build
```

Then open **`index.html`**, or double-click **`Open Explorer.cmd`**. A built copy is already
included, so you only need to rebuild after changing `src/`. Reload the page after each
download to see new games.

- The board starts at the initial position. The table lists every move played from the
  current position in your games, with its share, game count, and a won/drawn/lost bar
  (Σ is the total). **Click a move** to play it, or make any move on the board.
- **Back / Forward / Start / Reset** controls, also on the keys ← → ↑. `F` flips the board.
  Click a move in the move list above the table to jump back to it.
- Filters: **my color** (White / Black / Both), **site**, **time control**, and a **date range**
  (From / To, both inclusive, in your local time zone; leave either empty for no limit, ×
  clears both). They are remembered in your browser.
- Positions are matched by position, not move order, so transpositions merge (like the Lichess
  explorer). Each game counts once per position. The first 25 moves of each game are indexed.
- *Recent games* links to the latest games that reached the current position.

## 3. Analyze with Stockfish

Double-click **`Open Analysis.cmd`**, or run `npm run serve` and open http://localhost:5175.
(The same server also powers the Download tab.)
Keep that window open while you use the page; closing it stops the server. Then click
**Analysis** at the top.

1. Pick which games with the tabs at the top: **Date range** (all games between two dates;
   leave a date empty for no limit) or **Last games** (your most recent *N* games that match
   the other options and reach the chosen move, newest first).
   Then choose **I play** (White / Black), **After my move** (a move number), **Seconds per
   position** (how long Stockfish thinks on each one; default 10, from 0.1 to 600), the
   **time controls**, and the **site**.
2. The page shows how many games reach that move and how many *different* positions that is.
   Repeated positions are analyzed only once and shown with a count (×N).
3. It shows an **estimated time** of *number of games × seconds per position* (games whose
   position is already analyzed are not counted). Click **Analyze with Stockfish…**, then confirm with the
   **Start · about …** button, which shows the same estimate.
4. Stockfish thinks for the chosen time on each position, using all but two CPU threads. Its
   memory (hash) grows with the time, about 50 MB per second rounded up to a power of two:
   512 MB up to 10 s, 1 GB to 20 s, 2 GB to 40 s, 4 GB to 80 s, and 8 GB beyond that (never
   more than a quarter of your RAM). On a 10 s search 512 MB is only about 40% used, so more
   memory only helps on longer searches. Results
   appear while it runs, **sorted from your worst evaluation to your best**. **Stop** ends
   early and keeps every finished position.

Each row shows the evaluation from your side (e.g. `−1.20`, or `#−3` for a mate against
you), the number of games and their won–drawn–lost record, the line played, and Stockfish's
best reply for your opponent. Click a row to list its games. **Explore** opens the line in the
explorer.

The position used is the one right after *your* move N (for White after ply 2N−1, for Black
after ply 2N). Games that ended earlier are left out and counted separately.

Evaluations are saved in `data/evals.json`, one per position, and reused by later runs, so
nothing is analyzed twice. An eval is reused when it was searched at least as long as the
current setting. Asking for more time re-analyzes those positions, and the deeper result
replaces the shallower one. Nothing is ever removed from that file. Analysis runs in the server, so it keeps
going if you close or reload the page, and the page picks it up again when reopened. The API
only answers requests from this page on localhost.

## Tests

```bash
node test/explorer.test.mjs
```

This replays every game with chess.js and checks the explorer's counts for every position
against that brute-force count, with several filter combinations.

## Files

| Path | What |
|---|---|
| `download.mjs` | Downloader: chess.com + Lichess → `data/games.json` and `data/games.js` |
| `src/main.js` | Explorer UI (board, move table, filters) |
| `src/explorer.js` | Position index and statistics |
| `src/index.html`, `src/style.css` | Page and styles; `build.mjs` copies/bundles them |
| `src/analysis.js` | Analysis view (selection, estimate, results) |
| `src/download.js` | Download view (usernames, download progress) |
| `serve.mjs`, `engine.mjs` | Local server with the analysis API, and the Stockfish (UCI) wrapper |
| `build.mjs` | Build script |
| `data/` | Your games, backups and `evals.json` (git-ignored) |
| `config.json` | Your usernames and Stockfish path (git-ignored) |

## Credits and licenses

The built page (`dist/`) bundles the following open-source software:

- **[chessground](https://github.com/lichess-org/chessground)** 9.2.1, the Lichess board UI,
  © Thibault Duplessis and contributors, **GPL-3.0-or-later**. Its assets include the
  Lichess "brown" board theme.
  License: [`licenses/chessground-GPL-3.0.txt`](licenses/chessground-GPL-3.0.txt)
- **cburnett piece set** (shipped in chessground's `chessground.cburnett.css`), by
  Colin M.L. Burnett, licensed **GPLv2+** (as used by Lichess; see
  [lichess-org/lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md)).
- **[chess.js](https://github.com/jhlywa/chess.js)** 1.4.0, move generation and PGN parsing
  (in the page and in the downloader), © Jeff Hlywa, **BSD-2-Clause**.
  License: [`licenses/chess.js-BSD-2-Clause.txt`](licenses/chess.js-BSD-2-Clause.txt)
- **[Stockfish](https://stockfishchess.org)** (GPL-3.0), © the Stockfish developers. It is
  **not included** here. You download it yourself, and it runs as a separate program that the
  local server talks to over the UCI protocol.
- **[esbuild](https://github.com/evanw/esbuild)** (MIT), used only at build time. It is not
  included in the built app.

Because the built bundle contains GPL-3.0 code, this project as a whole is distributed under
**GPL-3.0-or-later**.

Game data comes from the [chess.com Published-Data API](https://www.chess.com/news/view/published-data-api)
and the [Lichess API](https://lichess.org/api). Your downloaded games stay on your computer.
