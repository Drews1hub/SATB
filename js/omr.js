// Optical music recognition for simple four-part (SATB) scores.
//
// Works on a grayscale page image and returns staves, systems and noteheads
// with enough detail (stem direction, beams, dots, accidentals) for score.js to
// turn them into four voices. Everything is measured relative to the staff
// space ("il" = distance between two staff lines) so it works at any size.

// ---------- basic image helpers ----------

export function imageDataToGray(img) {
  const { data, width, height } = img;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const a = data[j + 3] / 255;
    const lum = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    gray[i] = Math.round(255 - (255 - lum) * a);
  }
  return { gray, width, height };
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// Global Otsu combined with a local-mean test so uneven scan lighting is handled.
function binarize(gray, w, h) {
  const t = otsu(gray);
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const r = 20;
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const g = gray[y * w + x];
      if (g >= t + 25) continue;
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      const mean = s / ((y1 - y0) * (x1 - x0));
      if (g < t * 0.6 || (g < t + 25 && g < mean - 12) || (g < t && g < mean)) bin[y * w + x] = 1;
    }
  }
  return bin;
}

// Find the small rotation (degrees) that makes staff lines most horizontal.
function estimateSkew(bin, w, h) {
  const pts = [];
  // Sample columns only: skipping rows would alias the projection at 0 degrees.
  const step = Math.max(1, Math.floor((w * h) / 400000));
  for (let y = 0; y < h; y++)
    for (let x = (y * 7) % step; x < w; x += step) if (bin[y * w + x]) pts.push(x, y);
  const score = (deg) => {
    const tan = Math.tan((deg * Math.PI) / 180);
    const hist = new Float64Array(h + w);
    for (let i = 0; i < pts.length; i += 2) {
      const yy = Math.round(pts[i + 1] - pts[i] * tan + w * 0.5);
      if (yy >= 0 && yy < hist.length) hist[yy]++;
    }
    let s = 0;
    for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
    return s;
  };
  let best = 0, bestS = -1;
  for (let a = -3; a <= 3.001; a += 0.2) {
    const s = score(a);
    if (s > bestS) { bestS = s; best = a; }
  }
  const c = best;
  for (let a = c - 0.2; a <= c + 0.2001; a += 0.02) {
    const s = score(a);
    if (s > bestS) { bestS = s; best = a; }
  }
  return best;
}

function rotateGray(gray, w, h, deg) {
  const out = new Uint8Array(w * h).fill(255);
  const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = c * dx - s * dy + cx, sy = s * dx + c * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
      const v = gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) +
        gray[i + w] * (1 - fx) * fy + gray[i + w + 1] * fx * fy;
      out[y * w + x] = v;
    }
  }
  return out;
}

// Most common black vertical run = line thickness; most common white run = gap.
function runStats(bin, w, h) {
  const bh = new Int32Array(256), wh = new Int32Array(512);
  for (let x = 0; x < w; x += 2) {
    let run = 0, cur = bin[x];
    for (let y = 0; y <= h; y++) {
      const v = y < h ? bin[y * w + x] : 2;
      if (v === cur) { run++; continue; }
      if (cur === 1 && run < 256) bh[run]++;
      else if (cur === 0 && run < 512) wh[run]++;
      cur = v; run = 1;
    }
  }
  let t = 1, g = 4;
  for (let i = 1; i < 256; i++) if (bh[i] > bh[t]) t = i;
  for (let i = 4; i < 512; i++) if (wh[i] > wh[g]) g = i;
  return { thickness: t, il: t + g };
}

/** Rough staff-space size in pixels, used to pick a good rendering scale. */
export function estimateStaffSpace(page) {
  const { gray, width: w, height: h } = page;
  const bin = binarize(gray, w, h);
  const { thickness, il } = runStats(bin, w, h);
  const staves = findStaves(bin, w, h, il, thickness);
  return staves.length ? staves.reduce((s, st) => s + st.space, 0) / staves.length : il;
}

// ---------- connected components ----------

