"""
pg_statviz - stats visualization and time series analysis
"""

__author__ = "Jimmy Angelakos"
__copyright__ = "Copyright (c) 2026 Jimmy Angelakos"
__license__ = "PostgreSQL License"

import argparse
import getpass
import logging
import numpy
from dataclasses import dataclass, field
from enum import Enum
from argh.decorators import arg
from dateutil.parser import isoparse
from matplotlib.pyplot import close as mpclose
from matplotlib.ticker import MaxNLocator
from pandas import DataFrame
from pg_statviz.libs import plot
from pg_statviz.libs.ai import (AI_HELP, AI_PROVIDERS,
                                DEFAULT_AI_PROVIDER,
                                run_chart_analysis)
from pg_statviz.libs.dbconn import dbconn
from pg_statviz.libs.html_report import finalize_module_report
from pg_statviz.libs.info import getinfo


class IoOutcome(str, Enum):
    """How a single I/O category fared when rates were derived.

    Keeping this explicit (instead of silently emitting NaN) lets the
    collection result account for every category that was dropped.
    """

    OK = "ok"                 # rates produced normally
    STATS_RESET = "stats_reset"  # invalidated by a stats_reset
    MISSING = "missing"       # counter absent, NULL or zero


_OUTCOME_TEXT = {
    IoOutcome.OK: "rate produced",
    IoOutcome.STATS_RESET: "invalidated by stats_reset",
    IoOutcome.MISSING: "not computable (counter missing, zero or unusable)",
}

_BYTE_FIELDS = {'reads': 'read_bytes', 'writes': 'write_bytes'}


def io_category_kind(entry):
    """Return the backend_type/object/context triple identifying a category."""
    return {'backend_type': entry['backend_type'],
            'object': entry['object'],
            'context': entry['context']}


def io_category_key(kind):
    """Hashable form of an I/O category triple, for lookups."""
    return (kind['backend_type'], kind['object'], kind['context'])


def io_category_name(kind):
    """Display name used in chart legends and rate dictionaries.

    The default ``relation`` object is left implicit (matching historical
    labels); any other object is prefixed so categories that differ only by
    object -- e.g. ``temp relation`` or PG18's ``wal`` -- cannot collide.
    """
    name = f"{kind['backend_type']}/{kind['context']}"
    if kind.get('object') != 'relation':
        name = f"{kind['object']}/{name}"
    return name


@dataclass
class IoIntervalOutcome:
    """Outcome of deriving one interval's rate for one category."""

    interval: int                  # index of the left-hand snapshot (0-based)
    read: IoOutcome = IoOutcome.MISSING
    write: IoOutcome = IoOutcome.MISSING
    read_detail: str = ""
    write_detail: str = ""

    def problems(self):
        """Yield (direction, outcome, detail) for directions that failed."""
        if self.read is not IoOutcome.OK:
            yield 'reads', self.read, self.read_detail
        if self.write is not IoOutcome.OK:
            yield 'writes', self.write, self.write_detail


@dataclass
class IoCategory:
    """One I/O category with its byte counters, rates and per-interval fate."""

    kind: dict
    name: str
    reads: list = field(default_factory=list)
    writes: list = field(default_factory=list)
    intervals: list = field(default_factory=list)
    counter_source: str = "blocks"

    def _combine(self, outcomes):
        """Fold per-interval outcomes into one; OK only if all were OK.

        A category is reported OK only when every interval produced a rate
        in that direction. Otherwise the dominant reason wins: a stats_reset
        invalidation if one occurred, else a missing/zero counter -- so an
        aggregate outcome never hides a skipped interval.
        """
        outcomes = list(outcomes)
        if not outcomes:
            return IoOutcome.MISSING
        if all(o is IoOutcome.OK for o in outcomes):
            return IoOutcome.OK
        if any(o is IoOutcome.STATS_RESET for o in outcomes):
            return IoOutcome.STATS_RESET
        return IoOutcome.MISSING

    @property
    def read_result(self):
        return self._combine(i.read for i in self.intervals)

    @property
    def write_result(self):
        return self._combine(i.write for i in self.intervals)

    @property
    def result(self):
        """Category-wide outcome: OK only if every interval was usable."""
        read, write = self.read_result, self.write_result
        if read is IoOutcome.OK and write is IoOutcome.OK:
            return IoOutcome.OK
        if (read is IoOutcome.STATS_RESET
                or write is IoOutcome.STATS_RESET):
            return IoOutcome.STATS_RESET
        return IoOutcome.MISSING

    @property
    def result_detail(self):
        if not self.intervals:
            return "fewer than two snapshots, so no rate interval exists"
        details = []
        for interval in self.intervals:
            for direction, outcome, detail in interval.problems():
                details.append(f"{direction}: {_OUTCOME_TEXT[outcome]}"
                               + (f" ({detail})" if detail else ""))
        return "; ".join(details) if details else "all rate intervals usable"


