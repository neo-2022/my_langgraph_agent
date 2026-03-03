import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/obs/outbox.js", () => ({
  pushObservabilityGap: vi.fn(),
}));

import { pushObservabilityGap } from "../src/obs/outbox.js";
import { ArtStreamClient } from "../src/obs/artStream.js";

function mockWindowWithStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  global.window = {
    localStorage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { store, localStorage };
}

describe("ArtStreamClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete global.window;
  });

  test("updates cursor on incoming event", () => {
    const { store } = mockWindowWithStorage();
    const client = new ArtStreamClient("http://example.com");
    client.cursor = "";
    client.lastSequence = undefined;
    client._handleMessage({ data: JSON.stringify({ cursor: "cursor-1" }) });
    expect(store.get("regart_art_stream_cursor")).toBe("cursor-1");
    expect(client.cursor).toBe("cursor-1");
  });

  test("detects ordering gap when sequence decreases", () => {
    mockWindowWithStorage();
    const client = new ArtStreamClient("http://example.com");
    client.lastSequence = 10;
    client._handleMessage({ data: JSON.stringify({ sequence_id: 7 }) });
    expect(pushObservabilityGap).toHaveBeenCalledWith(
      "observability_gap.stream_order_gap",
      expect.objectContaining({ sequence_id: 7 })
    );
  });

  test("build URL contains stored cursor", () => {
    const { store } = mockWindowWithStorage({ regart_art_stream_cursor: "stored-cursor" });
    const client = new ArtStreamClient("http://example.com/base");
    const url = client._buildUrl();
    expect(url).toContain("cursor=stored-cursor");
  });
});
