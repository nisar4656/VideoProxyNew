'use strict';

const fs     = require('fs');
const express  = require('express');
const puppeteer = require('puppeteer-core');

const router = express.Router();

// ── Find the Chromium / Chrome binary ────────────────────────────────────────
// Checked in priority order.  CHROME_BIN env var always wins.
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
  // macOS (for local dev)
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ── Shared browser instance (reused across requests) ──────────────────────────
let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;

  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium binary found. ' +
      'Set the CHROME_BIN environment variable to the full path of your Chrome/Chromium executable. ' +
      'Checked: ' + CHROME_CANDIDATES.filter(Boolean).join(', ')
    );
  }

  console.log('  [fetch] using browser:', executablePath);

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// ── Patterns that identify stream manifests ───────────────────────────────────
const MANIFEST_RE   = /\.m3u8|\.mpd/i;
const SEGMENT_RE    = /\.ts(\?|$)|\.m4s(\?|$)|\.aac(\?|$)/i;
const SKIP_RE       = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ico|json)(\?|$)/i;

/**
 * GET /fetch?page=<encoded-page-url>&timeout=<ms>
 *
 * Opens the given page in headless Chrome, intercepts all network requests, and
 * returns the first HLS/DASH manifest URL it finds, plus the headers the page
 * used to request it (Referer, Origin, User-Agent, Cookie).
 *
 * Optional query params:
 *   timeout  – how long to wait for a manifest (default 20000 ms)
 */
router.get('/', async (req, res) => {
  const pageParam = req.query.page || req.query.url;
  const pageUrl = pageParam ? decodeURIComponent(pageParam) : null;
  if (!pageUrl) {
    return res.status(400).json({
      error: 'Missing ?page= parameter',
      example: '/fetch?page=https%3A%2F%2Fexample.com%2Fwatch%3Fid%3D1',
    });
  }

  let targetUrl;
  try { targetUrl = new URL(pageUrl).href; }
  catch { return res.status(400).json({ error: 'Invalid page URL' }); }

  const timeout = Math.min(parseInt(req.query.timeout) || 20_000, 60_000);

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Set a real desktop User-Agent so sites don't serve bot pages
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1280, height: 720 });

    // Enable request interception so we can read headers
    await page.setRequestInterception(true);

    const found = [];      // manifest candidates
    const capturedUA = userAgent;

    page.on('request', interceptedReq => {
      const url = interceptedReq.url();
      // Abort clearly irrelevant resources to speed things up
      const rtype = interceptedReq.resourceType();
      if (['image', 'font', 'stylesheet'].includes(rtype)) {
        return interceptedReq.abort();
      }
      interceptedReq.continue();
    });

    // Listen to responses — this is where we capture the real URLs & headers
    page.on('response', async response => {
      const url  = response.url();
      const reqH = response.request().headers();

      if (MANIFEST_RE.test(url)) {
        const origin  = new URL(targetUrl);
        found.push({
          type:      url.includes('.m3u8') ? 'hls' : 'dash',
          url,
          referer:   reqH['referer']  || targetUrl,
          origin:    reqH['origin']   || (origin.protocol + '//' + origin.host),
          userAgent: reqH['user-agent'] || capturedUA,
          cookie:    reqH['cookie']   || null,
          status:    response.status(),
        });
      }
    });

    // Navigate to the page
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    // Wait for a manifest to appear (poll, so we return as soon as one is found)
    const deadline = Date.now() + timeout;
    while (found.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
    }

    if (found.length === 0) {
      return res.status(404).json({
        error: 'No HLS/DASH manifest found on this page within the timeout.',
        timeout,
        tip: 'The stream may load only after user interaction (click play). ' +
             'Try increasing ?timeout= or clicking play manually.',
      });
    }

    // Prefer the first manifest with status 200; fall back to whatever we have
    const best = found.find(f => f.status === 200) || found[0];

    return res.json({
      url:       best.url,
      type:      best.type,
      referer:   best.referer,
      origin:    best.origin,
      userAgent: best.userAgent,
      useragent: best.userAgent,
      cookie:    best.cookie,
      allFound:  found.map(f => ({ url: f.url, type: f.type, status: f.status })),
    });

  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Page timed out', timeout });
    }
    console.error('  [fetch] error:', err.message);
    return res.status(502).json({ error: 'Fetch failed', message: err.message });
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
});

module.exports = router;
