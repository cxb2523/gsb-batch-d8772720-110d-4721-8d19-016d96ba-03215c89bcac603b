# -*- coding: utf-8 -*-
"""
商品入库公共逻辑（修复 M3 字段截断 + M5 DRY 重复）。

两条入库路径（实时爬取 `detail_crawler_wrapper` / 离线 JSON 导入 `json_to_products`）
共用同一套：图片 URL 提取、按表结构动态截断、字段组装、UPSERT 语句，
避免行为不一致（例如 gallery 提取逻辑差异）与漏改。
"""
import json

# products 表字段顺序（不含 id；id 由 product_links.id 决定，保证双路径一致）
# 末尾 cover_image_local / shop_logo_local 为「URL+本地都存」策略新增：本地路径列
PRODUCT_COLUMNS = [
    'sku_id', 'title', 'sub_title', 'category_id', 'brand',
    'cover_image', 'gallery_json', 'detail_media_json',
    'description', 'price', 'original_price', 'sales', 'stock',
    'comment_count', 'rating', 'shop_name',
    'attributes_json', 'tags_json', 'skus_json', 'comments_json',
    'source', 'source_url', 'status',
    'cover_image_local', 'shop_logo_local',
]
# 幂等写入：冲突时按 UNIQUE(sku_id) 更新除 id/sku_id 外的全部字段（修复 M1/M2）
PRODUCT_UPDATE_CLAUSE = ", ".join(
    f"{c}=VALUES({c})" for c in PRODUCT_COLUMNS if c != 'sku_id'
)
PRODUCT_UPSERT = f" ON DUPLICATE KEY UPDATE {PRODUCT_UPDATE_CLAUSE}"

# TEXT 类字段的硬上限（字符），超过会触发 Data too long（description 为 TEXT）
TEXT_MAX_CHARS = 65535


def extract_gallery_urls(gallery_json):
    """从 gallery_json 提取轮播图 URL（统一两条路径的提取逻辑，修复 M5）。

    兼容两种结构：
      - 嵌套列表：每项是一组不同尺寸的图片，优先取 size=='1440' 的那张，否则取第一张；
      - 扁平字典：直接取 url（跳过 type=='video'）。
    返回纯 URL 字符串列表。
    """
    urls = []
    if not gallery_json:
        return urls
    for item in gallery_json:
        if isinstance(item, list) and item:
            chosen = None
            for size_info in item:
                if isinstance(size_info, dict) and size_info.get('size') == '1440':
                    chosen = size_info.get('url')
                    break
            if chosen is None and isinstance(item[0], dict):
                chosen = item[0].get('url')
            if chosen:
                urls.append(chosen)
        elif isinstance(item, dict):
            if item.get('type') == 'video':
                continue
            if item.get('url'):
                urls.append(item['url'])
    return urls


def extract_detail_urls(detail_media_json):
    """从 detail_media_json 提取详情图 URL 列表（纯字符串）。"""
    urls = []
    if not detail_media_json:
        return urls
    for item in detail_media_json:
        if isinstance(item, dict) and item.get('url'):
            urls.append(item['url'])
    return urls


def extract_gallery_items(gallery_json):
    """从 gallery_json 提取轮播图条目（保留 url 与 local_path），供入库「URL+本地都存」使用。

    兼容两种结构：
      - 嵌套列表：每项是一组不同尺寸的图片，优先取 size=='1440' 的那张，否则取第一张；
      - 扁平字典：直接取 url（video 类型仅保留已下载的 local_path，url 留空）。
    返回 [{"url": ..., "local_path": ...}, ...]，local_path 缺失则为 ''。
    """
    items = []
    if not gallery_json:
        return items
    for item in gallery_json:
        if isinstance(item, list) and item:
            chosen = None
            for size_info in item:
                if isinstance(size_info, dict) and size_info.get('size') == '1440':
                    chosen = size_info
                    break
            if chosen is None and isinstance(item[0], dict):
                chosen = item[0]
            if chosen and isinstance(chosen, dict):
                items.append({'url': chosen.get('url', ''), 'local_path': chosen.get('local_path', '')})
        elif isinstance(item, dict):
            if item.get('type') == 'video':
                items.append({'url': '', 'local_path': item.get('local_path', '')})
                continue
            items.append({'url': item.get('url', ''), 'local_path': item.get('local_path', '')})
    return items


def extract_detail_items(detail_media_json):
    """从 detail_media_json 提取详情图条目（保留 url 与 local_path）。

    支持 dict 项与嵌套 list 项（dict 内取 url/local_path）。返回 [{"url":..,"local_path":..}, ...]。
    """
    items = []
    if not detail_media_json:
        return items
    for item in detail_media_json:
        if isinstance(item, dict):
            items.append({'url': item.get('url', ''), 'local_path': item.get('local_path', '')})
        elif isinstance(item, list):
            for sub in item:
                if isinstance(sub, dict):
                    items.append({'url': sub.get('url', ''), 'local_path': sub.get('local_path', '')})
    return items


