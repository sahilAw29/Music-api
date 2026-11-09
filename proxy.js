// Upstream proxy with HTTP Range support (so <video>/<audio> can seek forward/back).
// - JSON / text / errors  -> buffered and returned untouched (same as before)
// - audio / video bytes   -> streamed, Range forwarded to upstream
// - upstream ignores Range -> we buffer once (cached) and serve the slices ourselves
const { Readable } = require('stream');

// Every public endpoint: upstream path, which quota bucket it uses, which query params pass through, which one is required.
// Quota buckets stay audio / video / search, so old keys, limits and the admin panel keep working as before.
const EP = {
  audio:    { path: '/song/audio', bucket: 'audio',  params: ['q'],       need: 'q' },
  video:    { path: '/song/video', bucket: 'video',  params: ['q'],       need: 'q' },
  search:   { path: '/search',     bucket: 'search', params: ['q'],       need: 'q' },
  flac:     { path: '/song/flac',  bucket: 'audio',  params: ['q'],       need: 'q' },    // lossless audio, counts as audio
  suggest:  { path: '/suggest',    bucket: 'search', params: ['q', 'hl'], need: 'q' },    // search suggestions
  artist:   { path: '/artist',     bucket: 'search', params: ['name'],    need: 'name' }, // artist info + songs
  trending: { path: '/trending',   bucket: 'search', params: ['n'],       need: null }    // trending songs, n optional
};
const CACHE_TTL = 10 * 60 * 1000, CACHE_MAX = 200 * 1024 * 1024;
const cache = new Map(); let cacheBytes = 0; // fallback buffers for upstreams without Range support
setInterval(() => { const n = Date.now(); for (const [k, v] of cache) if (v.exp < n) drop(k); }, 60000).unref();
function drop(k) { const v = cache.get(k); if (v) { cacheBytes -= v.buf.length; cache.delete(k); } }
function put(k, v) {
  if (v.buf.length > CACHE_MAX / 2) return;
  while (cacheBytes + v.buf.length > CACHE_MAX && cache.size) drop(cache.keys().next().value);
  cache.set(k, v); cacheBytes += v.buf.length;
}

// -> {start,end} | 'full' (ignore range) | null (unsatisfiable)
function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'full'; // multi-range / garbage -> plain 200
  let start, end;
  if (m[1] === '') { const n = +m[2]; if (!n) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  return start > end || start >= size ? null : { start, end };
}

// Start the upstream request. Resolves when HEADERS arrive (body is not read yet).
// Timeout only covers the wait for headers, so long videos are not cut after 30s.
// qs = already-encoded query string, e.g. "q=ishq" or "name=arijit+singh"
function open(base, ep, qs, range, ac) {
  const t = setTimeout(() => ac.abort(), 30000);
  const headers = {}; if (range) headers.range = range;
  return fetch(base + EP[ep].path + (qs ? '?' + qs : ''), { headers, signal: ac.signal }).finally(() => clearTimeout(t));
}

const isText = t => /json|text|xml|javascript/i.test(t);
const cancel = r => { try { r?.body?.cancel().catch(() => {}); } catch {} };

// Sends the upstream response to the client. Returns the final status code.
async function send(r, req, res, cacheKey, ac) {
  const type = r.headers.get('content-type') || 'application/json', range = req.get('range');
  const buffered = async () => Buffer.from(await r.arrayBuffer());
  // errors, JSON, text: buffer and pass through untouched
  if (r.status >= 400 || isText(type)) { const b = await buffered(); res.status(r.status).type(type).send(b); return r.status; }
  // client closed the page / skipped ahead: stop pulling from upstream
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' };
  const enc = r.headers.get('content-encoding'), len = r.headers.get('content-length');
  const raw = !enc || enc === 'identity'; // fetch() already decoded gzip, so lengths would lie
  const stream = status => { // pipe upstream body to client
    const h = { ...common }; if (raw && len) h['Content-Length'] = len; const cr = r.headers.get('content-range'); if (cr && status === 206) h['Content-Range'] = cr;
    res.writeHead(status, h);
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res); return status;
  };
  if (r.status === 206) return stream(206);          // upstream supports Range: just pass it on
  if (!range) return stream(200);                      // normal full request
  // client asked for a range but upstream answered 200 with the full file -> slice it ourselves
  let c = cache.get(cacheKey);
  if (!c) { const buf = await buffered(); c = { buf, type, exp: Date.now() + CACHE_TTL }; put(cacheKey, c); }
  return slice(c, range, res);
}

function slice(c, range, res) {
  const size = c.buf.length, p = parseRange(range, size);
  const common = { 'Content-Type': c.type, 'Accept-Ranges': 'bytes' };
  if (p === null) { res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` }); res.end(); return 416; }
  if (p === 'full') { res.writeHead(200, { ...common, 'Content-Length': size }); res.end(c.buf); return 200; }
  res.writeHead(206, { ...common, 'Content-Range': `bytes ${p.start}-${p.end}/${size}`, 'Content-Length': p.end - p.start + 1 });
  res.end(c.buf.subarray(p.start, p.end + 1)); return 206;
}

// Seek requests (cached from an earlier full request) can be served without touching upstream.
const cached = k => { const c = cache.get(k); return c && c.exp > Date.now() ? c : null; };

module.exports = { EP, open, send, slice, cached, cancel, parseRange };