function labelComponents(bin, w, h) {
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i]) continue;
      const n = [];
      if (x > 0 && labels[i - 1]) n.push(labels[i - 1]);
      if (y > 0) {
        if (labels[i - w]) n.push(labels[i - w]);
        if (x > 0 && labels[i - w - 1]) n.push(labels[i - w - 1]);
        if (x < w - 1 && labels[i - w + 1]) n.push(labels[i - w + 1]);
      }
      if (!n.length) { parent.push(parent.length); labels[i] = parent.length - 1; }
      else {
        let m = n[0];
        for (const v of n) if (v < m) m = v;
        labels[i] = m;
        for (const v of n) if (v !== m) union(m, v);
      }
    }
  }
  const remap = new Int32Array(parent.length);
  const comps = [];
  for (let i = 1; i < parent.length; i++) {
    const r = find(i);
    if (!remap[r]) {
      comps.push({ x0: 1e9, y0: 1e9, x1: -1, y1: -1, area: 0, sy: 0 });
      remap[r] = comps.length;
    }
    remap[i] = remap[r];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const l = (labels[i] = remap[labels[i]]);
      const c = comps[l - 1];
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      c.area++;
      c.sy += y;
    }
  }
  for (const c of comps) { c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; c.cy = c.sy / c.area; }
  return { labels, comps };
}

// ---------- staff finding ----------

function findStaves(bin, w, h, il, t) {
  const minRun = Math.round(il * 3);
  const rowScore = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let run = 0, s = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && bin[y * w + x]) run++;
      else { if (run >= minRun) s += run; run = 0; }
    }
    rowScore[y] = s;
  }
  let max = 0;
  for (let y = 0; y < h; y++) if (rowScore[y] > max) max = rowScore[y];
  const thr = max * 0.3;
  const lines = [];
  for (let y = 0; y < h; y++) {
    if (rowScore[y] < thr) continue;
    let y1 = y, sw = 0, sy = 0;
    while (y1 < h && rowScore[y1] >= thr) { sw += rowScore[y1]; sy += y1 * rowScore[y1]; y1++; }
    lines.push({ y: sy / sw, th: y1 - y });
    y = y1;
  }
  const staves = [];
  for (let i = 0; i + 4 < lines.length; ) {
    const g = [];
    for (let k = 0; k < 4; k++) g.push(lines[i + k + 1].y - lines[i + k].y);
    const g0 = (g[0] + g[1] + g[2] + g[3]) / 4;
    const ok = g0 > il * 0.7 && g0 < il * 1.35 && g.every((v) => Math.abs(v - g0) < g0 * 0.2 + 1);
    if (ok) { staves.push({ lines: lines.slice(i, i + 5).map((l) => l.y), space: g0 }); i += 5; }
    else i++;
  }
  // Horizontal extent: where at least 4 of the 5 lines are black.
  for (const st of staves) {
    const isStaff = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (const ly of st.lines) {
        const yy = Math.round(ly);
        for (let d = -1 - (t >> 1); d <= 1 + (t >> 1); d++) {
          const y2 = yy + d;
          if (y2 >= 0 && y2 < h && bin[y2 * w + x]) { c++; break; }
        }
      }
      isStaff[x] = c >= 4 ? 1 : 0;
    }
    let best = [0, 0], start = -1, last = -1;
    const gap = il * 2;
    for (let x = 0; x <= w; x++) {
      if (x < w && isStaff[x]) {
        if (start < 0 || x - last > gap) start = x;
        last = x;
        if (last - start > best[1] - best[0]) best = [start, last];
      }
    }
    st.x0 = best[0];
    st.x1 = best[1];
  }
  return staves.filter((s) => s.x1 - s.x0 > il * 10);
}