@dataclass
class IoCollection:
    """Auditable result of collecting I/O snapshots.

    Attributes:
        snapshots: per-snapshot statistics, with ``reads``/``writes``
            normalised to bytes (PG18+ byte fields or legacy block counts).
        categories: every I/O category seen, in first-seen order, each
            carrying its cumulative series, rate series and interval outcomes.
        timestamps: snapshot timestamps aligned with the series above.
        block_size: block size used for legacy block-count conversion.
    """

    snapshots: list
    categories: list
    timestamps: list
    block_size: int = 8192

    @property
    def snapshot_count(self):
        return len(self.snapshots)

    def outcome_for(self, kind):
        """Return the IoCategory for *kind*, or None if never observed."""
        key = io_category_key(kind)
        for category in self.categories:
            if io_category_key(category.kind) == key:
                return category
        return None

    def outcomes(self, direction=None):
        """Map every category name to its IoOutcome.

        With no direction, each category's aggregate outcome is returned.
        Pass ``'read'`` or ``'write'`` to get that direction's outcome
        instead. Either way there is exactly one entry per
        backend_type/object/context triple -- the auditable summary that
        callers and tests can inspect without parsing logs.
        """
        if direction is None:
            return {category.name: category.result
                    for category in self.categories}
        if direction not in ('read', 'write'):
            raise ValueError(f"unknown I/O direction: {direction!r}")
        return {category.name: getattr(category, f"{direction}_result")
                for category in self.categories}

    def skipped(self):
        """Categories with at least one interval that produced no rate.

        Matches exactly what :func:`log_io_outcomes` itemises, including
        categories that produced rates on some intervals but not others.
        """
        return [category for category in self.categories
                if not category.intervals
                or any(list(interval.problems())
                       for interval in category.intervals)]

    @property
    def rates(self):
        """Rate dictionaries in the shape the chart/DataFrame code expects."""
        return {
            'reads': {c.name: c.reads for c in self.categories},
            'writes': {c.name: c.writes for c in self.categories},
        }


def _convert_entry(entry, block_size):
    """Return a copy of *entry* with reads/writes normalised to bytes.

    PG18+ rows carry read_bytes/write_bytes; older rows carry block counts
    that must be multiplied by block_size. Input rows are never mutated, so
    cumulative and rate paths cannot convert a counter twice.
    """
    converted = dict(entry)
    for rw, bytes_field in _BYTE_FIELDS.items():
        if bytes_field in entry:
            value = entry[bytes_field]
            converted[rw] = int(value) if value else 0
        else:
            value = entry.get(rw)
            # Preserve the legacy representation of a missing/zero counter
            # (None stays None, 0 stays 0); only real counts are scaled.
            converted[rw] = int(value) * block_size if value else value
    return converted


def _entry_source(entry, rw):
    return 'bytes' if _BYTE_FIELDS[rw] in entry else 'blocks'


