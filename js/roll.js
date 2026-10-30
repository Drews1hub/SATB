// Piano-roll note editor. Time runs left to right, pitch bottom to top.
import { midiName } from './score.js';

export const PART_COLORS = ['#d9472b', '#e09a12', '#1f9b8f', '#4257c9'];
const ROW = 10;
const LABEL_W = 44;
const SNAP = 0.25;

export class PianoRoll {
  constructor(container, { onChange, onSelect, onSeek, onPreview }) {
    this.wrap = container;
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Note editor. Click a note to select it; use arrow keys to change pitch.');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.score = null;
    this.ppb = 36; // pixels per beat
    this.sel = null; // { part, note }
    this.activePart = 0;
    this.hidden = [false, false, false, false];
    this.playhead = 0;
    this.cb = { onChange, onSelect, onSeek, onPreview };
    container.addEventListener('scroll', () => this.draw());
    this.canvas.addEventListener('mousedown', (e) => this.down(e));
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e));
    this.canvas.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', () => this.up());
    new ResizeObserver(() => this.layout()).observe(container);
  }

  setScore(score) {
    this.score = score;
    this.sel = null;
    this.layout();
  }

  layout() {
    if (!this.score) return;
    const all = this.score.parts.flatMap((p) => p.notes);
    const lo = all.length ? Math.min(...all.map((n) => n.midi)) : 48;
    const hi = all.length ? Math.max(...all.map((n) => n.midi)) : 79;
    this.lo = Math.min(lo, 40) - 2;
    this.hi = Math.max(hi, 81) + 2;
    this.beats = Math.max(16, ...all.map((n) => n.t + n.d)) + 4;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(30000, LABEL_W + this.beats * this.ppb);
    const h = (this.hi - this.lo + 1) * ROW;
    this.cssW = w;
    this.cssH = h;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  zoom(f) {
    const centreBeat = this.xToBeat(this.wrap.scrollLeft + this.wrap.clientWidth / 2);
    this.ppb = Math.max(10, Math.min(120, this.ppb * f));
    this.layout();
    this.wrap.scrollLeft = this.beatToX(centreBeat) - this.wrap.clientWidth / 2;
  }

  beatToX(b) { return LABEL_W + b * this.ppb; }
  xToBeat(x) { return (x - LABEL_W) / this.ppb; }
  midiToY(m) { return (this.hi - m) * ROW; }
  yToMidi(y) { return this.hi - Math.floor(y / ROW); }

  draw() {
    if (!this.score) return;
    const c = this.ctx, W = this.cssW, H = this.cssH;
    const sx = this.wrap.scrollLeft, vw = this.wrap.clientWidth;
    const b0 = Math.max(0, Math.floor(this.xToBeat(sx)) - 1), b1 = Math.ceil(this.xToBeat(sx + vw)) + 1;
    c.clearRect(0, 0, W, H);
    for (let m = this.lo; m <= this.hi; m++) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      c.fillStyle = black ? '#eef0f4' : '#fbfbfd';
      c.fillRect(0, this.midiToY(m), W, ROW);
      if (m % 12 === 0) { c.fillStyle = '#d5d9e2'; c.fillRect(0, this.midiToY(m) + ROW - 1, W, 1); }
    }
    for (let b = b0; b <= b1; b++) {
      c.fillStyle = b % 4 === 0 ? '#cfd4de' : '#e6e9ef';
      c.fillRect(Math.round(this.beatToX(b)), 0, 1, H);
    }
    this.score.parts.forEach((p, pi) => {
      if (this.hidden[pi]) return;
      for (const n of p.notes) {
        if (n.t + n.d < b0 || n.t > b1) continue;
        const x = this.beatToX(n.t), y = this.midiToY(n.midi), w = Math.max(3, n.d * this.ppb - 2);
        c.globalAlpha = pi === this.activePart ? 0.95 : 0.6;
        c.fillStyle = PART_COLORS[pi];
        c.beginPath();
        c.roundRect(x + 1, y + 1, w, ROW - 2, 3);
        c.fill();
        c.globalAlpha = 1;
        if (this.sel && this.sel.note === n) {
          c.strokeStyle = '#111';
          c.lineWidth = 2;
          c.stroke();
        }
        if (this.playing && this.playhead >= n.t && this.playhead < n.t + n.d) {
          c.strokeStyle = '#fff';
          c.lineWidth = 1.5;
          c.stroke();
        }
      }
    });
    // playhead
    const px = this.beatToX(this.playhead);
    c.fillStyle = '#111';
    c.fillRect(Math.round(px), 0, 2, H);
    // sticky note names at the left edge
    c.fillStyle = 'rgba(255,255,255,.92)';
    c.fillRect(sx, 0, LABEL_W, H);
    c.fillStyle = '#556';
    c.font = '10px system-ui, sans-serif';
    c.textBaseline = 'middle';
    for (let m = this.lo; m <= this.hi; m++) if (m % 12 === 0) c.fillText(midiName(m), sx + 4, this.midiToY(m) + ROW / 2);
  }

  setPlayhead(beat, playing) {
    this.playhead = beat;
    this.playing = playing;
    if (playing) {
      const x = this.beatToX(beat), left = this.wrap.scrollLeft, vw = this.wrap.clientWidth;
      if (x > left + vw * 0.85 || x < left) this.wrap.scrollLeft = x - vw * 0.15;
    }
    this.draw();
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hit(x, y) {
    const midi = this.yToMidi(y), beat = this.xToBeat(x);
    const order = [this.activePart, 0, 1, 2, 3].filter((v, i, a) => a.indexOf(v) === i);
    for (const pi of order) {
      if (this.hidden[pi]) continue;
      const n = this.score.parts[pi].notes.find((n) => n.midi === midi && beat >= n.t && beat <= n.t + n.d);
      if (n) return { part: pi, note: n };
    }
    return null;
  }

  select(sel, scroll = false) {
    this.sel = sel;
    if (sel) {
      this.activePart = sel.part;
      if (scroll) {
        const x = this.beatToX(sel.note.t);
        if (x < this.wrap.scrollLeft + LABEL_W || x > this.wrap.scrollLeft + this.wrap.clientWidth - 40)
          this.wrap.scrollLeft = x - this.wrap.clientWidth / 3;
        const y = this.midiToY(sel.note.midi);
        if (y < this.wrap.scrollTop || y > this.wrap.scrollTop + this.wrap.clientHeight - ROW)
          this.wrap.scrollTop = y - this.wrap.clientHeight / 2;
      }
    }
    this.cb.onSelect?.(sel);
    this.draw();
  }

  down(e) {
    if (!this.score || e.button !== 0) return;
    const { x, y } = this.pos(e);
    this.canvas.focus({ preventScroll: true });
    if (x < this.wrap.scrollLeft + LABEL_W) return;
    const h = this.hit(x, y);
    if (h) {
      this.select(h);
      this.cb.onPreview?.(h.part, h.note.midi);
      this.drag = { sx: x, sy: y, t: h.note.t, midi: h.note.midi, moved: false };
    } else {
      this.select(null);
      this.cb.onSeek?.(Math.max(0, Math.round(this.xToBeat(x) / SNAP) * SNAP));
    }
  }

  move(e) {
    if (!this.drag || !this.sel) return;
    const { x, y } = this.pos(e);
    const n = this.sel.note;
    const t = Math.max(0, Math.round((this.drag.t + (x - this.drag.sx) / this.ppb) / SNAP) * SNAP);
    const midi = this.drag.midi - Math.round((y - this.drag.sy) / ROW);
    if (t === n.t && midi === n.midi) return;
    if (!this.drag.moved) { this.cb.onChange?.('before'); this.drag.moved = true; }
    if (midi !== n.midi) this.cb.onPreview?.(this.sel.part, midi);
    n.t = t;
    n.midi = midi;
    this.draw();
  }

  up() {
    if (this.drag?.moved) this.finish();
    this.drag = null;
  }

  finish() {
    const p = this.score.parts[this.sel.part];
    p.notes.sort((a, b) => a.t - b.t);
    this.cb.onChange?.('after');
    this.select(this.sel);
  }

  dbl(e) {
    if (!this.score) return;
    const { x, y } = this.pos(e);
    if (this.hit(x, y)) return;
    this.cb.onChange?.('before');
    const note = { t: Math.max(0, Math.floor(this.xToBeat(x) / 0.5) * 0.5), d: 1, midi: this.yToMidi(y) };
    this.score.parts[this.activePart].notes.push(note);
    this.sel = { part: this.activePart, note };
    this.cb.onPreview?.(this.activePart, note.midi);
    this.finish();
  }

  key(e) {
    if (!this.sel) return;
    const n = this.sel.note, notes = this.score.parts[this.sel.part].notes;
    const idx = notes.indexOf(n);
    const edit = (fn) => { this.cb.onChange?.('before'); fn(); this.finish(); };
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        edit(() => { n.midi += d; });
        this.cb.onPreview?.(this.sel.part, n.midi);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) edit(() => { n.t = Math.max(0, n.t + dir * 0.5); });
        else {
          const m = notes[idx + dir];
          if (m) { this.select({ part: this.sel.part, note: m }, true); this.cb.onPreview?.(this.sel.part, m.midi); }
        }
        break;
      }
      case '+':
      case '=':
        edit(() => { n.d += 0.5; });
        break;
      case '-':
      case '_':
        if (n.d > 0.25) edit(() => { n.d = Math.max(0.25, n.d - 0.5); });
        break;
      case 'Delete':
      case 'Backspace':
        edit(() => { notes.splice(idx, 1); });
        this.select(notes[Math.min(idx, notes.length - 1)] ? { part: this.sel.part, note: notes[Math.min(idx, notes.length - 1)] } : null);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
