// Download view: edit your usernames (saved to config.json) and fetch new games,
// both through the local server.
const $ = (id) => document.getElementById(id);
const fmtInt = (n) => n.toLocaleString('en-US');
const USER_RE = /^[A-Za-z0-9_-]{1,50}$/;

const splitNames = (s) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function initDownload({ games }) {
  let server = false;
  let saved = { chesscom: [], lichess: [] };
  let dl = null;
  let pollTimer = null;

  async function api(path, body) {
    const res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- current database ----------
  function renderStats() {
    if (!games.length) { $('dl-stats').textContent = 'No games downloaded yet.'; return; }
    const by = { chesscom: 0, lichess: 0 };
    let latest = '';
    for (const g of games) { by[g.source] = (by[g.source] || 0) + 1; if (g.date > latest) latest = g.date; }
    const updated = window.EXPLORER_DATA?.updatedAt ? new Date(window.EXPLORER_DATA.updatedAt).toLocaleString() : '?';
    $('dl-stats').innerHTML = `<b>${fmtInt(games.length)}</b> games loaded (chess.com ${fmtInt(by.chesscom)}, Lichess ${fmtInt(by.lichess)}).
      Latest game ${latest ? new Date(latest).toLocaleDateString() : '?'} · last download ${updated}.`;
  }

  // ---------- usernames ----------
  function current() {
    return { chesscom: splitNames($('dl-chesscom').value), lichess: splitNames($('dl-lichess').value) };
  }
  const same = (a, b) => a.join(',').toLowerCase() === b.join(',').toLowerCase();
  function dirty() {
    const c = current();
    return !same(c.chesscom, saved.chesscom) || !same(c.lichess, saved.lichess);
  }
  function invalid() {
    const c = current();
    return [...c.chesscom, ...c.lichess].filter((n) => !USER_RE.test(n));
  }

  function renderNames(msg) {
    const bad = invalid();
    const el = $('dl-save-status');
    if (bad.length) { el.textContent = `Not a valid username: ${bad.join(', ')}`; el.className = 'dl-note warn'; }
    else if (msg) { el.textContent = msg; el.className = 'dl-note ok'; }
    else if (dirty()) { el.textContent = 'Unsaved changes'; el.className = 'dl-note'; }
    else { el.textContent = server ? 'Saved' : ''; el.className = 'dl-note muted'; }
    $('dl-save').disabled = !server || !!bad.length || !dirty();
    const none = !current().chesscom.length && !current().lichess.length;
    $('dl-run').disabled = !server || running() || !!bad.length || none;
  }

  async function save() {
    try {
      saved = await api('/api/config', current());
      $('dl-chesscom').value = saved.chesscom.join(', ');
      $('dl-lichess').value = saved.lichess.join(', ');
      renderNames('Saved to config.json');
      return true;
    } catch (e) {
      $('dl-save-status').textContent = e.message;
      $('dl-save-status').className = 'dl-note warn';
      return false;
    }
  }

  // ---------- downloading ----------
  const running = () => dl && dl.status === 'running';

  async function run() {
    if (dirty() && !(await save())) return; // download with what's in the boxes
    try {
      dl = (await api('/api/download', {})).download;
      startPolling();
    } catch (e) {
      alert(`Could not start the download: ${e.message}`);
    }
    renderRun();
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1000);
  }

  async function poll() {
    try {
      dl = (await api('/api/download')).download;
    } catch {
      clearInterval(pollTimer);
      dl = dl && { ...dl, status: 'error', log: dl.log.concat('Lost connection to the local server.') };
    }
    if (!running()) clearInterval(pollTimer);
    renderRun();
  }

  function renderRun() {
    renderNames();
    const box = $('dl-progress');
    if (!dl) { box.hidden = true; return; }
    box.hidden = false;
    const log = $('dl-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = dl.log.join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
    const status = $('dl-status');
    $('dl-reload').hidden = true;
    if (dl.status === 'running') {
      status.textContent = 'Downloading… you can keep using the other tabs.';
      status.className = 'dl-status';
    } else if (dl.status === 'done') {
      const n = dl.added ?? 0;
      // The page already has them if its data was written after this download started.
      const loadedAt = Date.parse(window.EXPLORER_DATA?.updatedAt || '') || 0;
      const shown = loadedAt >= dl.startedAt;
      status.textContent = !n ? 'Done: no new games.'
        : `Done: ${fmtInt(n)} new game${n === 1 ? '' : 's'} added${shown ? ' and loaded.' : '.'}`;
      status.className = 'dl-status ok';
      $('dl-reload').hidden = !n || shown;
    } else {
      status.textContent = 'The download stopped with an error (see the log). Games saved before the error are kept.';
      status.className = 'dl-status warn';
    }
  }

  // ---------- server ----------
  async function connect() {
    if (location.protocol === 'file:') {
      $('dl-server').innerHTML = 'Downloading from this page needs the local server. Double-click <b>Open Analysis.cmd</b> (it starts the server and opens this page), or use <b>Download Games.cmd</b>.';
      $('dl-server').hidden = false;
      renderNames();
      return;
    }
    try {
      saved = await api('/api/config');
      server = true;
      $('dl-server').hidden = true;
    } catch (e) {
      $('dl-server').textContent = /not found/i.test(e.message)
        ? 'The local server is from an older version. Close its window, start Open Analysis.cmd again, then reload this page.'
        : `Can’t reach the local server (${e.message}). Is it still running?`;
      $('dl-server').hidden = false;
      renderNames();
      return;
    }
    $('dl-chesscom').value = saved.chesscom.join(', ');
    $('dl-lichess').value = saved.lichess.join(', ');
    try {
      dl = (await api('/api/download')).download;
      if (running()) startPolling();
    } catch { /* ignore */ }
    renderRun();
  }

  // ---------- events ----------
  for (const id of ['dl-chesscom', 'dl-lichess']) {
    $(id).addEventListener('input', () => renderNames());
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('dl-save').disabled) save(); });
  }
  $('dl-save').onclick = save;
  $('dl-run').onclick = run;
  $('dl-reload').onclick = () => location.reload();

  renderStats();
  renderNames();
  connect();
}
