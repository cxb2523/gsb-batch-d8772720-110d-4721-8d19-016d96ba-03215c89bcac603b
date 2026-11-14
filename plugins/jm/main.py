import logging
from pathlib import Path
from plugins.subscription import safe_name
from utils import config
from utils.notify import notifier
from .client import account_name, create_client
from .database import JmDatabase

log = logging.getLogger(__name__)


def download_photo(client, chapter_id, folder):
    photo = client.get_photo_detail(chapter_id, False)
    images = list(photo)
    if not images:
        raise ValueError('JM 章节没有图片')
    for index, image in enumerate(images, 1):
        target = folder / f'{index:04d}.jpg'
        if target.exists() and target.stat().st_size:
            continue
        temporary = folder / f'{index:04d}.part.jpg'
        # 必须由 SDK 解码切片图片，不能回退为原始 HTTP 下载。
        client.download_by_image_detail(image, str(temporary))
        if not temporary.exists() or not temporary.stat().st_size:
            raise RuntimeError('JM 图片下载为空')
        temporary.replace(target)
    return len(images)


def download_batch(tasks):
    from downloader import postprocess
    from updater import outcomes
    client = create_client()
    account = account_name()
    with JmDatabase(account) as db:
        for task in tasks:
            album_id = str(task['album_id'])
            pending = []
            try:
                if task.get('account') != account:
                    raise ValueError('JM 登录账号已变化，请重新检查收藏夹')
                album = client.get_album_detail(album_id)
                chapters = list(album)
                if not chapters:
                    raise ValueError('JM 专辑没有章节，保留待重试状态')
                title = str(getattr(album, 'title', None) or task['name'])
                db.save_metadata(album_id, {'title': title,
                    'authors': getattr(album, 'authors', []),
                    'tags': getattr(album, 'tags', []),
                    'description': getattr(album, 'description', ''),
                    'chapters': [{'id': str(p.photo_id), 'title': p.title} for p in chapters]})
                series = safe_name(f'{title} [JM-{album_id}]')
                pending = list(chapters)
                for number, chapter in enumerate(chapters, 1):
                    photo_id = str(chapter.photo_id)
                    chapter_title = chapter.title or f'第{number}话'
                    if db.is_packed(album_id, photo_id):
                        # 已打包章节属于“已跳过”，与本次“已下载”区分开。
                        outcomes.emit(outcomes.SKIPPED, 'jm', title,
                                      detail=f'章节={chapter_title} [{photo_id}]',
                                      reason=outcomes.REASON_ALREADY_PACKED)
                        pending = pending[1:]
                        continue
                    filename = safe_name(f'{chapter_title} [{photo_id}]')
                    folder = Path(config.DOWNLOAD_PATH) / 'jm' / safe_name(account) / safe_name(album_id) / safe_name(photo_id)
                    folder.mkdir(parents=True, exist_ok=True)
                    download_photo(client, photo_id, folder)
                    postprocess(series, chapter_title, filename, number, str(folder))
                    db.mark_packed(album_id, photo_id, Path(config.CBZ_PATH) / series / f'{filename}.cbz')
                    notifier.add_success('jm', title, chapter_title)
                    outcomes.emit(outcomes.DOWNLOADED, 'jm', title,
                                  detail=f'章节={chapter_title} [{photo_id}]')
                    pending = pending[1:]
                db.mark_completed(album_id)
            except Exception as exc:
                log.exception('JM 专辑 %s 下载失败，保留数据库进度', album_id)
                notifier.add_error('jm', task['name'], str(exc))
                # 失败章节之后的章节本次不处理，等下次从失败处重试。
                for chapter in pending[1:]:
                    outcomes.emit(outcomes.SKIPPED, 'jm', task['name'],
                                  detail=f'章节={chapter.title} [{chapter.photo_id}]',
                                  reason=outcomes.REASON_PREVIOUS_FAILED)
                outcomes.emit(outcomes.DOWNLOAD_FAILED, 'jm', task['name'],
                              detail=str(exc), reason=outcomes.REASON_DOWNLOAD_ERROR)

