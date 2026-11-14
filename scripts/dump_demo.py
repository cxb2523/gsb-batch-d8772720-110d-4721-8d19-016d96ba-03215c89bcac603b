"""Dump demo mode (``DemoService``) to JSON for the static web demo on GitHub Pages.

Usage:
    uv run python scripts/dump_demo.py           # write web/src/demo/data.json
    uv run python scripts/dump_demo.py --check   # fail (exit 1) if it is out of date

The web demo has no Python: it replays these answers. They come from the real API routes
of ``mecha serve --demo`` (FastAPI's test client over ``create_app``), so the web demo and
the local demo cannot drift apart. CI runs ``--check``.

Nothing secret is written: demo credentials have no secrets, and the sample keys offered
by "Add" are made-up values generated here, of which only the redacted answers are kept.
The output is deterministic (fixed clock, seeded values, fixed ids and fingerprints).
"""

from __future__ import annotations

import hashlib
import json
import random
import string
import sys
import warnings
from itertools import count
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "src" / "demo" / "data.json"
TOKEN = "dump"  # noqa: S105 - session token of the in-process test app, not a credential

# The keys "Add" offers in the web demo (no free text field there). `kind` is passed when
# the format alone does not tell it (an xAI management key looks like an API key).
SAMPLES: list[dict[str, Any]] = [
    {
        "id": "anthropic-api",
        "label": "Sample Anthropic key",
        "prefix": "sk-ant-api03-",
        "n": 93,
        "suffix": "AA",
    },
    {
        "id": "anthropic-admin",
        "label": "Sample Anthropic admin key",
        "prefix": "sk-ant-admin01-",
        "n": 93,
        "suffix": "AA",
    },
    {"id": "openai-project", "label": "Sample OpenAI project key", "prefix": "sk-proj-", "n": 156},
    {"id": "openai-admin", "label": "Sample OpenAI admin key", "prefix": "sk-admin-", "n": 80},
    {"id": "gemini", "label": "Sample Gemini key", "prefix": "AIza", "n": 35},
    {"id": "xai-api", "label": "Sample xAI key", "prefix": "xai-", "n": 80},
    {
        "id": "xai-management",
        "label": "Sample xAI management key",
        "prefix": "xai-",
        "n": 80,
        "kind": "management_key",
    },
    {
        "id": "openrouter",
        "label": "Sample OpenRouter key",
        "prefix": "sk-or-v1-",
        "n": 64,
        "hex": True,
    },
]


def _made_up_secret(sample: dict[str, Any]) -> str:
    rng = random.Random(f"mecha-web-demo:{sample['id']}")  # noqa: S311 - made-up, not crypto
    alphabet = "0123456789abcdef" if sample.get("hex") else string.ascii_letters + string.digits
    body = "".join(rng.choice(alphabet) for _ in range(sample["n"]))
    return f"{sample['prefix']}{body}{sample.get('suffix', '')}"


def _answer(response: Any) -> dict[str, Any]:
    return {"status": response.status_code, "body": response.json()}


