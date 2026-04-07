'use strict';

/**
 * Install the Puppeteer-bundled Chrome browser.
 *
 * Sets PUPPETEER_CACHE_DIR from $HOME so that BOTH this install step and the
 * runtime (src/index.js) resolve the same path — even when running from a
 * bundled dist/ entry point where .puppeteerrc.cjs is not found via CWD.
 */
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'puppeteer');

process.env.PUPPETEER_CACHE_DIR = cacheDir;

console.log(`  Installing Chrome → ${cacheDir}`);

execSync('npx puppeteer browsers install chrome', {
  stdio: 'inherit',
  env: process.env,
});