def _counter_rate(entry1, entry2, rw, seconds, block_size):
    """Derive one interval's rate.

    Returns (rate, outcome, detail). Rate is numpy.nan unless the outcome is
    IoOutcome.OK.
    """
    source1 = _entry_source(entry1, rw)
    source2 = _entry_source(entry2, rw)
    if source1 != source2:
        return (numpy.nan, IoOutcome.MISSING,
                "counter representation changed between snapshots")
    field_name = _BYTE_FIELDS[rw] if source1 == 'bytes' else rw
    raw1, raw2 = entry1.get(field_name), entry2.get(field_name)
    if raw1 is None or raw2 is None:
        return (numpy.nan, IoOutcome.MISSING, f"{field_name} is NULL")
    try:
        scale = block_size if source1 == 'blocks' else 1
        v1 = int(raw1) * scale
        v2 = int(raw2) * scale
    except (TypeError, ValueError):
        return (numpy.nan, IoOutcome.MISSING, f"{field_name} is not numeric")
    if v1 == 0:
        return (numpy.nan, IoOutcome.MISSING, f"{field_name} is zero")
    delta = v2 - v1
    if delta < 0:
        return (numpy.nan, IoOutcome.MISSING,
                f"{field_name} decreased without stats_reset")
    if seconds <= 0:
        return (numpy.nan, IoOutcome.MISSING,
                "snapshot timestamps are not increasing")
    return (delta / seconds, IoOutcome.OK, "")


def collect_iostats(data, block_size=8192):
    """Collect I/O snapshots into an auditable IoCollection.

    Every category (backend_type/object/context) present in any snapshot
    receives an outcome per direction and interval:
      * OK          - a rate was produced normally
      * STATS_RESET - invalidated because stats_reset changed
      * MISSING     - counter absent, NULL, zero or otherwise unusable

    Fewer than two snapshots, or a category absent from an adjacent snapshot,
    produce MISSING outcomes rather than exceptions.
    """
    timestamps = [row['snapshot_tstamp'] for row in data]
    snapshots = []
    raw_lookups = []
    kinds = []
    seen = set()
    sources = {}

    for row in data:
        converted = []
        raw_lookup = {}
        for entry in row.get('io_stats') or []:
            kind = io_category_kind(entry)
            key = io_category_key(kind)
            if key not in seen:
                seen.add(key)
                kinds.append(kind)
            sources.setdefault(key, set()).update(
                (_entry_source(entry, 'reads'),
                 _entry_source(entry, 'writes')))
            converted.append(_convert_entry(entry, block_size))
            raw_lookup.setdefault(key, entry)
        snapshots.append(converted)
        raw_lookups.append(raw_lookup)

    categories = []
    for kind in kinds:
        key = io_category_key(kind)
        source_set = sources.get(key, {'blocks'})
        counter_source = (source_set.pop() if len(source_set) == 1
                          else 'mixed')
        reads = [numpy.nan]
        writes = [numpy.nan]
        intervals = []
        for i in range(len(data) - 1):
            row1, row2 = data[i], data[i + 1]
            interval = IoIntervalOutcome(interval=i)
            entry1 = raw_lookups[i].get(key)
            entry2 = raw_lookups[i + 1].get(key)
            if row1.get('stats_reset') != row2.get('stats_reset'):
                interval.read = interval.write = IoOutcome.STATS_RESET
                interval.read_detail = interval.write_detail = (
                    f"stats_reset changed between snapshot {i + 1} and "
                    f"snapshot {i + 2}")
            elif entry1 is None or entry2 is None:
                if entry1 is None and entry2 is None:
                    where = "both adjacent snapshots"
                elif entry1 is None:
                    where = f"snapshot {i + 1}"
                else:
                    where = f"snapshot {i + 2}"
                interval.read = interval.write = IoOutcome.MISSING
                interval.read_detail = interval.write_detail = (
                    f"category absent from {where}")
            else:
                seconds = (row2['snapshot_tstamp']
                           - row1['snapshot_tstamp']).total_seconds()
                (read_rate, interval.read, interval.read_detail) = \
                    _counter_rate(entry1, entry2, 'reads', seconds,
                                  block_size)
                (write_rate, interval.write, interval.write_detail) = \
                    _counter_rate(entry1, entry2, 'writes', seconds,
                                  block_size)
            if interval.read is IoOutcome.OK:
                reads.append(read_rate)
            else:
                reads.append(numpy.nan)
            if interval.write is IoOutcome.OK:
                writes.append(write_rate)
            else:
                writes.append(numpy.nan)
            intervals.append(interval)
        categories.append(IoCategory(
            kind=kind, name=io_category_name(kind), reads=reads,
            writes=writes, intervals=intervals,
            counter_source=counter_source))

    return IoCollection(snapshots=snapshots, categories=categories,
                        timestamps=timestamps, block_size=block_size)


