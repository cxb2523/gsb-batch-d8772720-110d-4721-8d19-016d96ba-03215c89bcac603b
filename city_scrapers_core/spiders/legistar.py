from collections import defaultdict
from datetime import datetime
from typing import Dict, Iterable, List, Union
from urllib.parse import parse_qs, urlencode

import scrapy

from ..items import Meeting
from .spider import CityScrapersSpider

LINK_TYPES = ["Agenda", "Minutes", "Video", "Summary", "Captions"]

#: Outcome of processing a single requested year.
LEGISTAR_YEAR_SUCCESS = "success"
LEGISTAR_YEAR_RETRY_SUCCESS = "retry_success"
LEGISTAR_YEAR_FAILED = "failed"

#: Number of additional attempts used for a year request when nothing is configured.
DEFAULT_LEGISTAR_MAX_RETRIES = 3

#: Setting that overrides :attr:`LegistarSpider.legistar_max_retries`.
LEGISTAR_MAX_RETRIES_SETTING = "LEGISTAR_MAX_RETRIES"


class LegistarPageError(Exception):
    """Raised when a Legistar events page is missing its expected structure."""


class LegistarSpider(CityScrapersSpider):
    """Subclass of :class:`CityScrapersSpider` that handles processing Legistar sites,
    which almost always share the same components and general structure.

    Any methods that don't pull the correct values can be replaced.
    """  # noqa

    link_types = []

    #: Extra attempts allowed for each year's event request before that year is
    #: marked as failed. ``None`` (the default) falls back to the
    #: ``LEGISTAR_MAX_RETRIES`` setting and then to
    #: :data:`DEFAULT_LEGISTAR_MAX_RETRIES`.
    legistar_max_retries = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Can override since_year (via a class attribute or ``-a since_year=...``)
        # to start earlier
        if not hasattr(self, "since_year"):
            self.since_year = datetime.now().year - 1
        self._scraped_urls = set()
        # Mapping of year -> LEGISTAR_YEAR_* outcome, plus pages that couldn't be
        # parsed. Both are exposed so callers (and tests) can inspect the crawl.
        self.legistar_year_outcomes = {}
        self.legistar_failed_pages = []
        self._legistar_retried_years = set()

    def parse(self, response: scrapy.http.Response) -> Iterable[scrapy.Request]:
        """Creates initial event requests for each queried year.

        Each year is requested independently, so a failure for one year (after its
        retries are exhausted) does not prevent the remaining years from being
        requested.

        :param response: Scrapy response to be ignored
        :return: Iterable of ``Request`` objects for event pages
        """

        secrets = self._parse_secrets(response)
        for year in self.legistar_years():
            yield self._legistar_year_request(response.url, secrets, year)

    def legistar_years(self) -> List[int]:
        """Years for which event pages will be requested, oldest first."""
        # ``since_year`` may arrive as a string from ``-a since_year=2018``.
        return list(range(int(self.since_year), datetime.now().year + 1))

    def legistar_max_retries_value(self) -> int:
        """Resolve the number of retries for a year request.

        A ``legistar_max_retries`` value set on the spider (class attribute or
        ``-a`` argument) takes precedence over the ``LEGISTAR_MAX_RETRIES``
        setting, which takes precedence over the library default.
        """
        value = getattr(self, "legistar_max_retries", None)
        if value is None:
            settings = getattr(self, "settings", None)
            if settings is not None:
                try:
                    value = settings.getint(
                        LEGISTAR_MAX_RETRIES_SETTING, DEFAULT_LEGISTAR_MAX_RETRIES
                    )
                except AttributeError:
                    value = settings.get(
                        LEGISTAR_MAX_RETRIES_SETTING, DEFAULT_LEGISTAR_MAX_RETRIES
                    )
                except (TypeError, ValueError):
                    value = DEFAULT_LEGISTAR_MAX_RETRIES
            else:
                value = DEFAULT_LEGISTAR_MAX_RETRIES
        try:
            value = int(value)
        except (TypeError, ValueError):
            value = DEFAULT_LEGISTAR_MAX_RETRIES
        return max(value, 0)

    def _legistar_year_request(
        self,
        url: str,
        secrets: Dict,
        year: int,
        attempt: int = 1,
    ) -> scrapy.Request:
        """Build (or rebuild) the POST request that selects a year's event calendar."""
        return scrapy.Request(
            url,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=urlencode(
                {
                    **secrets,
                    "__EVENTTARGET": "ctl00$ContentPlaceHolder1$lstYears",
                    "ctl00_ContentPlaceHolder1_lstYears_ClientState": f'{{"value":"{year}"}}',  # noqa
                }
            ),
            callback=self._parse_legistar_events_page,
            errback=self._handle_year_request_error,
            meta={"legistar_year": year, "legistar_attempt": attempt},
            dont_filter=True,
        )

    def _handle_year_request_error(self, failure) -> Iterable[scrapy.Request]:
        """Retry a failed year request, or record the year as failed once the
        configured number of retries has been exhausted.
        """
        request = getattr(failure, "request", None)
        meta = getattr(request, "meta", None) or {}
        year = meta.get("legistar_year")
        attempt = meta.get("legistar_attempt", 1)
        error = (
            failure.getErrorMessage()
            if hasattr(failure, "getErrorMessage")
            else failure
        )
        if year is None:
            self.logger.error(
                "Legistar request failed without year metadata: %s", error
            )
            return
        max_retries = self.legistar_max_retries_value()
        if request is not None and attempt <= max_retries:
            self._legistar_retried_years.add(year)
            self.logger.warning(
                "Legistar request for year %s failed (%s), retrying "
                "(attempt %s of %s)",
                year,
                error,
                attempt + 1,
                max_retries + 1,
            )
            yield request.replace(meta={**meta, "legistar_attempt": attempt + 1})
        else:
            self._record_year_outcome(year, passed=False, attempt=attempt)
            self.logger.error(
                "Legistar request for year %s failed after %s attempt(s): %s",
                year,
                attempt,
                error,
            )

    def _record_year_outcome(self, year, passed: bool, attempt: int = 1) -> None:
        """Store the best-known outcome for a year.

        A later successful page cannot erase a failure already recorded for the
        same year, while a failed page (or exhausted year request) always marks
        the year as failed.
        """
        if year is None:
            return
        current = self.legistar_year_outcomes.get(year)
        if not passed:
            self.legistar_year_outcomes[year] = LEGISTAR_YEAR_FAILED
            return
        if current == LEGISTAR_YEAR_FAILED:
            return
        if attempt > 1 or year in self._legistar_retried_years:
            self.legistar_year_outcomes[year] = LEGISTAR_YEAR_RETRY_SUCCESS
        elif current != LEGISTAR_YEAR_RETRY_SUCCESS:
            self.legistar_year_outcomes[year] = LEGISTAR_YEAR_SUCCESS

    def _record_page_failure(self, response, error, year=None, attempt: int = 1):
        page = {
            "year": year,
            "url": response.url,
            "reason": str(error),
        }
        self.legistar_failed_pages.append(page)
        self._record_year_outcome(year, passed=False, attempt=attempt)
        self.logger.warning(
            "Skipping Legistar page %s (year %s): %s", response.url, year, error
        )

    def legistar_year_summary(self) -> str:
        """Human-readable summary of how each requested year ended."""
        years = self.legistar_years()
        outcomes = self.legistar_year_outcomes
        succeeded = sorted(
            year
            for year, outcome in outcomes.items()
            if outcome in (LEGISTAR_YEAR_SUCCESS, LEGISTAR_YEAR_RETRY_SUCCESS)
        )
        retried = sorted(
            year
            for year, outcome in outcomes.items()
            if outcome == LEGISTAR_YEAR_RETRY_SUCCESS
        )
        failed = sorted(
            year
            for year, outcome in outcomes.items()
            if outcome == LEGISTAR_YEAR_FAILED
        )
        summary = "Legistar year summary: {} year(s) total, {} succeeded".format(
            len(years), len(succeeded)
        )
        if retried:
            summary += " ({} after retry: {})".format(
                len(retried), ", ".join(str(year) for year in retried)
            )
        summary += ", {} failed, failed years: {}".format(
            len(failed),
            ", ".join(str(year) for year in failed) if failed else "none",
        )
        unattempted = [year for year in years if year not in outcomes]
        if unattempted:
            summary += ", not attempted: {}".format(
                ", ".join(str(year) for year in unattempted)
            )
        return summary

    def closed(self, reason: str) -> None:
        """Log the per-year summary when the spider is shut down."""
        self.logger.info(self.legistar_year_summary())

    def parse_legistar(self, events: Iterable[Dict]) -> Iterable[Meeting]:
        """Method to be implemented by Spider classes that will handle the response from
        Legistar. Functions similar to ``parse`` for other Spider classes.

        :param events: Iterable consisting of a dict of scraped results from Legistar
        :raises NotImplementedError: Must be implemented in subclasses
        :return: ``Meeting`` objects that will be passed to pipelines, output
        """
        raise NotImplementedError("Must implement parse_legistar")

    def legistar_start(self, item: Dict) -> datetime:
        """Pulls the start time from a Legistar item

        :param item: Scraped item from Legistar
        :return: Meeting start datetime
        """

        start_date = item.get("Meeting Date")
        start_time = item.get("Meeting Time")
        if start_date and start_time:
            try:
                return datetime.strptime(
                    f"{start_date} {start_time}", "%m/%d/%Y %I:%M %p"
                )
            except ValueError:
                return datetime.strptime(start_date, "%m/%d/%Y")

    def legistar_links(self, item: Dict) -> List[Dict]:
        """Pulls relevant links from a Legistar item

        :param item: Scraped item from Legistar
        :return: List of meeting links
        """

        links = []
        for link_type in LINK_TYPES + self.link_types:
            if isinstance(item.get(link_type), dict) and item[link_type].get("url"):
                links.append({"href": item[link_type]["url"], "title": link_type})
        return links

    def legistar_source(self, item: Dict) -> str:
        """Pulls the source URL from a Legistar item. Pulls a specific meeting URL if
        available, otherwise defaults to the general Legistar calendar page.

        :param item: Scraped item from Legistar
        :return: Source URL
        """

        default_url = self.start_urls[0]
        if isinstance(item.get("Name"), dict):
            return item["Name"].get("url", default_url)
        if isinstance(item.get("Meeting Details"), dict):
            return item["Meeting Details"].get("url", default_url)
        return default_url

    def _parse_legistar_events_page(
        self, response: scrapy.http.Response
    ) -> Iterable[Union[Meeting, scrapy.http.Request]]:
        year = response.meta.get("legistar_year") if hasattr(response, "meta") else None
        attempt = (
            response.meta.get("legistar_attempt", 1) if hasattr(response, "meta") else 1
        )
        try:
            legistar_events = self._parse_legistar_events(response)
        except Exception as exc:
            # A missing events table or malformed page shouldn't abort the crawl.
            self._record_page_failure(response, exc, year=year, attempt=attempt)
            return
        self._record_year_outcome(year, passed=True, attempt=attempt)
        yield from self.parse_legistar(legistar_events)
        try:
            next_page_requests = list(self._parse_next_page(response))
        except Exception as exc:
            self._record_page_failure(response, exc, year=year, attempt=attempt)
            return
        yield from next_page_requests

    def _parse_legistar_events(self, response: scrapy.http.Response) -> Iterable[Dict]:
        tables = response.css("table.rgMasterTable")
        if len(tables) == 0:
            raise LegistarPageError("Missing rgMasterTable events table")
        events_table = tables[0]

        headers = []
        for header in events_table.css("th[class^='rgHeader']"):
            header_text = (
                " ".join(header.css("*::text").extract()).replace("&nbsp;", " ").strip()
            )
            header_inputs = header.css("input")
            if header_text:
                headers.append(header_text)
            elif len(header_inputs) > 0:
                headers.append(header_inputs[0].attrib["value"])
            else:
                headers.append(header.css("img")[0].attrib["alt"])

        events = []
        for row in events_table.css("tr.rgRow, tr.rgAltRow"):
            try:
                data = defaultdict(lambda: None)
                for header, field in zip(headers, row.css("td")):
                    field_text = (
                        " ".join(field.css("*::text").extract())
                        .replace("&nbsp;", " ")
                        .strip()
                    )
                    url = None
                    if len(field.css("a")) > 0:
                        link_el = field.css("a")[0]
                        if "onclick" in link_el.attrib and link_el.attrib[
                            "onclick"
                        ].startswith(("radopen('", "window.open", "OpenTelerikWindow")):
                            url = response.urljoin(
                                link_el.attrib["onclick"].split("'")[1]
                            )
                        elif "href" in link_el.attrib:
                            url = response.urljoin(link_el.attrib["href"])
                    if url:
                        if header in ["", "ics"] and "View.ashx?M=IC" in url:
                            header = "iCalendar"
                            value = {"url": url}
                        else:
                            value = {"label": field_text, "url": url}
                    else:
                        value = field_text

                    data[header] = value

                ical_url = data.get("iCalendar", {}).get("url")
                if ical_url is None or ical_url in self._scraped_urls:
                    continue
                else:
                    self._scraped_urls.add(ical_url)
                events.append(dict(data))
            except Exception:
                pass

        return events

    def _parse_next_page(
        self, response: scrapy.http.Response
    ) -> Iterable[scrapy.Request]:
        next_page_link = response.css("a.rgCurrentPage + a")
        if len(next_page_link) == 0:
            return
        event_target = next_page_link[0].attrib["href"].split("'")[1]
        next_page_payload = {
            **parse_qs(response.request.body.decode("utf-8")),
            **self._parse_secrets(response),
            "__EVENTTARGET": event_target,
        }
        meta = dict(getattr(response, "meta", None) or {})
        # The next page belongs to the same year as the page that linked to it, but
        # each request gets its own fresh retry budget.
        meta["legistar_attempt"] = 1
        yield scrapy.Request(
            response.url,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=urlencode(next_page_payload),
            callback=self._parse_legistar_events_page,
            errback=self._handle_year_request_error,
            meta=meta,
            dont_filter=True,
        )

    def _parse_secrets(self, response: scrapy.http.Response) -> Dict:
        secrets = {
            "__EVENTARGUMENT": None,
            "__VIEWSTATE": response.css("[name='__VIEWSTATE']")[0].attrib["value"],
        }
        event_validation = response.css("[name='__EVENTVALIDATION']")
        if len(event_validation) > 0:
            secrets["__EVENTVALIDATION"] = event_validation[0].attrib["value"]
        return secrets
