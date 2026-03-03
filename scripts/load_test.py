import asyncio
import json
import os
import random
import string

import httpx


def random_event(event_id: str, simulate: str | None = None) -> dict:
    return {
        "event_id": event_id,
        "schema_version": "REGART.Art.RawEvent.v1",
        "kind": "load.test",
        "scope": "ui",
        "severity": "info",
        "message": "load test event",
        "payload": {"nonce": random.random(), **({"simulate": simulate} if simulate else {})},
    }


async def main(
    base_url: str,
    total: int = 100,
    concurrency: int = 8,
    delay: float = 0,
    simulate: str | None = None,
):
    auth_token = os.environ.get("REGART_INGEST_TOKEN", "")
    headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
    async with httpx.AsyncClient(base_url=base_url) as client:
        semaphore = asyncio.Semaphore(concurrency)

        async def send(idx: int):
            event = random_event(
                f"load-{idx}-{random.randint(1, 1_000_000)}",
                simulate=simulate,
            )
            payload = {"events": [event]}
            await semaphore.acquire()
            try:
                response = await client.post("/ui/art/ingest", headers=headers, json=payload)
                if response.status_code not in (200, 504):
                    print("unexpected status", response.status_code, response.text)
            finally:
                semaphore.release()

        await asyncio.gather(*(send(i) for i in range(total)))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Регрессия: генерация нагрузочных событий")
    parser.add_argument("--base-url", default="http://127.0.0.1:8090", help="UI Proxy base URL")
    parser.add_argument("--events", type=int, default=100, help="Всего событий")
    parser.add_argument("--concurrency", type=int, default=8, help="Параллельные запросы")
    parser.add_argument("--delay", type=float, default=0, help="Задержка между слепками (сек)")
    parser.add_argument(
        "--simulate",
        default="",
        help="simulate mode for event payload (error_502, delay, partial)",
    )
    args = parser.parse_args()
    asyncio.run(
        main(
            args.base_url,
            total=args.events,
            concurrency=args.concurrency,
            delay=args.delay,
            simulate=args.simulate or None,
        )
    )
