#!/usr/bin/env python3
"""Coverage-table checks for the reddit-research skill.

The tests parse fabricated report text in the format required by
`skills/reddit-research/SKILL.md` and assert how the coverage appendix is judged.
They never call ScrapeAtlas, never touch the network and never spend credits.

Run from the repository root:

    python3 tests/test_reddit_coverage.py

or, to let unittest discover it:

    python3 -m unittest discover -s tests -p "test_*.py"

Exit code 0 means every check passed. No third-party packages are required.
"""

from __future__ import annotations

import re
import unittest
from dataclasses import dataclass

COVERAGE_HEADING = "## Subreddit coverage"
REQUIRED_COLUMNS = [
    "Subreddit (as discovered)",
    "Called",
    "Calls",
    "Credits",
    "Status",
    "Pages",
    "Post date range",
    "Skipped",
    "Missing",
]
USABLE_STATUSES = {"success", "partial"}
SKIP_REASONS = {"private", "quarantined", "not_found"}
EMPTY_CELLS = {"", "-", "—"}

COMPLETE = "complete"
PARTIAL = "partial"
NO_USABLE_DATA = "no usable data"


class ReportFormatError(ValueError):
    """The fabricated report does not follow the skill's output template."""


@dataclass
class CoverageReport:
    rows: list[dict[str, str]]
    declared_coverage: str | None
    totals: tuple[int, int] | None
    classification: str
    problems: list[str]


def _cells(line: str) -> list[str]:
    return [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]


def _clean(cell: str) -> str:
    value = cell.strip().strip("`").strip()
    return "" if value in EMPTY_CELLS else value


def _section(text: str, heading: str) -> list[str]:
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == heading:
            start = index + 1
            break
    if start is None:
        raise ReportFormatError(f"missing heading: {heading}")
    end = len(lines)
    for index in range(start, len(lines)):
        if re.match(r"^##\s+", lines[index]):
            end = index
            break
    return lines[start:end]


def parse_coverage_rows(text: str) -> list[dict[str, str]]:
    """Return the rows of the `## Subreddit coverage` table, keyed by header."""
    section = _section(text, COVERAGE_HEADING)
    table_lines = [line for line in section if line.strip().startswith("|")]
    if not table_lines:
        raise ReportFormatError("coverage table is missing")

    header = _cells(table_lines[0])
    missing = [column for column in REQUIRED_COLUMNS if column not in header]
    if missing:
        raise ReportFormatError(f"coverage table missing columns: {', '.join(missing)}")
    if len(header) != len(REQUIRED_COLUMNS):
        raise ReportFormatError("coverage table has unexpected columns")

    data_lines = table_lines[1:]
    if data_lines and set(data_lines[0].replace("|", "").replace(" ", "")) <= set("-:"):
        data_lines = data_lines[1:]

    rows: list[dict[str, str]] = []
    for line in data_lines:
        cells = _cells(line)
        if len(cells) != len(header):
            raise ReportFormatError(f"coverage row has {len(cells)} cells, expected {len(header)}")
        row = {column: _clean(cell) for column, cell in zip(header, cells)}
        if not row["Subreddit (as discovered)"]:
            raise ReportFormatError("coverage row has no subreddit name")
        rows.append(row)
    if not rows:
        raise ReportFormatError("coverage table has no rows")
    return rows


def parse_declared_coverage(text: str) -> str | None:
    match = re.search(r"^\*\*Coverage:\*\*\s*([^·\n]+)", text, re.M)
    if match:
        return match.group(1).strip().strip("`").lower()
    return None


def parse_totals(text: str) -> tuple[int, int] | None:
    match = re.search(r"Totals:\s*([\d,]+)\s*calls\s*·\s*([\d,]+)\s*credits charged", text)
    if not match:
        return None
    return (
        int(match.group(1).replace(",", "")),
        int(match.group(2).replace(",", "")),
    )


def is_empty(cell: str) -> bool:
    return _clean(cell) == ""


def effective_status(row: dict[str, str]) -> str:
    """`success` with a non-empty Missing cell is really partial coverage."""
    status = row["Status"].lower()
    if status == "success" and not is_empty(row["Missing"]):
        return "partial"
    return status


