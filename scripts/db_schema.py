# -*- coding: utf-8 -*-
"""数据库表结构集中初始化（幂等、安全）。

所有核心表的建表语句统一收口到本模块，供：
- 列表采集管道（jdcrawler/pipelines.py）自动创建 product_links / product_category_relation；
- 详情采集包装器（detail_crawler_wrapper.py）自动创建 products 及唯一索引；
- --init-db 一键确保全部核心表存在。

设计原则：
- 全部使用 CREATE TABLE IF NOT EXISTS，重复运行安全（不会因表已存在报错）；
- 唯一索引缺失时用 ALTER ADD UNIQUE KEY（幂等，已存在则忽略错误）；
- 每个 ensure_* 内部都会 commit，调用方无需为建表语句再提交；
- 唯一索引检测兼容 DictCursor（返回 dict）与普通游标（返回 tuple）两种 fetchone 结果。

注意：jd_data 库本身仍需用户手动 CREATE DATABASE（见 docs/SETUP.md）；本模块只负责库内表。
"""

import pymysql


# ---------------------------------------------------------------------------
# DDL：三张核心表（与历史 json_to_products.init_products_table 定义保持一致）
# ---------------------------------------------------------------------------

CREATE_PRODUCT_LINKS_SQL = """
CREATE TABLE IF NOT EXISTS product_links (
    id                BIGINT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku_id            VARCHAR(50)    NOT NULL                COMMENT '商品SKU ID',
    source_url        VARCHAR(1024)  NOT NULL DEFAULT ''     COMMENT '商品详情页URL',
    crawl_status      TINYINT        NOT NULL DEFAULT 0      COMMENT '详情是否已入库products：0未 1已',
    detail_status     TINYINT        NOT NULL DEFAULT 0      COMMENT '详情爬取状态：0未爬 1成功 2失败',
    detail_crawled_at DATETIME       NULL                    COMMENT '详情爬取时间',
    detail_error      TEXT           NULL                    COMMENT '详情爬取错误信息',
    created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_sku_id (sku_id),
    KEY idx_detail_status (detail_status),
    KEY idx_crawl_status (crawl_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='京东商品链接表（列表采集产出）';
"""

CREATE_PRODUCT_CATEGORY_RELATION_SQL = """
CREATE TABLE IF NOT EXISTS product_category_relation (
    id          BIGINT   NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku_id      VARCHAR(50) NOT NULL                COMMENT '商品SKU ID',
    category_id BIGINT   NOT NULL DEFAULT 0         COMMENT '所属分类ID（categories.id）',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_sku_cat (sku_id, category_id),
    KEY idx_category_id (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品-分类关联表';
"""

CREATE_PRODUCTS_SQL = """
CREATE TABLE IF NOT EXISTS products (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    sku_id VARCHAR(50) COMMENT '商品SKU ID',
    category_id BIGINT COMMENT '分类ID',
    merchant_id BIGINT COMMENT '商家ID',
    title VARCHAR(500) COMMENT '商品标题',
    sub_title VARCHAR(500) COMMENT '商品副标题',
    brand VARCHAR(100) COMMENT '品牌',
    shop_name VARCHAR(200) COMMENT '店铺名称',
    cover_image VARCHAR(1000) COMMENT '封面图片URL',
    cover_image_local VARCHAR(1000) COMMENT '封面图本地路径（download_images 开启时填充）',
    gallery_json JSON COMMENT '轮播图JSON（每项含 url 与 local_path）',
    detail_media_json JSON COMMENT '详情图JSON（每项含 url 与 local_path）',
    description TEXT COMMENT '商品描述',
    price DECIMAL(10,2) COMMENT '现价',
    original_price DECIMAL(10,2) COMMENT '原价',
    sales INT DEFAULT 0 COMMENT '销量',
    stock INT DEFAULT 0 COMMENT '库存',
    comment_count INT DEFAULT 0 COMMENT '评论数',
    rating DECIMAL(3,2) COMMENT '评分',
    favorite_count INT DEFAULT 0 COMMENT '收藏数',
    attributes_json JSON COMMENT '属性JSON',
    tags_json JSON COMMENT '标签JSON',
    skus_json JSON COMMENT 'SKU列表JSON',
    comments_json JSON COMMENT '评论JSON',
    source VARCHAR(20) DEFAULT 'jd' COMMENT '数据来源',
    source_url VARCHAR(1000) COMMENT '原始URL',
    status TINYINT DEFAULT 1 COMMENT '状态：1正常',
    shop_logo_local VARCHAR(1000) COMMENT '店铺Logo本地路径（download_images 开启时填充）',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_category_id (category_id),
    INDEX idx_brand (brand),
    INDEX idx_shop_name (shop_name),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='京东商品详情表';
"""


