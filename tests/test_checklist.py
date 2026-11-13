"""Tests for the read-only hand-off checklist artifact.

The local HAR below has three dependency layers:

1. ``POST /login`` responds with a ``session`` value (Set-Cookie and body).
2. ``GET /refresh`` carries that session and responds with a ``token``.
3. ``POST /orders`` (the target) carries the token and an ``X-Signature``
   header whose source never appears in the capture.
"""

from __future__ import annotations

import json

import pytest

from reqvexa.capture import HarProvider
from reqvexa.checklist import (
    CHECKLIST_SCHEMA_VERSION,
    DEPTH_ONE_LEVEL,
    DEPTH_RECURSIVE,
    build_checklist,
)
from reqvexa.cli import main
from reqvexa.provenance import ProvenanceEngine

SESSION_VALUE = "session-secret-0001"
TOKEN_VALUE = "token-secret-0002"
SIGNATURE_VALUE = "signature-secret-0003"


def _entry(method: str, url: str, *, headers=None, response=None) -> dict:
    return {
        "startedDateTime": "2026-08-29T00:00:00Z",
        "time": 1,
        "timings": {"wait": 1},
        "request": {
            "method": method, "url": url, "httpVersion": "HTTP/1.1",
            "headers": headers or [], "cookies": [],
        },
        **({"response": response} if response is not None else {}),
    }


def _response(text: str, headers=None) -> dict:
    return {
        "status": 200, "headers": headers or [], "cookies": [],
        "content": {"size": len(text), "mimeType": "application/json", "text": text},
    }


@pytest.fixture
def three_layer_capture():
    document = {"log": {"version": "1.2", "creator": {"name": "checklist-test"},
                        "entries": [
        _entry("POST", "https://example.test/login", response=_response(
            json.dumps({"session": SESSION_VALUE}),
            headers=[{"name": "Set-Cookie", "value": f"session={SESSION_VALUE}"}],
        )),
        _entry("GET", "https://example.test/refresh", headers=[
            {"name": "Cookie", "value": f"session={SESSION_VALUE}"},
        ], response=_response(json.dumps({"token": TOKEN_VALUE}))),
        _entry("POST", "https://example.test/orders", headers=[
            {"name": "Authorization", "value": f"Bearer {TOKEN_VALUE}"},
            {"name": "X-Signature", "value": SIGNATURE_VALUE},
        ]),
    ]}}
    return HarProvider().load_json(document)


@pytest.fixture
def target_id(three_layer_capture):
    return three_layer_capture.requests[2].id


def _analyzed(capture, target_id, *, recursive: bool):
    return ProvenanceEngine().analyze(
        capture, target_request_id=target_id, recursive=recursive,
    )


# ------------------------------------------------------------- step shape ---


def test_recursive_checklist_lists_every_planned_request_in_capture_order(
    three_layer_capture, target_id,
):
    analysis = _analyzed(three_layer_capture, target_id, recursive=True)
    checklist = build_checklist(analysis, target_id)

    assert checklist.depth == DEPTH_RECURSIVE
    assert checklist.mode == DEPTH_RECURSIVE
    assert checklist.max_step_depth == 2
    assert [step.sequence for step in checklist.steps] == [0, 1, 2]
    assert [step.method for step in checklist.steps] == ["POST", "GET", "POST"]
    assert [step.path for step in checklist.steps] == ["/login", "/refresh", "/orders"]
    assert [step.role for step in checklist.steps] == ["producer", "producer", "target"]
    # depth is the hop distance from the target (target == 0).
    assert [step.depth for step in checklist.steps] == [2, 1, 0]

    login, refresh, target = checklist.steps
    assert [value.name for value in login.produces] == ["session"]
    assert login.consumes == ()
    assert [value.name for value in refresh.consumes] == ["session"]
    assert [value.name for value in refresh.produces] == ["authorization"]
    assert [value.name for value in target.consumes] == ["authorization", "x-signature"]
    assert target.produces == ()


def test_one_level_checklist_keeps_only_target_and_first_producers(
    three_layer_capture, target_id,
):
    analysis = _analyzed(three_layer_capture, target_id, recursive=False)
    checklist = build_checklist(analysis, target_id, recursive=False)

    assert checklist.depth == DEPTH_ONE_LEVEL
    assert checklist.mode == DEPTH_ONE_LEVEL
    assert checklist.max_step_depth == 1
    # The login request (the session's own producer) is not expanded.
    assert [step.sequence for step in checklist.steps] == [1, 2]
    assert [step.depth for step in checklist.steps] == [1, 0]
    assert [step.role for step in checklist.steps] == ["producer", "target"]

    refresh, target = checklist.steps
    assert refresh.path == "/refresh"
    assert [value.name for value in refresh.produces] == ["authorization"]
    assert [value.name for value in target.consumes] == ["authorization", "x-signature"]


