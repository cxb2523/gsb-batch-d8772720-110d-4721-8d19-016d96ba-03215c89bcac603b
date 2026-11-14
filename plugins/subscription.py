"""Commit subscription progress only after a complete chapter is packed."""
import logging
import re
from pathlib import Path

from utils import config
from utils.notify import notifier
from updater import outcomes

log = logging.getLogger(__name__)


def safe_name(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value)).strip(' .')
    if not name or name in {'.', '..'}:
        raise ValueError('无效文件名')
    if name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *{f'COM{i}' for i in range(1, 10)}, *{f'LPT{i}' for i in range(1, 10)}}:
        name = '_' + name
    return name[:160]


def run_batch(tasks, fetch):
    """Download tasks chapter by chapter, committing the cursor only on success.

    A failed chapter stops the task: the cursor is not advanced, later chapters
    are not attempted, and the next run starts again from the failed chapter.
    Every chapter ends in a distinct outcome (downloaded / download_failed /
    skipped) so "skipped" is never reported as "completed".
    """
    from downloader import postprocess
    from updater.updater import update_chapter_record
    for task in tasks:
        site = task['site']
        id_field = 'keyword'
        series = safe_name(task['name'])
        chapter_infos = task.get('chapter_infos') or []
        if not chapter_infos:
            outcomes.emit(outcomes.SKIPPED, site, task['name'],
                          reason=outcomes.REASON_NO_CHAPTERS)
            continue
        for number, (chapter_id, title) in enumerate(chapter_infos, 1):
            stage = 'fetch'
            try:
                filename = safe_name(f'{title} [{chapter_id}]')
                folder = Path(config.DOWNLOAD_PATH) / site / safe_name(task[id_field]) / safe_name(chapter_id)
                folder.mkdir(parents=True, exist_ok=True)
                count = fetch(task, chapter_id, folder)
                if count <= 0:
                    raise ValueError('章节没有图片')
                chapter_number = task.get('chapter_numbers', {}).get(str(chapter_id), number)
                stage = 'pack'
                postprocess(series, title, filename, chapter_number, str(folder))
                stage = 'cursor'
                if not update_chapter_record(site, task[id_field], str(chapter_id)):
                    raise RuntimeError('保存章节进度失败')
                notifier.add_success(site, task['name'], title)
                outcomes.emit(outcomes.DOWNLOADED, site, task['name'],
                              detail=f'章节={title} [{chapter_id}]')
            except Exception as exc:
                reason = {
                    'pack': outcomes.REASON_PACK_FAILED,
                    'cursor': outcomes.REASON_CURSOR_SAVE_FAILED,
                }.get(stage, outcomes.REASON_FETCH_FAILED)
                log.exception('下载 %s / %s 失败', series, title)
                notifier.add_error(site, task['name'], str(exc))
                outcomes.emit(outcomes.DOWNLOAD_FAILED, site, task['name'],
                              detail=f'章节={title} [{chapter_id}]: {exc}', reason=reason)
                # 不越过失败章节推进游标；下次仍可重试。
                for remaining_id, remaining_title in chapter_infos[number:]:
                    outcomes.emit(outcomes.SKIPPED, site, task['name'],
                                  detail=f'章节={remaining_title} [{remaining_id}]',
                                  reason=outcomes.REASON_PREVIOUS_FAILED)
                break
