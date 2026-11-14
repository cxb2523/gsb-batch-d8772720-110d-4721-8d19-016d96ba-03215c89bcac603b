# -*- coding: utf-8 -*-
"""本地假接口（样例请求函数）。

本模块不依赖任何真实平台凭据，仅用于演示和测试博主主页笔记采集链路。
真实接入时，实现一个与 :class:`MockXhsApiClient` 相同接口的客户端，
在实例化 ``XhsUserPosted`` 时通过 ``api_client`` 参数注入即可，
采集主流程（分页、逐页结局、CSV 实时落盘）无需任何改动。

覆盖四种样例场景：
1. 成功页：正常返回笔记列表；
2. 空页：返回空列表（无更多数据，正常结束）；
3. 请求异常：指定页码抛出异常，由上层捕获并记录为“请求失败”；
4. 详情失败：指定笔记 id 的详情请求抛出异常，仅影响该条笔记。
"""


class MockXhsApiError(Exception):
    """假接口统一异常类型，模拟网络/接口请求失败。"""


class BaseXhsApiClient:
    """请求客户端接口约定。真实平台客户端实现同样的三个方法即可替换。"""

    def fetch_user_notes(self, user_id, page, page_size):
        """分页请求某博主主页的笔记列表。

        返回 dict：``{"notes": [...], "has_more": bool}``；
        请求失败时抛出异常，由采集主流程捕获。
        """
        raise NotImplementedError

    def fetch_note_detail(self, note_id):
        """请求单条笔记详情，返回详情 dict；失败时抛出异常。"""
        raise NotImplementedError

    def download_image(self, url, pic_name):
        """下载单张图片；失败时抛出异常，不得影响 CSV 行写入。"""
        raise NotImplementedError


class MockXhsApiClient(BaseXhsApiClient):
    """内存假接口，按确定性规则生成笔记数据。

    参数
    ----
    notes_per_page : int
        每个成功页返回的笔记条数；翻到超出总页数时返回空页。
    total_pages : int
        该博主“真实”拥有的数据页数，再往后翻即为空页。
    fail_pages : set/tuple
        需要模拟请求异常的页码（从 1 开始），访问这些页时抛出
        :class:`MockXhsApiError`。
    fail_detail_note_ids : set/tuple
        需要模拟详情请求失败的笔记 id 集合。
    fail_image_urls : set/tuple
        需要模拟图片下载失败的 url 集合。
    """

    def __init__(self,
                 notes_per_page=3,
                 total_pages=2,
                 fail_pages=None,
                 fail_detail_note_ids=None,
                 fail_image_urls=None):
        self.notes_per_page = int(notes_per_page)
        self.total_pages = int(total_pages)
        self.fail_pages = set(fail_pages or [])
        self.fail_detail_note_ids = set(fail_detail_note_ids or [])
        self.fail_image_urls = set(fail_image_urls or [])
        # 记录调用情况，便于测试断言
        self.list_call_log = []
        self.detail_call_log = []
        self.image_call_log = []

    @staticmethod
    def _make_note(user_id, page, idx):
        note_id = 'note_{}_p{}_{}'.format(user_id, page, idx)
        return {
            'note_id': note_id,
            'title': '笔记标题_{}_第{}页_{}'.format(user_id, page, idx),
            'note_type': 'video' if idx % 2 else 'normal',
            'note_url': 'https://www.xiaohongshu.com/explore/{}'.format(note_id),
            'timestamp': 1700000000 + page * 1000 + idx,
            'liked_count': str(page * 10 + idx),
            'comment_count': str(page * 5 + idx),
            'collected_count': str(page * 3 + idx),
            'shared_count': str(page * 2 + idx),
            'image_url': 'https://img.example.com/{}.jpg'.format(note_id),
        }

    def fetch_user_notes(self, user_id, page, page_size):
        self.list_call_log.append((user_id, page, page_size))
        if page in self.fail_pages:
            raise MockXhsApiError(
                '模拟列表请求失败: user_id={}, page={}'.format(user_id, page))
        if page < 1 or page > self.total_pages:
            return {'notes': [], 'has_more': False}
        notes = [self._make_note(user_id, page, idx)
                 for idx in range(self.notes_per_page)]
        return {'notes': notes, 'has_more': page < self.total_pages}

    def fetch_note_detail(self, note_id):
        self.detail_call_log.append(note_id)
        if note_id in self.fail_detail_note_ids:
            raise MockXhsApiError('模拟详情请求失败: note_id={}'.format(note_id))
        return {
            'note_id': note_id,
            'desc': '笔记{}的正文详情'.format(note_id),
            'image_list': ['https://img.example.com/{}_1.jpg'.format(note_id)],
        }

    def download_image(self, url, pic_name):
        self.image_call_log.append((url, pic_name))
        if url in self.fail_image_urls:
            raise MockXhsApiError('模拟图片下载失败: url={}'.format(url))
        # 样例不真正落盘，仅返回一个标记
        return pic_name
