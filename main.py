import logging
import traceback
from threading import Lock

from dispatcher import DownloadDispatcher
from updater import updater
from utils import config
from utils.log import configure_logging
from utils.notify import notifier

configure_logging()

log = logging.getLogger(__name__)
_run_lock = Lock()


def _run():
    config.reload()
    notifier.clear()

    try:
        all_tasks = updater.process_updates()

        if not all_tasks:
            log.info("没有发现需要下载的更新")
            return

        log.info(f"发现来自 {len(set(t['site'] for t in all_tasks))} 个站点的更新任务")

        DownloadDispatcher.download_site(all_tasks)

    except Exception as e:
        log.error(f"主程序运行出错: {e}")
        log.debug(traceback.format_exc())
        notifier.add_error("System", "Main Loop", str(e))

    finally:
        notifier.flush()


def main():
    if not _run_lock.acquire(blocking=False):
        log.warning('已有下载任务运行，跳过本次触发')
        return
    try:
        _run()
    finally:
        _run_lock.release()


if __name__ == '__main__':
    main()
