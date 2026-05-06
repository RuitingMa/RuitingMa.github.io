#!/usr/bin/env python3
"""
Build the stroke-data JSON consumed by StrokeSketch.

For each requested character, the output carries:
  - glyph: Huiwen Mincho's full SVG outline path, scaled to a 1024 em
    box so it shares the coord system MMH medians live in. y-up,
    baseline at 0, ascender ~900, descender ~-124.
  - medians: list of stroke medians from make-me-a-hanzi, one inner
    array per stroke (`[[x, y], ...]`). These are the centerlines —
    StrokeSketch uses them to clip the Huiwen glyph into per-stroke
    bitmaps at runtime.

We keep only what the sketch consumes — no stroke outline polygons
(the Huiwen path replaces them visually) and no per-stroke rendering
metadata (bbox, etc., are computed in JS).

Usage:
    python scripts/build-strokes.py            # PROTOTYPE_CHARS
    python scripts/build-strokes.py 字的颗粒度  # explicit set
"""
import json
import sys
from pathlib import Path
from typing import Optional

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MMH_SRC = ROOT / "data" / "makemeahanzi" / "graphics.txt"
FONT_SRC = ROOT / "src" / "assets" / "fonts" / "huiwen-mincho.ttf"
OUT = ROOT / "public" / "data" / "strokes.json"

# Title + a representative flood-cue phrase. Picked for stroke-count
# variety so the sketch reads as a mix of light/dense glyphs.
PROTOTYPE_CHARS = "字的颗粒度这一段汉横跨整片海"

# MMH medians live in a 1024-wide em box. We scale Huiwen to match so
# the two data sources align without further per-char tweaks.
TARGET_UPEM = 1024


def extract_glyph_path(font: TTFont, char: str) -> Optional[str]:
    """Huiwen glyph as an SVG path string in the target 1024 em space.
    The font's own units-per-em can be anything (Huiwen Mincho is 1000);
    the TransformPen rescales as the path streams through. Returns None
    if the char isn't covered by the font's cmap."""
    cmap = font.getBestCmap()
    cp = ord(char)
    if cp not in cmap:
        return None
    glyph_set = font.getGlyphSet()
    glyph = glyph_set[cmap[cp]]

    upem = font["head"].unitsPerEm
    s = TARGET_UPEM / upem

    pen = SVGPathPen(glyph_set)
    glyph.draw(TransformPen(pen, Transform().scale(s, s)))
    return pen.getCommands()


def main():
    chars = sys.argv[1] if len(sys.argv) > 1 else PROTOTYPE_CHARS
    wanted = set(chars)
    print(f"extracting {len(wanted)} char(s): {''.join(sorted(wanted))}")

    if not MMH_SRC.exists():
        sys.exit(
            f"missing {MMH_SRC}\n"
            "  run: curl -sL -o data/makemeahanzi/graphics.txt "
            "https://raw.githubusercontent.com/skishore/makemeahanzi/master/graphics.txt"
        )
    if not FONT_SRC.exists():
        sys.exit(f"missing {FONT_SRC}")

    font = TTFont(str(FONT_SRC))
    print(f"  font unitsPerEm = {font['head'].unitsPerEm} → normalize to {TARGET_UPEM}")

    # MMH file is line-delimited JSON. We only need medians.
    mmh = {}
    with MMH_SRC.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            entry = json.loads(line)
            ch = entry.get("character")
            if ch in wanted:
                mmh[ch] = entry["medians"]
                if len(mmh) == len(wanted):
                    break

    out = {}
    missing = []
    for ch in wanted:
        path = extract_glyph_path(font, ch)
        medians = mmh.get(ch)
        if path is None:
            missing.append(f"{ch} (no Huiwen glyph)")
            continue
        if medians is None:
            missing.append(f"{ch} (no MMH medians)")
            continue
        out[ch] = {"glyph": path, "medians": medians}

    if missing:
        print(f"  WARNING: dropped {missing}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = OUT.stat().st_size / 1024
    total_strokes = sum(len(v["medians"]) for v in out.values())
    print(
        f"wrote {OUT.relative_to(ROOT)}: "
        f"{len(out)} char(s), {total_strokes} stroke(s), {size_kb:.1f} KB"
    )


if __name__ == "__main__":
    main()
