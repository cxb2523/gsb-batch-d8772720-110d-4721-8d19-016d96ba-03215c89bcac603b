"""Pytest bootstrap: ensure the repository root is importable.

Python's isolated mode (``-I``) does not add the current working directory to
``sys.path``, so inserting the repository root explicitly lets the tests import
``app`` without relying on environment variables.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
