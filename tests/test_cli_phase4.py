from __future__ import annotations

import json
import re
from pathlib import Path

import httpx
import respx
from typer.testing import CliRunner

from mecha.cli import app
from tests.fakes import fake

runner = CliRunner()
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run(*args: str, input: str | None = None) -> tuple[int, str]:
    r = runner.invoke(app, list(args), input=input, env={"COLUMNS": "200"})
    return r.exit_code, ANSI.sub("", r.output)


def test_import_env_preview_selection_and_no_tty_guard(tmp_path: Path) -> None:
    a, x = fake("sk-ant-api03-"), fake("xai-")
    env = tmp_path / ".env"
    env.write_text(f"ANTHROPIC_API_KEY={a}\nXAI_API_KEY='{x}'\nPORT=8080\n")
    code, output = run("import", str(env))
    assert code == 2
    assert "--yes" in output
    assert a not in output
    assert x not in output
    code, output = run("import", str(env), "--yes", "--only", "XAI_API_KEY")
    assert code == 0, output
    assert output.count("Imported") == 1
    data = json.loads(run("ls", "--json")[1])
    assert [c["credential"]["label"] for c in data["credentials"]] == ["XAI_API_KEY"]


def test_link_command(tmp_path: Path) -> None:
    f = tmp_path / "oauth_creds.json"
    f.write_text(json.dumps({"refresh_token": "1//x", "expiry_date": 1, "scope": "openid"}))
    code, output = run("link", "gemini-cli", "--path", str(f))
    assert code == 0, output
    assert "Linked" in output
    code, output = run("link", "vscode")
    assert code == 2
    assert "unknown tool" in output


def test_check_active_hourly_limit_message(isolated_env: Path) -> None:
    isolated_env.mkdir(parents=True, exist_ok=True)
    (isolated_env / "config.toml").write_text(
        '[http]\nretries = 0\n[probes]\nxai_model = "grok-4.20-0309-non-reasoning"\n'
    )
    run("add", input=fake("xai-"))
    with respx.mock as router:
        post = router.post("https://api.x.ai/v1/chat/completions").mock(
            return_value=httpx.Response(200, json={"id": "c", "choices": []})
        )
        assert run("check", "--active")[0] == 0
        _code, output = run("check", "--active")
        assert "one active probe per hour" in output
        assert post.call_count == 1
        run("check", "--active", "--force")
        assert post.call_count == 2