def _summarise_problems(problems):
    """Group (direction, outcome, detail) problems into readable clauses."""
    grouped = {}
    for direction, outcome, detail in problems:
        grouped.setdefault((direction, outcome, detail), None)
    clauses = []
    for direction, outcome, detail in grouped:
        text = f"{direction}: {_OUTCOME_TEXT[outcome]}"
        if detail:
            text += f" ({detail})"
        clauses.append(text)
    return clauses


def log_io_outcomes(collection, logger):
    """Log every category whose rate was not produced, and why.

    Each category gets one explicitly itemised line; nothing is silently
    turned into NaN without an explanation. Stats_reset invalidations are
    informational, missing/zero counters are warnings.
    """
    if not collection.categories:
        return

    if collection.snapshot_count < 2:
        for category in collection.categories:
            logger.info("I/O rate unavailable for %s (%s counters): %s",
                        category.name, category.counter_source,
                        category.result_detail)
        logger.info("I/O rates unavailable for all %d categories: fewer "
                    "than two snapshots were collected",
                    len(collection.categories))
        return

    skipped = 0
    for category in collection.categories:
        problems = [problem
                    for interval in category.intervals
                    for problem in interval.problems()]
        if not problems:
            continue
        skipped += 1
        level = (logging.WARNING
                 if any(outcome is IoOutcome.MISSING
                        for _, outcome, _ in problems)
                 else logging.INFO)
        logger.log(level, "I/O rate skipped for %s (%s counters, outcome "
                   "%s): %s", category.name, category.counter_source,
                   category.result.value,
                   "; ".join(_summarise_problems(problems)))
    if skipped:
        remaining = len(collection.categories) - skipped
        logger.info("I/O rates: %d of %d categories had intervals that "
                    "could not produce a rate (itemised above); %d "
                    "produced rates normally", skipped,
                    len(collection.categories), remaining)


@arg('-d', '--dbname', help="database name to analyze")
@arg('-h', '--host', metavar="HOSTNAME",
     help="database server host or socket directory")
@arg('-p', '--port', help="database server port")
@arg('-U', '--username', help="database user name")
@arg('-W', '--password', action='store_true',
     help="force password prompt (should happen automatically)")
@arg('-D', '--daterange', nargs=2, metavar=('FROM', 'TO'), type=str,
     help="date range to be analyzed in ISO 8601 format e.g. 2026-01-01T00:00"
          + " 2026-01-01T23:59")
@arg('-O', '--outputdir', help="output directory")
@arg('--ai', nargs='?', const=DEFAULT_AI_PROVIDER, default=None,
     choices=AI_PROVIDERS, metavar='PROVIDER',
     help=AI_HELP)
