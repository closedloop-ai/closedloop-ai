/**
 * @file store-integrity.ts
 * @description The desktop store-integrity probe's bounded vocabularies — check
 * names, issue categories, storage-exhaustion reasons, SQL statement families and
 * migration outcomes — with the Zod enums and the per-category `object` bound
 * that keep a path from riding in on a free-text field.
 *
 * Check names are TOLERANT of version skew (ISS-7488); the issue category and
 * the storage-exhaustion reason are deliberately not, because `object` is bound
 * per category — see `STORE_INTEGRITY_ISSUE_CATEGORY`.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { z } from "zod";
import { tolerantDesktopTelemetryValue } from "./tolerant-desktop-value";

/**
 * FEA-1999 / ISS-4818 — the desktop store-integrity probe's sub-check names, as
 * a const object so producers and this wire schema cannot drift. The desktop
 * mirror is `StoreIntegrityCheckName` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`.
 *
 * TOLERANT since ISS-7488. It was a closed `z.enum`, so a check name only a
 * newer desktop knew failed the WHOLE event as `telemetry.validation_failed`
 * rather than the one field — 5 of the 33 rejections measured over the 30 days
 * to 2026-09-14 were unrecognised members of `checksRun`. An unrecognised name
 * now coarsens to `Unknown`, so the probe's verdict, its duration, and the
 * issues it found still arrive from a desktop ahead of this deploy.
 *
 * A new check still belongs here in the same change: coarsening costs the one
 * dimension that says WHICH check ran, and
 * `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts` fails CI on a
 * producer-side member this const lacks.
 */
export const StoreIntegrityCheckName = {
  QuickCheck: "quick_check",
  IndexPresence: "index_presence",
  TokenParity: "token_parity",
  WalFrameProbe: "wal_frame_probe",
  /** ISS-4976: stored per-invocation telemetry that is impossible, not absent. */
  InvocationTelemetry: "invocation_telemetry",
  /** ISS-5102: bounded `PRAGMA foreign_key_check` + the FK-less orphan shape. */
  ForeignKeyCheck: "foreign_key_check",
  /** ISS-5838: persisted repository-default authority integrity. No longer emitted by Desktop (ISS-12594); kept for installed builds. */
  RepositoryDefaultAuthority: "repository_default_authority",
  /** ISS-6209: unreadable `created_at` on live invocation-delivery outbox rows. */
  InvocationSyncOutbox: "invocation_sync_outbox",
  /** ISS-6337: writes the local store refused for lack of disk space. */
  StorageExhaustion: "storage_exhaustion",
  /** ISS-6550: non-authoritative Desktop GitHub overlay persistence. No longer emitted by Desktop (ISS-12594); kept for installed builds. */
  CloudGithubOverlay: "cloud_github_overlay",
  /** ISS-8259: `sessions.metadata` blobs that are not parseable JSON. */
  SessionMetadata: "session_metadata",
  /** ISS-9981: local trace-comment writes that repaired an unreadable token. */
  TraceCommentGeneration: "trace_comment_generation",
  /**
   * ISS-7488 — a check name this build does not recognise, which for a desktop
   * fleet mid-rollout means a probe newer than this deploy. No producer emits
   * the value; it exists so the event survives rather than the name being read
   * as a real check.
   */
  Unknown: "unknown",
} as const;

export type StoreIntegrityCheckName =
  (typeof StoreIntegrityCheckName)[keyof typeof StoreIntegrityCheckName];

