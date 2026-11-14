# coding=utf-8
"""H03 滚动加载翻页采集：可续采采集器。

练习页每次只返回当前页，并在 id 为 ``sLaOuol2SM0iFj4d`` 的 div 文本里给出
下一页标识（URL 末段）；标识为空表示已到末页。

本模块在原有 ``base_url`` / ``myheaders`` 请求、逐页 HTML 落盘 ``./data/h03``
的基础上，把翻页过程改造为 :func:`collect` 采集器，支持：

* 逐页记录页码、请求地址、结局（成功 / 失败 / 未采）与失败原因；
* 单页请求失败不抛异常、不伪装成功，返回完整汇总；
* 区分“自然到末页”与“因页数上限截断”，并给出未采页面清单；
* 传入起始页标识与历史明细从断点续采，续采结果与一次采完的页面集合一致。
"""
import json
import os.path

import requests
from lxml import etree

base_url = 'https://spiderbuf.cn/web-scraping-practice/scraping-scroll-load'

myheaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.164 Safari/537.36'}

# 下一页标识所在 div 的 id
MARKER_DIV_ID = 'sLaOuol2SM0iFj4d'
# 首页标识：空串表示请求 base_url 本身
FIRST_PAGE_TOKEN = ''
DEFAULT_DATA_DIR = './data/h03'
DEFAULT_MAX_PAGES = 10

# 逐页结局
STATUS_SUCCESS = '成功'
STATUS_FAILED = '失败'
STATUS_PENDING = '未采'

# 结束原因代码 -> 中文说明
END_REASON_TEXT = {
    'natural_end': '自然到末页：下一页标识为空',
    'limit_truncated': '因页数上限截断，存在未采页面',
    'request_failed': '页面请求失败，翻页链中断，可使用 resume_token 续采',
    'homepage_request_failed': '首页请求失败，未开始翻页',
    'marker_not_found': '页面中找不到下一页标识 div(sLaOuol2SM0iFj4d)',
}


def getHTML(url, file_name=''):
    html = requests.get(url, headers=myheaders).text
    if file_name != '':
        with open(file_name, 'w', encoding='utf-8') as f:
            f.write(html)
    return html


def downloadImage(url, path=''):
    img_data = requests.get(url, headers=myheaders).content
    # get image file name
    file_name = url.split('/').pop()

    with open(os.path.join(path, file_name), 'wb') as img:
        img.write(img_data)


