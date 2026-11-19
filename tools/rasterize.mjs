#!/usr/bin/env node
/*
 * Renders art/svg/*.svg to transparent PNG files in public/assets/ (3x size).
 *
 * This is a development tool - the PNGs are committed, so the game itself does
 * not need it. It uses any Chrome/Chromium through puppeteer-core:
 *
 *   npm i --no-save puppeteer-core
 *   CHROME_PATH=/path/to/chrome node tools/rasterize.mjs
 */
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'art', 'svg');
const OUT = join(ROOT, 'public', 'assets');
const SCALE = 3;

const { default: puppeteer } = await import('puppeteer-core');
const executablePath = process.env.CHROME_PATH;
if (!executablePath) {
  console.error('Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(1);
}
const browser = await puppeteer.launch({
  executablePath,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});
mkdirSync(OUT, { recursive: true });
const page = await browser.newPage();
let n = 0;
for (const file of readdirSync(SRC).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = readFileSync(join(SRC, file), 'utf8');
  const m = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  const w = Math.ceil(+m[1]);
  const h = Math.ceil(+m[2]);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: SCALE });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg style="display:block" ')}</body></html>`,
  );
  await page.screenshot({
    path: join(OUT, file.replace(/\.svg$/, '.png')),
    omitBackground: true,
    clip: { x: 0, y: 0, width: w, height: h },
  });
  n++;
}
await browser.close();
console.log(`rendered ${n} sprites to ${OUT}`);