/** The bounded issue classifications that ride the same event. */
export const StoreIntegrityIssueCategory = {
  MissingIndexEntry: "missing_index_entry",
  WrongIndexEntryCount: "wrong_index_entry_count",
  NonUniqueIndexEntry: "non_unique_index_entry",
  MalformedStructure: "malformed_structure",
  Constraint: "constraint",
  MissingIndex: "missing_index",
  TokenStoreDivergence: "token_store_divergence",
  /** ISS-5342: a token total the parity read cannot legitimately produce. */
  TokenTotalOutOfRange: "token_total_out_of_range",
  WalProbeFailure: "wal_probe_failure",
  InvocationTelemetryOutOfRange: "invocation_telemetry_out_of_range",
  /** ISS-5102: `foreign_key_check` reported dangling FK rows in a child table. */
  ForeignKeyViolation: "foreign_key_violation",
  /** ISS-5102: orphaned rows on an FK-less reference (the ISS-5098 shape). */
  OrphanedRow: "orphaned_row",
  // ISS-12594: the next two are no longer emitted by Desktop; installed builds
  // still send them, so ingest keeps accepting them.
  MalformedRepositoryDefaultAuthority: "malformed_repository_default_authority",
  RepositoryDefaultAuthorityWriteFailure:
    "repository_default_authority_write_failure",
  /**
   * ISS-6209: an invocation-delivery outbox row whose `created_at` the desktop
   * lane cannot parse, so it cannot evaluate the horizon that bounds its retries.
   * `object` names the table only.
   */
  UnreadableInvocationSyncOutboxTimestamp:
    "unreadable_invocation_sync_outbox_timestamp",
  /**
   * ISS-5855: the desktop invocation lane permanently abandoned a delivery part
   * whose parent session never reached the cloud inside the retry horizon. The
   * lane has no dead-letter recovery, so that session's invocation data is
   * permanently incomplete upstream. `object` names the table only.
   */
  AbandonedInvocationSyncOutboxPart: "abandoned_invocation_sync_outbox_part",
  /**
   * ISS-6337: the desktop store refused at least one write because it is out of
   * space. `object` carries the bounded `StorageExhaustionReason`
   * (`sqlite_full` / `enospc` / `unattributed`) — never a filesystem path, which
   * would leak the OS account name.
   */
  StorageExhausted: "storage_exhausted",
  // ISS-12594: no longer emitted by Desktop; kept for installed builds.
  CloudGithubOverlayWriteFailure: "cloud_github_overlay_write_failure",
  /**
   * ISS-8259: at least one `sessions` row holds a `metadata` blob that is not
   * valid JSON, so every derivation over that column silently skips the session.
   * `object` names the table only — the blob is the largest column in the store
   * and can carry prompt text, so no id or fragment may ride this event.
   */
  MalformedSessionMetadata: "malformed_session_metadata",
  /**
   * ISS-9981: a local desktop write found `trace_comments.updated_at` (the row's
   * generation token) unreadable and repaired it to now. `object` names the
   * table only.
   */
  UnreadableTraceCommentGeneration: "unreadable_trace_comment_generation",
  Other: "other",
} as const;

export type StoreIntegrityIssueCategory =
  (typeof StoreIntegrityIssueCategory)[keyof typeof StoreIntegrityIssueCategory];

/**
 * ISS-6337 — the ONLY values `storage_exhausted` may carry in `object`.
 *
 * Mirrors `StorageExhaustionReason` in
 * `apps/desktop/src/main/database/storage-exhaustion.ts`, for the same reason
 * the two enums above are mirrored rather than imported: this package must not
 * depend on `apps/`. A reason only the producer knows about is rejected here, so
 * a new one MUST be added in the same change.
 *
 * This is enforced at ingest rather than trusted from the producer because the
 * generic `object` slot is a 128-char string: a malformed or version-skewed
 * desktop build could put a FILESYSTEM PATH there, and a path carries the OS
 * account name — the ISS-6228 / ISS-6229 leak class. The producer being bounded
 * today is not what keeps it bounded on the wire.
 */
export const StorageExhaustionReason = {
  SqliteFull: "sqlite_full",
  Enospc: "enospc",
  Unattributed: "unattributed",
} as const;

export type StorageExhaustionReason =
  (typeof StorageExhaustionReason)[keyof typeof StorageExhaustionReason];

/**
 * ISS-6339 — the closed set of statement families a desktop query-duration
 * sample may be labelled with.
 *
 * Mirrors `SqlStatementFamily` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`, for the same reason
 * the enums above are mirrored rather than imported: this package must not
 * depend on `apps/`. A family only the producer knows about is rejected here,
 * which drops the WHOLE event as `telemetry.validation_failed` rather than the
 * one field — so a new family MUST be added here in the same change.
 *
 * The point of the enum is cardinality: a duration keyed by the SQL text, or by
 * table plus column, grows its label set with the store and the workload. This
 * set cannot grow at all without a code change on both sides.
 */
export const SqlStatementFamily = {
  Select: "select",
  Insert: "insert",
  Update: "update",
  Delete: "delete",
  Pragma: "pragma",
  Ddl: "ddl",
  Transaction: "transaction",
  Other: "other",
} as const;

export type SqlStatementFamily =
  (typeof SqlStatementFamily)[keyof typeof SqlStatementFamily];

/**
 * ISS-6339 — how one desktop boot migration step finished.
 *
 * Mirrors `MigrationStepOutcome` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`; an outcome only the
 * producer knows about drops the whole event, so a new one MUST be added here in
 * the same change.
 */
export const MigrationStepOutcome = {
  Applied: "applied",
  /** The whole-migration attempt rolled back and re-ran statement-by-statement. */
  Reapplied: "reapplied",
  Failed: "failed",
} as const;

export type MigrationStepOutcome =
  (typeof MigrationStepOutcome)[keyof typeof MigrationStepOutcome];

export const SQL_STATEMENT_FAMILIES = Object.values(SqlStatementFamily);

