const STORAGE_KEY = "regart.session_id";

function createSessionId(prefix = "sess") {
  try {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch {}
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function getSessionId() {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const value = createSessionId();
    window.sessionStorage.setItem(STORAGE_KEY, value);
    return value;
  } catch {
    return undefined;
  }
}

export function resetSessionId() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
