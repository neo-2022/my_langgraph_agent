import { z } from "zod";

const attachmentSchema = z
  .object({
    id: z.string().min(1).max(80),
    filename: z.string().min(1).max(260),
    mime: z.string().min(3).max(100),
    size: z.number().int().nonnegative(),
    digest: z.string().max(128).optional(),
  })
  .passthrough();

export const rawEventSchema = z
  .object({
    schema_version: z.string().min(1).max(64),
    event_id: z.string().min(8).max(80),
    session_id: z.string().min(1).max(256).optional(),
    sequence_id: z.number().int().nonnegative().optional(),
    timestamp: z.string().datetime().optional(),
    kind: z.string().min(1).max(120),
    scope: z.string().min(1).max(120),
    severity: z.enum(["debug", "info", "warn", "error", "fatal"]),
    title: z.string().max(256).optional(),
    message: z.string().min(1).max(32768),
    payload: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()).optional(),
    attachments: z.array(attachmentSchema).optional(),
    tags: z.array(z.string().max(64)).max(64).optional(),
    attrs: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    content_hash: z.string().max(128).optional(),
    version_history: z.array(z.string().min(1).max(64)).optional(),
  })
  .passthrough();