export const SQL_STATEMENT_FAMILY = z.enum(SQL_STATEMENT_FAMILIES);

export const MIGRATION_STEP_OUTCOME = z.enum(
  Object.values(MigrationStepOutcome)
);

export const STORE_INTEGRITY_CHECK_NAMES = Object.values(
  StoreIntegrityCheckName
);

export const STORE_INTEGRITY_CHECK_NAME = tolerantDesktopTelemetryValue(
  StoreIntegrityCheckName
);

/**
 * ISS-7488 — the issue CATEGORY stays closed, and that asymmetry is deliberate.
 *
 * `object` is one shared 128-char free-text slot whose bound is derived from the
 * category ({@link storageExhaustedObjectIsBounded}). Coarsening an unrecognised
 * category onto an `Unknown` member would unbind that slot for exactly the
 * payloads this build cannot reason about — and the value a version-skewed
 * desktop might put there is a filesystem path, which carries the OS account
 * name (the ISS-6228 / ISS-6229 leak class). This module already records the
 * judgment that dropping such an event beats forwarding it, and this ticket does
 * not reverse it. `checksRun` and `issues[].check` carry no such sibling, which
 * is why they fold and this does not.
 */
export const STORE_INTEGRITY_ISSUE_CATEGORY = z.enum(
  Object.values(StoreIntegrityIssueCategory)
);

/**
 * ISS-5444 / ISS-7488 — the set of checks one probe run reported.
 *
 * The cap is the ENUM'S CARDINALITY, not a hand-tuned literal, so adding a check
 * moves the bound with it and no literal can fall behind.
 *
 * Deriving it only stays sound because the preprocess below reduces the array to
 * DISTINCT names — every unrecognised one onto a single `Unknown`, and every
 * recognised one to a single entry. Deduping the unknown half alone would have
 * left the cap resting on an `apps/desktop` invariant, that the probe appends
 * each name at most once per run; this schema is the half that cannot assume
 * anything about a desktop newer than this deploy, so a probe that re-ran a
 * known check after a retry would send more elements than the derived cap allows
 * and the whole event would fail `too_big` — trading the `invalid_value` drop
 * this ticket fixes for the same drop under another code. With the full dedupe
 * the element count can never exceed the number of members, whatever the
 * producer sends. `checksRun` is a SET of names semantically, so a repeat states
 * nothing a single entry does not; what is lost is HOW MANY unknown checks ran,
 * a number this build could not name the members of anyway.
 */
export const STORE_INTEGRITY_CHECKS_RUN = z.preprocess(
  foldCheckNamesToDistinct,
  z.array(STORE_INTEGRITY_CHECK_NAME).max(STORE_INTEGRITY_CHECK_NAMES.length)
);

export const STORAGE_EXHAUSTION_REASONS: readonly string[] = Object.values(
  StorageExhaustionReason
);

/**
 * ISS-6337 — hold `storage_exhausted` to its own closed vocabulary.
 *
 * `object` is one loose 128-char string shared by every category, so the enum
 * that bounds this one has to be applied per-category. Rejecting is the right
 * failure here, and matches how this schema already treats an unknown check name
 * or category: a path in this slot is a PII leak, and dropping the event is
 * strictly better than forwarding one. Omitting `object` stays valid — a window
 * that recorded no reason legitimately has none.
 */
export function storageExhaustedObjectIsBounded(
  issue: { category: string; object?: string },
  ctx: z.RefinementCtx
): void {
  if (
    issue.category !== StoreIntegrityIssueCategory.StorageExhausted ||
    issue.object === undefined ||
    STORAGE_EXHAUSTION_REASONS.includes(issue.object)
  ) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    path: ["object"],
    message: `storage_exhausted object must be one of ${STORAGE_EXHAUSTION_REASONS.join(" | ")}`,
  });
}

/**
 * ISS-7488 — reduce `checksRun` to the DISTINCT names it reported, every
 * unrecognised one folded onto `Unknown`.
 *
 * Runs BEFORE the element schema so the array's derived cap can still hold: see
 * {@link STORE_INTEGRITY_CHECKS_RUN}. A non-array and a non-string element are
 * passed through untouched — the tolerance is for unknown MEMBERS, not for a
 * structurally wrong payload, which must still fail, and a non-string is not a
 * name to dedupe against.
 */
function foldCheckNamesToDistinct(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const seen = new Set<string>();
  const folded: unknown[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      folded.push(entry);
      continue;
    }
    const name = KNOWN_CHECK_NAMES.has(entry)
      ? entry
      : StoreIntegrityCheckName.Unknown;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    folded.push(name);
  }
  return folded;
}

/** Membership lookup for the fold above; built once rather than per parse. */
const KNOWN_CHECK_NAMES = new Set<string>(STORE_INTEGRITY_CHECK_NAMES);
