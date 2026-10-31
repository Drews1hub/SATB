// Runs the app with Promise.withResolvers removed, as in browsers before 2024.
// Usage: node tests/old-browser-check.mjs [url] <file>
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [url = 'https://drews1hub.github.io/SATB/', file] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => { delete Promise.withResolvers; });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(url);
await page.setInputFiles('#file', file);
await page.waitForFunction(() => /Found|Sorry|No music/.test(document.querySelector('#status').textContent), null, { timeout: 300000 }).catch(() => {});
console.log('status:', await page.textContent('#status'));
console.log('errors:', errs);
await browser.close();
