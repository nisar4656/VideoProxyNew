'use strict';

const http   = require('http');
const https  = require('https');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const config = require('../config');
const { rewriteM3U8, rewriteMPD } = require('../utils/rewriter');

// ── Connection pools ──────────────────────────────────────────────────────────
// Reuse TCP/TLS connections across segment requests — the single biggest
// latency win for HLS (avoids a ~200 ms TLS handshake per segment).
const httpAgent  = new http.Agent ({  keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const router = express.Router();

// Cache is used only for text manifests (m3u8 / MPD).
const manifestCache = new NodeCache({
  stdTTL: config.CACHE_TTL,
  maxKeys: config.MAX_CACHE_KEYS,
  useClones: false,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true when the URL's hostname is in the ALLOWED_DOMAINS whitelist. */
function isAllowedDomain(urlStr) {
  if (config.ALLOWED_DOMAINS.length === 0) return true;
  try {
    const { hostname } = new URL(urlStr);
    return config.ALLOWED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith('.' + d),
    );
  } catch {
    return false;
  }
}

/** Derive the base URL (everything up to and including the last slash). */
function baseOf(urlStr) {
  return urlStr.substring(0, urlStr.lastIndexOf('/') + 1);
}

/**
 * Build the headers forwarded to the upstream server.
 *
 * Priority (highest → lowest):
 *   1. ?headers=<base64-JSON>  – arbitrary headers supplied by the client
 *   2. ?referer=<url>          – explicit Referer override
 *   3. Incoming request's own Referer / Origin / Cookie
 *   4. Defaults (User-Agent, Range, cache validators)
 */
function buildUpstreamHeaders(req) {
  const headers = { 'User-Agent': config.USER_AGENT };

  // ── Cache / range headers from the incoming request ──────────────────────
  if (req.headers['range'])            headers['Range']            = req.headers['range'];
  if (req.headers['if-range'])         headers['If-Range']         = req.headers['if-range'];
  if (req.headers['if-none-match'])    headers['If-None-Match']    = req.headers['if-none-match'];
  if (req.headers['if-modified-since'])headers['If-Modified-Since']= req.headers['if-modified-since'];

  // Let the upstream use gzip/br compression — pass through to client as-is.
  // We set decompress:false on axios so we never touch the encoded bytes.
  headers['Accept-Encoding'] = req.headers['accept-encoding'] || 'gzip, deflate, br';

  // Keep the upstream TCP connection alive for reuse.
  headers['Connection'] = 'keep-alive';

  // ── Forward browser identity headers so CDNs / auth servers accept us ───
  if (req.headers['referer'])  headers['Referer']  = req.headers['referer'];
  if (req.headers['origin'])   headers['Origin']   = req.headers['origin'];
  if (req.headers['cookie'])   headers['Cookie']   = req.headers['cookie'];

  // ── Query-param overrides ────────────────────────────────────────────────
  // ?referer=<url>  — lets the caller set an explicit Referer
  if (req.query.referer) {
    try { headers['Referer'] = decodeURIComponent(req.query.referer); } catch { /* ignore */ }
  }

  // ?origin=<url>  — lets the caller set an explicit Origin
  if (req.query.origin) {
    try { headers['Origin'] = decodeURIComponent(req.query.origin); } catch { /* ignore */ }
  }

  // ?headers=<base64-encoded JSON object>  — arbitrary header overrides
  // Example:  btoa(JSON.stringify({ Authorization: 'Bearer token123' }))
  if (req.query.headers) {
    try {
      const extra = JSON.parse(Buffer.from(req.query.headers, 'base64').toString('utf8'));
      if (extra && typeof extra === 'object') {
        Object.entries(extra).forEach(([k, v]) => {
          if (typeof v === 'string') headers[k] = v;
        });
      }
    } catch {
      // Malformed base64 / JSON — silently ignore
    }
  }

  return headers;
}

/** Forward a safe subset of upstream response headers to the client. */
const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-encoding',
  'transfer-encoding',
  'accept-ranges',
  'cache-control',
  'last-modified',
  'etag',
  'expires',
];

function forwardResponseHeaders(upstreamHeaders, res) {
  FORWARD_HEADERS.forEach((h) => {
    if (upstreamHeaders[h] != null) res.setHeader(h, upstreamHeaders[h]);
  });
}

// ── Content-type sniffing ─────────────────────────────────────────────────────

function detectType(url, contentType = '') {
  const u = url.toLowerCase().split('?')[0];
  const ct = contentType.toLowerCase();

  if (u.endsWith('.m3u8') || u.endsWith('.m3u') || ct.includes('mpegurl'))
    return 'hls';

  if (u.endsWith('.mpd') || ct.includes('dash+xml'))
    return 'dash';

  return 'binary';
}

// ── Proxy base URL ────────────────────────────────────────────────────────────

/**
 * Build the proxy base URL, preserving auth-related query params so that
 * rewritten manifest segment URLs keep the same auth context.
 * e.g. http://localhost:3000/proxy?referer=...&url=
 */
function proxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const base = `${proto}://${host}/proxy`;

  const passThrough = {};
  if (req.query.referer) passThrough.referer = req.query.referer;
  if (req.query.origin)  passThrough.origin  = req.query.origin;
  if (req.query.headers) passThrough.headers = req.query.headers;

  const qs = Object.keys(passThrough).length
    ? '?' + new URLSearchParams(passThrough).toString() + '&url='
    : '?url=';

  return base + qs;
}

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * GET /proxy?url=<encoded-url>
 *
 * Supports:
 *   - Direct video files (MP4, WebM, TS, …) — streamed with range request support
 *   - HLS manifests (.m3u8) — fetched as text, segment/key URLs rewritten
 *   - MPEG-DASH manifests (.mpd) — fetched as text, BaseURL / media URLs rewritten
 */
router.get('/', async (req, res) => {
  // ── 1. Validate input ──────────────────────────────────────────────────────
  const rawUrl = req.query.url;
  if (!rawUrl) {
    return res.status(400).json({
      error: 'Missing required query parameter: url',
      example: '/proxy?url=https%3A%2F%2Fexample.com%2Fvideo.mp4',
    });
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    new URL(targetUrl); // throws if invalid
  } catch {
    return res.status(400).json({ error: 'Invalid URL provided.' });
  }

  if (!['http:', 'https:'].includes(new URL(targetUrl).protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are supported.' });
  }

  if (!isAllowedDomain(targetUrl)) {
    return res.status(403).json({ error: 'Domain is not in the allowed list.' });
  }

  // ── 2. Serve from cache (manifests only) ───────────────────────────────────
  // Include auth params in the cache key so different credentials get their
  // own cached copy.
  const cacheKey = targetUrl
    + (req.query.referer ? '|ref=' + req.query.referer : '')
    + (req.query.origin  ? '|ori=' + req.query.origin  : '')
    + (req.query.headers ? '|hdr=' + req.query.headers : '');

  const cached = manifestCache.get(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('X-Cache', 'HIT');
    return res.send(cached.body);
  }

  // ── 3. Fetch from upstream ─────────────────────────────────────────────────
  try {
    // We don't yet know the content-type, so we always start with a text
    // response type and switch to stream after we get the headers.
    // However, axios requires us to pick responseType upfront, so we do a
    // quick content-type sniff from the URL first, then confirm from the
    // actual response headers.
    const urlType = detectType(targetUrl);
    const responseType = urlType === 'binary' ? 'stream' : 'text';

    const upstreamResponse = await axios({
      method: 'get',
      url: targetUrl,
      responseType,
      headers: buildUpstreamHeaders(req),
      timeout: config.REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
      // Reuse TCP/TLS connections across requests (huge win for HLS segments)
      httpAgent,
      httpsAgent,
      // Never let axios decompress binary content — pass encoded bytes straight
      // through to the client, saving CPU and preserving Content-Encoding.
      decompress: responseType === 'stream' ? false : true,
    });

    const { status, headers: upHeaders, data } = upstreamResponse;

    // Re-check type now that we have the real content-type header
    const actualType = detectType(targetUrl, upHeaders['content-type'] || '');

    // ── 4a. Error passthrough ──────────────────────────────────────────────
    if (status >= 400) {
      return res.status(status).json({
        error: 'Upstream returned an error.',
        upstreamStatus: status,
        url: targetUrl,
      });
    }

    // ── 4b. HLS manifest ──────────────────────────────────────────────────
    if (actualType === 'hls') {
      // If we fetched as stream by mistake, stringify it
      const text = typeof data === 'string' ? data : data.toString();
      const rewritten = rewriteM3U8(text, baseOf(targetUrl), proxyBase(req));
      const contentType =
        upHeaders['content-type'] || 'application/vnd.apple.mpegurl';

      manifestCache.set(cacheKey, { body: rewritten, contentType });

      res.status(status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Cache', 'MISS');
      return res.send(rewritten);
    }

    // ── 4c. DASH manifest ─────────────────────────────────────────────────
    if (actualType === 'dash') {
      const text = typeof data === 'string' ? data : data.toString();
      const rewritten = rewriteMPD(text, baseOf(targetUrl), proxyBase(req));
      const contentType = upHeaders['content-type'] || 'application/dash+xml';

      manifestCache.set(cacheKey, { body: rewritten, contentType });

      res.status(status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Cache', 'MISS');
      return res.send(rewritten);
    }

    // ── 4d. Binary stream (video segments, MP4, etc.) ─────────────────────
    res.status(status);
    forwardResponseHeaders(upHeaders, res);

    // If we accidentally fetched a binary as text (shouldn't happen with
    // our sniffing, but be defensive), convert back to a buffer.
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      return res.end(data);
    }

    // Pipe stream directly to client
    data.on('error', (err) => {
      console.error('  Stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });

    data.pipe(res);
  } catch (err) {
    // ── 5. Network / timeout errors ────────────────────────────────────────
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return res.status(504).json({
        error: 'Upstream request timed out.',
        timeout: config.REQUEST_TIMEOUT,
      });
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return res.status(502).json({
        error: 'Could not reach upstream server.',
        code: err.code,
      });
    }
    console.error('  Proxy error:', err.message);
    return res.status(502).json({ error: 'Proxy error.', message: err.message });
  }
});

/**
 * HEAD /proxy?url=<encoded-url>
 *
 * Some video players send a HEAD request first to check content-length before
 * issuing a ranged GET.  We forward it transparently.
 */
router.head('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.sendStatus(400);

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    new URL(targetUrl);
  } catch {
    return res.sendStatus(400);
  }

  if (!isAllowedDomain(targetUrl)) return res.sendStatus(403);

  try {
    const { status, headers } = await axios.head(targetUrl, {
      headers: buildUpstreamHeaders(req),
      timeout: config.REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    res.status(status);
    forwardResponseHeaders(headers, res);
    res.end();
  } catch {
    res.sendStatus(502);
  }
});

module.exports = router;
