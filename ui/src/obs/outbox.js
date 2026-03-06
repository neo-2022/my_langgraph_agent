import { httpClient } from "./httpClient.js";
import { normalizeRawEvent } from "./rawEvent.normalize.js";
import { getSessionId } from "./session.js";
import { defaultOutboxDb, createOutboxDb } from "./outbox.db.js";
import { tabLock } from "./tabLock.js";
import { shouldSendDedup } from "../multiTabManager.js";

const STATUS = Object.freeze({
  pending: "pending",
  inFlight: "in_flight",
  retryable: "retryable",
});

const DEFAULTS = {
  maxBatchEvents: 50,
  maxBatchBytes: 256 * 1024,
  maxRetries: 8,
  flushDelayMs: 500,
};

function estimateSize(value) {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).length;
  } catch {
    return 0;
  }
}

export function pushObservabilityGap(name, payload = {}) {
  try {
    if (typeof window === "undefined") return;
    const target = window.__DBG0__;
    if (!target || typeof target.pushEvent !== "function") return;
    target.pushEvent({
      name,
      origin: "frontend",
      level: "warn",
      ts: new Date().toISOString(),
      payload,
    });
  } catch {
    // best effort
  }
}

async function defaultSendBatch({ events }) {
  return httpClient.post("/ui/art/ingest", {
    body: { events },
    timeout: 15000,
  });
}

export class Outbox {
  constructor(options = {}) {
    this.db = options.db || defaultOutboxDb;
    this.sendBatch = options.sendBatch || defaultSendBatch;
    this.maxBatchEvents = options.maxBatchEvents || DEFAULTS.maxBatchEvents;
    this.maxBatchBytes = options.maxBatchBytes || DEFAULTS.maxBatchBytes;
    this.maxRetries = options.maxRetries || DEFAULTS.maxRetries;
    this.flushDelayMs = options.flushDelayMs || DEFAULTS.flushDelayMs;
    this._flushing = false;
    this._flushTimer = null;
    this._lastDlqGapTs = 0;
    this._scheduled = false;
    if (!this.db.isOpen()) {
      this.db.open().catch(() => {});
    }
  }

  async enqueue(event) {
    const normalized = normalizeRawEvent(event);
    const sessionId = normalized.session_id || getSessionId();
    if (sessionId) normalized.session_id = sessionId;
    const sequence = await this._reserveSequence(sessionId);
    if (sequence != null) {
      normalized.sequence_id = sequence;
    }
    const stored = {
      raw_event: normalized,
      event_id: normalized.event_id,
      session_id: normalized.session_id,
      sequence_id: normalized.sequence_id,
      created_at: Date.now(),
      status: STATUS.pending,
      try_count: 0,
      size: estimateSize(normalized),
    };
    await this.db.events.add(stored);
    this._scheduleFlush();
    return stored;
  }

  async listPage(page = 0, pageSize = 20) {
    const skip = page * pageSize;
    return this.db.events.orderBy("created_at").offset(skip).limit(pageSize).toArray();
  }

  async stats() {
    const [pending, dlq] = await Promise.all([
      this.db.events.where("status").equals(STATUS.pending).count(),
      this.db.dlq.count(),
    ]);
    return { pending, dlq };
  }

  async flush() {
    if (this._flushing) return;
    this._flushing = true;
    let hasLock = false;
    try {
      hasLock = await tabLock.acquire();
      if (!hasLock) {
        return;
      }
      const batch = await this._collectBatch();
      if (!batch.length) return;
      const batchToSend = [];
      for (const entry of batch) {
        if (!shouldSendDedup(entry.raw_event?.dedup_key)) {
          await this.db.events.delete(entry.id);
          continue;
        }
        batchToSend.push(entry);
      }
      if (!batchToSend.length) return;
      await this._markInFlight(batchToSend);
      try {
        const response = await this.sendBatch({ events: batchToSend.map((entry) => entry.raw_event) });
        await this._processBatch(batchToSend, response?.results ?? []);
      } catch (error) {
        await this._handleFlushError(batchToSend, error);
      }
    } finally {
      if (hasLock) {
        tabLock.release();
      } else {
        this._scheduleFlush();
      }
      this._flushing = false;
    }
  }

