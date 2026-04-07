'use strict';

/**
 * URL rewriting utilities for HLS and MPEG-DASH manifests.
 *
 * All relative segment / resource URLs inside a manifest must be converted to
 * absolute URLs and then wrapped in the proxy's own base URL so that the
 * client always routes through this server.
 */

// ── Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve `relative` against `base`.  If `relative` is already absolute it is
 * returned unchanged.  Returns an empty string on parse error.
 */
function resolveUrl(base, relative) {
  if (!relative || relative.startsWith('data:')) return relative;
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

/**
 * Wrap an absolute URL so it goes through the proxy.
 *   https://cdn.example.com/seg.ts  →  <proxyBase>https%3A%2F%2F…
 */
function proxify(absoluteUrl, proxyBase) {
  return proxyBase + encodeURIComponent(absoluteUrl);
}

// ── HLS (m3u8) rewriter ───────────────────────────────────────────────────────

/**
 * Rewrite all URLs inside an HLS manifest so they pass through the proxy.
 *
 * Handles:
 *   - Variant stream URLs (lines that follow #EXT-X-STREAM-INF, etc.)
 *   - Media segment URLs (plain non-comment lines)
 *   - URI="…" attributes inside tags (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, …)
 *   - Absolute and relative URLs alike
 *
 * @param {string} content  Raw m3u8 text
 * @param {string} baseUrl  Base URL of the manifest (up to and including last /)
 * @param {string} proxyBase  e.g. "http://localhost:3000/proxy?url="
 * @returns {string} Rewritten m3u8 text
 */
function rewriteM3U8(content, baseUrl, proxyBase) {
  const lines = content.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trimEnd();

    if (line.startsWith('#')) {
      // Rewrite URI="…" attributes that appear inside tags
      line = line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        const abs = resolveUrl(baseUrl, uri);
        return `URI="${proxify(abs, proxyBase)}"`;
      });
      out.push(line);
      continue;
    }

    if (line.trim() === '') {
      out.push(line);
      continue;
    }

    // Non-comment, non-empty line → it's a URL (segment or sub-playlist)
    const abs = resolveUrl(baseUrl, line.trim());
    out.push(proxify(abs, proxyBase));
  }

  return out.join('\n');
}

// ── MPEG-DASH (MPD) rewriter ──────────────────────────────────────────────────

/**
 * Rewrite all resource URLs inside an MPEG-DASH MPD manifest so they pass
 * through the proxy.
 *
 * Handles:
 *   - <BaseURL> elements
 *   - initialization="…" attributes
 *   - media="…" attributes (only when they are absolute URLs; template
 *     variables like $Number$ are left untouched)
 *   - src="…" attributes on <ContentProtection> and similar elements
 *
 * @param {string} content  Raw MPD XML text
 * @param {string} baseUrl  Base URL of the manifest
 * @param {string} proxyBase  e.g. "http://localhost:3000/proxy?url="
 * @returns {string} Rewritten MPD XML text
 */
function rewriteMPD(content, baseUrl, proxyBase) {
  // <BaseURL>https://cdn.example.com/path/</BaseURL>
  content = content.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_m, url) => {
    const abs = resolveUrl(baseUrl, url.trim());
    return `<BaseURL>${proxify(abs, proxyBase)}</BaseURL>`;
  });

  // initialization="init-$RepresentationID$.mp4"
  content = content.replace(/\binitialization="([^"]+)"/g, (_m, url) => {
    // Skip DASH template variables; they'll be resolved relative to BaseURL
    if (url.includes('$')) return `initialization="${url}"`;
    const abs = resolveUrl(baseUrl, url);
    return `initialization="${proxify(abs, proxyBase)}"`;
  });

  // media="chunk-$Number%05d$.m4s" — only rewrite absolute http(s) URLs
  content = content.replace(/\bmedia="([^"]+)"/g, (_m, url) => {
    if (!url.startsWith('http')) return `media="${url}"`;
    return `media="${proxify(url, proxyBase)}"`;
  });

  // src="…" on elements like <ContentProtection> license URLs
  content = content.replace(/\bsrc="(https?:\/\/[^"]+)"/g, (_m, url) => {
    return `src="${proxify(url, proxyBase)}"`;
  });

  return content;
}

module.exports = { rewriteM3U8, rewriteMPD, resolveUrl, proxify };
