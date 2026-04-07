'use strict';

const path = require('path');
const fs = require('fs/promises');
const esbuild = require('esbuild');

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const publicSrcDir = path.join(rootDir, 'src', 'public');
  const publicDistDir = path.join(distDir, 'public');
  const entryPoint = path.join(rootDir, 'src', 'index.js');
  const outputFile = path.join(distDir, 'index.js');

  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(publicDistDir, { recursive: true });

  await esbuild.build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node18'],
    sourcemap: false,
    minify: false,
    // Playwright (and its sub-packages) use native binaries, dynamic requires,
    // and optional dependencies that cannot be bundled by esbuild.
    // Mark them all external so they are loaded from node_modules at runtime.
    external: ['playwright', 'playwright-core', 'chromium-bidi'],
    logLevel: 'info',
  });

  await fs.cp(publicSrcDir, publicDistDir, { recursive: true });

  console.log(`Build complete: ${path.relative(rootDir, outputFile)}`);
  console.log(`Static assets copied to: ${path.relative(rootDir, publicDistDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});