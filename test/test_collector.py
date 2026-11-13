"""Offline tests for hasdata_yellowpages_mcp.collector.

All search responses come from local fake invokers; no network access and no
API credits are consumed. Run with: python -m unittest test.test_collector -v
"""
import unittest

from hasdata_yellowpages_mcp.collector import collect, failed_pages


def make_biz(name, **overrides):
    biz = {
        "name": name,
        "rating": 4.5,
        "reviews": 12,
        "address": "1 Main St",
        "phone": "555-0100",
        "website": "https://example.com",
        "workingHours": "Mon-Fri 9am-5pm",
        "categories": ["Plumber"],
    }
    biz.update(overrides)
    return biz


class FakeInvoker:
    """Local stand-in for call(keyword, location, page, sort, domain).

    Serves payloads from a {page: payload} mapping and records every argument
    it receives so tests can assert only page numbers are used for paging.
    """

    def __init__(self, payloads, fail_on=()):
        self.payloads = payloads
        self.fail_on = set(fail_on)
        self.calls = []

    def __call__(self, keyword, location, page, sort, domain):
        self.calls.append((keyword, location, page, sort, domain))
        if page in self.fail_on:
            raise ConnectionError(f"boom on page {page}")
        if page not in self.payloads:
            raise AssertionError(f"unexpected page requested: {page}")
        return self.payloads[page]


def page_payload(results, total_pages=None):
    payload = {"organicResults": results}
    pagination = {}
    if total_pages is not None:
        pagination["totalPages"] = total_pages
    # These URLs must never be sent back as request parameters.
    pagination["nextPageUrl"] = "https://example.com/search?page=NEXT"
    pagination["otherPageUrls"] = ["https://example.com/search?page=2"]
    payload["pagination"] = pagination
    return payload


class NormalPaginationTest(unittest.TestCase):
    def test_paginates_until_total_pages(self):
        invoker = FakeInvoker({
            1: page_payload([make_biz("A"), make_biz("B")], total_pages=3),
            2: page_payload([make_biz("C")], total_pages=3),
            3: page_payload([make_biz("D")], total_pages=3),
        })
        summary = collect("plumber", "Austin, TX", sort="rating", domain="yellowpages.com",
                          max_pages=10, call=invoker)

        self.assertEqual([r["page"] for r in summary["pages"]], [1, 2, 3])
        self.assertTrue(all(r["status"] == "success" for r in summary["pages"]))
        self.assertEqual([r["result_count"] for r in summary["pages"]], [2, 1, 1])
        self.assertEqual([r["name"] for r in summary["results"]], ["A", "B", "C", "D"])
        self.assertEqual(failed_pages(summary), [])

        # Paging is by incrementing page number only; URLs are never passed back.
        requested_pages = [c[2] for c in invoker.calls]
        self.assertEqual(requested_pages, [1, 2, 3])
        for call_args in invoker.calls:
            self.assertEqual(call_args[0], "plumber")
            self.assertEqual(call_args[1], "Austin, TX")
            self.assertIsInstance(call_args[2], int)
            self.assertEqual(call_args[3], "rating")
            self.assertEqual(call_args[4], "yellowpages.com")
            self.assertNotIn("http", str(call_args[2]))

    def test_stops_at_max_pages(self):
        invoker = FakeInvoker({
            1: page_payload([make_biz("A")], total_pages=9),
            2: page_payload([make_biz("B")], total_pages=9),
        })
        summary = collect("plumber", "Austin, TX", max_pages=2, call=invoker)
        self.assertEqual([r["page"] for r in summary["pages"]], [1, 2])
        self.assertEqual(len(invoker.calls), 2)

    def test_stops_on_empty_page(self):
        invoker = FakeInvoker({
            1: page_payload([make_biz("A")], total_pages=9),
            2: page_payload([], total_pages=9),
        })
        summary = collect("plumber", "Austin, TX", max_pages=10, call=invoker)
        self.assertEqual([r["page"] for r in summary["pages"]], [1, 2])
        self.assertEqual(summary["pages"][1]["result_count"], 0)
        self.assertEqual([r["name"] for r in summary["results"]], ["A"])

    def test_start_page_is_respected(self):
        invoker = FakeInvoker({
            3: page_payload([make_biz("A")], total_pages=3),
        })
        summary = collect("plumber", "Austin, TX", start_page=3, max_pages=5, call=invoker)
        self.assertEqual([c[2] for c in invoker.calls], [3])
        self.assertEqual([r["page"] for r in summary["pages"]], [3])


