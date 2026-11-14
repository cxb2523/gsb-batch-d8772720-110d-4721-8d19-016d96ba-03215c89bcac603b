"""Where to look, what to skip and which places are risky, per platform.

Every known path comes from the tool's own documentation (docs/providers.md, "Scan:
known locations", checked 2026-11-09). Nothing here reads a file: it only builds paths.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from mecha.scan.model import PlaceKind


@dataclass(frozen=True)
class Env:
    """The machine the scan runs on (injected in tests: never the real home there)."""

    home: Path
    platform: str  # "darwin", "linux" or "win32"
    environ: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def current(cls) -> Env:
        import sys

        platform = "win32" if sys.platform.startswith("win") else sys.platform
        platform = "linux" if platform.startswith("linux") else platform
        return cls(home=Path.home(), platform=platform, environ=dict(os.environ))

    def var(self, name: str) -> Path | None:
        value = self.environ.get(name)
        return Path(value).expanduser() if value else None

    @property
    def appdata(self) -> Path:
        return self.var("APPDATA") or self.home / "AppData" / "Roaming"

    @property
    def xdg_data(self) -> Path:
        return self.var("XDG_DATA_HOME") or self.home / ".local" / "share"

    @property
    def xdg_config(self) -> Path:
        return self.var("XDG_CONFIG_HOME") or self.home / ".config"


@dataclass(frozen=True)
class Place:
    """A known file (or every file matching `pattern` in a folder) scanned by default."""

    path: Path
    kind: PlaceKind
    tool: str
    pattern: str | None = None  # glob inside `path` (a folder) when set
    legacy: bool = False  # a path the current docs no longer mention


def known_places(env: Env) -> list[Place]:
    """AI tool configs and shell histories, scanned even where the home walk does not go."""
    h, p = env.home, env.platform
    places: list[Place] = []

    def add(path: Path, kind: PlaceKind, tool: str, **kw: object) -> None:
        places.append(Place(path, kind, tool, **kw))  # type: ignore[arg-type]

    text = PlaceKind.text
    # Claude Desktop (modelcontextprotocol.io, "Connect to local MCP servers").
    claude = {
        "darwin": h / "Library" / "Application Support" / "Claude",
        "win32": env.appdata / "Claude",
    }.get(p, env.xdg_config / "Claude")
    add(claude / "claude_desktop_config.json", text, "Claude Desktop")
    # Cursor (cursor.com/docs/context/mcp): global; project files are found by the walk.
    add(h / ".cursor" / "mcp.json", text, "Cursor")
    # VS Code (code.visualstudio.com: MCP configuration reference, Profiles).
    for product in ("Code", "Code - Insiders"):
        user = {
            "darwin": h / "Library" / "Application Support" / product / "User",
            "win32": env.appdata / product / "User",
        }.get(p, env.xdg_config / product / "User")
        add(user / "mcp.json", text, "VS Code")
        add(user / "profiles", text, "VS Code", pattern="*/mcp.json")
    add(env.var("COPILOT_HOME") or h / ".copilot", text, "VS Code", pattern="mcp-config.json")
    # Windsurf, now Devin Desktop (docs.devin.ai/desktop/cascade/mcp), and its old path.
    add(h / ".config" / "devin" / "mcp_config.json", text, "Windsurf")
    add(h / ".codeium" / "windsurf" / "mcp_config.json", text, "Windsurf", legacy=True)
    # Continue (docs.continue.dev: understanding configs, MCP).
    add(h / ".continue", text, "Continue", pattern="config.*")
    add(h / ".continue", text, "Continue", pattern=".env")
    add(h / ".continue" / "mcpServers", text, "Continue", pattern="*")

    # Shell histories.
    add(h / ".bash_history", PlaceKind.history_plain, "bash")  # GNU bash manual: HISTFILE
    add(h / ".zsh_history", PlaceKind.history_zsh, "zsh")  # macOS /etc/zshrc; usual elsewhere
    histfile = env.var("HISTFILE")
    if histfile is not None:
        kind = PlaceKind.history_zsh if "zsh" in histfile.name else PlaceKind.history_plain
        add(histfile, kind, "HISTFILE")
    add(env.xdg_data / "fish", PlaceKind.history_fish, "fish", pattern="*_history")
    psreadline = (
        env.appdata / "Microsoft" / "Windows" / "PowerShell" / "PSReadLine"
        if p == "win32"
        else env.xdg_data / "powershell" / "PSReadLine"
    )
    add(psreadline, PlaceKind.history_plain, "PowerShell", pattern="*_history.txt")
    if p == "darwin":  # Terminal's per-session history (/etc/zshrc_Apple_Terminal, bashrc)
        add(h / ".zsh_sessions", PlaceKind.history_zsh, "zsh (Terminal)", pattern="*.history*")
        add(h / ".bash_sessions", PlaceKind.history_plain, "bash (Terminal)", pattern="*.history*")
    return places


# --- the home walk ---------------------------------------------------------------------

# Folder names skipped anywhere: dependencies, caches, virtualenvs, VCS internals.
EXCLUDED_NAMES = frozenset(
    {
        ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor", "Pods",
        "__pycache__", ".venv", "venv", ".tox", ".nox", ".mypy_cache", ".ruff_cache",
        ".pytest_cache", ".gradle", ".m2", ".npm", ".pnpm-store", ".yarn", ".cargo",
        ".rustup", "site-packages", "DerivedData", ".Trash", "Trash", ".terraform",
        ".next", ".nuxt", ".turbo", ".parcel-cache",
    }
)  # fmt: skip


def excluded_dirs(env: Env) -> list[Path]:
    """Folders under home skipped by the walk (known places inside are still scanned)."""
    h = env.home
    out = [
        h / ".cache",  # includes ~/.cache/huggingface
        h / ".ollama",  # local models: huge and binary
        h / ".lmstudio",
        h / ".local" / "share" / "Trash",
    ]
    if env.platform == "darwin":
        out.append(h / "Library")
    if env.platform == "win32":
        out += [h / "AppData"]
    return out


def protected_dirs(env: Env) -> list[Path]:
    """macOS asks for permission to read these: scanned only with --include-protected."""
    if env.platform != "darwin":
        return []
    h = env.home
    return [
        h / "Desktop",
        h / "Documents",
        h / "Downloads",
        h / "Library" / "Mobile Documents",  # iCloud Drive
        h / "Library" / "CloudStorage",  # Dropbox, Google Drive, OneDrive (File Provider)
    ]


def synced_dirs(env: Env) -> list[Path]:
    """Folders a sync client uploads somewhere else: a key there is a risk."""
    h = env.home
    out = [h / "Dropbox", h / "Google Drive", h / "My Drive"]
    out += [h / name for name in _home_names(h) if name.startswith(("OneDrive", "Dropbox ("))]
    for var in ("OneDrive", "OneDriveCommercial", "OneDriveConsumer"):
        path = env.var(var)
        if path is not None:
            out.append(path)
    if env.platform == "darwin":
        out += [h / "Library" / "Mobile Documents", h / "Library" / "CloudStorage"]
    return out


def _home_names(home: Path) -> list[str]:
    try:
        return [entry.name for entry in os.scandir(home) if entry.is_dir(follow_symlinks=False)]
    except OSError:
        return []


# CLI session files: their tokens are linked with `mecha link`, never imported.
def session_files(env: Env) -> dict[Path, str]:
    h = env.home
    codex = env.var("CODEX_HOME") or h / ".codex"
    return {
        codex / "auth.json": "codex",
        h / ".claude" / ".credentials.json": "claude-code",
        h / ".gemini" / "oauth_creds.json": "gemini-cli",
    }
