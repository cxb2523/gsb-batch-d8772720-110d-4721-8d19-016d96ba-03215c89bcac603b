# -*- coding: utf-8 -*-
"""
运行会话记录（健壮性 L3）：为每次批量爬取 / 导入建立一条会话，记录开始/结束与成功失败数，
便于中断后审计"哪次运行采集了多少、成功多少、失败多少"。

与具体 DB 连接对象解耦：调用方传入 cursor 与 connection 即可（wrapper 与 importer 共用）。
"""
import pymysql


def ensure_session_table(cursor, conn):
    """创建 crawl_session 表（若未存在）。"""
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS crawl_session (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                run_type VARCHAR(32) NOT NULL COMMENT '运行类型：detail_crawl / json_import',
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finished_at DATETIME NULL,
                total INT DEFAULT 0,
                success INT DEFAULT 0,
                failed INT DEFAULT 0,
                note TEXT,
                INDEX idx_run_type (run_type),
                INDEX idx_started (started_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采集运行会话记录'
        """)
        conn.commit()
    except pymysql.MySQLError as e:
        print(f"[会话] 确保 crawl_session 表失败: {e}")


def start_session(cursor, conn, run_type, note=''):
    """开始一条会话，返回 session_id；失败返回 None。"""
    try:
        cursor.execute(
            "INSERT INTO crawl_session (run_type, note) VALUES (%s, %s)",
            (run_type, note),
        )
        conn.commit()
        return cursor.lastrowid
    except pymysql.MySQLError as e:
        print(f"[会话] 开始会话失败: {e}")
        return None


def finish_session(cursor, conn, session_id, total=0, success=0, failed=0, note=''):
    """结束会话：更新成功/失败计数与结束时间。"""
    if session_id is None:
        return
    try:
        cursor.execute(
            "UPDATE crawl_session SET finished_at=NOW(), total=%s, success=%s, failed=%s, note=%s "
            "WHERE id=%s",
            (total, success, failed, note, session_id),
        )
        conn.commit()
    except pymysql.MySQLError as e:
        print(f"[会话] 结束会话失败: {e}")
