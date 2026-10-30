# SATB Hum-Along

Upload a PDF (or a photo) of four-part a cappella music and hear the soprano,
alto, tenor and bass parts hummed together, so you can hear how your part
fits with the others.

It's a static website: everything, including reading the sheet music, runs
in your browser. Nothing is uploaded to a server.

## Using it

1. Open the site and choose a file, or drag one onto the page:
   - **PDF**: works best with clean PDFs exported from MuseScore, Finale,
     Sibelius or Dorico. Scanned PDFs work too, but expect a few mistakes.
   - **Photo or image** (JPG/PNG) of a page: hold the camera flat and straight
     over the page, in good light.
   - **MusicXML** (`.musicxml`, `.xml`, `.mxl`): read exactly with no guessing.
     If you have the notation file, export MusicXML from it.
2. Press **Play**. Use the checkboxes and sliders to mute or balance parts,
   and the tempo slider to slow down.
3. If a note sounds wrong, fix it:
   - **Check against the sheet** shows your page with a coloured dot on every
     note the reader found. A missing dot or a wrong colour shows where it went
     wrong. Click a dot to jump to that note in the editor.
   - In the **Notes** editor, click a note, then use <kbd>↑</kbd>/<kbd>↓</kbd>
     for pitch, <kbd>+</kbd>/<kbd>−</kbd> for length, <kbd>Delete</kbd> to remove.
     Double-click to add a note. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.
   - **Reading settings**: if the whole piece sounds off (wrong key signature,
     wrong clef, parts swapped), correct it there and re-read.

## What it can read

- Hymn-style layout: soprano and alto on the top staff, tenor and bass on the
  bottom, with either separate stems for each part or shared stems (chords).
- Open score with one staff per part (including the tenor's treble clef with
  an "8" below it).
- Treble and bass clefs, key signatures, sharps/flats/naturals, whole, half,
  quarter, eighth and sixteenth notes, dotted notes, and ledger lines.

Not yet supported: rests (a resting part is just silent, which is usually
fine), ties (tied notes are re-sung), repeats and first/second endings, alto or
other C clefs, triplets, and piano accompaniment staves.

## Turning on the website (GitHub Pages)

The site is plain HTML/JS, so GitHub Pages can host it straight from this repo:

1. On GitHub, open the repo's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose the branch with this code (for example `main`) and the **/ (root)**
   folder, then **Save**.
4. After a minute the page shows the site's address, usually
   `https://<your-username>.github.io/SATB/`.

To try it locally instead, serve the folder with any static web server, for
example `python3 -m http.server`, then open http://localhost:8000. Opening
`index.html` straight from disk won't work, because browsers block JavaScript
modules on `file://` pages.

## How it works

- `js/pages.js` renders PDF pages with [PDF.js](https://mozilla.github.io/pdf.js/)
  (included in `vendor/pdfjs`), or loads an image, at a size suited to reading.
- `js/omr.js` is the music reader. It straightens the page, finds staff lines,
  removes them, then finds noteheads, stems, beams, flags, dots, accidentals,
  clefs, key signatures and barlines.
- `js/score.js` turns those symbols into four timed parts. When the parts in a
  bar don't add up to the same length, it lines notes up by their horizontal
  position, so one misread rhythm doesn't throw the other parts off.
- `js/musicxml.js` imports MusicXML. `js/synth.js` is the hum synthesizer and
  player (Web Audio). `js/roll.js` is the note editor.

## Tests

The reader is checked against hymns engraved with LilyPond, plus a fake
"scan" (rotated, blurred, noisy) of one of them:

```bash
python3 tests/make_fixtures.py   # needs lilypond, poppler-utils, imagemagick
node tests/run.mjs               # needs Playwright + Chromium
```

`node tests/debug.mjs <fixture>` saves an annotated picture of what the reader
saw to `/tmp/debug.png`.
