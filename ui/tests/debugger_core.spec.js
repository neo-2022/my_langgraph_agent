import { beforeEach, describe, expect, it } from "vitest";
import { getUiErrorCore, UiErrorCore } from "../src/debugger/core.js";

function makeMockLevel0() {
  const errorListeners = new Set();
  const eventListeners = new Set();

  return {
    subscribeErrors(fn) {
      if (typeof fn === "function") errorListeners.add(fn);
      return () => errorListeners.delete(fn);
    },
    subscribeEvents(fn) {
      if (typeof fn === "function") eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    pushError(_input, overrides = {}) {
      const err = {
        id: "err-1",
        ts: new Date().toISOString(),
        scope: overrides.scope || "ui",
        severity: overrides.severity || "error",
        title: overrides.title || "",
        message: overrides.message || "error",
        details: overrides.details || {},
      };
      for (const fn of errorListeners) fn(err);
      return err;
    },
    emitEvent(ev) {
      for (const fn of eventListeners) fn(ev);
    },
    snapshot() {
      return {
        stats: {
          size: { errors: 0 },
          dropped: { errors: 0 },
          cap: { errors: 200 },
        },
      };
    },
  };
}

describe("UiErrorCore subscribe(listener)", () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {};
    globalThis.window.__DBG0__ = makeMockLevel0();
  });

  it("delivers UiError and DebugEvent in order without drops", () => {
    const core = getUiErrorCore({ capacity: 200 });
    const got = [];
    const unsub = core.subscribe((record) => {
      got.push(record);
    });

    core.push(new Error("boom"), { scope: "ui", severity: "error", message: "boom" });
    globalThis.window.__DBG0__.emitEvent({ event_id: "ev-1", name: "ui.test", level: "info" });

    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(expect.objectContaining({ id: "err-1", severity: "error", message: "boom" }));
    expect(got[1]).toEqual(expect.objectContaining({ event_id: "ev-1", name: "ui.test", level: "info" }));

    unsub();
  });

  it("subscribe(listener) receives events in emission order and supports unsubscribe", () => {
    const core = new UiErrorCore({ capacity: 200 });
    const received = [];
    const unsub = core.subscribe((record) => {
      received.push(record);
    });

    const pushError = () => core.push(new Error("boom"), { scope: "ui", severity: "error", message: "boom" });
    pushError();
    globalThis.window.__DBG0__.emitEvent({ event_id: "ev-1", name: "ui.event", level: "info" });
    globalThis.window.__DBG0__.emitEvent({ event_id: "ev-2", name: "ui.event", level: "info" });

    expect(received.map((rec) => rec.event_id || rec.id)).toEqual(["err-1", "ev-1", "ev-2"]);

    unsub();

    globalThis.window.__DBG0__.emitEvent({ event_id: "ev-3", name: "ui.event", level: "info" });
    expect(received).toHaveLength(3);
  });
});