# ---------------------------------------------------------------------------
# ensure 函数：调用方传入 cursor 与 connection（与 crawl_session 同款解耦风格）
# ---------------------------------------------------------------------------

def _exec(cursor, conn, sql):
    cursor.execute(sql)
    conn.commit()


def ensure_product_links_table(cursor, conn):
    """确保 product_links 表存在（列表采集管道依赖）。"""
    try:
        _exec(cursor, conn, CREATE_PRODUCT_LINKS_SQL)
    except pymysql.MySQLError as e:
        print("[schema] 确保 product_links 表失败: %s" % e)


def ensure_product_category_relation_table(cursor, conn):
    """确保 product_category_relation 表存在（列表采集管道依赖）。"""
    try:
        _exec(cursor, conn, CREATE_PRODUCT_CATEGORY_RELATION_SQL)
    except pymysql.MySQLError as e:
        print("[schema] 确保 product_category_relation 表失败: %s" % e)


def ensure_products_unique_skuid(cursor, conn, db_name):
    """确保 products.sku_id 唯一索引（幂等写入/重入的前提，修复 M1/M2）。

    兼容 DictCursor（dict）与普通游标（tuple）两种 fetchone 返回。
    若已存在重复 sku，ALTER 会失败，此时仅告警不阻塞（需先手动去重）。
    """
    try:
        cursor.execute(
            "SELECT COUNT(1) AS cnt FROM INFORMATION_SCHEMA.STATISTICS "
            "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'products' AND INDEX_NAME = 'uk_sku_id'",
            (db_name,),
        )
        row = cursor.fetchone()
        cnt = row.get("cnt") if isinstance(row, dict) else (row[0] if row else 0)
        if cnt == 0:
            cursor.execute("ALTER TABLE products ADD UNIQUE KEY uk_sku_id (sku_id)")
            conn.commit()
            print("[schema] 已为 products.sku_id 添加唯一索引 uk_sku_id")
    except pymysql.MySQLError as e:
        print("[schema] 确保 uk_sku_id 失败（若已存在重复 sku，请先手动去重）: %s" % e)


def ensure_products_image_columns(cursor, conn, db_name):
    """确保 products 表含本地路径列 cover_image_local / shop_logo_local（策略 C: URL+本地都存）。

    对已存在的旧表做幂等 ALTER ADD COLUMN（缺失才加）；新表由 CREATE_PRODUCTS_SQL 自带，无需 ALTER。
    逐列检测，避免重复执行报错。ALTER 不加 AFTER，列追加到表尾（与 PRODUCT_COLUMNS 末尾顺序一致）。
    """
    expected = {
        'cover_image_local': "VARCHAR(1000) COMMENT '封面图本地路径'",
        'shop_logo_local': "VARCHAR(1000) COMMENT '店铺Logo本地路径'",
    }
    try:
        cursor.execute(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'products'",
            (db_name,),
        )
        existing = {row['COLUMN_NAME'] for row in cursor.fetchall()}
        for col, ddl in expected.items():
            if col not in existing:
                cursor.execute("ALTER TABLE products ADD COLUMN %s %s" % (col, ddl))
                conn.commit()
                print("[schema] products 已补充本地路径列 %s" % col)
    except pymysql.MySQLError as e:
        print("[schema] 确保 products 本地路径列失败: %s" % e)


def ensure_products_table(cursor, conn, db_name):
    """创建 products 表（若不存在）并确保 sku_id 唯一索引与本地路径列。"""
    try:
        _exec(cursor, conn, CREATE_PRODUCTS_SQL)
        ensure_products_unique_skuid(cursor, conn, db_name)
        ensure_products_image_columns(cursor, conn, db_name)
    except pymysql.MySQLError as e:
        print("[schema] 确保 products 表失败: %s" % e)


def ensure_core_tables(cursor, conn, db_name):
    """确保全部核心表存在：product_links / product_category_relation / products / crawl_session。"""
    ensure_product_links_table(cursor, conn)
    ensure_product_category_relation_table(cursor, conn)
    ensure_products_table(cursor, conn, db_name)
    # crawl_session 与具体连接解耦，直接复用既有实现
    try:
        from crawl_session import ensure_session_table
        ensure_session_table(cursor, conn)
    except Exception as e:  # noqa: BLE001 - 会话表失败不应影响核心表
        print("[schema] 确保 crawl_session 表失败: %s" % e)
