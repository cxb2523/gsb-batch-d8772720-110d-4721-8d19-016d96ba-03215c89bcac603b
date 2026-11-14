"""Durable account-scoped favorite history and chapter completion."""
import json
import sqlite3
import time
from pathlib import Path
from utils import config


class JmDatabase:
    def __init__(self, account):
        self.account = account
        path = Path(config.DATA_PATH) / 'jm.sqlite'
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript('''
            CREATE TABLE IF NOT EXISTS jm_books (
                account TEXT, album_id TEXT, title TEXT NOT NULL,
                is_favorite INTEGER NOT NULL DEFAULT 1,
                completed INTEGER NOT NULL DEFAULT 0,
                metadata TEXT, first_seen REAL, last_seen REAL,
                PRIMARY KEY(account, album_id));
            CREATE TABLE IF NOT EXISTS jm_chapters (
                account TEXT, album_id TEXT, photo_id TEXT,
                cbz_path TEXT NOT NULL, packed_at REAL,
                PRIMARY KEY(account, album_id, photo_id));
        ''')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.conn.close()

    def sync_favorites(self, favorites):
        now = time.time()
        with self.conn:
            self.conn.execute('UPDATE jm_books SET is_favorite=0 WHERE account=?', (self.account,))
            for album_id, title in favorites.items():
                self.conn.execute('''INSERT INTO jm_books
                    (account,album_id,title,is_favorite,first_seen,last_seen)
                    VALUES (?,?,?,1,?,?) ON CONFLICT(account,album_id) DO UPDATE SET
                    title=excluded.title,is_favorite=1,last_seen=excluded.last_seen''',
                    (self.account, str(album_id), title, now, now))

    def pending_books(self):
        return [dict(row) for row in self.conn.execute('''SELECT * FROM jm_books
            WHERE account=? AND completed=0 ORDER BY first_seen,album_id''', (self.account,))]

    def save_metadata(self, album_id, metadata):
        with self.conn:
            self.conn.execute('UPDATE jm_books SET metadata=? WHERE account=? AND album_id=?',
                              (json.dumps(metadata, ensure_ascii=False), self.account, album_id))

    def is_packed(self, album_id, photo_id):
        row = self.conn.execute('''SELECT cbz_path FROM jm_chapters
            WHERE account=? AND album_id=? AND photo_id=?''',
            (self.account, album_id, photo_id)).fetchone()
        return bool(row and Path(row['cbz_path']).is_file() and Path(row['cbz_path']).stat().st_size)

    def mark_packed(self, album_id, photo_id, cbz_path):
        with self.conn:
            self.conn.execute('INSERT OR REPLACE INTO jm_chapters VALUES (?,?,?,?,?)',
                              (self.account, album_id, photo_id, str(Path(cbz_path).resolve()), time.time()))

    def mark_completed(self, album_id):
        with self.conn:
            self.conn.execute('UPDATE jm_books SET completed=1 WHERE account=? AND album_id=?',
                              (self.account, album_id))
