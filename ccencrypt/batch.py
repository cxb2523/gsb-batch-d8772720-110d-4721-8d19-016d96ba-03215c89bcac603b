"""Batch token collection across processors.

run_batch() executes a list of tokenisation jobs, reporting a per-job
outcome instead of raising on the first failure.  The returned manifest
lists only the failed job ids and can be handed to resume_batch() to
re-run exactly those jobs — jobs that already succeeded are never
requested again.
"""

import re

import requests

from ccencrypt.braintree import ccbraintree
from ccencrypt.paydock import ccpaydock
from ccencrypt.shopify import ccshopify
from ccencrypt.stripe import ccstripe

PROCESSORS = ("stripe", "braintree", "paydock", "shopify")

# Card fields every job must carry, plus the credential fields each
# processor needs before a request may be sent.
_COMMON_FIELDS = ("card", "month", "year", "cvv")
_REQUIRED_FIELDS = {
    "stripe": ("key",),
    "braintree": ("client_token",),
    "paydock": ("public_key", "name"),
    "shopify": ("domain", "name"),
}

# Status code each processor returns on success; a RuntimeError carrying
# that code means the HTTP call worked but no token came back.
_SUCCESS_STATUS = {"stripe": 200, "braintree": 200, "paydock": 201, "shopify": 200}

_ERROR_RE = re.compile(r"^\w+ failed: (\d+) (.*)$", re.S)

MAX_RESPONSE_CHARS = 300


def _missing_fields(job):
    missing = [f for f in _COMMON_FIELDS if not str(job.get(f) or "").strip()]
    for f in _REQUIRED_FIELDS.get(job.get("processor"), ()):
        if not str(job.get(f) or "").strip():
            missing.append(f)
    return missing


def _dispatch(job, proxy, timeout, user_agent):
    """Call the single-processor function without changing its signature."""
    p = job["processor"]
    args = (job["card"], job["month"], job["year"], job["cvv"])
    kwargs = {"user_agent": user_agent, "proxy": proxy, "timeout": timeout}
    if p == "stripe":
        return ccstripe(job["key"], *args, name=job.get("name") or "",
                        account=job.get("account"), **kwargs)
    if p == "braintree":
        return ccbraintree(job["client_token"], *args, name=job.get("name") or "", **kwargs)
    if p == "paydock":
        return ccpaydock(job["public_key"], *args, job["name"],
                         gateway_id=job.get("gateway_id") or "", **kwargs)
    if p == "shopify":
        return ccshopify(job["domain"], *args, job["name"], **kwargs)
    raise ValueError(f"unsupported processor: {p!r}")


def _classify(exc, processor):
    """Map an exception from a single-processor call to an error record."""
    if isinstance(exc, RuntimeError):
        m = _ERROR_RE.match(str(exc))
        if m:
            status = int(m.group(1))
            response = m.group(2)[:MAX_RESPONSE_CHARS]
            etype = "empty_token" if status == _SUCCESS_STATUS.get(processor) else "http_error"
            return {"type": etype, "status_code": status, "response": response}
    return {"type": "http_error", "status_code": None, "response": str(exc)[:MAX_RESPONSE_CHARS]}


def _run(jobs, proxy, timeout, user_agent):
    results = []
    seen = set()
    for job in jobs:
        jid = job.get("id")
        if jid in seen:
            results.append({"id": jid, "status": "skipped", "reason": "duplicate_id"})
            continue
        seen.add(jid)

        processor = job.get("processor")
        if processor not in PROCESSORS:
            results.append({"id": jid, "status": "failed",
                            "error": {"type": "invalid_processor", "processor": processor}})
            continue

        missing = _missing_fields(job)
        if missing:
            results.append({"id": jid, "status": "failed",
                            "error": {"type": "missing_field", "fields": missing}})
            continue

        try:
            token = _dispatch(job, proxy, timeout, user_agent)
        except (RuntimeError, requests.RequestException) as exc:
            results.append({"id": jid, "status": "failed", "error": _classify(exc, processor)})
        else:
            results.append({"id": jid, "status": "ok", "token": token})
    return results


def _wrap(results):
    return {
        "results": results,
        "manifest": {"failed": [r["id"] for r in results if r["status"] == "failed"]},
    }


def run_batch(jobs, proxy=None, timeout=30, user_agent=None):
    """Run every job once, in order, and report each outcome.

    Returns {"results": [...], "manifest": {"failed": [id, ...]}}.
    """
    return _wrap(_run(jobs, proxy, timeout, user_agent))


def resume_batch(manifest, jobs, proxy=None, timeout=30, user_agent=None):
    """Re-run only the jobs whose ids are listed in manifest["failed"].

    Raises ValueError if the manifest references an id that is not
    present in jobs, instead of silently dropping it.
    """
    failed_ids = manifest.get("failed", []) if isinstance(manifest, dict) else list(manifest)
    by_id = {}
    for job in jobs:
        by_id.setdefault(job.get("id"), job)
    unknown = [i for i in failed_ids if i not in by_id]
    if unknown:
        raise ValueError(f"manifest references ids not present in jobs: {unknown}")
    return _wrap(_run([by_id[i] for i in failed_ids], proxy, timeout, user_agent))
