'use strict';

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