class MissingFieldsTest(unittest.TestCase):
    def test_missing_fields_become_none_and_do_not_raise(self):
        sparse = {"name": "No Frills LLC"}  # no rating/reviews/address/workingHours/categories
        invoker = FakeInvoker({1: page_payload([sparse], total_pages=1)})
        summary = collect("plumber", "Austin, TX", call=invoker)

        (result,) = summary["results"]
        self.assertEqual(result["name"], "No Frills LLC")
        self.assertIsNone(result["rating"])
        self.assertIsNone(result["reviews"])
        self.assertIsNone(result["address"])
        self.assertIsNone(result["workingHours"])
        self.assertEqual(result["categories"], [])

    def test_reviews_must_be_an_integer_count(self):
        results = [
            make_biz("Good", reviews=37),
            make_biz("NoCount", rating=4.9),  # rating must not stand in for reviews
            make_biz("FloatCount", reviews=4.5),
            make_biz("StringCount", reviews="28"),
            make_biz("BoolCount", reviews=True),
        ]
        # strip reviews key entirely for the "NoCount" entry
        del results[1]["reviews"]
        invoker = FakeInvoker({1: page_payload(results, total_pages=1)})
        summary = collect("plumber", "Austin, TX", call=invoker)

        by_name = {r["name"]: r for r in summary["results"]}
        self.assertEqual(by_name["Good"]["reviews"], 37)
        self.assertIsNone(by_name["NoCount"]["reviews"])
        self.assertIsNone(by_name["FloatCount"]["reviews"])
        self.assertEqual(by_name["StringCount"]["reviews"], 28)
        self.assertIsNone(by_name["BoolCount"]["reviews"])

    def test_categories_stays_a_list(self):
        results = [
            make_biz("Multi", categories=["Plumber", "HVAC"]),
            make_biz("NotAList", categories="Plumber"),
        ]
        invoker = FakeInvoker({1: page_payload(results, total_pages=1)})
        summary = collect("plumber", "Austin, TX", call=invoker)

        by_name = {r["name"]: r for r in summary["results"]}
        self.assertEqual(by_name["Multi"]["categories"], ["Plumber", "HVAC"])
        self.assertEqual(by_name["NotAList"]["categories"], [])


class FailedPageRerunTest(unittest.TestCase):
    def test_failed_page_is_recorded_and_rerun_merges(self):
        payloads = {
            1: page_payload([make_biz("A"), make_biz("B")], total_pages=3),
            2: page_payload([make_biz("C")], total_pages=3),
            3: page_payload([make_biz("D")], total_pages=3),
        }
        # First run: page 2 blows up; the run stops there with page 1 kept.
        first = collect("plumber", "Austin, TX", max_pages=10,
                        call=FakeInvoker(payloads, fail_on={2}))
        self.assertEqual([r["page"] for r in first["pages"]], [1, 2])
        self.assertEqual(first["pages"][0]["status"], "success")
        self.assertEqual(first["pages"][1]["status"], "failed")
        self.assertIn("ConnectionError", first["pages"][1]["error"])
        self.assertEqual([r["name"] for r in first["results"]], ["A", "B"])
        self.assertEqual(failed_pages(first), [2])

        # Rerun only the failed page; pages 1 and 3 are not requested again.
        retry_invoker = FakeInvoker(payloads)
        merged = collect("plumber", "Austin, TX", call=retry_invoker,
                         pages=failed_pages(first), summary=first)
        self.assertEqual([c[2] for c in retry_invoker.calls], [2])

        self.assertEqual([r["page"] for r in merged["pages"]], [1, 2])
        self.assertTrue(all(r["status"] == "success" for r in merged["pages"]))
        self.assertEqual([r["name"] for r in merged["results"]], ["A", "B", "C"])
        self.assertEqual(failed_pages(merged), [])

        # Continue the sequential run from page 3 against the merged summary.
        rest_invoker = FakeInvoker(payloads)
        final = collect("plumber", "Austin, TX", start_page=3, max_pages=10,
                        call=rest_invoker, summary=merged)
        self.assertEqual([c[2] for c in rest_invoker.calls], [3])
        self.assertEqual([r["page"] for r in final["pages"]], [1, 2, 3])
        self.assertEqual([r["name"] for r in final["results"]], ["A", "B", "C", "D"])

    def test_rerun_of_still_failing_page_keeps_failure_recorded(self):
        payloads = {1: page_payload([make_biz("A")], total_pages=2)}
        first = collect("plumber", "Austin, TX", call=FakeInvoker(payloads, fail_on={2}))
        self.assertEqual(failed_pages(first), [2])

        second = collect("plumber", "Austin, TX",
                         call=FakeInvoker(payloads, fail_on={2}),
                         pages=failed_pages(first), summary=first)
        self.assertEqual(failed_pages(second), [2])
        # Page 1 data survives both runs.
        self.assertEqual([r["name"] for r in second["results"]], ["A"])


if __name__ == "__main__":
    unittest.main()
