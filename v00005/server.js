require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { discoverSite } = require('./lib/discovery');
const { getState, saveState, getResults, getHistory } = require('./lib/store');
const scanner = require('./lib/scanner');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_SITE_URL = process.env.DEFAULT_SITE_URL || '';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'v00005.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000 }
}));

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function requireAdmin(req, res, next) {
  if (req.session?.admin === true) return next();
  res.redirect('/login');
}
function esc(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function shell(title, body, refresh = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="8">' : ''}<title>${esc(title)}</title><link rel="stylesheet" href="/public/style.css"></head><body><main class="wrap">${body}</main></body></html>`;
}
function redactedState() {
  const s = getState();
  return {
    status: s.status,
    mode: s.mode,
    cycle: s.cycle,
    sourceConnected: Boolean(s.connectedSite),
    discoveredCount: s.discoveredVideos?.length || 0,
    progress: s.progress,
    running: scanner.isRunning(),
    lastError: s.lastError || null
  };
}

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.get('/', (req, res) => res.redirect(req.session?.admin ? '/v00005' : '/login'));
app.get('/login', (req, res) => res.send(shell('Private Console', `
  <section class="card login-card"><div class="eyebrow">PRIVATE ADMIN CONSOLE</div><h1>V00005</h1><p class="muted">Private playback health monitor</p>
  <form method="post" action="/login" class="stack"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Enter</button></form></section>`)));

app.post('/login', (req, res) => {
  const ok = safeEqual(req.body.username, process.env.ADMIN_USERNAME) && safeEqual(req.body.password, process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).send(shell('Access', '<section class="card login-card"><h1>Access denied</h1><a class="button" href="/login">Try again</a></section>'));
  req.session.admin = true;
  res.redirect('/v00005');
});
app.post('/logout', requireAdmin, (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/v00005', requireAdmin, (req, res) => {
  const s = redactedState();
  const p = s.progress || {};
  res.send(shell('V00005', `
    <header class="topbar"><div><div class="eyebrow">PRIVATE MODULE</div><h1>V00005</h1></div><form method="post" action="/logout"><button class="ghost">Logout</button></form></header>
    <section class="hero card"><div><h2>Playback Health Monitor</h2><p class="muted">Private labels only. Source names, titles, URLs and thumbnails stay hidden on-screen.</p></div><span class="status ${String(s.status || 'IDLE').toLowerCase()}">${esc(s.status || 'IDLE')}</span></section>
    <section class="grid two">
      <div class="card"><h3>1. Connect source</h3><form method="post" action="/connect" class="stack"><label>Source URL<input type="password" name="siteUrl" placeholder="Paste source URL" autocomplete="off"></label><button>Connect & Fetch</button></form><p class="small muted">Configured source can also be used without displaying its address.</p></div>
      <div class="card"><h3>2. Scan control</h3><div class="stack"><form method="post" action="/start-once"><button ${!s.discoveredCount || s.running ? 'disabled' : ''}>Start one cycle</button></form><form method="post" action="/start-continuous"><button ${!s.discoveredCount || s.running ? 'disabled' : ''}>Start 24/7 mode</button></form><div class="actions"><form method="post" action="/pause"><button class="ghost" ${s.status !== 'RUNNING' ? 'disabled' : ''}>Pause</button></form><form method="post" action="/resume"><button class="ghost" ${s.status !== 'PAUSED' ? 'disabled' : ''}>Resume</button></form><form method="post" action="/stop"><button class="danger" ${!s.running ? 'disabled' : ''}>Stop</button></form></div></div><p class="small muted">Batch size: 300 • Discovered items: ${s.discoveredCount}</p></div>
    </section>
    <section class="stats">${[['Total',p.total||0],['Checked',p.checked||0],['Passed',p.passed||0],['Failed',p.failed||0],['Ad seen',p.adSeen||0],['Skipped',p.skipped||0],['Batch',`${p.currentBatch||0}/${p.totalBatches||0}`],['Cycle',s.cycle||0]].map(([k,v])=>`<div class="stat card"><span>${k}</span><strong>${v}</strong></div>`).join('')}</section>
    <section class="card"><h3>Source status</h3><p><strong>${s.sourceConnected ? 'CONNECTED' : 'NOT CONNECTED'}</strong></p><p class="small muted">Mode: ${esc(s.mode||'ONCE')} • Last activity: ${esc(p.lastActivityAt||'—')}</p>${s.lastError ? `<p class="error">${esc(s.lastError)}</p>` : ''}<div class="actions"><a class="button ghost" href="/results">Results</a><a class="button ghost" href="/history">History</a></div></section>
  `, s.running));
});

app.post('/connect', requireAdmin, async (req, res) => {
  try {
    const source = String(req.body.siteUrl || '').trim() || DEFAULT_SITE_URL;
    if (!source) throw new Error('Source URL required');
    const d = await discoverSite(source);
    const s = getState();
    s.connectedSite = d.base;
    s.discoveredVideos = d.videoUrls;
    s.discoveryCount = d.videoUrls.length;
    s.status = 'READY';
    s.nextIndex = 0;
    s.lastError = null;
    s.progress = { total:d.videoUrls.length, checked:0, passed:0, failed:0, adSeen:0, skipped:0, currentBatch:0, totalBatches:Math.ceil(d.videoUrls.length/300), startedAt:null, finishedAt:null, lastActivityAt:new Date().toISOString() };
    saveState(s);
    res.redirect('/v00005');
  } catch (err) {
    res.status(400).send(shell('Connect', `<section class="card login-card"><h1>Connection failed</h1><p>${esc(String(err.message || err).replace(/https?:\/\/\S+/gi,'[redacted]'))}</p><a class="button" href="/v00005">Back</a></section>`));
  }
});
app.post('/start-once', requireAdmin, (req,res)=>{ scanner.launch('ONCE', true); res.redirect('/v00005'); });
app.post('/start-continuous', requireAdmin, (req,res)=>{ scanner.launch('CONTINUOUS', true); res.redirect('/v00005'); });
app.post('/pause', requireAdmin, (req,res)=>{ scanner.pause(); res.redirect('/v00005'); });
app.post('/resume', requireAdmin, (req,res)=>{ scanner.resume(); res.redirect('/v00005'); });
app.post('/stop', requireAdmin, (req,res)=>{ scanner.stop(); res.redirect('/v00005'); });

app.get('/results', requireAdmin, (_req, res) => {
  const rows = getResults().slice().reverse().slice(0, 1000).map(r => `<tr><td>${esc(r.item)}</td><td>${esc(r.status)}</td><td>${r.adDetected?'Yes':'No'}</td><td>${r.skipDetected?'Yes':'No'}</td><td>${r.videoPlayed?'Yes':'No'}</td><td>${r.pageLoadMs??'—'}</td><td>${r.adDelayMs??'—'}</td><td>${r.bufferEvents??0}</td><td>${esc(r.error||'')}</td></tr>`).join('');
  res.send(shell('Results', `<header class="topbar"><div><div class="eyebrow">V00005</div><h1>Results</h1></div><a class="button ghost" href="/v00005">Dashboard</a></header><section class="card table-wrap"><table><thead><tr><th>Item</th><th>Status</th><th>Ad</th><th>Skip</th><th>Video</th><th>Load ms</th><th>Ad ms</th><th>Buffers</th><th>Error</th></tr></thead><tbody>${rows||'<tr><td colspan="9">No results yet.</td></tr>'}</tbody></table></section>`));
});
app.get('/history', requireAdmin, (_req,res)=>{
  const rows = getHistory().slice().reverse().map(h=>`<tr><td>${h.cycle}</td><td>${h.checked}</td><td>${h.passed}</td><td>${h.failed}</td><td>${h.adSeen}</td><td>${h.skipped}</td><td>${esc(h.finishedAt||'')}</td></tr>`).join('');
  res.send(shell('History', `<header class="topbar"><div><div class="eyebrow">V00005</div><h1>Cycle History</h1></div><a class="button ghost" href="/v00005">Dashboard</a></header><section class="card table-wrap"><table><thead><tr><th>Cycle</th><th>Checked</th><th>Passed</th><th>Failed</th><th>Ad seen</th><th>Skipped</th><th>Finished</th></tr></thead><tbody>${rows||'<tr><td colspan="7">No completed cycles yet.</td></tr>'}</tbody></table></section>`));
});
app.get('/api/state', requireAdmin, (_req,res)=>res.json(redactedState()));
app.get('/api/results', requireAdmin, (_req,res)=>res.json(getResults().map(r=>({ ...r, url: undefined }))));

app.listen(PORT, () => {
  console.log(`V00005 online on port ${PORT}`);
  scanner.recover();
});
