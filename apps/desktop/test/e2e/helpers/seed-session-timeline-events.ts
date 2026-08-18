/**
 * ISS-5124: direct-SQLite seeding of a session's raw `events` stream for the
 * desktop E2E suite, with the two fields the existing seeders hold fixed —
 * `created_at` and `tool_name` — opened up to the caller.
 *
 * Its own module rather than another concern piled onto `seed-branches-db.ts`
 * (already well past the file-size smell threshold), following the ISS-4896
 * precedent set by `seed-activity-segments.ts`: shared connection/schema-wait
 * substrate stays in `desktop-seed-core.ts`, and this file owns only the
 * `events` row shape.
 *
 * ## Why the existing seeder cannot express this
 *
 * `substantiveToolEventBatchItem` (`seed-branches-db.ts`) hardcodes
 * `event_type='PreToolUse'`, `tool_name='SeedTool'` and a REQUIRED valid
 * `created_at`. Every one of those is load-bearing against ISS-5124:
 *
 * - a valid `created_at` produces a TIMED turn row, which sends
 *   `alignBucketRowsToTranscript` down its repair path instead of the bail-out
 *   this spec exists to pin;
 * - a non-null `tool_name` makes the event tool-like, so `buildToolsTurn`
 *   coalesces the whole run into ONE `tools` card and the transcript can no
 *   longer overflow its scroller.
 *
 * ## `created_at: null` is a real shape, not a contrivance
 *
 * `events.created_at` is a nullable `TEXT` with no `NOT NULL` and no default
 * (`0001_init` in `migration/migrations-manifest.ts`; `createdAt String?` in
 * `prisma/schema.prisma`). The bounded read selects it with no filter and the
 * projection copies it verbatim into `TurnItem.t`, where `Date.parse` yields
 * `NaN` for `tMs`. `db-row-types.ts` types the column `string`, which is the
 * type lying about the schema — precisely the class of drift that let the
 * ISS-5124 population exist unnoticed.
 *
 * The asymmetry that makes such a session interesting is entirely inside the
 * desktop producer, which is why this needs a desktop spec rather than an
 * assumption borrowed from web: `bucketIndex` (`session-trace.ts`) FLOORS an
 * unparseable instant into bucket 0 and lets `bucket.tl0 ??= index` fire, while
 * `hasTimedTraceRow` (`session-timeline-geometry.ts`) REJECTS the very same row.
 * One fold keeps it, the other drops it — so the bar ends up carrying a jump
 * target derived from rows the transcript side refuses to place.
 */

import {
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForColumnsPresent,
} from "./desktop-seed-core";

const EVENTS_TABLE = "events";
const EVENT_REQUIRED_COLUMNS = [
  "id",
  "session_id",
  "event_type",
  "tool_name",
  "summary",
  "created_at",
] as const;

/**
 * One raw `events` row. Mirrors the columns the desktop sync source reads in
 * `sync-source-bounded-reads.ts`, so a seeded event is indistinguishable from a
 * collected one to the detail read — no test-only code path.
 */
export type SessionEventSeed = {
  /**
   * `events.event_type`. `eventKindToTimelineKind` lowercases it and routes on
   * substrings, so a type containing `"prompt"` (with a NULL `tool_name`) yields
   * a `type:"prompt"` turn row whose visible text is {@link summary}.
   */
  eventType: string;
  /**
   * `events.tool_name`. NULL keeps the event NON-tool-like, so each row stays
   * its own turn instead of being coalesced into a single `tools` card.
   */
  toolName?: string | null;
  /** `events.summary` — the transcript row's rendered text. */
  summary: string;
  /**
   * `events.created_at`, verbatim. `null` is the ISS-5124 shape: the column is
   * nullable and nothing on the read path coerces or filters it.
   */
  createdAt: string | null;
};

/**
 * Insert raw `events` rows for an ALREADY-SEEDED session, while the app is DOWN.
 *
 * Compose after `seedSessionsList(..., { idle: true })`. The `idle` flag is not
 * cosmetic here: a default seed writes its own `PreToolUse` row at a VALID
 * instant, and that single timed row is enough to give the transcript a timed
 * turn — which flips `alignBucketRowsToTranscript` from the demotion branch to
 * the repair branch and would make an ISS-5124 spec silently assert nothing.
 *
 * Checkpoints on the way out so the next launch's fresh connection reads the
 * rows from the main db file rather than a WAL segment this process still owns.
 */
export async function seedSessionEvents(
  userDataDir: string,
  sessionId: string,
  events: readonly SessionEventSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForColumnsPresent(
      client,
      EVENTS_TABLE,
      EVENT_REQUIRED_COLUMNS,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );
    await client.batch(
      events.map((event, index) => ({
        sql: `INSERT INTO events
                (id, session_id, event_type, tool_name, summary, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          `${sessionId}-event-${index}`,
          sessionId,
          event.eventType,
          event.toolName ?? null,
          event.summary,
          event.createdAt,
        ],
      })),
      "write"
    );
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
