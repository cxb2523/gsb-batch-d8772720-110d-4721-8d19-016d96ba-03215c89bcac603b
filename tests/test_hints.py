from __future__ import annotations

import pytest

from mecha.core.hints import match_unique, matches_hint, split_hint
from tests.fakes import body

KEY = "sk-ant-api03-R2D" + "x" * 80 + "igAA"


@pytest.mark.parametrize(
    "hint",
    [
        "sk-ant-api03-R2D...igAA",  # Anthropic partial_key_hint (docs example)
        "sk-ant-api03-R2D…igAA",
        "sk-ant-api03-...igAA",
        "sk-...igAA",
    ],
)
def test_matches_provider_hint_formats(hint: str) -> None:
    assert matches_hint(KEY, hint)


@pytest.mark.parametrize(
    "hint",
    ["sk-ant-api03-R2E...igAA", "sk-ant-api03-R2D...igAB", "sk-ant-api03-R2D", "...", "s...A", ""],
)
def test_rejects_non_matching_or_weak_hints(hint: str) -> None:
    assert not matches_hint(KEY, hint)


def test_xai_double_star_mask() -> None:
    assert split_hint("xai-a**b") == ("xai-a", "b")
    assert matches_hint("xai-a" + body(40) + "b", "xai-a**b")


def test_a_hint_matching_several_keys_enriches_none() -> None:
    a = "sk-proj-abc" + body(40) + "wxyz"
    b = "sk-proj-abc" + body(40) + "wxyz"
    c = "sk-proj-def" + body(40) + "1234"
    secrets = {"A": a, "B": b, "C": c}
    assert match_unique("sk-proj-abc...wxyz", secrets) is None
    assert match_unique("sk-proj-def...1234", secrets) == "C"
    assert match_unique("sk-proj-zzz...0000", secrets) is None
