const ADMIN = document.body.dataset.admin;
const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (u, m = 'GET', b) => {
  try {
    const r = await fetch(ADMIN + '/api/' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    if (r.status === 401) { location.reload(); return { error: 'Session expired' }; }
    return await r.json().catch(() => ({ error: 'Server error (' + r.status + ')' }));
  } catch { return { error: 'Network error' }; }
};
const fmt = n => (n = n || 0) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n;
const debounce = (f, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const day = d => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? '' : x.toISOString().slice(0, 10); };
const randKey = () => 'nz_' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
const KEY_RE = /^[A-Za-z0-9_-]{6,64}$/;
let chart, S = {};
const loadSettings = async () => { const s = await api('settings'); if (!s.error) S = s; return S; };

/* ── OVERVIEW ── */
async function overview() {
  const d = await api('stats'); if (d.error) return toast(d.error, 'er');
  const w = d.sw;
  $('#sw').innerHTML = `<div class="row wrapr"><div class="grow"><h3>Quick switch</h3><span class="mu small">Source: <b>${w.useBackup ? 'Backup' : 'Primary'}</b> · API: <b class="${w.maintenance ? 'er' : 'ok'}">${w.maintenance ? 'OFF (maintenance)' : 'ON'}</b> · Free API: <b class="${w.freeOff ? 'er' : 'ok'}">${w.freeOff ? 'OFF' : 'ON'}</b></span></div><button class="btn g" data-sw="source">Switch to ${w.useBackup ? 'primary' : 'backup'} source</button><button class="btn ${w.freeOff ? 'ok' : 'r'}" data-sw="free">${w.freeOff ? 'Turn on free API' : 'Turn off free API'}</button><button class="btn ${w.maintenance ? 'ok' : 'r'}" data-sw="maintenance">${w.maintenance ? 'Turn API on' : 'Turn API off'}</button></div>`;
  const t = d.types || {};
  $('#cards').innerHTML = [['Total requests', fmt(d.total)], ['Success', fmt(d.ok), 'ok'], ['Errors', fmt(d.err), 'er'], ['Avg latency', d.avgMs + ' ms'], ['Users', d.users], ['Unique IPs (24h)', d.ips],
    ['Free keys', t.free || 0, 'ok', 'free'], ['Admin keys', t.admin || 0, 'v', 'admin'], ['Audio used', fmt(d.used.a)], ['Video used', fmt(d.used.v)], ['Search used', fmt(d.used.s)]]
    .map(c => `<div class="glass stat${c[3] ? ' link' : ''}"${c[3] ? ` data-goto="${c[3]}" tabindex="0"` : ''}><small>${c[0]}</small><div class="${c[2] || ''}">${c[1]}</div></div>`).join('');
  const data = { labels: d.hrs.map(h => h.label), datasets: [{ label: 'Success', data: d.hrs.map(h => h.ok), backgroundColor: 'rgba(61,220,151,.75)', borderRadius: 5 }, { label: 'Error', data: d.hrs.map(h => h.err), backgroundColor: 'rgba(255,90,95,.75)', borderRadius: 5 }] };
  if (window.Chart) {
    if (!chart) { Chart.defaults.color = '#a99fb5'; Chart.defaults.font.family = 'Manrope, system-ui'; chart = new Chart($('#ch'), { type: 'bar', data, options: { maintainAspectRatio: false, animation: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(255,255,255,.06)' } } }, plugins: { legend: { position: 'top', align: 'end' } } } }); }
    else { chart.data = data; chart.update('none'); }
  }
  const mx = d.eps[0]?.n || 1;
  $('#eps').innerHTML = d.eps.map(e => `<tr><td><code>/api/${esc(e._id)}</code></td><td>${e.n}</td><td class="er">${e.err}</td><td>${Math.round(e.ms)}ms</td><td style="width:90px"><div class="bar"><i style="width:${e.n / mx * 100}%"></i></div></td></tr>`).join('') || '<tr><td class="mu">No requests yet</td></tr>';
  $('#codes').innerHTML = d.codes.map(c => `<span class="pill ${c._id < 400 ? 'ok' : 'er'}">${c._id}: ${c.n}</span>`).join('');
  $('#recent').innerHTML = d.recent.map(r => `<tr><td class="mu">${new Date(r.t).toLocaleTimeString()}</td><td>${esc(r.email || '-')}</td><td><code>${esc(r.ep)}</code> ${esc(r.q)}</td><td class="${r.status < 400 ? 'ok' : 'er'}">${r.status}</td><td>${r.ms}ms</td></tr>`).join('') || '<tr><td class="mu">No requests yet</td></tr>';
}

/* ── USERS ── */
let U = [];
const drawUsers = () => {
  const q = ($('#uq').value || '').toLowerCase(), list = q ? U.filter(x => (x.name + ' ' + x.email).toLowerCase().includes(q)) : U;
  $('#users').innerHTML = list.map(x => `<tr data-uid="${x._id}" data-email="${esc(x.email)}"><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${x.googleId ? 'Google' : 'Password'}</td><td>${x.keys}</td><td>${x.a}</td><td>${x.v}</td><td>${x.s}</td><td class="mu">${new Date(x.createdAt).toLocaleDateString()}</td>
<td class="nw"><button class="btn v s" data-u="give">Give key</button> <button class="btn g s" data-u="keys">Keys</button> <button class="btn g s" data-u="pw">New password</button> <button class="btn g s" data-u="reset">Reset use</button> <button class="btn r s" data-u="del">Delete</button></td></tr>`).join('') || '<tr><td class="mu" colspan="9">No users found</td></tr>';
};
async function users() { const u = await api('users'); if (u.error) return toast(u.error, 'er'); U = u; drawUsers(); }

/* ── KEYS ── */
let kf = 'all', nkMode = 'admin';
const pct = (u, l) => !l || l <= 0 ? 0 : Math.min(100, (u || 0) / l * 100);
function kcard(x) {
  const exp = x.expiresAt && new Date(x.expiresAt) < new Date(), st = !x.active ? ['disabled', 'er'] : exp ? ['expired', 'warn'] : ['active', 'ok'];
  const L = (cls, l, n, u) => `<div class="f"><label>${l} limit</label><input class="${cls}" type="number" min="0" value="${n ?? 0}"><div class="bar${pct(u, n) > 85 ? ' hot' : ''}"><i style="width:${pct(u, n)}%"></i></div><small class="mu">${fmt(u)} / ${n > 0 ? fmt(n) : '∞'} used</small></div>`;
  return `<article class="glass card kcard" data-id="${x._id}" data-key="${esc(x.key)}">
<div class="row"><input class="nm" value="${esc(x.name || '')}" maxlength="40" aria-label="Key name"><label class="tg" title="Key on/off"><input class="act" type="checkbox" ${x.active ? 'checked' : ''}><i></i></label></div>
<div class="row tags"><span class="pill ${x.plan === 'free' ? 'ok' : 'v'}">${esc(x.plan)}</span><span class="pill">${x.createdBy === 'admin' ? 'made by admin' : 'made by user'}</span>${x.custom ? '<span class="pill warn">custom key</span>' : ''}<span class="pill ${st[1]}">${st[0]}</span></div>
<div class="mu small em">${esc(x.email || '-')}</div>
<div class="keybox"><code>${esc(x.key)}</code><button class="btn g s" data-k="copy">Copy</button></div>
<div class="row"><button class="btn g s" data-k="custom">Set custom key</button><button class="btn g s" data-k="regen">New random key</button></div>
<div class="fgrid sm">${L('in-a', 'Audio', x.limits?.audio, x.used?.audio)}${L('in-v', 'Video', x.limits?.video, x.used?.video)}${L('in-s', 'Search', x.limits?.search, x.used?.search)}
<div class="f"><label>Requests / min</label><input class="in-rpm" type="number" min="1" value="${x.rpm || ''}"></div><div class="f"><label>Expires</label><input class="in-exp" type="date" value="${day(x.expiresAt)}"></div>
<div class="f"><label>Plan</label><select class="in-plan"><option ${x.plan === 'free' ? 'selected' : ''}>free</option><option ${x.plan !== 'free' ? 'selected' : ''}>paid</option></select></div></div>
<div class="row wrapr"><button class="btn s" data-k="save">Save</button><button class="btn g s" data-k="extend">+30 days</button><button class="btn g s" data-k="reset">Reset use</button><span class="grow"></span><button class="btn r s" data-k="del">Delete</button></div></article>`;
}
async function keys() {
  const r = await api(`keys?type=${kf}&q=${encodeURIComponent($('#kq').value || '')}`); if (r.error) return toast(r.error, 'er');
  const c = r.counts || {}; $('#kc-all').textContent = c.all || 0; $('#kc-free').textContent = c.free || 0; $('#kc-admin').textContent = c.admin || 0;
  $('#keys').innerHTML = r.list.map(kcard).join('') || `<div class="glass card empty"><p>No ${kf === 'all' ? '' : kf + ' '}keys yet.</p><button class="btn ${kf === 'free' ? 'ok' : 'v'}" data-new="${kf === 'free' ? 'free' : 'admin'}">Create ${kf === 'free' ? 'a free' : 'an admin'} key</button></div>`;
}
function setKf(v) { kf = v; $$('[data-kf]').forEach(b => b.classList.toggle('on', b.dataset.kf === v)); keys(); }
async function openNew(mode, email = '') {
  if (!S.defaultRpm) await loadSettings();
  nkMode = mode; const f = mode === 'free';
  $('#nk-box').hidden = false; $('#nk-out').hidden = true; $('#nk-msg').textContent = '';
  $('#nk-mode').textContent = f ? 'New free key' : 'New admin key'; $('#nk-mode').className = 'pill ' + (f ? 'ok' : 'v');
  $('#nk-planw').hidden = f;
  $('#nk-name').value = f ? 'Free key' : 'Admin key'; $('#nk-email').value = email; $('#nk-custom').value = '';
  $('#nk-a').value = f ? S.freeAudio : 0; $('#nk-v').value = f ? S.freeVideo : 0; $('#nk-s').value = f ? S.freeSearch : 0;
  $('#nk-rpm').value = S.defaultRpm || 30; $('#nk-d').value = f ? S.freeDays : ''; $('#nk-plan').value = 'paid';
  $('#nk').className = 'btn ' + (f ? 'ok' : 'v');
  $('#nk-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); $('#nk-name').focus();
}
async function createKey() {
  const g = i => $('#' + i).value.trim(), custom = g('nk-custom');
  if (custom && !KEY_RE.test(custom)) return $('#nk-msg').textContent = 'Custom key: 6–64 characters, letters, numbers, _ or -';
  $('#nk').disabled = true;
  const r = await api('keys', 'POST', { type: nkMode, name: g('nk-name'), email: g('nk-email'), custom, audio: g('nk-a'), video: g('nk-v'), search: g('nk-s'), rpm: g('nk-rpm'), days: g('nk-d'), plan: $('#nk-plan').value });
  $('#nk').disabled = false;
  if (!r.key) return $('#nk-msg').textContent = r.error || 'Could not create the key';
  $('#nk-msg').textContent = ''; $('#nk-key').textContent = r.key; $('#nk-out').hidden = false; toast('Key created');
  setKf(nkMode === 'free' ? 'free' : 'admin');
}
const cardBody = (card, extra = {}) => { const g = c => card.querySelector('input.' + c + ',select.' + c); return { name: g('nm').value, audio: g('in-a').value, video: g('in-v').value, search: g('in-s').value, rpm: g('in-rpm').value, expiresAt: g('in-exp').value, active: g('act').checked, plan: g('in-plan').value, ...extra }; };
async function keyAction(b) {
  const card = b.closest('[data-id]'), id = card.dataset.id, a = b.dataset.k;
  const done = (r, msg) => { if (r.error) return toast(r.error, 'er'); toast(msg); keys(); };
  if (a === 'copy') { await copyText(card.dataset.key); return toast('Key copied'); }
  if (a === 'save') return done(await api('keys/' + id, 'PATCH', cardBody(card)), 'Saved');
  if (a === 'reset') { if (confirm('Reset usage of this key to 0?')) done(await api('keys/' + id, 'PATCH', cardBody(card, { resetUsage: true })), 'Usage reset'); return; }
  if (a === 'extend') { const e = card.querySelector('.in-exp'), cur = e.value ? new Date(e.value) : null, base = cur && cur > new Date() ? cur : new Date(); base.setDate(base.getDate() + 30); e.value = day(base); return done(await api('keys/' + id, 'PATCH', cardBody(card)), 'Extended to ' + e.value); }
  if (a === 'custom') {
    const k = prompt('Custom API key (6–64 characters: letters, numbers, _ or -).\nThe old key stops working.', card.dataset.key); if (!k || k.trim() === card.dataset.key) return;
    if (!KEY_RE.test(k.trim())) return toast('Use 6–64 characters: letters, numbers, _ or -', 'er');
    return done(await api('keys/' + id + '/set', 'POST', { key: k.trim() }), 'Custom key set');
  }
  if (a === 'regen') { if (confirm('Generate a new random key? The old key stops working.')) done(await api('keys/' + id + '/regen', 'POST'), 'New key generated'); return; }
  if (a === 'del') { if (confirm('Delete this key? Apps using it stop working.')) done(await api('keys/' + id, 'DELETE'), 'Key deleted'); }
}

/* ── SETTINGS ── */
const SF = ['upstream', 'upstream2', 'defaultRpm', 'freeDays', 'freeAudio', 'freeVideo', 'freeSearch'];
async function settings() {
  const s = await loadSettings(); if (!s.upstream) return;
  for (const k of SF) $('#st-' + k).value = s[k] ?? '';
  $('#st-maintenance').checked = !!s.maintenance; for (const e of ['audio', 'video', 'search', 'flac', 'suggest', 'artist', 'trending']) $('#st-on-' + e).checked = !(s.off || []).includes(e);
}

/* ── DATABASE ── */
let dbPage = 0;
async function dbm() {
  const cols = await api('db'); if (cols.error) return toast(cols.error, 'er');
  const cur = $('#dbc').value || 'keys';
  $('#dbc').innerHTML = cols.map(c => `<option value="${c.name}" ${c.name === cur ? 'selected' : ''}>${c.name} (${c.n})</option>`).join('');
  const c = $('#dbc').value, r = await api(`db/${c}?page=${dbPage}&q=${encodeURIComponent($('#dbq').value || '')}`); if (r.error) return toast(r.error, 'er');
  $('#dbl').innerHTML = r.docs.map(d => `<div class="glass card" data-id="${esc(d._id)}"><textarea spellcheck="false">${esc(JSON.stringify(d, null, 2))}</textarea><div class="row"><button class="btn s" data-db="save">Save</button><button class="btn r s" data-db="del">Delete</button></div></div>`).join('') || '<div class="glass card mu">No documents</div>';
  $('#dbp').textContent = `Page ${dbPage + 1} of ${Math.max(1, Math.ceil(r.total / 20))} · ${r.total} docs`;
}

/* ── TABS (remembered in the URL, so /nazriya#keys opens the keys tab) ── */
const TABS = { overview, keys, users, settings, db: dbm };
function tab(n) {
  if (!TABS[n]) n = 'overview';
  $$('.tab').forEach(e => e.hidden = e.id !== 't-' + n); $$('[data-tab]').forEach(b => { const on = b.dataset.tab === n; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  if (location.hash.slice(1) !== n) history.replaceState(null, '', '#' + n);
  TABS[n]();
}
$$('[data-tab]').forEach(b => b.onclick = () => tab(b.dataset.tab));
window.addEventListener('hashchange', () => tab(location.hash.slice(1)));

/* ── EVENTS ── */
document.addEventListener('click', async e => {
  const t = e.target;
  const k = t.closest('[data-k]'); if (k) return keyAction(k);
  const nw = t.closest('[data-new]'); if (nw) { if ($('#t-keys').hidden) tab('keys'); return openNew(nw.dataset.new); }
  const f = t.closest('[data-kf]'); if (f) return setKf(f.dataset.kf);
  const go = t.closest('[data-goto]'); if (go) { tab('keys'); return setKf(go.dataset.goto); }
  const s = t.closest('[data-sw]'); if (s) {
    const w = s.dataset.sw; if (w === 'free' && s.textContent.includes('off') && !confirm('Turn off free API? Every key users made after login stops working until you turn it back on. Admin and paid keys keep working.')) return;
    const r = await api('switch', 'POST', { what: w }); if (r.error) toast(r.error, 'er'); else toast(w === 'free' ? (r.freeOff ? 'Free API turned off' : 'Free API turned on') : 'Switched'); return overview(); }
  const u = t.closest('[data-u]');
  if (u) {
    const tr = u.closest('tr'), id = tr.dataset.uid, email = tr.dataset.email, a = u.dataset.u;
    if (a === 'give') { tab('keys'); return openNew('admin', email); }
    if (a === 'keys') { $('#kq').value = email; tab('keys'); return setKf('all'); }
    if (a === 'pw') { const p = prompt('New password for ' + email + ' (6+ characters)'); if (p) { const r = await api('users/' + id + '/password', 'POST', { password: p }); r.ok ? toast('Password changed') : toast(r.error, 'er'); } }
    if (a === 'reset' && confirm('Reset usage of all keys of ' + email + '?')) { await api('users/' + id + '/reset-usage', 'POST'); toast('Usage reset'); users(); }
    if (a === 'del' && confirm('Delete ' + email + ' and all their keys?')) { await api('users/' + id, 'DELETE'); toast('User deleted'); users(); }
    return;
  }
  const d = t.closest('[data-db]');
  if (d) {
    const box = d.closest('[data-id]'), c = $('#dbc').value;
    if (d.dataset.db === 'del') { if (!confirm('Delete this document?')) return; await api(`db/${c}/${encodeURIComponent(box.dataset.id)}`, 'DELETE'); toast('Deleted'); return dbm(); }
    let j; try { j = JSON.parse(box.querySelector('textarea').value); } catch { return toast('Invalid JSON', 'er'); }
    const r = await api(`db/${c}/${encodeURIComponent(box.dataset.id)}`, 'PUT', j); r.error ? toast(r.error, 'er') : toast('Saved');
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.goto) e.target.click(); });
// flipping the on/off switch saves at once
document.addEventListener('change', async e => {
  if (!e.target.classList.contains('act')) return; const card = e.target.closest('[data-id]');
  const r = await api('keys/' + card.dataset.id, 'PATCH', cardBody(card)); r.error ? toast(r.error, 'er') : toast(e.target.checked ? 'Key turned on' : 'Key turned off'); keys();
});
$('#kq').oninput = debounce(keys); $('#uq').oninput = drawUsers;
$('#nk').onclick = createKey; $('#nk-x').onclick = () => $('#nk-box').hidden = true;
$('#nk-rand').onclick = () => { $('#nk-custom').value = randKey(); $('#nk-custom').focus(); };
$('#nk-cp').onclick = async () => { await copyText($('#nk-key').textContent); toast('Key copied'); };
$('#nk-box').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') createKey(); });
$('#sv').onclick = async () => {
  const g = i => $('#st-' + i).value;
  const r = await api('settings', 'POST', { upstream: g('upstream'), upstream2: g('upstream2'), defaultRpm: g('defaultRpm'), freeDays: g('freeDays'), freeAudio: g('freeAudio'), freeVideo: g('freeVideo'), freeSearch: g('freeSearch'), maintenance: $('#st-maintenance').checked, off: ['audio', 'video', 'search', 'flac', 'suggest', 'artist', 'trending'].filter(x => !$('#st-on-' + x).checked) });
  if (r.error) return toast(r.error, 'er'); S = r.settings || S; toast('Settings saved');
};
$('#ra').onclick = async () => { if (confirm('Reset usage of ALL keys?')) { await api('reset-all-usage', 'POST'); toast('All usage reset'); } };
$('#cl').onclick = async () => { if (confirm('Delete ALL request logs?')) { await api('logs', 'DELETE'); toast('Logs cleared'); } };
$('#dbc').onchange = () => { dbPage = 0; dbm(); }; $('#dbq').oninput = debounce(() => { dbPage = 0; dbm(); });
$('#dbprev').onclick = () => { if (dbPage > 0) { dbPage--; dbm(); } }; $('#dbnext').onclick = () => { dbPage++; dbm(); };
$('#dbadd').onclick = async () => { let j; try { j = JSON.parse($('#dbnew').value); } catch { return toast('Invalid JSON', 'er'); } const r = await api(`db/${$('#dbc').value}`, 'POST', j); r.ok ? toast('Inserted') : toast(r.error, 'er'); dbm(); };

tab(location.hash.slice(1) || 'overview'); loadSettings();
setInterval(() => { if (!$('#t-overview').hidden && !document.hidden) overview(); }, 15000);
