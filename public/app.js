// copy that works on http, https and old mobile browsers
function fallbackCopy(text) {
  const t = document.createElement('textarea');
  t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(t); t.focus(); t.select(); t.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} t.remove();
  if (!ok) prompt('Copy your key:', text);
}
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text); return Promise.resolve();
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]');
  if (b) { await copyText(b.dataset.copy); const o = b.textContent; b.textContent = 'Copied \u2713'; setTimeout(() => b.textContent = o, 1500); }
  const r = e.target.closest('[data-rename]');
  if (r) {
    const n = prompt('Key name', r.dataset.cur); if (!n || !n.trim()) return;
    const j = await (await fetch('/keys/' + r.dataset.rename + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) })).json();
    if (j.ok) location.reload(); else alert(j.error || 'Failed');
  }
});
