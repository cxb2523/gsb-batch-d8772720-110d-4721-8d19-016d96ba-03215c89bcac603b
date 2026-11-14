import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from plugins.jm.database import JmDatabase
from updater.jm import JmUpdater
from utils import config


class FavoriteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(config, 'DATA_PATH', self.temp.name)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def page(self, items):
        return SimpleNamespace(iter_id_title=lambda: iter(items))

    def run_scan(self, pages):
        client = Mock()
        client.favorite_folder_gen.return_value = pages
        with patch('plugins.jm.client.create_client', return_value=client), \
             patch('plugins.jm.client.account_name', return_value='user'):
            return JmUpdater().build_tasks({'mode': 'favorites', 'name': 'favorites'})

    def test_removed_favorites_and_reordered_pages_do_not_hide_new_items(self):
        self.run_scan([self.page([('3', 'three'), ('2', 'two')]), self.page([('1', 'one')])])
        with JmDatabase('user') as db:
            db.mark_completed('3')
            db.mark_completed('2')
        tasks = self.run_scan([self.page([('2', 'two')]), self.page([('4', 'four')])])
        self.assertEqual({t['album_id'] for t in tasks}, {'1', '4'})
        with JmDatabase('user') as db:
            self.assertEqual(db.conn.execute('SELECT is_favorite FROM jm_books WHERE album_id="3"').fetchone()[0], 0)
            self.assertEqual(db.conn.execute('SELECT count(*) FROM jm_books').fetchone()[0], 4)
        tasks = self.run_scan([self.page([('3', 'three'), ('4', 'four')])])
        self.assertNotIn('3', {t['album_id'] for t in tasks})

    def test_failed_pagination_does_not_commit_partial_snapshot(self):
        self.run_scan([self.page([('1', 'one')])])
        def pages():
            yield self.page([('2', 'two')])
            raise RuntimeError('network failure')
        with self.assertRaises(RuntimeError):
            self.run_scan(pages())
        with JmDatabase('user') as db:
            self.assertEqual([(r['album_id'], r['is_favorite']) for r in db.pending_books()], [('1', 1)])

    def test_persistent_account_isolation(self):
        with JmDatabase('alice') as db:
            db.sync_favorites({'1': 'one'})
            db.mark_completed('1')
        with JmDatabase('bob') as db:
            db.sync_favorites({'1': 'one'})
            self.assertEqual(len(db.pending_books()), 1)
        with JmDatabase('alice') as db:
            self.assertEqual(db.pending_books(), [])

    def test_empty_favorites_preserve_history(self):
        self.run_scan([self.page([('1', 'one')])])
        self.run_scan([self.page([])])
        with JmDatabase('user') as db:
            self.assertEqual([(r['album_id'], r['is_favorite']) for r in db.pending_books()], [('1', 0)])

    def test_login_failure_preserves_database(self):
        self.run_scan([self.page([('1', 'one')])])
        with patch('plugins.jm.client.create_client', side_effect=ValueError('login failed')):
            with self.assertRaises(ValueError):
                JmUpdater().build_tasks({'mode': 'favorites', 'name': 'favorites'})
        with JmDatabase('user') as db:
            self.assertEqual(len(db.pending_books()), 1)

    def test_failed_chapter_retries_only_unfinished_chapter(self):
        from plugins.jm.main import download_batch
        chapters = [SimpleNamespace(photo_id='11', title='first'), SimpleNamespace(photo_id='12', title='second')]
        class Album(list):
            title = 'book'
        client = Mock()
        client.get_album_detail.return_value = Album(chapters)
        self.run_scan([self.page([('1', 'book')])])
        task = {'site': 'jm', 'account': 'user', 'album_id': '1', 'name': 'book'}
        output = Path(self.temp.name, 'cbz')
        def pack(series, title, filename, number, folder):
            target = output / series / f'{filename}.cbz'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'packed')
        with patch('plugins.jm.main.create_client', return_value=client), \
             patch('plugins.jm.main.account_name', return_value='user'), \
             patch.object(config, 'CBZ_PATH', str(output)), \
             patch.object(config, 'DOWNLOAD_PATH', str(Path(self.temp.name, 'downloads'))), \
             patch('downloader.postprocess', side_effect=pack), \
             patch('plugins.jm.main.download_photo', side_effect=[None, RuntimeError('failed')]):
            download_batch([task])
            with JmDatabase('user') as db:
                self.assertTrue(db.is_packed('1', '11'))
                self.assertEqual(len(db.pending_books()), 1)
            with patch('plugins.jm.main.download_photo') as fetch:
                download_batch([task])
                self.assertEqual(fetch.call_args.args[1], '12')
                fetch.assert_called_once()
        with JmDatabase('user') as db:
            self.assertEqual(db.pending_books(), [])

    def test_requires_favorites_mode(self):
        self.assertFalse(JmUpdater.validate_record({'album_id': '1', 'name': 'book'}))
        self.assertTrue(JmUpdater.validate_record({'mode': 'favorites', 'name': 'favorites'}))
