import { describe, expect, it } from "vitest";
import { buildGraphEmptyEvent, buildGraphEmptyEventIfNeeded } from "../src/GraphView.jsx";

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

describe("buildGraphEmptyEventIfNeeded", () => {
  it("returns ui.graph.empty when all required conditions are met", () => {
    const event = buildGraphEmptyEventIfNeeded({
      assistantId: "assistant-1",
      direction: "LR",
      containerRect: { width: 320, height: 240 },
      nodesCount: 0,
      edgesCount: 0,
      inFlight: false,
      lastFetchMs: 50,
    });

    expect(event).not.toBeNull();
    expect(event.name).toBe("ui.graph.empty");
    expect(event.ctx.nodes_count).toBe(0);
    expect(event.ctx.edges_count).toBe(0);
  });

  it("returns null when conditions are not met", () => {
    expect(
      buildGraphEmptyEventIfNeeded({
        assistantId: "assistant-1",
        direction: "LR",
        containerRect: { width: 0, height: 240 },
        nodesCount: 0,
        edgesCount: 0,
        inFlight: false,
        lastFetchMs: 10,
      })
    ).toBeNull();

    expect(
      buildGraphEmptyEventIfNeeded({
        assistantId: "assistant-1",
        direction: "LR",
        containerRect: { width: 320, height: 240 },
        nodesCount: 1,
        edgesCount: 0,
        inFlight: false,
        lastFetchMs: 10,
      })
    ).toBeNull();

    expect(
      buildGraphEmptyEventIfNeeded({
        assistantId: "assistant-1",
        direction: "LR",
        containerRect: { width: 320, height: 240 },
        nodesCount: 0,
        edgesCount: 0,
        inFlight: true,
        lastFetchMs: 10,
      })
    ).toBeNull();
  });
});
