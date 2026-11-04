const $ = s => document.querySelector(s), esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (u, m = 'GET', b) => fetch('/sahil/api/' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : (n || 0);
let chart;
async function overview() {
  const d = await api('stats'); if (d.error) return;
  const w = d.sw; $('#sw').innerHTML = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="margin-right:auto"><h3>Quick switch</h3><small class="mu">Source: <b>${w.useBackup ? 'Backup' : 'Primary'}</b> · API: <b class="${w.maintenance ? 'er' : 'ok'}">${w.maintenance ? 'OFF (maintenance)' : 'ON'}</b></small></div><button class="btn" data-sw="source">Switch to ${w.useBackup ? 'Primary' : 'Backup'} source</button><button class="btn ${w.maintenance ? '' : 'r'}" data-sw="maintenance">${w.maintenance ? 'Turn API ON' : 'Turn API OFF'}</button></div>`;
  $('#cards').innerHTML = [['Total requests', fmt(d.total)], ['Success', fmt(d.ok)], ['Errors', fmt(d.err)], ['Avg latency', d.avgMs + ' ms'], ['Users', d.users], ['API keys', d.keys], ['Unique IPs', d.ips], ['Audio used', fmt(d.used.a)], ['Video used', fmt(d.used.v)], ['Search used', fmt(d.used.s)], ...d.origin.map(o => [`Keys by ${o._id || 'user'}`, `${o.n}`]), ...d.origin.map(o => [`${o._id || 'user'} keys: A / V / S`, `${fmt(o.a)} / ${fmt(o.v)} / ${fmt(o.s)}`])]
    .map(c => `<div class="glass stat"><small>${c[0]}</small><div>${c[1]}</div></div>`).join('');
  const data = { labels: d.hrs.map(h => h.label), datasets: [{ label: 'Success', data: d.hrs.map(h => h.ok), backgroundColor: 'rgba(48,209,88,.7)', borderRadius: 5 }, { label: 'Error', data: d.hrs.map(h => h.err), backgroundColor: 'rgba(255,69,58,.7)', borderRadius: 5 }] };
  if (!chart) { Chart.defaults.color = '#9a9aa5'; chart = new Chart($('#ch'), { type: 'bar', data, options: { maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(255,255,255,.06)' } } }, plugins: { legend: { position: 'top', align: 'end' } } } }); }
  else { chart.data = data; chart.update('none'); }
  const mx = d.eps[0]?.n || 1;
  $('#eps').innerHTML = d.eps.map(e => `<tr><td><code>/api/${esc(e._id)}</code></td><td>${e.n}</td><td class="er">${e.err}</td><td>${Math.round(e.ms)}ms</td><td style="width:90px"><div class="bar"><i style="width:${e.n / mx * 100}%"></i></div></td></tr>`).join('') || '<tr><td class="mu">No requests yet</td></tr>';
  $('#codes').innerHTML = d.codes.map(c => `<span class="pill ${c._id < 400 ? 'ok' : 'er'}" style="margin:3px">${c._id}: ${c.n}</span>`).join('');
  $('#recent').innerHTML = d.recent.map(r => `<tr><td class="mu">${new Date(r.t).toLocaleTimeString()}</td><td>${esc(r.email || '-')}</td><td><code>${esc(r.ep)}</code> ${esc(r.q)}</td><td class="${r.status < 400 ? 'ok' : 'er'}">${r.status}</td><td>${r.ms}ms</td></tr>`).join('');
}
async function users() {
  const u = await api('users');
  $('#users').innerHTML = u.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${x.googleId ? 'Google' : 'Password'}</td><td>${x.keys}</td><td>${x.a}</td><td>${x.v}</td><td>${x.s}</td><td class="mu">${new Date(x.createdAt).toLocaleDateString()}</td><td style="white-space:nowrap" data-uid="${x._id}"><button class="btn g s" data-pw="1">New password</button> <button class="btn g s" data-ru="1">Reset use</button> <button class="btn r s" data-du="${x._id}">Delete</button></td></tr>`).join('');
}
async function keys() {
  const k = await api('keys?q=' + encodeURIComponent($('#kq').value || ''));
  $('#keys').innerHTML = k.map(x => `<tr data-id="${x._id}"><td><b>${esc(x.name || '')}</b><br>${esc(x.email)}<br><code class="mu">${esc(x.key.slice(0, 14))}…</code><br><button class="btn g s" data-cp="${esc(x.key)}">Copy</button></td>
<td><span class="pill">${esc(x.createdBy || 'user')}</span><br><select class="plan"><option ${x.plan == 'free' ? 'selected' : ''}>free</option><option ${x.plan == 'paid' ? 'selected' : ''}>paid</option></select></td>
<td><input class="a" type="number" value="${x.limits?.audio ?? 0}"><small class="mu">used ${x.used?.audio || 0}</small></td><td><input class="v" type="number" value="${x.limits?.video ?? 0}"><small class="mu">used ${x.used?.video || 0}</small></td><td><input class="s" type="number" value="${x.limits?.search ?? 0}"><small class="mu">used ${x.used?.search || 0}</small></td>
<td><input class="rpm" type="number" value="${x.rpm || 30}"></td><td><input class="exp" type="date" value="${x.expiresAt ? x.expiresAt.slice(0, 10) : ''}"></td>
<td><input class="act" type="checkbox" style="min-width:0;width:18px" ${x.active ? 'checked' : ''}></td><td style="white-space:nowrap"><button class="btn s" data-sv="1">Save</button> <button class="btn g s" data-rs="1">Reset use</button> <button class="btn g s" data-rg="1">New key</button> <button class="btn r s" data-dk="1">Del</button></td></tr>`).join('');
}
async function settings() {
  const s = await api('settings'); for (const k of ['upstream', 'upstream2', 'defaultRpm', 'freeDays', 'freeAudio', 'freeVideo', 'freeSearch']) $('#st-' + k).value = s[k];
  $('#st-maintenance').checked = s.maintenance; for (const e of ['audio', 'video', 'search']) $('#st-on-' + e).checked = !s.off.includes(e);
}
function tab(n) { document.querySelectorAll('.tab').forEach(e => e.hidden = e.id !== 't-' + n); document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === n)); ({ users, keys, settings, overview, db: dbm })[n](); }
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => tab(b.dataset.tab));
$('#kq').oninput = keys;
document.addEventListener('click', async e => {
  const t = e.target, tr = t.closest('tr');
  if (t.dataset.cp) { copyText(t.dataset.cp); t.textContent = 'Copied'; }
  if (t.dataset.du && confirm('Delete user and their keys?')) { await api('users/' + t.dataset.du, 'DELETE'); users(); }
  if (t.dataset.dk && confirm('Delete this key?')) { await api('keys/' + tr.dataset.id, 'DELETE'); keys(); }
  if (t.dataset.sw) { const r = await api('switch', 'POST', { what: t.dataset.sw }); if (r.error) alert(r.error); overview(); }
  if (t.dataset.dbs || t.dataset.dbd) { const box = t.closest('[data-id]'), c = $('#dbc').value;
    if (t.dataset.dbd) { if (!confirm('Delete this document?')) return; await api(`db/${c}/${box.dataset.id}`, 'DELETE'); }
    else { let j; try { j = JSON.parse(box.querySelector('textarea').value); } catch { return alert('Invalid JSON'); } const r = await api(`db/${c}/${box.dataset.id}`, 'PUT', j); if (r.error) return alert(r.error); t.textContent = 'Saved'; return; }
    dbm(); }
  if (t.dataset.rg && confirm('Generate a new key string? Old key stops working.')) { await api('keys/' + tr.dataset.id + '/regen', 'POST'); keys(); }
  if (t.dataset.pw) { const p = prompt('New password for this user (6+ chars)'); if (p) { const r = await api('users/' + tr.querySelector('[data-uid]').dataset.uid + '/password', 'POST', { password: p }); alert(r.ok ? 'Password changed' : r.error); } }
  if (t.dataset.ru && confirm('Reset usage of all this user keys?')) { await api('users/' + tr.querySelector('[data-uid]').dataset.uid + '/reset-usage', 'POST'); users(); }
  if (t.dataset.sv || t.dataset.rs) {
    await api('keys/' + tr.dataset.id, 'PATCH', { audio: tr.querySelector('.a').value, video: tr.querySelector('.v').value, search: tr.querySelector('.s').value, rpm: tr.querySelector('.rpm').value, expiresAt: tr.querySelector('.exp').value, active: tr.querySelector('.act').checked, plan: tr.querySelector('.plan').value, resetUsage: !!t.dataset.rs });
    keys();
  }
});
$('#nk').onclick = async () => { const g = i => $('#' + i).value; const r = await api('keys', 'POST', { email: g('nk-email'), plan: g('nk-plan'), audio: g('nk-a'), video: g('nk-v'), search: g('nk-s'), name: g('nk-name'), rpm: g('nk-rpm'), days: g('nk-d') }); $('#nk-msg').textContent = r.key ? 'Created: ' + r.key : (r.error || 'Failed'); keys(); };
$('#sv').onclick = async () => { const g = i => $('#st-' + i).value; await api('settings', 'POST', { upstream: g('upstream'), upstream2: g('upstream2'), defaultRpm: g('defaultRpm'), freeDays: g('freeDays'), freeAudio: g('freeAudio'), freeVideo: g('freeVideo'), freeSearch: g('freeSearch'), maintenance: $('#st-maintenance').checked, off: ['audio', 'video', 'search'].filter(x => !$('#st-on-' + x).checked) }); $('#sv-msg').textContent = 'Saved'; };
overview(); setInterval(() => { if (!$('#t-overview').hidden) overview(); }, 15000);