def classify_coverage(rows: list[dict[str, str]]) -> str:
    """Judge the report from the appendix: any gap means it is not complete."""
    usable = [row for row in rows if effective_status(row) in USABLE_STATUSES]
    if not usable:
        return NO_USABLE_DATA
    if len(usable) != len(rows) or any(
        effective_status(row) == PARTIAL for row in usable
    ):
        return PARTIAL
    return COMPLETE


def validate_rows(rows: list[dict[str, str]]) -> list[str]:
    """Return human-readable consistency problems in the appendix."""
    problems: list[str] = []
    names = [row["Subreddit (as discovered)"] for row in rows]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        problems.append(f"duplicate subreddit rows: {', '.join(duplicates)}")

    for row in rows:
        name = row["Subreddit (as discovered)"]
        status = row["Status"].lower()
        skipped = row["Skipped"].lower()
        called = row["Called"].lower()

        if called not in {"yes", "no"}:
            problems.append(f"{name}: Called must be yes or no")
        try:
            calls = int(row["Calls"])
            credits = int(row["Credits"])
            pages = int(row["Pages"])
        except ValueError:
            problems.append(f"{name}: Calls, Credits and Pages must be integers")
            continue
        if calls < 0 or credits < 0 or pages < 0:
            problems.append(f"{name}: counts cannot be negative")
        if called == "no" and calls != 0:
            problems.append(f"{name}: Called is no but Calls is {calls}")
        if called == "yes" and calls == 0:
            problems.append(f"{name}: Called is yes but Calls is 0")
        if pages > calls:
            problems.append(f"{name}: Pages ({pages}) cannot exceed Calls ({calls})")

        if status == "restricted_page":
            if skipped not in {"private", "quarantined"}:
                problems.append(f"{name}: restricted_page must say private or quarantined")
            if calls != 0:
                problems.append(f"{name}: restricted_page entries should be skipped, not retried")
        elif status == "not_found":
            if skipped != "not_found":
                problems.append(f"{name}: not_found must be marked skipped")
            if calls != 0:
                problems.append(f"{name}: not_found entries should be skipped, not retried")
        elif status == "success":
            if skipped:
                problems.append(f"{name}: success cannot also be skipped")
        elif status == "partial":
            if is_empty(row["Missing"]):
                problems.append(f"{name}: partial coverage must say what is missing")
            if skipped:
                problems.append(f"{name}: partial coverage cannot also be skipped")
        else:
            # Any other status is a failure code; it must not be presented as usable.
            if not status:
                problems.append(f"{name}: Status is empty")

    return problems


def parse_report(text: str) -> CoverageReport:
    rows = parse_coverage_rows(text)
    declared = parse_declared_coverage(text)
    totals = parse_totals(text)
    classification = classify_coverage(rows)
    problems = validate_rows(rows)

    if totals is None:
        problems.append("missing Totals line")
    else:
        calls = sum(int(row["Calls"]) for row in rows)
        credits = sum(int(row["Credits"]) for row in rows)
        if totals != (calls, credits):
            problems.append(
                f"Totals says {totals[0]} calls / {totals[1]} credits, "
                f"rows sum to {calls} calls / {credits} credits"
            )

    if declared is not None and declared != classification:
        problems.append(f"declared coverage is {declared}, table implies {classification}")

    if classification == NO_USABLE_DATA:
        short = "\n".join(_section(text, "## The short answer"))
        if "No usable data" not in short:
            problems.append("No usable data must be stated in The short answer")
        if "consensus" in short.lower():
            problems.append("No usable data must not claim a consensus")

    return CoverageReport(rows, declared, totals, classification, problems)


