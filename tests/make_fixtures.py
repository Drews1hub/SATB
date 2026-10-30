"""Generate test hymn PDFs with LilyPond plus the expected notes as JSON.

Usage: python3 tests/make_fixtures.py   (needs lilypond, pdftoppm, ImageMagick)
Writes tests/fixtures/<name>.pdf, <name>.expected.json and a fake "scan" PDF.
"""
import json, os, random, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
STEPS = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
TOKEN = re.compile(r"([a-gr])((?:is|es)*)([',]*)(\d+)?(\.*)(~?)")


def parse(music):
    """Parse absolute-mode LilyPond tokens -> list of (onset, dur, midi)."""
    t, dur, notes, tie = 0.0, 1.0, [], False
    for tok in music.split():
        if tok == "|":
            continue
        m = TOKEN.fullmatch(tok)
        assert m, tok
        name, acc, octs, d, dots, tied = m.groups()
        if d:
            dur = 4.0 / int(d)
            for i, _ in enumerate(dots):
                dur += 4.0 / int(d) / (2 ** (i + 1))
        if name != "r":
            alter = acc.count("is") - acc.count("es")
            octave = 3 + octs.count("'") - octs.count(",")
            midi = 12 * (octave + 1) + STEPS[name] + alter
            if tie and notes and notes[-1][2] == midi:
                notes[-1] = (notes[-1][0], notes[-1][1] + dur, midi)
            else:
                notes.append((t, dur, midi))
        tie = bool(tied)
        t += dur
    return notes


PIECES = {
    # Two staves, separate stems (voiceOne/voiceTwo), lyrics between staves.
    "hymn_voices": dict(
        key=r"\key g \major", time=r"\time 4/4", partial=r"\partial 4",
        S="d''4 | g''4 g''8 a''8 b''4 a''4 | g''2 fis''4 d''4 | e''4 fis''4 g''4 a''4 | b''2. b''4 | c'''4 b''4 a''4 g''4 | fis''4. e''8 d''4 d''4 | e''4 fis''8 g''8 a''4 fis''4 | g''2.",
        A="b'4 | d''4 d''4 d''4 d''4 | b'2 d''4 d''4 | c''4 c''4 b'4 d''4 | d''2. g''4 | e''4 d''4 d''4 cis''4 | d''4. cis''8 d''4 b'4 | c''4 c''4 e''4 d''4 | d''2.",
        T="g4 | b4 b4 g4 fis4 | g2 a4 b4 | g4 a4 g4 fis4 | g2. g4 | g4 g4 fis4 e4 | a4. g8 fis4 g4 | g4 a4 a4 a4 | b2.",
        B="g4 | g4 g4 g4 d4 | e2 d4 g4 | c4 a,4 e4 d4 | g,2. e4 | c4 g,4 d4 a,4 | d4. e8 fis4 g4 | c4 a,4 d4 d4 | g,2.",
        lyrics="Prai -- ses we sing un -- to the Lord on high, sing to the King of all the earth and sky, all of the na -- tions come and join the song, glad -- ly we lift our voi -- ces all day long.",
    ),
    # Flat key, half notes, dotted halves, a ledger line or two, 3/4 time.
    "hymn_flats": dict(
        key=r"\key ees \major", time=r"\time 3/4", partial="",
        S="ees''2 f''4 | g''2 aes''4 | bes''4 aes''4 g''4 | f''2. | g''4 g''4 aes''4 | bes''2 c'''4 | bes''4 aes''4 f''4 | ees''2.",
        A="bes'2 bes'4 | ees''2 ees''4 | ees''4 ees''4 ees''4 | d''2. | ees''4 ees''4 ees''4 | ees''2 ees''4 | ees''4 c''4 d''4 | bes'2.",
        T="g2 aes4 | bes2 c'4 | bes4 c'4 bes4 | bes2. | bes4 bes4 aes4 | g2 aes4 | g4 aes4 aes4 | g2.",
        B="ees2 d4 | ees2 aes,4 | g,4 aes,4 ees4 | bes,2. | ees4 ees4 c4 | ees2 aes,4 | bes,4 bes,4 bes,4 | ees,2.",
        lyrics="",
    ),
}

LY = r"""\version "2.24.0"
\header { tagline = ##f }
\paper { indent = 0 }
global = { %(key)s %(time)s %(partial)s }
\score {
  \new ChoirStaff <<
    \new Staff <<
      \new Voice = "sop" { \voiceOne \global %(S)s \bar "|." }
      \new Voice = "alto" { \voiceTwo \global %(A)s }
    >>
    \new Lyrics \lyricsto "sop" { %(lyrics)s }
    \new Staff <<
      \clef bass
      \new Voice = "ten" { \voiceOne \global %(T)s }
      \new Voice = "bass" { \voiceTwo \global %(B)s }
    >>
  >>
  \layout { }
}
"""


def strip(m):
    return m.replace("|", "")


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, p in PIECES.items():
        src = LY % {k: (strip(v) if k in "SATB" else v) for k, v in p.items()}
        ly = os.path.join(OUT, name + ".ly")
        open(ly, "w").write(src)
        subprocess.run(["lilypond", "-s", "-o", os.path.join(OUT, name), ly], check=True)
        os.remove(ly)
        exp = {v: parse(p[v]) for v in "SATB"}
        json.dump(exp, open(os.path.join(OUT, name + ".expected.json"), "w"))
    # Fake scan: rasterise, rotate slightly, blur, add noise, save as image PDF.
    src = os.path.join(OUT, "hymn_voices.pdf")
    subprocess.run(["pdftoppm", "-r", "200", "-gray", "-png", "-singlefile", src, "/tmp/scan"], check=True)
    subprocess.run(["convert", "/tmp/scan.png", "-background", "white", "-rotate", "0.8",
                    "-blur", "0x0.8", "-attenuate", "0.3", "+noise", "Gaussian",
                    "-level", "8%,92%", "-quality", "80", "/tmp/scan.jpg"], check=True)
    subprocess.run(["convert", "/tmp/scan.jpg", "-density", "200", os.path.join(OUT, "hymn_voices_scan.pdf")], check=True)
    exp = json.load(open(os.path.join(OUT, "hymn_voices.expected.json")))
    json.dump(exp, open(os.path.join(OUT, "hymn_voices_scan.expected.json"), "w"))
    print("ok")


if __name__ == "__main__":
    main()
