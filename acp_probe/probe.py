"""
ACP protocol reconnaissance probe.

Spawns `hermes acp` as a subprocess, drives it through a minimal session
(initialize → new_session → prompt), and dumps EVERY session_update event
to stdout as pretty JSON so we can see the real event shape.

Runs inside the official nousresearch/hermes-agent container where the
`acp` python package and `hermes` binary are both already installed.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

import acp
from acp import PROTOCOL_VERSION, Client, RequestError, connect_to_agent, text_block
from acp.schema import ClientCapabilities, Implementation


def _dump(obj: Any) -> str:
    """Best-effort JSON dump of ACP pydantic models."""
    if hasattr(obj, "model_dump"):
        return json.dumps(obj.model_dump(mode="json", exclude_none=True), ensure_ascii=False, indent=2)
    try:
        return json.dumps(obj, ensure_ascii=False, default=str, indent=2)
    except Exception:
        return repr(obj)


class ProbeClient(Client):
    # All the ACP client methods we don't care to implement for the probe.
    # Agents may call these; we reject with method_not_found.
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
        """THE main event sink — this is what we want to characterise."""
        kind = type(update).__name__
        print(f"\n[SESSION_UPDATE · session={session_id[-8:]} · type={kind}]", flush=True)
        print(_dump(update), flush=True)


async def main() -> int:
    print(f"=== probe starting · PROTOCOL_VERSION={PROTOCOL_VERSION}", flush=True)

    # Spawn hermes in ACP mode.
    proc = await asyncio.create_subprocess_exec(
        "hermes", "acp",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        # stderr goes to our stderr so we see Hermes startup logs.
    )
    assert proc.stdin and proc.stdout

    client = ProbeClient()
    conn = connect_to_agent(client, proc.stdin, proc.stdout)

    # 1. Initialize (handshake + capabilities exchange).
    init_resp = await conn.initialize(
        protocol_version=PROTOCOL_VERSION,
        client_capabilities=ClientCapabilities(),
        client_info=Implementation(name="searcharvester-probe", title="Probe", version="0.1.0"),
    )
    print("\n=== INITIALIZE RESPONSE:", flush=True)
    print(_dump(init_resp), flush=True)

    # 2. Create a new session.
    session = await conn.new_session(mcp_servers=[], cwd=os.getcwd())
    print(f"\n=== NEW SESSION: session_id={session.session_id}", flush=True)
    print(_dump(session), flush=True)

    # 3. Send a prompt — the tiniest possible one that still forces a tool call,
    #    so we see ToolCallStart/Progress in the event stream.
    print("\n=== PROMPT: 'say hi' (2-word answer, no tool use expected)", flush=True)
    prompt_resp = await conn.prompt(
        session_id=session.session_id,
        prompt=[text_block("Reply with exactly two words: hello world. No extra text, no reasoning output.")],
    )
    print("\n=== PROMPT RESPONSE:", flush=True)
    print(_dump(prompt_resp), flush=True)

    # Clean shutdown.
    if proc.returncode is None:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
