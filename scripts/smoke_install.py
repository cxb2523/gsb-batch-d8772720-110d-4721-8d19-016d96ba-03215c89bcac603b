"""Install a built wheel the way users do and check that Mecha runs, UI included.

Usage: uv run --no-project scripts/smoke_install.py dist/mecha_keys-X.Y.Z-py3-none-any.whl

Runs ``uvx --from <wheel> mecha-keys`` in a fresh temporary MECHA_HOME, so it uses the
wheel from this build (never an index): ``--version``, then ``serve --demo`` on a free
port, and checks ``/api/health`` (with the session token, and 401 without it) and that
``/`` serves the compiled interface with its CSP. Standard library only; any OS.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

TIMEOUT = 180  # first run downloads Python and the dependencies


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def get(url: str, token: str | None = None) -> tuple[int, dict[str, str], str]:
    req = urllib.request.Request(url)  # noqa: S310 - http://127.0.0.1 only
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, ""


def stop(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "posix":
        os.killpg(proc.pid, signal.SIGINT)
    else:
        # uvx starts mecha as a child: end the whole tree.
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)  # noqa: S603, S607
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        proc.kill()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: smoke_install.py <wheel>", file=sys.stderr)
        return 2
    wheel = Path(sys.argv[1]).resolve()
    uvx = shutil.which("uvx")
    if not wheel.is_file() or uvx is None:
        print(f"error: need an existing wheel and uvx (wheel={wheel})", file=sys.stderr)
        return 2
    home = Path(tempfile.mkdtemp(prefix="mecha-smoke-"))
    env = {**os.environ, "MECHA_HOME": str(home), "PYTHONUTF8": "1"}
    base = [uvx, "--isolated", "--from", str(wheel), "mecha-keys"]

    version = subprocess.run(  # noqa: S603
        [*base, "--version"], env=env, capture_output=True, text=True, timeout=TIMEOUT
    )
    print(version.stdout.strip() or version.stderr.strip())
    if version.returncode != 0:
        print("error: mecha-keys --version failed", file=sys.stderr)
        return 1

    port = free_port()
    kwargs: dict[str, object] = {}
    if os.name == "posix":
        kwargs["start_new_session"] = True  # its own process group, killed as a whole
    else:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    proc = subprocess.Popen(  # noqa: S603
        [*base, "serve", "--demo", "--no-open", "--port", str(port)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        **kwargs,  # type: ignore[call-overload]
    )
    out: list[str] = []
    reader = threading.Thread(
        target=lambda: out.extend(iter(proc.stdout.readline, "")) if proc.stdout else None,
        daemon=True,
    )
    reader.start()
    try:
        deadline = time.monotonic() + TIMEOUT
        token = None
        while time.monotonic() < deadline and proc.poll() is None:
            text = "".join(out)
            m = re.search(r"Open: http://\S+#t=(\S+)", text)
            if m and "Uvicorn running" in text:
                token = m.group(1)
                break
            time.sleep(0.5)
        if token is None:
            print("error: the server did not start:\n" + "".join(out), file=sys.stderr)
            return 1
        root = f"http://127.0.0.1:{port}"
        status, _, body = get(f"{root}/api/health", token)
        health = json.loads(body) if status == 200 else {}
        no_token, _, _ = get(f"{root}/api/health")
        status_index, headers, html = get(f"{root}/")
        checks = {
            "health 200 with the token": status == 200 and health.get("status") == "ok",
            "health in demo mode": health.get("demo") is True,
            "health 401 without the token": no_token == 401,
            "index 200": status_index == 200,
            "index ships the compiled UI": '<div id="root">' in html and "/assets/" in html,
            "index has a CSP with a nonce": "nonce-" in headers.get("content-security-policy", ""),
        }
        for name, ok in checks.items():
            print(f"{'ok' if ok else 'FAIL'}: {name}")
        if not all(checks.values()):
            print("".join(out), file=sys.stderr)
            return 1
        print(
            f"ok: {wheel.name} installs and runs with its interface"
            f" (version {health.get('version')})"
        )
        return 0
    finally:
        stop(proc)
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