ALL_SUCCESS_REPORT = """\
# Reddit research: mechanical keyboards for programming

**Coverage:** complete · **Communities:** r/MechanicalKeyboards (1.2M), r/ProgrammerHumor (2.4M) · **Threads read:** 6 · **Window:** year

## The short answer
- Most people recommend silent tactile switches, with links.

## Most recommended
| Option | Mentions | Why people like it | Example thread |

## Subreddit coverage
| Subreddit (as discovered) | Called | Calls | Credits | Status | Pages | Post date range | Skipped | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r/MechanicalKeyboards | yes | 2 | 2 | success | 2 | 2024-01-04 – 2026-10-30 | — | — |
| r/ProgrammerHumor | yes | 2 | 2 | success | 2 | 2024-02-11 – 2026-09-19 | — | — |

Totals: 4 calls · 4 credits charged.
"""

PARTIAL_REPORT = """\
# Reddit research: mechanical keyboards for programming

**Coverage:** partial · **Communities:** r/MechanicalKeyboards (1.2M), r/BudgetKeebs (120K) · **Threads read:** 4 · **Window:** year

## The short answer
- Silent tactile switches dominate the threads that returned.

## Coverage gaps
r/BudgetKeebs returned one page with `coverage.complete: false`: the next page and post dates before 2026-01-01 are missing.

## Subreddit coverage
| Subreddit (as discovered) | Called | Calls | Credits | Status | Pages | Post date range | Skipped | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r/MechanicalKeyboards | yes | 2 | 2 | success | 2 | 2024-01-04 – 2026-10-30 | — | — |
| r/BudgetKeebs | yes | 1 | 1 | partial | 1 | 2026-01-01 – 2026-10-30 | — | one page returned, older posts and the next page are missing |

Totals: 3 calls · 3 credits charged.
"""

SKIPPED_REPORT = """\
# Reddit research: mechanical keyboards for programming

**Coverage:** partial · **Communities:** r/MechanicalKeyboards (1.2M) · **Threads read:** 2 · **Window:** year

## The short answer
- The one reachable community recommends silent tactile switches.

## Coverage gaps
r/keebs is private and r/MechanicalKeyboardsUK does not exist publicly, so two planned communities were skipped.

## Subreddit coverage
| Subreddit (as discovered) | Called | Calls | Credits | Status | Pages | Post date range | Skipped | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r/MechanicalKeyboards | yes | 2 | 2 | success | 2 | 2024-01-04 – 2026-10-30 | — | — |
| r/keebs | no | 0 | 0 | restricted_page | 0 | — | private | — |
| r/MechanicalKeyboardsUK | no | 0 | 0 | not_found | 0 | — | not_found | — |

Totals: 2 calls · 2 credits charged.
"""

ALL_FAILED_REPORT = """\
# Reddit research: mechanical keyboards for programming

**Coverage:** no usable data · **Communities:** none reached · **Threads read:** 0 · **Window:** year

## The short answer
No usable data: every shortlisted subreddit was private or did not exist, so there is no community sample to summarize.

## Subreddit coverage
| Subreddit (as discovered) | Called | Calls | Credits | Status | Pages | Post date range | Skipped | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r/keebs | no | 0 | 0 | restricted_page | 0 | — | private | — |
| r/MechanicalKeyboardsUK | no | 0 | 0 | not_found | 0 | — | not_found | — |
| r/MechanicalKeyboards_Private | no | 0 | 0 | restricted_page | 0 | — | quarantined | — |

Totals: 0 calls · 0 credits charged.
"""


class CoverageClassificationTests(unittest.TestCase):
    def test_all_success_is_complete(self) -> None:
        report = parse_report(ALL_SUCCESS_REPORT)
        self.assertEqual(report.classification, COMPLETE)
        self.assertEqual(report.problems, [])
        self.assertEqual(report.totals, (4, 4))

    def test_partial_subreddit_makes_report_partial(self) -> None:
        report = parse_report(PARTIAL_REPORT)
        self.assertEqual(report.classification, PARTIAL)
        self.assertEqual(report.problems, [])
        partial_row = report.rows[1]
        self.assertEqual(partial_row["Status"], "partial")
        self.assertTrue(partial_row["Missing"])
        self.assertIn("older posts", partial_row["Missing"])

    def test_private_and_not_found_are_skipped_failures(self) -> None:
        report = parse_report(SKIPPED_REPORT)
        self.assertEqual(report.classification, PARTIAL)
        self.assertEqual(report.problems, [])
        skipped = {row["Skipped"] for row in report.rows}
        self.assertIn("private", skipped)
        self.assertIn("not_found", skipped)
        statuses = {row["Status"] for row in report.rows}
        self.assertIn("restricted_page", statuses)
        self.assertIn("not_found", statuses)

    def test_all_failed_has_no_usable_data(self) -> None:
        report = parse_report(ALL_FAILED_REPORT)
        self.assertEqual(report.classification, NO_USABLE_DATA)
        self.assertEqual(report.problems, [])
        self.assertEqual(report.totals, (0, 0))
        self.assertTrue(all(row["Skipped"] for row in report.rows))


