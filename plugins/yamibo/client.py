import time
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from utils import config

BASE = 'https://bbs.yamibo.com/'


class YamiboClient:
    def __init__(self):
        cookie = config.get_setting('yamibo_cookie', 'CMNAS_YAMIBO_COOKIE', '')
        if not cookie:
            raise ValueError('请设置 CMNAS_YAMIBO_COOKIE 或 yamibo_cookie')
        self.delay = max(3, float(config.get_setting('yamibo_delay', 'CMNAS_YAMIBO_DELAY', 4)))
        self.client = httpx.Client(headers={'Cookie': cookie, 'Referer': BASE,
                                           'User-Agent': 'Mozilla/5.0'},
                                   timeout=30, follow_redirects=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.client.close()

    def request(self, method, url, **kwargs):
        for attempt in range(3):
            time.sleep(self.delay if attempt == 0 else 10)
            response = self.client.request(method, url, **kwargs)
            response.raise_for_status()
            if 'alert_info' not in response.text or 'messagetext' not in response.text:
                return response
        raise RuntimeError('Yamibo 限流或登录失效，请检查 Cookie 后重试')

    def chapters(self, keyword):
        response = self.request('POST', BASE + 'search.php?mod=forum', data={
            'srchtxt': keyword, 'seltableid': '0', 'srchfilter': 'all', 'srchfrom': '0',
            'orderby': 'dateline', 'ascdesc': 'desc', 'srchfid[]': '30', 'searchsubmit': 'yes'})
        results = {}
        visited = set()
        for _ in range(100):
            if str(response.url) in visited:
                raise RuntimeError('Yamibo 搜索分页循环')
            visited.add(str(response.url))
            soup = BeautifulSoup(response.text, 'html.parser')
            for item in soup.select('li.pbw'):
                link = item.select_one('h3.xs3 a')
                tid = item.get('id', '').removeprefix('normalthread_')
                if link and tid.isdigit():
                    title = link.get_text(strip=True)
                    if keyword.casefold() in title.casefold():
                        results[tid] = {'uuid': tid, 'name': title}
            next_link = soup.select_one('a.nxt')
            if not next_link:
                if not soup.select('li.pbw') and not soup.select('.pg'):
                    raise ValueError('Yamibo 搜索结果不可识别，可能需要重新登录或没有结果')
                return sorted(results.values(), key=lambda c: int(c['uuid']))
            next_url = urljoin(str(response.url), next_link['href'])
            if httpx.URL(next_url).host != 'bbs.yamibo.com':
                raise ValueError('Yamibo 分页域名异常')
            response = self.request('GET', next_url)
        raise RuntimeError('Yamibo 搜索超过 100 页，请缩小关键词范围')

    def download(self, chapter_id, folder):
        response = self.request('GET', BASE + 'api/mobile/index.php',
                                params={'module': 'viewthread', 'tid': chapter_id})
        post = response.json()['Variables']['postlist'][0]
        images = post.get('imagelist', [])
        attachments = post.get('attachments', {})
        if not images:
            raise ValueError('Yamibo 主楼没有可下载图片')
        for index, key in enumerate(images, 1):
            target = folder / f'{index:04d}.jpg'
            if target.exists() and target.stat().st_size:
                continue
            attachment = attachments[str(key)]['attachment']
            url = urljoin(BASE + 'data/attachment/forum/', attachment)
            # 不把论坛 Cookie 发送到第三方图片域名。
            if httpx.URL(url).host != 'bbs.yamibo.com':
                raise ValueError('不支持论坛外部附件地址')
            response = self.request('GET', url)
            if not response.content or not response.headers.get('content-type', '').startswith('image/'):
                raise ValueError('Yamibo 附件响应不是图片')
            temporary = target.with_suffix('.part')
            temporary.write_bytes(response.content)
            temporary.replace(target)
        return len(images)
