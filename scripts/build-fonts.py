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
        <dist-dir>/fonts/p/, and inject into each HTML's <head>:
            - `<link rel="preload" as="font">` for THIS page's own
              subsets, so fonts start downloading while <head> is being
              parsed (high priority, same-page use).
            - a `<style>` block with per-page @font-face rules.
            - `<link rel="prefetch">` for every other processed page
              this page links to via `<a href>`, so cross-page navigation
              doesn't re-download fonts (low priority, idle-time).

        Only Huiwen families actually referenced from tokens.css are
        processed. Dormant families are skipped entirely.

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
import re
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
TOKENS_CSS = ASTRO_ROOT / "src" / "styles" / "tokens.css"

# (source filename, CSS font-family, dir/file slug)
ALL_FACES = [
    ("huiwen-mincho.ttf",   "Huiwen Mincho",   "mincho"),
    ("huiwen-kaiti.ttf",    "Huiwen Kaiti",    "kaiti"),
    ("huiwen-fangsong.ttf", "Huiwen Fangsong", "fangsong"),
    ("huiwen-hkhei.ttf",    "Huiwen HKHei",    "hkhei"),
]

# System fonts to wrap as the "<Family> Fallback" face — their metrics get
# re-declared via ascent/descent/line-gap overrides so fallback and
# webfont occupy the same line box. Result: when `font-display: fallback`
# swaps in the webfont, the line heights don't jump (CLS ≈ 0). Order
# matters only for first-match-wins `src: local()` resolution.
FALLBACK_SYSTEM_FONTS = {
    "mincho":   ["Songti SC", "STSong", "SimSun"],
    "fangsong": ["FangSong", "STFangsong"],
    "kaiti":    ["Kaiti SC", "STKaiti", "KaiTi"],
    "hkhei":    ["PingFang SC", "Heiti SC", "STHeiti", "Microsoft YaHei"],
}


def _active_faces():
    """Return only the ALL_FACES entries whose family is actually
    referenced from tokens.css. Any face not named there is assumed
    dormant and fully skipped — no subsetting, no @font-face, no
    preload, nothing deployed. Re-activate by naming the family in
    tokens.css; the next build picks it up."""
    try:
        src = TOKENS_CSS.read_text(encoding="utf-8")
    except FileNotFoundError:
        return list(ALL_FACES)
    active = set(re.findall(r"'(Huiwen [^']+)'", src))
    return [f for f in ALL_FACES if f[1] in active]


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


def _metric_overrides(face_bytes: bytes):
    """Read typographic metrics from a TTF and express them as CSS
    percentage overrides. CSS ascent/descent/line-gap-override take
    non-negative percentages of the em box; OS/2 sTypoDescender is
    signed (negative), so we flip its sign."""
    f = _fresh_font(face_bytes)
    upem = f["head"].unitsPerEm
    os2 = f["OS/2"]
    asc  = f"{os2.sTypoAscender  / upem * 100:.2f}"
    desc = f"{-os2.sTypoDescender / upem * 100:.2f}"
    gap  = f"{os2.sTypoLineGap   / upem * 100:.2f}"
    return asc, desc, gap


def _fallback_face_css(slug: str, family: str, face_bytes: bytes) -> str:
    """Emit an @font-face that wraps system fonts but reports the real
    webfont's metrics. Named '<Family> Fallback' — referenced in
    tokens.css between the webfont and raw system fonts, so the
    cascade resolves to this face until the webfont arrives. When the
    webfont loads, line heights don't change because this face already
    declared matching metrics."""
    locals_ = FALLBACK_SYSTEM_FONTS.get(slug)
    if not locals_:
        return ""
    asc, desc, gap = _metric_overrides(face_bytes)
    src = ",".join(f"local('{name}')" for name in locals_)
    return (
        f"@font-face{{font-family:'{family} Fallback';"
        f"src:{src};"
        f"ascent-override:{asc}%;"
        f"descent-override:{desc}%;"
        f"line-gap-override:{gap}%}}"
    )


