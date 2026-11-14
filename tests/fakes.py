# -*- coding: utf-8 -*-
"""
白盒测试用的轻量假对象（不依赖 DrissionPage / 真实 MySQL）。

提供：
- RecordingCursor / RecordingConnection：记录所有 execute/executemany 调用，
  可预设 fetchone 返回值、可针对特定 SQL 抛异常。
- FakeCategoriesStore：在内存中模拟 categories 表，用于验证 load_categories 的
  parent_id / is_leaf / path 计算逻辑（真正的白盒）。
"""
import re


class RecordingCursor:
    """记录型游标，模拟 pymysql 游标的最小接口。"""

    def __init__(self):
        self.calls = []              # [("execute"|"executemany", sql, params), ...]
        self.fetchone_queue = []     # fetchone() 依次弹出的返回值
        self.rowcount = 0
        self.lastrowid = 0           # 供 start_session 等取 lastrowid
        self._pending_fetch = None   # 最近一次 SELECT 的待返回结果
        self.raise_if_contains = None  # 若 SQL 含该子串则 execute/executemany 抛异常
        self._raise_cls = Exception

    def push_fetchone(self, value):
        self.fetchone_queue.append(value)

    def _maybe_raise(self, sql):
        if self.raise_if_contains and self.raise_if_contains in sql.upper():
            raise self._raise_cls(f"模拟数据库错误: {sql[:60]}")

    def execute(self, sql, params=None):
        self.calls.append(("execute", sql, params))
        self._maybe_raise(sql)
        su = sql.strip().upper()
        if su.startswith("SELECT LAST_INSERT_ID"):
            self._pending_fetch = getattr(self, "_last_insert_id", 0)
        # 其余 SELECT 的结果由调用方在 execute 后通过 fetchone 获取（已在别处设置）
        return None

    def executemany(self, sql, seq):
        self.calls.append(("executemany", sql, seq))
        self._maybe_raise(sql)
        self.rowcount = len(seq) if seq else 0
        return None

    def fetchone(self):
        if self.fetchone_queue:
            return self.fetchone_queue.pop(0)
        return self._pending_fetch

    def fetchall(self):
        return []

    def close(self):
        pass


class RecordingConnection:
    """记录型连接，模拟 pymysql 连接的最小接口。"""

    def __init__(self):
        self.committed = 0
        self.rolledback = 0
        self.closed = False

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1

    def close(self):
        self.closed = True


class FakeDb:
    """供 wrapper._save_to_db 使用：同时具备 .cursor 与 .connection。"""

    def __init__(self):
        self.cursor = RecordingCursor()
        self.connection = RecordingConnection()

    def _ensure_connection(self):
        """测试桩：连接保持可用。"""
        return True

    def ensure_products_unique_skuid(self):
        """测试桩：唯一索引确保（空操作）。"""
        return True


class FakeCategoriesStore:
    """
    内存版 categories 表，用于白盒验证 load_categories.insert_tree 的
    parent_id / is_leaf / path / 自增 id / 增量去重 逻辑。
    """

    def __init__(self):
        self.rows = {}          # id -> {name, parent_id, path, level, source_url, crawl_status, is_leaf, sort_order}
        self.next_id = 1
        self.calls = []         # [(sql, params), ...]
        self.committed = 0
        self.rolledback = 0
        self.table_created = False
        self._pending_fetch = None
        self._last_insert_id = 0

    # ---- 游标/连接共用接口 ----
    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        s = sql.strip()
        su = s.upper()
        if su.startswith("CREATE TABLE"):
            self.table_created = True
            return
        if su.startswith("TRUNCATE"):
            self.rows = {}
            self.next_id = 1
            self._pending_fetch = None
            return
        if su.startswith("SELECT ID, PATH FROM CATEGORIES WHERE NAME"):
            name, parent_id = params
            found = None
            for rid, r in self.rows.items():
                if r["name"] == name and r["parent_id"] == parent_id:
                    found = {"id": rid, "path": r["path"]}
                    break
            self._pending_fetch = found  # dict 或 None（DictCursor 风格）
            return
        if su.startswith("SELECT LAST_INSERT_ID"):
            self._pending_fetch = self._last_insert_id
            return
        if su.startswith("INSERT INTO CATEGORIES"):
            cols = self._parse_insert_cols(s)
            row = {c: v for c, v in zip(cols, params)}
            rid = self.next_id
            row["id"] = rid
            self.rows[rid] = row
            self._last_insert_id = rid
            self.lastrowid = rid
            self.next_id += 1
            self._pending_fetch = rid
            return
        if su.startswith("UPDATE CATEGORIES SET PATH"):
            # params: (path, id)
            path, rid = params
            if rid in self.rows:
                self.rows[rid]["path"] = path
            return
        if su.startswith("SELECT ID FROM CATEGORIES ORDER BY ID DESC LIMIT 1"):
            self._pending_fetch = max(self.rows.keys()) if self.rows else None
            return
        # 其它 SELECT（如 SHOW TABLES）默认返回空
        self._pending_fetch = None

    def executemany(self, sql, seq):
        self.calls.append((sql, seq))

    def fetchone(self):
        return self._pending_fetch

    def fetchall(self):
        return []

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1

    def close(self):
        pass

    @staticmethod
    def _parse_insert_cols(sql):
        m = re.search(r"INSERT INTO categories \((.*?)\)", sql, re.I | re.S)
        if not m:
            return []
        return [c.strip() for c in m.group(1).split(",")]
