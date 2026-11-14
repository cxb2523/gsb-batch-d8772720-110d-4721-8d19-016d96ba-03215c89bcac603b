# -*- coding: utf-8 -*-
"""
状态枚举常量（健壮性 L4）：统一项目内两套状态字段的取值语义，避免误用。

1. categories.crawl_status：列表采集阶段分类的爬取状态
2. product_links.detail_status：详情采集阶段单个 SKU 的爬取状态
"""


class CategoryCrawlStatus:
    """categories.crawl_status 取值（jdcrawler/spiders/jdproduct.py 使用）。"""
    PENDING = 0      # 待爬取
    CRAWLING = 1     # 爬取中（start 标记）
    DONE = 2         # 已爬取完成
    FAILED = 3       # 爬取失败（短响应被反爬 / 首页请求失败）


class DetailStatus:
    """product_links.detail_status 取值（scripts/* 详情采集使用）。"""
    PENDING = 0      # 待爬取
    SUCCESS = 1      # 已成功入库
    FAILED = 2       # 爬取/入库失败（也临时用作"采集中"，成功后改写为 SUCCESS）


# 便于日志打印的映射
CATEGORY_STATUS_TEXT = {
    CategoryCrawlStatus.PENDING: "待爬取",
    CategoryCrawlStatus.CRAWLING: "爬取中",
    CategoryCrawlStatus.DONE: "已爬取",
    CategoryCrawlStatus.FAILED: "爬取失败",
}

DETAIL_STATUS_TEXT = {
    DetailStatus.PENDING: "待爬取",
    DetailStatus.SUCCESS: "已成功",
    DetailStatus.FAILED: "失败",
}
