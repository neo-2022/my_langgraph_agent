import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

MOCK_PORT = 7345
PROXY_PORT = 8098


def _start_mock() -> subprocess.Popen:
    env = os.environ.copy()
    return subprocess.Popen(
        [sys.executable, "scripts/mock_art_stream.py", "--port", str(MOCK_PORT)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _start_proxy(spool_path: str) -> subprocess.Popen:
    env = os.environ.copy()
    env.update(
        {
            "UI_PROXY_PORT": str(PROXY_PORT),
            "ART_INGEST_URL": f"http://127.0.0.1:{MOCK_PORT}/api/v1/ingest",
            "ART_STREAM_URL": f"http://127.0.0.1:{MOCK_PORT}/api/v1/stream",
            "UI_PROXY_SPOOL_PATH": spool_path,
            "REACT_PORT": "5175",
        }
    )
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "react_agent.ui_proxy:app", "--host", "127.0.0.1", "--port", str(PROXY_PORT)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for_port(host: str, port: int, timeout: float = 5.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    raise RuntimeError(f"port {host}:{port} not ready after {timeout}s")


def _stop(proc: subprocess.Popen) -> None:
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


async def _run_cycle() -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        event = {
            "event_id": "full-cycle-1",
            "kind": "full-cycle",
            "scope": "ui",
            "severity": "info",
            "payload": {"nonce": "full"},
        }
        ingest_resp = await client.post(
            f"http://127.0.0.1:{PROXY_PORT}/ui/art/ingest",
            json={"events": [event]},
        )
        ingest_resp.raise_for_status()
        print("ingest result", ingest_resp.json())

        subscribe = client.stream("GET", f"http://127.0.0.1:{PROXY_PORT}/ui/art/stream")
        async with subscribe as stream:
            async for line in stream.aiter_lines():
                if line.startswith("data:"):
                    payload = json.loads(line[len("data:") :].strip())
                    print("stream event", payload)
                    break


if __name__ == "__main__":
    spool_file = tempfile.gettempdir() + "/regart_full_cycle_spool.db"
    os.environ.pop("UI_PROXY_SPOOL_PATH", None)
    mock_proc = _start_mock()
    time.sleep(0.5)
    proxy_proc = _start_proxy(spool_file)
    wait_for_port("127.0.0.1", PROXY_PORT)
    try:
        asyncio.run(_run_cycle())
    finally:
        _stop(proxy_proc)
        _stop(mock_proc)
