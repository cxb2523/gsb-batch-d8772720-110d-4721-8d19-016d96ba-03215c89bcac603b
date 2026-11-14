"""
Probe #2 — real research query. Check ALL session_update types fire, especially
ToolCallStart/Progress + sub-agent events during delegate_task.
"""
from __future__ import annotations
import asyncio, json, os, sys
from collections import Counter
from typing import Any

import acp
from acp import PROTOCOL_VERSION, Client, RequestError, connect_to_agent, text_block
from acp.schema import ClientCapabilities, Implementation


def _dump(obj: Any, cap: int = 600) -> str:
    if hasattr(obj, "model_dump"):
        s = json.dumps(obj.model_dump(mode="json", exclude_none=True), ensure_ascii=False, indent=2)
    else:
        s = repr(obj)
    return s if len(s) <= cap else s[:cap] + f"\n...[truncated, {len(s)} chars total]"


class LoggingClient(Client):
    def __init__(self):
        self.counts: Counter[str] = Counter()
        self.first_of_each: dict[str, Any] = {}

    # rejected client-side methods
    async def request_permission(self, *a, **kw):      raise RequestError.method_not_found("session/request_permission")
    async def write_text_file(self, *a, **kw):          raise RequestError.method_not_found("fs/write_text_file")
    async def read_text_file(self, *a, **kw):           raise RequestError.method_not_found("fs/read_text_file")
    async def create_terminal(self, *a, **kw):          raise RequestError.method_not_found("terminal/create")
    async def terminal_output(self, *a, **kw):          raise RequestError.method_not_found("terminal/output")
    async def release_terminal(self, *a, **kw):         raise RequestError.method_not_found("terminal/release")
    async def wait_for_terminal_exit(self, *a, **kw):   raise RequestError.method_not_found("terminal/wait_for_exit")
    async def kill_terminal(self, *a, **kw):            raise RequestError.method_not_found("terminal/kill")
    async def ext_method(self, method, params):         raise RequestError.method_not_found(method)
    async def ext_notification(self, method, params):   raise RequestError.method_not_found(method)

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        kind = type(update).__name__
        self.counts[kind] += 1
        if kind not in self.first_of_each:
            self.first_of_each[kind] = update
            print(f"\n━━━━ FIRST {kind} ━━━━", flush=True)
            print(_dump(update), flush=True)
        elif self.counts[kind] % 10 == 0:
            print(f"  · {kind} × {self.counts[kind]}", flush=True)


async def main() -> int:
    print(f"=== probe 2 · PROTOCOL_VERSION={PROTOCOL_VERSION}", flush=True)

    proc = await asyncio.create_subprocess_exec(
        "hermes", "acp",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    assert proc.stdin and proc.stdout
    client = LoggingClient()
    conn = connect_to_agent(client, proc.stdin, proc.stdout)

    await conn.initialize(
        protocol_version=PROTOCOL_VERSION,
        client_capabilities=ClientCapabilities(),
        client_info=Implementation(name="probe2", title="Probe2", version="0.1.0"),
    )
    session = await conn.new_session(mcp_servers=[], cwd="/workspace")
    print(f"=== session: {session.session_id}", flush=True)

    # Research query requiring tool calls + likely delegate_task with our skill
    query = (
        "Use the searcharvester-deep-research skill to research "
        "'LMCache overview' with 2 sub-questions. Keep it short. "
        "Don't take longer than 2 minutes."
    )
    print(f"=== prompting: {query}", flush=True)
    resp = await conn.prompt(
        session_id=session.session_id,
        prompt=[text_block(query)],
    )
    print("\n━━━━ PROMPT RESPONSE ━━━━", flush=True)
    print(_dump(resp), flush=True)

    print("\n━━━━ EVENT TYPE COUNTS ━━━━", flush=True)
    for k, v in client.counts.most_common():
        print(f"  {k}: {v}")

    # Dump first ToolCallStart if we got one (most interesting event type)
    if "ToolCallStart" in client.first_of_each:
        print("\n━━━━ FULL FIRST ToolCallStart (uncapped) ━━━━", flush=True)
        t = client.first_of_each["ToolCallStart"]
        print(json.dumps(t.model_dump(mode="json", exclude_none=True), ensure_ascii=False, indent=2), flush=True)

    if proc.returncode is None:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
