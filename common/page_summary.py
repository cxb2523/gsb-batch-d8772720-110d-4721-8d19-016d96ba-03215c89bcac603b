# -*- coding: utf-8 -*-
"""
三大招聘平台（BOSS直聘 / 51job / 猎聘）采集器统一的【单页采集小结】模块。

每处理完一页，采集器输出一行结构化小结（JSON），字段与状态取值在三个平台间
完全一致，便于运营横向对比：

    [单页小结] {"平台": "...", "页码": 1, "捕获岗位数": 15, "新增入库数": 5,
                "已存在跳过数": 8, "详情失败放弃数": 2, "结束状态": "正常完成",
                "触发原因": "", "计入成功页": true}

状态取值限定为：
    正常完成 / 已到最后一页 / 页面加载失败 / 数据包未捕获

规则：
- 状态非“正常完成”时必须写明触发原因，且该页不计入成功页（计入成功页=false）。
- 整页岗位都已存在时：新增=0、跳过数=捕获数，状态仍为“正常完成”。
"""

import json

# ===== 统一的结束状态取值（三个平台必须一致） =====
STATUS_OK = "正常完成"
STATUS_LAST_PAGE = "已到最后一页"
STATUS_LOAD_FAILED = "页面加载失败"
STATUS_PACKET_MISSING = "数据包未捕获"

ALL_STATUSES = (STATUS_OK, STATUS_LAST_PAGE, STATUS_LOAD_FAILED, STATUS_PACKET_MISSING)

# 小结行前缀，方便运营在日志中检索 / 程序解析
SUMMARY_PREFIX = "[单页小结]"


class PageSummary:
    """单页采集小结的结构化载体。"""

    def __init__(self, platform, page, captured=0, inserted=0, skipped=0,
                 detail_failed=0, status=STATUS_OK, reason=""):
        if status not in ALL_STATUSES:
            raise ValueError(f"非法的结束状态: {status!r}，取值限定为 {ALL_STATUSES}")
        self.platform = platform
        self.page = page
        self.captured = captured        # 本页捕获岗位数
        self.inserted = inserted        # 新增入库数
        self.skipped = skipped          # 因已存在（公司+职位+城市 查重）跳过数
        self.detail_failed = detail_failed  # 因详情获取失败放弃数
        self.status = status
        self.reason = reason
        # 状态非“正常完成”时必须写明触发原因
        if self.status != STATUS_OK and not self.reason:
            self.reason = "未记录具体触发原因"

    @property
    def is_success_page(self):
        """只有“正常完成”的页才计入成功页。"""
        return self.status == STATUS_OK

    def to_dict(self):
        """三个平台完全一致的中文字段，便于运营横向对比。"""
        return {
            "平台": self.platform,
            "页码": self.page,
            "捕获岗位数": self.captured,
            "新增入库数": self.inserted,
            "已存在跳过数": self.skipped,
            "详情失败放弃数": self.detail_failed,
            "结束状态": self.status,
            "触发原因": self.reason,
            "计入成功页": self.is_success_page,
        }

    def format_line(self):
        return f"{SUMMARY_PREFIX} " + json.dumps(self.to_dict(), ensure_ascii=False)

    def emit(self, logger=print):
        logger(self.format_line())
        return self


def emit_page_summary(summary, logger=print):
    """输出一行结构化单页小结。"""
    return summary.emit(logger=logger)


def abort_page(platform, page, status, reason, logger=print):
    """
    页面非正常结束时使用：构造小结（捕获数等为 0）、立即输出并返回。
    status 只能取 已到最后一页 / 页面加载失败 / 数据包未捕获。
    """
    if status == STATUS_OK:
        raise ValueError("abort_page 只用于非正常结束状态")
    summary = PageSummary(platform=platform, page=page, status=status, reason=reason)
    return emit_page_summary(summary, logger=logger)


def process_page_jobs(platform, page, jobs, identity_fn, exists_fn, detail_fn, save_fn,
                      describe_fn=None, sleep_fn=None, logger=print):
    """
    三个平台共用的“单页岗位处理流水线”，不改变各平台原有采集链路：
    列表已由各平台自己的方式取得（BOSS 走 boss export，51job / 猎聘走数据包拦截），
    这里只负责逐条：查重（公司+职位+城市）→ 下钻详情 → 入库，并统计小结数据。

    参数:
        platform:    平台名（与入库 platform 字段一致）
        page:        页码
        jobs:        本页列表（平台原始条目）；空列表 => 状态“已到最后一页”
        identity_fn: fn(job) -> (company, title, city)，查重键
        exists_fn:   fn(company, title, city) -> bool，前置查重
        detail_fn:   fn(job) -> dict | None；返回完整 job_data 字典，
                     返回 None 表示详情获取失败，该岗位放弃
        save_fn:     fn(job_data) -> bool（True 表示实际新增入库）
        describe_fn: 可选，fn(job) -> str，用于日志展示
        sleep_fn:    可选，每处理完一条（非跳过）后调用，保留原有防风控休眠
        logger:      日志输出函数，默认 print

    返回: PageSummary（调用方负责 emit）
    """
    if not jobs:
        return PageSummary(
            platform=platform, page=page, captured=0,
            status=STATUS_LAST_PAGE,
            reason="本页列表为空，未获取到任何岗位，判定已到最后一页",
        )

    total = len(jobs)
    summary = PageSummary(platform=platform, page=page, captured=total)

    for i, job in enumerate(jobs):
        company, title, city = identity_fn(job)
        desc = describe_fn(job) if describe_fn else f"{company} - {title}"

        if exists_fn(company, title, city):
            logger(f"   ⏩ [{i+1}/{total}] {desc} | 数据库已存在，跳过！")
            summary.skipped += 1
            continue

        logger(f"   🔍 [{i+1}/{total}] 正在抓取详情: {desc}")
        job_data = detail_fn(job)

        if job_data is None:
            logger(f"   ❌ [{i+1}/{total}] 详情获取失败，放弃该岗位: {desc}")
            summary.detail_failed += 1
            continue

        if save_fn(job_data):
            summary.inserted += 1

        if sleep_fn:
            sleep_fn()

    return summary