# ---------------------------------------------------------------------------
# `dev` subcommand
# ---------------------------------------------------------------------------

def cmd_dev():
    faces = _active_faces()
    if not faces:
        print("no active faces found in tokens.css — nothing to generate")
        return

    out_dir = ASTRO_ROOT / "public" / "fonts" / "dev"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    css_blocks = []
    for src_name, family, slug in faces:
        src = SRC_DIR / src_name
        data = src.read_bytes()
        cmap = set(_fresh_font(data).getBestCmap().keys())
        font = _fresh_font(data)
        size = _subset_and_save(font, cmap, out_dir / f"{slug}.woff2")
        print(f"  {slug:<9} {len(cmap):>5} glyphs  {_kb(size)}")
        css_blocks.append(
            f"@font-face {{\n"
            f"  font-family: '{family}';\n"
            f"  src: url('/fonts/dev/{slug}.woff2') format('woff2');\n"
            f"  font-display: fallback;\n"
            f"  font-weight: 400;\n"
            f"  font-style: normal;\n"
            f"}}"
        )
        fb = _fallback_face_css(slug, family, data)
        if fb:
            css_blocks.append(fb)

    # Regenerate public/fonts-dev.css so it matches the active face set.
    dev_css = ASTRO_ROOT / "public" / "fonts-dev.css"
    dev_css.write_text(
        "/*\n"
        " * GENERATED by scripts/build-fonts.py dev — do not edit by hand.\n"
        " *\n"
        " * Linked from BaseLayout only when import.meta.env.DEV is true.\n"
        " * In prod, per-page @font-face is injected by the font-subset\n"
        " * integration. The face list mirrors whichever Huiwen families\n"
        " * are referenced in tokens.css.\n"
        " */\n\n"
        + "\n\n".join(css_blocks)
        + "\n",
        encoding="utf-8",
    )
    print(f"  wrote {dev_css.relative_to(ASTRO_ROOT)}")


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


def _page_url(relpath: str) -> str:
    """Map a dist-relative HTML path to its served URL, matching what
    `<a href>` attributes are expected to contain."""
    if relpath == "index.html":
        return "/"
    if relpath.endswith("/index.html"):
        return "/" + relpath[:-len("index.html")]
    return "/" + relpath


class _LinkCollector(HTMLParser):
    """Collect `<a href>` values from an HTML document."""

    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.hrefs.append(v)
                    break


def _face_css(family: str, url: str) -> str:
    return (
        f"@font-face{{font-family:'{family}';"
        f"src:url('{url}') format('woff2');"
        f"font-display:fallback;"
        f"font-weight:400;font-style:normal}}"
    )


