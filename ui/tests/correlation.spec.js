import { describe, it, expect } from "vitest";
import {
  buildCorrelationHeaders,
  createCorrelationContext,
  getTraceId,
  resetTraceId,
} from "../src/obs/correlation.js";

describe("correlation helpers", () => {
  it("produces consistent headers with trace/span/request ids", () => {
    resetTraceId();
    const ctx = createCorrelationContext();
    const headers = buildCorrelationHeaders(ctx);
    expect(headers["X-Trace-Id"]).toBe(ctx.trace_id);
    expect(headers["X-Span-Id"]).toBe(ctx.span_id);
    expect(headers["X-Request-Id"]).toBe(ctx.request_id);
    expect(getTraceId()).toBe(ctx.trace_id);
  });
});
