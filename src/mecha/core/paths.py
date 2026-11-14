"""User paths. ``MECHA_HOME`` overrides the platform data directory."""

from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_data_path

DB_NAME = "mecha.db"


def data_dir() -> Path:
    override = os.environ.get("MECHA_HOME")
    if override:
        return Path(override).expanduser()
    return user_data_path("mecha", appauthor=False)


def db_path() -> Path:
    return data_dir() / DB_NAME
