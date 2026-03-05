import { describe, expect, it } from "vitest";
import { buildGraphEmptyEvent } from "../src/GraphView.jsx";

describe("buildGraphEmptyEvent", () => {
  it("builds ctx with required fields", () => {
    const rect = { width: 123.4, height: 56.7 };
    const event = buildGraphEmptyEvent({
      assistantId: "assistant-1",
      direction: "LR",
      containerRect: rect,
      nodesCount: 0,
      edgesCount: 0,
      inFlight: false,
      lastFetchMs: 101,
    });

    expect(event.name).toBe("ui.graph.empty");
    expect(event.ctx).toMatchObject({
      assistant_id: "assistant-1",
      container_w: 123,
      container_h: 57,
      nodes_count: 0,
      edges_count: 0,
      in_flight: false,
      last_fetch_ms: 101,
    });
    expect(typeof event.ctx.trace_id).toBe("string");
  });
});