def get_product_column_limits(cursor, db_name, cache_attr='_product_col_limits'):
    """从 INFORMATION_SCHEMA 读取 products 表 VARCHAR/CHAR 列的实际长度上限（修复 M3）。

    结果缓存到 cursor 对象上，避免每条商品重复查询元数据（同时缓解 L2）。
    若查询失败（无权限等），返回空 dict，退化为不截断（由 MySQL 抛错暴露问题）。
    """
    cached = getattr(cursor, cache_attr, None)
    if cached is not None:
        return cached
    limits = {}
    try:
        cursor.execute(
            "SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH "
            "FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'products' "
            "AND DATA_TYPE IN ('varchar', 'char')",
            (db_name,),
        )
        for row in cursor.fetchall():
            name = row['COLUMN_NAME']
            maxlen = row['CHARACTER_MAXIMUM_LENGTH']
            if maxlen:
                limits[name] = maxlen
    except Exception:
        limits = {}
    setattr(cursor, cache_attr, limits)
    return limits


def _truncate(col, value, limits, warn):
    """按列实际长度上限截断字符串（修复 M3 盲切）。超长时告警。"""
    if not isinstance(value, str) or col not in limits:
        return value
    limit = limits[col]
    if len(value) <= limit:
        return value
    warn(f"[截断告警] 字段 {col} 原始长度 {len(value)} 超过列上限 {limit}，已截断（信息可能丢失）")
    return value[:limit]


def _truncate_text(value, warn):
    """TEXT 类字段按固定上限截断（description 为 TEXT，65535 字符）。"""
    if not isinstance(value, str) or len(value) <= TEXT_MAX_CHARS:
        return value
    warn(f"[截断告警] description 原始长度 {len(value)} 超过 {TEXT_MAX_CHARS}，已截断")
    return value[:TEXT_MAX_CHARS]


def clean_text(text):
    """清理文本：移除控制字符并去首尾空白（从 json_to_products 提炼，修复 M5）。"""
    import re
    if not text:
        return ""
    text = re.sub(r'[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]', '', text)
    return text.strip()


def build_product_values(data, category_id, limits, warn=print):
    """按 PRODUCT_COLUMNS 组装一条 products 记录的值（不含 id）。

    - 图片统一提取为 [{"url": ..., "local_path": ...}]（URL+本地都存，两条路径一致）；
    - VARCHAR 字段按表结构动态截断并告警（修复 M3）；
    - description(TEXT) 按固定上限截断。
    """
    gallery_items = extract_gallery_items(data.get('gallery_json', []))
    detail_items = extract_detail_items(data.get('detail_media_json', []))

    def tv(col, val):
        return _truncate(col, val, limits, warn)

    values = (
        data.get('sku_id', ''),
        tv('title', clean_text(data.get('title', ''))),
        tv('sub_title', clean_text(data.get('sub_title', ''))),
        category_id,
        tv('brand', clean_text(data.get('brand', ''))),
        tv('cover_image', data.get('cover_image', '')),
        json.dumps(gallery_items, ensure_ascii=False),
        json.dumps(detail_items, ensure_ascii=False),
        _truncate_text(data.get('description', ''), warn),
        data.get('price', 0),
        data.get('original_price', 0),
        data.get('sales', 0),
        data.get('stock', 0),
        data.get('comment_count', 0),
        data.get('rating'),
        tv('shop_name', clean_text(data.get('shop_name', ''))),
        json.dumps(data.get('attributes_json', []), ensure_ascii=False),
        json.dumps(data.get('tags_json', []), ensure_ascii=False),
        json.dumps(data.get('skus', []), ensure_ascii=False),
        json.dumps(data.get('comments', []), ensure_ascii=False),
        data.get('source', 'jd'),
        tv('source_url', data.get('source_url', '')),
        data.get('status', 1),
        data.get('cover_image_local', ''),
        data.get('shop_logo_local', ''),
    )
    return values


def upsert_product(cursor, product_id, values):
    """执行 products 表幂等写入（INSERT ... ON DUPLICATE KEY UPDATE）。

    product_id 为 None 时走自增分支；否则显式指定 id（= product_links.id，双路径一致）。
    """
    cols = ", ".join(PRODUCT_COLUMNS)
    placeholders = ", ".join(["%s"] * len(PRODUCT_COLUMNS))
    if product_id:
        sql = f"INSERT INTO products (id, {cols}) VALUES (%s, {placeholders}) {PRODUCT_UPSERT}"
        cursor.execute(sql, (product_id,) + values)
    else:
        sql = f"INSERT INTO products ({cols}) VALUES ({placeholders}) {PRODUCT_UPSERT}"
        cursor.execute(sql, values)
