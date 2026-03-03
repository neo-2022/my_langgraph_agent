import { rawEventSchema } from "./rawEvent.schema.js";
import { getSessionId } from "./session.js";

const CURRENT_SCHEMA_VERSION = "REGART.Art.RawEvent.v1";
const VALID_SEVERITIES = new Set(["debug", "info", "warn", "error", "fatal"]);

function nowIso() {
  return new Date().toISOString();
}

function toString(value, fallback = "") {
  if (value == null) return fallback;
  return typeof value === "string" ? value : String(value);
}

function ensureObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function ensureArray(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  return undefined;
}

function parseSequence(value) {
  if (value == null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(0, Math.trunc(num));
}

export function generateEventId(prefix = "evt") {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // fallback
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function ensureSeverity(value) {
  const normalized = toString(value, "").toLowerCase();
  if (VALID_SEVERITIES.has(normalized)) return normalized;
  return "error";
}

function ensureTimestamp(value) {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return nowIso();
}

function ensureTags(value) {
  if (!Array.isArray(value)) return undefined;
  const filtered = value
    .map((item) => toString(item))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 64);
  return filtered.length ? filtered : undefined;
}

function ensureAttrs(value) {
  const obj = ensureObject(value);
  if (!obj) return undefined;
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!key || String(key).trim().length === 0) continue;
    if (val === undefined) continue;
    if (typeof val === "string" || typeof val === "boolean" || typeof val === "number" || val === null) {
      out[key] = val;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function buildVersionHistory(base, overrides) {
  const history = new Set();
  const baseVersion = toString(overrides.schema_version || base.schema_version || CURRENT_SCHEMA_VERSION).trim();
  if (baseVersion) history.add(baseVersion);
  const inputHistory = Array.isArray(base.version_history) ? base.version_history : [];
  const overrideHistory = Array.isArray(overrides.version_history) ? overrides.version_history : [];
  for (const candidate of [...inputHistory, ...overrideHistory]) {
    const value = toString(candidate).trim();
    if (value) history.add(value);
  }
  return Array.from(history);
}

export function normalizeRawEvent(input = {}, overrides = {}) {
  const base = ensureObject(input) || {};
  const overrideObj = ensureObject(overrides) || {};

  const merged = {
    ...base,
    ...overrideObj,
    schema_version: toString(overrideObj.schema_version || base.schema_version || CURRENT_SCHEMA_VERSION),
    event_id: toString(overrideObj.event_id || base.event_id || generateEventId("raw")),
    timestamp: ensureTimestamp(overrideObj.timestamp || base.timestamp),
    kind: toString(overrideObj.kind || base.kind || "raw_event"),
    scope: toString(overrideObj.scope || base.scope || "ui"),
    severity: ensureSeverity(overrideObj.severity || base.severity),
    title: toString(overrideObj.title || base.title || "").slice(0, 256),
    message: toString(overrideObj.message || base.message || "(no message)").slice(0, 32768),
    payload: ensureObject(overrideObj.payload ?? base.payload) ?? {},
    context: ensureObject(overrideObj.context ?? base.context) || undefined,
    tags: ensureTags(overrideObj.tags ?? base.tags),
    attrs: ensureAttrs(overrideObj.attrs ?? base.attrs),
    attachments: ensureArray(overrideObj.attachments ?? base.attachments),
    sequence_id: parseSequence(overrideObj.sequence_id ?? base.sequence_id),
    session_id: (() => {
      const session = toString(
        overrideObj.session_id || base.session_id || getSessionId() || "",
      ).trim();
      return session || undefined;
    })(),
    version_history: buildVersionHistory(base, overrideObj),
  };

  if (!Array.isArray(merged.version_history) || merged.version_history.length === 0) {
    merged.version_history = [merged.schema_version];
  }

  return rawEventSchema.parse(merged);
}
