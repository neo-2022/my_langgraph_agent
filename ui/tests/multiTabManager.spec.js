import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { computeDedupKey, resetForTests, shouldSendDedup } from "../src/multiTabManager.js";

describe("multiTabManager dedup", () => {
  beforeEach(() => {
    resetForTests();
  });

  afterEach(() => {
    resetForTests();
  });

  test("canonicalizes events ignoring timestamps and key order", () => {
    const base = {
      kind: "ui.event",
      name: "trace",
      context: { span_id: "span-1", trace_id: "trace-1" },
      payload: { b: 2, a: 1, ts_ms: 10 },
      ts: "2026-03-05T00:00:00.000Z",
      timestamp: "t",
    };
    const variant = {
      name: "trace",
      kind: "ui.event",
      payload: { a: 1, b: 2, ts_ms: 9999 },
      context: { trace_id: "trace-1", span_id: "span-1" },
      timestamp: "t2",
    };
    const key1 = computeDedupKey(base);
    const key2 = computeDedupKey(variant);
    expect(key1).toBeTruthy();
    expect(key2).toBeTruthy();
    expect(key2).toBe(key1);
  });

  test("shouldSendDedup respects ttl", () => {
    vi.useFakeTimers();
    try {
      const key = computeDedupKey({ kind: "ui.event", payload: { value: 1 } });
      expect(shouldSendDedup(key)).toBe(true);
      expect(shouldSendDedup(key)).toBe(false);
      vi.advanceTimersByTime(300_001);
      expect(shouldSendDedup(key)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
