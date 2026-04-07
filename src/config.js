'use strict';

require('dotenv').config();

module.exports = {
  /** Port the proxy server listens on */
  PORT: parseInt(process.env.PORT) || 3000,

  /** Comma-separated list of allowed origin domains for CORS.
   *  Set to '*' to allow all origins (default). */
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',

  /** Comma-separated whitelist of upstream domains the proxy may fetch from.
   *  Leave empty (default) to allow any domain. */
  ALLOWED_DOMAINS: process.env.ALLOWED_DOMAINS
    ? process.env.ALLOWED_DOMAINS.split(',').map((d) => d.trim())
    : [],

  /** Number of manifest entries (m3u8 / MPD) to keep in the in-memory cache */
  MAX_CACHE_KEYS: parseInt(process.env.MAX_CACHE_KEYS) || 200,

  /** How long (seconds) a cached manifest is considered fresh */
  CACHE_TTL: parseInt(process.env.CACHE_TTL) || 30,

  /** Upstream request timeout in milliseconds */
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 30_000,

  /** User-Agent sent to upstream servers */
  USER_AGENT:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (compatible; VideoProxy/1.0; +https://github.com/video-proxy)',
};
