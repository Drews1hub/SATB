// Saves an annotated PNG of what the recogniser saw: node tests/debug.mjs name [page]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [name, pageNo = '0'] = process.argv.slice(2);
const server = spawn('python3', ['-m', 'http.server', '8766', '--bind', '127.0.0.1'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:8766/tests/harness.html');
await page.waitForFunction(() => window.ready);
const out = await page.evaluate(async ([n, pn]) => {
  const { loadPages } = await import('../js/pages.js');
  const { recognizePage, posY } = await import('../js/omr.js');
  const blob = await (await fetch('fixtures/' + n + '.pdf')).blob();
  let i = 0;
  for await (const p of loadPages(new File([blob], n + '.pdf', { type: 'application/pdf' }))) {
    if (i++ !== +pn) continue;
    const r = recognizePage(p.gray);
    const c = p.canvas, ctx = c.getContext('2d');
    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.translate(c.width / 2, c.height / 2); ctx.rotate(-r.skew * Math.PI / 180); ctx.translate(-c.width / 2, -c.height / 2);
    const cp = document.createElement('canvas'); cp.width = c.width; cp.height = c.height; cp.getContext('2d').drawImage(c, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(cp, 0, 0); ctx.restore();
    ctx.lineWidth = 2;
    for (const s of r.staves) {
      ctx.strokeStyle = 'rgba(0,160,0,.6)'; ctx.strokeRect(s.x0, s.lines[0], s.x1 - s.x0, s.lines[4] - s.lines[0]);
      ctx.fillStyle = 'green'; ctx.font = '16px sans-serif'; ctx.fillText(`${s.index} ${s.clef} key${s.key}`, s.x0, s.lines[0] - 4);
      ctx.strokeStyle = 'orange'; for (const b of s.bars) { ctx.beginPath(); ctx.moveTo(b, s.lines[0] - 10); ctx.lineTo(b, s.lines[4] + 10); ctx.stroke(); }
    }
    for (const h of r.heads) {
      ctx.strokeStyle = h.stemUp && h.stemDown ? 'purple' : h.stemUp ? 'red' : h.stemDown ? 'blue' : 'black';
      ctx.beginPath(); ctx.arc(h.x, h.y, r.il * 0.7, 0, 7); ctx.stroke();
      ctx.fillStyle = 'magenta'; ctx.font = '11px sans-serif';
      ctx.fillText(String(h.dur) + (h.acc ? h.acc[0] : ''), h.x + r.il * 0.7, h.y + r.il * 1.4);
    }
    return { url: c.toDataURL('image/png'), il: r.il };
  }
}, [name, pageNo]);
fs.writeFileSync('/tmp/debug.png', Buffer.from(out.url.split(',')[1], 'base64'));
console.log('il', out.il);
await browser.close(); server.kill();
