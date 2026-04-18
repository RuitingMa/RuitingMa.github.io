#!/usr/bin/env python3
"""
Font pipeline — Level 4 (per-page subsetting with shared common pool).

Two subcommands:

    dev
        Generate a single compact WOFF2 for every face into
        public/fonts/dev/. These are referenced by public/fonts-dev.css
        and used only during `astro dev`. Run once after cloning, and
        again whenever the source TTFs change.

    pages <dist-dir>
        Scan every .html under <dist-dir>, collect the set of characters
        used on each page, split into a common pool (chars used on >=2
        pages) and per-page extras, emit subset WOFF2 files under
        <dist-dir>/fonts/p/, and inject a <style> block with per-page
        @font-face declarations into each HTML's <head>.

Char-pool declarations (for procedurally-generated text):
    Any HTML element may carry `data-font-pool="<chars>"`. Every character
    inside that attribute value is added to the page's font subset, even
    if the character never appears as visible text. Use this for sketches
    that draw glyphs into canvas at runtime (canvas `fillText` only finds
    glyphs that were in the loaded subset). The attribute is read but not
    otherwise acted on — it's a one-way hint to this build step.

    Example:
        <div class="sketch" data-font-pool="眠海潮汐一二三四五六七八九十">

Dependencies: fonttools, brotli  (pip install fonttools brotli)
"""
import hashlib
import io
import shutil
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

HERE = Path(__file__).resolve().parent
ASTRO_ROOT = HERE.parent
SRC_DIR = ASTRO_ROOT / "src" / "assets" / "fonts"

# (source filename, CSS font-family, dir/file slug)
FACES = [
    ("huiwen-mincho.ttf",   "Huiwen Mincho",   "mincho"),
    ("huiwen-kaiti.ttf",    "Huiwen Kaiti",    "kaiti"),
    ("huiwen-fangsong.ttf", "Huiwen Fangsong", "fangsong"),
    ("huiwen-hkhei.ttf",    "Huiwen HKHei",    "hkhei"),
]


def _subsetter_options():
    opts = Options()
    opts.flavor = "woff2"
    opts.hinting = False
    opts.layout_features = []
    opts.glyph_names = False
    opts.legacy_cmap = False
    opts.symbol_cmap = False
    opts.name_IDs = ["*"]          # preserve license string
    opts.drop_tables += [
        "DSIG", "GDEF", "GPOS", "GSUB", "BASE", "JSTF",
        "MATH", "VORG", "kern",
    ]
    return opts


def _fresh_font(face_bytes: bytes) -> TTFont:
    """Parse a new TTFont from cached bytes. Subsetter mutates the object,
    so each subset operation needs its own instance."""
    return TTFont(io.BytesIO(face_bytes))


