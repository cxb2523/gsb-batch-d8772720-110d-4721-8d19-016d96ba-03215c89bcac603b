"""Commit subscription progress only after a complete chapter is packed."""
import logging
import re
from pathlib import Path

from utils import config
from utils.notify import notifier

log = logging.getLogger(__name__)


def safe_name(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value)).strip(' .')
    if not name or name in {'.', '..'}:
        raise ValueError('无效文件名')
    if name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *{f'COM{i}' for i in range(1, 10)}, *{f'LPT{i}' for i in range(1, 10)}}:
        name = '_' + name
    return name[:160]


def run_batch(tasks, fetch):
    from downloader import postprocess
    from updater.updater import update_chapter_record
    for task in tasks:
        site = task['site']
        id_field = 'keyword'
        series = safe_name(task['name'])
        for number, (chapter_id, title) in enumerate(task['chapter_infos'], 1):
            try:
                filename = safe_name(f'{title} [{chapter_id}]')
                folder = Path(config.DOWNLOAD_PATH) / site / safe_name(task[id_field]) / safe_name(chapter_id)
                folder.mkdir(parents=True, exist_ok=True)
                count = fetch(task, chapter_id, folder)
                if count <= 0:
                    raise ValueError('章节没有图片')
                chapter_number = task.get('chapter_numbers', {}).get(str(chapter_id), number)
                postprocess(series, title, filename, chapter_number, str(folder))
                if not update_chapter_record(site, task[id_field], str(chapter_id)):
                    raise RuntimeError('保存章节进度失败')
                notifier.add_success(site, task['name'], title)
            except Exception as exc:
                log.exception('下载 %s / %s 失败', series, title)
                notifier.add_error(site, task['name'], str(exc))
                # 不越过失败章节推进游标；下次仍可重试。
                break
