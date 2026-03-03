import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createTestOutbox } from "../src/obs/outbox.js";
import { createOutboxDb } from "../src/obs/outbox.db.js";

function makeWindowMocks() {
  if (typeof globalThis.window === "undefined") {
    globalThis.window = {};
  }
  if (!globalThis.window.sessionStorage) {
    globalThis.window.sessionStorage = {
      _store: {},
      getItem(key) {
        return this._store[key] || null;
      },
      setItem(key, value) {
        this._store[key] = String(value);
      },
      removeItem(key) {
        delete this._store[key];
      },
    };
  }
  globalThis.window.__DBG0__ = { pushEvent: vi.fn() };
}

describe("Outbox", () => {
  let outbox;
  let db;
  let sendBatch;

  beforeEach(() => {
    makeWindowMocks();
    sendBatch = vi.fn(async ({ events }) => ({
      results: events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
    }));
    db = createOutboxDb(`test_outbox_${Math.random().toString(16).slice(2)}`);
    outbox = createTestOutbox({ db, sendBatch });
  });

  afterEach(async () => {
    await db.delete();
    if (globalThis.window?.__DBG0__?.pushEvent) {
      globalThis.window.__DBG0__.pushEvent.mockReset();
    }
  });

  it("flush removes accepted events", async () => {
    await outbox.enqueue({ kind: "ui.test", message: "ok" });
    await outbox.flush();
    const stats = await outbox.stats();
    expect(stats.pending).toBe(0);
  });

  it("marks retryable when ack requests retry", async () => {
    sendBatch.mockImplementation(async ({ events }) => ({
      results: events.map((event) => ({ event_id: event.event_id, status: "retryable" })),
    }));
    await outbox.enqueue({ kind: "ui.retry", message: "later" });
    await outbox.flush();
    const rows = await outbox.db.events.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("retryable");
    expect(rows[0].try_count).toBe(1);
  });

  it("moves to DLQ after rejection and emits gap events", async () => {
    sendBatch.mockImplementation(async ({ events }) => ({
      results: events.map((event) => ({
        event_id: event.event_id,
        status: "rejected",
        reason: "malformed",
      })),
    }));
    await outbox.enqueue({ kind: "ui.bad", message: "fail" });
    await outbox.flush();
    expect(await outbox.db.events.count()).toBe(0);
    expect(await outbox.db.dlq.count()).toBe(1);
    expect(globalThis.window.__DBG0__.pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "observability_gap.dlq_enqueued" }),
    );
  });

  it("pushes to DLQ after repeated retries beyond maxRetries", async () => {
    sendBatch.mockImplementation(async ({ events }) => ({
      results: events.map((event) => ({ event_id: event.event_id, status: "retryable" })),
    }));
    const limitedOutbox = createTestOutbox({
      db: createOutboxDb(`test_outbox_${Math.random().toString(16).slice(2)}`),
      sendBatch,
      maxRetries: 2,
    });
    await limitedOutbox.enqueue({ kind: "ui.repeat", message: "loop" });
    await limitedOutbox.flush();
    await limitedOutbox.flush();
    await limitedOutbox.flush();
    expect(await limitedOutbox.db.dlq.count()).toBe(1);
    expect(globalThis.window.__DBG0__.pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "observability_gap.dlq_enqueued" }),
    );
  });
});
