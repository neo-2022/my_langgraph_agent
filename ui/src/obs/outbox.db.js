import Dexie from "dexie";

export function createOutboxDb(name = "regart_outbox") {
  const db = new Dexie(name);
  db.version(1).stores({
    events: "++id, event_id, status, session_id, sequence_id, created_at",
    dlq: "++id, event_id, created_at",
    meta: "&session_id, last_sequence_id",
  });
  return db;
}

export const defaultOutboxDb = createOutboxDb();
