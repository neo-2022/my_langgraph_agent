import { describe, it, expect } from "vitest";
import { rawEventSchema } from "../src/obs/rawEvent.schema.js";
import {
  RAW_EVENT_SCHEMA_VERSION,
  downgradeRawEventSchema,
  upgradeRawEventSchema,
} from "../src/obs/rawEvent.upgrade.js";
import { generateEventId } from "../src/obs/rawEvent.normalize.js";

const now = () => new Date().toISOString();

function buildBaseEvent(overrides = {}) {
  return {
    schema_version: overrides.schema_version || RAW_EVENT_SCHEMA_VERSION,
    event_id: overrides.event_id || "evt-test",
    timestamp: overrides.timestamp || now(),
    kind: overrides.kind || "test.raw",
    scope: overrides.scope || "ui",
    severity: overrides.severity || "info",
    message: overrides.message || "something happened",
    ...overrides,
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

describe("RawEvent schema compatibility", () => {
  it("validates a v2 event using the v1 schema and keeps unknown fields", () => {
    const blob = buildBaseEvent({ schema_version: "REGART.Art.RawEvent.v2", new_field: "extra" });
    const parsed = rawEventSchema.parse(blob);
    expect(parsed.new_field).toBe("extra");
    expect(parsed.schema_version).toBe("REGART.Art.RawEvent.v2");
  });

  it("upgrades an older schema during rolling upgrade and can downgrade again", () => {
    const oldEvent = buildBaseEvent({ schema_version: "REGART.Art.RawEvent.v0", legacy: true });
    const upgraded = upgradeRawEventSchema(oldEvent);
    expect(upgraded.schema_version).toBe(RAW_EVENT_SCHEMA_VERSION);
    expect(upgraded.legacy).toBe(true);
    expect(upgraded.version_history).toEqual(expect.arrayContaining(["REGART.Art.RawEvent.v0"]));

    const downgraded = downgradeRawEventSchema(upgraded, "REGART.Art.RawEvent.v0");
    expect(downgraded.schema_version).toBe("REGART.Art.RawEvent.v0");
    expect(downgraded.legacy).toBe(true);
  });

  it("generates 100k unique event ids even under parallel callers", async () => {
    const concurrency = 10;
    const perWorker = 10000;
    const promises = Array.from({ length: concurrency }, () => {
      return Promise.resolve().then(() => {
        const local = [];
        for (let i = 0; i < perWorker; i++) {
          local.push(generateEventId());
        }
        return local;
      });
    });
    const batches = await Promise.all(promises);
    const allIds = batches.flat();
    expect(allIds).toHaveLength(concurrency * perWorker);
    const unique = new Set(allIds);
    expect(unique.size).toBe(allIds.length);
  }, 10000);
});