def cmd_pages(dist_dir_str: str):
    dist = Path(dist_dir_str).resolve()
    assert dist.is_dir(), f"not a directory: {dist}"
    htmls = sorted(dist.rglob("*.html"))
    print(f"scanning {len(htmls)} HTML file(s) under {dist}", flush=True)
    if not htmls:
        return

    # Load source fonts once (as bytes) and cache their cmaps. Only
    # faces actually referenced from tokens.css are processed —
    # dormant faces are skipped entirely (no subsetting, no @font-face,
    # no preload, no deploy bytes).
    faces = _active_faces()
    if not faces:
        print("no active Huiwen faces referenced in tokens.css")
        return
    face_bytes = {}
    face_cmaps = {}
    face_families = {}
    for src_name, family, slug in faces:
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

    # 1. Build common subsets, one per face. Also emit one fallback
    # @font-face per face — it has no src file (wraps local system fonts
    # with metric overrides) but logically belongs in the common pool
    # since every page references it identically via tokens.css.
    common_css = []
    common_urls = []
    for slug, family in face_families.items():
        fb = _fallback_face_css(slug, family, face_bytes[slug])
        if fb:
            common_css.append(fb)
        cps = {ord(c) for c in common} & face_cmaps[slug]
        if not cps:
            continue
        url = f"/fonts/p/common/{slug}.woff2"
        out = fonts_out / "p" / "common" / f"{slug}.woff2"
        size = _subset_and_save(_fresh_font(face_bytes[slug]), cps, out)
        print(f"  common {slug:<9} {len(cps):>5} glyphs  {_kb(size)}", flush=True)
        common_css.append(_face_css(family, url))
        common_urls.append(url)

    # 2. Build per-page subsets, inject preload + <style>, and record
    # what each page has for the later prefetch pass.
    total_page_bytes = 0
    page_info = {}  # html_path -> {"hash", "url", "slugs"}
    for h, chars in page_chars.items():
        rel = h.relative_to(dist).as_posix()
        extras = chars - common
        phash = _page_hash(rel)
        css_lines = list(common_css)
        slugs = []
        page_urls = []

        if extras:
            extras_cps = {ord(c) for c in extras}
            for slug, family in face_families.items():
                cps = extras_cps & face_cmaps[slug]
                if not cps:
                    continue
                url = f"/fonts/p/{phash}/{slug}.woff2"
                out = fonts_out / "p" / phash / f"{slug}.woff2"
                size = _subset_and_save(_fresh_font(face_bytes[slug]), cps, out)
                total_page_bytes += size
                css_lines.append(_face_css(family, url))
                slugs.append(slug)
                page_urls.append(url)

        page_info[h] = {"hash": phash, "url": _page_url(rel), "slugs": slugs}

        # Preload this page's own font files (common + extras). Browser
        # starts fetching as soon as <head> is parsed, so fonts are
        # usually already in cache by the time CSS resolves.
        preload_block = "".join(
            f'<link rel="preload" href="{u}" as="font" type="font/woff2" crossorigin>'
            for u in common_urls + page_urls
        )
        style_block = f"<style>{''.join(css_lines)}</style>"
        text = h.read_text(encoding="utf-8")
        if "</head>" in text:
            text = text.replace(
                "</head>", f"{preload_block}{style_block}</head>", 1
            )
            h.write_text(text, encoding="utf-8")
            print(
                f"  injected into {rel} "
                f"({len(css_lines)} faces, {len(common_urls) + len(page_urls)} preload)",
                flush=True,
            )
        else:
            print(f"  WARN: no </head> in {rel}", flush=True)

    print(f"per-page total across all pages: {total_page_bytes / 1024:.1f} KB", flush=True)

    # 3. Prefetch hints: for each page, find <a href> values that point
    # at another page we've processed, and emit low-priority prefetch
    # links for that page's per-page font subsets. The browser fetches
    # them during idle time so navigation feels instant.
    url_to_info = {info["url"]: info for info in page_info.values()}
    hash_to_info = {info["hash"]: info for info in page_info.values()}

    for h, info in page_info.items():
        text = h.read_text(encoding="utf-8")
        lc = _LinkCollector()
        lc.feed(text)

        targets = set()
        for href in lc.hrefs:
            hit = url_to_info.get(href)
            if hit and hit["hash"] != info["hash"]:
                targets.add(hit["hash"])
        if not targets:
            continue

        prefetch_lines = []
        for t in sorted(targets):
            for slug in hash_to_info[t]["slugs"]:
                prefetch_lines.append(
                    f'<link rel="prefetch" href="/fonts/p/{t}/{slug}.woff2" '
                    f'as="font" type="font/woff2" crossorigin>'
                )
        if not prefetch_lines:
            continue

        prefetch_block = "".join(prefetch_lines)
        if "</head>" in text:
            text = text.replace("</head>", f"{prefetch_block}</head>", 1)
            h.write_text(text, encoding="utf-8")
            rel = h.relative_to(dist).as_posix()
            print(
                f"  prefetch from {rel}: "
                f"{len(targets)} page(s), {len(prefetch_lines)} hint(s)",
                flush=True,
            )


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
