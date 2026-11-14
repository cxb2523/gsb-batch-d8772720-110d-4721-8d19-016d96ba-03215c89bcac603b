"""Check that the real app and the static web demo never mix.

Usage: uv run python scripts/check_web_builds.py [static_dir] [pages_dir]
       (defaults: src/mecha/static and web/dist-pages)

* The real build (what ``mecha serve`` ships) must contain **no** web demo code or data:
  otherwise the dashboard could show made-up credentials as if they were yours.
* The web demo build must contain **no** client for ``/api`` (session token, event
  stream), must declare its CSP in a <meta> tag with ``connect-src 'none'``, and must not
  inline assets as ``data:`` URIs (its CSP only allows its own files).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "src" / "demo" / "data.json"

# Strings that only exist in the in-memory API, the client, or the dumped data.
DEMO_CODE_MARKERS = ("not_available_in_demo", "sample:", "static-demo")
CLIENT_MARKERS = ("Bearer ", "text/event-stream", "/api/events", "/api${")


def demo_data_markers() -> list[str]:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    labels = {item["credential"]["label"] for item in data["listing"]["credentials"]}
    labels |= {sample["label"] for sample in data["samples"]}
    return sorted(labels)


def bundle(directory: Path) -> str:
    files = sorted((directory / "assets").glob("*.js"))
    if not files:
        raise SystemExit(f"error: no built scripts in {directory}/assets (build it first)")
    return "\n".join(f.read_text(encoding="utf-8") for f in files)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    static = Path(args[0]) if args else ROOT / "src" / "mecha" / "static"
    pages = Path(args[1]) if len(args) > 1 else ROOT / "web" / "dist-pages"
    problems: list[str] = []

    real = bundle(static)
    for marker in (*DEMO_CODE_MARKERS, *demo_data_markers()):
        if marker in real:
            problems.append(f"the real build ({static}) contains web demo code or data: {marker!r}")
    if "Bearer " not in real:
        problems.append(f"the real build ({static}) has no API client: is it the right build?")

    demo = bundle(pages)
    for marker in CLIENT_MARKERS:
        if marker in demo:
            problems.append(f"the web demo build ({pages}) contains the /api client: {marker!r}")
    if "not_available_in_demo" not in demo:
        problems.append(
            f"the web demo build ({pages}) has no in-memory API: is it the right build?"
        )

    html = (pages / "index.html").read_text(encoding="utf-8")
    csp = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', html)
    if not csp:
        problems.append("the web demo has no CSP <meta> tag")
    else:
        directives = {d.split()[0]: d.split()[1:] for d in csp.group(1).split("; ")}
        if directives.get("connect-src") != ["'none'"]:
            problems.append(f"the web demo CSP must have connect-src 'none': {csp.group(1)}")
        if "'unsafe-inline'" in directives.get("script-src", []):
            problems.append("the web demo CSP must not allow inline scripts")
        head = html.split("<head>", 1)[1]
        if head.find("Content-Security-Policy") > head.find("<script"):
            problems.append("the CSP <meta> tag must come before any script")
    for asset in (pages / "assets").iterdir():
        if asset.suffix in {".css", ".js"} and "url(data:" in asset.read_text(encoding="utf-8"):
            problems.append(f"{asset.name} inlines a data: URI, which the web demo CSP blocks")

    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"ok: {static} has no web demo code; {pages} has no /api client and a strict CSP")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
