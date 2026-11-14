import time
import csv
import datetime
import os
from functools import partial
import tkinter as tk
from tkinter import ttk
from tkinter import messagebox
import threading
import re
import sys
import json
import logging
from logging.handlers import TimedRotatingFileHandler
import urllib.parse

from mock_xhs_api import MockXhsApiClient


class XhsUserPosted:
    """小红书用户主页笔记采集模块

    负责：
    1. 遍历用户链接列表
    2. 分页获取用户发布的笔记列表（逐页实时写入 CSV，中断不丢已完成页）
    3. 每页结束后在界面日志追加一条可判读的结局：
       成功 / 空页（无更多数据，正常结束）/ 请求失败（后续页继续）
    4. 可选采集笔记详情（单条失败只记录该笔记 id，不影响列表行）
    5. 可选下载图片（失败不影响 CSV 行）

    请求函数通过 ``api_client`` 注入，默认使用本地假接口
    :class:`~mock_xhs_api.MockXhsApiClient`，真实接入时替换为同接口的
    平台客户端即可，本类的分页与落盘逻辑无需改动。
    """

    CSV_HEADER = ['页码', '笔记标题', '笔记类型', '笔记链接', '发布时间',
                  '点赞数', '评论数', '收藏数', '转发数']

    def __init__(self, user_link_list, top_num, pic_tag, detail_tag, txt_msglist,
                 logger, max_page=10, api_client=None, config_path='config_pub.json',
                 result_file=None):
        self.txt_msglist = txt_msglist
        self.logger = logger
        self.describe = []
        self.cookie_val = self.get_cookie()
        self.user_link_list = user_link_list or []
        self.top_num = int(top_num)
        self.pic_tag = pic_tag
        self.detail_tag = detail_tag
        self.max_page = int(max_page)
        # 可替换的请求函数集合；默认本地假接口，不依赖真实平台凭据
        self.api_client = api_client or MockXhsApiClient()
        self.config_path = config_path
        self.wait_sec = self.get_config_pub()
        now = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
        self.result_file = result_file or '小红书博主笔记_{}.csv'.format(now)
        # 逐页结局记录，元素为 dict，便于程序化校验与测试
        self.page_outcomes = []

    def tk_show(self, context):
        self.logger.info(context)
        try:
            self.txt_msglist.delete('1.0', 'end')
            self.describe.append(context)
            self.txt_msglist.insert('insert', '\n'.join(self.describe))
            self.txt_msglist.see("end")
        except Exception as e:
            # 界面组件异常不应影响采集主流程
            self.logger.error('[tk_show] %s', e)

    def trans_date(self, v_timestamp):
        timeArray = time.localtime(int(v_timestamp))
        otherStyleTime = time.strftime("%Y-%m-%d %H:%M:%S", timeArray)
        return otherStyleTime

    def trans_note_type(self, v_str):
        if v_str == 'all':
            return '不限'
        elif v_str == 'video':
            return '视频'
        elif v_str == 'normal':
            return '图文'
        else:
            return '未知'

    def get_cookie(self, num_tag=0):
        """[专有代码已移除] 从 cookie.txt 读取cookie"""
        return ""

    def get_config_pub(self):
        """读取 config_pub.json 的 wait_sec。

        小于 1 秒或文件缺失/格式错误时，按既有做法提示后 exit(1)。
        """
        try:
            with open(self.config_path, 'r', encoding='utf-8') as file:
                text = json.load(file)
            wait_sec = text['wait_sec']
            if wait_sec < 1:
                self.tk_show('\n等待时长需至少1秒，请重新配置！')
                exit(1)
            self.tk_show(f'\n读取config_pub成功, 等待间隔是:{wait_sec}s')
        except Exception as e:
            wait_sec = ''
            self.tk_show('\n读取config_pub失败！请检查config_pub.json')
            self.tk_show(str(e))
            exit(1)
        return wait_sec

    def down_pic(self, v_url, pic_name):
        """下载单张图片，委托给可替换的请求客户端。

        图片下载为可选动作，调用方负责捕获异常，失败不得影响 CSV 行。
        """
        return self.api_client.download_image(v_url, pic_name)

    def init_csv(self, csv_header):
        """新建结果文件并写入表头（每次采集一个全新文件）。"""
        with open(self.result_file, 'w', encoding='utf_8_sig', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(csv_header)
        self.tk_show('csv初始化完成:{}'.format(self.result_file))

    def get_xhs_detail(self, v_page, v_note_id, v_is_top, v_detail_tag, v_pic_tag):
        """采集单条笔记详情，委托给可替换的请求客户端。

        返回详情 dict；请求异常向上抛出，由调用方按笔记 id 记录，
        单条失败只影响该条，不影响列表字段写入 CSV。
        """
        return self.api_client.fetch_note_detail(v_note_id)

    @staticmethod
    def extract_user_id(v_user_link):
        """从博主主页链接中提取 user_id。

        兼容 ``/user/profile/xxx``、``?user_id=xxx`` 等常见形态，
        提取不到时退化为链接本身，保证假接口仍可区分不同博主。
        """
        if not v_user_link:
            return ''
        parsed = urllib.parse.urlparse(v_user_link)
        query = urllib.parse.parse_qs(parsed.query)
        if 'user_id' in query and query['user_id']:
            return query['user_id'][0]
        match = re.search(r'/user/profile/([^/?#]+)', parsed.path)
        if match:
            return match.group(1)
        match = re.search(r'/user/([^/?#]+)', parsed.path)
        if match:
            return match.group(1)
        return v_user_link.rstrip('/').split('/')[-1] or v_user_link

    def _record_outcome(self, user_link, page, status, message):
        """记录一页的采集结局，并在界面日志追加恰好一条可判读记录。"""
        outcome = {
            'user_link': user_link,
            'page': page,
            'status': status,  # success / empty / failed
            'message': message,
        }
        self.page_outcomes.append(outcome)
        self.tk_show(message)

    def _build_row(self, page, note):
        """把一条列表笔记转换为 CSV 行（列表字段始终可写）。"""
        return [
            page,
            note.get('title', ''),
            self.trans_note_type(note.get('note_type', '')),
            note.get('note_url', ''),
            self.trans_date(note.get('timestamp', 0)),
            note.get('liked_count', 0),
            note.get('comment_count', 0),
            note.get('collected_count', 0),
            note.get('shared_count', 0),
        ]

    def get_user_posted(self):
        """采集用户主页笔记列表主流程。

        1. 遍历博主主页链接列表，逐博主从第 1 页翻到 ``max_page``；
        2. 每页请求一次笔记列表，成功后逐行实时写入 CSV 并 flush/fsync，
           中途中断时已完成页仍保留在结果文件中；
        3. 每页结束追加一条结局日志：成功 / 空页 / 请求失败；
        4. 单页请求异常被捕获并记录为失败，后续页继续，不终止进程；
        5. 详情、图片均为可选开关，失败只记录日志，不影响 CSV 行。
        """
        self.init_csv(csv_header=self.CSV_HEADER)
        # 文件在整个采集过程中保持打开，每页写完立即 flush，保证中断不丢数据
        with open(self.result_file, 'a', encoding='utf_8_sig', newline='') as f:
            writer = csv.writer(f)

            for user_link in self.user_link_list:
                user_id = self.extract_user_id(user_link)
                self.tk_show('\n开始采集博主主页:{} (user_id={})'.format(user_link, user_id))

                for page in range(1, self.max_page + 1):
                    # —— 单页请求：异常必须被捕获，不能终止整个进程 ——
                    try:
                        resp = self.api_client.fetch_user_notes(
                            user_id, page, self.top_num)
                    except Exception as e:
                        # 失败页不得记成成功，也不得静默跳过；后续页继续
                        msg = ('第{}页 请求失败，失败原因:{}，后续页将继续采集'.format(page, e))
                        self._record_outcome(user_link, page, 'failed', msg)
                        self._wait()
                        continue

                    notes = (resp or {}).get('notes', []) or []

                    # —— 空页：无更多数据，视为正常结束，停止该博主后续翻页 ——
                    if not notes:
                        msg = '第{}页 空页，无更多数据，本博主采集正常结束'.format(page)
                        self._record_outcome(user_link, page, 'empty', msg)
                        break

                    # —— 成功页：逐条处理可选详情/图片，列表字段照常写入 ——
                    page_rows = []
                    for idx, item in enumerate(notes):
                        note_id = item.get('note_id', '')

                        if self.detail_tag:
                            try:
                                self.get_xhs_detail(page, note_id, idx,
                                                    self.detail_tag, self.pic_tag)
                            except Exception as e:
                                # 单条详情失败只影响该条，按笔记 id 记录原因
                                self.tk_show(
                                    '笔记id:{} 详情采集失败，失败原因:{}，'
                                    '列表字段仍正常写入CSV'.format(note_id, e))

                        row = self._build_row(page, item)
                        page_rows.append(row)

                        if self.pic_tag:
                            try:
                                pic_name = '{}_{}.jpg'.format(note_id, idx)
                                self.down_pic(item.get('image_url', ''), pic_name)
                            except Exception as e:
                                # 图片下载失败不得影响 CSV 行
                                self.tk_show(
                                    '笔记id:{} 图片下载失败，失败原因:{}，'
                                    '不影响CSV行写入'.format(note_id, e))

                    # 本页全部行一次性追加后立即落盘
                    writer.writerows(page_rows)
                    f.flush()
                    os.fsync(f.fileno())

                    msg = '第{}页 采集成功，本页写入{}条'.format(page, len(page_rows))
                    self._record_outcome(user_link, page, 'success', msg)
                    self._wait()

        self.tk_show('\n全部博主采集结束，结果文件:{}'.format(self.result_file))
        return self.result_file

    def _wait(self):
        """按 config_pub.json 的 wait_sec 控制请求节奏。"""
        try:
            time.sleep(self.wait_sec)
        except Exception:
            pass