def test_recursive_and_one_level_step_sets_differ(three_layer_capture, target_id):
    recursive = build_checklist(
        _analyzed(three_layer_capture, target_id, recursive=True), target_id,
    )
    one_level = build_checklist(
        _analyzed(three_layer_capture, target_id, recursive=False),
        target_id, recursive=False,
    )
    recursive_ids = {step.request_id for step in recursive.steps}
    one_level_ids = {step.request_id for step in one_level.steps}
    assert one_level_ids < recursive_ids
    assert recursive_ids - one_level_ids == {three_layer_capture.requests[0].id}
    assert recursive.max_step_depth > one_level.max_step_depth


# -------------------------------------------------------------- unresolved ---


def test_unresolved_value_is_listed_as_is_without_a_producer(
    three_layer_capture, target_id,
):
    analysis = _analyzed(three_layer_capture, target_id, recursive=True)
    checklist = build_checklist(analysis, target_id)

    assert [value.name for value in checklist.unresolved_values] == ["x-signature"]
    unresolved = checklist.unresolved_values[0]
    assert unresolved.status == "UNKNOWN"
    # No producer information is fabricated: value entries carry status and
    # summaries only, never a producer field (at any depth or safety mode).
    for payload in (
        build_checklist(analysis, target_id).to_dict(),
        build_checklist(analysis, target_id, unsafe_raw=True).to_dict(),
    ):
        value_entries = [
            *payload["unresolved_values"],
            *(value for step in payload["steps"] for value in step["consumes"]),
            *(value for step in payload["steps"] for value in step["produces"]),
        ]
        assert all("producer" not in entry for entry in value_entries)
    # The resolved values are never listed as unresolved.
    assert "session" not in [value.name for value in checklist.unresolved_values]
    assert "authorization" not in [value.name for value in checklist.unresolved_values]


def test_unresolved_list_is_identical_across_depths(three_layer_capture, target_id):
    recursive = build_checklist(
        _analyzed(three_layer_capture, target_id, recursive=True), target_id,
    )
    one_level = build_checklist(
        _analyzed(three_layer_capture, target_id, recursive=False),
        target_id, recursive=False,
    )
    assert [value.name for value in recursive.unresolved_values] == ["x-signature"]
    assert [value.name for value in one_level.unresolved_values] == ["x-signature"]


# ------------------------------------------------------------------ masking ---


def test_checklist_masks_values_by_default(three_layer_capture, target_id):
    analysis = _analyzed(three_layer_capture, target_id, recursive=True)
    payload = build_checklist(analysis, target_id).to_dict()
    rendered = json.dumps(payload)

    assert payload["unsafe_raw"] is False
    for secret in (SESSION_VALUE, TOKEN_VALUE, SIGNATURE_VALUE):
        assert secret not in rendered
    # Stable summaries and statuses survive masking.
    target_step = payload["steps"][-1]
    entries = {value["name"]: value for value in target_step["consumes"]}
    assert entries["x-signature"]["status"] == "UNKNOWN"
    assert len(entries["x-signature"]["value_digest"]) == 64
    assert "raw_value" not in entries["x-signature"]
    assert entries["authorization"]["masked_value"]
    assert len(entries["authorization"]["value_digest"]) == 64


def test_unsafe_raw_checklist_contains_original_values(three_layer_capture, target_id):
    analysis = _analyzed(three_layer_capture, target_id, recursive=True)
    payload = build_checklist(analysis, target_id, unsafe_raw=True).to_dict()
    rendered = json.dumps(payload)

    assert payload["unsafe_raw"] is True
    for secret in (SESSION_VALUE, TOKEN_VALUE, SIGNATURE_VALUE):
        assert secret in rendered
    target_step = payload["steps"][-1]
    entries = {value["name"]: value for value in target_step["consumes"]}
    assert entries["x-signature"]["raw_value"] == SIGNATURE_VALUE
    assert entries["authorization"]["raw_value"] == f"Bearer {TOKEN_VALUE}"
    # Masking information is still present alongside the raw value.
    assert entries["x-signature"]["masked_value"] != SIGNATURE_VALUE


# ------------------------------------------------------------- serialization ---


