import { describe, expect, it, vi } from "vitest";

vi.mock("../src/obs/outbox.js", () => ({
  outbox: {
    enqueue: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("../src/obs/httpClient.js", () => ({
  httpClient: {
    request: vi.fn(),
  },
}));

import { initDebuggerLevel0 } from "../src/debugger/level0.js";
import { outbox } from "../src/obs/outbox.js";

function makeElement(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    textContent: "",
    innerHTML: "",
    className: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((it) => it !== child);
    },
    contains(target) {
      if (this === target) return true;
      return this.children.some((it) => (typeof it?.contains === "function" ? it.contains(target) : it === target));
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    focus() {},
    blur() {},
    select() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 20 };
    },
  };
}

function installDomStubs() {
  const head = makeElement("head");
  head.querySelector = () => null;
  const body = makeElement("body");

  globalThis.document = {
    head,
    body,
    createElement: (tag) => makeElement(tag),
    execCommand: () => true,
  };

  const listeners = new Map();
  globalThis.window = {
    __DBG0_ACTIVE__: false,
    addEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      listeners.set(type, arr.filter((it) => it !== fn));
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "vitest",
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href: "http://127.0.0.1:5175/",
      reload: vi.fn(),
    },
  });
}

describe("Debugger Level0 trace_id", () => {
  it("генерирует trace_id при отсутствии и сохраняет переданный trace_id", () => {
    installDomStubs();
    delete window.__DBG0__;
    const dbg0 = initDebuggerLevel0();

    outbox.enqueue.mockClear();

    const generated = dbg0.pushEvent({ name: "ui.test.generated" });
    expect(typeof generated.trace_id).toBe("string");
    expect(generated.trace_id.length).toBeGreaterThan(0);

    const firstRaw = outbox.enqueue.mock.calls[0][0];
    expect(firstRaw.context.trace_id).toBe(generated.trace_id);

    const explicitTraceId = "trace-explicit-123";
    const explicit = dbg0.pushEvent({
      name: "ui.test.explicit",
      trace_id: explicitTraceId,
    });
    expect(explicit.trace_id).toBe(explicitTraceId);

    const secondRaw = outbox.enqueue.mock.calls[1][0];
    expect(secondRaw.context.trace_id).toBe(explicitTraceId);
  });
});
