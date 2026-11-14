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
    client = create_client()
    account = account_name()
    with JmDatabase(account) as db:
        for task in tasks:
            album_id = str(task['album_id'])
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
                for number, chapter in enumerate(chapters, 1):
                    photo_id = str(chapter.photo_id)
                    if db.is_packed(album_id, photo_id):
                        continue
                    chapter_title = chapter.title or f'第{number}话'
                    filename = safe_name(f'{chapter_title} [{photo_id}]')
                    folder = Path(config.DOWNLOAD_PATH) / 'jm' / safe_name(account) / safe_name(album_id) / safe_name(photo_id)
                    folder.mkdir(parents=True, exist_ok=True)
                    download_photo(client, photo_id, folder)
                    postprocess(series, chapter_title, filename, number, str(folder))
                    db.mark_packed(album_id, photo_id, Path(config.CBZ_PATH) / series / f'{filename}.cbz')
                    notifier.add_success('jm', title, chapter_title)
                db.mark_completed(album_id)
            except Exception as exc:
                log.exception('JM 专辑 %s 下载失败，保留数据库进度', album_id)
                notifier.add_error('jm', task['name'], str(exc))
