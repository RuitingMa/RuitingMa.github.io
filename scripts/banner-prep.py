#!/usr/bin/env python3
"""
Prepare banner video clips for CineBanner component.

Directory convention:
    public/banner/raw/<group>/*.mp4   ← source videos (gitignored)
    public/banner/<group>/*.mp4       ← processed output (tracked)

Usage:
    python scripts/banner-prep.py                        # process all groups
    python scripts/banner-prep.py lobby                  # one group only
    python scripts/banner-prep.py lobby/lamp.mp4         # one file only

Pipeline per clip:
  1. Grab --take seconds (default 10) starting at --start
  2. Center-crop to panoramic strip (--ratio, default 6:1)
  3. Scale to --max-width (default 1280)
  4. Slow to --target seconds (default 30)
  5. Encode H.264 30fps, no audio, CRF 28, faststart
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

RAW_ROOT = Path("public/banner/raw")
OUT_ROOT = Path("public/banner")


def probe(path: Path) -> dict:
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True,
    )
    data = json.loads(r.stdout)
    for s in data.get("streams", []):
        if s["codec_type"] == "video":
            num, den = map(int, s["r_frame_rate"].split("/"))
            return {
                "width": int(s["width"]),
                "height": int(s["height"]),
                "duration": float(data["format"]["duration"]),
                "fps": num / den if den else 30,
            }
    raise ValueError(f"no video stream in {path}")


def even(n: int) -> int:
    return n - n % 2


def process(src: Path, out_dir: Path, *, start: float, take: float,
            target: float, ratio: float, fade: float, crop_y: str,
            crf: int, max_width: int):
    info = probe(src)
    w, h, dur = info["width"], info["height"], info["duration"]

    available = max(0, dur - start)
    actual_take = min(available, take) if available > 0 else dur
    slow = target / actual_take

    crop_h = even(int(w / ratio))
    if crop_y == "center":
        y_expr = f"(ih-{crop_h})/2"
    elif crop_y == "top":
        y_expr = "0"
    elif crop_y == "bottom":
        y_expr = f"ih-{crop_h}"
    else:
        y_expr = crop_y

    filters = [f"crop={w}:{crop_h}:0:{y_expr}"]

    if w > max_width:
        out_h = even(int(max_width / ratio))
        filters.append(f"scale={max_width}:{out_h}")

    filters.append(f"setpts={slow:.4f}*PTS")

    if fade > 0:
        fade_start = target - fade
        filters.append(f"fade=t=out:st={fade_start:.2f}:d={fade:.2f}")

    vf = ",".join(filters)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{src.stem}.mp4"

    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-t", str(actual_take),
        "-i", str(src),
        "-vf", vf,
        "-an",
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-r", "30",
        str(out_path),
    ]

    print(f"\n{'=' * 50}")
    print(f"  src:    {src.name}  ({w}x{h}, {dur:.1f}s)")
    print(f"  crop:   {w}x{crop_h}  (ratio {ratio}:1, y={crop_y})")
    print(f"  speed:  {actual_take:.1f}s -> {target:.1f}s  ({slow:.2f}x slow)")
    print(f"  out:    {out_path}")
    print(f"{'=' * 50}")

    subprocess.run(cmd, check=True)

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"  done:   {size_mb:.2f} MB")
    return out_path


def collect(target: str | None) -> list[tuple[Path, Path]]:
    """Return [(source_mp4, output_dir), ...] pairs."""
    if target is None:
        groups = sorted(d for d in RAW_ROOT.iterdir() if d.is_dir())
        if not groups:
            print(f"no subdirectories in {RAW_ROOT}/", file=sys.stderr)
            sys.exit(1)
        pairs = []
        for g in groups:
            out = OUT_ROOT / g.name
            for f in sorted(g.glob("*.mp4")):
                pairs.append((f, out))
        return pairs

    path = RAW_ROOT / target
    if path.is_file():
        return [(path, OUT_ROOT / path.parent.name)]
    if path.is_dir():
        files = sorted(path.glob("*.mp4"))
        if not files:
            print(f"no MP4 files in {path}/", file=sys.stderr)
            sys.exit(1)
        return [(f, OUT_ROOT / path.name) for f in files]

    print(f"not found: {path}", file=sys.stderr)
    sys.exit(1)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("target", nargs="?", default=None,
                   help="group name or group/file.mp4 (default: all groups)")
    p.add_argument("--start", type=float, default=0,
                   help="start offset in seconds (default: 0)")
    p.add_argument("--take", type=float, default=10,
                   help="seconds to grab (default: 10)")
    p.add_argument("--target", type=float, default=30, dest="target_dur",
                   help="output duration in seconds (default: 30)")
    p.add_argument("--ratio", type=float, default=6,
                   help="crop aspect ratio W:1 (default: 6)")
    p.add_argument("--fade", type=float, default=0,
                   help="baked-in fade-out seconds (default: 0)")
    p.add_argument("--crop-y", default="center",
                   help="vertical crop: center / top / bottom")
    p.add_argument("--crf", type=int, default=28,
                   help="H.264 quality 0-51 (default: 28)")
    p.add_argument("--max-width", type=int, default=1280,
                   help="max output width in px (default: 1280)")
    args = p.parse_args()

    pairs = collect(args.target)

    opts = dict(start=args.start, take=args.take, target=args.target_dur,
                ratio=args.ratio, fade=args.fade, crop_y=args.crop_y,
                crf=args.crf, max_width=args.max_width)

    for src, out_dir in pairs:
        process(src, out_dir, **opts)

    groups = {d for _, d in pairs}
    print(f"\ndone: {len(pairs)} clip(s) in {len(groups)} group(s)")


if __name__ == "__main__":
    main()
