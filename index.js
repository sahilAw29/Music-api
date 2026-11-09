const express = require('express'), mongoose = require('mongoose'), compression = require('compression'), cookies = require('cookie-parser');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), crypto = require('crypto'), path = require('path'), { OAuth2Client } = require('google-auth-library');
const cfg = require('./config');
const { PORT, MONGO_URI, JWT_SECRET, ADMIN_PASS, GOOGLE_CLIENT_ID: GID, DEVELOPER: DEV, DEFAULTS } = cfg;
const AP = '/' + String(cfg.ADMIN_PATH || 'nazriya').replace(/^\/+|\/+$/g, ''); // admin panel path, e.g. /nazriya
const ADMIN_DAYS = +cfg.ADMIN_DAYS || 30, BRANDS = Array.isArray(cfg.BRANDS) ? cfg.BRANDS.filter(b => b && b.logo) : [];
const V = Date.now().toString(36); // cache-buster: new deploy = browsers fetch fresh css/js

const app = express(); app.set('trust proxy', 1); app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' }); next(); });
app.use(compression(), express.json({ limit: '50kb' }), express.urlencoded({ extended: true, limit: '50kb' }), cookies(), express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

/* ── MODELS ── */
const S = mongoose.Schema;
const User = mongoose.model('User', new S({ email: { type: String, unique: true }, name: String, hash: String, googleId: String, picture: String, createdAt: { type: Date, default: Date.now } }));
const Key = mongoose.model('Key', new S({ key: { type: String, unique: true }, user: { type: S.Types.ObjectId, index: true }, email: { type: String, index: true }, name: { type: String, default: 'My API key' },
  plan: { type: String, default: 'free', index: true }, createdBy: { type: String, default: 'user' }, custom: { type: Boolean, default: false },
  limits: { audio: Number, video: Number, search: Number }, used: { audio: { type: Number, default: 0 }, video: { type: Number, default: 0 }, search: { type: Number, default: 0 } },
  rpm: Number, expiresAt: Date, active: { type: Boolean, default: true }, createdAt: { type: Date, default: Date.now } }));
const logSchema = new S({ key: String, email: String, ep: String, q: String, status: Number, ms: Number, ip: String, t: { type: Date, default: Date.now } });
logSchema.index({ t: 1 }, { expireAfterSeconds: 90 * 86400 }); // logs auto-delete after 90 days
const Log = mongoose.model('Log', logSchema);
const Setting = mongoose.model('Setting', new S({ _id: String, upstream: String, upstream2: String, useBackup: Boolean, defaultRpm: Number, freeDays: Number, freeAudio: Number, freeVideo: Number, freeSearch: Number, maintenance: Boolean, freeOff: Boolean, off: [String] }));

/* ── HELPERS ── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sign = (p, d = '30d') => jwt.sign(p, JWT_SECRET, { expiresIn: d });
const verify = t => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };
const setCookie = (req, res, n, v, days = 30) => res.cookie(n, v, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: days * 864e5 });
const newKey = () => 'ak_' + crypto.randomBytes(18).toString('hex');
const KEY_RE = /^[A-Za-z0-9_-]{6,64}$/, KEY_ERR = 'Custom key must be 6–64 characters: letters, numbers, _ or -';
const isDup = e => e && e.code === 11000;
const limiter = (max, ms) => { const m = new Map(); setInterval(() => m.clear(), ms).unref(); return (req, res, next) => { const c = (m.get(req.ip) || 0) + 1; m.set(req.ip, c); c > max ? res.status(429).json({ error: 'Too many attempts. Wait a minute.' }) : next(); }; };
const me = async req => { const p = verify(req.cookies.tk); return p ? User.findById(p.id).select('-hash').lean() : null; };
const isAdmin = req => verify(req.cookies.ak)?.admin === true;
let cache = null, at = 0;
const getSet = async () => { if (cache && Date.now() - at < 10000) return cache; const d = { ...DEFAULTS, ...((await Setting.findById('main').lean()) || {}) }; d.off = d.off || []; d.freeOff = !!d.freeOff; cache = d; at = Date.now(); return cache; };
let buf = []; const flush = () => { if (!buf.length) return; const b = buf; buf = []; Log.insertMany(b, { ordered: false }).catch(() => {}); };
setInterval(flush, 3000).unref(); const log = e => { buf.push(e); if (buf.length > 200) flush(); };
const isUserFree = k => k.plan === 'free' && k.createdBy !== 'admin'; // keys users made themselves after login
const FREE_OFF = () => `Our API service is currently disabled. Please contact @${DEV} to purchase a Paid API subscription and activate your access.`;
const num = v => Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0; // 0 or negative = unlimited
const lim = (v, d) => v === '' || v == null ? d : num(v);
const keyCounts = async () => { const r = await Key.aggregate([{ $group: { _id: { $cond: [{ $eq: ['$plan', 'free'] }, 'free', { $cond: [{ $eq: ['$createdBy', 'admin'] }, 'admin', 'other'] }] }, n: { $sum: 1 } } }]); const o = { free: 0, admin: 0, other: 0 }; r.forEach(x => o[x._id] = x.n); o.all = o.free + o.admin + o.other; return o; };

/* ── PAGE SHELL ── */
const ICON = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="9" width="3" height="6" rx="1.5"/><rect x="8" y="5" width="3" height="14" rx="1.5"/><rect x="13" y="2" width="3" height="20" rx="1.5"/><rect x="18" y="7" width="3" height="10" rx="1.5"/></svg>`;
const FAV = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ff5e8a"><rect x="3" y="9" width="3" height="6" rx="1.5"/><rect x="8" y="5" width="3" height="14" rx="1.5"/><rect x="13" y="2" width="3" height="20" rx="1.5"/><rect x="18" y="7" width="3" height="10" rx="1.5"/></svg>`);
const FOOT = `<footer>Built by <a href="https://t.me/${esc(DEV)}">@${esc(DEV)}</a> · Paid API ke liye contact karo: <a href="https://t.me/${esc(DEV)}">@${esc(DEV)}</a></footer>`;
const page = (title, body, { user, script = '', src = [], head = '', nav = true, attr = '' } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#120d1a"><title>${esc(title)}</title>
<link rel="icon" href="${FAV}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css?v=${V}">${head}</head><body${attr}>
${nav ? `<nav class="glass"><a class="brand" href="/">${ICON}Nazriya API</a><a class="h" href="/">Home</a><a href="/docs">Docs</a>${user ? '<a href="/dashboard">Dashboard</a><a href="/logout">Log out</a>' : '<a class="btn s" href="/login">Get API key</a>'}</nav>` : ''}
<main>${body}</main>${nav ? FOOT : ''}<script src="/app.js?v=${V}"></script>${src.map(s => `<script src="${s}"></script>`).join('')}${script ? `<script>${script}</script>` : ''}</body></html>`;

/* ── KEY-PROTECTED API ── */
const { EP, open, send, slice, cached, cancel } = require('./proxy');
const hits = new Map(); setInterval(() => hits.clear(), 60000).unref();
// a played song/video: its seek (Range) requests in the next 30 min are free (no quota, no req/min)
const paid = new Map(); setInterval(() => { const n = Date.now(); for (const [k, v] of paid) if (v < n) paid.delete(k); }, 60000).unref();
const kc = new Map(); setInterval(() => { const n = Date.now(); for (const [k, v] of kc) if (v.exp < n) kc.delete(k); }, 60000).unref();
const getKey = async k => { const c = kc.get(k); if (c && c.exp > Date.now()) return c.d; const d = await Key.findOne({ key: k }).lean(); if (d) kc.set(k, { d, exp: Date.now() + 5000 }); return d; };
// CORS: lets websites/web apps call the API straight from the browser
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-api-key, range, content-type', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Retry-After' };
app.options('/api/:ep', (req, res) => res.set({ ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }).sendStatus(204));
app.get('/api/:ep', async (req, res) => {
  res.set(CORS);
  const ep = req.params.ep, t0 = Date.now(), ip = req.ip, q = String(req.query.q || '').slice(0, 200), k = String(req.query.key || req.get('x-api-key') || '').trim(); let kd = null;
  const done = (status, body, hdr) => { log({ key: k.slice(0, 12), email: kd?.email, ep, q, status, ms: Date.now() - t0, ip }); if (hdr) res.set(hdr); return res.status(status).json({ success: false, ...body }); };
  try {
    if (!EP[ep]) return done(404, { error: 'Unknown endpoint. Use audio, video or search.' });
    const s = await getSet();
    if (s.maintenance || s.off.includes(ep)) return done(503, { error: 'Endpoint temporarily disabled.' });
    if (!k) return done(401, { error: 'API key missing. Pass ?key=YOUR_KEY or x-api-key header.' });
    kd = await getKey(k);
    if (!kd) return done(401, { error: 'Invalid API key.' });
    if (s.freeOff && isUserFree(kd)) return done(403, { status: 'API_DISABLED', error: FREE_OFF() });
    if (!kd.active) return done(403, { error: `API key disabled. Contact @${DEV}.` });
    if (kd.expiresAt && new Date(kd.expiresAt) < new Date()) return done(403, { error: `API key expired. Contact @${DEV} for renewal.` });
    if (!q) return done(400, { error: 'Missing q parameter.' });
    const LIMIT = `Our API request limit has been reached. To get access to the paid API, please contact @${DEV}`;
    const range = req.get('range'), pk = k + '|' + ep + '|' + q, free = !!range && (paid.get(pk) || 0) > Date.now(); // seek on an already-counted song/video
    if (!free) {
      const rpm = kd.rpm || s.defaultRpm, c = (hits.get(k) || 0) + 1; hits.set(k, c);
      if (c > rpm) return done(429, { error: `Rate limit reached (${rpm} requests/minute). Please wait a minute and try again. For a higher limit contact @${DEV}` }, { 'Retry-After': '60' });
    }
    const base = s.useBackup && s.upstream2 ? s.upstream2 : s.upstream, ck = base + '|' + ep + '|' + q;
    if (free) { const c = cached(ck); if (c) { const st = slice(c, range, res); log({ key: k.slice(0, 12), email: kd.email, ep, q, status: st, ms: Date.now() - t0, ip }); return; } }
    const f = 'used.' + ep, refund = () => { paid.delete(pk); if (!free) Key.updateOne({ _id: kd._id }, { $inc: { [f]: -1 } }).catch(() => {}); };
    // upstream call and quota check start together (fast); if quota is over we answer at once and cancel the upstream call
    const ac = new AbortController(), up = open(base, ep, q, range, ac).catch(() => null);
    const ok = free ? true : await Key.findOneAndUpdate({ _id: kd._id, $expr: { $or: [{ $lte: [{ $ifNull: ['$limits.' + ep, 0] }, 0] }, { $lt: [{ $ifNull: ['$' + f, 0] }, '$limits.' + ep] }] } }, { $inc: { [f]: 1 } }, { projection: { _id: 1 } }); // atomic quota
    if (!ok) { ac.abort(); up.then(cancel); return done(429, { error: LIMIT }); }
    if (!free) paid.set(pk, Date.now() + 30 * 60000);
    const r = await up;
    if (!r) { refund(); return done(502, { error: 'Upstream error, try again.' }); }
    if (r.status >= 400) refund();
    let status; try { status = await send(r, req, res, ck, ac); } catch { refund(); if (!res.headersSent) return done(502, { error: 'Upstream error, try again.' }); return res.destroy(); }
    log({ key: k.slice(0, 12), email: kd.email, ep, q, status, ms: Date.now() - t0, ip });
  } catch (e) { console.error(e); if (!res.headersSent) done(500, { error: 'Server error, try again.' }); else res.destroy(); }
});
app.get('/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1, uptime: Math.round(process.uptime()) }));

/* ── USER AUTH + KEYS ── */
const g = GID ? new OAuth2Client(GID) : null, slow = limiter(12, 60000), loginOk = (req, res, u) => { setCookie(req, res, 'tk', sign({ id: u._id })); res.json({ ok: true }); };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/auth/register', slow, async (req, res) => {
  const { name, password } = req.body, email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || !password || password.length < 6) return res.status(400).json({ error: 'Enter a valid email and a password of 6+ characters.' });
  if (await User.exists({ email })) return res.status(409).json({ error: 'Email already registered. Log in instead.' });
  loginOk(req, res, await User.create({ name: String(name || '').trim().slice(0, 40) || email.split('@')[0], email, hash: await bcrypt.hash(password, 10) }));
});
app.post('/auth/login', slow, async (req, res) => {
  const u = await User.findOne({ email: String(req.body.email || '').trim().toLowerCase() });
  if (!u?.hash || !(await bcrypt.compare(req.body.password || '', u.hash))) return res.status(401).json({ error: 'Wrong email or password.' });
  loginOk(req, res, u);
});
app.post('/auth/google', slow, async (req, res) => {
  if (!g) return res.status(400).json({ error: 'Google login not configured.' });
  try {
    const p = (await g.verifyIdToken({ idToken: req.body.credential, audience: GID })).getPayload(), email = p.email.toLowerCase(); let u = await User.findOne({ email });
    if (!u) u = await User.create({ email, name: p.name, googleId: p.sub, picture: p.picture }); else if (!u.googleId) { u.googleId = p.sub; u.picture = p.picture; await u.save(); }
    loginOk(req, res, u);
  } catch { res.status(401).json({ error: 'Google sign-in failed.' }); }
});
app.get('/logout', (req, res) => { res.clearCookie('tk'); res.redirect('/'); });
app.post('/keys/create', async (req, res) => {
  const u = await me(req); if (!u) return res.status(401).json({ error: 'Log in first.' });
  const s = await getSet(); if (s.freeOff) return res.status(403).json({ status: 'API_DISABLED', error: FREE_OFF() });
  if (await Key.exists({ $or: [{ user: u._id }, { email: u.email }], plan: 'free' })) return res.status(409).json({ error: 'You already have a free key.' });
  await Key.create({ key: newKey(), name: String(req.body.name || '').trim().slice(0, 40) || 'My API key', user: u._id, email: u.email, plan: 'free', limits: { audio: s.freeAudio, video: s.freeVideo, search: s.freeSearch }, rpm: s.defaultRpm, expiresAt: new Date(Date.now() + s.freeDays * 864e5) });
  res.json({ ok: true });
});
app.post('/keys/:id/rename', async (req, res) => {
  const u = await me(req); if (!u) return res.status(401).json({ error: 'Log in first.' });
  const name = String(req.body.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  await Key.updateOne({ _id: req.params.id, $or: [{ user: u._id }, { email: u.email }] }, { name }); res.json({ ok: true });
});

/* ── ADMIN  (default: /nazriya) ── */
const inp = (id, l, t = 'number', ph = '') => `<div class="f"><label for="${id}">${l}</label><input id="${id}" type="${t}"${ph ? ` placeholder="${ph}"` : ''}></div>`;
const tog = (id, l) => `<label class="tg"><input id="${id}" type="checkbox"><i></i>${l}</label>`;
const ADMIN_LOGIN = page('Admin · Nazriya API', `<div class="lock"><div class="glass card"><div class="brand big">${ICON}Nazriya</div><h2>Control panel</h2><p class="mu">Enter the admin password. You stay signed in for ${ADMIN_DAYS} days, so next time ${esc(AP)} opens straight to the panel.</p>
<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" autofocus><div class="msg" id="msg" role="alert"></div><button class="btn w" id="go">Open panel</button></div></div>`,
  { nav: false, script: `const $=i=>document.getElementById(i);const go=async()=>{$('go').disabled=true;const r=await fetch(${JSON.stringify(AP + '/login')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('pw').value})}).catch(()=>null);$('go').disabled=false;if(r&&r.ok)return location.reload();$('msg').textContent=r&&r.status===429?'Too many tries. Wait a minute.':'Wrong password.';$('pw').select()};$('go').onclick=go;$('pw').onkeydown=e=>e.key==='Enter'&&go()` });