def build() -> dict[str, Any]:
    warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient`")
    from fastapi.testclient import TestClient

    import mecha.core.demo as demo_module
    import mecha.core.service as service_module
    from mecha.api.routes import ApiContext
    from mecha.core.demo import DemoService
    from mecha.server import create_app

    # Deterministic ids for the credentials that "Add" (or a scan's import) creates.
    ids = count(1)
    service_module.new_ulid = lambda: f"01WEBDEMO{next(ids):017d}"  # type: ignore[attr-defined]
    demo_module.new_ulid = service_module.new_ulid  # type: ignore[attr-defined]

    def client() -> TestClient:
        service = DemoService()
        service.scan_seconds = 0  # the web demo animates the progress itself
        app = create_app(token=TOKEN, port=7878, api=ApiContext(service=service, demo=True))
        return TestClient(
            app, base_url="http://127.0.0.1:7878", headers={"Authorization": f"Bearer {TOKEN}"}
        )

    with client() as c:
        listing = c.get("/api/credentials").json()
        # The event position is per server start (random boot id): the web demo has its own
        # in-page bus and never needs it.
        listing.pop("events", None)
        providers = c.get("/api/providers").json()
        cred_ids = [item["credential"]["id"] for item in listing["credentials"]]
        history = {
            cid: c.get(f"/api/credentials/{cid}/history?limit=50").json()["history"]
            for cid in cred_ids
        }
    # Each action on a fresh service: what the same click does in `mecha serve --demo`.
    with client() as c:
        check = {
            cid: _answer(c.post(f"/api/credentials/{cid}/check?force=true")) for cid in cred_ids
        }
    with client() as c:
        probe = {
            cid: _answer(c.post(f"/api/credentials/{cid}/check?mode=active&force=true"))
            for cid in cred_ids
        }

    samples = []
    with client() as c:
        for sample in SAMPLES:
            body = {"secret": _made_up_secret(sample), "label": sample["label"]}
            if "kind" in sample:
                body["kind"] = sample["kind"]
            added = c.post("/api/credentials", json=body)
            if added.status_code != 201:
                raise SystemExit(f"error: adding sample {sample['id']} failed: {added.text}")
            status = added.json()
            cid = status["credential"]["id"]
            # The store key of a demo service is random: give the fingerprint a fixed value.
            status["credential"]["fingerprint"] = hashlib.sha256(
                f"web-demo:{sample['id']}".encode()
            ).hexdigest()[:12]
            checked = _answer(c.post(f"/api/credentials/{cid}/check?force=true"))
            probed = _answer(c.post(f"/api/credentials/{cid}/check?mode=active&force=true"))
            for answer in (checked, probed):
                if "credential" in answer["body"]:
                    answer["body"]["credential"]["fingerprint"] = status["credential"][
                        "fingerprint"
                    ]
            samples.append(
                {
                    "id": sample["id"],
                    "label": sample["label"],
                    "provider": status["credential"]["provider"],
                    "kind": status["credential"]["kind"],
                    "redacted": status["credential"]["redacted"],
                    "added": status,
                    "check": checked,
                    "probe": probed,
                }
            )

    # mecha scan: the demo's fixed result, what importing each finding adds, and where
    # the stored keys were found. Paths are the demo's made-up home, never this machine's.
    with client() as c:
        c.post("/api/scan", json={})
        for _ in range(500):
            scan = c.get("/api/scan").json()
            if not scan["running"]:
                break
        if scan["report"] is None:
            raise SystemExit("error: the demo scan did not finish")
        exposures = {
            item["credential"]["id"]: c.get(
                f"/api/credentials/{item['credential']['id']}/exposures"
            ).json()
            for item in listing["credentials"]
            if (item["credential"].get("facts") or {}).get("exposure")
        }
        imports = {}
        for finding in scan["report"]["findings"]:
            if not finding["importable"]:
                continue
            result = c.post("/api/scan/import", json={"ids": [finding["id"]]}).json()["results"][0]
            added = next(
                item
                for item in c.get("/api/credentials").json()["credentials"]
                if item["credential"]["id"] == result["credential_id"]
            )
            cid = result["credential_id"]
            imports[finding["id"]] = {
                "result": result,
                "added": added,
                "check": _answer(c.post(f"/api/credentials/{cid}/check?force=true")),
                "probe": _answer(c.post(f"/api/credentials/{cid}/check?mode=active&force=true")),
                "exposures": c.get(f"/api/credentials/{cid}/exposures").json(),
            }

    return {
        "generated_at": listing["generated_at"],
        "scan": scan,
        "scan_imports": imports,
        "exposures": exposures,
        "listing": listing,
        "providers": providers,
        "history": history,
        "check": check,
        "probe": probe,
        "samples": samples,
    }


def render(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    wanted = render(build())
    for sample in SAMPLES:  # no made-up secret in the output, only redacted forms
        if _made_up_secret(sample) in wanted:
            raise SystemExit(f"error: sample {sample['id']}'s made-up secret leaked into the dump")
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != wanted:
            print(
                f"error: {OUT.relative_to(ROOT)} is out of date with demo mode; run "
                "`uv run python scripts/dump_demo.py`",
                file=sys.stderr,
            )
            return 1
        print(f"ok: {OUT.relative_to(ROOT)} matches demo mode")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(wanted, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(wanted) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
