#!/usr/bin/env python3
"""
make_demo_cast.py — Render the `prism demo` session as an animated SVG.

A real terminal recording would mean a GIF: megabytes, blurry text, and a
binary blob nobody can diff. This draws the same session as CSS-animated SVG
instead — a few KB, crisp at any zoom, and reviewable as plain text.

The transcript below is copied verbatim from an actual `prism demo` run.

Usage: python3 docs/assets/make_demo_cast.py  ->  docs/assets/demo.svg
"""
import pathlib

# (delay_seconds, [(text, style), ...]) — delay is when the line appears.
# A line with no segments is a blank line and needs no delay.
CAST: list[tuple[float, list[tuple[str, str]]]] = [
    (0.4, [("$ ", "prompt"), ("pip install prism-insights", "cmd")]),
    (1.1, [("Successfully installed prism-insights-0.3.0", "dim")]),
    (0, []),
    (1.9, [("$ ", "prompt"), ("prism demo", "cmd")]),
    (0, []),
    (2.6, [("Prism demo · bundled anonymized data", "dim")]),
    (0, []),
    (3.0, [("① Collect-rate ranking (save/like — Prism's core signal):", "head")]),
    (3.3, [("    2.38", "hi"), ("  save   1520 / like    640   ", "out"),
           ("Every visa document I needed, in order", "title")]),
    (3.5, [("    1.82", "hi"), ("  save   1655 / like    910   ", "out"),
           ("Reading a rental contract line by line", "title")]),
    (3.7, [("    1.82", "hi"), ("  save   1490 / like    820   ", "out"),
           ("How to pick a rice cooker without overpaying", "title")]),
    (3.9, [("     1.6", "hi"), ("  save   1980 / like   1240   ", "out"),
           ("12 museums in the city that are free on Sunda…", "title")]),
    (4.1, [("    1.24", "hi"), ("  save   2610 / like   2100   ", "out"),
           ("Beginner sourdough: the whole schedule on one…", "title")]),
    (0, []),
    (4.5, [("② By content type (avg saves):", "head")]),
    (4.7, [("   image    n=9    avg_save=", "out"), ("1748", "hi")]),
    (4.85, [("   video    n=11   avg_save=", "out"), ("693", "dim")]),
    (0, []),
    (5.2, [("③ Save distribution: n=20 median=940 p90=1980 max=2610", "out")]),
    (5.4, [("④ Save concentration: HHI=657 top3-share=0.284", "out")]),
    (0, []),
    (5.9, [("✓", "hi"), (" offline demo data. Live: ", "dim"),
           ("prism analyze bilibili --limit 15", "cmd")]),
]

TOTAL = 11.0          # loop length, seconds
FADE_OUT_AT = 0.955   # fraction of the loop where everything clears

CH = 7.83             # advance width of 13px SF Mono / Menlo
LINE_H = 21
PAD_X = 22
TITLE_BAR = 34
TOP_PAD = 14

COLORS = {
    "prompt": "#4ADE80",
    "cmd": "#FFFFFF",
    "out": "#C9D4E3",
    "title": "#E6EDF3",
    "head": "#7DD3FC",
    "hi": "#4ADE80",
    "dim": "#7C8899",
}


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build() -> str:
    width = 782
    height = TITLE_BAR + TOP_PAD + len(CAST) * LINE_H + TOP_PAD

    keyframes, body = [], []
    for idx, (delay, segs) in enumerate(CAST):
        if not segs:
            continue
        start = delay / TOTAL
        name = f"l{idx}"
        # Hold at 0 until `start`, snap on, hold, then clear before the loop restarts.
        keyframes.append(
            f"@keyframes {name}{{0%,{start * 100:.2f}%{{opacity:0}}"
            f"{start * 100 + 0.35:.2f}%,{FADE_OUT_AT * 100:.1f}%{{opacity:1}}"
            f"100%{{opacity:0}}}}"
        )

        y = TITLE_BAR + TOP_PAD + idx * LINE_H + 14
        spans, col = [], 0
        for text, style in segs:
            x = PAD_X + col * CH
            spans.append(f'<tspan x="{x:.1f}" fill="{COLORS[style]}">{esc(text)}</tspan>')
            col += len(text)
        # xml:space="preserve" is load-bearing: without it SVG collapses runs of
        # spaces and the column alignment that makes it read like a terminal is gone.
        body.append(f'<text y="{y}" class="ln" xml:space="preserve" '
                    f'style="animation-name:{name}">' + "".join(spans) + "</text>")

    # Blinking cursor, parked after the last command until output starts.
    cur_x = PAD_X + len("$ prism demo") * CH + 1

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"
     viewBox="0 0 {width} {height}" font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace">
  <style>
    .ln {{ font-size: 13px; opacity: 0; font-variant-ligatures: none;
           animation-duration: {TOTAL}s; animation-iteration-count: infinite;
           animation-timing-function: steps(1, end); }}
    {" ".join(keyframes)}
    @keyframes blink {{ 0%,44%{{opacity:0}} 45%,49%{{opacity:.85}} 50%,54%{{opacity:0}}
                        55%,59%{{opacity:.85}} 60%,100%{{opacity:0}} }}
    .cur {{ animation: blink {TOTAL}s infinite; }}
  </style>

  <rect width="{width}" height="{height}" rx="10" fill="#0D1117"/>
  <rect width="{width}" height="{TITLE_BAR}" rx="10" fill="#161B22"/>
  <rect y="{TITLE_BAR - 10}" width="{width}" height="10" fill="#161B22"/>
  <line x1="0" y1="{TITLE_BAR}" x2="{width}" y2="{TITLE_BAR}" stroke="#FFFFFF" stroke-opacity="0.07"/>
  <rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="10"
        fill="none" stroke="#FFFFFF" stroke-opacity="0.09"/>

  <circle cx="20" cy="{TITLE_BAR // 2}" r="6" fill="#FF5F57"/>
  <circle cx="40" cy="{TITLE_BAR // 2}" r="6" fill="#FEBC2E"/>
  <circle cx="60" cy="{TITLE_BAR // 2}" r="6" fill="#28C840"/>
  <text x="{width // 2}" y="{TITLE_BAR // 2 + 4}" font-size="12" fill="#7C8899"
        text-anchor="middle">prism — demo</text>

  {chr(10).join("  " + b for b in body)}

  <rect class="cur" x="{cur_x:.1f}" y="{TITLE_BAR + TOP_PAD + 3 * LINE_H + 3}"
        width="7.5" height="15" fill="#C9D4E3"/>
</svg>
'''


if __name__ == "__main__":
    out = pathlib.Path(__file__).with_name("demo.svg")
    out.write_text(build(), encoding="utf-8")
    print(f"✓ {out}  ({out.stat().st_size / 1024:.1f} KB)")
