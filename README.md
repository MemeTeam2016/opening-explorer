# Opening Explorer

A local tool for exploring the openings in **your own games**. It downloads all your games
from chess.com and Lichess into one local database. A Lichess-style explorer then shows, for
any position, which moves were played in your games, how often, and how they turned out for
you (won / drawn / lost).

Everything runs on your computer. The page needs no server and no CDN. The downloader talks
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
  "lichess": ["your-lichess-name"]
}
```

## 1. Download your games

```bash
npm run download
```

Or double-click **`Download Games.cmd`**. You can also skip `config.json` and pass names
directly: `node download.mjs --chesscom NAME --lichess NAME`.

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
- Filters: **my color** (White / Black / Both), **site**, and **time control**. They are
  remembered in your browser.
- Positions are matched by position, not move order, so transpositions merge (like the Lichess
  explorer). Each game counts once per position. The first 25 moves of each game are indexed.
- *Recent games* links to the latest games that reached the current position.

Optional local server: `npm run serve`, then open http://localhost:5175.

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
| `build.mjs`, `serve.mjs` | Build script and optional local server |
| `data/` | Your games and backups (git-ignored) |
| `config.json` | Your usernames (git-ignored) |

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
- **[esbuild](https://github.com/evanw/esbuild)** (MIT), used only at build time. It is not
  included in the built app.

Because the built bundle contains GPL-3.0 code, this project as a whole is distributed under
**GPL-3.0-or-later**.

Game data comes from the [chess.com Published-Data API](https://www.chess.com/news/view/published-data-api)
and the [Lichess API](https://lichess.org/api). Your downloaded games stay on your computer.
