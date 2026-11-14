from __future__ import annotations

import json
import re

import httpx
import pytest
import respx
from typer.testing import CliRunner

from mecha.cli import app
from tests.fakes import fake, fake_aiza
from tests.test_error_map import fixture

runner = CliRunner()
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run(*args: str, input: str | None = None) -> tuple[int, str]:
    r = runner.invoke(app, list(args), input=input, env={"COLUMNS": "200"})
    return r.exit_code, ANSI.sub("", r.output)


def mock(router: respx.MockRouter, host: str, provider: str, name: str) -> respx.Route:
    fx = fixture(provider, name)
    return router.route(host=host).mock(
        return_value=httpx.Response(fx["status"], json=fx["body"], headers=fx["headers"])
    )


@pytest.fixture(autouse=True)
def fast_http(isolated_env) -> None:  # type: ignore[no-untyped-def]
    isolated_env.mkdir(parents=True, exist_ok=True)
    (isolated_env / "config.toml").write_text("[http]\nretries = 0\nbackoff_seconds = 0\n")


def test_check_green_exit_0() -> None:
    run("add", input=fake("xai-"))
    with respx.mock as router:
        mock(router, "api.x.ai", "xai", "api_key_ok")
        code, output = run("check")
    assert code == 0, output
    assert "green" in output
    assert "just now" in output


def test_check_red_exit_2() -> None:
    run("add", input=fake("xai-"))
    with respx.mock as router:
        mock(router, "api.x.ai", "xai", "invalid_key")
        assert run("check")[0] == 2


def test_check_amber_exit_1() -> None:
    run("add", input=fake_aiza())
    with respx.mock as router:
        mock(router, "generativelanguage.googleapis.com", "gemini", "models_ok")
        assert run("check")[0] == 1


def test_strict_grey_exits_3() -> None:
    run("add", input=fake("xai-"))
    with respx.mock as router:
        router.route(host="api.x.ai").mock(side_effect=httpx.ConnectError("down"))
        code, output = run("check")
        assert code == 0  # grey is not a failure by default
        assert "check failed" in output
        assert run("check", "--strict", "--force")[0] == 3


def test_strict_red_still_wins() -> None:
    run("add", input=fake("xai-"))
    run("add", input=fake("sk-ant-api03-"))
    with respx.mock as router:
        router.route(host="api.x.ai").mock(side_effect=httpx.ConnectError("down"))
        mock(router, "api.anthropic.com", "anthropic", "invalid_key")
        assert run("check", "--strict")[0] == 2


def test_cached_result_is_marked_and_force_rechecks() -> None:
    run("add", input=fake("xai-"))
    with respx.mock as router:
        route = mock(router, "api.x.ai", "xai", "api_key_ok")
        run("check")
        _, output = run("check")
        assert "(cached)" in output
        assert route.call_count == 1
        run("check", "--force")
        assert route.call_count == 2


def test_check_json_schema_is_stable() -> None:
    run("add", input=fake("xai-"))
    with respx.mock as router:
        mock(router, "api.x.ai", "xai", "api_key_ok")
        code, output = run("check", "--json")
    data = json.loads(output)
    assert set(data) == {"schema_version", "generated_at", "exit_code", "credentials"}
    assert data["schema_version"] == 1
    assert data["exit_code"] == code == 0
    [item] = data["credentials"]
    assert set(item) == {"credential", "result", "cached", "last_known", "probe_next_at"}
    result = item["result"]
    assert set(result) >= {
        "credential_id",
        "checked_at",
        "mode",
        "check_status",
        "overall",
        "reasons",
        "validity",
        "funds",
        "expiry",
        "limits",
        "account",
        "http",
        "error",
    }
    assert result["validity"] == {
        "value": "valid",
        "source": "api",
        "observed_at": result["validity"]["observed_at"],
    }
    assert result["mode"] == "passive"


def test_check_selected_ids_only() -> None:
    run("add", input=fake("xai-"))
    run("add", input=fake("xai-"))
    ids = [c["credential"]["id"] for c in json.loads(run("ls", "--json")[1])["credentials"]]
    with respx.mock as router:
        route = mock(router, "api.x.ai", "xai", "api_key_ok")
        code, output = run("check", ids[0], "--json")
    assert code == 0
    assert len(json.loads(output)["credentials"]) == 1
    assert route.call_count == 1


def test_check_unknown_id_exits_3() -> None:
    assert run("check", "NOPE1234")[0] == 3


def test_ls_shows_last_known_for_grey() -> None:
    run("add", input=fake("xai-"))
    with respx.mock as router:
        mock(router, "api.x.ai", "xai", "api_key_ok")
        run("check")
    with respx.mock as router:
        router.route(host="api.x.ai").mock(side_effect=httpx.ConnectError("down"))
        run("check", "--force")
    _, output = run("ls")
    assert "check failed · last green just now" in output


def test_ls_ids_are_distinguishable_even_when_created_together() -> None:
    from mecha.cli import _unique_prefix_len

    same_ms = ["01M6K0000000000000000000AA", "01M6K0000000000000000000AB"]
    assert _unique_prefix_len(same_ms) == 26
    assert _unique_prefix_len(["01M6K0000AXXXX", "01M6K0000BYYYY"]) == 10
