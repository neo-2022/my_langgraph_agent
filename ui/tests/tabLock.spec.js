import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TabLock } from "../src/obs/tabLock.js";

function createTestWindow() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  global.window = { localStorage, addEventListener, removeEventListener };
  return { store };
}

describe("TabLock", () => {
  let windowRef;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    windowRef = createTestWindow();
  });

  afterEach(() => {
    delete global.window;
  });

  test("acquires and releases lock", async () => {
    const lock = new TabLock({ key: "test-lock", ttl: 200, heartbeat: 50 });
    expect(await lock.acquire()).toBe(true);
    expect(await lock.acquire()).toBe(true);
    const another = new TabLock({ key: "test-lock", ttl: 200, heartbeat: 50 });
    expect(await another.acquire()).toBe(false);
    lock.release();
    expect(await another.acquire()).toBe(true);
    another.release();
    lock.dispose();
    another.dispose();
  });

  test("expires lock after ttl", async () => {
    vi.useFakeTimers();
    const lock = new TabLock({ key: "ttl-lock", ttl: 100, heartbeat: 50 });
    expect(await lock.acquire()).toBe(true);
    lock._stopHeartbeat();
    vi.advanceTimersByTime(150);
    const another = new TabLock({ key: "ttl-lock", ttl: 100, heartbeat: 20 });
    expect(await another.acquire()).toBe(true);
    lock.release();
    another.release();
    vi.useRealTimers();
    lock.dispose();
    another.dispose();
  });
});
