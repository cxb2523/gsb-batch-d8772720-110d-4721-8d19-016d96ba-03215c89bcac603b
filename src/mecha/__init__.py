"""Mecha: how much fuse is left on your API keys?"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("mecha-keys")
except PackageNotFoundError:  # pragma: no cover - running from a raw checkout
    __version__ = "0.0.0"

__all__ = ["__version__"]
