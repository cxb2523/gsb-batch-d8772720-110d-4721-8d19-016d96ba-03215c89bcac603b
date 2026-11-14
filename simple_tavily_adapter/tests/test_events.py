"""Pure-logic tests for the ACP → flat-event normalizer."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from events import Event, normalize_acp_update


# Minimal stand-ins for pydantic ACP models. normalize_acp_update only cares
# about type(x).__name__ + .model_dump(), so plain dataclasses with a
# model_dump method pass through unchanged.
def _model_dump_factory(d: dict[str, Any]):
    def _dump(self, **_: Any) -> dict[str, Any]:
        return d
    return _dump


def _make(cls_name: str, data: dict[str, Any]) -> Any:
    cls = type(cls_name, (), {"model_dump": _model_dump_factory(data)})
    return cls()


def test_normalize_thought_chunk():
    upd = _make("AgentThoughtChunk", {"content": [{"type": "text", "text": "thinking"}]})
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    assert len(evs) == 1
    ev = evs[0]
    assert ev.type == "thought"
    assert ev.payload["text"] == "thinking"
    assert ev.agent_id == "lead"
    assert ev.parent_id is None


def test_normalize_tool_call_start_extracts_key_fields():
    upd = _make("ToolCallStart", {
        "tool_call_id": "tc-1",
        "title": "search",
        "kind": "other",
        "raw_input": {"query": "x"},
        "content": [{"content": {"type": "text", "text": "preview"}}],
        "locations": [],
    })
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    assert len(evs) == 1
    ev = evs[0]
    assert ev.type == "tool_call"
    assert ev.payload["id"] == "tc-1"
    assert ev.payload["title"] == "search"
    assert ev.payload["raw_input"] == {"query": "x"}
    assert "preview" in ev.payload["preview"]


def test_normalize_tool_call_progress_error():
    upd = _make("ToolCallProgress", {
        "tool_call_id": "tc-1",
        "status": "error",
        "content": [{"content": {"type": "text", "text": "boom"}}],
    })
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    assert len(evs) == 1
    ev = evs[0]
    assert ev.type == "tool_result"
    assert ev.payload["status"] == "error"
    assert "boom" in ev.payload["content"]


def test_normalize_unknown_becomes_note():
    upd = _make("SomeFutureEvent", {"foo": "bar"})
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    assert len(evs) == 1
    ev = evs[0]
    assert ev.type == "note"
    assert ev.payload["kind"] == "SomeFutureEvent"
    assert ev.payload["data"] == {"foo": "bar"}


def test_delegate_task_tool_call_spawns_sub_agents():
    upd = _make("ToolCallStart", {
        "tool_call_id": "tc-del",
        "title": "delegate task",
        "kind": "other",
        "raw_input": {
            "tasks": [
                {"goal": "Sub-question 1", "toolsets": ["terminal"]},
                {"goal": "Sub-question 2", "toolsets": ["terminal"]},
            ],
        },
    })
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    assert len(evs) == 3
    assert evs[0].type == "tool_call"
    assert evs[0].agent_id == "lead"
    # Sub agent ids are scoped by delegate_call_id; same-batch IDs share prefix
    assert evs[1].type == "spawn"
    assert evs[1].agent_id.startswith("sub-")
    assert evs[1].agent_id.endswith("-1")
    assert evs[1].parent_id == "lead"
    assert evs[1].payload["goal"] == "Sub-question 1"
    assert evs[2].agent_id.endswith("-2")
    assert evs[2].payload["task_index"] == 1
    # Shared prefix = same batch
    prefix1 = evs[1].agent_id.rsplit("-", 1)[0]
    prefix2 = evs[2].agent_id.rsplit("-", 1)[0]
    assert prefix1 == prefix2


def test_sub_agent_ids_are_unique_across_batches():
    """Lead fires delegate_task twice; sub-1 in each batch must not collide."""
    upd_a = _make("ToolCallStart", {
        "tool_call_id": "tc-AAA",
        "title": "delegate task",
        "raw_input": {"tasks": [{"goal": "g1"}]},
    })
    upd_b = _make("ToolCallStart", {
        "tool_call_id": "tc-BBB",
        "title": "delegate task",
        "raw_input": {"tasks": [{"goal": "g2"}]},
    })
    evs_a = normalize_acp_update(upd_a, job_id="j", agent_id="lead", parent_id=None)
    evs_b = normalize_acp_update(upd_b, job_id="j", agent_id="lead", parent_id=None)
    sub_a = evs_a[1].agent_id
    sub_b = evs_b[1].agent_id
    assert sub_a != sub_b


def test_delegate_task_tool_result_emits_per_sub_done_and_message():
    content_json = (
        '{"results": [{"task_index": 0, "status": "completed", "summary": "found X"},'
        ' {"task_index": 1, "status": "error", "error": "timeout"}]}'
    )
    upd = _make("ToolCallProgress", {
        "tool_call_id": "tc-del",
        "status": "completed",
        "content": [{"content": {"type": "text", "text": content_json}}],
    })
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    types = [e.type for e in evs]
    assert "tool_result" in types
    # Look up by task_index rather than by fixed id, since the id embeds a hash
    sub1_id = next(e.agent_id for e in evs if e.type == "message")
    sub_messages = [e for e in evs if e.agent_id == sub1_id and e.type == "message"]
    assert sub_messages and sub_messages[0].payload["text"] == "found X"
    sub_done = [e for e in evs if e.agent_id == sub1_id and e.type == "done"]
    assert sub_done and sub_done[0].payload["status"] == "completed"
    error_dones = [e for e in evs if e.type == "done" and e.payload.get("status") == "error"]
    assert len(error_dones) == 1


def test_delegate_task_tool_result_survives_truncated_json():
    """ACP truncates content around 2000 chars — the regex fallback should
    still surface at least the task_index + status for each sub."""
    # Incomplete JSON: missing closing `]}` and summary string unterminated
    truncated = (
        '{"results": [{"task_index": 0, "status": "completed", "summary": "partial summary'
        ' text ..."}, {"task_index": 1, "status": "error", "summary": "err'
    )
    upd = _make("ToolCallProgress", {
        "tool_call_id": "tc-del",
        "status": "completed",
        "content": [{"content": {"type": "text", "text": truncated}}],
    })
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    dones = [e for e in evs if e.type == "done"]
    assert len(dones) == 2
    statuses = sorted(e.payload["status"] for e in dones)
    assert statuses == ["completed", "error"]


def test_delegate_task_regex_recovers_summary_when_cut_mid_string():
    """Worst case: ACP cuts the buffer in the middle of the first summary's
    text — no closing quote, no closing brace, no next task. Still, the
    regex should emit a message event with the partial summary we have."""
    # Realistic shape from Hermes when task 0's summary is large
    cut = (
        '{"results": [{"task_index": 0, "status": "completed", "summary": "'
        '**What I did**\\n1. Ran a search.\\n2. Looked at several URLs and '
        'extracted content. More text here that is long enough to be cut off'
    )
    upd = _make("ToolCallProgress", {
        "tool_call_id": "tc-del",
        "status": "completed",
        "content": [{"content": {"type": "text", "text": cut}}],
    })
    evs = normalize_acp_update(upd, job_id="j1", agent_id="lead", parent_id=None)
    messages = [e for e in evs if e.type == "message"]
    assert len(messages) == 1
    text = messages[0].payload["text"]
    assert "What I did" in text
    assert "Ran a search" in text


def test_event_to_dict_is_jsonable():
    import json
    ev = Event.now(
        job_id="j1", agent_id="sub-1", parent_id="lead",
        type="message", payload={"text": "hi"},
    )
    # Should round-trip through json without losing data
    reconstructed = json.loads(json.dumps(ev.to_dict()))
    assert reconstructed["type"] == "message"
    assert reconstructed["agent_id"] == "sub-1"
    assert reconstructed["parent_id"] == "lead"
    assert reconstructed["payload"]["text"] == "hi"
