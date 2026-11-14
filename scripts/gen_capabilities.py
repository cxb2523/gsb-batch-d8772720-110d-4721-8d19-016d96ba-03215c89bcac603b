"""Generate the README capability table from ``src/mecha/data/capabilities.toml``.

Usage:
    uv run python scripts/gen_capabilities.py           # rewrite the table in README.md
    uv run python scripts/gen_capabilities.py --check   # fail (exit 1) if it is out of date

The table lives between ``<!-- capabilities:start -->`` and ``<!-- capabilities:end -->``.
CI runs ``--check`` so the README can never promise something the matrix does not say.
"""

from __future__ import annotations

import sys
from pathlib import Path

from mecha.core.capabilities import Level, load_capabilities, load_probes
from mecha.core.models import CredentialKind

ROOT = Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
START, END = "<!-- capabilities:start -->", "<!-- capabilities:end -->"

LEVEL: dict[Level, str] = {
    "yes": "yes",
    "no": "no",
    "admin_key": "with an admin key",
    "management_key": "with a management key",
    "admin_estimate": "estimated, with an admin key",
    "error_only": "only when it fails",
}
KIND = {
    CredentialKind.api_key: "API key",
    CredentialKind.admin_key: "admin key",
    CredentialKind.management_key: "management key",
}


def table() -> str:
    probes = load_probes()
    rows = [
        "| Provider | Validates | Funds | Expiry | Free check | Active probe (opt-in) |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for pid, caps in load_capabilities().items():
        passive = "<br>".join(
            f"{KIND.get(kind, kind.value)}: `{endpoint}`" for kind, endpoint in caps.passive.items()
        )
        probe = probes.get(pid)
        if probe is None:
            active = caps.active_probe
        else:
            per_thousand = (probe.usd_per_probe() * 1000).normalize()
            active = (
                f"`{probe.endpoint}`, `{probe.default_model}`: "
                f"{per_thousand:f} USD per 1,000 probes"
            )
        rows.append(
            f"| {caps.name} | {LEVEL[caps.validate_]} | {LEVEL[caps.funds]} "
            f"| {LEVEL[caps.expiry]} | {passive} | {active} |"
        )
    dates = sorted({str(p.prices_checked) for p in probes.values()})
    note = (
        f"Probe prices from each provider's pricing page, checked {', '.join(dates)}. "
        "Generated from `src/mecha/data/capabilities.toml` by `scripts/gen_capabilities.py`; "
        "do not edit by hand."
    )
    return "\n".join([START, "", *rows, "", note, "", END])


def render(readme: str) -> str:
    if START not in readme or END not in readme:
        raise SystemExit(f"error: {README.name} has no {START} ... {END} block")
    head, rest = readme.split(START, 1)
    _, tail = rest.split(END, 1)
    return head + table() + tail


def main() -> int:
    current = README.read_text(encoding="utf-8")
    wanted = render(current)
    if "--check" in sys.argv:
        if current != wanted:
            print(
                "error: the README capability table is out of date; run "
                "`uv run python scripts/gen_capabilities.py`",
                file=sys.stderr,
            )
            return 1
        print("ok: README capability table matches capabilities.toml")
        return 0
    README.write_text(wanted, encoding="utf-8")
    print(f"wrote the capability table in {README.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
