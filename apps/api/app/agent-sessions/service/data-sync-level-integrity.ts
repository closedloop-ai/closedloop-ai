import {
  type DataSyncLevel,
  toDataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { log } from "@repo/observability/log";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

/**
 * @file data-sync-level-integrity.ts
 * @description The READ of `session_detail.data_sync_level` that keeps a
 * CORRUPT value distinguishable from an ABSENT one.
 *
 * `toDataSyncLevel` returns `undefined` for both, deliberately — a value the
 * server cannot trust must not produce a verdict any more than a missing one
 * can. That is the right WIRE answer and the wrong OBSERVABILITY answer: an
 * older desktop that never wrote the column and a row holding garbage are the
 * same silence, so nobody can tell a version-skew population from a data-
 * integrity incident. This module keeps the wire answer identical and adds the
 * server-side record, which is the half that was missing.
 */

export const SESSION_DATA_SYNC_LEVEL_CORRUPT_EVENT =
  "agent_session_data_sync_level_corrupt";

/** One emission per organization per window. */
export const DATA_SYNC_LEVEL_CORRUPT_WINDOW_MS = 60_000;

/** Distinct keys tracked before the limiter evicts in insertion order. */
export const DATA_SYNC_LEVEL_CORRUPT_MAX_ENTRIES = 10_000;

/**
 * How much of the offending value is recorded. The column is untrusted TEXT of
 * unbounded length, so the sample is clipped rather than passed through — enough
 * to recognize the bad writer, bounded so one row cannot bloat a log line. The
 * full length is emitted alongside it, so a clipped sample is visible as clipped
 * instead of reading as the whole value.
 */
export const CORRUPT_DATA_SYNC_LEVEL_SAMPLE_MAX_LENGTH = 64;

export type DataSyncLevelIntegrityContext = {
  organizationId: string;
  sessionId: string;
};

/**
 * Narrow the stored column to a {@link DataSyncLevel}, reporting the corrupt
 * case on the way past.
 *
 * The narrowing and the integrity check are ONE call on purpose. Split in two,
 * a caller can read the column without the check and nothing fails — which is
 * precisely the state this fixes — so the only way to read this column is the
 * way that also reports a bad one.
 *
 * OMISSION SEMANTICS ARE PRESERVED EXACTLY. An ABSENT value returns `undefined`
 * and logs NOTHING: a desktop build that predates the column legitimately
 * reports no level, and treating that as an anomaly would drown the real signal
 * in the entire pre-upgrade fleet. Only a PRESENT unrecognized value is an
 * anomaly. Both still return `undefined`, so the served payload is
 * byte-identical either way and no reader can be shown a level the row does not
 * support.
 *
 * Absent means `null` OR `undefined`, and the difference is not cosmetic: the
 * column is `String?`, so a row that never set it reads as `null`, while a
 * `select` that omits the field — or any caller reading a record projected
 * without it — hands over `undefined`. Checking only `null` treats that second
 * shape as corrupt and, before the fix, dereferenced it. Hence `== null`.
 *
 * Takes `unknown` rather than `string | null` on purpose. This is a read of a
 * persisted row, which the root `AGENTS.md` names as a boundary the type system
 * does not constrain at runtime; the reporter below must therefore be safe for
 * whatever the column actually holds, not only for what Prisma's generated type
 * promises.
 */
export function readPersistedDataSyncLevel(
  stored: unknown,
  context: DataSyncLevelIntegrityContext
): DataSyncLevel | undefined {
  const level = toDataSyncLevel(stored);
  if (level === undefined && stored != null) {
    reportCorruptDataSyncLevel(stored, context);
  }
  return level;
}

/**
 * Reset the process-local budget. For tests, which must not inherit another
 * spec's spent window.
 */
export function resetDataSyncLevelCorruptBudget(): void {
  emissionBudget.clear();
}

function reportCorruptDataSyncLevel(
  stored: NonNullable<unknown>,
  context: DataSyncLevelIntegrityContext
): void {
  if (!emissionBudget.attempt(context.organizationId, Date.now())) {
    return;
  }
  // `String(...)` rather than a `typeof` branch: the column is TEXT, so a
  // non-string here already means the row disagrees with its own schema, and
  // that is the case least worth crashing a detail read over. Rendering it keeps
  // the line useful without the reporter needing to know what went wrong.
  const rendered = String(stored);
  log.warn(SESSION_DATA_SYNC_LEVEL_CORRUPT_EVENT, {
    organizationId: context.organizationId,
    sessionId: context.sessionId,
    storedValueSample: rendered.slice(
      0,
      CORRUPT_DATA_SYNC_LEVEL_SAMPLE_MAX_LENGTH
    ),
    storedValueLength: rendered.length,
  });
}

/**
 * Process-local emission budget, one event per organization per window.
 * Best-effort and ephemeral per serverless instance, exactly like the sibling
 * limiters in `apps/api/lib` — reused rather than reimplemented so this does not
 * fork a second copy of the fixed-window mechanism.
 *
 * Keyed on the ORGANIZATION, not the session: a corrupt column does not
 * self-heal, so it is re-read on every detail request, and the branch
 * merged-trace fan-out hydrates many sessions per request. A session-keyed
 * budget is defeated by exactly the traffic it bounds — a caller cycling more
 * distinct sessions than the entry cap evicts its own key before reuse. The
 * trade is the sibling's: a suppressed emission inside a window may be a
 * DIFFERENT affected session, so this event answers "is this org serving corrupt
 * levels", and the affected-row population is a corpus query, not this log.
 */
const emissionBudget = new FixedWindowRateLimiter({
  maxEntries: DATA_SYNC_LEVEL_CORRUPT_MAX_ENTRIES,
  maxRequests: 1,
  windowMs: DATA_SYNC_LEVEL_CORRUPT_WINDOW_MS,
});
