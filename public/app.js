// copy that works on http, https and old mobile browsers
function fallbackCopy(text) {
  const t = document.createElement('textarea');
  t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(t); t.focus(); t.select(); t.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} t.remove();
  if (!ok) prompt('Copy this:', text);
}
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text); return Promise.resolve();
}
function toast(msg, type = 'ok') {
  let w = document.getElementById('toasts');
  if (!w) { w = document.createElement('div'); w.id = 'toasts'; w.setAttribute('role', 'status'); document.body.appendChild(w); }
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; w.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2600);
}
const flash = (b, txt) => { const o = b.dataset.o || b.textContent; b.dataset.o = o; b.textContent = txt; clearTimeout(b._t); b._t = setTimeout(() => b.textContent = o, 1400); };

document.addEventListener('click', async e => {
  const c = e.target.closest('[data-copy]');
  if (c) { await copyText(c.dataset.copy); flash(c, 'Copied \u2713'); }
  const v = e.target.closest('[data-reveal]');
  if (v) { const code = v.parentElement.querySelector('code'), on = code.textContent === code.dataset.mask; code.textContent = on ? code.dataset.full : code.dataset.mask; v.textContent = on ? 'Hide' : 'Show'; }
  const r = e.target.closest('[data-rename]');
  if (r) {
    const n = prompt('Key name', r.dataset.cur); if (!n || !n.trim()) return;
    const j = await (await fetch('/keys/' + r.dataset.rename + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) })).json();
    if (j.ok) location.reload(); else toast(j.error || 'Rename failed', 'er');
  }
  const p = e.target.closest('.cpb');
  if (p) { const cl = p.parentElement.cloneNode(true); cl.querySelector('.cpb').remove(); await copyText(cl.textContent.trim()); flash(p, 'Copied \u2713'); }
});

// copy button on every code block marked .cp
document.querySelectorAll('pre.cp').forEach(pre => { const b = document.createElement('button'); b.className = 'cpb'; b.type = 'button'; b.textContent = 'Copy'; pre.appendChild(b); });

// dashboard: create first free key
const mk = document.getElementById('mk');
if (mk) mk.onclick = async () => {
  mk.disabled = true;
  const r = await fetch('/keys/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('kn').value }) }).then(r => r.json()).catch(() => ({ error: 'Network error, try again.' }));
  if (r.ok) return location.reload(); document.getElementById('msg').textContent = r.error; mk.disabled = false;
};

// dashboard: live API tester
const T = document.getElementById('tester');
if (T) {
  const sel = T.querySelector('select'), inp = T.querySelector('input'), btn = T.querySelector('.row .btn'), out = T.querySelector('.out'), pre = T.querySelector('pre:not(.cp)');
  const run = async () => {
    const ep = sel.value, q = inp.value.trim(); if (!q) return inp.focus();
    btn.disabled = true; out.innerHTML = '<span class="mu">Loading…</span>'; pre.hidden = true;
    const url = `/api/${ep}?q=${encodeURIComponent(q)}`, ac = new AbortController();
    try {
      const r = await fetch(url, { headers: { 'x-api-key': T.dataset.key }, signal: ac.signal }), ct = r.headers.get('content-type') || '';
      const tag = `<span class="pill ${r.ok ? 'ok' : 'er'}">HTTP ${r.status}</span> `;
      if (/json|text/.test(ct)) {
        const txt = await r.text(); let s; try { s = JSON.stringify(JSON.parse(txt), null, 2); } catch { s = txt; }
        out.innerHTML = tag; pre.textContent = s.length > 8000 ? s.slice(0, 8000) + '\n…' : s; pre.hidden = false;
      } else {
        ac.abort(); // the player loads it again with seeking support (free, no extra quota)
        const m = document.createElement(ep === 'video' ? 'video' : 'audio'); m.controls = true; m.preload = 'metadata';
        m.src = url + '&key=' + encodeURIComponent(T.dataset.key); out.innerHTML = tag + `<span class="mu">${ct}</span>`; out.appendChild(m);
      }
    } catch { out.innerHTML = '<span class="er">Network error, try again.</span>'; }
    btn.disabled = false;
  };
  btn.onclick = run; inp.onkeydown = e => e.key === 'Enter' && run();
}
