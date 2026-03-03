import asyncio
import json
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7331)
