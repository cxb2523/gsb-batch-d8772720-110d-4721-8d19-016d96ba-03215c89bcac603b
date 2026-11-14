from __future__ import annotations

import logging
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mecha.cli import app
from mecha.core.config import ConfigError, load_config, parse_config


def test_missing_file_gives_defaults(tmp_path: Path) -> None:
    assert load_config(tmp_path / "config.toml").scheduler.interval_hours == 6


def test_values_are_read() -> None:
    c = parse_config(
        "[thresholds]\nsoon_days = 30\nlow_funds_usd = 10.5\n"
        "[scheduler]\nenabled = false\ninterval_hours = 1\n"
        '[providers.anthropic]\nversion = "2023-06-01"\n'
    )
    assert c.thresholds.soon_days == 30
    assert str(c.thresholds.low_funds_usd) == "10.5"
    assert c.scheduler.enabled is False
    assert c.providers.anthropic.version == "2023-06-01"


def test_unknown_keys_warn_but_do_not_fail(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING):
        c = parse_config("typo = 1\n[scheduler]\ninterval_hour = 2\n[nope]\nx = 1\n")
    assert c.scheduler.interval_hours == 6
    for key in ("'typo'", "'scheduler.interval_hour'", "'nope'"):
        assert key in caplog.text


@pytest.mark.parametrize(
    ("text", "match"),
    [
        ("[scheduler]\nconcurrency = 0\n", "scheduler.concurrency"),
        ("[http]\ntimeout_seconds = -1\n", "http.timeout_seconds"),
        ("[thresholds]\nsoon_days = 'soon'\n", "thresholds.soon_days"),
        ("this is not toml", "invalid TOML"),
    ],
)
def test_invalid_values_are_clear_errors(text: str, match: str) -> None:
    with pytest.raises(ConfigError, match=match):
        parse_config(text)


def test_bad_config_makes_ls_and_check_exit_3(isolated_env: Path) -> None:
    isolated_env.mkdir(parents=True, exist_ok=True)
    (isolated_env / "config.toml").write_text("[scheduler]\nconcurrency = 0\n")
    runner = CliRunner()
    for cmd in (["ls"], ["check"]):
        r = runner.invoke(app, cmd)
        assert r.exit_code == 3, r.output
        assert "concurrency" in r.output
