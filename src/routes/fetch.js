'use strict';

const express      = require('express');
const { chromium } = require('playwright');

const router = express.Router();

// Shared browser instance
let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--mute-audio',
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

const MANIFEST_RE = /\.m3u8|\.mpd/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * GET /fetch?page=<encoded-url>
 * GET /fetch?url=<encoded-url>
 *
 * Opens the page in headless Chromium (Playwright), intercepts all network
 * requests, and returns the first HLS/DASH manifest URL found along with
 * the request headers (Referer, Origin, User-Agent, Cookie).
 *
 * Optional: ?timeout=<ms>  (default 20000, max 60000)
 */
router.get('/', async (req, res) => {
  const pageParam = req.query.page || req.query.url;
  const pageUrl   = pageParam ? decodeURIComponent(pageParam) : null;

  if (!pageUrl) {
    return res.status(400).json({
      error:   'Missing ?page= parameter',
      example: '/fetch?page=https%3A%2F%2Fexample.com%2Fwatch%3Fid%3D1',
    });
  }

  let targetUrl;
  try   { targetUrl = new URL(pageUrl).href; }
  catch { return res.status(400).json({ error: 'Invalid page URL' }); }

  const timeout = Math.min(parseInt(req.query.timeout) || 20_000, 60_000);
  let context = null, page = null;

  try {
    const b = await getBrowser();
    context = await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });

    // Block fonts/images to speed up page load
    await context.route(/\.(png|jpg|jpeg|gif|svg|woff2?|ico)(\?|$)/i, route => route.abort());

    page = await context.newPage();
    const found = [];

    // Capture every manifest request + its headers
    page.on('request', request => {
      const url = request.url();
      if (!MANIFEST_RE.test(url)) return;
      const h = request.headers();
      const originObj = new URL(targetUrl);
      found.push({
        type:      url.includes('.m3u8') ? 'hls' : 'dash',
        url,
        referer:   h['referer']    || targetUrl,
        origin:    h['origin']     || (originObj.protocol + '//' + originObj.host),
        userAgent: h['user-agent'] || UA,
        cookie:    h['cookie']     || null,
      });
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout });

    // Poll until a manifest appears or we hit the timeout
    const deadline = Date.now() + timeout;
    while (found.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(300);
    }

    if (found.length === 0) {
      return res.status(404).json({
        error:   'No HLS/DASH manifest found on this page within the timeout.',
        timeout,
        tip:     'The stream may load only after user interaction. Try increasing ?timeout=',
      });
    }

    const best = found[0];
    return res.json({
      url:       best.url,
      type:      best.type,
      referer:   best.referer,
      origin:    best.origin,
      userAgent: best.userAgent,
      useragent: best.userAgent,
      cookie:    best.cookie,
      allFound:  found.map(f => ({ url: f.url, type: f.type })),
    });

  } catch (err) {
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message)) {
      return res.status(504).json({ error: 'Page timed out', timeout });
    }
    console.error('  [fetch] playwright error:', err.message);
    return res.status(502).json({ error: 'Fetch failed', message: err.message });
  } finally {
    if (page)    await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

module.exports = router;
