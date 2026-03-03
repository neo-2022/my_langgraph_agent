const DEFAULT_LOCK_KEY = "regart_tab_lock";
const TTL_MS = 6000;
const HEARTBEAT_MS = 2000;

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasLocalStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function genTabId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // fallthrough
    }
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class TabLock {
  constructor(options = {}) {
    this.key = options.key || DEFAULT_LOCK_KEY;
    this.ttl = options.ttl || TTL_MS;
    this.heartbeat = options.heartbeat || HEARTBEAT_MS;
    this.tabId = genTabId();
    this.channel = null;
    this.heartbeatTimer = null;
    this.boundStorage = this._handleStorageEvent.bind(this);
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel(`${this.key}`);
        this.channel.addEventListener("message", this.boundStorage);
      } catch {
        this.channel = null;
      }
    }
    if (hasLocalStorage()) {
      window.addEventListener("storage", this.boundStorage);
    }
  }

  _handleStorageEvent(event) {
    if (!event) return;
    if (event.key === this.key && !this.isOwner()) {
      // try to reacquire stale lock next flush
      this._stopHeartbeat();
    }
  }

  _readRecord() {
    if (!hasLocalStorage()) return null;
    const raw = window.localStorage.getItem(this.key);
    if (!raw) return null;
    const rec = safeParse(raw);
    if (rec && typeof rec.expiresAt === "number") {
      return rec;
    }
    return null;
  }

  _writeRecord(record) {
    if (!hasLocalStorage()) return;
    try {
      window.localStorage.setItem(this.key, JSON.stringify(record));
    } catch {
      // ignore
    }
    this._broadcast(record);
  }

  _removeRecord() {
    if (!hasLocalStorage()) return;
    try {
      window.localStorage.removeItem(this.key);
    } catch {
      // ignore
    }
    this._broadcast({ tabId: this.tabId, action: "release" });
  }

  _broadcast(payload) {
    if (this.channel) {
      try {
        this.channel.postMessage(payload);
      } catch {}
    }
    if (hasLocalStorage()) {
      try {
        window.localStorage.setItem(`${this.key}-event`, JSON.stringify({ ...payload, ts: Date.now() }));
        window.localStorage.removeItem(`${this.key}-event`);
      } catch {}
    }
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    const tick = () => {
      if (!this.isOwner()) {
        this._stopHeartbeat();
        return;
      }
      const now = Date.now();
      this._writeRecord({ tabId: this.tabId, expiresAt: now + this.ttl });
    };
    tick();
    this.heartbeatTimer = setInterval(tick, this.heartbeat);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  isOwner() {
    const record = this._readRecord();
    return record?.tabId === this.tabId;
  }

  async acquire() {
    const now = Date.now();
    const record = this._readRecord();
    if (!record || record.expiresAt < now || record.tabId === this.tabId) {
      this._writeRecord({ tabId: this.tabId, expiresAt: now + this.ttl });
      this._startHeartbeat();
      return true;
    }
    return false;
  }

  release() {
    if (this.isOwner()) {
      this._removeRecord();
    }
    this._stopHeartbeat();
  }

  dispose() {
    this.release();
    if (this.channel) {
      this.channel.removeEventListener("message", this.boundStorage);
      this.channel.close();
      this.channel = null;
    }
    if (hasLocalStorage()) {
      window.removeEventListener("storage", this.boundStorage);
    }
  }
}

export const tabLock = new TabLock();
export { TabLock };