@arg('--info', help=argparse.SUPPRESS)
@arg('--conn', help=argparse.SUPPRESS)
def io(*, dbname=getpass.getuser(), host="/var/run/postgresql", port="5432",
       username=getpass.getuser(), password=None, daterange=[],
       outputdir=None, ai=None, info=None, conn=None):
    "run I/O analysis module"

    logging.basicConfig()
    _logger = logging.getLogger(__name__)
    _logger.setLevel(logging.INFO)

    if not conn:
        conn_details = {'dbname': dbname, 'user': username,
                        'password': getpass.getpass("Password: ") if password
                        else password, 'host': host, 'port': port}
        conn = dbconn(**conn_details)
    if not info:
        info = getinfo(conn)

    _logger.info("Running I/O analysis")

    daterange = normalize_daterange(daterange)

    # Retrieve the snapshots from DB
    cur = conn.cursor()
    cur.execute("""SELECT io_stats, block_size, i.stats_reset, snapshot_tstamp
                   FROM pgstatviz.io i
                   JOIN pgstatviz.db USING (snapshot_tstamp)
                   WHERE snapshot_tstamp BETWEEN %s AND %s
                   ORDER BY snapshot_tstamp""",
                (daterange[0], daterange[1]))

    data = cur.fetchall()
    if not data:
        cur.execute("""SELECT
                    (current_setting('server_version_num')::int >= 160000)
                    AS version_ok""")
        versioncheck = cur.fetchone()['version_ok']
        if not versioncheck:
            _logger.warning("I/O analysis is only available from "
                            + "PostgreSQL release 16 onwards")
            return
        else:
            raise SystemExit("No pg_statviz snapshots found in this database")

    tstamps = [ts['snapshot_tstamp'] for ts in data]
    blcksz = int(data[0]['block_size'])
    collection = collect_iostats(data, blcksz)

    # Account for every category whose rate could not be produced
    log_io_outcomes(collection, _logger)

    iostats = collection.snapshots

    # Build a flattened DataFrame for AI analysis
    io_df = build_io_dataframe(collection)

    report_sections = []

    def cumulative_series(category, direction):
        series = []
        for snapshot in iostats:
            value = 0
            for entry in snapshot:
                if io_category_kind(entry) == category.kind:
                    raw = entry.get(direction)
                    if raw:
                        value = round(raw / 1073741824,
                                      1 if raw >= 100 else 2)
                        break
            series.append(value)
        return series

    def plot_series(axis, series, label):
        # Downsample if needed
        frame = DataFrame(data=series, index=tstamps, copy=False)
        if len(tstamps) > plot.MAX_POINTS:
            q = str(round(
                (tstamps[-1] - tstamps[0]).total_seconds()
                / plot.MAX_POINTS, 2))
            frame = frame.resample(q + "s").mean()
        axis.plot(frame.index, frame, label=label)

    # Plot as many of each I/O kinds we have per snapshot
    plt, fig, splt1, splt2 = plot.setupdouble()
    plt.suptitle(f"pg_statviz · {info['hostname']}:{port}",
                 fontweight='semibold')

    # Plot Reads
    splt1.set_title("I/O Reads")
    for category in collection.categories:
        iobytes = cumulative_series(category, 'reads')
        if not all(b == 0 for b in iobytes):
            plot_series(splt1, iobytes, category.name)
    splt1.set_xlabel("Timestamp", fontweight='semibold')
    splt1.set_ylabel("GB read (at time of snapshot)", fontweight='semibold')
    splt1.set_ylim(bottom=0)
    splt1.legend()

    # Plot Writes
    splt2.set_title("I/O Writes")
    for category in collection.categories:
        iobytes = cumulative_series(category, 'writes')
        if not all(b == 0 for b in iobytes):
            plot_series(splt2, iobytes, category.name)
    splt2.set_xlabel("Timestamp", fontweight='semibold')
    splt2.set_ylabel("GB written (at time of snapshot)",
                     fontweight='semibold')
    splt2.set_ylim(bottom=0)
    splt2.legend()

    fig.gca().yaxis.set_major_locator(MaxNLocator(integer=True))
    outfile = f"""{
        outputdir.rstrip("/") + "/" if outputdir
        else ''}pg_statviz_{info['hostname']
                            .replace("/", "-")}_{port}_io.png"""
    _logger.info(f"Saving {outfile}")
    plt.gcf().autofmt_xdate()
    fig.tight_layout()
    plt.savefig(outfile)
    run_chart_analysis(
        report_sections, ai, io_df, "I/O Statistics",
        metric_description="CUMULATIVE COUNTER — rising values are "
                           "NORMAL. I/O volume by component. "
                           "'client backend' is query work. "
                           "'checkpointer' spikes at checkpoint "
                           "intervals are normal. No warning "
                           "threshold. Default to [HEALTHY].",
        outfile=outfile,
        info=info,
    )

    # Build rate DataFrame for AI analysis
    rate_df = build_iorate_dataframe(collection)

    # Plot I/O Rates
    plt, fig, splt1, splt2 = plot.setupdouble()
    plt.suptitle(f"pg_statviz · {info['hostname']}:{port}",
                 fontweight='semibold')

    def rate_series(category, direction):
        return [round(v / 1048576, 1 if v >= 100 else 2)
                if not numpy.isnan(v) else numpy.nan
                for v in getattr(category, direction)]

    # Plot Read Rates
    splt1.set_title("I/O Read Rate")
    for category in collection.categories:
        series = rate_series(category, 'reads')
        if not all(numpy.isnan(v) or v == 0 for v in series):
            plot_series(splt1, series, category.name)
    splt1.set_xlabel("Timestamp", fontweight='semibold')
    splt1.set_ylabel("Avg. read rate in MB/s", fontweight='semibold')
    splt1.set_ylim(bottom=0)
    splt1.legend()

    # Plot Write Rates
    splt2.set_title("I/O Write Rate")
    for category in collection.categories:
        series = rate_series(category, 'writes')
        if not all(numpy.isnan(v) or v == 0 for v in series):
            plot_series(splt2, series, category.name)
    splt2.set_xlabel("Timestamp", fontweight='semibold')
    splt2.set_ylabel("Avg. write rate in MB/s", fontweight='semibold')
    splt2.legend()
    splt2.set_ylim(bottom=0)

    plt.gcf().autofmt_xdate()
    fig.tight_layout()
    outfile = f"""{
        outputdir.rstrip("/") + "/" if outputdir
        else ''}pg_statviz_{info['hostname']
                            .replace("/", "-")}_{port}_io_rate.png"""
    _logger.info(f"Saving {outfile}")
    plt.savefig(outfile)
    run_chart_analysis(
        report_sections, ai, rate_df, "I/O Rate",
        metric_description="I/O RATES in MB/s (derived from cumulative "
                           "counters). NaN values appear on "
                           "stats_reset — IGNORE them. Read spikes "
                           "indicate cache misses. Write spikes "
                           "during checkpoints are normal. No "
                           "warning threshold (storage limits vary). "
                           "Default to [HEALTHY].",
        outfile=outfile,
        info=info,
    )

    finalize_module_report(outputdir, info, port, 'io',
                           report_sections)
    mpclose('all')


