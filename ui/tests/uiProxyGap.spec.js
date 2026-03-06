import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/obs/outbox.js", () => ({
  pushObservabilityGap: vi.fn(),
}));

import { pushObservabilityGap } from "../src/obs/outbox.js";
import { notifyUiProxyUnavailable } from "../src/obs/uiProxyGap.js";

describe("notifyUiProxyUnavailable", () => {
  beforeEach(() => {
    pushObservabilityGap.mockClear();
  });

  test("pushes observability_gap with required fields", () => {
    notifyUiProxyUnavailable({
      status: { health: { ok: false, reason: "down" } },
      error: "fetch failed",
      retryCount: 3,
      backoffMs: 2000,
      trace_id: "trace-123",
    });

    expect(pushObservabilityGap).toHaveBeenCalledWith(
      "observability_gap.ui_proxy_unavailable",
      expect.objectContaining({
        endpoint: "/ui/ui-proxy/status",
        status: JSON.stringify({ health: { ok: false, reason: "down" } }),
        error: "fetch failed",
        retry_count: 3,
        backoff_ms: 2000,
        trace_id: "trace-123",
      }),
    );
  });
});