def parseHTML(html):
    # parse html source code here
    root = etree.HTML(html)
    divs = root.xpath('/html/body/div/div/div[@style="margin-top: 10px;"]')
    i = 1
    for div in divs:
        if i % 2 == 0:
            # 简介 /html/body/div[2] /div[3]/div
            summarys = div.xpath('./div/text()')
            summary = ''
            if len(summarys) > 0:
                summary = summarys[0].strip()
            print(summary)
        else:
            titles = div.xpath('./div/h2')
            title = ''
            if len(titles) > 0:
                title = titles[0].text
                print(title)
            #haibao
            img_urls = div.xpath('./div/div/img/@src')
            img_url = ''
            if len(img_urls) > 0:
                img_url = 'https://spiderbuf.cn/' + img_urls[0]
            print(img_url)
            downloadImage(img_url, './data/h02')
            # 评分 /html/body/div[2]/div[2]  /div/div[2]/span[1]
            ratings = div.xpath('./div/div/span[contains(text(),"豆瓣电影评分:")]/following::text()[1]')
            rating = ''
            if len(ratings) > 0:
                rating = ratings[0].strip()
            print(rating)
            # 导演 /html/body/div[2]/div[2] /div/div[2]/span[2]/span[2]
            directors = div.xpath('./div/div/span/span[contains(text(),"导演")]/following::text()')
            director = ''
            if len(directors) > 1:
                director = directors[1].strip()
            if len(directors) > 3:
                director += '/' + directors[2].strip()
            print(director)
            # 编剧 /html/body/div[2]/div[2] /div/div[2]/span[3]/span[2]
            scriptwriters = div.xpath('./div/div/span/span[contains(text(),"编剧")]/following::text()')
            scriptwriter = ''
            if len(scriptwriters) > 0:
                scriptwriter = scriptwriters[1].strip()

            if len(scriptwriters) > 3:
                scriptwriter += scriptwriters[2].strip()
            print(scriptwriter)
            # 主演
            performers = div.xpath('./div/div/span/span[contains(text(),"主演")]/following::text()')
            performer = ''
            if len(performers) > 0:
                performer = performers[1].strip()

            if len(performers) > 3:
                performer += performers[2].strip()
            print(performer)
            # 类型
            genres = div.xpath('./div/div/span/span[contains(text(),"类型:")]/following::text()')
            genre = ''
            if len(genres) > 0:
                genre = genres[0].strip()

            if len(performers) > 1:
                genre += genres[1].strip()
            print(genre)
            # 制片国家/地区
            areas = div.xpath('./div/div/span/span[contains(text(),"制片国家/地区:")]/following::text()')
            area = ''
            if len(areas) > 0:
                area = areas[0].strip()
            print(area)
            # 语言
            langs = div.xpath('./div/div/span/span[contains(text(),"语言:")]/following::text()')
            lang = ''
            if len(langs) > 0:
                lang = langs[0].strip().replace('\n', '')
            if len(langs) > 1:
                lang += langs[1].strip().replace('\n', '')
            print(lang)
            # 又名
            aliases = div.xpath('./div/div/span/span[contains(text(),"又名:")]/following::text()')
            alias = ''
            if len(aliases) > 0:
                alias = aliases[0].strip().replace('\n', '').replace('|', '')
            if len(aliases) > 1:
                alias += aliases[1].strip().replace('\n', '').replace('|', '')
            print(alias)
            # IMDb
            imdbs = div.xpath('./div/div/span[contains(text(),"IMDb:")]/following::text()')
            imdb = ''
            if len(imdbs) > 0:
                imdb = imdbs[0].strip().replace('\n', '')
            print(imdb)
            # 上映日期
            release_dates = div.xpath('./div/div/span/span[contains(text(),"上映日期:")]/following::text()')
            release_date = ''
            if len(release_dates) > 0:
                release_date = release_dates[0].strip().replace('\n', '')
            if len(release_dates) > 1:
                release_date += release_dates[1].strip().replace('\n', '')
            print(release_date)
            # 片长
            runtimes = div.xpath('./div/div/span/span[contains(text(),"片长:")]/following::text()')
            runtime = ''
            if len(runtimes) > 0:
                runtime = runtimes[0].strip().replace('\n', '')
            if len(runtimes) > 1:
                runtime += runtimes[1].strip().replace('\n', '')
            print(runtime)
        i += 1


def default_fetch(url):
    """默认取页函数：仍用 base_url 同源地址与 myheaders 发请求。

    失败（连接错误 / HTTP 4xx-5xx）时抛异常，由 :func:`collect` 捕获。
    """
    response = requests.get(url, headers=myheaders, timeout=15)
    response.raise_for_status()
    return response.text


def build_url(token):
    """根据页面标识拼请求地址：空标识为首页 base_url，否则 base_url/token。"""
    if token == FIRST_PAGE_TOKEN:
        return base_url
    return base_url + '/' + token


def extract_next_token(html):
    """解析下一页标识。

    :return: 标识字符串（空串表示已到末页）；找不到标识 div 时返回 None。
    """
    if not html:
        return None
    try:
        root = etree.HTML(html)
    except etree.Error:
        return None
    if root is None:
        return None
    divs = root.xpath('//div[@id="%s"]' % MARKER_DIV_ID)
    if len(divs) == 0:
        return None
    # div 存在但文本为空 -> 末页；div 不存在 -> None（由上面分支处理）
    texts = divs[0].xpath('./text()')
    token = texts[0].strip() if len(texts) > 0 else ''
    return token


def _safe_file_token(token):
    """把页面标识清洗成可用于文件名的片段。"""
    return token.replace('/', '_').replace('\\', '_').replace(':', '_')


def _page_record(page, token, url, status, reason='', file_path='', next_token=None):
    return {
        'page': page,
        'token': token,
        'url': url,
        'status': status,
        'reason': reason,
        'file': file_path,
        'next_token': next_token,
    }


def _count(details, status):
    return sum(1 for item in details if item['status'] == status)