$('#ra').onclick = async () => { if (confirm('Reset usage of ALL keys?')) { await api('reset-all-usage', 'POST'); $('#sv-msg').textContent = 'All usage reset'; } };
$('#cl').onclick = async () => { if (confirm('Delete ALL request logs?')) { await api('logs', 'DELETE'); $('#sv-msg').textContent = 'Logs cleared'; } };

let dbPage = 0;
async function dbm() {
  const cols = await api('db'), cur = $('#dbc').value || 'keys';
  $('#dbc').innerHTML = cols.map(c => `<option value="${c.name}" ${c.name === cur ? 'selected' : ''}>${c.name} (${c.n})</option>`).join('');
  const c = $('#dbc').value, r = await api(`db/${c}?page=${dbPage}&q=${encodeURIComponent($('#dbq').value || '')}`);
  $('#dbl').innerHTML = r.docs.map(d => `<div class="glass card" style="margin-bottom:12px" data-id="${esc(d._id)}"><textarea spellcheck="false">${esc(JSON.stringify(d, null, 2))}</textarea><div style="margin-top:10px;display:flex;gap:8px"><button class="btn s" data-dbs="1">Save</button><button class="btn r s" data-dbd="1">Delete</button></div></div>`).join('') || '<p class="mu">No documents</p>';
  $('#dbp').textContent = `Page ${dbPage + 1} · ${r.total} docs`;
}
$('#dbc').onchange = () => { dbPage = 0; dbm(); }; $('#dbq').oninput = () => { dbPage = 0; dbm(); };
$('#dbprev').onclick = () => { if (dbPage > 0) { dbPage--; dbm(); } }; $('#dbnext').onclick = () => { dbPage++; dbm(); };
$('#dbadd').onclick = async () => { let j; try { j = JSON.parse($('#dbnew').value); } catch { return alert('Invalid JSON'); } const r = await api(`db/${$('#dbc').value}`, 'POST', j); alert(r.ok ? 'Inserted' : r.error); dbm(); };
