import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

MOCK_PORT = 7346
PROXY_PORT = 8099


def wait_for_port(host: str, port: int, timeout: float = 10.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    raise RuntimeError(f"port {host}:{port} not ready after {timeout}s")


def stop_process(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def start_proxy(spool_path: str) -> subprocess.Popen:
    env = os.environ.copy()
    env.update(
        {
            "PYTHONPATH": str(Path.cwd() / "agent" / "src"),
            "UI_PROXY_PORT": str(PROXY_PORT),
            "ART_INGEST_URL": f"http://127.0.0.1:{MOCK_PORT}/api/v1/ingest",
            "ART_STREAM_URL": f"http://127.0.0.1:{MOCK_PORT}/api/v1/stream",
            "UI_PROXY_SPOOL_PATH": spool_path,
            "UI_PROXY_SPOOL_REPLAY_ENABLED": "1",
            "UI_PROXY_SPOOL_REPLAY_INTERVAL_SECONDS": "0.2",
            "UI_PROXY_SPOOL_REPLAY_BATCH_SIZE": "10",
            "ART_ALLOW_HTTP_LOCAL": "1",
            "ART_CONNECT_TIMEOUT": "0.2",
            "ART_READ_TIMEOUT": "0.5",
            "ART_WRITE_TIMEOUT": "0.5",
            "REACT_PORT": "5175",
        }
    )
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "react_agent.ui_proxy:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(PROXY_PORT),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def start_mock() -> subprocess.Popen:
    env = os.environ.copy()
    return subprocess.Popen(
        [sys.executable, "scripts/mock_art_stream.py", "--port", str(MOCK_PORT)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def spool_rows(spool_path: str) -> list[tuple[str, str, int, str | None]]:
    conn = sqlite3.connect(spool_path)
    try:
        cursor = conn.execute(
            "SELECT event_id, status, try_count, last_error FROM spool_events ORDER BY id ASC"
        )
        return [(row[0], row[1], int(row[2]), row[3]) for row in cursor.fetchall()]
    finally:
        conn.close()


def wait_for_spool_empty(spool_path: str, timeout: float = 10.0) -> None:
    end = time.time() + timeout
    last_rows: list[tuple[str, str, int, str | None]] = []
    while time.time() < end:
        last_rows = spool_rows(spool_path)
        if not last_rows:
            return
        time.sleep(0.2)
    raise RuntimeError(f"spool not drained after {timeout}s: {last_rows}")


def main() -> int:
    spool_path = tempfile.gettempdir() + f"/regart_spool_replay_cycle_{int(time.time())}.db"
    proxy_proc: subprocess.Popen | None = None
    mock_proc: subprocess.Popen | None = None

    try:
        proxy_proc = start_proxy(spool_path)
        wait_for_port("127.0.0.1", PROXY_PORT)

        event = {
            "event_id": "spool-replay-cycle-1",
            "schema_version": "REGART.Art.RawEvent.v1",
            "kind": "ui.test",
            "scope": "ui",
            "severity": "info",
            "message": "payload",
        }

        with httpx.Client(timeout=10.0) as client:
            response = client.post(
                f"http://127.0.0.1:{PROXY_PORT}/ui/art/ingest",
                json={"events": [event]},
                headers={"x-client-id": "cycle-client"},
            )
            if response.status_code not in {502, 504}:
                raise RuntimeError(f"expected 502/504 while Art is offline, got {response.status_code}: {response.text}")

        pending = spool_rows(spool_path)
        if len(pending) != 1 or pending[0][0] != event["event_id"]:
            raise RuntimeError(f"event not persisted to spool after offline ingest: {pending}")

        mock_proc = start_mock()
        wait_for_port("127.0.0.1", MOCK_PORT)
        wait_for_spool_empty(spool_path)

        print("status=PASS")
        print("offline_spool=PASS")
        print("replay_after_reconnect=PASS")
        return 0
    finally:
        stop_process(mock_proc)
        stop_process(proxy_proc)


if __name__ == "__main__":
    raise SystemExit(main())