def normalize_daterange(daterange):
    """Parse a FROM/TO pair, swapping them when FROM is later than TO.

    An empty/None range keeps the historical open-ended default.
    """
    if daterange:
        parsed = [isoparse(d) for d in daterange]
        if parsed[0] > parsed[1]:
            parsed = [parsed[1], parsed[0]]
        return parsed
    return ['-infinity', 'now()']


# Gather I/O stats and convert to bytes (backwards-compatible wrapper)
def calc_iostats(data, blcksz=8192):
    collection = collect_iostats(data, blcksz)
    iokinds = [category.kind for category in collection.categories]
    return collection.snapshots, iokinds


# Calculate I/O rates (backwards-compatible wrapper)
def calc_iorates(data, iokinds, blcksz=8192):
    """Rate dict for the requested categories, keyed by display name."""
    collection = collect_iostats(data, blcksz)
    rates = collection.rates
    if iokinds is not None:
        wanted = {io_category_name(kind) for kind in iokinds}
        rates = {rw: {name: series for name, series in series_by_name.items()
                      if name in wanted}
                 for rw, series_by_name in rates.items()}
    return rates


# Build a flattened DataFrame from I/O stats for AI analysis
def build_io_dataframe(collection):
    """Build the cumulative-GB DataFrame for AI analysis from a collection."""
    data = {}
    for category in collection.categories:
        reads = []
        writes = []
        for snapshot in collection.snapshots:
            r = w = 0
            for entry in snapshot:
                if io_category_kind(entry) == category.kind:
                    r = entry.get('reads') or 0
                    w = entry.get('writes') or 0
                    break
            reads.append(round(r / 1073741824, 2))
            writes.append(round(w / 1073741824, 2))
        if not all(v == 0 for v in reads):
            data[f"{category.name}_read_GB"] = reads
        if not all(v == 0 for v in writes):
            data[f"{category.name}_write_GB"] = writes
    return DataFrame(data=data, index=collection.timestamps, copy=False)


# Build a flattened DataFrame from I/O rates for AI analysis
def build_iorate_dataframe(collection):
    """Build the rate DataFrame for AI analysis from a collection."""
    data = {}
    for category in collection.categories:
        reads = [round(v / 1048576, 2) if not numpy.isnan(v) else 0
                 for v in category.reads]
        if not all(v == 0 for v in reads):
            data[f"{category.name}_read_MBps"] = reads
        writes = [round(v / 1048576, 2) if not numpy.isnan(v) else 0
                  for v in category.writes]
        if not all(v == 0 for v in writes):
            data[f"{category.name}_write_MBps"] = writes
    return DataFrame(data=data, index=collection.timestamps, copy=False)
