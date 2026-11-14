"""Ordered chapter subscriptions shared by the additional sources."""
from .base import BaseUpdater


class SubscriptionUpdater(BaseUpdater):
    REQUIRED_FIELDS = BaseUpdater.REQUIRED_FIELDS + ['name']

    def find_subsequent_uuids(self, chapters, target_chapter):
        self.chapter_numbers = {str(c['uuid']): i for i, c in enumerate(chapters, 1)}
        if target_chapter:
            matches = [i for i, c in enumerate(chapters)
                       if str(c['uuid']) == str(target_chapter)]
            if not matches:
                raise ValueError(f'找不到上次章节 ID {target_chapter}，请核对或清空游标')
            chapters = chapters[matches[0] + 1:]
        return [(str(c['uuid']), c['name']) for c in chapters]

    def create_download_task(self, record, chapter_infos):
        return dict(record, site=self.SITE_NAME, chapter_infos=chapter_infos,
                    chapter_numbers=getattr(self, 'chapter_numbers', {}))