def collect(max_pages=DEFAULT_MAX_PAGES,
            start_token=FIRST_PAGE_TOKEN,
            prior_pages=None,
            data_dir=DEFAULT_DATA_DIR,
            fetcher=None,
            max_retries=0):
    """按标识链逐页采集，返回汇总字典（任何单页失败都不抛异常）。

    :param max_pages: 页数上限，达到上限即截断；按“总页数”（含历史页）计。
    :param start_token: 本次运行第一个请求的页面标识，默认空串（首页）；
        断点续采时传上一次汇总里的 ``resume_token``。
    :param prior_pages: 上一次运行汇总中的逐页明细（``pages``），仅其中的
        成功页会被原样并入，失败 / 未采页不保留结论、需重新采集，因此不会
        重复计入已采页。
    :param data_dir: 每页 HTML 的落盘目录，默认 ``./data/h03``。
    :param fetcher: 可注入的取页函数 ``fetcher(url) -> html``，失败抛异常；
        默认走 :func:`default_fetch`（requests + myheaders）。
    :param max_retries: 单页请求失败后的额外重试次数（默认 0，不重试）。
    :returns: 汇总 dict，含成功 / 失败 / 未采页数、结束原因、逐页明细、
        未采页面清单与建议的续采标识 ``resume_token``。
    """
    fetcher = fetcher or default_fetch

    # 1) 并入历史成功页（去重、按页码排序），失败/未采页不沿用旧结论
    details = []
    seen_pages = set()
    if prior_pages:
        for record in prior_pages:
            if record.get('status') == STATUS_SUCCESS and record['page'] not in seen_pages:
                details.append(dict(record))
                seen_pages.add(record['page'])
    details.sort(key=lambda item: item['page'])

    end_reason = None
    token = start_token

    while end_reason is None:
        page_no = len(details) + 1

        # 已达页数上限：当前 token 是已知的下一页，如实记一条“未采”
        if page_no > max_pages:
            details.append(_page_record(
                page_no, token, build_url(token), STATUS_PENDING,
                reason='页数上限（max_pages=%d）截断，未发起请求' % max_pages))
            end_reason = 'limit_truncated'
            break

        url = build_url(token)

        # 2) 取页（带可选重试），任何异常都不外抛
        html = None
        errors = []
        for attempt in range(1, max_retries + 2):
            try:
                html = fetcher(url)
                break
            except Exception as exc:  # noqa: BLE001 - 采集器需吞掉单页全部异常
                errors.append('第%d次请求失败：%s: %s'
                              % (attempt, type(exc).__name__, exc))
        if html is None:
            reason = '；'.join(errors)
            details.append(_page_record(page_no, token, url,
                                        STATUS_FAILED, reason=reason))
            end_reason = ('homepage_request_failed' if page_no == 1
                          else 'request_failed')
            break

        # 3) 保留“每页 HTML 写入 ./data/h03”的做法
        os.makedirs(data_dir, exist_ok=True)
        if token == FIRST_PAGE_TOKEN:
            file_name = 'h03.html'
        else:
            file_name = 'h03_%s.html' % _safe_file_token(token)
        file_path = os.path.join(data_dir, file_name)
        with open(file_path, 'w', encoding='utf-8') as handle:
            handle.write(html)

        # 4) 解析下一页标识：None=找不到标识；''=自然末页
        next_token = extract_next_token(html)
        if next_token is None:
            details.append(_page_record(
                page_no, token, url, STATUS_SUCCESS,
                reason='页面中找不到下一页标识，无法继续翻页',
                file_path=file_path, next_token=None))
            end_reason = 'marker_not_found'
            break

        retry_note = '；'.join(errors) + ('；重试后成功' if errors else '')
        details.append(_page_record(
            page_no, token, url, STATUS_SUCCESS, reason=retry_note,
            file_path=file_path, next_token=next_token))

        if next_token == FIRST_PAGE_TOKEN:
            end_reason = 'natural_end'
            break

        # 还有下一页，但再采一页就超上限：把已知的下一页记为未采
        if page_no + 1 > max_pages:
            details.append(_page_record(
                page_no + 1, next_token, build_url(next_token),
                STATUS_PENDING,
                reason='页数上限（max_pages=%d）截断，未发起请求' % max_pages))
            end_reason = 'limit_truncated'
            break

        token = next_token

    # 5) 汇总：失败页 / 未采页都给出可续采标识
    failed_pages = [item for item in details if item['status'] == STATUS_FAILED]
    pending_pages = [item for item in details if item['status'] == STATUS_PENDING]
    if failed_pages:
        resume_token = failed_pages[-1]['token']
    elif pending_pages:
        resume_token = pending_pages[-1]['token']
    else:
        resume_token = None

    return {
        'success_count': _count(details, STATUS_SUCCESS),
        'failed_count': _count(details, STATUS_FAILED),
        'pending_count': _count(details, STATUS_PENDING),
        'end_reason': end_reason,
        'end_reason_text': END_REASON_TEXT[end_reason],
        'resume_token': resume_token,
        'pending_pages': pending_pages,
        'pages': details,
    }


if __name__ == '__main__':
    print(json.dumps(collect(), ensure_ascii=False, indent=2))
