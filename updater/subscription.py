"""Ordered chapter subscriptions shared by the additional sources."""
from .base import BaseUpdater
from .errors import CursorNotFoundError, MissingFieldsError


class SubscriptionUpdater(BaseUpdater):
    REQUIRED_FIELDS = BaseUpdater.REQUIRED_FIELDS + ['name']

    @classmethod
    def validate_record(cls, record) -> bool:
        missing = [field for field in [cls.ID_FIELD, *cls.REQUIRED_FIELDS]
                   if field and field not in record]
        if missing:
            raise MissingFieldsError('缺少字段: ' + ', '.join(missing))
        return True

    def find_subsequent_uuids(self, chapters, target_chapter):
        self.chapter_numbers = {str(c['uuid']): i for i, c in enumerate(chapters, 1)}
        if target_chapter:
            matches = [i for i, c in enumerate(chapters)
                       if str(c['uuid']) == str(target_chapter)]
            if not matches:
                raise CursorNotFoundError(f'找不到上次章节 ID {target_chapter}，请核对或清空游标')
            chapters = chapters[matches[0] + 1:]
        return [(str(c['uuid']), c['name']) for c in chapters]

    def create_download_task(self, record, chapter_infos):
        return dict(record, site=self.SITE_NAME, chapter_infos=chapter_infos,
                    chapter_numbers=getattr(self, 'chapter_numbers', {}))
