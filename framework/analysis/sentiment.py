#!/usr/bin/env python3
"""
sentiment.py — Sentiment analysis lens (comments → structured sentiment → features table)

⭐ Model selection rationale: multi-model bake-off on real multilingual data with
   separate judging (write/judge separation). Primary model uses a single unified scale;
   reviewer model gives a second opinion only on hard samples (sarcasm / ambiguous intensity).

⭐ Cross-language comparison rule: the primary model must use a single unified scale —
   otherwise "0.8 in English" ≠ "0.8 in Chinese" and cross-language comparisons are invalid.
   The reviewer supplements only for hard samples; it does not participate in the primary scale.

Reliability: sentiment classification falls in the "pattern recognition ★★★ (medium)" tier —
             suitable for trend comparison, not precise verdicts.

Usage: import as a library — functions operate on the 5-table schema, called by xhs analysis
       and user scripts.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

from framework.store import Store

_BASE = os.environ.get("PRISM_LLM_BASE", "http://localhost:4000/v1")
ENDPOINT = _BASE + "/chat/completions"
PRIMARY = os.environ.get("PRISM_LLM_PRIMARY", "primary-model")
REVIEWER = os.environ.get("PRISM_LLM_REVIEWER", "reviewer-model")

_PROMPT_HEAD = (
    "You are a multilingual sentiment analyst. Analyze each social media comment below. "
    "Output a JSON array only — no surrounding prose.\n"
    "Fields per item: id(int), polarity(positive/negative/neutral), intensity(0.0-1.0), "
    "emotion(one of anger/support/mockery/sarcasm/doubt/joy/sadness/neutral), "
    "toward, note(one sentence of reasoning, in the language of the comment; "
    "say so explicitly when the comment is sarcasm or irony).\n\nComments:\n")


def _call(model: str, prompt: str, max_tokens: int = 4000) -> str:
    """Call an OpenAI-compatible LLM endpoint. max_tokens is set generously to prevent thinking budget exhaustion."""
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
                       "max_tokens": max_tokens, "temperature": 0}).encode()
    req = urllib.request.Request(ENDPOINT, data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer sk-x"})
    r = urllib.request.urlopen(req, timeout=280)
    return json.loads(r.read())["choices"][0]["message"].get("content") or ""


def _extract_json(raw: str) -> list:
    """Extract a JSON array from model output (handles ```json fencing)."""
    m = re.search(r"\[\s*\{.*\}\s*\]", raw, re.DOTALL)
    if not m:
        return []
    try:
        return json.loads(m.group(0))
    except Exception:
        return []


def _fmt(rows) -> str:
    return "\n".join(f"[{j+1}]({r[3] or '?'}) {' '.join((r[2] or '').split())[:260]}"
                     for j, r in enumerate(rows))


def analyze(store: Store, platform: str, item_ids: list[str],
            batch: int = 8, escalate: bool = True) -> dict:
    """Batch primary analysis + (optional) escalation for hard samples.

    Writes to features:
        feature_set='comment_sentiment'        source=<primary model>   (primary judgment, scope='text')
        feature_set='comment_sentiment_review' source=<reviewer model>  (hard-sample second opinion)
    Idempotent: deletes existing sentiment features for the given comments before re-running.
    """
    qs = ",".join("?" * len(item_ids))
    rows = store.con.execute(
        f"SELECT id, ref_id, content, lang FROM texts "
        f"WHERE platform=? AND text_type='comment' AND ref_id IN ({qs}) "
        f"AND LENGTH(content) > 3",
        (platform, *item_ids)).fetchall()

    for tid, *_ in rows:
        store.con.execute(
            "DELETE FROM features WHERE platform=? AND scope='text' AND ref_id=? "
            "AND feature_set IN ('comment_sentiment','comment_sentiment_review')",
            (platform, str(tid)))

    stats = {"comments": len(rows), "analyzed": 0, "escalated": 0}
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        result = _extract_json(_call(PRIMARY, _PROMPT_HEAD + _fmt(chunk)))
        for j, r in enumerate(chunk):
            tid = r[0]
            rec = next((x for x in result if x.get("id") == j + 1), None)
            if not rec:
                continue
            store.add_feature(platform, "text", str(tid), "comment_sentiment",
                              rec, PRIMARY)
            stats["analyzed"] += 1
            if escalate:
                emo = rec.get("emotion")
                try:
                    inten = float(rec.get("intensity") or 0)
                except (TypeError, ValueError):
                    inten = 0.0
                if emo in ("sarcasm", "mockery") or 0.4 <= inten <= 0.6:
                    rev = _extract_json(_call(REVIEWER, _PROMPT_HEAD + _fmt([r]), 6000))
                    if rev:
                        store.add_feature(platform, "text", str(tid),
                                          "comment_sentiment_review", rev[0], REVIEWER)
                        stats["escalated"] += 1
    return stats


def distribution(store: Store, platform: str) -> dict:
    """Aggregate sentiment distribution (primary judgments only)."""
    pol = dict(store.con.execute(
        "SELECT json_extract(feature_json,'$.polarity'), COUNT(*) FROM features "
        "WHERE platform=? AND feature_set='comment_sentiment' GROUP BY 1", (platform,)))
    emo = dict(store.con.execute(
        "SELECT json_extract(feature_json,'$.emotion'), COUNT(*) FROM features "
        "WHERE platform=? AND feature_set='comment_sentiment' GROUP BY 1 "
        "ORDER BY 2 DESC", (platform,)))
    return {"polarity": pol, "emotion": emo}
