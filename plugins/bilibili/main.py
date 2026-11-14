import asyncio
import logging
import os
import time
from typing import List, Dict, Any

from downloader import downloader, postprocess
from updater import updater
from utils import config
from utils.notify import notifier
from .client import get_list, get_co, get_opus, get_opus_images
from .utils import clean_filename

log = logging.getLogger(__name__)

def _get_loop():
    try:
        return asyncio.get_event_loop()
    except RuntimeError:
        new_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(new_loop)
        return new_loop

class BilibiliAbortError(Exception):
    """用于强制停止 Bilibili 批处理的异常"""
    pass

async def get_chapter_content(task_type: str, uuid: str):
    """获取章节详情 (Bilibili CV or Opus)"""
    try:
        if task_type == 'opus':
            return await get_opus(int(uuid))
        elif task_type == 'cv':
            return await get_co(int(uuid))
            
        # OpusID 约18位，CVID 约8位
        if uuid.isdigit() and len(uuid) > 12:
            return await get_opus(int(uuid))
        else:
            return await get_co(int(uuid))
    except Exception as e:
        err_str = str(e)
        if "-509" in err_str or "请求过于频繁" in err_str:
            log.error(f"检测到 Bilibili 风控 (-509): {err_str}")
            raise BilibiliAbortError("Bilibili 请求过于频繁，已触发风控保护，停止当前任务。")
        log.error(f"Bilibili 内容解析失败: {e}")
        return None, None

def download_chapter(task: Dict[str, Any], uuid: str, chapter_name: str, chapter_index: int = 0):
    """下载单个章节 (CV 或 Opus)"""
    loop = _get_loop()
    
    effective_type = task.get('type')
    if effective_type == 'lid':
        effective_type = 'cv'
        
    images, cname = loop.run_until_complete(get_chapter_content(effective_type, uuid))
    
    if not images:
        log.error(f"无法获取 Bilibili 内容: {chapter_name} (ID: {uuid})")
        notifier.add_error("bilibili", f"{task['name']} - {chapter_name}", "获取内容失败")
        return False

    current_name = clean_filename(chapter_name)
    series_name = clean_filename(task['name'])
    
    save_path = os.path.join(config.DOWNLOAD_PATH, "bilibili", series_name, current_name)
    os.makedirs(save_path, exist_ok=True)

    log.info(f"开启下载 Bilibili {series_name} - {current_name}")

    download_failed = False
    for index, url in enumerate(images):
        image_path = os.path.join(save_path, f"{index:04d}.jpg")
        if downloader(url, image_path):
            log.debug(f"已下载 {index:04d}.jpg")
        else:
            log.error(f"下载失败: {index:04d}.jpg")
            download_failed = True

    if download_failed:
        notifier.add_error("bilibili", f"{task['name']} - {current_name}", "部分图片下载失败")

    log.info(f"{current_name} 下载完成，开始打包 CBZ")

    chapter_num = chapter_index + 1
    chapter_filename = f"{chapter_num:03d}-{current_name}" if task.get('type') == 'lid' else current_name

    postprocess(
        series_name=series_name,
        chapter_name=current_name,
        chapter_filename=chapter_filename,
        chapter_number=chapter_num,
        file_path=save_path
    )

    # 更新下载记录
    updater.update_chapter_record(
        task['site'], task['id'], uuid
    )

    notifier.add_success("bilibili", task['name'], current_name)
    log.info(f"{current_name} CBZ 打包完成")
    return True

def download_task(task: Dict[str, Any]):
    """处理单个 Bilibili 任务 (Lid/CV/Opus)"""
    if not task.get('chapter_infos'):
        log.info(f"{task['name']} 没有待下载内容")
        return

    log.info(f"开始处理 Bilibili {task['name']} 的 {len(task['chapter_infos'])} 个项目")

    for i, (uuid, name) in enumerate(task['chapter_infos']):
        try:
            success = download_chapter(task, uuid, name, i)
            if not success:
               log.error(f"下载失败: {name} (ID: {uuid})")
        except BilibiliAbortError:
            raise
        except Exception as e:
            log.error(f"处理异常: {e}")
            import traceback
            log.debug(traceback.format_exc())
            notifier.add_error("bilibili", f"{task['name']} - {name}", str(e))
        time.sleep(2)

def download_batch(tasks: List[Dict[str, Any]]):
    """批量处理 Bilibili 任务"""
    if not tasks:
        log.info("Bilibili 无需更新")
        return

    try:
        for task in tasks:
            info = (
                f"Bilibili 任务: {task['name']}\n"
                f"类型: {task['type']}\n"
                f"ID: {task['id']}\n"
                f"待更新数: {len(task.get('chapter_infos', []))}"
            )
            log.info(info)
            download_task(task)
    except BilibiliAbortError as e:
        msg = str(e)
        log.warning(f"Bilibili 批处理已终止: {msg}")
        notifier.add_error("bilibili", "系统风控", msg)
        return

    log.info("所有 Bilibili 任务处理完成")
