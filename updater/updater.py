import json
import logging
from pathlib import Path
from typing import Dict, List, Any

from utils import config
from utils.notify import notifier
from site_registry import SITE_MAPPING
from . import outcomes
from .errors import InvalidRecordError, MissingFieldsError

log = logging.getLogger(__name__)

# 站点映射


def load_updater_json(file_path: str = "updater.json") -> Dict[str, List[Dict]]:
    path = Path(config.DATA_PATH, file_path)
    if not path.exists():
        return {}

    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)

            if not isinstance(data, dict):
                raise ValueError('updater.json 必须是站点对象')
            return data
    except Exception as e:
        log.error(f"加载updater.json出错: {e}")
        return {}


def _missing_fields(site_class, record) -> List[str]:
    if not isinstance(record, dict):
        return ['record']
    id_field = getattr(site_class, 'ID_FIELD', '') if site_class else ''
    required = getattr(site_class, 'REQUIRED_FIELDS', []) if site_class else []
    return [field for field in [id_field, *required] if field and field not in record]


def _check_record(site_name, site_class, site_instance, record):
    """Check one record, returning the tasks it produced (usually 0 or 1).

    Every record ends with exactly one of ``no_update``, ``task_created`` or
    ``check_failed``; a failure names the site, record and reason and never
    produces a task.
    """
    name = outcomes.record_name(record, site_class)
    try:
        if not isinstance(record, dict):
            raise MissingFieldsError('订阅记录必须是 JSON 对象')

        # Sites may raise (SubscriptionUpdater) or return False (JM and friends).
        if site_class.validate_record(record) is False:
            missing = _missing_fields(site_class, record)
            if missing:
                raise MissingFieldsError('缺少字段: ' + ', '.join(missing))
            raise InvalidRecordError('订阅记录未通过站点校验')

        if hasattr(site_instance, 'build_tasks'):
            source_tasks = site_instance.build_tasks(record) or []
            for task in source_tasks:
                notifier.add_update(site_name, task.get('name', name))
            if not source_tasks:
                outcomes.emit(outcomes.NO_UPDATE, site_name, name)
                return []
            outcomes.emit(outcomes.TASK_CREATED, site_name, name,
                          detail=f'生成 {len(source_tasks)} 个任务')
            return source_tasks

        chapters = site_instance.get_chapters(record)
        uuids = site_instance.find_subsequent_uuids(chapters, record.get('latest_chapter'))

        if uuids:
            notifier.add_update(site_name, name)
            task = site_instance.create_download_task(record, uuids)
            outcomes.emit(outcomes.TASK_CREATED, site_name, name,
                          detail=f'待下载 {len(uuids)} 章')
            return [task]

        outcomes.emit(outcomes.NO_UPDATE, site_name, name)
        return []

    except Exception as e:
        reason = outcomes.reason_for_exception(e)
        log.error(f"处理站点 {site_name} 记录失败: {e}")
        notifier.add_error(site_name, name, str(e))
        outcomes.emit(outcomes.CHECK_FAILED, site_name, name,
                      detail=str(e), reason=reason)
        return []


def process_updates() -> List[Dict[str, Any]]:
    tasks = []
    site_data = load_updater_json()
    if not isinstance(site_data, dict):
        site_data = {}

    for site_name, records in site_data.items():
        if not isinstance(records, list) or not records:
            continue

        site_class = None
        try:
            site_class = SITE_MAPPING.get(site_name)
        except ImportError as e:
            # 依赖缺失也要逐条留下可判读的结局。
            hint = f'{e}; pip install .[{site_name}]'
            notifier.add_error(site_name, '依赖缺失', hint)
            for record in records:
                outcomes.emit(outcomes.CHECK_FAILED, site_name,
                              outcomes.record_name(record), detail=hint,
                              reason=outcomes.REASON_DEPENDENCY_MISSING)
            continue

        if not site_class:
            log.error(f"未知站点: {site_name}")
            for record in records:
                outcomes.emit(outcomes.CHECK_FAILED, site_name,
                              outcomes.record_name(record),
                              detail=f'未知站点: {site_name}',
                              reason=outcomes.REASON_SITE_UNKNOWN)
            continue

        try:
            site_instance = site_class()
        except Exception as e:
            log.error(f"初始化站点 {site_name} 失败: {e}")
            for record in records:
                notifier.add_error(site_name, outcomes.record_name(record), str(e))
                outcomes.emit(outcomes.CHECK_FAILED, site_name,
                              outcomes.record_name(record), detail=str(e),
                              reason=outcomes.REASON_CHECK_ERROR)
            continue

        for record in records:
            tasks.extend(_check_record(site_name, site_class, site_instance, record))

    return tasks


def update_chapter_record(site_name: str, comic_id: str, new_chapter: str, file_path: str = "updater.json") -> bool:
    site_data = load_updater_json(file_path)

    # 获取该站点的记录列表
    site_records = site_data.get(site_name, [])
    site_class = SITE_MAPPING.get(site_name)

    if not site_class:
        log.error(f"未知站点: {site_name}")
        return False

    site_instance = site_class()
    updated = False

    for i, record in enumerate(site_records):
        record_id = site_instance.get_unique_id(record)

        if record_id == comic_id:
            site_records[i] = site_instance.update_record(record, new_chapter)
            updated = True
            break

    if not updated:
        log.error(f"找不到站点 {site_name} 中ID为 {comic_id} 的记录")
        return False

    # 更新整个站点数据
    site_data[site_name] = site_records

    # 写回文件
    try:
        path = Path(config.DATA_PATH, file_path)
        temporary = path.with_suffix(path.suffix + '.tmp')
        with open(temporary, 'w', encoding='utf-8') as f:
            json.dump(site_data, f, indent=2, ensure_ascii=False)
        temporary.replace(path)
        return True
    except Exception as e:
        log.error(f"更新updater.json失败: {e}")
        return False
