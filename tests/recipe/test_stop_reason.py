"""How a run that grows its list in place reports the reason it stopped.

These tests are offline: pages come from a fake fetcher and the "load more" /
scroll calls from a fake session, so no browser is needed.
"""
from scrapewizard.recipe.extract import (
    STOP_COMPLETE, STOP_CONTROL_MISSING, STOP_CONTROL_UNUSABLE, STOP_NO_GROWTH, STOP_NO_NEW_RECORDS,
    run_recipe,
)
from scrapewizard.recipe.fetch import GROWTH_MISSING, GROWTH_NO_CHANGE, GROWTH_UNUSABLE, MoreOutcome
from scrapewizard.recipe.model import Field, Recipe


def page(numbers) -> str:
    cards = "".join(
        f'<div class="product"><h3>Product {n}</h3><span class="cost">${n}.00</span></div>'
        for n in numbers
    )
    return f"<html><body><main>{cards}</main></body></html>"


def make_recipe(**overrides) -> Recipe:
    settings = dict(
        name="shop",
        url="https://shop.test/list",
        container="div.product",
        fields=[Field("title", ["h3"]), Field("price", ["span.cost"])],
        fetch="http",
        pagination={"type": "load_more", "select": "#more", "max_pages": 10},
        checks={"min_records": 1},
    )
    settings.update(overrides)
    return Recipe(**settings)


