# -*- coding: utf-8 -*-
"""
分类种子导入脚本

功能：
- 读取 seeds/jd_categories_full.json（京东完整分类树，4 级嵌套）
- 自建 categories 表（若不存在），递归解析分类树
- 为每个节点分配自增 id，维护 parent_id 与 id 路径（path）
- 标记叶子节点（is_leaf=1），供列表爬虫 jdproduct 抓取
- 支持增量导入、--reset 全量重建、--dry-run 仅统计

说明：
JSON 中绝大多数节点的 id 字段为空（不可作为主键），因此本脚本自行分配
自增 id，并通过 parent_id + path 维护层级关系。叶子节点（无 children）才会
被列表爬虫（jdproduct.py）作为抓取入口。

用法：
  python load_categories.py                # 增量导入（已存在的分类跳过）
  python load_categories.py --reset        # 清空 categories 表后全量重建
  python load_categories.py --dry-run      # 仅统计各级/叶子数量，不写库
"""

import json
import sys
import os
import argparse

# 将项目根目录加入 sys.path，确保从任意目录运行时都能导入 jdcrawler 包
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

try:
    from jdcrawler.settings import (
        MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DB, MYSQL_PORT, MYSQL_CHARSET
    )
except ImportError:
    # 备用配置（与 db_connection.py 保持一致）
    MYSQL_HOST = '127.0.0.1'
    MYSQL_USER = 'root'
    MYSQL_PASSWORD = '123456'
    MYSQL_DB = 'jd_data'
    MYSQL_PORT = 3306
    MYSQL_CHARSET = 'utf8mb4'

SEED_FILE = os.path.join(PROJECT_ROOT, 'seeds', 'jd_categories_full.json')

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS categories (
    id           INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(255)  NOT NULL                COMMENT '分类名称',
    parent_id    INT           NOT NULL DEFAULT 0      COMMENT '父分类 id，0 表示顶级',
    path         VARCHAR(512)  NOT NULL DEFAULT ''     COMMENT 'id 路径，如 1/5/23',
    level        TINYINT       NOT NULL DEFAULT 1      COMMENT '分类层级 1-4',
    source_url   VARCHAR(1024) NOT NULL DEFAULT ''     COMMENT '搜索入口 URL',
    crawl_status TINYINT       NOT NULL DEFAULT 0      COMMENT '0待爬 1爬取中 2完成 3失败 4部分完成',
    crawl_page   INT           NOT NULL DEFAULT 0      COMMENT '列表采集断点页（最后成功页，0=未开始）',
    crawl_items  INT           NOT NULL DEFAULT 0      COMMENT '列表采集累计已产出商品数',
    is_leaf      TINYINT       NOT NULL DEFAULT 0      COMMENT '1 叶子节点（列表爬虫可抓）',
    sort_order   INT           NOT NULL DEFAULT 0      COMMENT 'DFS 排序，列表爬虫按此顺序取分类',
    created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_path (path),
    KEY idx_is_leaf (is_leaf),
    KEY idx_crawl_status (crawl_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='京东商品分类树';
"""


def load_seed():
    """读取分类种子 JSON"""
    with open(SEED_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def count_nodes(nodes):
    """统计各级节点与叶子数量（dry-run 用，不依赖数据库）"""
    stat = {}
    leaf = {}

    def walk(ns, depth=1):
        for n in ns:
            lvl = n.get('level', depth)
            stat[lvl] = stat.get(lvl, 0) + 1
            kids = n.get('children') or []
            if not kids:
                leaf[lvl] = leaf.get(lvl, 0) + 1
            else:
                walk(kids, depth + 1)

    walk(nodes)
    return stat, leaf


def insert_tree(cursor, nodes, parent_id=0, parent_path='',
                sort_counter=None, counters=None):
    """
    递归插入分类树，维护 parent_id 与 id 路径。

    增量逻辑：同名同父节点已存在则跳过（复用其 id/path），保证重复运行幂等。
    """
    if sort_counter is None:
        sort_counter = [0]
    if counters is None:
        counters = {'inserted': 0, 'skipped': 0, 'leaf': 0}

    for n in nodes:
        sort_counter[0] += 1
        name = n.get('name', '')
        level = n.get('level', 1)
        url = n.get('url', '')
        kids = n.get('children') or []
        is_leaf = 1 if not kids else 0

        # 增量去重：同名同父已存在则复用
        cursor.execute(
            "SELECT id, path FROM categories WHERE name=%s AND parent_id=%s LIMIT 1",
            (name, parent_id),
        )
        row = cursor.fetchone()
        if row:
            node_id = row['id']
            path = row['path']
            counters['skipped'] += 1
        else:
            cursor.execute(
                "INSERT INTO categories (name, parent_id, level, source_url, is_leaf, sort_order) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (name, parent_id, level, url, is_leaf, sort_counter[0]),
            )
            node_id = cursor.lastrowid
            path = str(node_id) if not parent_path else f"{parent_path}/{node_id}"
            cursor.execute("UPDATE categories SET path=%s WHERE id=%s", (path, node_id))
            counters['inserted'] += 1
            if is_leaf:
                counters['leaf'] += 1

        if kids:
            insert_tree(cursor, kids, node_id, path, sort_counter, counters)

    return counters


def main():
    parser = argparse.ArgumentParser(description='京东分类种子导入脚本')
    parser.add_argument('--reset', action='store_true', help='清空 categories 表后全量重建')
    parser.add_argument('--dry-run', action='store_true', help='仅统计，不连接数据库')
    args = parser.parse_args()

    # dry-run：只读取种子做统计，不触碰数据库
    if args.dry_run:
        data = load_seed()
        stat, leaf = count_nodes(data)
        total = sum(stat.values())
        print(f"[dry-run] 种子文件: {SEED_FILE}")
        print(f"[dry-run] 总节点数: {total}")
        print(f"[dry-run] 各级节点数: {dict(sorted(stat.items()))}")
        print(f"[dry-run] 各级叶子数: {dict(sorted(leaf.items()))}")
        print(f"[dry-run] 叶子总数(列表爬虫可抓): {sum(leaf.values())}")
        return

    # 连接数据库并导入
    import pymysql
    conn = pymysql.connect(
        host=MYSQL_HOST, user=MYSQL_USER, password=MYSQL_PASSWORD,
        db=MYSQL_DB, port=MYSQL_PORT, charset=MYSQL_CHARSET,
        autocommit=False, cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with conn.cursor() as cursor:
            # 确保表存在
            cursor.execute(CREATE_TABLE_SQL)
            conn.commit()

            if args.reset:
                cursor.execute("TRUNCATE TABLE categories")
                conn.commit()
                print("[导入] 已重置 categories 表（自增 id 归零）")

            data = load_seed()
            counters = insert_tree(cursor, data)
            conn.commit()

            # 汇总统计
            cursor.execute("SELECT COUNT(*) AS c, SUM(is_leaf) AS leaf FROM categories")
            row = cursor.fetchone()
            print(f"[导入] 完成：本次新增 {counters['inserted']} 个，跳过已存在 {counters['skipped']} 个")
            print(f"[导入] categories 表现有 {row['c']} 个分类，其中叶子 {row['leaf']} 个（列表爬虫可抓）")
    finally:
        conn.close()


if __name__ == '__main__':
    main()
