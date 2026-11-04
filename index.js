const express = require('express'), mongoose = require('mongoose'), compression = require('compression'), cookies = require('cookie-parser');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), crypto = require('crypto'), path = require('path'), { OAuth2Client } = require('google-auth-library');
const { PORT, MONGO_URI, JWT_SECRET, ADMIN_PASS, GOOGLE_CLIENT_ID: GID, DEVELOPER: DEV, DEFAULTS } = require('./config');
const app = express(); app.set('trust proxy', 1); app.disable('x-powered-by');
app.use(compression(), express.json({ limit: '50kb' }), express.urlencoded({ extended: true }), cookies(), express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

/* ── MODELS ── */
const S = mongoose.Schema;
const User = mongoose.model('User', new S({ email: { type: String, unique: true }, name: String, hash: String, googleId: String, picture: String, createdAt: { type: Date, default: Date.now } }));
const Key = mongoose.model('Key', new S({ key: { type: String, unique: true }, user: S.Types.ObjectId, email: { type: String, index: true }, name: { type: String, default: 'My API key' }, plan: { type: String, default: 'free' }, createdBy: { type: String, default: 'user' },
  limits: { audio: Number, video: Number, search: Number }, used: { audio: { type: Number, default: 0 }, video: { type: Number, default: 0 }, search: { type: Number, default: 0 } },
  rpm: Number, expiresAt: Date, active: { type: Boolean, default: true }, createdAt: { type: Date, default: Date.now } }));
const logSchema = new S({ key: String, email: String, ep: String, q: String, status: Number, ms: Number, ip: String, t: { type: Date, default: Date.now } });
logSchema.index({ t: 1 }, { expireAfterSeconds: 90 * 86400 }); // logs auto-delete after 90 days
const Log = mongoose.model('Log', logSchema);
const Setting = mongoose.model('Setting', new S({ _id: String, upstream: String, upstream2: String, useBackup: Boolean, defaultRpm: Number, freeDays: Number, freeAudio: Number, freeVideo: Number, freeSearch: Number, maintenance: Boolean, off: [String] }));

/* ── HELPERS ── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (p, d = '30d') => jwt.sign(p, JWT_SECRET, { expiresIn: d });
const verify = t => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };
const setCookie = (req, res, n, v, days = 30) => res.cookie(n, v, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: days * 864e5 });
const newKey = () => 'ak_' + crypto.randomBytes(18).toString('hex');
const limiter = (max, ms) => { const m = new Map(); setInterval(() => m.clear(), ms).unref(); return (req, res, next) => { const c = (m.get(req.ip) || 0) + 1; m.set(req.ip, c); c > max ? res.status(429).json({ error: 'Too many attempts. Wait a minute.' }) : next(); }; };
const me = async req => { const p = verify(req.cookies.tk); return p ? User.findById(p.id).lean() : null; };
const isAdmin = req => verify(req.cookies.ak)?.admin === true;
let cache = null, at = 0;
const getSet = async () => { if (cache && Date.now() - at < 10000) return cache; cache = { ...DEFAULTS, ...((await Setting.findById('main').lean()) || {}) }; at = Date.now(); return cache; };
let buf = []; const flush = () => { if (!buf.length) return; const b = buf; buf = []; Log.insertMany(b, { ordered: false }).catch(() => {}); };
setInterval(flush, 3000).unref(); const log = e => { buf.push(e); if (buf.length > 200) flush(); };

/* ── PAGE SHELL ── */
const FOOT = `<footer class="glass">Developer <a href="https://t.me/${DEV}">@${DEV}</a> &nbsp;|&nbsp; Paid API ke liye contact karo: <a href="https://t.me/${DEV}">@${DEV}</a></footer>`;
const page = (title, body, { user, script = '', src = [], head = '', nav = true } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css">${head}</head><body>
${nav ? `<nav class="glass"><b>Nazriya API</b><a class="h" href="/">Home</a><a href="/docs">Docs</a>${user ? '<a href="/dashboard">Dashboard</a><a href="/logout">Logout</a>' : '<a href="/login">Login</a>'}</nav>` : ''}
${body}${nav ? FOOT : ''}<script src="/app.js"></script>${src.map(s => `<script src="${s}"></script>`).join('')}${script ? `<script>${script}</script>` : ''}</body></html>`;

/* ── KEY-PROTECTED API ── */
const { EP, open, send, slice, cached, cancel } = require('./proxy');
const hits = new Map(); setInterval(() => hits.clear(), 60000).unref();
// a played song/video: its seek (Range) requests in the next 30 min are free (no quota, no req/min)
const paid = new Map(); setInterval(() => { const n = Date.now(); for (const [k, v] of paid) if (v < n) paid.delete(k); }, 60000).unref();
const kc = new Map(); setInterval(() => { const n = Date.now(); for (const [k, v] of kc) if (v.exp < n) kc.delete(k); }, 60000).unref();
const getKey = async k => { const c = kc.get(k); if (c && c.exp > Date.now()) return c.d; const d = await Key.findOne({ key: k }).lean(); if (d) kc.set(k, { d, exp: Date.now() + 5000 }); return d; };
app.get('/api/:ep', async (req, res) => {
  const ep = req.params.ep, t0 = Date.now(), ip = req.ip, q = String(req.query.q || '').slice(0, 200), k = String(req.query.key || req.get('x-api-key') || ''); let kd = null;
  const done = (status, body, hdr) => { log({ key: k.slice(0, 12), email: kd?.email, ep, q, status, ms: Date.now() - t0, ip }); if (hdr) res.set(hdr); return res.status(status).json({ success: false, ...body }); };
  try {
    if (!EP[ep]) return done(404, { error: 'Unknown endpoint. Use audio, video or search.' });
    const s = await getSet();
    if (s.maintenance || s.off.includes(ep)) return done(503, { error: 'Endpoint temporarily disabled.' });
    if (!k) return done(401, { error: 'API key missing. Pass ?key=YOUR_KEY or x-api-key header.' });
    kd = await getKey(k);
    if (!kd) return done(401, { error: 'Invalid API key.' });
    if (!kd.active) return done(403, { error: `API key disabled. Contact @${DEV}.` });
    if (kd.expiresAt && kd.expiresAt < new Date()) return done(403, { error: `API key expired. Contact @${DEV} for renewal.` });
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
    // upstream call and quota check start together (fast), but if the quota is over we answer at once and cancel the upstream call
    const ac = new AbortController(), up = open(base, ep, q, range, ac).catch(() => null);
    const ok = free ? true : await Key.findOneAndUpdate({ _id: kd._id, $expr: { $or: [{ $lte: ['$limits.' + ep, 0] }, { $lt: ['$' + f, '$limits.' + ep] }] } }, { $inc: { [f]: 1 } }); // atomic quota
    if (!ok) { ac.abort(); up.then(cancel); return done(429, { error: LIMIT }); }
    if (!free) paid.set(pk, Date.now() + 30 * 60000);
    const r = await up;
    if (!r) { refund(); return done(502, { error: 'Upstream error, try again.' }); }
    if (r.status >= 400) refund();
    let status; try { status = await send(r, req, res, ck, ac); } catch { refund(); if (!res.headersSent) return done(502, { error: 'Upstream error, try again.' }); return res.destroy(); }
    log({ key: k.slice(0, 12), email: kd.email, ep, q, status, ms: Date.now() - t0, ip });
  } catch (e) { console.error(e); if (!res.headersSent) done(500, { error: 'Server error, try again.' }); else res.destroy(); }
});

/* ── USER AUTH + KEYS ── */
const g = GID ? new OAuth2Client(GID) : null, slow = limiter(12, 60000), loginOk = (req, res, u) => { setCookie(req, res, 'tk', sign({ id: u._id })); res.json({ ok: true }); };
app.post('/auth/register', slow, async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email and 6+ char password required.' });
  if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered. Log in instead.' });
  loginOk(req, res, await User.create({ name: name || email.split('@')[0], email: email.toLowerCase(), hash: await bcrypt.hash(password, 10) }));
});
app.post('/auth/login', slow, async (req, res) => {
  const u = await User.findOne({ email: String(req.body.email || '').toLowerCase() });
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
  const u = await me(req); if (!u) return res.status(401).json({ error: 'Login first.' });
  if (await Key.exists({ $or: [{ user: u._id }, { email: u.email }], plan: 'free' })) return res.status(409).json({ error: 'You already have a free key.' });
  const s = await getSet();
  await Key.create({ key: newKey(), name: String(req.body.name || '').trim().slice(0, 40) || 'My API key', user: u._id, email: u.email, plan: 'free', limits: { audio: s.freeAudio, video: s.freeVideo, search: s.freeSearch }, rpm: s.defaultRpm, expiresAt: new Date(Date.now() + s.freeDays * 864e5) });
  res.json({ ok: true });
});

app.post('/keys/:id/rename', async (req, res) => {
  const u = await me(req); if (!u) return res.status(401).json({ error: 'Login first.' });
  const name = String(req.body.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  await Key.updateOne({ _id: req.params.id, $or: [{ user: u._id }, { email: u.email }] }, { name }); res.json({ ok: true });
});

/* ── ADMIN /sahil ── */
const inp = (id, l, t = 'number') => `<div><label>${l}</label><input id="${id}" type="${t}"></div>`;
app.get('/sahil', (req, res) => res.send(!isAdmin(req)
  ? page('Admin', `<div class="wrap" style="max-width:400px;padding-top:120px"><div class="glass card" style="padding:32px"><h2>Admin</h2><label>Password</label><input id="pw" type="password"><div class="msg" id="msg"></div><button class="btn" style="width:100%" id="go">Enter</button></div></div>`,
    { nav: false, script: `const $=i=>document.getElementById(i);const go=async()=>{const r=await fetch('/sahil/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('pw').value})});r.ok?location.reload():$('msg').textContent='Wrong password.'};$('go').onclick=go;$('pw').onkeydown=e=>e.key==='Enter'&&go()` })
  : page('Admin · Nazriya API', `<div class="wrap" style="padding:24px 20px 40px"><div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px"><h2 style="margin-right:auto">Control panel</h2>
<div class="seg"><button class="on" data-tab="overview">Overview</button><button data-tab="users">Users</button><button data-tab="keys">Keys</button><button data-tab="settings">Settings</button><button data-tab="db">Database</button></div><a class="btn g s" href="/sahil/logout">Logout</a></div>
<section class="tab" id="t-overview"><div class="glass card" id="sw" style="margin-bottom:16px"></div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))" id="cards"></div>
<div class="glass card" style="margin-top:16px"><h3>Requests, last 24 hours</h3><div style="height:220px;margin-top:10px"><canvas id="ch"></canvas></div></div>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:16px"><div class="glass card sc"><h3>Endpoints</h3><table><tr><th>Name</th><th>Hits</th><th>Errors</th><th>Avg</th><th></th></tr><tbody id="eps"></tbody></table><div style="margin-top:12px" id="codes"></div></div>
<div class="glass card sc"><h3>Recent requests</h3><table><tbody id="recent"></tbody></table></div></div></section>
<section class="tab" id="t-users" hidden><div class="glass card sc"><table><tr><th>Name</th><th>Email</th><th>Login</th><th>Keys</th><th>Audio</th><th>Video</th><th>Search</th><th>Joined</th><th></th></tr><tbody id="users"></tbody></table></div></section>
<section class="tab" id="t-keys" hidden><div class="glass card"><h3>Create key</h3><p class="mu" style="font-size:13px;margin-top:4px">Email empty = your own admin key. Limit 0 = unlimited. Days empty = never expires.</p><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">${inp('nk-name', 'Key name (optional)', 'text')}${inp('nk-email', 'User email (optional)', 'email')}<div><label>Plan</label><select id="nk-plan"><option>paid</option><option>free</option></select></div>${inp('nk-a', 'Audio limit')}${inp('nk-v', 'Video limit')}${inp('nk-s', 'Search limit')}${inp('nk-rpm', 'Req/min')}${inp('nk-d', 'Days valid', 'number')}</div>
<button class="btn" style="margin-top:14px" id="nk">Create key</button> <span class="mu" id="nk-msg"></span></div>
<div class="glass card sc" style="margin-top:16px"><input id="kq" placeholder="Search by email" style="max-width:300px;margin:0 0 12px"><table><tr><th>User / key</th><th>Plan / by</th><th>Audio</th><th>Video</th><th>Search</th><th>Req/min</th><th>Expires</th><th>On</th><th></th></tr><tbody id="keys"></tbody></table></div></section>
<section class="tab" id="t-db" hidden><div class="glass card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><select id="dbc" style="max-width:200px;margin:0"></select><input id="dbq" placeholder="Search email / key / name" style="max-width:260px;margin:0"><button class="btn g s" id="dbprev">Prev</button><button class="btn g s" id="dbnext">Next</button><span class="mu" id="dbp"></span></div></div>
<div id="dbl" style="margin-top:16px"></div><div class="glass card"><h3>Add document</h3><textarea id="dbnew" spellcheck="false">{}</textarea><button class="btn s" id="dbadd" style="margin-top:10px">Insert</button></div></section>
<section class="tab" id="t-settings" hidden><div class="glass card"><h3>Global settings</h3><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">${inp('st-upstream', 'Primary upstream URL', 'text')}${inp('st-upstream2', 'Backup upstream URL', 'text')}${inp('st-defaultRpm', 'Default req/min per key')}${inp('st-freeDays', 'Free key valid days')}${inp('st-freeAudio', 'Free audio limit')}${inp('st-freeVideo', 'Free video limit')}${inp('st-freeSearch', 'Free search limit')}</div>
<div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:18px;font-size:14px"><label style="margin:0"><input id="st-on-audio" type="checkbox" style="width:auto"> Audio on</label><label style="margin:0"><input id="st-on-video" type="checkbox" style="width:auto"> Video on</label><label style="margin:0"><input id="st-on-search" type="checkbox" style="width:auto"> Search on</label><label style="margin:0"><input id="st-maintenance" type="checkbox" style="width:auto"> Maintenance mode (blocks all)</label></div>
<button class="btn" style="margin-top:18px" id="sv">Save settings</button> <span class="ok" id="sv-msg"></span>
<div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn g s" id="ra">Reset ALL usage</button><button class="btn r s" id="cl">Clear all logs</button></div></div></section></div>`,
    { nav: false, src: ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', '/admin.js'] })));
app.post('/sahil/login', limiter(8, 60000), (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(ADMIN_PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong admin password.' });
  setCookie(req, res, 'ak', sign({ admin: true }, '7d'), 7); res.json({ ok: true });
});
app.get('/sahil/logout', (req, res) => { res.clearCookie('ak'); res.redirect('/sahil'); });
const num = v => Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0; // negative (-1) = unlimited
const swState = async () => { const s = await getSet(); return { useBackup: !!s.useBackup, hasBackup: !!s.upstream2, maintenance: !!s.maintenance }; };
const A = express.Router(); app.use('/sahil/api', (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'admin only' }), (req, res, next) => { if (req.method !== 'GET') kc.clear(); next(); }, A);
A.get('/stats', async (req, res) => {
  flush(); const now = new Date(), since = new Date(now - 864e5), bad = { $cond: [{ $gte: ['$status', 400] }, 1, 0] };
  const [tot, hourly, eps, codes, recent, users, keys, ips, used, origin] = await Promise.all([
    Log.aggregate([{ $group: { _id: null, n: { $sum: 1 }, err: { $sum: bad }, ms: { $avg: '$ms' } } }]),
    Log.aggregate([{ $match: { t: { $gte: since } } }, { $group: { _id: { $dateTrunc: { date: '$t', unit: 'hour' } }, n: { $sum: 1 }, err: { $sum: bad } } }]),
    Log.aggregate([{ $group: { _id: '$ep', n: { $sum: 1 }, err: { $sum: bad }, ms: { $avg: '$ms' } } }, { $sort: { n: -1 } }]),
    Log.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Log.find().sort({ t: -1 }).limit(15).lean(), User.estimatedDocumentCount(), Key.estimatedDocumentCount(), Log.distinct('ip').then(a => a.length),
    Key.aggregate([{ $group: { _id: null, a: { $sum: '$used.audio' }, v: { $sum: '$used.video' }, s: { $sum: '$used.search' } } }]),
    Key.aggregate([{ $group: { _id: '$createdBy', n: { $sum: 1 }, a: { $sum: '$used.audio' }, v: { $sum: '$used.video' }, s: { $sum: '$used.search' } } }])]);
  const t = tot[0] || { n: 0, err: 0, ms: 0 }, map = new Map(hourly.map(h => [+h._id, h])), hrs = [];
  for (let i = 23; i >= 0; i--) { const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() - i); const h = map.get(+d) || { n: 0, err: 0 }; hrs.push({ label: d.getHours() + ':00', ok: h.n - h.err, err: h.err }); }
  res.json({ total: t.n, ok: t.n - t.err, err: t.err, avgMs: Math.round(t.ms || 0), users, keys, ips, used: used[0] || {}, origin, sw: await swState(), hrs, eps, codes, recent });
});
A.get('/users', async (req, res) => {
  const [us, ks] = await Promise.all([User.find().sort({ createdAt: -1 }).limit(500).select('-hash').lean(), Key.aggregate([{ $group: { _id: '$email', n: { $sum: 1 }, a: { $sum: '$used.audio' }, v: { $sum: '$used.video' }, s: { $sum: '$used.search' } } }])]);
  const c = {}; ks.forEach(k => c[k._id] = k); res.json(us.map(u => ({ ...u, keys: c[u.email]?.n || 0, a: c[u.email]?.a || 0, v: c[u.email]?.v || 0, s: c[u.email]?.s || 0 })));
});
A.delete('/users/:id', async (req, res) => { const u = await User.findByIdAndDelete(req.params.id); if (u) await Key.deleteMany({ email: u.email }); res.json({ ok: true }); });
A.get('/keys', async (req, res) => { const q = req.query.q ? { email: new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}; res.json(await Key.find(q).sort({ createdAt: -1 }).limit(300).lean()); });
A.post('/keys', async (req, res) => {
  const b = req.body, s = await getSet(), email = (b.email || 'admin').toLowerCase();
  res.json(await Key.create({ key: newKey(), name: String(b.name || '').trim().slice(0, 40) || 'Admin key', email, user: (await User.findOne({ email }))?._id, plan: b.plan || 'paid', createdBy: 'admin', limits: { audio: num(b.audio), video: num(b.video), search: num(b.search) }, rpm: +b.rpm || s.defaultRpm, expiresAt: b.days === '' || b.days == null ? undefined : new Date(Date.now() + (+b.days || 30) * 864e5) }));
});
A.patch('/keys/:id', async (req, res) => {
  const b = req.body, u = { limits: { audio: num(b.audio), video: num(b.video), search: num(b.search) }, rpm: +b.rpm, active: !!b.active, plan: b.plan };
  if (b.expiresAt) u.expiresAt = new Date(b.expiresAt + 'T23:59:59Z'); if (b.resetUsage) u.used = { audio: 0, video: 0, search: 0 };
  res.json(await Key.findByIdAndUpdate(req.params.id, { $set: u }, { new: true }));
});
A.delete('/keys/:id', async (req, res) => { await Key.findByIdAndDelete(req.params.id); res.json({ ok: true }); });
A.post('/keys/:id/regen', async (req, res) => res.json(await Key.findByIdAndUpdate(req.params.id, { key: newKey() }, { new: true }))); // new key string, same limits/usage
A.post('/users/:id/password', async (req, res) => { const p = String(req.body.password || ''); if (p.length < 6) return res.status(400).json({ error: '6+ chars' }); await User.findByIdAndUpdate(req.params.id, { hash: await bcrypt.hash(p, 10) }); res.json({ ok: true }); });
A.post('/users/:id/reset-usage', async (req, res) => { const u = await User.findById(req.params.id); if (u) await Key.updateMany({ email: u.email }, { $set: { used: { audio: 0, video: 0, search: 0 } } }); res.json({ ok: true }); });
A.post('/reset-all-usage', async (req, res) => { await Key.updateMany({}, { $set: { used: { audio: 0, video: 0, search: 0 } } }); res.json({ ok: true }); });
A.delete('/logs', async (req, res) => { flush(); await Log.deleteMany({}); res.json({ ok: true }); });
A.post('/switch', async (req, res) => { // one-click global switches
  const s = await getSet(), m = req.body.what === 'maintenance';
  if (!m && !s.upstream2) return res.status(400).json({ error: 'Set a Backup upstream URL in Settings first.' });
  await Setting.findByIdAndUpdate('main', m ? { maintenance: !s.maintenance } : { useBackup: !s.useBackup }, { upsert: true }); cache = null; res.json(await swState());
});
/* DB manager */
const COLS = { users: User, keys: Key, logs: Log, settings: Setting }, isOid = id => /^[a-f0-9]{24}$/i.test(id), oid = id => isOid(id) ? new mongoose.Types.ObjectId(id) : id;
const revive = d => { for (const k of ['createdAt', 'expiresAt', 't']) if (typeof d[k] === 'string') d[k] = new Date(d[k]); if (typeof d.user === 'string' && isOid(d.user)) d.user = oid(d.user); return d; };
A.get('/db', async (req, res) => res.json(await Promise.all(Object.keys(COLS).map(async name => ({ name, n: await COLS[name].estimatedDocumentCount() })))));
A.get('/db/:c', async (req, res) => {
  const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' });
  const page = Math.max(0, +req.query.page || 0), q = String(req.query.q || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const f = q ? { $or: ['email', 'key', 'name', 'ep', 'q', 'ip'].map(x => ({ [x]: new RegExp(q, 'i') })) } : {};
  const [docs, total] = await Promise.all([M.collection.find(f).sort({ _id: -1 }).skip(page * 20).limit(20).toArray(), M.collection.countDocuments(f)]);
  docs.forEach(d => delete d.hash); res.json({ docs, total });
});
A.put('/db/:c/:id', async (req, res) => {
  const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' });
  const _id = oid(req.params.id), old = await M.collection.findOne({ _id }); if (!old) return res.status(404).json({ error: 'not found' });
  const d = revive({ ...req.body }); delete d._id; if (old.hash) d.hash = old.hash;
  await M.collection.replaceOne({ _id }, d); cache = null; res.json({ ok: true });
});
A.post('/db/:c', async (req, res) => { const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' }); const r = await M.collection.insertOne(revive({ ...req.body })); cache = null; res.json({ ok: true, id: r.insertedId }); });
A.delete('/db/:c/:id', async (req, res) => { const M = COLS[req.params.c]; if (!M) return res.status(404).json({ error: 'no such collection' }); await M.collection.deleteOne({ _id: oid(req.params.id) }); cache = null; res.json({ ok: true }); });
A.get('/settings', async (req, res) => res.json(await getSet()));
A.post('/settings', async (req, res) => {
  const b = req.body; await Setting.findByIdAndUpdate('main', { upstream: String(b.upstream).replace(/\/$/, ''), upstream2: String(b.upstream2 || '').replace(/\/$/, ''), defaultRpm: +b.defaultRpm, freeDays: +b.freeDays, freeAudio: +b.freeAudio, freeVideo: +b.freeVideo, freeSearch: +b.freeSearch, maintenance: !!b.maintenance, off: b.off || [] }, { upsert: true }); cache = null; res.json({ ok: true });
});

/* ── PUBLIC PAGES ── */
app.get('/', async (req, res) => {
  const [s, u] = await Promise.all([getSet(), me(req)]), f = (t, p, n) => `<div class="glass card"><h3>${t}</h3><p>${p}</p><div class="stat" style="padding:10px 0 0"><div>${n}</div><small>free requests</small></div></div>`;
  res.send(page('Nazriya Music API', `<div class="wrap"><section class="hero"><h1>Music API,<br>ready in one key.</h1><p class="l" style="margin-top:20px">Search songs, get audio and video links with a simple API key. Free plan to start, paid plan when you grow.</p>
<div style="display:flex;gap:12px;margin-top:30px;flex-wrap:wrap"><a class="btn" href="${u ? '/dashboard' : '/login'}">${u ? 'Open dashboard' : 'Get free API key'}</a><a class="btn g" href="/docs">Read docs</a></div></section>
<div class="grid g3">${f('Audio', '/api/audio?q=song', s.freeAudio)}${f('Video', '/api/video?q=song', s.freeVideo)}${f('Search', '/api/search?q=song', s.freeSearch)}</div></div>`, { user: u }));
});
app.get('/login', async (req, res) => {
  if (await me(req)) return res.redirect('/dashboard'); const G = !!GID;
  res.send(page('Login · Nazriya API', `<div class="wrap" style="max-width:430px;padding-top:70px"><div class="glass card" style="padding:32px"><h2 id="ttl">Welcome back</h2><p class="mu" style="margin-top:4px">Log in to manage your API key.</p>
<div id="nm" hidden><label>Name</label><input id="name" placeholder="Your name"></div><label>Email</label><input id="email" type="email" autocomplete="email"><label>Password</label><input id="pw" type="password" autocomplete="current-password">
<div class="msg" id="msg"></div><button class="btn" style="width:100%" id="go">Log in</button>${G ? '<div style="text-align:center;margin:18px 0 6px" class="mu">or</div><div id="gbtn" style="display:flex;justify-content:center"></div>' : ''}
<p class="mu" style="text-align:center;margin-top:18px;font-size:14px"><span id="sw">New here?</span> <a href="#" id="tg">Create account</a></p></div></div>`,
    { head: G ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : '', script: `let reg=false;const $=i=>document.getElementById(i);
$('tg').onclick=e=>{e.preventDefault();reg=!reg;$('nm').hidden=!reg;$('ttl').textContent=reg?'Create account':'Welcome back';$('go').textContent=reg?'Sign up':'Log in';$('sw').textContent=reg?'Have an account?':'New here?';$('tg').textContent=reg?'Log in':'Create account'};
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.ok)location='/dashboard';else $('msg').textContent=j.error||'Something went wrong.'}
$('go').onclick=()=>post(reg?'/auth/register':'/auth/login',{name:$('name').value,email:$('email').value,password:$('pw').value});
${G ? `window.onload=()=>{google.accounts.id.initialize({client_id:${JSON.stringify(GID)},callback:r=>post('/auth/google',{credential:r.credential})});google.accounts.id.renderButton($('gbtn'),{theme:'filled_black',shape:'pill',size:'large'})}` : ''}` }));
});
app.get('/dashboard', async (req, res) => {
  const u = await me(req); if (!u) return res.redirect('/login');
  const keys = await Key.find({ $or: [{ user: u._id }, { email: u.email }] }).lean(), now = new Date();
  const bar = (n, used, lim) => `<div style="margin-top:12px;font-size:13px"><span class="mu">${n}</span> <b style="float:right">${used || 0} / ${!lim || lim < 0 ? '∞' : lim}</b><div class="bar"><i style="width:${!lim || lim < 0 ? 0 : Math.min(100, ((used || 0) / (lim || 1)) * 100)}%"></i></div></div>`;
  const cards = keys.map(k => { const exp = k.expiresAt && k.expiresAt < now; return `<div class="glass card"><div style="display:flex;align-items:center;gap:8px"><h3 style="margin-right:auto" id="nm-${k._id}">${esc(k.name || 'My API key')}</h3><button class="btn g s" data-rename="${k._id}" data-cur="${esc(k.name || 'My API key')}">Rename</button></div><div style="margin-top:8px"><span class="pill">${esc(k.plan)}</span> <span class="pill ${k.active && !exp ? 'ok' : 'er'}">${!k.active ? 'disabled' : exp ? 'expired' : 'active'}</span></div>
<pre style="margin-top:14px;word-break:break-all;white-space:pre-wrap">${esc(k.key)}</pre><button class="btn s" style="margin-top:10px;width:100%" data-copy="${esc(k.key)}">Copy API key</button><small class="mu" style="display:block;margin-top:10px">Expires ${k.expiresAt ? k.expiresAt.toISOString().slice(0, 10) : 'never'} · ${k.rpm || 30} req/min</small>
${bar('Audio', k.used?.audio, k.limits?.audio)}${bar('Video', k.used?.video, k.limits?.video)}${bar('Search', k.used?.search, k.limits?.search)}</div>`; }).join('');
  res.send(page('Dashboard · Nazriya API', `<div class="wrap" style="padding-top:40px"><h2>Hi, ${esc(u.name)}</h2><p class="mu">${esc(u.email)}</p>
<div class="grid g3" style="margin-top:24px">${cards || '<div class="glass card"><h3>Create your API key</h3><label>Key name (optional)</label><input id="kn" maxlength="40" placeholder="e.g. My Music Bot"><button class="btn" style="margin-top:16px;width:100%" id="mk">Create free key</button><div class="msg" id="msg"></div></div>'}</div>
<div class="glass card" style="margin-top:16px"><h3>Need more requests?</h3><p>Paid API ke liye contact karo <a href="https://t.me/${DEV}">@${DEV}</a>. <a href="/docs">Read the docs</a> to see how to call the API.</p></div></div>`,
    { user: u, script: `const b=document.getElementById('mk');if(b)b.onclick=async()=>{const r=await fetch('/keys/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('kn').value})});const j=await r.json();j.ok?location.reload():document.getElementById('msg').textContent=j.error}` }));
});
app.get('/docs', async (req, res) => {
  const [u, s] = await Promise.all([me(req), getSet()]), B = `${req.protocol}://${req.get('host')}`;
  const code = (t) => `<pre>${t}</pre>`;
  const sec = (id, title, desc, example, resp, note) => `<div class="glass card" id="${id}" style="margin-top:16px"><h3><span class="pill ok">GET</span> /api/${id}</h3><p>${desc}</p>
<h4 style="margin:18px 0 6px">Parameters</h4><table><tr><th>Name</th><th>Required</th><th>Description</th></tr><tr><td><code>q</code></td><td>Yes</td><td>${id === 'search' ? 'Search text, e.g. song or artist name' : 'Song name (or artist + song name)'}</td></tr><tr><td><code>key</code></td><td>Yes</td><td>Your API key (or send it in the <code>x-api-key</code> header)</td></tr></table>
<h4 style="margin:18px 0 6px">Request</h4>${code(example)}
<h4 style="margin:18px 0 6px">Response <span class="pill ok">200</span></h4>${code(resp)}${note ? `<p class="mu" style="margin-top:10px;font-size:13px">${note}</p>` : ''}
<h4 style="margin:18px 0 6px">Code</h4>${code(`<b>JavaScript</b>\nconst r = await fetch("${B}/api/${id}?q=aarzu", { headers: { "x-api-key": "YOUR_KEY" } });\nconst data = await r.json();\n\n<b>Python</b>\nimport requests\ndata = requests.get("${B}/api/${id}", params={"q": "aarzu", "key": "YOUR_KEY"}).json()`)}</div>`;
  res.send(page('Docs · Nazriya API', `<div class="wrap" style="padding-top:40px;max-width:820px"><h1 style="font-size:44px">API docs</h1><p class="l" style="margin-top:12px">Three endpoints, one key. Base URL: <code>${B}</code></p>
<div class="glass card" style="margin-top:20px"><h3>Jump to</h3><p style="margin-top:8px"><a href="#auth">Authentication</a> · <a href="#search">Search</a> · <a href="#audio">Audio</a> · <a href="#video">Video</a> · <a href="#limits">Limits</a> · <a href="#errors">Errors</a></p></div>
<div class="glass card" id="auth" style="margin-top:16px"><h3>Authentication</h3><p>Create a free key in your <a href="/dashboard">dashboard</a>. Send it with every request, in one of two ways:</p>
<table style="margin-top:12px"><tr><th>Method</th><th>Example</th></tr><tr><td>Query parameter</td><td><code>?key=YOUR_KEY</code></td></tr><tr><td>Header</td><td><code>x-api-key: YOUR_KEY</code></td></tr></table></div>
${sec('search', 'Search', 'For Search: finds songs by name and returns the matching results. Use it to show a list to your users.', `GET ${B}/api/search?q=aarzu&amp;key=YOUR_KEY`, `{\n  "success": true,\n  "results": [\n    {\n      "title": "Aarzu",\n      "id": "VIDEO_ID",\n      "duration": "3:45",\n      "thumbnail": "https://...",\n      "url": "https://..."\n    }\n  ]\n}`, 'Response is passed through exactly as the source returns it, so field names may be slightly different from this example.')}
${sec('audio', 'Audio', 'For Audio: returns the playable audio link for a song. Use it for audio players and music bots.', `GET ${B}/api/audio?q=aarzu&amp;key=YOUR_KEY`, `{\n  "success": true,\n  "title": "Aarzu",\n  "duration": "3:45",\n  "audio": "https://.../audio-link"\n}`, 'Response is passed through exactly as the source returns it, so field names may be slightly different from this example.')}
${sec('video', 'Video', 'For Video: returns the playable video link for a song. Use it for video players and video chat bots.', `GET ${B}/api/video?q=aarzu&amp;key=YOUR_KEY`, `{\n  "success": true,\n  "title": "Aarzu",\n  "duration": "3:45",\n  "video": "https://.../video-link"\n}`, 'Response is passed through exactly as the source returns it, so field names may be slightly different from this example.')}
<div class="glass card" id="limits" style="margin-top:16px"><h3>Free plan limits</h3><table style="margin-top:10px"><tr><th>Audio</th><th>Video</th><th>Search</th><th>Valid for</th><th>Rate</th></tr><tr><td>${s.freeAudio}</td><td>${s.freeVideo}</td><td>${s.freeSearch}</td><td>${s.freeDays} days</td><td>${s.defaultRpm}/min</td></tr></table><p class="mu" style="margin-top:10px;font-size:13px">Failed requests are not counted against your quota. Need more? Contact <a href="https://t.me/${DEV}">@${DEV}</a> for the paid plan.</p></div>
<div class="glass card" id="errors" style="margin-top:16px"><h3>Errors</h3><table style="margin-top:10px"><tr><th>Code</th><th>Meaning</th></tr><tr><td>400</td><td>Missing <code>q</code></td></tr><tr><td>401</td><td>Missing or invalid key</td></tr><tr><td>403</td><td>Key expired or disabled</td></tr><tr><td>429</td><td>Quota finished or rate limit hit</td></tr><tr><td>502 / 503</td><td>Source error or endpoint disabled</td></tr></table>${code('{ "success": false, "error": "Invalid API key." }')}</div></div>`, { user: u }));
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });
mongoose.connect(MONGO_URI).then(() => app.listen(PORT, () => console.log('Running on http://localhost:' + PORT))).catch(e => { console.error('Mongo error:', e.message); process.exit(1); });
