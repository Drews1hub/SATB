// Loads a file into the app and reports the resulting status line and console errors.
// Usage: node tests/multi-check.mjs [url] <file>   (default url: the live GitHub Pages site)
import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/user/SATB/tests/')('playwright');
const url = process.argv[2] || 'https://drews1hub.github.io/SATB/';
const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(url);
await page.setInputFiles('#file', process.argv[3]);
const t0 = Date.now();
await page.waitForFunction(() => /Found|Sorry|No music/.test(document.querySelector('#status').textContent), null, { timeout: 300000 }).catch(() => {});
console.log('status:', await page.textContent('#status'), `(${((Date.now()-t0)/1000).toFixed(0)}s)`);
console.log('errors:', errs);
await browser.close();
