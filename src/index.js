'use strict';

// ── Set Puppeteer cache dir BEFORE puppeteer is loaded anywhere ───────────────
// When running from a bundled dist/index.js the .puppeteerrc.cjs file is not
// found via CWD traversal, so Puppeteer falls back to its internal default
// which may not match where `npx puppeteer browsers install chrome` put the
// binary.  Setting the env var here guarantees both install and runtime agree.
const path = require('path');
const os = require('os');
if (!process.env.PUPPETEER_CACHE_DIR) {
  process.env.PUPPETEER_CACHE_DIR = path.join(os.homedir(), '.cache', 'puppeteer');
}

require('dotenv').config();
const app = require('./server');
const config = require('./config');

const server = app.listen(config.PORT, () => {
  console.log(`\n  🎬  Video Proxy Server`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Listening : http://localhost:${config.PORT}`);
  console.log(`  Health    : http://localhost:${config.PORT}/health`);
  console.log(`  Proxy     : http://localhost:${config.PORT}/proxy?url=<encoded-url>`);
  if (config.ALLOWED_DOMAINS.length > 0) {
    console.log(`  Allowed   : ${config.ALLOWED_DOMAINS.join(', ')}`);
  } else {
    console.log(`  Allowed   : all domains`);
  }
  console.log(`  Cache TTL : ${config.CACHE_TTL}s  (manifests only)\n`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n  Received ${signal}, shutting down…`);
  server.close(() => {
    console.log('  Server closed.\n');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
