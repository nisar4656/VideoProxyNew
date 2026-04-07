/**
 * Puppeteer configuration.
 *
 * Ensures the browser binary downloaded during `npx puppeteer browsers install chrome`
 * lives in the same place Puppeteer looks at runtime.
 *
 * On Render the HOME dir is /opt/render, so the default cache resolves to
 * /opt/render/.cache/puppeteer — which is exactly what the error message shows.
 * We pin it explicitly here so it is consistent across all environments.
 */
const { join } = require('path');

module.exports = {
  cacheDirectory: join(process.env.HOME || '/root', '.cache', 'puppeteer'),
};