def _subset_and_save(font: TTFont, unicodes, out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sub = Subsetter(options=_subsetter_options())
    sub.populate(unicodes=list(unicodes))
    sub.subset(font)
    font.flavor = "woff2"
    font.save(out_path)
    return out_path.stat().st_size


def _kb(n: int) -> str:
    return f"{n / 1024:>7.1f} KB"


# ---------------------------------------------------------------------------
# `dev` subcommand
# ---------------------------------------------------------------------------

def cmd_dev():
    out_dir = ASTRO_ROOT / "public" / "fonts" / "dev"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    for src_name, family, slug in FACES:
        src = SRC_DIR / src_name
        data = src.read_bytes()
        cmap = set(_fresh_font(data).getBestCmap().keys())
        font = _fresh_font(data)
        size = _subset_and_save(font, cmap, out_dir / f"{slug}.woff2")
        print(f"  {slug:<9} {len(cmap):>5} glyphs  {_kb(size)}")


# ---------------------------------------------------------------------------
# `pages` subcommand
# ---------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    """Collect visible text from an HTML document (skipping <script> /
    <style> content), plus any declared `data-font-pool` attribute
    values (chars declared by sketches that procedurally render text
    but don't include it in static markup)."""

    def __init__(self):
        super().__init__()
        self._chunks = []
        self._pool_chunks = []
        self._skip_depth = 0

    def _harvest_pool(self, attrs):
        for k, v in attrs:
            if k == "data-font-pool" and v:
                self._pool_chunks.append(v)

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip_depth += 1
        self._harvest_pool(attrs)

    def handle_startendtag(self, tag, attrs):
        self._harvest_pool(attrs)

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._chunks.append(data)

    def text(self):
        return "".join(self._chunks)

    def pool(self):
        return "".join(self._pool_chunks)


def _chars_from_html(html_str: str) -> set:
    """Visible text + declared font-pool, unioned. Any character with
    codepoint >= 0x20."""
    ex = _TextExtractor()
    ex.feed(html_str)
    return {c for c in ex.text() + ex.pool() if ord(c) >= 0x20}


def _page_hash(relpath: str) -> str:
    return hashlib.md5(relpath.encode()).hexdigest()[:10]


def _face_css(family: str, url: str) -> str:
    return (
        f"@font-face{{font-family:'{family}';"
        f"src:url('{url}') format('woff2');"
        f"font-display:optional;"
        f"font-weight:400;font-style:normal}}"
    )


def cmd_pages(dist_dir_str: str):
    dist = Path(dist_dir_str).resolve()
    assert dist.is_dir(), f"not a directory: {dist}"
    htmls = sorted(dist.rglob("*.html"))
    print(f"scanning {len(htmls)} HTML file(s) under {dist}", flush=True)
    if not htmls:
        return

    # Load source fonts once (as bytes) and cache their cmaps.
    face_bytes = {}
    face_cmaps = {}
    face_families = {}
    for src_name, family, slug in FACES:
        src = SRC_DIR / src_name
        data = src.read_bytes()
        face_bytes[slug] = data
        face_cmaps[slug] = set(_fresh_font(data).getBestCmap().keys())
        face_families[slug] = family

    # Collect chars per page.
    page_chars = {}
    for h in htmls:
        text = h.read_text(encoding="utf-8", errors="replace")
        chars = _chars_from_html(text)
        page_chars[h] = chars
        rel = h.relative_to(dist).as_posix()
        print(f"  {rel}: {len(chars)} chars", flush=True)

    # Common pool: chars used on >=2 pages. For a single-page site, this
    # stays empty and everything lives in per-page extras.
    counts = Counter()
    for chars in page_chars.values():
        for c in chars:
            counts[c] += 1
    common = {c for c, n in counts.items() if n >= 2}
    print(f"common pool: {len(common)} chars", flush=True)

    # Wipe old font output (both dev fallback and previous per-page runs
    # under dist/fonts/). dist/fonts/dev/ from the copy of public/ is
    # redundant in prod — the integration uses per-page faces instead.
    fonts_out = dist / "fonts"
    if fonts_out.exists():
        shutil.rmtree(fonts_out)

    # 1. Build common subsets, one per face.
    common_css = []
    for slug, family in face_families.items():
        cps = {ord(c) for c in common} & face_cmaps[slug]
        if not cps:
            continue
        out = fonts_out / "p" / "common" / f"{slug}.woff2"
        size = _subset_and_save(_fresh_font(face_bytes[slug]), cps, out)
        print(f"  common {slug:<9} {len(cps):>5} glyphs  {_kb(size)}", flush=True)
        common_css.append(_face_css(family, f"/fonts/p/common/{slug}.woff2"))

    # 2. Build per-page subsets and inject <style> into each HTML.
    total_page_bytes = 0
    for h, chars in page_chars.items():
        rel = h.relative_to(dist).as_posix()
        extras = chars - common
        phash = _page_hash(rel)
        css_lines = list(common_css)

        if extras:
            extras_cps = {ord(c) for c in extras}
            for slug, family in face_families.items():
                cps = extras_cps & face_cmaps[slug]
                if not cps:
                    continue
                out = fonts_out / "p" / phash / f"{slug}.woff2"
                size = _subset_and_save(_fresh_font(face_bytes[slug]), cps, out)
                total_page_bytes += size
                css_lines.append(
                    _face_css(family, f"/fonts/p/{phash}/{slug}.woff2")
                )

        style_block = f"<style>{''.join(css_lines)}</style>"
        text = h.read_text(encoding="utf-8")
        if "</head>" in text:
            text = text.replace("</head>", f"{style_block}</head>", 1)
            h.write_text(text, encoding="utf-8")
            print(f"  injected into {rel} ({len(css_lines)} faces)", flush=True)
        else:
            print(f"  WARN: no </head> in {rel}", flush=True)

    print(f"per-page total across all pages: {total_page_bytes / 1024:.1f} KB", flush=True)


# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "dev":
        cmd_dev()
    elif cmd == "pages":
        if len(sys.argv) < 3:
            print("error: `pages` needs a dist directory argument", file=sys.stderr)
            sys.exit(2)
        cmd_pages(sys.argv[2])
    else:
        print(f"error: unknown subcommand: {cmd!r}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
