// Load a PDF or image file into page canvases sized for recognition.
import './polyfills.js';
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { imageDataToGray, estimateStaffSpace } from './omr.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const MAX_SIDE = 3400;
const MAX_RERENDER_SIDE = 5200;
const TARGET_SPACE = 16; // staff-space size in pixels that recognition works best at

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  return c;
}

/** Yields { canvas, gray } for each page. `scale` 2.8 ≈ 200 dpi. */
export async function* loadPages(file, scale = 2.8, onProgress = () => {}) {
  const buf = await file.arrayBuffer();
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress(n, pdf.numPages);
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const s = Math.min(scale, MAX_SIDE / Math.max(base.width, base.height));
      let out = await renderPdfPage(page, s);
      // Scanned pages can be tiny or huge; re-render so staff spaces are a useful size.
      const space = estimateStaffSpace(out.gray);
      if (space > 3 && (space < 12 || space > 30)) {
        const s2 = Math.min(s * (TARGET_SPACE / space), MAX_RERENDER_SIDE / Math.max(base.width, base.height));
        if (Math.abs(s2 - s) / s > 0.15) out = await renderPdfPage(page, s2);
      }
      yield out;
    }
  } else {
    const bmp = await createImageBitmap(new Blob([buf], { type: file.type }));
    const draw = (s) => {
      const canvas = canvasOf(Math.round(bmp.width * s), Math.round(bmp.height * s));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return finish(canvas);
    };
    let s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    let out = draw(s);
    const space = estimateStaffSpace(out.gray);
    if (space > 3 && (space < 12 || space > 30)) {
      const s2 = Math.min(s * (TARGET_SPACE / space), MAX_RERENDER_SIDE / Math.max(bmp.width, bmp.height));
      if (Math.abs(s2 - s) / s > 0.15) out = draw(s2);
    }
    yield out;
  }
}

async function renderPdfPage(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = canvasOf(Math.floor(vp.width), Math.floor(vp.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: 'white' }).promise;
  return finish(canvas);
}

function finish(canvas) {
  const ctx = canvas.getContext('2d');
  const gray = imageDataToGray(ctx.getImageData(0, 0, canvas.width, canvas.height));
  return { canvas, gray };
}