const ADMIN_PANEL = () => page('Admin · Nazriya API', `<div class="wrap admin">
<header class="ahead"><a class="brand" href="/">${ICON}Nazriya</a><div class="seg" role="tablist"><button data-tab="overview">Overview</button><button data-tab="keys">API keys</button><button data-tab="users">Users</button><button data-tab="settings">Settings</button><button data-tab="db">Database</button></div><a class="btn g s" href="${AP}/logout">Log out</a></header>

<section class="tab" id="t-overview" hidden><div class="glass card" id="sw"></div><div class="stats" id="cards"></div>
<div class="glass card"><h3>Requests, last 24 hours</h3><div class="chart"><canvas id="ch"></canvas></div></div>
<div class="grid g2"><div class="glass card sc"><h3>Endpoints</h3><table><thead><tr><th>Name</th><th>Hits</th><th>Errors</th><th>Avg</th><th></th></tr></thead><tbody id="eps"></tbody></table><div class="codes" id="codes"></div></div>
<div class="glass card sc"><h3>Recent requests</h3><table><tbody id="recent"></tbody></table></div></div></section>

<section class="tab" id="t-keys" hidden>
<div class="glass card"><div class="row wrapr"><div class="grow"><h3>API management</h3><p class="mu">Free keys use the free-plan limits from Settings. Admin keys get your own limits and can use a custom key string.</p></div>
<button class="btn ok" data-new="free">+ Free key</button><button class="btn v" data-new="admin">+ Admin key</button></div>
<div id="nk-box" hidden><div class="row nk-top"><span class="pill" id="nk-mode"></span><span class="mu small">Limit 0 = unlimited · Days empty = never expires</span></div>
<div class="fgrid">${inp('nk-name', 'Key name', 'text')}${inp('nk-email', 'User email (optional)', 'email', 'user@mail.com')}
<div class="f span2"><label for="nk-custom">Custom key (optional)</label><div class="row"><input id="nk-custom" type="text" placeholder="e.g. nazriya_vip_2026 — empty = random" autocomplete="off" spellcheck="false"><button class="btn g s" id="nk-rand" type="button">Random</button></div></div>
${inp('nk-a', 'Audio limit')}${inp('nk-v', 'Video limit')}${inp('nk-s', 'Search limit')}${inp('nk-rpm', 'Requests / min')}${inp('nk-d', 'Valid days')}<div class="f" id="nk-planw"><label for="nk-plan">Plan</label><select id="nk-plan"><option>paid</option><option>free</option></select></div></div>
<div class="row"><button class="btn" id="nk">Create key</button><button class="btn g" id="nk-x">Cancel</button><span class="msg" id="nk-msg"></span></div>
<div class="made" id="nk-out" hidden><span class="mu small">New key created, copy it now:</span><div class="keybox"><code id="nk-key"></code><button class="btn s" id="nk-cp">Copy</button></div></div></div></div>
<div class="row wrapr kbar"><div class="seg" id="kf"><button class="on" data-kf="all">All <b id="kc-all">0</b></button><button data-kf="free">Free <b id="kc-free">0</b></button><button data-kf="admin">Admin <b id="kc-admin">0</b></button></div><input id="kq" type="search" placeholder="Search name, email or key"></div>
<div class="kgrid" id="keys"></div></section>

<section class="tab" id="t-users" hidden><div class="glass card"><div class="row wrapr"><h3 class="grow">Users</h3><input id="uq" type="search" placeholder="Filter by name or email"></div><div class="sc"><table><thead><tr><th>Name</th><th>Email</th><th>Login</th><th>Keys</th><th>Audio</th><th>Video</th><th>Search</th><th>Joined</th><th></th></tr></thead><tbody id="users"></tbody></table></div></div></section>

<section class="tab" id="t-db" hidden><div class="glass card"><div class="row wrapr"><select id="dbc"></select><input id="dbq" type="search" placeholder="Search email / key / name"><button class="btn g s" id="dbprev">Prev</button><button class="btn g s" id="dbnext">Next</button><span class="mu" id="dbp"></span></div></div>
<div id="dbl"></div><div class="glass card"><h3>Add document</h3><textarea id="dbnew" spellcheck="false">{}</textarea><button class="btn s" id="dbadd">Insert</button></div></section>

<section class="tab" id="t-settings" hidden><div class="glass card"><h3>Global settings</h3><div class="fgrid">${inp('st-upstream', 'Primary upstream URL', 'url')}${inp('st-upstream2', 'Backup upstream URL', 'url')}${inp('st-defaultRpm', 'Default requests / min per key')}${inp('st-freeDays', 'Free key valid days')}${inp('st-freeAudio', 'Free audio limit')}${inp('st-freeVideo', 'Free video limit')}${inp('st-freeSearch', 'Free search limit')}</div>
<div class="row wrapr tgs">${tog('st-on-audio', 'Audio on')}${tog('st-on-video', 'Video on')}${tog('st-on-search', 'Search on')}${tog('st-maintenance', 'Maintenance mode (blocks all)')}</div>
<div class="row"><button class="btn" id="sv">Save settings</button></div>
<h3 class="danger">Danger zone</h3><div class="row wrapr"><button class="btn g s" id="ra">Reset all usage</button><button class="btn r s" id="cl">Clear all logs</button></div></div></section></div>`,
  { nav: false, attr: ` data-admin="${esc(AP)}"`, src: ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', `/admin.js?v=${V}`] });
app.get(AP, (req, res) => { res.set('Cache-Control', 'no-store'); res.send(isAdmin(req) ? ADMIN_PANEL() : ADMIN_LOGIN); });
app.post(AP + '/login', limiter(8, 60000), (req, res) => {
  const a = crypto.createHash('sha256').update(String(req.body.password || '')).digest(), b = crypto.createHash('sha256').update(String(ADMIN_PASS)).digest();
  if (!ADMIN_PASS || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong admin password.' });
  setCookie(req, res, 'ak', sign({ admin: true }, ADMIN_DAYS + 'd'), ADMIN_DAYS); res.json({ ok: true });
});
app.get(AP + '/logout', (req, res) => { res.clearCookie('ak'); res.redirect(AP); });
const swState = async () => { const s = await getSet(); return { useBackup: !!s.useBackup, hasBackup: !!s.upstream2, maintenance: !!s.maintenance, freeOff: !!s.freeOff }; };
const A = express.Router(); app.use(AP + '/api', (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'admin only' }), (req, res, next) => { res.set('Cache-Control', 'no-store'); if (req.method !== 'GET') kc.clear(); next(); }, A);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
A.get('/stats', wrap(async (req, res) => {
  flush(); const now = new Date(), since = new Date(now - 864e5), bad = { $cond: [{ $gte: ['$status', 400] }, 1, 0] };
  const [tot, hourly, eps, codes, recent, users, keys, ips, used, types] = await Promise.all([
    Log.aggregate([{ $group: { _id: null, n: { $sum: 1 }, err: { $sum: bad }, ms: { $avg: '$ms' } } }]),
    Log.aggregate([{ $match: { t: { $gte: since } } }, { $group: { _id: { $dateTrunc: { date: '$t', unit: 'hour' } }, n: { $sum: 1 }, err: { $sum: bad } } }]),
    Log.aggregate([{ $group: { _id: '$ep', n: { $sum: 1 }, err: { $sum: bad }, ms: { $avg: '$ms' } } }, { $sort: { n: -1 } }]),
    Log.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Log.find().sort({ t: -1 }).limit(15).lean(), User.estimatedDocumentCount(), Key.estimatedDocumentCount(),
    Log.aggregate([{ $match: { t: { $gte: since } } }, { $group: { _id: '$ip' } }, { $count: 'n' }]).then(a => a[0]?.n || 0),
    Key.aggregate([{ $group: { _id: null, a: { $sum: '$used.audio' }, v: { $sum: '$used.video' }, s: { $sum: '$used.search' } } }]), keyCounts()]);
  const t = tot[0] || { n: 0, err: 0, ms: 0 }, map = new Map(hourly.map(h => [+h._id, h])), hrs = [];
  for (let i = 23; i >= 0; i--) { const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() - i); const h = map.get(+d) || { n: 0, err: 0 }; hrs.push({ label: d.getHours() + ':00', ok: h.n - h.err, err: h.err }); }
  res.json({ total: t.n, ok: t.n - t.err, err: t.err, avgMs: Math.round(t.ms || 0), users, keys, ips, used: used[0] || {}, types, sw: await swState(), hrs, eps, codes, recent });
}));
A.get('/users', wrap(async (req, res) => {
  const [us, ks] = await Promise.all([User.find().sort({ createdAt: -1 }).limit(500).select('-hash').lean(), Key.aggregate([{ $group: { _id: '$email', n: { $sum: 1 }, a: { $sum: '$used.audio' }, v: { $sum: '$used.video' }, s: { $sum: '$used.search' } } }])]);
  const c = {}; ks.forEach(k => c[k._id] = k); res.json(us.map(u => ({ ...u, keys: c[u.email]?.n || 0, a: c[u.email]?.a || 0, v: c[u.email]?.v || 0, s: c[u.email]?.s || 0 })));
}));
A.delete('/users/:id', wrap(async (req, res) => { const u = await User.findByIdAndDelete(req.params.id); if (u) await Key.deleteMany({ email: u.email }); res.json({ ok: true }); }));
A.get('/keys', wrap(async (req, res) => {
  const f = {}, t = req.query.type, q = String(req.query.q || '').trim();
  if (t === 'free') f.plan = 'free'; else if (t === 'admin') { f.createdBy = 'admin'; f.plan = { $ne: 'free' }; }
  if (q) { const r = new RegExp(escRe(q), 'i'); f.$or = [{ email: r }, { name: r }, { key: r }]; }
  const [list, counts] = await Promise.all([Key.find(f).sort({ createdAt: -1 }).limit(300).lean(), keyCounts()]); res.json({ list, counts });
}));
A.post('/keys', wrap(async (req, res) => {
  const b = req.body, s = await getSet(), free = b.type === 'free', email = String(b.email || '').trim().toLowerCase() || 'admin', custom = String(b.custom || '').trim();
  if (custom && !KEY_RE.test(custom)) return res.status(400).json({ error: KEY_ERR });
  const days = b.days === '' || b.days == null ? (free ? s.freeDays : 0) : num(b.days);
  try {
    res.json(await Key.create({ key: custom || newKey(), custom: !!custom, name: String(b.name || '').trim().slice(0, 40) || (free ? 'Free key' : 'Admin key'), email, user: (await User.findOne({ email }).select('_id').lean())?._id,
      plan: free ? 'free' : (b.plan === 'free' ? 'free' : 'paid'), createdBy: 'admin', rpm: num(b.rpm) > 0 ? num(b.rpm) : s.defaultRpm, expiresAt: days > 0 ? new Date(Date.now() + days * 864e5) : undefined,
      limits: { audio: lim(b.audio, free ? s.freeAudio : 0), video: lim(b.video, free ? s.freeVideo : 0), search: lim(b.search, free ? s.freeSearch : 0) } }));
  } catch (e) { if (isDup(e)) return res.status(409).json({ error: 'This key already exists. Pick another one.' }); throw e; }
}));
A.patch('/keys/:id', wrap(async (req, res) => {
  const b = req.body, s = await getSet(), set = { limits: { audio: num(b.audio), video: num(b.video), search: num(b.search) }, rpm: num(b.rpm) > 0 ? num(b.rpm) : s.defaultRpm, active: !!b.active, plan: b.plan === 'free' ? 'free' : 'paid' }, upd = { $set: set };
  if (b.name != null) set.name = String(b.name).trim().slice(0, 40) || 'API key';
  if (b.expiresAt) set.expiresAt = new Date(b.expiresAt + 'T23:59:59Z'); else upd.$unset = { expiresAt: 1 };
  if (b.resetUsage) set.used = { audio: 0, video: 0, search: 0 };
  res.json(await Key.findByIdAndUpdate(req.params.id, upd, { new: true }));
}));
A.post('/keys/:id/set', wrap(async (req, res) => { // custom key string, same limits/usage
  const k = String(req.body.key || '').trim(); if (!KEY_RE.test(k)) return res.status(400).json({ error: KEY_ERR });
  try { res.json(await Key.findByIdAndUpdate(req.params.id, { key: k, custom: true }, { new: true })); } catch (e) { if (isDup(e)) return res.status(409).json({ error: 'This key already exists. Pick another one.' }); throw e; }
}));
A.delete('/keys/:id', wrap(async (req, res) => { await Key.findByIdAndDelete(req.params.id); res.json({ ok: true }); }));
A.post('/keys/:id/regen', wrap(async (req, res) => res.json(await Key.findByIdAndUpdate(req.params.id, { key: newKey(), custom: false }, { new: true }))));
A.post('/users/:id/password', wrap(async (req, res) => { const p = String(req.body.password || ''); if (p.length < 6) return res.status(400).json({ error: 'Password needs 6+ characters.' }); await User.findByIdAndUpdate(req.params.id, { hash: await bcrypt.hash(p, 10) }); res.json({ ok: true }); }));
A.post('/users/:id/reset-usage', wrap(async (req, res) => { const u = await User.findById(req.params.id); if (u) await Key.updateMany({ email: u.email }, { $set: { used: { audio: 0, video: 0, search: 0 } } }); res.json({ ok: true }); }));
A.post('/reset-all-usage', wrap(async (req, res) => { await Key.updateMany({}, { $set: { used: { audio: 0, video: 0, search: 0 } } }); res.json({ ok: true }); }));
A.delete('/logs', wrap(async (req, res) => { flush(); await Log.deleteMany({}); res.json({ ok: true }); }));
A.post('/switch', wrap(async (req, res) => { // one-click global switches
  const s = await getSet(), w = req.body.what;
  if (w === 'source' && !s.upstream2) return res.status(400).json({ error: 'Set a backup upstream URL in Settings first.' });
  const upd = w === 'maintenance' ? { maintenance: !s.maintenance } : w === 'free' ? { freeOff: !s.freeOff } : w === 'source' ? { useBackup: !s.useBackup } : null;
  if (!upd) return res.status(400).json({ error: 'Unknown switch.' });
  await Setting.findByIdAndUpdate('main', upd, { upsert: true }); cache = null; res.json(await swState());
}));
/* DB manager */
const COLS = { users: User, keys: Key, logs: Log, settings: Setting }, isOid = id => /^[a-f0-9]{24}$/i.test(id), oid = id => isOid(id) ? new mongoose.Types.ObjectId(id) : id;
const revive = d => { for (const k of ['createdAt', 'expiresAt', 't']) if (typeof d[k] === 'string') d[k] = new Date(d[k]); if (typeof d.user === 'string' && isOid(d.user)) d.user = oid(d.user); return d; };
A.get('/db', wrap(async (req, res) => res.json(await Promise.all(Object.keys(COLS).map(async name => ({ name, n: await COLS[name].estimatedDocumentCount() }))))));
A.get('/db/:c', wrap(async (req, res) => {
  const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' });
  const pg = Math.max(0, +req.query.page || 0), q = escRe(String(req.query.q || '').trim());
  const f = q ? { $or: ['email', 'key', 'name', 'ep', 'q', 'ip'].map(x => ({ [x]: new RegExp(q, 'i') })) } : {};
  const [docs, total] = await Promise.all([M.collection.find(f).sort({ _id: -1 }).skip(pg * 20).limit(20).toArray(), M.collection.countDocuments(f)]);
  docs.forEach(d => delete d.hash); res.json({ docs, total });
}));
A.put('/db/:c/:id', wrap(async (req, res) => {
  const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' });
  const _id = oid(req.params.id), old = await M.collection.findOne({ _id }); if (!old) return res.status(404).json({ error: 'not found' });
  const d = revive({ ...req.body }); delete d._id; if (old.hash) d.hash = old.hash;
  await M.collection.replaceOne({ _id }, d); cache = null; res.json({ ok: true });
}));
A.post('/db/:c', wrap(async (req, res) => { const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' }); const r = await M.collection.insertOne(revive({ ...req.body })); cache = null; res.json({ ok: true, id: r.insertedId }); }));
A.delete('/db/:c/:id', wrap(async (req, res) => { const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' }); await M.collection.deleteOne({ _id: oid(req.params.id) }); cache = null; res.json({ ok: true }); }));
A.get('/settings', wrap(async (req, res) => res.json(await getSet())));
A.post('/settings', wrap(async (req, res) => {
  const b = req.body, n = (v, d) => num(v) > 0 ? num(v) : d;
  await Setting.findByIdAndUpdate('main', { upstream: String(b.upstream || DEFAULTS.upstream).trim().replace(/\/+$/, ''), upstream2: String(b.upstream2 || '').trim().replace(/\/+$/, ''), defaultRpm: n(b.defaultRpm, DEFAULTS.defaultRpm), freeDays: n(b.freeDays, DEFAULTS.freeDays), freeAudio: num(b.freeAudio), freeVideo: num(b.freeVideo), freeSearch: num(b.freeSearch), maintenance: !!b.maintenance, off: Array.isArray(b.off) ? b.off.filter(x => EP[x]) : [] }, { upsert: true });
  cache = null; res.json({ ok: true, settings: await getSet() });
}));

/* ── PUBLIC PAGES ── */
const IC = {
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="15" height="14" rx="3"/><path d="M17 10l5-3v10l-5-3z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'
};
const brandStrip = () => BRANDS.length ? `<div class="brands"><span>Works with</span>${BRANDS.map(b => `<span class="bchip"><img src="${esc(b.logo)}" alt="${esc(b.name || '')}" height="26" loading="lazy">${b.name && b.label !== false ? esc(b.name) : ''}</span>`).join('')}</div>` : '';
app.get('/', wrap(async (req, res) => {
  const [s, u] = await Promise.all([getSet(), me(req)]);
  const feat = (id, t, p, n) => `<div class="feat"><div class="ic">${IC[id]}</div><h3>${t}</h3><p>${p}</p><code>/api/${id}?q=…</code><div class="free"><b>${n > 0 ? n : '∞'}</b> free requests</div></div>`;
  res.send(page('Nazriya Music API', `<div class="wrap"><section class="hero">
<div class="hero-l"><span class="live"><i></i>${s.maintenance ? 'Under maintenance' : 'All systems playing'}</span><h1>Music API, ready in one key.</h1>
<p class="l">Search songs, then stream audio and video with a single API key. Start free with ${s.freeAudio} audio plays, upgrade when your bot grows.</p>
<div class="row cta"><a class="btn big" href="${u ? '/dashboard' : '/login'}">${u ? 'Open dashboard' : 'Get free API key'}</a><a class="btn g big" href="/docs">Read docs</a></div>${brandStrip()}</div>
<div class="console glass" aria-label="Example request"><div class="np"><div class="eq" aria-hidden="true">${'<i></i>'.repeat(14)}</div><div><b>Aarzu</b><small>now streaming via /api/audio</small></div></div>
<pre><span class="c">GET</span> /api/search?q=aarzu
<span class="c">x-api-key:</span> ak_••••••••••

{
  <span class="k">"success"</span>: <span class="v">true</span>,
  <span class="k">"results"</span>: [{ <span class="k">"title"</span>: <span class="s">"Aarzu"</span>, … }]
}</pre></div></section>
<section class="feats">${feat('search', 'Search', 'Find songs by name or artist and show a result list to your users.', s.freeSearch)}${feat('audio', 'Audio', 'Get a playable audio stream for music bots and players. Seeking works.', s.freeAudio)}${feat('video', 'Video', 'Get a playable video stream for video players and video-chat bots.', s.freeVideo)}</section>
<section class="steps glass"><h2>Live in three steps</h2><ol><li><b>Create an account</b><span>Email or Google, takes ten seconds.</span></li><li><b>Copy your key</b><span>Your free key appears on the dashboard.</span></li><li><b>Call the API</b><span>Send it as <code>?key=</code> or an <code>x-api-key</code> header.</span></li></ol></section></div>`, { user: u }));
}));
app.get('/login', wrap(async (req, res) => {
  if (await me(req)) return res.redirect('/dashboard'); const G = !!GID;
  res.send(page('Log in · Nazriya API', `<div class="lock"><div class="glass card"><h2 id="ttl">Welcome back</h2><p class="mu">Log in to manage your API key.</p>
<div id="nm" hidden><label for="name">Name</label><input id="name" placeholder="Your name" autocomplete="name"></div><label for="email">Email</label><input id="email" type="email" autocomplete="email"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password">
<div class="msg" id="msg" role="alert"></div><button class="btn w" id="go">Log in</button>${G ? '<div class="or">or</div><div id="gbtn" class="gbtn"></div>' : ''}
<p class="mu sw"><span id="sw">New here?</span> <a href="#" id="tg">Create account</a></p></div></div>`,
    { head: G ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : '', script: `let reg=false;const $=i=>document.getElementById(i);
$('tg').onclick=e=>{e.preventDefault();reg=!reg;$('nm').hidden=!reg;$('ttl').textContent=reg?'Create account':'Welcome back';$('go').textContent=reg?'Create account':'Log in';$('sw').textContent=reg?'Have an account?':'New here?';$('tg').textContent=reg?'Log in':'Create account';$('pw').autocomplete=reg?'new-password':'current-password'};
async function post(u,b){$('go').disabled=true;try{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.ok)return location='/dashboard';$('msg').textContent=j.error||'Something went wrong.'}catch{$('msg').textContent='Network error, try again.'}$('go').disabled=false}
const go=()=>post(reg?'/auth/register':'/auth/login',{name:$('name').value,email:$('email').value,password:$('pw').value});$('go').onclick=go;$('pw').onkeydown=e=>e.key==='Enter'&&go();
${G ? `window.onload=()=>{google.accounts.id.initialize({client_id:${JSON.stringify(GID)},callback:r=>post('/auth/google',{credential:r.credential})});google.accounts.id.renderButton($('gbtn'),{theme:'filled_black',shape:'pill',size:'large'})}` : ''}` }));
}));
app.get('/dashboard', wrap(async (req, res) => {
  const u = await me(req); if (!u) return res.redirect('/login');
  const keys = await Key.find({ $or: [{ user: u._id }, { email: u.email }] }).sort({ createdAt: -1 }).lean(), now = new Date(), B = `${req.protocol}://${req.get('host')}`;
  const pct = (used, l) => !l || l < 0 ? 0 : Math.min(100, ((used || 0) / l) * 100);
  const bar = (n, used, l) => `<div class="use"><div class="row"><span class="mu">${n}</span><span class="grow"></span><b>${used || 0} / ${!l || l < 0 ? '∞' : l}</b></div><div class="bar${pct(used, l) > 85 ? ' hot' : ''}"><i style="width:${pct(used, l)}%"></i></div></div>`;
  const mask = k => k.length > 12 ? k.slice(0, 5) + '•'.repeat(12) + k.slice(-4) : '•'.repeat(k.length);
  const cards = keys.map(k => { const exp = k.expiresAt && k.expiresAt < now, left = k.expiresAt ? Math.ceil((k.expiresAt - now) / 864e5) : null;
    return `<div class="glass card kc"><div class="row"><h3 class="grow" title="${esc(k.name)}">${esc(k.name || 'My API key')}</h3><button class="btn g s" data-rename="${k._id}" data-cur="${esc(k.name || 'My API key')}">Rename</button></div>
<div class="row tags"><span class="pill ${k.plan === 'free' ? 'ok' : 'v'}">${esc(k.plan)}</span><span class="pill ${k.active && !exp ? 'ok' : 'er'}">${!k.active ? 'disabled' : exp ? 'expired' : 'active'}</span></div>
<div class="keybox"><code data-full="${esc(k.key)}" data-mask="${esc(mask(k.key))}">${esc(mask(k.key))}</code><button class="btn g s" data-reveal aria-label="Show key">Show</button></div><button class="btn w" data-copy="${esc(k.key)}">Copy API key</button>
<p class="mu small">${left == null ? 'Never expires' : exp ? 'Expired ' + k.expiresAt.toISOString().slice(0, 10) : `${left} day${left === 1 ? '' : 's'} left (${k.expiresAt.toISOString().slice(0, 10)})`} · ${k.rpm || 30} requests/min</p>
${bar('Audio', k.used?.audio, k.limits?.audio)}${bar('Video', k.used?.video, k.limits?.video)}${bar('Search', k.used?.search, k.limits?.search)}</div>`; }).join('');
  const s = await getSet();
  const notice = s.freeOff ? `<div class="glass card notice"><h3>Free API is turned off</h3><p class="mu">${esc(FREE_OFF())}</p></div>` : '';
  const tk = keys.find(k => k.active && !(k.expiresAt && k.expiresAt < now) && !(s.freeOff && isUserFree(k)));
  const tester = tk ? `<div class="glass card" id="tester" data-key="${esc(tk.key)}"><h3>Try it</h3><p class="mu">Runs a real request with <b>${esc(tk.name)}</b>. It counts toward your quota.</p>
<div class="row wrapr"><select aria-label="Endpoint"><option value="search">search</option><option value="audio">audio</option><option value="video">video</option></select><input class="grow" placeholder="Song name, e.g. aarzu" aria-label="Song name"><button class="btn">Run</button></div><div class="out"></div><pre hidden></pre>
<h3 class="mt">Your request</h3><pre class="cp">curl "${esc(B)}/api/search?q=aarzu" -H "x-api-key: ${esc(tk.key)}"</pre></div>` : '';
  res.send(page('Dashboard · Nazriya API', `<div class="wrap dash"><div class="hi"><h2>Hi, ${esc(u.name)}</h2><p class="mu">${esc(u.email)}</p></div>
${notice}<div class="dgrid"><div class="stack">${cards || '<div class="glass card"><h3>Create your API key</h3><p class="mu">Free plan, ready instantly.</p><label for="kn">Key name (optional)</label><input id="kn" maxlength="40" placeholder="e.g. My Music Bot"><button class="btn w" id="mk">Create free key</button><div class="msg" id="msg" role="alert"></div></div>'}</div>${tester}</div><div class="glass card"><h3>Need more requests?</h3><p class="mu">Paid API ke liye contact karo <a href="https://t.me/${esc(DEV)}">@${esc(DEV)}</a>. <a href="/docs">Read the docs</a> to see every endpoint.</p></div></div>`, { user: u }));
}));
app.get('/docs', wrap(async (req, res) => {
  const [u, s] = await Promise.all([me(req), getSet()]), B = `${req.protocol}://${req.get('host')}`;
  const code = (t) => `<pre class="cp">${t}</pre>`;
  const NOTE = 'Response is passed through exactly as the source returns it, so field names may be slightly different from this example.';
  const sec = (id, desc, example, resp) => `<div class="glass card" id="${id}"><h3><span class="pill ok">GET</span> /api/${id}</h3><p>${desc}</p>
<h4>Parameters</h4><div class="sc"><table><tr><th>Name</th><th>Required</th><th>Description</th></tr><tr><td><code>q</code></td><td>Yes</td><td>${id === 'search' ? 'Search text, e.g. song or artist name' : 'Song name (or artist + song name)'}</td></tr><tr><td><code>key</code></td><td>Yes</td><td>Your API key (or send it in the <code>x-api-key</code> header)</td></tr></table></div>
<h4>Request</h4>${code(example)}<h4>Response <span class="pill ok">200</span></h4>${code(resp)}<p class="mu small">${NOTE}</p>
<h4>Code</h4>${code(`<b>JavaScript</b>\nconst r = await fetch("${B}/api/${id}?q=aarzu", { headers: { "x-api-key": "YOUR_KEY" } });\nconst data = await r.json();\n\n<b>Python</b>\nimport requests\ndata = requests.get("${B}/api/${id}", params={"q": "aarzu", "key": "YOUR_KEY"}).json()`)}</div>`;
  res.send(page('Docs · Nazriya API', `<div class="wrap docs"><h1>API docs</h1><p class="l">Three endpoints, one key. Base URL: <code>${esc(B)}</code></p>
<div class="glass card toc"><a href="#auth">Authentication</a><a href="#search">Search</a><a href="#audio">Audio</a><a href="#video">Video</a><a href="#limits">Limits</a><a href="#errors">Errors</a></div>
<div class="glass card" id="auth"><h3>Authentication</h3><p>Create a free key in your <a href="/dashboard">dashboard</a>. Send it with every request, in one of two ways:</p>
<div class="sc"><table><tr><th>Method</th><th>Example</th></tr><tr><td>Query parameter</td><td><code>?key=YOUR_KEY</code></td></tr><tr><td>Header</td><td><code>x-api-key: YOUR_KEY</code></td></tr></table></div><p class="mu small">Browser apps can call the API directly; CORS is enabled.</p></div>
${sec('search', 'Finds songs by name and returns the matching results. Use it to show a list to your users.', `GET ${B}/api/search?q=aarzu&amp;key=YOUR_KEY`, `{\n  "success": true,\n  "results": [\n    {\n      "title": "Aarzu",\n      "id": "VIDEO_ID",\n      "duration": "3:45",\n      "thumbnail": "https://...",\n      "url": "https://..."\n    }\n  ]\n}`)}
${sec('audio', 'Returns the playable audio for a song. Use it for audio players and music bots. Seeking (HTTP Range) is supported.', `GET ${B}/api/audio?q=aarzu&amp;key=YOUR_KEY`, `{\n  "success": true,\n  "title": "Aarzu",\n  "duration": "3:45",\n  "audio": "https://.../audio-link"\n}`)}
${sec('video', 'Returns the playable video for a song. Use it for video players and video chat bots. Seeking (HTTP Range) is supported.', `GET ${B}/api/video?q=aarzu&amp;key=YOUR_KEY`, `{\n  "success": true,\n  "title": "Aarzu",\n  "duration": "3:45",\n  "video": "https://.../video-link"\n}`)}
<div class="glass card" id="limits"><h3>Free plan limits</h3><div class="sc"><table><tr><th>Audio</th><th>Video</th><th>Search</th><th>Valid for</th><th>Rate</th></tr><tr><td>${s.freeAudio}</td><td>${s.freeVideo}</td><td>${s.freeSearch}</td><td>${s.freeDays} days</td><td>${s.defaultRpm}/min</td></tr></table></div><p class="mu small">Failed requests are not counted against your quota. Seeking inside a song you already played is free. Need more? Contact <a href="https://t.me/${esc(DEV)}">@${esc(DEV)}</a> for the paid plan.</p></div>
<div class="glass card" id="errors"><h3>Errors</h3><div class="sc"><table><tr><th>Code</th><th>Meaning</th></tr><tr><td>400</td><td>Missing <code>q</code></td></tr><tr><td>401</td><td>Missing or invalid key</td></tr><tr><td>403</td><td>Key expired or disabled</td></tr><tr><td>429</td><td>Quota finished or rate limit hit</td></tr><tr><td>502 / 503</td><td>Source error or endpoint disabled</td></tr></table></div>${code('{ "success": false, "error": "Invalid API key." }')}</div></div>`, { user: u }));
}));

app.use((req, res) => req.accepts('html') ? res.status(404).send(page('Not found · Nazriya API', '<div class="lock"><div class="glass card"><h2>Page not found</h2><p class="mu">This link is wrong or the page moved.</p><a class="btn w" href="/">Go home</a></div></div>')) : res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); if (res.headersSent) return res.destroy(); res.status(500).json({ error: 'Server error' }); });
mongoose.connect(MONGO_URI, { maxPoolSize: 20 }).then(() => app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}  ·  admin: http://localhost:${PORT}${AP}`))).catch(e => { console.error('Mongo error:', e.message); process.exit(1); });
process.on('SIGTERM', () => { flush(); setTimeout(() => process.exit(0), 500); });
