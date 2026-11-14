"""Per-record subscription outcomes, driven by local fake site data only."""
import io
import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugins.subscription import run_batch
from updater import outcomes, updater
from updater.errors import CursorNotFoundError, MissingFieldsError
from updater.subscription import SubscriptionUpdater
from utils import config


class FakeUpdater(SubscriptionUpdater):
    """A real sequential subscription source backed by an in-memory site.

    No network access: the chapter list and cursor lookup come from
    ``SubscriptionUpdater`` itself, only ``get_chapters`` is faked.
    """

    SITE_NAME = 'fake'
    ID_FIELD = 'keyword'

    chapters_by_keyword = {
        'normal': [{'uuid': 'a1', 'name': 'A1'}, {'uuid': 'a2', 'name': 'A2'}],
        'done': [{'uuid': 'b1', 'name': 'B1'}],
    }

    def get_chapters(self, record):
        return self.chapters_by_keyword.get(record['keyword'], [])


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write_config(self, data):
        (self.root / 'updater.json').write_text(json.dumps(data), encoding='utf-8')

    def run_checks(self, data):
        self.write_config(data)
        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(updater, 'SITE_MAPPING', {'fake': FakeUpdater}):
            with outcomes.collect() as entries:
                tasks = updater.process_updates()
        return tasks, entries

    def test_normal_record_creates_task(self):
        tasks, entries = self.run_checks({'fake': [
            {'keyword': 'normal', 'name': 'normal', 'latest_chapter': '', 'last_download_date': ''}]})
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]['chapter_infos'], [('a1', 'A1'), ('a2', 'A2')])
        self.assertEqual([e['outcome'] for e in entries], [outcomes.TASK_CREATED])
        self.assertEqual(entries[0]['site'], 'fake')
        self.assertEqual(entries[0]['record'], 'normal')

    def test_no_update_record_creates_no_task(self):
        tasks, entries = self.run_checks({'fake': [
            {'keyword': 'done', 'name': 'done', 'latest_chapter': 'b1', 'last_download_date': ''}]})
        self.assertEqual(tasks, [])
        self.assertEqual([e['outcome'] for e in entries], [outcomes.NO_UPDATE])

    def test_missing_cursor_fails_without_task(self):
        tasks, entries = self.run_checks({'fake': [
            {'keyword': 'normal', 'name': 'normal', 'latest_chapter': 'nope', 'last_download_date': ''}]})
        self.assertEqual(tasks, [])
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['outcome'], outcomes.CHECK_FAILED)
        self.assertEqual(entries[0]['reason'], outcomes.REASON_CURSOR_NOT_FOUND)
        self.assertEqual(entries[0]['site'], 'fake')
        self.assertEqual(entries[0]['record'], 'normal')
        self.assertIn('nope', entries[0]['detail'])

    def test_missing_fields_fail_with_reason(self):
        tasks, entries = self.run_checks({'fake': [
            {'keyword': 'normal', 'latest_chapter': '', 'last_download_date': ''}]})
        self.assertEqual(tasks, [])
        self.assertEqual(entries[0]['outcome'], outcomes.CHECK_FAILED)
        self.assertEqual(entries[0]['reason'], outcomes.REASON_FIELDS_MISSING)
        self.assertIn('name', entries[0]['detail'])

    def test_unknown_site_fails_per_record(self):
        tasks, entries = self.run_checks({'nosuchsite': [
            {'keyword': 'x', 'name': 'first'}, {'keyword': 'y', 'name': 'second'}]})
        self.assertEqual(tasks, [])
        self.assertEqual([e['outcome'] for e in entries], [outcomes.CHECK_FAILED] * 2)
        self.assertEqual({e['reason'] for e in entries}, {outcomes.REASON_SITE_UNKNOWN})

    def test_dependency_import_error_fails_per_record(self):
        class BrokenRegistry:
            def get(self, site):
                raise ImportError('No module named jmcomic')

            def __iter__(self):
                return iter(['jm'])

        (self.root / 'updater.json').write_text(json.dumps({'jm': [
            {'mode': 'favorites', 'name': 'favorites'}]}), encoding='utf-8')
        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(updater, 'SITE_MAPPING', BrokenRegistry()):
            with outcomes.collect() as entries:
                tasks = updater.process_updates()
        self.assertEqual(tasks, [])
        self.assertEqual(entries[0]['outcome'], outcomes.CHECK_FAILED)
        self.assertEqual(entries[0]['reason'], outcomes.REASON_DEPENDENCY_MISSING)
        self.assertIn('jmcomic', entries[0]['detail'])

    def test_mixed_batch_keeps_each_record_distinct(self):
        tasks, entries = self.run_checks({'fake': [
            {'keyword': 'normal', 'name': 'normal', 'latest_chapter': '', 'last_download_date': ''},
            {'keyword': 'done', 'name': 'done', 'latest_chapter': 'b1', 'last_download_date': ''},
            {'keyword': 'normal', 'name': 'broken', 'latest_chapter': 'nope', 'last_download_date': ''},
        ]})
        self.assertEqual(len(tasks), 1)
        self.assertEqual([e['outcome'] for e in entries],
                         [outcomes.TASK_CREATED, outcomes.NO_UPDATE, outcomes.CHECK_FAILED])
        self.assertEqual([e['record'] for e in entries], ['normal', 'done', 'broken'])

    def test_outcomes_are_written_to_log_output(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setLevel(logging.DEBUG)
        outcomes.log.addHandler(handler)
        try:
            self.run_checks({'fake': [
                {'keyword': 'normal', 'name': 'normal', 'latest_chapter': '', 'last_download_date': ''},
                {'keyword': 'normal', 'name': 'broken', 'latest_chapter': 'nope', 'last_download_date': ''},
            ]})
        finally:
            outcomes.log.removeHandler(handler)
        text = stream.getvalue()
        self.assertIn('site=fake', text)
        self.assertIn('record=normal', text)
        self.assertIn(outcomes.LABELS[outcomes.TASK_CREATED], text)
        self.assertIn(outcomes.LABELS[outcomes.CHECK_FAILED], text)
        self.assertIn(outcomes.REASON_LABELS[outcomes.REASON_CURSOR_NOT_FOUND], text)


class DownloadOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'updater.json').write_text(json.dumps({'yamibo': [
            {'keyword': '1', 'name': 'series', 'latest_chapter': '', 'last_download_date': ''}]}),
            encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def task(self, chapters):
        return {'site': 'yamibo', 'name': 'series', 'keyword': '1',
                'chapter_infos': chapters}

    def test_failed_chapter_stops_and_next_run_retries_same_chapter(self):
        chapters = [('11', 'first'), ('12', 'second'), ('13', 'third')]
        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(config, 'DOWNLOAD_PATH', str(self.root / 'dl')):
            with outcomes.collect() as first:
                with patch('downloader.postprocess', side_effect=RuntimeError('pack failed')):
                    run_batch([self.task(chapters)], lambda t, c, f: 1)
            saved = json.loads((self.root / 'updater.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['yamibo'][0]['latest_chapter'], '')
            self.assertEqual([e['outcome'] for e in first],
                             [outcomes.DOWNLOAD_FAILED, outcomes.SKIPPED, outcomes.SKIPPED])
            self.assertEqual(first[0]['reason'], outcomes.REASON_PACK_FAILED)
            self.assertEqual([e['reason'] for e in first[1:]], [outcomes.REASON_PREVIOUS_FAILED] * 2)

            attempted = []

            def fetch(task, chapter_id, folder):
                attempted.append(chapter_id)
                return 1

            with outcomes.collect() as second:
                with patch('downloader.postprocess'):
                    run_batch([self.task(chapters)], fetch)
            # 重跑仍从失败章节开始，成功后继续下一章。
            self.assertEqual(attempted, ['11', '12', '13'])
            self.assertEqual([e['outcome'] for e in second],
                             [outcomes.DOWNLOADED] * 3)
            saved = json.loads((self.root / 'updater.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['yamibo'][0]['latest_chapter'], '13')

    def test_partial_success_rerun_starts_at_failed_chapter(self):
        chapters = [{'uuid': '11', 'name': 'first'},
                    {'uuid': '12', 'name': 'second'},
                    {'uuid': '13', 'name': 'third'}]
        site = FakeUpdater()
        site.get_chapters = lambda record: chapters

        def fetch(task, chapter_id, folder):
            return 1

        # 章节 11 成功；章 12 打包失败；章 13 未尝试。
        calls = []

        def pack(series, title, filename, number, folder):
            calls.append(title)
            if title == 'second':
                raise RuntimeError('pack failed')

        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(config, 'DOWNLOAD_PATH', str(self.root / 'dl')), \
             patch('downloader.postprocess', side_effect=pack):
            with outcomes.collect() as first:
                run_batch([self.task([(c['uuid'], c['name']) for c in chapters])], fetch)
        self.assertEqual(calls, ['first', 'second'])
        self.assertEqual([e['outcome'] for e in first],
                         [outcomes.DOWNLOADED, outcomes.DOWNLOAD_FAILED, outcomes.SKIPPED])
        saved = json.loads((self.root / 'updater.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['yamibo'][0]['latest_chapter'], '11')

        # 重跑由游标重新生成任务：应从失败的 12 开始，而不是 13 或 11。
        infos = site.find_subsequent_uuids(chapters, saved['yamibo'][0]['latest_chapter'])
        self.assertEqual([c[0] for c in infos], ['12', '13'])
        attempted = []
        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(config, 'DOWNLOAD_PATH', str(self.root / 'dl')), \
             patch('downloader.postprocess'):
            with outcomes.collect() as second:
                run_batch([self.task(infos)],
                          lambda t, c, f: attempted.append(c) or 1)
        self.assertEqual(attempted, ['12', '13'])
        self.assertEqual([e['outcome'] for e in second], [outcomes.DOWNLOADED] * 2)

    def test_failed_fetch_is_reported_separately_from_pack_failure(self):
        def fetch(task, chapter_id, folder):
            if chapter_id == '12':
                raise RuntimeError('image download failed')
            return 1

        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(config, 'DOWNLOAD_PATH', str(self.root / 'dl')), \
             patch('downloader.postprocess'):
            with outcomes.collect() as entries:
                run_batch([self.task([('11', 'first'), ('12', 'second')])], fetch)
        self.assertEqual([e['outcome'] for e in entries],
                         [outcomes.DOWNLOADED, outcomes.DOWNLOAD_FAILED])
        self.assertEqual(entries[1]['reason'], outcomes.REASON_FETCH_FAILED)
        saved = json.loads((self.root / 'updater.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['yamibo'][0]['latest_chapter'], '11')

    def test_successful_chapter_is_distinct_from_skipped(self):
        chapters = [('11', 'first'), ('12', 'second')]
        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(config, 'DOWNLOAD_PATH', str(self.root / 'dl')), \
             patch('downloader.postprocess'):
            with outcomes.collect() as entries:
                run_batch([self.task(chapters)], lambda t, c, f: 1)
        self.assertEqual([e['outcome'] for e in entries],
                         [outcomes.DOWNLOADED, outcomes.DOWNLOADED])
        self.assertNotIn(outcomes.SKIPPED, [e['outcome'] for e in entries])
        saved = json.loads((self.root / 'updater.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['yamibo'][0]['latest_chapter'], '12')

    def test_cursor_save_failure_is_a_distinct_failure(self):
        with patch.object(config, 'DATA_PATH', str(self.root)), \
             patch.object(config, 'DOWNLOAD_PATH', str(self.root / 'dl')), \
             patch('downloader.postprocess'), \
             patch('updater.updater.update_chapter_record', return_value=False):
            with outcomes.collect() as entries:
                run_batch([self.task([('11', 'first'), ('12', 'second')])], lambda t, c, f: 1)
        self.assertEqual(entries[0]['outcome'], outcomes.DOWNLOAD_FAILED)
        self.assertEqual(entries[0]['reason'], outcomes.REASON_CURSOR_SAVE_FAILED)
        self.assertEqual(entries[1]['outcome'], outcomes.SKIPPED)

    def test_empty_task_is_skipped_not_completed(self):
        with outcomes.collect() as entries:
            run_batch([self.task([])], lambda t, c, f: 1)
        self.assertEqual(entries[0]['outcome'], outcomes.SKIPPED)
        self.assertEqual(entries[0]['reason'], outcomes.REASON_NO_CHAPTERS)


class CursorErrorTests(unittest.TestCase):
    def test_subscription_updater_raises_typed_cursor_error(self):
        from updater.yamibo import YamiboUpdater
        with self.assertRaises(CursorNotFoundError):
            YamiboUpdater().find_subsequent_uuids([{'uuid': '1', 'name': 'a'}], '2')

    def test_subscription_updater_raises_typed_missing_field_error(self):
        from updater.yamibo import YamiboUpdater
        with self.assertRaises(MissingFieldsError):
            YamiboUpdater.validate_record({'keyword': '1'})


class WebuiLogTests(unittest.TestCase):
    """The /api/logs endpoint must expose the per-record outcomes."""

    def test_outcomes_are_visible_via_logs_endpoint(self):
        try:
            import server
        except ImportError:
            self.skipTest('WebUI dependencies are not installed')

        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        log_dir = root / 'log'
        log_dir.mkdir()
        handler = logging.FileHandler(log_dir / '2026-01-01.log', encoding='utf-8')
        handler.setLevel(logging.DEBUG)
        outcomes.log.addHandler(handler)
        self.addCleanup(outcomes.log.removeHandler, handler)
        self.addCleanup(handler.close)

        (root / 'updater.json').write_text(json.dumps({'fake': [
            {'keyword': 'normal', 'name': 'normal', 'latest_chapter': '', 'last_download_date': ''},
            {'keyword': 'normal', 'name': 'badcursor', 'latest_chapter': 'zzz', 'last_download_date': ''},
        ]}), encoding='utf-8')

        with patch.object(config, 'DATA_PATH', str(root)), \
             patch.object(updater, 'SITE_MAPPING', {'fake': FakeUpdater}):
            with outcomes.collect():
                updater.process_updates()
            lines = server.get_logs()

        text = ''.join(lines)
        self.assertIn('site=fake', text)
        self.assertIn('record=normal', text)
        self.assertIn(outcomes.LABELS[outcomes.TASK_CREATED], text)
        self.assertIn(outcomes.LABELS[outcomes.CHECK_FAILED], text)
        self.assertIn(outcomes.REASON_LABELS[outcomes.REASON_CURSOR_NOT_FOUND], text)


if __name__ == '__main__':
    unittest.main()
