// Turns recognised noteheads (from omr.js) into four timed voices.
//
// Score format used everywhere else in the app:
//   { parts: [{ name, notes: [{ t, d, midi, src? }] } x4], title }
// t and d are measured in quarter-note beats.

export const PART_NAMES = ['Soprano', 'Alto', 'Tenor', 'Bass'];

const LETTER_SEMI = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B as letter indexes (C=0)
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

// Diatonic step number (octave*7 + letter) of the top staff line.
const TOP_LINE = { treble: 5 * 7 + 3, treble8: 4 * 7 + 3, bass: 3 * 7 + 5 };

export function keyAlter(key, letter) {
  if (key > 0 && SHARP_ORDER.slice(0, key).includes(letter)) return 1;
  if (key < 0 && FLAT_ORDER.slice(0, -key).includes(letter)) return -1;
  return 0;
}

export function stepToMidi(step, alter) {
  const oct = Math.floor(step / 7), letter = ((step % 7) + 7) % 7;
  return 12 * (oct + 1) + LETTER_SEMI[letter] + alter;
}

export function midiName(m) {
  const n = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][((m % 12) + 12) % 12];
  return n + (Math.floor(m / 12) - 1);
}

function mode(values) {
  const c = new Map();
  for (const v of values) c.set(v, (c.get(v) || 0) + 1);
  let best = null, bc = 0;
  for (const [v, n] of c) if (n > bc || (n === bc && v > best)) { best = v; bc = n; }
  return best;
}

/**
 * Detected settings for the UI to show (and let the user override).
 */
export function detectSettings(pages) {
  const keys = [], staffCounts = [], clefs = [];
  for (const p of pages) {
    p.systems.forEach((sys, si) => {
      staffCounts.push(sys.length);
      sys.forEach((sIdx, i) => {
        const st = p.staves[sIdx];
        if (si > 0 || p.systems.length === 1 || pages.length > 1) keys.push(st.key);
        (clefs[i] = clefs[i] || []).push(st.clef || '');
      });
    });
  }
  let staves = mode(staffCounts) || 2;
  if (staves !== 4) staves = staves === 1 ? 1 : 2;
  // If systems were not detected (no joining line), staves come one by one; pair them.
  const allSingle = staffCounts.length > 1 && staffCounts.every((n) => n === 1);
  if (allSingle) staves = 2;
  const clefList = [];
  for (let i = 0; i < staves; i++) {
    let c;
    if (allSingle) {
      const all = [];
      for (const p of pages) p.staves.forEach((st, j) => { if (j % 2 === i) all.push(st.clef || ''); });
      c = mode(all.filter(Boolean));
    } else c = mode((clefs[i] || []).filter(Boolean));
    if (!c) c = staves === 4 ? ['treble', 'treble', 'treble8', 'bass'][i] : i === 0 ? 'treble' : 'bass';
    clefList.push(c);
  }
  const key = keys.length ? mode(keys) : 0;
  return { key: key ?? 0, staves, clefs: clefList, regroup: allSingle };
}

/** Split staves into systems according to the chosen staves-per-system. */
function systemsOf(page, settings) {
  if (!settings.regroup && page.systems.every((s) => s.length === settings.staves)) return page.systems;
  const out = [];
  const n = settings.staves;
  for (let i = 0; i + n <= page.staves.length; i += n) out.push(page.staves.slice(i, i + n).map((s) => s.index));
  return out;
}

// Assign the heads of one staff to its voices: returns [[upper heads], [lower heads]].
function splitStaff(heads, il, homophonic) {
  const sorted = heads.slice().sort((a, b) => a.x - b.x);
  const cols = [];
  for (const h of sorted) {
    const c = cols.find((col) => col.some((o) => Math.abs(o.x - h.x) < il * 0.5 ||
      (o.stemX !== null && h.stemX !== null && Math.abs(o.stemX - h.stemX) < il * 0.25 && o.stemUp === h.stemUp)));
    if (c) c.push(h);
    else cols.push([h]);
  }
  const upper = [], lower = [];
  const asUp = (h) => ({ ...h, dur: h.durUp ?? h.dur });
  const asDown = (h) => ({ ...h, dur: h.durDown ?? h.dur });
  for (const col of cols) {
    col.sort((a, b) => a.k - b.k); // top first
    const hasUp = col.some((h) => h.stemUp), hasDown = col.some((h) => h.stemDown);
    const top = col[0], bot = col[col.length - 1];
    if (col.length === 1) {
      const h = col[0];
      if ((h.stemUp && h.stemDown) || (!h.stemUp && !h.stemDown) || homophonic) { upper.push(asUp(h)); lower.push(asDown(h)); }
      else if (h.stemUp) upper.push(asUp(h));
      else lower.push(asDown(h));
      continue;
    }
    if (hasUp && hasDown) { upper.push(asUp(top)); lower.push(asDown(bot)); continue; }
    if (homophonic || (!hasUp && !hasDown)) {
      const d = hasDown ? asDown : asUp;
      upper.push(d(top)); lower.push(d(bot));
      continue;
    }
    if (hasUp) upper.push(asUp(top));
    else lower.push(asDown(bot));
  }
  return [upper, lower];
}

function isHomophonic(heads, il) {
  // Count chords: several heads on one shared stem (vs. separate up/down stems).
  let shared = 0, split = 0;
  const sorted = heads.slice().sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x < il * 0.5; j++) {
      const a = sorted[i], b = sorted[j];
      if (a.k === b.k) continue;
      if ((a.stemUp && a.stemDown) || (b.stemUp && b.stemDown) || (a.stemUp !== b.stemUp)) split++;
      else shared++;
    }
  }
  return shared > split * 1.5 && shared >= 3;
}

