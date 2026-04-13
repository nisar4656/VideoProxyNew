'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const proxyRouter = require('./routes/proxy');

let fetchRouter = null;
try {
  fetchRouter = require('./routes/fetch');
} catch {
  // puppeteer not installed — /fetch will return a 503 JSON error
}

const app = express();

app.use((req, res, next) => {
  const origin = config.ALLOWED_ORIGINS === '*' ? '*' : config.ALLOWED_ORIGINS;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
    console.log('  ' + color + res.statusCode + '\x1b[0m  ' + req.method.padEnd(6) + ' ' + req.url.slice(0, 100) + '  \x1b[2m' + ms + 'ms\x1b[0m');
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/proxy', proxyRouter);

/**
 * Extract client IP from the request, respecting X-Forwarded-For set by nginx.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.ip || req.connection?.remoteAddress || null;
}

if (fetchRouter) {
  app.use('/fetch', fetchRouter);

  /**
   * GET /proxer?id=<encoded-url>
   * Like /fetch but returns the client's IP in the response.
   */
  app.get('/proxer', (req, res, next) => {
    const pageParam = req.query.id || req.query.page;
    const pageUrl = pageParam ? decodeURIComponent(pageParam) : null;

    if (!pageUrl) {
      return res.status(400).json({
        error: 'Missing ?id= parameter',
        example: '/proxer?id=https%3A%2F%2Fexample.com%2Fwatch%3Fid%3D1',
      });
    }

    const clientIp = getClientIp(req);

    // Forward to fetch, then inject client IP into response
    const originalJson = res.json;
    res.json = function(data) {
      if (data && typeof data === 'object') {
        data.clientIp = clientIp;
        data.fetchedFrom = clientIp;
      }
      return originalJson.call(this, data);
    };

    // Inject into req.query and forward to fetchRouter
    req.query = Object.assign({}, req.query, { page: pageUrl });
    req.url = '/';
    return fetchRouter(req, res, next);
  });

  app.get(/^\/getURL=(.+)$/i, (req, res, next) => {
    // Use originalUrl to avoid Express path normalization stripping one slash
    const match = req.originalUrl.match(/^\/getURL=([^?]+)(?:\?.*)?$/i);
    const rawPage = match ? match[1] : '';

    let pageUrl = rawPage;
    try {
      pageUrl = decodeURIComponent(rawPage);
    } catch {
      // keep raw value if decode fails
    }

    // Restore double-slash protocol in case it was collapsed (https:/ → https://)
    pageUrl = pageUrl.replace(/^(https?:)\/{1,2}/, '$1//');

    // Inject directly into req.query — re-setting req.url alone does NOT
    // re-parse the already-populated query object.
    req.query = Object.assign({}, req.query, { page: pageUrl });
    req.url = '/';

    return fetchRouter(req, res, next);
  });
} else {
  app.get('/fetch', (_req, res) => {
    res.status(503).json({
      error: 'Auto-detect is not available — puppeteer is not installed.',
      tip: 'Run: npm install puppeteer  then restart the server.'
    });
  });

  app.get(/^\/getURL=(.+)$/i, (_req, res) => {
    res.status(503).json({
      error: 'Auto-detect is not available — puppeteer is not installed.',
      tip: 'Run: npm install puppeteer  then restart the server.'
    });
  });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), fetchEnabled: !!fetchRouter });
});

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/proxy') && !req.path.startsWith('/health') && !req.path.startsWith('/fetch')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.status(404).json({ error: 'Not found' });
});

module.exports = app;
