"""Fail unless the release tag matches the version in pyproject.toml.

Usage: python scripts/check_version.py v0.1.0   (or refs/tags/v0.1.0)
"""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_version.py <tag>", file=sys.stderr)
        return 2
    tag = sys.argv[1].removeprefix("refs/tags/")
    root = Path(__file__).resolve().parent.parent
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "version"
    ]
    if tag != f"v{version}":
        print(
            f"error: tag {tag!r} does not match pyproject.toml version {version!r}"
            f" (expected v{version})",
            file=sys.stderr,
        )
        return 1
    print(f"ok: tag {tag} matches version {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
