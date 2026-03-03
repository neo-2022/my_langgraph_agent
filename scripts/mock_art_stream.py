import asyncio
import json
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

MAX_EVENTS = 5

@app.get("/api/v1/stream")
async def stream(cursor: Optional[str] = None, request: Request = None):
    try:
        start = int(cursor) if cursor and cursor.isdigit() else 1
    except Exception:
        start = 1
    async def content():
        seq = start
        while seq < start + MAX_EVENTS:
            if request and await request.is_disconnected():
                break
            payload = {
                "event_id": f"mock-{seq}",
                "sequence_id": seq,
                "cursor": str(seq),
                "message": f"mock event {seq}",
            }
            line = f"data: {json.dumps(payload)}\n\n"
            yield line.encode("utf-8")
            seq += 1
            await asyncio.sleep(0.3)
        # keep connection alive
        while True:
            if request and await request.is_disconnected():
                break
            await asyncio.sleep(1)
    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    }
    return StreamingResponse(content(), headers=headers)


@app.post("/api/v1/ingest")
async def ingest(payload: dict, request: Request):
    events = payload.get("events")
    if not events or not isinstance(events, list):
        raise HTTPException(status_code=400, detail="missing events")
    event = events[0]
    simulate = (event.get("payload") or {}).get("simulate")
    if simulate == "error_502":
        return JSONResponse(
            status_code=502,
            content={
                "ok": False,
                "error": "mock upstream",
                "results": [
                    {
                        "event_id": event.get("event_id"),
                        "status": "retryable",
                        "reason": "mock error",
                    }
                ],
            },
        )
    if simulate == "delay":
        await asyncio.sleep(2)
    if simulate == "partial":
        return {
            "ok": True,
            "results": [
                {"event_id": event.get("event_id"), "status": "ok"},
                {"event_id": f"{event.get('event_id')}-dlq", "status": "retryable"},
            ],
        }
    return {"ok": True, "results": [{"event_id": event.get("event_id"), "status": "ok"}]}

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7331)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
