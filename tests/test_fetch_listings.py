"""Offline tests for fetch_listings.py. No network, no Apify token, no money spent.

A FakeApify stands in for the two HTTP functions (start / wait) and hands back
scripted results per keyword. Run with:  python -m pytest tests/   (or unittest)
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_listings as fl


class FakeApify:
    """Scriptable stand-in for Apify. `results` maps a label fragment (the keyword,
    or 'Gumtree') to (status, items, cost) or an Exception to raise."""

    def __init__(self, results):
        self.results = results
        self.started = []  # (actor, run_input, cap_usd) in call order

    def start(self, actor, run_input, cap_usd, tok):
        self.started.append((actor, run_input, cap_usd))
        return {"id": f"run-{len(self.started)}"}

    def wait(self, run, tok, label):
        for fragment, result in self.results.items():
            if fragment in label:
                if isinstance(result, Exception):
                    raise result
                return result
        raise AssertionError(f"FakeApify has no scripted result for '{label}'")

    def fb_started_queries(self, cfg_queries):
        """Which Facebook keywords a run was actually started for, in order."""
        out = []
        for actor, run_input, _cap in self.started:
            if actor != fl.FB_ACTOR:
                continue
            url = run_input["startUrls"][0]["url"]
            out.append(next(q for q in cfg_queries if f"query={q.replace(' ', '%20')}" in url
                            or q in url))
        return out


QUERIES = ["toyota prado", "toyota hilux"]


def make_config(tmp, budget=4.0, results_per_query=150, gt_enabled=True, gt_max_items=200):
    cfg = {
        "price_min": 8000, "price_max": 40000,
        "facebook": {"city_slug": "perth", "queries": QUERIES, "results_per_query": results_per_query},
        "gumtree": {"enabled": gt_enabled, "region": "AU", "location_id": "3008303",
                    "category_id": "18320", "keywords": QUERIES, "max_items": gt_max_items},
        "budget_usd": budget,
    }
    (tmp / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    return cfg


def listings(tag, n):
    return [{"id": f"{tag}-{i}", "title": f"{tag} car {i}"} for i in range(n)]


class FetchListingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for patcher in (mock.patch.dict(os.environ, {"APIFY_TOKEN": "fake-token"}),
                        mock.patch.object(fl, "token", lambda base=None: "fake-token")):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_main(self, fake, argv=("--yes",)):
        out = io.StringIO()
        with mock.patch.object(fl, "start", fake.start), \
             mock.patch.object(fl, "wait", fake.wait), \
             redirect_stdout(out):
            fl.main(list(argv), base=self.tmp)
        return out.getvalue()

    def manifest(self):
        return json.loads((self.tmp / "raw" / "fb_manifest.json").read_text(encoding="utf-8"))

    def fb_json(self):
        return json.loads((self.tmp / "raw" / "fb.json").read_text(encoding="utf-8"))

    def test_all_success(self):
        make_config(self.tmp)
        fake = FakeApify({
            "toyota prado": (fl.SUCCESS, listings("prado", 3), 0.50),
            "toyota hilux": (fl.SUCCESS, listings("hilux", 2), 0.40),
            "Gumtree": (fl.SUCCESS, listings("gt", 4), 0.30),
        })
        out = self.run_main(fake)

        m = self.manifest()
        self.assertEqual(m["keywords"]["toyota prado"]["status"], fl.SUCCESS)
        self.assertEqual(m["keywords"]["toyota hilux"]["status"], fl.SUCCESS)
        self.assertEqual(len(self.fb_json()), 5)
        self.assertEqual(len(json.loads((self.tmp / "raw" / "gt.json").read_text())), 4)
        # every run carried a hard spend cap
        self.assertTrue(all(cap > 0 for *_x, cap in fake.started))
        # summary lists each keyword, its count and cost, plus totals
        self.assertIn("toyota prado", out)
        self.assertIn("toyota hilux", out)
        self.assertIn("US$0.50", out)
        self.assertIn("TOTAL: 5 Facebook + 4 Gumtree", out)
        self.assertIn("US$1.20", out)  # 0.50 + 0.40 + 0.30 spent this run

    def test_partial_failure_then_resume(self):
        make_config(self.tmp)
        # Run 1: hilux fails, prado and gumtree succeed.
        fake1 = FakeApify({
            "toyota prado": (fl.SUCCESS, listings("prado", 3), 0.50),
            "toyota hilux": (fl.FAILED, [], 0.10),
            "Gumtree": (fl.SUCCESS, listings("gt", 4), 0.30),
        })
        out1 = self.run_main(fake1)
        m = self.manifest()
        self.assertEqual(m["keywords"]["toyota prado"]["status"], fl.SUCCESS)
        self.assertEqual(m["keywords"]["toyota hilux"]["status"], fl.FAILED)
        self.assertEqual([x["id"] for x in self.fb_json()], [f"prado-{i}" for i in range(3)])
        self.assertIn("'toyota hilux'", out1)  # named as not done

        # Run 2 (resume): only hilux is fetched; prado is kept, not re-bought.
        fake2 = FakeApify({"toyota hilux": (fl.SUCCESS, listings("hilux", 2), 0.40)})
        out2 = self.run_main(fake2)
        self.assertEqual(fake2.fb_started_queries(QUERIES), ["toyota hilux"])
        self.assertEqual(self.manifest()["keywords"]["toyota hilux"]["status"], fl.SUCCESS)
        ids = [x["id"] for x in self.fb_json()]
        self.assertEqual(ids, [f"prado-{i}" for i in range(3)] + [f"hilux-{i}" for i in range(2)])
        self.assertEqual(len(ids), len(set(ids)), "resume must not duplicate listings")
        self.assertIn("kept from earlier run", out2)

        # Run 3 (--force): both keywords fetched again even though both succeeded.
        fake3 = FakeApify({
            "toyota prado": (fl.SUCCESS, listings("prado2", 1), 0.20),
            "toyota hilux": (fl.SUCCESS, listings("hilux2", 1), 0.20),
            "Gumtree": (fl.SUCCESS, listings("gt", 1), 0.10),
        })
        self.run_main(fake3, argv=("--yes", "--force"))
        self.assertEqual(fake3.fb_started_queries(QUERIES), QUERIES)
        self.assertEqual([x["id"] for x in self.fb_json()], ["prado2-0", "hilux2-0"])

    def test_budget_skip(self):
        # Budget passes the up-front worst-case check (2*150*0.0062 + 200*0.00175 = 2.21)
        # but can't cover two fully-capped Facebook runs (cap = 1.166 each).
        make_config(self.tmp, budget=2.30)
        fake = FakeApify({
            "toyota prado": (fl.SUCCESS, listings("prado", 3), 1.16),
            "Gumtree": (fl.SUCCESS, listings("gt", 2), 0.30),
        })
        out = self.run_main(fake)

        m = self.manifest()
        self.assertEqual(m["keywords"]["toyota prado"]["status"], fl.SUCCESS)
        self.assertEqual(m["keywords"]["toyota hilux"]["status"], fl.BUDGET_SKIPPED)
        # no run was ever started for the skipped keyword
        self.assertEqual(fake.fb_started_queries(QUERIES), ["toyota prado"])
        self.assertEqual(len(self.fb_json()), 3)
        self.assertIn("budget-skipped", out)
        self.assertIn("toyota hilux", out)

    def test_gumtree_failure_keeps_facebook_results(self):
        make_config(self.tmp)
        (self.tmp / "raw").mkdir()
        (self.tmp / "raw" / "gt.json").write_text(json.dumps(listings("old-gt", 2)), encoding="utf-8")
        fake = FakeApify({
            "toyota prado": (fl.SUCCESS, listings("prado", 3), 0.50),
            "toyota hilux": (fl.SUCCESS, listings("hilux", 2), 0.40),
            "Gumtree": (fl.TIMED_OUT, [], 0.10),
        })
        out = self.run_main(fake)

        self.assertEqual(len(self.fb_json()), 5)  # Facebook results saved regardless
        self.assertEqual(len(json.loads((self.tmp / "raw" / "gt.json").read_text())), 2)  # old gt.json untouched
        self.assertIn("timed-out", out)
        self.assertIn("Gumtree", out)

    def test_over_budget_refuses_before_spending(self):
        make_config(self.tmp, budget=1.00)  # worst case 2.21 > 1.00
        fake = FakeApify({})
        with mock.patch.object(fl, "start", fake.start), mock.patch.object(fl, "wait", fake.wait), \
             redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                fl.main(["--yes"], base=self.tmp)
        self.assertEqual(fake.started, [])  # nothing was started, nothing spent


if __name__ == "__main__":
    unittest.main()
