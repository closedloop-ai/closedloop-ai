/**
 * ISS-12552: the `operationEvidence` a Desktop syncs with a
 * session. Kept beside `desktop-agent-sessions-schema.ts` so that file does not
 * grow. A snapshot this API cannot parse is dropped to absent, which the
 * cloud reads as "no claim" and keeps what it stored, so a newer or malformed
 * field never rejects the session's sync.
 */
import {
  type ParsedSessionOperationEvidence,
  sessionOperationEvidenceSchema,
} from "@repo/api/src/types/operation-claims-schema";
import { z } from "zod";

export const syncedOperationEvidenceSchema = z
  .preprocess((value) => {
    if (value === undefined) {
      return;
    }
    const parsed = sessionOperationEvidenceSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }, z.custom<ParsedSessionOperationEvidence>().optional())
  .optional();
