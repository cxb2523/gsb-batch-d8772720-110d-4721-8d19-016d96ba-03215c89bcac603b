"""Turn the video Playwright recorded (``just gif``) into ``docs/demo.gif`` with ffmpeg.

Usage: uv run python scripts/make_gif.py <dir with the recorded .webm> <out.gif>

Two passes (palettegen + paletteuse) keep the GIF small and sharp. Fails if the result is
over MAX_BYTES, so the README stays light (it is also shown on PyPI).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

FPS = 8
WIDTH = 800
COLOURS = 128
MAX_BYTES = 4 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: make_gif.py <video dir> <out.gif>", file=sys.stderr)
        return 2
    videos = sorted(Path(sys.argv[1]).rglob("*.webm"), key=lambda p: p.stat().st_mtime)
    ffmpeg = shutil.which("ffmpeg")
    if not videos or ffmpeg is None:
        print("error: need a recorded .webm and ffmpeg on PATH", file=sys.stderr)
        return 2
    video, out = videos[-1], Path(sys.argv[2])
    scale = f"fps={FPS},scale={WIDTH}:-1:flags=lanczos"
    with tempfile.TemporaryDirectory() as tmp:
        palette = Path(tmp) / "palette.png"
        run = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
        subprocess.run(  # noqa: S603 - fixed arguments
            [
                *run,
                "-i",
                str(video),
                "-vf",
                f"{scale},palettegen=stats_mode=diff:max_colors={COLOURS}",
                str(palette),
            ],
            check=True,
        )
        subprocess.run(  # noqa: S603
            [
                *run,
                "-i",
                str(video),
                "-i",
                str(palette),
                "-lavfi",
                f"{scale}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle",
                "-loop",
                "0",
                str(out),
            ],
            check=True,
        )
    size = out.stat().st_size
    print(f"wrote {out} ({size / 1024 / 1024:.2f} MB) from {video.name}")
    if size > MAX_BYTES:
        print(f"error: {out} is over {MAX_BYTES // 1024 // 1024} MB", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
