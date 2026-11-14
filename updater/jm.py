from .base import BaseUpdater


class JmUpdater(BaseUpdater):
    SITE_NAME = 'jm'
    ID_FIELD = 'mode'
    REQUIRED_FIELDS = ['name']

    @classmethod
    def get_field_meta(cls):
        meta = super().get_field_meta()
        meta['mode'].update(label='同步模式', default='favorites', placeholder='favorites')
        return meta

    @classmethod
    def validate_record(cls, record):
        return super().validate_record(record) and record.get('mode') == 'favorites'

    def build_tasks(self, record):
        from plugins.jm.client import account_name, create_client
        from plugins.jm.database import JmDatabase
        client = create_client()
        favorites = {}
        # Never stop at a cached ID: removals and reorderings invalidate that shortcut.
        for page in client.favorite_folder_gen():
            for album_id, title in page.iter_id_title():
                favorites[str(album_id)] = str(title)
        with JmDatabase(account_name()) as db:
            db.sync_favorites(favorites)
            return [{'site': 'jm', 'account': db.account, 'album_id': book['album_id'],
                     'name': book['title']} for book in db.pending_books()]
