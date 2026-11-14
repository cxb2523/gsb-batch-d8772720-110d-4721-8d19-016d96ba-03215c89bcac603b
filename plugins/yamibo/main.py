from plugins.subscription import run_batch
from .client import YamiboClient


def download_batch(tasks):
    with YamiboClient() as client:
        run_batch(tasks, lambda task, chapter_id, folder: client.download(chapter_id, folder))
