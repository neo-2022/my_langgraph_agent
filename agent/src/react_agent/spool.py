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
def _get_max_events() -> int:
    return int(os.environ.get("UI_PROXY_SPOOL_MAX_EVENTS", "1000"))


def _get_overflow_policy() -> str:
    return os.environ.get("UI_PROXY_SPOOL_OVERFLOW_POLICY", "never_drop_unacked")
LOGGER = logging.getLogger(__name__)


class SpoolOverflowError(Exception):
    """Raised when the spool cannot accept new events under the configured policy."""

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

AUDIT_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS spool_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL
);
"""

AUDIT_IMMUTABLE_TRIGGERS = [
    """
    CREATE TRIGGER IF NOT EXISTS trg_spool_audit_no_update
    BEFORE UPDATE ON spool_audit
    BEGIN
        SELECT RAISE(ABORT, 'spool_audit is append-only');
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_spool_audit_no_delete
    BEFORE DELETE ON spool_audit
    BEGIN
        SELECT RAISE(ABORT, 'spool_audit is append-only');
    END;
    """,
]

META_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS spool_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

def _now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


async def _count_pending(conn: aiosqlite.Connection) -> int:
    cursor = await conn.execute(
        "SELECT COUNT(*) FROM spool_events WHERE status IN ('pending','retryable')"
    )
    row = await cursor.fetchone()
    return int(row[0]) if row else 0


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
                await self._conn.execute(AUDIT_TABLE_SQL)
                for sql in AUDIT_IMMUTABLE_TRIGGERS:
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
        pending = await _count_pending(conn)
        incoming_events = list(events)
        incoming = len(incoming_events)
        max_events = _get_max_events()
        available = max_events - pending
        policy = _get_overflow_policy()
        if policy == "drop_oldest_when_full" and (available <= 0 or incoming > available):
            await self._handle_drop_oldest(conn, max(incoming - max(available, 0), 1), max_events)
        elif available <= 0:
            await self._handle_overflow(conn, pending, incoming, max_events, policy)
        elif incoming > available and policy == "never_drop_unacked":
            await self._handle_overflow(conn, pending, incoming, max_events, policy)
        for ev in incoming_events:
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

    async def _handle_overflow(
        self, conn: aiosqlite.Connection, pending: int, incoming: int, max_events: int, policy: str
    ) -> None:
        LOGGER.warning(
            f"observability_gap.spool_full: pending={pending} limit={max_events} incoming={incoming}"
        )
        LOGGER.warning(f"observability_gap.outbox_full: policy={policy}")
        raise SpoolOverflowError("spool is full")

    async def _handle_drop_oldest(self, conn: aiosqlite.Connection, drop_count: int, max_events: int) -> None:
        drop_count = max(1, drop_count)
        await conn.execute(
            "DELETE FROM spool_events WHERE id IN (SELECT id FROM spool_events WHERE status IN ('pending','retryable') ORDER BY created_at ASC LIMIT ?)",
            (drop_count,),
        )
        pending_after = await _count_pending(conn)
        LOGGER.warning(
            f"observability_gap.spool_full: dropped={drop_count} pending={pending_after} limit={max_events}"
        )
        LOGGER.warning(f"observability_gap.outbox_full: policy=drop_oldest_when_full dropped={drop_count}")
        LOGGER.warning(
            f"data_quality.lossy_outbox_drop: dropped={drop_count} pending={pending_after} limit={max_events}"
        )
        LOGGER.warning("lossy_mode_active incident triggered (policy drop_oldest_when_full)")
        LOGGER.warning(f"spool_dropped_total: {drop_count}")
        LOGGER.warning(f"outbox_dropped_total: {drop_count}")

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

    async def append_audit(self, action: str, payload: Dict[str, Any]) -> int:
        if self._corrupted:
            return -1
        conn = await self._connection()
        now = _now_ts()
        cursor = await conn.execute(
            "INSERT INTO spool_audit (created_at, action, payload) VALUES (?, ?, ?)",
            (now, action, json.dumps(payload, ensure_ascii=False)),
        )
        await conn.commit()
        return int(cursor.lastrowid or -1)

    async def verify_audit_immutability(self) -> bool:
        if self._corrupted:
            return False
        conn = await self._connection()
        entry_id = await self.append_audit("immutability_probe", {"probe": True})

        update_blocked = False
        delete_blocked = False
        try:
            await conn.execute("UPDATE spool_audit SET action='tamper' WHERE id=?", (entry_id,))
            await conn.commit()
        except sqlite3.DatabaseError as exc:
            update_blocked = True
            await conn.rollback()
            LOGGER.warning("observability_gap.audit_tampering: update blocked: %s", exc)

        try:
            await conn.execute("DELETE FROM spool_audit WHERE id=?", (entry_id,))
            await conn.commit()
        except sqlite3.DatabaseError as exc:
            delete_blocked = True
            await conn.rollback()
            LOGGER.warning("observability_gap.audit_tampering: delete blocked: %s", exc)

        return update_blocked and delete_blocked

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None
            self._ready = False

spool = Spool()