// Follow each staff line along x so slightly curved / tilted scans still work.
function trackLines(st, bin, w, h, il) {
  const chunk = Math.max(8, Math.round(il * 4));
  const n = Math.ceil((st.x1 - st.x0 + 1) / chunk);
  const r = Math.max(2, Math.round(il * 0.3));
  st.chunk = chunk;
  st.track = st.lines.map((y0) => {
    const ys = new Float64Array(n);
    let prev = y0;
    for (let c = 0; c < n; c++) {
      const xa = st.x0 + c * chunk, xb = Math.min(st.x1 + 1, xa + chunk);
      let sw = 0, sy = 0, best = 0;
      const counts = [];
      for (let d = -r; d <= r; d++) {
        const y = Math.round(prev) + d;
        let cnt = 0;
        if (y >= 0 && y < h) for (let x = xa; x < xb; x++) cnt += bin[y * w + x];
        counts.push([y, cnt]);
        if (cnt > best) best = cnt;
      }
      if (best >= (xb - xa) * 0.6) {
        for (const [y, cnt] of counts) if (cnt >= best * 0.8) { sw += cnt; sy += y * cnt; }
        // Lines bend slowly; limit the step so noteheads cannot drag the line.
        const step = Math.max(1, il * 0.1);
        prev = Math.max(prev - step, Math.min(prev + step, sy / sw));
      }
      ys[c] = prev;
    }
    return ys;
  });
}

function lineY(st, l, x) {
  const ys = st.track[l];
  const f = (x - st.x0) / st.chunk - 0.5;
  const c = Math.max(0, Math.min(ys.length - 1, Math.floor(f)));
  const c2 = Math.min(ys.length - 1, c + 1);
  const a = Math.max(0, Math.min(1, f - c));
  return ys[c] * (1 - a) + ys[c2] * a;
}

// y of staff position k (0 = top line, 1 = space below it, ... 8 = bottom line).
export function posY(st, k, x) {
  if (k >= 0 && k <= 8) {
    const l = Math.min(3, Math.floor(k / 2));
    const a = (k - l * 2) / 2;
    return lineY(st, l, x) * (1 - a) + lineY(st, l + 1, x) * a;
  }
  if (k < 0) {
    const sp = lineY(st, 1, x) - lineY(st, 0, x);
    return lineY(st, 0, x) + (k / 2) * sp;
  }
  const sp = lineY(st, 4, x) - lineY(st, 3, x);
  return lineY(st, 4, x) + ((k - 8) / 2) * sp;
}

function removeStaffLines(bin, w, h, staves, t) {
  const nb = bin.slice();
  const maxLen = Math.max(t + 2, Math.round(t * 1.7));
  for (const st of staves) {
    for (let l = 0; l < 5; l++) {
      for (let x = st.x0; x <= st.x1; x++) {
        const yc = Math.round(lineY(st, l, x));
        let y = -1;
        for (let d = 0; d <= t; d++) {
          if (yc - d >= 0 && bin[(yc - d) * w + x]) { y = yc - d; break; }
          if (yc + d < h && bin[(yc + d) * w + x]) { y = yc + d; break; }
        }
        if (y < 0) continue;
        let a = y, b = y;
        while (a > 0 && bin[(a - 1) * w + x]) a--;
        while (b < h - 1 && bin[(b + 1) * w + x]) b++;
        if (b - a + 1 <= maxLen) for (let yy = a; yy <= b; yy++) nb[yy * w + x] = 0;
      }
    }
  }
  return nb;
}

// Small enclosed white areas (inside half/whole noteheads) -> hole mask.
function findHoles(nb, w, h, staves, il, hole, strict) {
  const seen = new Uint8Array(w * h);
  // With staff lines still present the gaps between lines are enclosed too, so
  // be stricter about size there.
  const maxArea = il * il * 0.6, maxDim = il * (strict ? 1.1 : 1.3);
  const maxH = strict ? il * 0.8 : maxDim;
  const stack = new Int32Array(w * h > 4e6 ? 4e6 : w * h);
  for (const st of staves) {
    const ya = Math.max(1, Math.floor(st.lines[0] - il * 5));
    const yb = Math.min(h - 2, Math.ceil(st.lines[4] + il * 5));
    const xa = Math.max(1, st.x0), xb = Math.min(w - 2, st.x1);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const i0 = y * w + x;
        if (nb[i0] || seen[i0]) continue;
        let sp = 0, area = 0, open = false;
        let mx0 = x, mx1 = x, my0 = y, my1 = y;
        const pix = [];
        stack[sp++] = i0;
        seen[i0] = 1;
        while (sp) {
          const i = stack[--sp];
          const px = i % w, py = (i - px) / w;
          area++;
          if (area <= maxArea) pix.push(i);
          if (px < mx0) mx0 = px;
          if (px > mx1) mx1 = px;
          if (py < my0) my0 = py;
          if (py > my1) my1 = py;
          if (px <= xa || px >= xb || py <= ya || py >= yb) { open = true; continue; }
          for (const j of [i - 1, i + 1, i - w, i + w]) {
            if (!nb[j] && !seen[j] && sp < stack.length) { seen[j] = 1; stack[sp++] = j; }
          }
        }
        // (strict) holes in noteheads are oval; gaps boxed in by lines and stems are rectangles
        const rect = area / ((mx1 - mx0 + 1) * (my1 - my0 + 1));
        if (!open && area <= maxArea && mx1 - mx0 < maxDim && my1 - my0 < maxH && (!strict || rect < 0.85))
          for (const i of pix) hole[i] = 1;
      }
    }
  }
  return hole;
}