  async _collectBatch() {
    const entries = await this.db.events.where("status").anyOf([STATUS.pending, STATUS.retryable]).toArray();
    entries.sort((a, b) => (a.sequence_id || 0) - (b.sequence_id || 0) || a.created_at - b.created_at);
    const selected = [];
    let bytes = 0;
    for (const entry of entries) {
      if (selected.length >= this.maxBatchEvents) break;
      const nextBytes = bytes + (entry.size || 0);
      if (nextBytes > this.maxBatchBytes && selected.length) break;
      selected.push(entry);
      bytes = nextBytes;
    }
    return selected;
  }

  async _markInFlight(batch) {
    if (!batch.length) return;
    await this.db.events.bulkPut(batch.map((entry) => ({ ...entry, status: STATUS.inFlight })));
    for (const entry of batch) {
      entry.status = STATUS.inFlight;
    }
  }

  async _handleFlushError(batch, error) {
    pushObservabilityGap("observability_gap.outbox_flush_failed", {
      error: String(error?.message || error),
      pending: batch.length,
    });
    for (const entry of batch) {
      const nextCount = (entry.try_count || 0) + 1;
      if (nextCount >= this.maxRetries) {
        await this._moveToDlq(entry, "max_retries");
      } else {
        await this.db.events.update(entry.id, {
          status: STATUS.retryable,
          try_count: nextCount,
          last_attempt: Date.now(),
        });
      }
    }
  }

  async _processBatch(batch, results) {
    const ackMap = new Map((results || []).map((ack) => [ack.event_id, ack]));
    for (const entry of batch) {
      const ack = ackMap.get(entry.event_id);
      if (ack?.status === "accepted") {
        await this.db.events.delete(entry.id);
        continue;
      }
      if (ack?.status === "rejected") {
        await this._moveToDlq(entry, ack.reason || "rejected");
        continue;
      }
      const nextCount = (entry.try_count || 0) + 1;
      if (nextCount >= this.maxRetries) {
        await this._moveToDlq(entry, ack?.reason || "max_retries");
        continue;
      }
      await this.db.events.update(entry.id, {
        status: STATUS.retryable,
        try_count: nextCount,
        last_attempt: Date.now(),
      });
    }
  }

  async _moveToDlq(entry, reason) {
    await this.db.dlq.add({
      event_id: entry.event_id,
      raw_event: entry.raw_event,
      reason: reason || "dlq",
      created_at: Date.now(),
      attempts: (entry.try_count || 0) + 1,
    });
    await this.db.events.delete(entry.id);
    const size = await this.db.dlq.count();
    pushObservabilityGap("observability_gap.dlq_enqueued", {
      event_id: entry.event_id,
      reason,
      size,
    });
    pushObservabilityGap("observability_gap.dlq_size", { size });
    this._checkDlqNonEmpty(size);
  }

  _checkDlqNonEmpty(size) {
    if (!size) {
      this._lastDlqGapTs = 0;
      return;
    }
    const now = Date.now();
    if (!this._lastDlqGapTs || now - this._lastDlqGapTs > 15 * 60 * 1000) {
      pushObservabilityGap("observability_gap.dlq_non_empty", { size });
      this._lastDlqGapTs = now;
    }
  }

  async _reserveSequence(sessionId) {
    if (!sessionId) return undefined;
    return this.db.transaction("rw", this.db.meta, async () => {
      const existing = await this.db.meta.get(sessionId);
      const next = (existing?.last_sequence_id || 0) + 1;
      await this.db.meta.put({ session_id: sessionId, last_sequence_id: next });
      return next;
    });
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(() => {});
    }, this.flushDelayMs);
  }
}

export const outbox = new Outbox();
export function createTestOutbox(options = {}) {
  const db = options.db || createOutboxDb(`regart_outbox_test_${Date.now()}`);
  return new Outbox({ ...options, db });
}
