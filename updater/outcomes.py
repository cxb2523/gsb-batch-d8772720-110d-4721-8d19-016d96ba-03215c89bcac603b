"""Per-record subscription outcomes shared by the updater and the downloader.

Every subscription record handled by a run ends with at least one outcome kind:

``no_update``       the site was checked and nothing new was found
``task_created``    new chapters were found and a download task was generated
``check_failed``    the record could not be checked; ``reason`` explains why
``downloaded``      a chapter was packed *and* the cursor advanced
``download_failed`` a chapter failed to fetch/pack/save; the cursor did not advance
``skipped``         a chapter was deliberately not attempted in this run

Outcomes are logged with the ``subscription.outcome`` logger so they are visible
in the log file, which is what the WebUI ``/api/logs`` endpoint serves. The
downloader emits one ``downloaded`` / ``download_failed`` / ``skipped`` outcome
per chapter so that "skipped" is never mistaken for "completed".

A run can collect structured copies for inspection (and for a final summary)::

    with outcomes.collect() as entries:
        updater.process_updates()
"""
import contextlib
import contextvars
import logging

log = logging.getLogger('subscription.outcome')
# Outcomes are the user-facing record of a run: emit them even when the root
# logger is configured at WARNING (the default). The file handler has no level
# filter, so these lines reach the log file served by /api/logs.
log.setLevel(logging.INFO)

NO_UPDATE = 'no_update'
TASK_CREATED = 'task_created'
CHECK_FAILED = 'check_failed'
DOWNLOADED = 'downloaded'
DOWNLOAD_FAILED = 'download_failed'
SKIPPED = 'skipped'

LABELS = {
    NO_UPDATE: '无更新',
    TASK_CREATED: '已生成下载任务',
    CHECK_FAILED: '检查失败',
    DOWNLOADED: '已下载',
    DOWNLOAD_FAILED: '下载失败',
    SKIPPED: '已跳过',
}

# Reasons for check_failed
REASON_DEPENDENCY_MISSING = 'dependency_missing'
REASON_CURSOR_NOT_FOUND = 'cursor_not_found'
REASON_FIELDS_MISSING = 'fields_missing'
REASON_RECORD_INVALID = 'record_invalid'
REASON_SITE_UNKNOWN = 'site_unknown'
REASON_CHECK_ERROR = 'check_error'

# Reasons for download_failed
REASON_FETCH_FAILED = 'chapter_fetch_failed'
REASON_PACK_FAILED = 'chapter_pack_failed'
REASON_CURSOR_SAVE_FAILED = 'cursor_save_failed'
REASON_DOWNLOAD_ERROR = 'download_error'

# Reasons for skipped
REASON_NO_CHAPTERS = 'no_pending_chapters'
REASON_PREVIOUS_FAILED = 'previous_chapter_failed'
REASON_ALREADY_PACKED = 'already_packed'

REASON_LABELS = {
    REASON_DEPENDENCY_MISSING: '依赖缺失',
    REASON_CURSOR_NOT_FOUND: '游标 ID 找不到',
    REASON_FIELDS_MISSING: '字段缺失',
    REASON_RECORD_INVALID: '记录字段无效',
    REASON_SITE_UNKNOWN: '未知站点',
    REASON_CHECK_ERROR: '检查异常',
    REASON_FETCH_FAILED: '章节下载失败',
    REASON_PACK_FAILED: '打包失败',
    REASON_CURSOR_SAVE_FAILED: '进度保存失败',
    REASON_DOWNLOAD_ERROR: '下载异常',
    REASON_NO_CHAPTERS: '没有待下载章节',
    REASON_PREVIOUS_FAILED: '前序章节失败',
    REASON_ALREADY_PACKED: '已打包',
}

_ACTIVE = contextvars.ContextVar('subscription_outcomes', default=None)


@contextlib.contextmanager
def collect():
    """Collect structured outcome entries for the duration of a run."""
    entries = []
    token = _ACTIVE.set(entries)
    try:
        yield entries
    finally:
        _ACTIVE.reset(token)


# Fields that can identify a record when the site class is unavailable.
_FALLBACK_ID_FIELDS = ('keyword', 'comic_id', 'path_word', 'id', 'album_id',
                       'mode', 'type')


def record_name(record, site_class=None):
    """Best-effort readable name for a record, even when it is broken."""
    if isinstance(record, dict):
        name = record.get('name')
        if name:
            return str(name)
        # Fall back to the unique id so the failure can still be identified;
        # the site class is unknown when an optional dependency is missing.
        candidates = []
        id_field = getattr(site_class, 'ID_FIELD', '') if site_class else ''
        if id_field:
            candidates.append(id_field)
        candidates.extend(_FALLBACK_ID_FIELDS)
        for field in candidates:
            if record.get(field):
                return str(record.get(field))
    return '未知记录'


def format_line(site, name, kind, detail=None, reason=None):
    label = LABELS[kind]
    reason_label = REASON_LABELS.get(reason, reason) if reason else None
    parts = [f'[订阅结局] site={site}', f'record={name}', f'outcome={label}']
    if reason_label:
        parts.append(f'reason={reason_label}')
    if detail:
        parts.append(f'detail={detail}')
    return ' | '.join(parts)


def emit(kind, site, name, detail=None, reason=None, collector=None):
    """Log an outcome and collect a structured copy when a run is active."""
    level = logging.WARNING if kind in (CHECK_FAILED, DOWNLOAD_FAILED) else logging.INFO
    log.log(level, format_line(site, name, kind, detail, reason))
    entry = {'site': site, 'record': name, 'outcome': kind,
             'reason': reason, 'detail': detail}
    target = collector if collector is not None else _ACTIVE.get()
    if target is not None:
        target.append(entry)
    return entry


def log_summary(entries):
    """One line per run so a glance at the log shows every record's fate."""
    counts = {}
    for entry in entries:
        counts[entry['outcome']] = counts.get(entry['outcome'], 0) + 1
    if not counts:
        log.info('[订阅结局] 汇总 | 本次运行没有订阅记录')
        return
    parts = [f'{LABELS[kind]}={counts[kind]}' for kind in LABELS if kind in counts]
    log.info('[订阅结局] 汇总 | ' + ' '.join(parts))


def reason_for_exception(exc):
    """Map a check-time exception to a stable reason code."""
    from .errors import (CursorNotFoundError, InvalidRecordError,
                         MissingFieldsError, SubscriptionCheckError)
    if isinstance(exc, CursorNotFoundError):
        return REASON_CURSOR_NOT_FOUND
    if isinstance(exc, MissingFieldsError):
        return REASON_FIELDS_MISSING
    if isinstance(exc, InvalidRecordError):
        return REASON_RECORD_INVALID
    if isinstance(exc, SubscriptionCheckError):
        return REASON_CHECK_ERROR
    return REASON_CHECK_ERROR