function integral(img, w, h) {
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += img[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  return ii;
}

function fill(ii, w, h, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(w, Math.round(x1)); y1 = Math.min(h, Math.round(y1));
  if (x1 <= x0 || y1 <= y0) return 0;
  const W = w + 1;
  const s = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
  return s / ((x1 - x0) * (y1 - y0));
}

// ---------- page recognition ----------

/**
 * Recognise one page.
 * @param {{gray:Uint8Array,width:number,height:number}} page
 * @returns {{il:number, systems:Array, staves:Array, heads:Array, skew:number, width:number, height:number}}
 */
export function recognizePage(page) {
  let { gray, width: w, height: h } = page;
  let bin = binarize(gray, w, h);
  const skew = estimateSkew(bin, w, h);
  if (Math.abs(skew) > 0.05) {
    gray = rotateGray(gray, w, h, skew);
    bin = binarize(gray, w, h);
  }
  const { thickness: t0, il: il0 } = runStats(bin, w, h);
  const staves = findStaves(bin, w, h, il0, t0);
  const result = { il: il0, skew, width: w, height: h, staves: [], systems: [], heads: [] };
  if (!staves.length) return result;
  const il = staves.reduce((s, st) => s + st.space, 0) / staves.length;
  const t = Math.max(1, Math.min(t0, Math.round(il * 0.25)));
  result.il = il;
  for (const st of staves) trackLines(st, bin, w, h, il);

  const nb = removeStaffLines(bin, w, h, staves, t);
  const hole = new Uint8Array(w * h);
  findHoles(nb, w, h, staves, il, hole, false);
  findHoles(bin, w, h, staves, il, hole, true);
  const nf = nb.slice();
  for (let i = 0; i < nf.length; i++) if (hole[i]) nf[i] = 1;
  const iiF = integral(nf, w, h), iiH = integral(hole, w, h);
  const { labels, comps } = labelComponents(nb, w, h);

  const black = (x, y) => x >= 0 && y >= 0 && x < w && y < h && nb[(y | 0) * w + (x | 0)] === 1;

  // Walk along a stem column; returns the farthest y reached (allowing 2px gaps).
  const walk = (x, y, dir, maxLen) => {
    let yy = y, gapLeft = 2, end = y;
    for (let n = 0; n < maxLen; n++) {
      yy += dir;
      if (black(x, yy) || black(x + 1, yy)) { end = yy; gapLeft = 2; }
      else if (--gapLeft < 0) break;
    }
    return end;
  };

  const stemSearch = (hx, hy, dir) => {
    // Up-stems sit on the right edge of the head, down-stems on the left edge.
    const xa = Math.round(dir < 0 ? hx + il * 0.3 : hx - il * 0.9);
    const xb = Math.round(dir < 0 ? hx + il * 0.9 : hx - il * 0.3);
    let best = 0, bestX = 0, tip = hy;
    for (let x = xa; x <= xb; x++) {
      let start = -1;
      for (let d = Math.round(-il * 0.35); d <= Math.round(il * 0.35); d++) {
        if (black(x, hy + d) || black(x + 1, hy + d)) { start = hy + d; break; }
      }
      if (start < 0) continue;
      const end = walk(x, Math.round(start), dir, Math.round(il * 9));
      const len = Math.abs(end - hy);
      if (len > best) { best = len; bestX = x; tip = end; }
    }
    return { len: best, x: bestX, tip };
  };

  const countBeams = (sx, tip, dir, len) => {
    // dir: +1 stem goes down from head (tip below), -1 stem up (tip above).
    // Only look along the part of the stem away from the head (ledger lines!).
    const span = Math.round(Math.min(il * 2.4, len - il * 1.2));
    let best = 0;
    for (const off of [-0.45, 0.45, 0.7]) {
      const x = Math.round(sx + off * il);
      let runs = 0, run = 0;
      for (let n = 0; n <= span; n++) {
        const y = Math.round(tip - dir * n);
        if (black(x, y)) run++;
        else { if (run >= il * 0.22 && run <= il * 0.9) runs++; run = 0; }
      }
      best = Math.max(best, runs);
    }
    return Math.min(best, 3);
  };

  // ----- clefs, systems -----
  // The clef is the first symbol after the staff start. Treble clefs stick out
  // above and below the staff; bass clefs stay inside. Measured on the ink
  // itself because staff-line removal can break clefs into pieces.
  const clefOf = (st) => {
    // Look above/below the staff, but not past halfway to the neighbouring staff.
    const i = staves.indexOf(st), prev = staves[i - 1], next = staves[i + 1];
    let ya = st.lines[0] - il * 3.5, yb = st.lines[4] + il * 3.5;
    if (prev) ya = Math.max(ya, (prev.lines[4] + st.lines[0]) / 2);
    if (next) yb = Math.min(yb, (st.lines[4] + next.lines[0]) / 2);
    ya = Math.max(0, Math.round(ya));
    yb = Math.min(h - 1, Math.round(yb));
    const ia = Math.round(st.lines[0] - il * 0.5), ib = Math.round(st.lines[4] + il * 0.5);
    const colInk = (x, y0, y1) => { for (let y = y0; y <= y1; y++) if (nb[y * w + x]) return true; return false; };
    let x = Math.round(st.x0 + il * 0.4);
    const xMax = Math.round(st.x0 + il * 5);
    while (x < xMax && !colInk(x, ia, ib)) x++;
    if (x >= xMax) return { clef: null, right: st.x0 + il * 3 };
    const x0 = x;
    let gap = 0, right = x;
    for (; x < xMax && gap < il * 0.35; x++) {
      if (colInk(x, ya, yb)) { gap = 0; right = x; } else gap++;
    }
    if (right - x0 < il * 1.2) return { clef: null, right: st.x0 + il * 3 };
    // Union of the pieces in that column range (ignoring the system bracket,
    // whose curled tips reach over the staff).
    let top = yb, bottom = ya;
    for (const c of comps) {
      if (c.x1 < x0 || c.x0 > right || c.y1 < ya || c.y0 > yb) continue;
      if (c.x0 < st.x0 || c.h > il * 9 || c.y0 < ya || c.y1 > yb) continue;
      top = Math.min(top, c.y0);
      bottom = Math.max(bottom, c.y1);
    }
    let clef = 'bass';
    if (top < st.lines[0] - il * 0.8 || bottom > st.lines[4] + il * 0.8) {
      clef = bottom > st.lines[4] + il * 2.4 ? 'treble8' : 'treble';
    }
    return { clef, right };
  };

  staves.forEach((st, i) => {
    const c = clefOf(st);
    st.clef = c.clef;
    st.headerX = c.right;
    st.index = i;
  });

  // Staves joined by a vertical line at their left edge belong to one system.
  const joined = (a, b) => {
    const ya = Math.round(a.lines[4]), yb = Math.round(b.lines[0]);
    const xa = Math.round(Math.min(a.x0, b.x0) - il * 0.8), xb = Math.round(Math.max(a.x0, b.x0) + il * 0.4);
    for (let x = xa; x <= xb; x++) {
      let c = 0;
      for (let y = ya; y <= yb; y++) if (x >= 0 && bin[y * w + x]) c++;
      if (c >= (yb - ya + 1) * 0.92) return true;
    }
    return false;
  };
  const groups = [[staves[0]]];
  for (let i = 1; i < staves.length; i++) {
    if (joined(staves[i - 1], staves[i])) groups[groups.length - 1].push(staves[i]);
    else groups.push([staves[i]]);
  }

  // ----- accidentals -----
  // Staff-line removal can split a flat into stem + bowl, so nearby pieces are merged.
  const symbolsIn = (xa, xb, ya, yb) => {
    const boxes = comps
      .filter((c) => c.x1 >= xa && c.x0 <= xb && c.y1 >= ya && c.y0 <= yb && c.h >= il * 0.25 && c.w <= il * 2)
      .map((c) => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 }));
    // A thin stem with a small bowl hugging its lower right end is a flat.
    const isStem = (b) => b.x1 - b.x0 < il * 0.35 && b.y1 - b.y0 > il * 1.5;
    for (const st of boxes.filter(isStem)) {
      let best = -1, bestGap = il * 0.35;
      boxes.forEach((b, j) => {
        if (b === st || isStem(b) || b.y1 - b.y0 > il * 1.4 || b.x1 - b.x0 > il * 0.9) return;
        const gap = b.x0 - st.x1;
        if (gap < -2 || gap > bestGap) return;
        if (b.y1 < st.y1 - il * 0.5 || b.y1 > st.y1 + il * 0.4) return;
        best = j; bestGap = gap;
      });
      if (best >= 0) {
        const b = boxes[best];
        st.x1 = Math.max(st.x1, b.x1); st.y0 = Math.min(st.y0, b.y0); st.y1 = Math.max(st.y1, b.y1);
        boxes.splice(best, 1);
      }
    }
    for (const b of boxes) {
      b.w = b.x1 - b.x0 + 1; b.h = b.y1 - b.y0 + 1;
      const mid = (b.y0 + b.y1) / 2;
      let up = 0, lo = 0;
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (nb[y * w + x]) (y < mid ? up++ : lo++);
      b.lowRatio = lo / Math.max(1, up);
    }
    return boxes;
  };
  const classifyAccidental = (g) => {
    if (g.h < il * 1.6 || g.h > il * 3.6 || g.w < il * 0.35 || g.w > il * 1.4) return null;
    if (g.lowRatio > 1.4) return 'flat';
    return g.w < il * 0.82 ? 'natural' : 'sharp';
  };
  const accidentalCentre = (g, kind) => (kind === 'flat' ? g.y1 - il * 0.45 : (g.y0 + g.y1) / 2);

  // ----- noteheads -----
  const heads = [];
  for (const st of staves) {
    const cands = [];
    const xStart = Math.max(st.x0 + il * 2.8, st.headerX + il * 0.3);
    for (let k = -8; k <= 16; k++) {
      // Contiguous x positions that look like a head. A run can span a head plus
      // a touching accidental or neighbour, so take score peaks, not the middle.
      let run = [];
      const flush = () => {
        while (run.length) {
          let best = 0;
          for (let i = 1; i < run.length; i++) if (run[i].s > run[best].s) best = i;
          let a = best, b = best;
          while (a > 0 && run[a - 1].s >= run[best].s - 0.02) a--;
          while (b < run.length - 1 && run[b + 1].s >= run[best].s - 0.02) b++;
          const cx = (run[a].x + run[b].x) / 2;
          cands.push({ k, x: cx, score: run[best].s });
          run = run.filter((r) => Math.abs(r.x - cx) >= il * 0.9);
          if (run.length && run.every((r) => Math.abs(r.x - cx) < il * 1.6)) break; // leftovers are edges
        }
        run = [];
      };
      for (let x = Math.round(xStart); x <= st.x1; x++) {
        const y = posY(st, k, x);
        const fa = fill(iiF, w, h, x - il * 0.35, y - il * 0.3, x + il * 0.35, y + il * 0.3);
        const fb = fa >= 0.88 ? fill(iiF, w, h, x - il * 0.2, y - il * 0.42, x + il * 0.2, y + il * 0.42) : 0;
        if (fa >= 0.88 && fb >= 0.82) run.push({ x, s: fa + fb });
        else if (run.length) flush();
      }
      flush();
    }
    cands.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of cands) {
      if (kept.some((o) => Math.abs(o.x - c.x) < il * 0.85 && Math.abs(o.k - c.k) <= 1)) continue;
      kept.push(c);
    }
    for (const c of kept) {
      const x = c.x, y = posY(st, c.k, x);
      const hollow = fill(iiH, w, h, x - il * 0.35, y - il * 0.25, x + il * 0.35, y + il * 0.25) > 0.08;
      const up = stemSearch(x, Math.round(y), -1);
      const down = stemSearch(x, Math.round(y), 1);
      const hasUp = up.len >= il * 2.2, hasDown = down.len >= il * 2.2;
      // Head width (ignore ledger lines by measuring off-centre rows).
      let width = 0;
      for (const dy of [-0.3, 0.3]) {
        const yy = Math.round(y + dy * il);
        let a = Math.round(x), b = Math.round(x);
        while (a > x - il * 1.5 && black(a - 1, yy)) a--;
        while (b < x + il * 1.5 && black(b + 1, yy)) b++;
        width = Math.max(width, b - a + 1);
      }
      if (!hasUp && !hasDown && !(hollow && width >= il * 1.35)) continue;
      // A long vertical line straight through the middle means a barline, not a note.
      {
        const cx = Math.round(x);
        let a = Math.round(y), b = Math.round(y);
        while (a > y - il * 6 && (black(cx, a - 1) || black(cx + 1, a - 1))) a--;
        while (b < y + il * 6 && (black(cx, b + 1) || black(cx + 1, b + 1))) b++;
        if (b - a > il * 3.2) continue;
      }
      // Notes outside the staff need ledger lines.
      if (c.k < -1 || c.k > 9) {
        const lk = c.k < 0 ? (c.k % 2 === 0 ? c.k : c.k + 1) : (c.k % 2 === 0 ? c.k : c.k - 1);
        const ly = Math.round(posY(st, lk, x));
        let run = 0;
        for (let d = -2; d <= 2; d++) {
          let a = Math.round(x), b = Math.round(x);
          if (!black(a, ly + d)) continue;
          while (a > x - il * 2 && black(a - 1, ly + d)) a--;
          while (b < x + il * 2 && black(b + 1, ly + d)) b++;
          run = Math.max(run, b - a + 1);
        }
        if (run < il * 1.45) continue;
      }
      // Duration for each stem direction (a head can appear to have both when
      // two voices' heads touch; score.js decides which stem is really its own).
      let durUp = null, durDown = null;
      if (hollow) durUp = durDown = hasUp || hasDown ? 2 : 4;
      else {
        if (hasUp) durUp = 1 / Math.pow(2, countBeams(up.x, up.tip, -1, up.len));
        if (hasDown) durDown = 1 / Math.pow(2, countBeams(down.x, down.tip, 1, down.len));
      }
      // Augmentation dot to the right of the head.
      const hw = il * 0.6;
      const dotted = comps.some((cc) => {
        const cx = (cc.x0 + cc.x1) / 2, cy = (cc.y0 + cc.y1) / 2;
        return cc.w >= il * 0.22 && cc.w <= il * 0.7 && cc.h >= il * 0.22 && cc.h <= il * 0.7 &&
          cc.area >= cc.w * cc.h * 0.5 && cx > x + hw + il * 0.05 && cx < x + hw + il * 1.1 &&
          cy > y - il * 0.75 && cy < y + il * 0.75;
      });
      if (dotted) { if (durUp) durUp *= 1.5; if (durDown) durDown *= 1.5; }
      // Accidental just left of the head.
      let acc = null, accDist = 1e9;
      for (const g of symbolsIn(x - il * 2.8, x - il * 0.5, y - il * 2.5, y + il * 2.5)) {
        if (g.x1 > x - il * 0.5 || g.y0 > y || g.y1 < y) continue;
        const kind = classifyAccidental(g);
        if (!kind) continue;
        const dist = x - g.x1;
        if (dist > accDist || Math.abs(accidentalCentre(g, kind) - y) > il * 0.45) continue;
        acc = kind; accDist = dist;
      }
      heads.push({
        staff: st.index, k: c.k, x, y, hollow, dur: durUp ?? durDown, durUp, durDown, dotted, acc,
        stemUp: hasUp, stemDown: hasDown,
        stemX: hasUp ? up.x : hasDown ? down.x : null,
      });
    }
  }

  // A head between two staves (ledger lines) belongs to the nearer one.
  const distTo = (st, y) => (y < st.lines[0] ? st.lines[0] - y : y > st.lines[4] ? y - st.lines[4] : 0);
  for (let i = heads.length - 1; i >= 0; i--) {
    const hd = heads[i], own = distTo(staves[hd.staff], hd.y);
    if (own > 0 && staves.some((st) => st.index !== hd.staff && distTo(st, hd.y) < own &&
        hd.x >= st.x0 && hd.x <= st.x1)) heads.splice(i, 1);
  }

  // ----- barlines -----
  const barsOf = (st) => {
    const ya = Math.round(st.lines[0]), yb = Math.round(st.lines[4]);
    const xs = [];
    for (let x = Math.round(st.x0 + il); x <= st.x1; x++) {
      let c = 0;
      const y0 = Math.round(lineY(st, 0, x)), y1 = Math.round(lineY(st, 4, x));
      for (let y = y0; y <= y1; y++) c += nb[y * w + x] || 0;
      if (c >= (y1 - y0 + 1) * 0.95) xs.push(x);
    }
    const bars = [];
    for (const x of xs) {
      const last = bars[bars.length - 1];
      if (last && x - last.b <= il * 1.2) last.b = x;
      else bars.push({ a: x, b: x });
    }
    return bars
      .filter((b) => !heads.some((hd) => hd.staff === st.index && hd.stemX !== null && Math.abs(hd.stemX - (b.a + b.b) / 2) < il * 0.4))
      .filter((b) => {
        // reject anything with a notehead sitting on it
        const cx = (b.a + b.b) / 2;
        return !heads.some((hd) => hd.staff === st.index && Math.abs(hd.x - cx) < il * 0.6);
      })
      .map((b) => (b.a + b.b) / 2);
    void ya; void yb;
  };
  for (const st of staves) st.bars = barsOf(st);

  // ----- key signature -----
  // Accidentals right after the clef, checked against the standard order and
  // staff positions so a following time signature is not mistaken for one.
  const KEY_POS = {
    treble: { sharp: [0, 3, -1, 2, 5, 1, 4], flat: [4, 1, 5, 2, 6, 3, 7] },
    bass: { sharp: [2, 5, 1, 4, 7, 3, 6], flat: [6, 3, 7, 4, 8, 5, 9] },
  };
  for (const st of staves) {
    const first = heads.filter((hd) => hd.staff === st.index).reduce((m, hd) => Math.min(m, hd.x), st.x1);
    const syms = symbolsIn(st.headerX + il * 0.1, first - il * 0.6, st.lines[0] - il * 3, st.lines[4] + il * 3)
      .sort((a, b) => a.x0 - b.x0);
    const pos = KEY_POS[st.clef === 'bass' ? 'bass' : 'treble'];
    let kind = null, n = 0, lastX = st.headerX;
    for (const g of syms) {
      const kd = classifyAccidental(g);
      if (!kd && g.h < il * 1.2) continue; // bass-clef dots, specks
      if (!kd || kd === 'natural' || (kind && kd !== kind) || g.x0 - lastX > il * 1.8) break;
      const k = Math.round(((accidentalCentre(g, kd) - posY(st, 0, g.x0)) / st.space) * 2);
      if (n >= 7 || Math.abs(k - pos[kd][n]) > 0) break;
      kind = kd; n++; lastX = g.x1;
    }
    st.key = kind === 'flat' ? -n : n;
  }

  result.staves = staves.map((st) => ({
    index: st.index, lines: st.lines, x0: st.x0, x1: st.x1, clef: st.clef, key: st.key, bars: st.bars,
    space: st.space,
  }));
  result.systems = groups.map((g) => g.map((st) => st.index));
  result.heads = heads;
  void labels;
  return result;
}
