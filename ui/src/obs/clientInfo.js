import { httpClient } from "./httpClient.js";

let cachedInfo = null;

export async function fetchClientInfo() {
  if (cachedInfo) return cachedInfo;
  try {
    const info = await httpClient.get("/ui/client-info");
    cachedInfo = info;
    if (info && info.client_id && typeof window !== "undefined") {
      window.__REGART_CLIENT_ID__ = info.client_id;
    }
    return info;
  } catch (error) {
    console.warn("fetchClientInfo failed", error);
    return null;
  }
}

export function getClientId() {
  if (cachedInfo && cachedInfo.client_id) return cachedInfo.client_id;
  if (typeof window === "undefined") return undefined;
  return window.__REGART_CLIENT_ID__;
}

export function resetClientInfo() {
  cachedInfo = null;
  if (typeof window !== "undefined") {
    delete window.__REGART_CLIENT_ID__;
  }
}
