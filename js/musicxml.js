// MusicXML (.musicxml / .xml / compressed .mxl) import. This is the accurate
// path: notation programs like MuseScore, Finale and Sibelius export it.
import { PART_NAMES } from './score.js';

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

async function unzipEntry(buf, wanted) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .mxl (zip) file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, size, local });
    p += 46 + nameLen + extra + comment;
  }
  const read = async (e) => {
    const nl = dv.getUint16(e.local + 26, true), el = dv.getUint16(e.local + 28, true);
    const data = new Uint8Array(buf, e.local + 30 + nl + el, e.size);
    if (e.method === 0) return dec.decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  };
  return { entries, read, pick: wanted };
}

export async function readMusicXmlFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  let text;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const zip = await unzipEntry(buf);
    let main = null;
    const container = zip.entries.find((e) => e.name === 'META-INF/container.xml');
    if (container) {
      const doc = new DOMParser().parseFromString(await zip.read(container), 'application/xml');
      const path = doc.querySelector('rootfile')?.getAttribute('full-path');
      main = zip.entries.find((e) => e.name === path);
    }
    main = main || zip.entries.find((e) => /\.(xml|musicxml)$/i.test(e.name) && !e.name.startsWith('META-INF'));
    if (!main) throw new Error('No score found inside the .mxl file');
    text = await zip.read(main);
  } else text = new TextDecoder().decode(buf);
  return parseMusicXml(text);
}

export function parseMusicXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not read this MusicXML file');
  if (doc.documentElement.nodeName === 'score-timewise') throw new Error('Timewise MusicXML is not supported; export as partwise');
  // streams: one per (part, voice): array of chords {t, d, midis[]}
  const streams = [];
  const title = doc.querySelector('work-title, movement-title')?.textContent?.trim() || '';
  doc.querySelectorAll('part').forEach((part, pi) => {
    let divisions = 1, t = 0, octaveShift = 0;
    const byVoice = new Map();
    const ties = new Map(); // "voice:midi" -> open tied note
    for (const measure of part.querySelectorAll(':scope > measure')) {
      let measureStart = t, measureMax = t;
      for (const el of measure.children) {
        if (el.nodeName === 'attributes') {
          const d = el.querySelector('divisions');
          if (d) divisions = +d.textContent;
          const oc = el.querySelector('transpose > octave-change');
          if (oc) octaveShift = +oc.textContent;
        } else if (el.nodeName === 'backup') {
          t -= +el.querySelector('duration').textContent / divisions;
        } else if (el.nodeName === 'forward') {
          t += +el.querySelector('duration').textContent / divisions;
        } else if (el.nodeName === 'note') {
          if (el.querySelector('grace')) continue;
          const isChord = !!el.querySelector('chord');
          const d = +(el.querySelector('duration')?.textContent || 0) / divisions;
          const voice = el.querySelector('voice')?.textContent || '1';
          if (!byVoice.has(voice)) byVoice.set(voice, []);
          const list = byVoice.get(voice);
          const pitch = el.querySelector('pitch');
          let start = t;
          if (isChord && list.length) start = list[list.length - 1].t;
          if (pitch) {
            const step = pitch.querySelector('step').textContent;
            const alter = +(pitch.querySelector('alter')?.textContent || 0);
            const oct = +pitch.querySelector('octave').textContent + octaveShift;
            const midi = 12 * (oct + 1) + STEP[step] + Math.round(alter);
            const tieTypes = [...el.querySelectorAll('tie')].map((x) => x.getAttribute('type'));
            const key = voice + ':' + midi;
            const open = ties.get(key);
            if (open && tieTypes.includes('stop') && Math.abs(open.t + open.d - start) < 1e-6) {
              open.d += d;
              if (!tieTypes.includes('start')) ties.delete(key);
            } else {
              const last = list[list.length - 1];
              const note = { t: start, d, midi };
              if (isChord && last && Math.abs(last.t - start) < 1e-6) last.midis.push(note);
              else list.push({ t: start, d, midis: [note] });
              if (tieTypes.includes('start')) ties.set(key, note);
            }
          }
          if (!isChord) t += d;
          measureMax = Math.max(measureMax, t);
        }
      }
      t = Math.max(measureMax, measureStart);
    }
    [...byVoice.keys()].sort((a, b) => +a - +b).forEach((v) => {
      const chords = byVoice.get(v).filter((c) => c.midis.length);
      if (chords.length) streams.push({ part: pi, voice: v, chords });
    });
  });
  return { title, parts: assignVoices(streams) };
}

// Map the file's parts/voices onto Soprano, Alto, Tenor, Bass.
function assignVoices(streams) {
  const parts = PART_NAMES.map((name) => ({ name, notes: [] }));
  const take = (chords, pick) => chords.flatMap((c) => {
    const sorted = c.midis.slice().sort((a, b) => b.midi - a.midi);
    const n = pick(sorted);
    return n ? [{ t: n.t, d: n.d, midi: n.midi }] : [];
  });
  const top = (s) => s[0], bottom = (s) => s[s.length - 1];
  if (streams.length >= 4) {
    streams.slice(0, 4).forEach((s, i) => { parts[i].notes = take(s.chords, top); });
  } else if (streams.length === 3) {
    // the stream with the most chords is the one holding two voices
    const most = streams.reduce((b, s, i) => (chordiness(s) > chordiness(streams[b]) ? i : b), 0);
    let v = 0;
    streams.forEach((s, i) => {
      if (i === most) { parts[v++].notes = take(s.chords, top); parts[v++].notes = take(s.chords, bottom); }
      else parts[v++].notes = take(s.chords, top);
    });
  } else if (streams.length === 2) {
    streams.forEach((s, i) => {
      parts[i * 2].notes = take(s.chords, top);
      parts[i * 2 + 1].notes = take(s.chords, bottom);
    });
  } else if (streams.length === 1) {
    const s = streams[0];
    parts.forEach((p, i) => { p.notes = take(s.chords, (c) => c[Math.min(i, c.length - 1)]); });
  }
  for (const p of parts) p.notes.sort((a, b) => a.t - b.t);
  return parts;
}

function chordiness(s) {
  return s.chords.filter((c) => c.midis.length > 1).length;
}
