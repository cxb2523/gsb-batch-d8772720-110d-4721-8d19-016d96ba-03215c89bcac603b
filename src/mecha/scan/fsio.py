"""Reading files for a scan: one place opens files (tests guard it), streaming only.

* ``cloud_only`` tells files that only exist in the cloud from their attributes, without
  opening them: opening one would download it (macOS SF_DATALESS; Windows recall/offline).
* ``prefilter`` reads in overlapping chunks looking for key prefixes, so a key split across
  two chunks is still seen; it also spots binary files (a NUL byte).
* ``lines`` yields (line, cell line, column offset, text) per format: plain text, notebooks
  (cell sources and text outputs), zsh extended history, fish history.
"""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any

from mecha.scan.model import PlaceKind

CHUNK = 64 * 1024
OVERLAP = 512  # longer than any key, so a key split between two chunks is still seen
MARKERS = (b"sk-", b"AIza", b"xai-", b"AQ.")

SF_DATALESS = 0x40000000  # macOS: the file's data is not on this disk (iCloud, File Provider)
WIN_RECALL = 0x00040000 | 0x00400000 | 0x00001000  # recall on open / on data access, offline


def open_binary(path: Path) -> IO[bytes]:
    """The only way a scan opens a file (tests replace it to forbid paths outside a tree)."""
    return open(path, "rb")


def cloud_only(st: os.stat_result) -> bool:
    flags = getattr(st, "st_flags", 0)
    attributes = getattr(st, "st_file_attributes", 0)
    return bool(flags & SF_DATALESS) or bool(attributes & WIN_RECALL)


def is_regular(st: os.stat_result) -> bool:
    return stat.S_ISREG(st.st_mode)


def prefilter(path: Path) -> tuple[bool, bool]:
    """(has a key prefix, is binary). Reads at most the whole file, chunk by chunk."""
    tail = b""
    first = True
    found = False
    with open_binary(path) as f:
        while chunk := f.read(CHUNK):
            if first and b"\0" in chunk[:8192]:
                return False, True
            first = False
            window = tail + chunk
            if any(m in window for m in MARKERS):
                found = True
                break
            tail = window[-OVERLAP:]
    return found, False


Line = tuple[int, int | None, int, str]  # line (or cell), cell line, column offset, text


def lines(path: Path, kind: PlaceKind) -> Iterator[Line]:
    if kind is PlaceKind.notebook:
        yield from _notebook(path)
        return
    with open_binary(path) as raw:
        for number, data in enumerate(raw, start=1):
            text = data.decode("utf-8", errors="replace").rstrip("\r\n")
            offset = 0
            if kind is PlaceKind.history_zsh and text.startswith(": "):
                # ": <beginning time>:<elapsed seconds>;<command>" (zsh EXTENDED_HISTORY)
                semi = text.find(";")
                if semi != -1:
                    offset, text = semi + 1, text[semi + 1 :]
            elif kind is PlaceKind.history_fish:
                stripped = text.lstrip()
                if not stripped.startswith("- cmd:"):
                    continue
                offset = len(text) - len(stripped) + len("- cmd:")
                text = text[offset:]
            yield number, None, offset, text


def _notebook(path: Path) -> Iterator[Line]:
    with open_binary(path) as f:
        try:
            nb = json.load(f)
        except ValueError:
            return
    cells = nb.get("cells") if isinstance(nb, dict) else None
    if not isinstance(cells, list):
        return
    for index, cell in enumerate(cells, start=1):
        if not isinstance(cell, dict):
            continue
        texts = [_join(cell.get("source"))]
        for output in cell.get("outputs") or []:
            if isinstance(output, dict):
                texts.append(_join(output.get("text")))
                data = output.get("data")
                if isinstance(data, dict):
                    texts.append(_join(data.get("text/plain")))
        number = 0
        for block in texts:
            for line in block.splitlines():
                number += 1
                yield index, number, 0, line


def _join(value: Any) -> str:
    if isinstance(value, list):
        return "".join(v for v in value if isinstance(v, str))
    return value if isinstance(value, str) else ""