def test_checklist_is_json_serializable_with_stable_fields(
    three_layer_capture, target_id,
):
    analysis = _analyzed(three_layer_capture, target_id, recursive=True)
    payload = build_checklist(analysis, target_id).to_dict()
    restored = json.loads(json.dumps(payload))
    assert restored == payload
    assert payload["schema_version"] == CHECKLIST_SCHEMA_VERSION

    expected_top_level = {
        "schema_version", "target_request_id", "depth", "mode", "max_step_depth",
        "unsafe_raw", "steps", "unresolved_values", "warnings",
    }
    assert set(payload) == expected_top_level
    expected_step = {
        "request_id", "sequence", "depth", "method", "path",
        "role", "consumes", "produces",
    }
    assert set(payload["steps"][0]) == expected_step
    expected_value = {
        "name", "value_id", "version_id", "status",
        "masked_value", "value_digest",
    }
    assert set(payload["steps"][0]["produces"][0]) == expected_value


def test_repeated_analysis_produces_identical_checklist(
    three_layer_capture, target_id,
):
    first = build_checklist(
        _analyzed(three_layer_capture, target_id, recursive=True), target_id,
    ).to_dict()
    second = build_checklist(
        _analyzed(three_layer_capture, target_id, recursive=True), target_id,
    ).to_dict()
    assert first == second


# --------------------------------------------------------------------- CLI ---


def _three_layer_document() -> dict:
    return {"log": {"version": "1.2", "creator": {"name": "cli"}, "entries": [
        _entry("POST", "https://example.test/login", response=_response(
            json.dumps({"session": SESSION_VALUE}),
            headers=[{"name": "Set-Cookie", "value": f"session={SESSION_VALUE}"}],
        )),
        _entry("GET", "https://example.test/refresh", headers=[
            {"name": "Cookie", "value": f"session={SESSION_VALUE}"},
        ], response=_response(json.dumps({"token": TOKEN_VALUE}))),
        _entry("POST", "https://example.test/orders", headers=[
            {"name": "Authorization", "value": f"Bearer {TOKEN_VALUE}"},
            {"name": "X-Signature", "value": SIGNATURE_VALUE},
        ]),
    ]}}


def _write_har(tmp_path, document: dict) -> object:
    path = tmp_path / "three-layer.har"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_cli_checklist_default_is_masked_and_depth_labeled(tmp_path, capsys):
    path = _write_har(tmp_path, _three_layer_document())
    code = main(["checklist", str(path), "--request", "-1"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["depth"] == DEPTH_RECURSIVE
    assert [step["sequence"] for step in payload["steps"]] == [0, 1, 2]
    rendered = json.dumps(payload)
    for secret in (SESSION_VALUE, TOKEN_VALUE, SIGNATURE_VALUE):
        assert secret not in rendered


def test_cli_checklist_one_level_and_unsafe_raw(tmp_path, capsys):
    path = _write_har(tmp_path, _three_layer_document())
    code = main([
        "checklist", str(path), "--request", "-1",
        "--one-level", "--unsafe-raw",
    ])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["depth"] == DEPTH_ONE_LEVEL
    assert [step["sequence"] for step in payload["steps"]] == [1, 2]
    rendered = json.dumps(payload)
    for secret in (TOKEN_VALUE, SIGNATURE_VALUE):
        assert secret in rendered
    # The login request is absent from the plan entirely.
    assert all(step["path"] != "/login" for step in payload["steps"])
    # The session is still shown as a consumed value of the remaining producer,
    # because one-level mode keeps producer requests' own consumption visible.
    refresh_step = next(step for step in payload["steps"] if step["path"] == "/refresh")
    assert [value["name"] for value in refresh_step["consumes"]] == ["session"]
    assert refresh_step["consumes"][0]["raw_value"] == SESSION_VALUE


def test_cli_checklist_writes_output_file(tmp_path, capsys):
    document = {"log": {"version": "1.2", "creator": {"name": "cli"}, "entries": [
        _entry("POST", "https://example.test/target", headers=[
            {"name": "X-Signature", "value": SIGNATURE_VALUE},
        ]),
    ]}}
    path = _write_har(tmp_path, document)
    output = tmp_path / "checklist.json"
    code = main([
        "checklist", str(path), "--request", "-1", "--output", str(output),
    ])
    assert code == 0
    assert capsys.readouterr().out == ""
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["unresolved_values"][0]["name"] == "x-signature"
    assert SIGNATURE_VALUE not in output.read_text(encoding="utf-8")
