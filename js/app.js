import { loadPages } from './pages.js';
import { recognizePage } from './omr.js';
import { buildScore, detectSettings, PART_NAMES, midiName } from './score.js';
import { readMusicXmlFile } from './musicxml.js';
import { Player } from './synth.js';
import { PianoRoll, PART_COLORS } from './roll.js';

const $ = (s) => document.querySelector(s);
const player = new Player();
let pages = []; // { canvas, result }
let settings = null;
let score = null;
let undoStack = [];

const status = (msg, error = false) => {
  $('#status').textContent = msg;
  $('#status').classList.toggle('error', error);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- loading ----------

async function openFile(file) {
  player.stop();
  updatePlayButton();
  try {
    if (/\.(xml|musicxml|mxl)$/i.test(file.name)) {
      status('Reading MusicXML…');
      score = await readMusicXmlFile(file);
      pages = [];
      settings = null;
      showScore();
      status(`Loaded ${countNotes()} notes from ${file.name}.`);
      return;
    }
    pages = [];
    let n = 0;
    status('Opening ' + file.name + '…');
    await tick();
    for await (const p of loadPages(file, undefined, (i, total) => {
      status(`Reading page ${i} of ${total}…`);
    })) {
      n++;
      await tick();
      pages.push({ canvas: p.canvas, result: recognizePage(p.gray) });
    }
    const results = pages.map((p) => p.result);
    if (!results.some((r) => r.heads.length)) {
      status('No music staves were found in that file. Try a clearer scan, a straighter photo, or a MusicXML export.', true);
      return;
    }
    settings = detectSettings(results);
    score = buildScore(results, settings);
    showScore();
    status(`Found ${countNotes()} notes on ${n} page${n > 1 ? 's' : ''}. Press play, and fix any wrong notes in the editor below.`);
  } catch (err) {
    console.error(err);
    status('Sorry, that file could not be read: ' + err.message, true);
  }
}

const countNotes = () => score.parts.reduce((s, p) => s + p.notes.length, 0);

function showScore() {
  $('#workspace').hidden = false;
  undoStack = [];
  $('#undo').disabled = true;
  roll.setScore(score);
  player.pausedBeat = 0;
  roll.setPlayhead(0, false);
  const fromSheet = pages.length > 0;
  for (const tab of document.querySelectorAll('[role=tab]')) {
    if (tab.dataset.tab !== 'notes') tab.hidden = !fromSheet;
  }
  showTab('notes');
  if (fromSheet) { renderSheet(); renderSettings(); }
  roll.wrap.scrollTop = Math.max(0, roll.midiToY(72) - roll.wrap.clientHeight / 3);
  roll.wrap.scrollLeft = 0;
}

// ---------- transport ----------

function updatePlayButton() {
  $('#play').textContent = player.playing ? '⏸ Pause' : '▶ Play';
  $('#play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}

$('#play').addEventListener('click', () => {
  if (!score) return;
  if (player.playing) player.pause();
  else player.play(score, player.pausedBeat);
  updatePlayButton();
  animate();
});
$('#rewind').addEventListener('click', () => {
  player.seek(0);
  roll.setPlayhead(0, player.playing);
  roll.wrap.scrollLeft = 0;
});
$('#tempo').addEventListener('input', (e) => {
  player.setTempo(+e.target.value);
  $('#tempoOut').textContent = e.target.value;
});
player.onEnd = () => { updatePlayButton(); roll.setPlayhead(0, false); drawOverlays(); };

let lastOverlay = 0;
function animate() {
  roll.setPlayhead(player.beat, player.playing);
  const now = performance.now();
  if (now - lastOverlay > 120) { drawOverlays(); lastOverlay = now; }
  if (player.playing) requestAnimationFrame(animate);
  else drawOverlays();
}

// part chips
PART_NAMES.forEach((name, i) => {
  const el = document.createElement('div');
  el.className = 'part';
  el.innerHTML = `<input type="checkbox" checked aria-label="Hear ${name}">
    <span class="sw" style="background:${PART_COLORS[i]}"></span>${name}
    <input type="range" min="0" max="1.5" step="0.05" value="1" aria-label="${name} volume">`;
  const [box, vol] = el.querySelectorAll('input');
  box.addEventListener('change', () => {
    player.setPart(i, { muted: !box.checked });
    el.classList.toggle('off', !box.checked);
  });
  vol.addEventListener('input', () => player.setPart(i, { volume: +vol.value }));
  $('#parts').appendChild(el);
  const opt = new Option(name, i);
  $('#activePart').appendChild(opt);
});

// ---------- editor ----------

const roll = new PianoRoll($('#roll'), {
  onChange(phase) {
    if (phase === 'before') {
      undoStack.push(JSON.stringify(score.parts));
      if (undoStack.length > 100) undoStack.shift();
      $('#undo').disabled = false;
    } else {
      if (player.playing) player.play(score, player.beat);
      drawOverlays();
    }
  },
  onSelect(sel) {
    $('#selInfo').textContent = sel
      ? `${PART_NAMES[sel.part]}: ${midiName(sel.note.midi)}, ${fmtBeats(sel.note.d)} at beat ${+(sel.note.t + 1).toFixed(2)}`
      : '';
    if (sel) $('#activePart').value = sel.part;
    drawOverlays();
  },
  onSeek(beat) {
    player.seek(beat);
    roll.setPlayhead(beat, player.playing);
  },
  onPreview(part, midi) {
    if (!player.playing) player.preview(part, midi);
  },
});

const fmtBeats = (d) => (d === 1 ? '1 beat' : `${+d.toFixed(2)} beats`);

$('#activePart').addEventListener('change', (e) => { roll.activePart = +e.target.value; roll.draw(); });
$('#zoomIn').addEventListener('click', () => roll.zoom(1.25));
$('#zoomOut').addEventListener('click', () => roll.zoom(0.8));
$('#undo').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  if (e.key === ' ' && e.target === document.body && score) { e.preventDefault(); $('#play').click(); }
});

function undo() {
  if (!undoStack.length) return;
  score.parts = JSON.parse(undoStack.pop());
  $('#undo').disabled = !undoStack.length;
  roll.sel = null;
  roll.layout();
  drawOverlays();
  if (player.playing) player.play(score, player.beat);
}

// ---------- sheet check ----------

function renderSheet() {
  const box = $('#pages');
  box.innerHTML = '';
  pages.forEach((p, pi) => {
    const { canvas, result } = p;
    const wrap = document.createElement('div');
    wrap.className = 'page';
    // Show the page straightened the same way the reader saw it.
    const base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    const bc = base.getContext('2d');
    bc.fillStyle = '#fff';
    bc.fillRect(0, 0, base.width, base.height);
    bc.translate(base.width / 2, base.height / 2);
    bc.rotate((-result.skew * Math.PI) / 180);
    bc.translate(-base.width / 2, -base.height / 2);
    bc.drawImage(canvas, 0, 0);
    const ov = document.createElement('canvas');
    ov.className = 'overlay';
    ov.width = canvas.width;
    ov.height = canvas.height;
    ov.dataset.page = pi;
    ov.addEventListener('click', (e) => {
      const r = ov.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * ov.width, y = ((e.clientY - r.top) / r.height) * ov.height;
      let best = null, bd = (result.il * 1.2) ** 2;
      score.parts.forEach((part, i) => part.notes.forEach((n) => {
        if (!n.src || n.src.page !== pi) return;
        const d = (n.src.x - x) ** 2 + (n.src.y - y) ** 2;
        if (d < bd) { bd = d; best = { part: i, note: n }; }
      }));
      if (best) {
        roll.select(best, true);
        player.preview(best.part, best.note.midi);
        showTab('notes');
      }
    });
    wrap.append(base, ov);
    box.appendChild(wrap);
  });
  drawOverlays();
}

function drawOverlays() {
  if (!pages.length || !score) return;
  const beat = player.beat;
  document.querySelectorAll('canvas.overlay').forEach((ov) => {
    const pi = +ov.dataset.page;
    const il = pages[pi].result.il;
    const c = ov.getContext('2d');
    c.clearRect(0, 0, ov.width, ov.height);
    score.parts.forEach((part, i) => {
      // offset the four parts slightly so shared noteheads show both colours
      const dx = (i % 2 ? 1 : -1) * il * 0.28, dy = (i < 2 ? -1 : 1) * il * 0.0;
      for (const n of part.notes) {
        if (!n.src || n.src.page !== pi) continue;
        const sounding = player.playing && beat >= n.t && beat < n.t + n.d;
        const selected = roll.sel && roll.sel.note === n;
        c.beginPath();
        c.arc(n.src.x + dx, n.src.y + dy, il * (sounding ? 0.55 : 0.32), 0, Math.PI * 2);
        c.fillStyle = PART_COLORS[i];
        c.globalAlpha = sounding ? 0.85 : 0.75;
        c.fill();
        c.globalAlpha = 1;
        if (selected) { c.lineWidth = 3; c.strokeStyle = '#111'; c.stroke(); }
      }
    });
  });
}

// ---------- reading settings ----------

const KEY_NAMES = { '-7': 'C♭', '-6': 'G♭', '-5': 'D♭', '-4': 'A♭', '-3': 'E♭', '-2': 'B♭', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F♯', 7: 'C♯' };
for (let k = -7; k <= 7; k++) {
  const label = k === 0 ? 'No sharps or flats (C major / A minor)'
    : `${Math.abs(k)} ${k > 0 ? 'sharp' : 'flat'}${Math.abs(k) > 1 ? 's' : ''} (${KEY_NAMES[k]} major)`;
  $('#key').appendChild(new Option(label, k));
}

const CLEFS = [['treble', 'Treble'], ['treble8', 'Treble with 8 below (tenor)'], ['bass', 'Bass']];
function renderSettings() {
  $('#key').value = settings.key;
  $('#staves').value = settings.staves;
  renderClefs();
}
function renderClefs() {
  const n = +$('#staves').value;
  const box = $('#clefs');
  box.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const def = settings.clefs[i] || (n === 4 ? ['treble', 'treble', 'treble8', 'bass'][i] : i === 0 ? 'treble' : 'bass');
    const sel = document.createElement('select');
    sel.dataset.i = i;
    CLEFS.forEach(([v, l]) => sel.appendChild(new Option(l, v, false, v === def)));
    const label = document.createElement('label');
    const names = n === 4 ? PART_NAMES : n === 2 ? ['Soprano & alto', 'Tenor & bass'] : ['All parts'];
    label.append(`Clef, staff ${i + 1} (${names[i]})`, sel);
    box.appendChild(label);
  }
}
$('#staves').addEventListener('change', renderClefs);
$('#reread').addEventListener('click', () => {
  player.stop();
  updatePlayButton();
  const n = +$('#staves').value;
  settings = {
    ...settings,
    key: +$('#key').value,
    staves: n,
    regroup: settings.regroup || n !== settings.staves,
    clefs: [...document.querySelectorAll('#clefs select')].map((s) => s.value),
  };
  score = buildScore(pages.map((p) => p.result), settings);
  showScore();
  showTab('settings');
  status(`Re-read: ${countNotes()} notes.`);
});

// ---------- tabs, file input, drag & drop ----------

function showTab(name) {
  document.querySelectorAll('[role=tab]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'notes') roll.layout();
}
document.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

$('#file').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
$('#example').addEventListener('click', async () => {
  status('Loading the example…');
  const blob = await (await fetch('examples/example-hymn.pdf')).blob();
  openFile(new File([blob], 'example-hymn.pdf', { type: 'application/pdf' }));
});
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });

// Handy for debugging from the browser console.
window.satb = { player, roll, get score() { return score; } };
