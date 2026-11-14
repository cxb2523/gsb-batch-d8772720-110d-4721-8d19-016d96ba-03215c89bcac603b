import re

from typer.testing import CliRunner

from mecha import __version__
from mecha.cli import app

runner = CliRunner()
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def plain(text: str) -> str:
    # Rich forces colour on CI (e.g. GITHUB_ACTIONS), which splits option names with ANSI codes.
    return ANSI.sub("", text)


def test_version() -> None:
    r = runner.invoke(app, ["--version"])
    assert r.exit_code == 0
    assert __version__ in r.stdout


def test_serve_help_lists_options() -> None:
    r = runner.invoke(app, ["serve", "--help"], env={"COLUMNS": "200"})
    assert r.exit_code == 0
    out = plain(r.stdout)
    for opt in ("--port", "--no-open", "--demo", "--dev"):
        assert opt in out
