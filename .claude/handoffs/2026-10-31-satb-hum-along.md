# Handoff: SATB Hum-Along

## Goal
A static web app where the user uploads four-part a cappella sheet music (PDF, photo, or MusicXML). The app reads the notes and hums soprano, alto, tenor and bass together. Hosted from this repo with GitHub Pages.

## Done
- Live at https://drews1hub.github.io/SATB/ (repo is public; Pages serves branch `claude/nifty-lamport-hep853`, folder `/`).
- Reader: `js/omr.js` (page recognition), `js/score.js` (notes into four parts), `js/pages.js` (PDF/image loading via vendor PDF.js), `js/musicxml.js` (MusicXML import).
- Player and hum synth: `js/synth.js`. Piano-roll editor: `js/roll.js`. UI: `index.html`, `style.css`, `js/app.js`.
- Tests: `tests/make_fixtures.py` (LilyPond fixtures), `tests/run.mjs` (accuracy, currently 94–100% on six layouts), `tests/debug.mjs`, `tests/multi-check.mjs`, `tests/old-browser-check.mjs`.
- Fixed: "Promise.withResolvers is not a function" on older browsers (`js/polyfills.js`, commit c318796).
- Added per-page progress in the status line (commit d312861).
- Latest commits: 9bb0856, c318796, d312861.

## Decisions
- Everything runs in the browser. Nothing is uploaded.
- Open-source OMR with an editable piano roll, rather than a paid vision API.
- GitHub Pages, no backend.
- User chose to make the repo public so Pages works.
- Model is Opus 5.5 for implementation work; commits use the Co-Authored-By line from the system reminder.

## Open
- User's file `Hymn-of-Heaven-SN_Preview.pdf` (Sibelius export, 11 pages, 906 notes) reads correctly in Chromium locally and live (about 25 s). The user reported it stuck at "Opening…" in their browser. Progress messages were added, but the root cause is unconfirmed. Next step: ask the user for their browser and what the status shows after the update. If it stops at "Reading page 1 of 11…", investigate rendering of the first page (possibly Safari-specific). Consider a time budget or a "still working" message.
- Known limits: rests, ties (re-hummed), repeats, alto clefs, triplets, piano staves. Scans are less accurate than clean exports.
- The user has not yet confirmed the two-page / multi-page fix works in their browser.

## Where things live
- Branch: `claude/nifty-lamport-hep853` (no PR was opened; user did not ask for one).
- The user's test PDF is at `/root/.claude/uploads/37a315f3-77bc-5ecb-83fc-978849a8e13e/30171507-Hymn-of-Heaven-SN_Preview.pdf` and a copy at `/tmp/hymn/hymn.pdf`. Keep it out of the repo.
- Local test server: `python3 -m http.server 8770` from the repo root. Start it again in a new chat.
- Playwright is at `tests/node_modules`-free; run tests with `createRequire` from `/home/user/SATB/tests/`.