class CoverageConsistencyTests(unittest.TestCase):
    def test_success_with_missing_notes_is_treated_as_partial(self) -> None:
        text = ALL_SUCCESS_REPORT.replace(
            "| r/ProgrammerHumor | yes | 2 | 2 | success | 2 | 2024-02-11 – 2026-09-19 | — | — |",
            "| r/ProgrammerHumor | yes | 2 | 2 | success | 2 | 2024-02-11 – 2026-09-19 | — | second page missing |",
        )
        report = parse_report(text)
        self.assertEqual(report.classification, PARTIAL)
        self.assertTrue(
            any("must say what is missing" in problem or "table implies partial" in problem
                for problem in report.problems)
        )

    def test_private_row_without_skip_reason_is_rejected(self) -> None:
        text = SKIPPED_REPORT.replace(
            "| r/keebs | no | 0 | 0 | restricted_page | 0 | — | private | — |",
            "| r/keebs | no | 0 | 0 | restricted_page | 0 | — | — | — |",
        )
        report = parse_report(text)
        self.assertTrue(any("restricted_page must say private or quarantined" in p for p in report.problems))

    def test_retrying_a_skipped_subreddit_is_rejected(self) -> None:
        text = SKIPPED_REPORT.replace(
            "| r/keebs | no | 0 | 0 | restricted_page | 0 | — | private | — |",
            "| r/keebs | yes | 2 | 2 | restricted_page | 0 | — | private | — |",
        )
        report = parse_report(text)
        self.assertTrue(any("should be skipped, not retried" in p for p in report.problems))

    def test_totals_must_match_rows(self) -> None:
        text = PARTIAL_REPORT.replace("Totals: 3 calls · 3 credits charged.", "Totals: 4 calls · 4 credits charged.")
        report = parse_report(text)
        self.assertTrue(any("rows sum to 3 calls / 3 credits" in p for p in report.problems))

    def test_declared_complete_cannot_hide_partial(self) -> None:
        text = PARTIAL_REPORT.replace("**Coverage:** partial", "**Coverage:** complete", 1)
        report = parse_report(text)
        self.assertTrue(any("declared coverage is complete, table implies partial" in p for p in report.problems))

    def test_all_failed_must_not_claim_consensus(self) -> None:
        text = ALL_FAILED_REPORT.replace(
            "No usable data: every shortlisted subreddit was private or did not exist, so there is no community sample to summarize.",
            "The community consensus is that silent switches are best.",
        )
        report = parse_report(text)
        self.assertTrue(any("No usable data" in p for p in report.problems))
        self.assertTrue(any("must not claim a consensus" in p for p in report.problems))

    def test_names_keep_discovered_casing(self) -> None:
        report = parse_report(SKIPPED_REPORT)
        self.assertEqual(report.rows[1]["Subreddit (as discovered)"], "r/keebs")
        self.assertEqual(report.rows[2]["Subreddit (as discovered)"], "r/MechanicalKeyboardsUK")

    def test_table_without_required_column_is_rejected(self) -> None:
        text = ALL_SUCCESS_REPORT.replace("| Skipped |", "| Skipped? |")
        with self.assertRaises(ReportFormatError):
            parse_report(text)

    def test_missing_coverage_heading_is_rejected(self) -> None:
        text = ALL_SUCCESS_REPORT.replace("## Subreddit coverage", "## Communities")
        with self.assertRaises(ReportFormatError):
            parse_report(text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
