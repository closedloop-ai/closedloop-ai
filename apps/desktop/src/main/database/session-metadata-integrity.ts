/**
 * @file session-metadata-integrity.ts
 * @description ISS-8259 schema-aware store-integrity check for persisted
 * `sessions.metadata`. Counts rows whose blob is not valid JSON; telemetry
 * receives a table identifier and the presence of malformed rows, never a row
 * value or a session id.
 *
 * Why this is a PROBE and not a log at the point of the skip. Every reader of
 * this column already degrades on a malformed blob rather than throwing —
 * `deriveSessionTurnBuckets` returns `[]`, `session-metadata-projection.ts`
 * passes the row through untouched, and the `json_valid` guards in
 * `session-aggregate-filters.ts`, `dashboard-queries.ts` and
 * `branch-activity-sql.ts` all skip it — so the condition has been reachable and
 * UNREPORTED from many places, not just one. A diagnostic emitted from any single
 * one of those would report only the rows that reader happened to select, which
 * for `recomputeLegacyMessageAgentTurnBuckets` is the sessions with no token
 * events and no agent bucket: a strict undercount presented as a measurement.
 *
 * Readers skip it without reporting; this integrity check scans the whole table
 * and raises the telemetry against the monitored `storeIntegrity` event.
 */
import { z } from "zod";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Clone-safe aggregate returned across the DB-host boundary. */
export type SessionMetadataIntegrityResult = {
  malformedRows: number;
};

/** Optional DB-host read surface consumed by the regularly wired probe. */
export type SessionMetadataIntegrityReader = {
  runSessionMetadataIntegrityCheck?(): Promise<SessionMetadataIntegrityResult>;
};

/** Runtime boundary for a version-skewed DB-host response. */
export const SESSION_METADATA_INTEGRITY_SCHEMA = z.object({
  malformedRows: z.number().int().nonnegative().safe(),
});

/**
 * Count sessions whose `metadata` is present but not parseable JSON.
 *
 * A single aggregate, not a paged row scan: `json_valid` is a scalar JSON1
 * function, so SQLite answers this without materializing any blob into JS. That
 * matters here more than in the sibling checks — this column is the largest in
 * the store, and the analytics invariant in this directory's AGENTS.md forbids
 * hydrating it corpus-wide.
 *
 * `metadata IS NULL` is NOT malformed. It is the ordinary absence every reader
 * already handles, and counting it would make the signal fire on healthy stores.
 */
export function runSessionMetadataIntegrityCheck(
  prisma: DesktopPrisma
): Promise<SessionMetadataIntegrityResult> {
  return prisma.read(async (reader) => {
    const rows = await reader.$queryRawUnsafe<{ n: number | bigint | null }[]>(
      `SELECT COUNT(*) AS n
         FROM sessions
        WHERE metadata IS NOT NULL
          AND json_valid(metadata) = 0`
    );
    return { malformedRows: Number(rows[0]?.n ?? 0) };
  });
}

/** Convert a positive malformed-row count into one content-free table issue. */
export function classifySessionMetadataIntegrity(
  result: SessionMetadataIntegrityResult,
  issues: StoreIntegrityIssue[]
): void {
  if (result.malformedRows > 0) {
    issues.push({
      check: "session_metadata",
      category: "malformed_session_metadata",
      object: "sessions",
      objectType: "table",
    });
  }
}

/** Compose the clone-safe read, validation, and classifier for probe wiring. */
export function sessionMetadataIntegrityCheck(
  reader: SessionMetadataIntegrityReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "session_metadata",
    label: "session metadata integrity check",
    read: reader.runSessionMetadataIntegrityCheck
      ? () => Promise.resolve(reader.runSessionMetadataIntegrityCheck?.())
      : undefined,
    schema: SESSION_METADATA_INTEGRITY_SCHEMA,
    classify: classifySessionMetadataIntegrity,
  });
}
