from unittest.mock import patch

import requests

from src.linkcheck import check_link, partition_alive


def _resp(status, text=""):
    from types import SimpleNamespace

    return SimpleNamespace(status_code=status, text=text)


LIVE_PAGE = '<html><li class="list-group-item">movie.mkv</li></html>'
DEAD_PAGE = "<html><h3>404! Page Not Found</h3>The file you are trying to download is no longer available!</html>"


class TestCheckLink:
    def test_live_page_alive(self):
        with patch("src.linkcheck.requests.get", return_value=_resp(200, LIVE_PAGE)):
            assert check_link("https://driveseed.org/file/abc") == "alive"

    def test_404_marker_dead(self):
        with patch("src.linkcheck.requests.get", return_value=_resp(200, DEAD_PAGE)):
            assert check_link("https://driveseed.org/zfile/bDXuke3VI02Wi9fOtoVR") == "dead"

    def test_status_404_dead(self):
        with patch("src.linkcheck.requests.get", return_value=_resp(404, "")):
            assert check_link("https://driveseed.org/file/abc") == "dead"

    def test_status_500_unknown(self):
        with patch("src.linkcheck.requests.get", return_value=_resp(500, "")):
            assert check_link("https://driveseed.org/file/abc") == "unknown"

    def test_timeout_unknown(self):
        with patch(
            "src.linkcheck.requests.get", side_effect=requests.Timeout("slow")
        ):
            assert check_link("https://driveseed.org/file/abc") == "unknown"

    def test_retry_then_alive(self):
        with patch(
            "src.linkcheck.requests.get",
            side_effect=[requests.Timeout("slow"), _resp(200, LIVE_PAGE)],
        ):
            assert check_link("https://driveseed.org/file/abc") == "alive"

    def test_sends_browser_headers(self):
        with patch("src.linkcheck.requests.get", return_value=_resp(200, LIVE_PAGE)) as m:
            check_link("https://driveseed.org/file/abc")
            assert "Chrome" in m.call_args.kwargs["headers"]["User-Agent"]


class TestPartitionAlive:
    def _fake_get(self, verdicts: dict[str, str]):
        """Build a fake requests.get dispatching on the trailing url segment."""

        def get(url, **_kwargs):
            kind = verdicts[url.rsplit("/", 1)[-1]]
            if kind == "alive":
                return _resp(200, LIVE_PAGE)
            if kind == "dead404":
                return _resp(404, "")
            if kind == "deadmarker":
                return _resp(200, DEAD_PAGE)
            if kind == "unknown500":
                return _resp(500, "")
            if kind == "timeout":
                raise requests.Timeout("slow")
            if kind == "boom":
                raise ValueError("unexpected failure")
            raise AssertionError(f"unhandled kind {kind}")

        return get

    def test_groups_verdicts(self):
        verdicts = {"a": "alive", "b": "dead404", "c": "timeout"}
        urls = [f"https://driveseed.org/{name}" for name in verdicts]
        with patch("src.linkcheck.requests.get", side_effect=self._fake_get(verdicts)):
            assert partition_alive(urls) == (
                ["https://driveseed.org/a"],
                ["https://driveseed.org/b"],
                ["https://driveseed.org/c"],
            )

    def test_mixed_three_states_grouping_and_order(self):
        verdicts = {
            "a1": "alive",
            "d1": "dead404",
            "a2": "alive",
            "u1": "timeout",
            "d2": "deadmarker",
            "u2": "unknown500",
            "a3": "alive",
        }
        urls = [f"https://driveseed.org/{name}" for name in verdicts]
        with patch("src.linkcheck.requests.get", side_effect=self._fake_get(verdicts)):
            alive, dead, unknown = partition_alive(urls, max_workers=3)
        assert alive == [
            "https://driveseed.org/a1",
            "https://driveseed.org/a2",
            "https://driveseed.org/a3",
        ]
        assert dead == ["https://driveseed.org/d1", "https://driveseed.org/d2"]
        assert unknown == ["https://driveseed.org/u1", "https://driveseed.org/u2"]

    def test_concurrency_cap_is_enforced(self):
        import threading

        state = {"current": 0, "peak": 0}
        lock = threading.Lock()
        release = threading.Event()
        cap = 3

        def probe(url, timeout=15):
            with lock:
                state["current"] += 1
                state["peak"] = max(state["peak"], state["current"])
                if state["current"] >= cap:
                    release.set()
            # Hold the slot until the pool has actually reached the cap.
            release.wait(timeout=2)
            with lock:
                state["current"] -= 1
            return "alive"

        urls = [f"u{i}" for i in range(9)]
        with patch("src.linkcheck.check_link", side_effect=probe):
            alive, dead, unknown = partition_alive(urls, max_workers=cap)
        assert state["peak"] == cap
        assert alive == urls and dead == [] and unknown == []

    def test_concurrency_cap_one_is_serial(self):
        import threading

        state = {"current": 0, "peak": 0}
        lock = threading.Lock()

        def probe(url, timeout=15):
            with lock:
                state["current"] += 1
                state["peak"] = max(state["peak"], state["current"])
            with lock:
                state["current"] -= 1
            return "alive"

        with patch("src.linkcheck.check_link", side_effect=probe):
            partition_alive(["a", "b", "c"], max_workers=1)
        assert state["peak"] == 1

    def test_single_exception_degrades_to_unknown(self):
        verdicts = {"a": "alive", "boom": "boom", "d": "dead404"}
        urls = [f"https://driveseed.org/{name}" for name in verdicts]
        with patch("src.linkcheck.requests.get", side_effect=self._fake_get(verdicts)):
            alive, dead, unknown = partition_alive(urls, max_workers=2)
        assert alive == ["https://driveseed.org/a"]
        assert dead == ["https://driveseed.org/d"]
        assert unknown == ["https://driveseed.org/boom"]

    def test_empty_input_returns_three_empty_lists(self):
        with patch("src.linkcheck.check_link") as m:
            assert partition_alive([]) == ([], [], [])
        m.assert_not_called()

    def test_timeout_is_passed_through(self):
        with patch("src.linkcheck.check_link", return_value="alive") as m:
            partition_alive(["a", "b"], timeout=7, max_workers=2)
        assert all(call.kwargs["timeout"] == 7 for call in m.call_args_list)

    def test_each_verdict_and_summary_logged(self, caplog):
        import logging

        caplog.set_level(logging.INFO, logger="src.linkcheck")
        verdicts = {"a": "alive", "boom": "boom", "u": "timeout"}
        urls = [f"https://driveseed.org/{name}" for name in verdicts]
        with patch("src.linkcheck.requests.get", side_effect=self._fake_get(verdicts)):
            partition_alive(urls, max_workers=2)
        text = caplog.text
        assert "ALIVE https://driveseed.org/a" in text
        assert "UNKNOWN https://driveseed.org/boom" in text
        assert "ValueError" in text
        assert "UNKNOWN https://driveseed.org/u" in text
        assert "Timeout" in text
        assert "Link check: 1 alive, 0 dead, 2 unknown of 3" in text
