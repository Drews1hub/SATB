// Runs the recogniser on every fixture in headless Chromium and scores it.
// Usage: node tests/run.mjs [fixtureName...]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(root, 'tests/fixtures')).filter(f => f.endsWith('.pdf')).map(f => f.slice(0, -4));
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:8765/tests/harness.html');
await page.waitForFunction(() => window.ready);
let failed = false;
for (const name of fixtures) {
  const res = await page.evaluate(n => window.runFixture(n), name);
  const exp = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures', name + '.expected.json')));
  console.log(`\n== ${name}  settings=${JSON.stringify(res.settings)}`);
  for (const p of res.pages) console.log('  page', JSON.stringify(p));
  let totalOk = 0, total = 0;
  ['S', 'A', 'T', 'B'].forEach((v, i) => {
    const got = res.score.parts[i].notes;
    const want = exp[v].map(([t, d, midi]) => ({ t, d, midi }));
    let ok = 0, pitchOnly = 0;
    for (const w of want) {
      const g = got.find(g => Math.abs(g.t - w.t) < 1e-6 && g.midi === w.midi);
      if (g) { ok++; if (Math.abs(g.d - w.d) > 1e-6) pitchOnly++; }
    }
    total += want.length; totalOk += ok;
    const extra = got.length - ok;
    console.log(`  ${v}: ${ok}/${want.length} matched (pitch+onset), ${pitchOnly} wrong length, ${extra} extra`);
    if (process.env.VERBOSE) {
      const fmt = n => `${n.t}:${n.midi}/${n.d}`;
      console.log('    want', want.map(fmt).join(' '));
      console.log('    got ', got.map(fmt).join(' '));
    }
  });
  const pct = (100 * totalOk / total).toFixed(1);
  console.log(`  TOTAL ${totalOk}/${total} = ${pct}%`);
  if (totalOk / total < 0.9) failed = true;
}
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