class FakeSession:
    """Stands in for BrowserSession: hands out scripted click/scroll outcomes."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.clicks = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def open(self, url):
        raise AssertionError("pages should come from the fetcher in these tests")

    def _next(self, action):
        self.clicks.append(action)
        if not self.outcomes:
            return MoreOutcome(problem=GROWTH_MISSING, detail="no scripted outcome left")
        return self.outcomes.pop(0)

    def click_more(self, selector):
        self.clicks.append(selector)
        return self._next("load_more")

    def scroll_more(self):
        return self._next("scroll")


def fake_session(*outcomes):
    """A session_factory that returns one FakeSession holding these outcomes."""
    session = FakeSession(outcomes)
    return lambda: session, session


def first_page_fetcher(html):
    return lambda url, mode: html


def test_button_vanishing_after_some_records_keeps_them_and_says_why():
    first = page(range(1, 4))
    grown = page(range(1, 7))
    factory, _ = fake_session(
        MoreOutcome(html=grown),
        MoreOutcome(problem=GROWTH_MISSING, detail='the "load more" control is no longer on the page'),
    )

    result = run_recipe(make_recipe(), fetcher=first_page_fetcher(first), session_factory=factory, delay=0)

    assert [r["title"] for r in result.records] == [f"Product {n}" for n in range(1, 7)]
    assert result.pages == 2
    assert result.stop == STOP_CONTROL_MISSING
    assert result.aborted and not result.completed
    # ok keeps exactly its old meaning (no check failed); it is not turned into
    # an always-success, and the early stop is read from the new stop fields.
    assert result.ok and result.failures == []
    assert result.stop_detail
    assert result.stop_message.startswith("Stopped after 2 pages with 6 records:")


def test_a_normal_run_to_the_end_is_not_reported_as_aborted():
    first = page(range(1, 4))
    grown_a = page(range(1, 7))
    grown_b = page(range(1, 10))
    factory, _ = fake_session(MoreOutcome(html=grown_a), MoreOutcome(html=grown_b))

    result = run_recipe(
        make_recipe(pagination={"type": "load_more", "select": "#more", "max_pages": 3}),
        fetcher=first_page_fetcher(first), session_factory=factory, delay=0,
    )

    assert len(result.records) == 9
    assert result.pages == 3
    assert result.stop == STOP_COMPLETE
    assert not result.aborted and result.completed
    assert result.ok
    assert "page limit" in result.stop_detail
    assert result.stop_message.startswith("Read 3 pages")


def test_hidden_or_unusable_control_has_its_own_reason():
    factory, _ = fake_session(MoreOutcome(problem=GROWTH_UNUSABLE,
                                          detail='the "load more" control #more is hidden or disabled'))

    result = run_recipe(make_recipe(), fetcher=first_page_fetcher(page(range(1, 4))),
                        session_factory=factory, delay=0)

    assert len(result.records) == 3  # the records already read survive
    assert result.pages == 1
    assert result.stop == STOP_CONTROL_UNUSABLE
    assert "hidden or disabled" in result.stop_detail
    assert result.aborted


def test_click_without_growth_is_told_apart_from_a_missing_control():
    factory, _ = fake_session(MoreOutcome(problem=GROWTH_NO_CHANGE,
                                          detail='clicking "load more" did not add anything to the page'))

    result = run_recipe(make_recipe(), fetcher=first_page_fetcher(page(range(1, 4))),
                        session_factory=factory, delay=0)

    assert result.stop == STOP_NO_GROWTH
    assert "did not add anything" in result.stop_detail
    assert result.aborted and len(result.records) == 3


def test_two_pages_without_new_records_is_an_early_stop():
    first = page(range(1, 4))
    factory, _ = fake_session(MoreOutcome(html=first), MoreOutcome(html=first))

    result = run_recipe(make_recipe(), fetcher=first_page_fetcher(first), session_factory=factory, delay=0)

    assert result.pages == 3
    assert result.stop == STOP_NO_NEW_RECORDS
    assert "no new records" in result.stop_detail
    assert len(result.records) == 3
    assert result.aborted


def test_scroll_that_finds_nothing_more_says_so():
    factory, _ = fake_session(MoreOutcome(problem=GROWTH_MISSING, detail="nothing to scroll to"))

    result = run_recipe(make_recipe(pagination={"type": "scroll", "max_pages": 10}),
                        fetcher=first_page_fetcher(page(range(1, 4))),
                        session_factory=factory, delay=0)

    assert result.stop == STOP_NO_GROWTH
    assert "nothing more to scroll" in result.stop_detail
    assert len(result.records) == 3


def test_a_session_that_answers_the_old_way_still_reports_no_growth():
    """A fake session returning None must not lose the stop reason."""
    factory, _ = fake_session(None, None)

    result = run_recipe(make_recipe(), fetcher=first_page_fetcher(page(range(1, 4))),
                        session_factory=factory, delay=0)

    assert result.stop == STOP_NO_GROWTH
    assert "did not add anything" in result.stop_detail
    assert len(result.records) == 3
    assert result.aborted


def test_recipes_without_in_place_pagination_are_unchanged():
    pages = {
        "https://shop.test/list": page(range(1, 4)).replace(
            "</main>", '<a class="next" href="/list?page=2">next</a></main>'),
        "https://shop.test/list?page=2": page(range(4, 6)),
    }

    result = run_recipe(
        make_recipe(pagination={"type": "next_link", "select": "a.next", "max_pages": 5}),
        fetcher=lambda url, mode: pages[url], delay=0,
    )

    assert result.pages == 2
    assert len(result.records) == 5
    assert result.stop == STOP_COMPLETE
    assert result.ok
    assert "no next page" in result.stop_detail


def test_cli_run_prints_the_stop_reason_and_saves_what_was_read(tmp_path, monkeypatch):
    """End to end through `run`, with a fake browser session: no real browser needed."""
    import csv

    from typer.testing import CliRunner

    import scrapewizard.cli.commands.recipe as cli
    from scrapewizard.cli.main import app
    from scrapewizard.recipe.model import save_recipe

    class FakeBrowser:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def open(self, url):
            return page(range(1, 4))

        def click_more(self, selector):
            return MoreOutcome(problem=GROWTH_MISSING,
                               detail='the "load more" control is no longer on the page')

    monkeypatch.setattr(cli, "BrowserSession", FakeBrowser)
    monkeypatch.chdir(tmp_path)
    recipe = make_recipe(fetch="browser",
                         pagination={"type": "load_more", "select": "#more", "max_pages": 2},
                         checks={"min_records": 1})
    save_recipe(recipe, tmp_path / "shop.recipe.yaml")

    result = CliRunner().invoke(app, ["run", "shop.recipe.yaml"])

    assert result.exit_code == 0, result.output
    assert 'Pagination stopped: the "load more" control was not found' in result.output
    assert "3 rows from 1 page" in result.output
    assert "checks passed, but the list was not followed to its end" in result.output
    with open(tmp_path / "shop.csv", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert [r["title"] for r in rows] == ["Product 1", "Product 2", "Product 3"]