/**
 * Build the four-part score from recognised pages.
 * settings: { key, staves (2|4), clefs: [clef per staff in system] }
 */
export function buildScore(pages, settings) {
  const parts = PART_NAMES.map((name) => ({ name, notes: [] }));
  let time = 0;
  // Decide notation style per staff position once for the whole document.
  const homo = [];
  for (let i = 0; i < settings.staves; i++) {
    const hs = [];
    let il = 20;
    for (const p of pages) {
      il = p.il;
      for (const sys of systemsOf(p, settings)) hs.push(...p.heads.filter((h) => h.staff === sys[i]));
    }
    homo.push(isHomophonic(hs, il));
  }

  pages.forEach((page, pi) => {
    const il = page.il;
    for (const sys of systemsOf(page, settings)) {
      // voices[v] = heads for that voice in this system
      const voices = [[], [], [], []];
      sys.forEach((sIdx, i) => {
        const hs = page.heads.filter((h) => h.staff === sIdx).map((h) => ({ ...h, clef: settings.clefs[i] || 'treble' }));
        if (settings.staves === 4) voices[i].push(...hs);
        else if (settings.staves === 1) { const [u, l] = splitStaff(hs, il, homo[0]); voices[0].push(...u); voices[1].push(...l); }
        else {
          const [u, l] = splitStaff(hs, il, homo[i]);
          voices[i * 2].push(...u);
          voices[i * 2 + 1].push(...l);
        }
      });

      // Pitches (key signature + accidentals that last until the barline).
      const staves = sys.map((s) => page.staves[s]);
      const barsOf = (sIdx) => page.staves[sIdx].bars || [];
      const measureIndex = (h) => barsOf(h.staff).filter((b) => b < h.x).length;
      const accMemo = new Map();
      const allHeads = [...new Set(voices.flat())].sort((a, b) => a.x - b.x);
      for (const h of allHeads) {
        const step = TOP_LINE[h.clef] - h.k;
        const letter = ((step % 7) + 7) % 7;
        const key = `${h.staff}:${measureIndex(h)}:${step}`;
        let alter = keyAlter(settings.key, letter);
        if (h.acc) {
          alter = h.acc === 'sharp' ? 1 : h.acc === 'flat' ? -1 : 0;
          accMemo.set(key, alter);
        } else if (accMemo.has(key)) alter = accMemo.get(key);
        h.midi = stepToMidi(step, alter);
      }

      // Measures for the whole system: union of barlines seen on its staves.
      const barXs = [];
      for (const st of staves) for (const b of st.bars || []) if (!barXs.some((o) => Math.abs(o - b) < il)) barXs.push(b);
      barXs.sort((a, b) => a - b);
      const sysX0 = Math.min(...staves.map((s) => s.x0)), sysX1 = Math.max(...staves.map((s) => s.x1));
      const edges = [sysX0, ...barXs.filter((b) => b > sysX0 + il * 2 && b < sysX1 - il * 0.5), sysX1 + 1];

      for (let m = 0; m + 1 < edges.length; m++) {
        const xa = edges[m], xb = edges[m + 1];
        // events per voice: heads at the same x form one event
        const evs = voices.map((vh) => {
          const hs = vh.filter((h) => h.x >= xa && h.x < xb).sort((a, b) => a.x - b.x);
          const out = [];
          for (const h of hs) {
            const last = out[out.length - 1];
            if (last && Math.abs(last.x - h.x) < il * 0.5) { last.heads.push(h); last.dur = Math.min(last.dur, h.dur); }
            else out.push({ x: h.x, dur: h.dur, heads: [h] });
          }
          return out;
        });
        const sums = evs.map((e) => e.reduce((s, ev) => s + ev.dur, 0));
        const nonEmpty = sums.filter((s) => s > 0);
        if (!nonEmpty.length) continue;
        const target = mode(nonEmpty);
        const refs = evs.filter((e, v) => sums[v] === target);
        // x -> beat lookup built from voices whose rhythm adds up.
        const pts = [[xa, 0], [xb, target]];
        for (const e of refs) {
          let tt = 0;
          for (const ev of e) { pts.push([ev.x, tt]); tt += ev.dur; }
        }
        pts.sort((a, b) => a[0] - b[0]);
        const xToBeat = (x) => {
          let near = null;
          for (const p of pts) if (Math.abs(p[0] - x) < il * 0.7 && (!near || Math.abs(p[0] - x) < Math.abs(near[0] - x))) near = p;
          if (near && near[0] !== xa && near[0] !== xb) return near[1];
          let i = 0;
          while (i + 1 < pts.length && pts[i + 1][0] < x) i++;
          const [x0, b0] = pts[i], [x1, b1] = pts[Math.min(i + 1, pts.length - 1)];
          const b = x1 === x0 ? b0 : b0 + ((x - x0) / (x1 - x0)) * (b1 - b0);
          return Math.round(b * 4) / 4;
        };
        evs.forEach((e, v) => {
          if (!e.length) return;
          let onsets;
          if (sums[v] === target) {
            let tt = 0;
            onsets = e.map((ev) => { const o = tt; tt += ev.dur; return o; });
          } else onsets = e.map((ev) => xToBeat(ev.x));
          e.forEach((ev, i) => {
            const next = i + 1 < e.length ? onsets[i + 1] : target;
            const d = sums[v] === target ? ev.dur : Math.min(ev.dur, next - onsets[i]) || next - onsets[i];
            if (d <= 0) return;
            for (const h of ev.heads) {
              parts[v].notes.push({ t: time + onsets[i], d, midi: h.midi, src: { page: pi, x: h.x, y: h.y } });
            }
          });
        });
        time += target;
      }
    }
  });
  for (const p of parts) p.notes.sort((a, b) => a.t - b.t || b.midi - a.midi);
  return { parts };
}
