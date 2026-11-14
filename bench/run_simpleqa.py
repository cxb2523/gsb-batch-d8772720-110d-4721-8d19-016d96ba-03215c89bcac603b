#!/usr/bin/env python3
"""
SimpleQA-20 smoke benchmark for Searcharvester deep-research.

Hits POST /research per question, polls until completed, grades by checking
if the gold answer (or a normalised variant) appears in the produced report.

Usage:
    python3 bench/run_simpleqa.py \
        --adapter http://localhost:8000 \
        --dataset bench/simpleqa_20.jsonl \
        --output bench/results.jsonl \
        --parallel 1

Substring grading is intentionally permissive (case-insensitive, normalises
whitespace/punctuation). Misses mean the agent did NOT find the right answer
or produced an ambiguous one — both are interesting failure modes.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx


def normalise(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def is_correct(gold: str, report: str) -> bool:
    """Substring match of normalised gold in normalised report."""
    if not report:
        return False
    g = normalise(gold)
    r = normalise(report)
    if not g:
        return False
    if g in r:
        return True
    # allow partial — when gold has multiple tokens, any 2+ consecutive tokens
    # is enough (handles minor name formatting differences).
    tokens = g.split()
    if len(tokens) >= 2:
        for n in range(len(tokens), 1, -1):
            for i in range(0, len(tokens) - n + 1):
                phrase = " ".join(tokens[i : i + n])
                if phrase in r:
                    return True
    return False


def run_one(
    client: httpx.Client, adapter: str, q: dict, timeout_s: int, poll_interval: int
) -> dict:
    t0 = time.time()
    res: dict = {"question": q["question"], "gold": q["answer"], "topic": q["topic"]}
    try:
        r = client.post(f"{adapter}/research", json={"query": q["question"]}, timeout=15)
        r.raise_for_status()
        job_id = r.json()["job_id"]
        res["job_id"] = job_id
    except Exception as e:
        res["status"] = "dispatch_error"
        res["error"] = str(e)
        return res

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            s = client.get(f"{adapter}/research/{job_id}", timeout=10).json()
        except Exception as e:
            res["status"] = "poll_error"
            res["error"] = str(e)
            return res
        if s["status"] in ("completed", "failed", "timeout", "cancelled"):
            res["status"] = s["status"]
            res["duration_sec"] = s.get("duration_sec")
            res["report"] = s.get("report") or ""
            res["error_msg"] = s.get("error")
            break
        time.sleep(poll_interval)
    else:
        res["status"] = "bench_timeout"
        res["duration_sec"] = time.time() - t0

    res["correct"] = is_correct(q["answer"], res.get("report", "")) if res.get("status") == "completed" else False
    res["wall_sec"] = round(time.time() - t0, 1)
    return res


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--adapter", default="http://localhost:8000")
    p.add_argument("--dataset", default="bench/simpleqa_20.jsonl")
    p.add_argument("--output", default="bench/results.jsonl")
    p.add_argument("--parallel", type=int, default=1,
                   help="Concurrent research jobs. >1 stresses the stack")
    p.add_argument("--per-job-timeout", type=int, default=600,
                   help="Seconds to wait for each job before giving up")
    p.add_argument("--poll-interval", type=int, default=5)
    args = p.parse_args()

    questions = [json.loads(l) for l in Path(args.dataset).read_text().splitlines() if l.strip()]
    print(f"Running {len(questions)} questions against {args.adapter}, parallel={args.parallel}")

    results: list[dict] = []
    with httpx.Client(timeout=15) as client, open(args.output, "w") as fout:
        if args.parallel == 1:
            for i, q in enumerate(questions, 1):
                r = run_one(client, args.adapter, q, args.per_job_timeout, args.poll_interval)
                results.append(r)
                fout.write(json.dumps(r, ensure_ascii=False) + "\n")
                fout.flush()
                mark = "✓" if r.get("correct") else "✗"
                print(
                    f"[{i:2}/{len(questions)}] {mark} "
                    f"{r['status']:10} {r.get('wall_sec', 0):5.0f}s  "
                    f"{q['question'][:60]!r}  gold={q['answer'][:30]!r}"
                )
        else:
            with ThreadPoolExecutor(max_workers=args.parallel) as pool:
                futs = {
                    pool.submit(run_one, client, args.adapter, q, args.per_job_timeout, args.poll_interval): (i, q)
                    for i, q in enumerate(questions, 1)
                }
                for fut in as_completed(futs):
                    i, q = futs[fut]
                    r = fut.result()
                    results.append(r)
                    fout.write(json.dumps(r, ensure_ascii=False) + "\n")
                    fout.flush()
                    mark = "✓" if r.get("correct") else "✗"
                    print(
                        f"[{i:2}/{len(questions)}] {mark} "
                        f"{r['status']:10} {r.get('wall_sec', 0):5.0f}s  "
                        f"{q['question'][:60]!r}"
                    )

    # Summary
    n = len(results)
    completed = [r for r in results if r["status"] == "completed"]
    correct = [r for r in completed if r["correct"]]
    by_status: dict = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    durations = [r["wall_sec"] for r in results if r.get("wall_sec")]

    print("\n" + "=" * 70)
    print(f"Total:      {n}")
    print(f"Completed:  {len(completed)}  ({100 * len(completed) // n if n else 0}%)")
    print(f"Correct:    {len(correct)}/{n}  ({100 * len(correct) // n if n else 0}%)")
    print(f"Statuses:   {by_status}")
    if durations:
        durations.sort()
        print(f"Duration:   median={durations[len(durations)//2]:.0f}s  "
              f"max={max(durations):.0f}s  "
              f"avg={sum(durations) / len(durations):.1f}s")
    print(f"\nResults in {args.output}")
    return 0 if correct else 1


if __name__ == "__main__":
    sys.exit(main())
