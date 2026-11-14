import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from updater.yamibo import YamiboUpdater
from utils import config


class IntegrationTests(unittest.TestCase):
    def test_core_does_not_import_optional_sources(self):
        script = '''
import sys
class Block:
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] in {'jmcomic', 'bilibili_api', 'bs4', 'chompjs'}:
            raise ImportError(fullname)
sys.meta_path.insert(0, Block())
import main
assert not any(n.startswith('plugins.jm') for n in sys.modules)
'''
        subprocess.run([sys.executable, '-c', script], check=True)

    def test_cursor_is_id_and_missing_cursor_fails(self):
        updater = YamiboUpdater()
        chapters = [{'uuid': '1', 'name': 'same'}, {'uuid': '2', 'name': 'same'}]
        self.assertEqual(updater.find_subsequent_uuids(chapters, '1'), [('2', 'same')])
        with self.assertRaises(ValueError):
            updater.find_subsequent_uuids(chapters, 'missing')

    def test_false_configuration(self):
        self.assertFalse(config.parse_bool('false'))
        self.assertFalse(config.parse_bool('0'))
        self.assertTrue(config.parse_bool('true'))

    def test_failed_chapter_does_not_advance_cursor(self):
        from plugins.subscription import run_batch
        with tempfile.TemporaryDirectory() as tmp:
            task = {'site': 'yamibo', 'name': 'test', 'keyword': '1',
                    'chapter_infos': [('11', 'first'), ('12', 'second')]}
            with patch.object(config, 'DOWNLOAD_PATH', tmp), \
                 patch('downloader.postprocess', side_effect=RuntimeError('pack failed')), \
                 patch('updater.updater.update_chapter_record') as update:
                calls = []
                run_batch([task], lambda t, c, f: calls.append(c) or 1)
                self.assertEqual(calls, ['11'])
                update.assert_not_called()

    def test_complete_chapter_advances_cursor(self):
        from plugins.subscription import run_batch
        from updater.updater import load_updater_json
        with tempfile.TemporaryDirectory() as tmp:
            record = {'keyword': '1', 'name': 'test', 'latest_chapter': '', 'last_download_date': ''}
            Path(tmp, 'updater.json').write_text(json.dumps({'yamibo': [record]}), encoding='utf-8')
            with patch.object(config, 'DATA_PATH', tmp), patch.object(config, 'DOWNLOAD_PATH', tmp), \
                 patch('downloader.postprocess'):
                run_batch([dict(record, site='yamibo', chapter_infos=[('11', 'first')])], lambda *a: 1)
                self.assertEqual(load_updater_json()['yamibo'][0]['latest_chapter'], '11')

    def test_real_cbz_pack(self):
        from PIL import Image
        from downloader import postprocess
        from zipfile import ZipFile
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp, 'pages')
            folder.mkdir()
            Image.new('RGB', (8, 8)).save(folder / '0001.jpg')
            (folder / '0002.part').write_bytes(b'incomplete')
            with patch.object(config, 'CBZ_PATH', str(Path(tmp, 'output'))):
                postprocess('series', 'chapter', 'chapter', 1, str(folder))
                with ZipFile(Path(tmp, 'output', 'series', 'chapter.cbz')) as cbz:
                    from io import BytesIO
                    images = [n for n in cbz.namelist() if not n.lower().endswith('.xml')]
                    self.assertEqual(len(images), 1)
                    Image.open(BytesIO(cbz.read(images[0]))).verify()
                self.assertFalse(folder.exists())

    def test_incremental_number_is_stable(self):
        updater = YamiboUpdater()
        chapters = [{'uuid': str(i), 'name': str(i)} for i in range(1, 4)]
        infos = updater.find_subsequent_uuids(chapters, '2')
        task = updater.create_download_task({'keyword': '1', 'name': 'test'}, infos)
        self.assertEqual(task['chapter_numbers']['3'], 3)

    def test_jm_uses_sdk_image_decoder(self):
        from plugins.jm.main import download_photo
        from types import SimpleNamespace
        from unittest.mock import Mock
        client = Mock()
        image = SimpleNamespace(img_url='https://example.invalid/image.jpg')
        client.get_photo_detail.return_value = [image]
        client.download_by_image_detail.side_effect = lambda image, target: Path(target).write_bytes(b'decoded')
        with tempfile.TemporaryDirectory() as tmp:
            download_photo(client, '11', Path(tmp))
            self.assertEqual((Path(tmp) / '0001.jpg').read_bytes(), b'decoded')
        client.download_by_image_detail.assert_called_once()

    def test_yamibo_attachment_and_search(self):
        import httpx
        from plugins.yamibo.client import YamiboClient
        with patch('plugins.yamibo.client.config.get_setting', side_effect=lambda key, env, default: 'cookie' if key == 'yamibo_cookie' else 3):
            with YamiboClient() as client:
                search = httpx.Response(200, text='<li class="pbw" id="20"><h3 class="xs3"><a>test chapter</a></h3></li>',
                                        request=httpx.Request('GET', 'https://bbs.yamibo.com/search.php?searchid=1'))
                with patch.object(client, 'request', return_value=search):
                    self.assertEqual(client.chapters('test'), [{'uuid': '20', 'name': 'test chapter'}])
                post = httpx.Response(200, json={'Variables': {'postlist': [{'imagelist': ['1'],
                    'attachments': {'1': {'attachment': '2026/test.jpg'}}}]}})
                image = httpx.Response(200, content=b'image', headers={'content-type': 'image/jpeg'})
                with tempfile.TemporaryDirectory() as tmp, patch.object(client, 'request', side_effect=[post, image]):
                    self.assertEqual(client.download('20', Path(tmp)), 1)
                    self.assertEqual(Path(tmp, '0001.jpg').read_bytes(), b'image')


if __name__ == '__main__':
    unittest.main()
