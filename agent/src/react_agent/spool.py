from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import aiosqlite

DEFAULT_SPOOL_PATH = Path(os.environ.get("UI_PROXY_SPOOL_PATH", "~/.local/share/regart/ui_proxy_spool.db")).expanduser()
SCHEMA_VERSION = 1
RETENTION_SECONDS = int(os.environ.get("UI_PROXY_SPOOL_RETENTION", str(60 * 60 * 24)))
LOGGER = logging.getLogger(__name__)

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS spool_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    raw_event TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    try_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT DEFAULT NULL
);
"""

INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_spool_events_event ON spool_events (event_id);",
    "CREATE INDEX IF NOT EXISTS idx_spool_events_status ON spool_events (status);",
    "CREATE INDEX IF NOT EXISTS idx_spool_events_created ON spool_events (created_at);",
    "CREATE UNIQUE INDEX IF NOT EXISTS uniq_spool_events_event ON spool_events (event_id);",
]

DLQ_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS spool_dlq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    raw_event TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);
"""

DLQ_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_spool_dlq_event ON spool_dlq (event_id);",
]

META_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS spool_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

def _now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


class Spool:
    def __init__(self, path: Path = DEFAULT_SPOOL_PATH):
        self.path = path
        self._conn: Optional[aiosqlite.Connection] = None
        self._lock = asyncio.Lock()
        self._ready = False
        self._corrupted = False
        self._fallback: List[Dict[str, Any]] = []

    async def ensure_schema(self) -> None:
        if self._ready:
            return
        async with self._lock:
            if self._ready:
                return
            dir_path = self.path.parent
            dir_path.mkdir(parents=True, exist_ok=True)
            try:
                self._conn = await aiosqlite.connect(str(self.path))
                await self._conn.execute("PRAGMA journal_mode=WAL;")
                await self._conn.execute("PRAGMA synchronous=NORMAL;")
                await self._conn.execute("PRAGMA foreign_keys=ON;")
                await self._conn.execute(CREATE_TABLE_SQL)
                for sql in INDICES:
                    await self._conn.execute(sql)
                await self._conn.execute(DLQ_TABLE_SQL)
                for sql in DLQ_INDICES:
                    await self._conn.execute(sql)
                await self._conn.execute(META_TABLE_SQL)
                await self._set_schema_version()
                await self._conn.commit()
                self._ready = True
            except sqlite3.DatabaseError as exc:
                self._corrupted = True
                LOGGER.exception("Spool DB corrupted, falling back to in-memory queue: %s", exc)

    async def _set_schema_version(self) -> None:
        conn = await self._connection()
        cursor = await conn.execute("SELECT value FROM spool_meta WHERE key='schema_version'")
        row = await cursor.fetchone()
        if row is None:
            await conn.execute(
                "INSERT OR REPLACE INTO spool_meta (key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
        elif int(row[0]) < SCHEMA_VERSION:
            await self._migrate_schema(int(row[0]))
            await conn.execute(
                "UPDATE spool_meta SET value=? WHERE key='schema_version'",
                (str(SCHEMA_VERSION),),
            )

    async def _migrate_schema(self, from_version: int) -> None:
        LOGGER.info("Migrating spool schema from %s to %s", from_version, SCHEMA_VERSION)

    async def _connection(self) -> aiosqlite.Connection:
        if self._corrupted:
            raise sqlite3.DatabaseError("spool is corrupted")
        if not self._conn:
            await self.ensure_schema()
        if not self._conn:
            raise sqlite3.DatabaseError("spool not available")
        return self._conn  # type: ignore

    async def add_events(self, events: Iterable[Dict[str, Any]], client_id: str) -> None:
        if self._corrupted:
            self._fallback.extend(
                [
                    {"event": ev, "client_id": client_id, "received_at": _now_ts()}
                    for ev in events
                ]
            )
            return
        conn = await self._connection()
        now = _now_ts()
        await conn.execute("BEGIN IMMEDIATE")
        for ev in events:
            await conn.execute(
                "INSERT OR IGNORE INTO spool_events (event_id, client_id, raw_event, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (
                    ev.get("event_id"),
                    client_id,
                    json.dumps(ev, ensure_ascii=False),
                    now,
                    now,
                ),
            )
        await conn.commit()
        await self.cleanup_retention()

    async def fetch_pending(self, limit: int = 100) -> List[Tuple[int, Dict[str, Any]]]:
        conn = await self._connection()
        cursor = await conn.execute(
            "SELECT id, raw_event FROM spool_events WHERE status IN ('pending', 'retryable') ORDER BY created_at ASC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        out = []
        for row in rows:
            raw_event = json.loads(row[1]) if row[1] else {}
            out.append((row[0], raw_event))
        return out

    async def mark_in_flight(self, ids: Iterable[int]) -> None:
        conn = await self._connection()
        now = _now_ts()
        await conn.execute("BEGIN IMMEDIATE")
        for event_id in ids:
            await conn.execute(
                "UPDATE spool_events SET status='in_flight', updated_at=?, try_count=try_count+1 WHERE id=?",
                (now, event_id),
            )
        await conn.commit()

    async def remove(self, ids: Iterable[int]) -> None:
        conn = await self._connection()
        await conn.execute("BEGIN IMMEDIATE")
        for event_id in ids:
            await conn.execute("DELETE FROM spool_events WHERE id=?", (event_id,))
        await conn.commit()

    async def mark_retryable(self, ids: Iterable[int], error: Optional[str] = None) -> None:
        conn = await self._connection()
        now = _now_ts()
        await conn.execute("BEGIN IMMEDIATE")
        for event_id in ids:
            await conn.execute(
                "UPDATE spool_events SET status='retryable', updated_at=?, last_error=? WHERE id=?",
                (now, error, event_id),
            )
        await conn.commit()

    async def cleanup_retention(self, retention_seconds: int = RETENTION_SECONDS) -> None:
        if self._corrupted:
            return
        threshold = _now_ts() - retention_seconds
        conn = await self._connection()
        await conn.execute("DELETE FROM spool_events WHERE created_at < ?", (threshold,))
        await conn.execute("DELETE FROM spool_dlq WHERE created_at < ?", (threshold,))
        await conn.commit()

    async def move_to_dlq(self, event_id: str, client_id: str, raw_event: Dict[str, Any], reason: str, attempts: int = 0) -> None:
        if self._corrupted:
            return
        conn = await self._connection()
        now = _now_ts()
        await conn.execute(
            "INSERT INTO spool_dlq (event_id, client_id, raw_event, reason, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, client_id, json.dumps(raw_event, ensure_ascii=False), reason, now, attempts),
        )
        await conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None
            self._ready = False

spool = Spool()
