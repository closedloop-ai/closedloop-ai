/**
 * ISS-4896: direct-SQLite seeding of a session's raw activity tiling
 * (`session_activity_segments`) for the desktop E2E suite.
 *
 * Its own module rather than another concern piled onto `seed-branches-db.ts`,
 * which was already well past the file-size smell threshold. The shared
 * connection/schema-wait substrate lives in `desktop-seed-core.ts`; this file
 * owns only the activity-segment table and its row shape.
 *
 * Seeded rather than imported through the real classifier because the cases the
 * label-parity specs need are hard to provoke from a synthetic transcript — an
 * EVIDENCED catch-all span, an EVIDENCE-FREE one, and an unknown compound phase
 * key — and driving the classifier to emit exactly those would pin the test to
 * classifier internals instead of to the label contract under test. The rows are
 * the real ones the desktop sync source reads, so the app's real detail
 * projection runs over them (no test-only code path).
 */

import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForColumnsPresent,
} from "./desktop-seed-core";

/**
 * One raw classifier span. Mirrors the `session_activity_segments` row shape the
 * desktop sync source reads (`SyncedActivitySegmentRow` on the wire), so a
 * seeded tiling is indistinguishable from a classified one to the detail read.
 */
export type ActivitySegmentSeed = {
  /** Verbatim classifier phase key — a bounded free string, not a closed union. */
  phase: string;
  /** epoch-ms inclusive lower bound. */
  startMs: number;
  /** epoch-ms exclusive upper bound (half-open `[startMs, endMs)`). */
  endMs: number;
  /** Attribution confidence in [0, 1] (defaults to 1). */
  confidence?: number;
  /**
   * Ranked evidence-layer names. EMPTY is meaningful, not a placeholder: an
   * evidence-free `other`/unknown span is projected as the strip's `unavailable`
   * fill, which is the case ISS-4790's `describeKind` bug mis-named. Defaults to
   * `[]`.
   */
  evidenceLayers?: string[];
};

/** The raw classifier tiling table both the seeder and its schema wait target. */
const ACTIVITY_SEGMENTS_TABLE = "session_activity_segments";

/**
 * The columns {@link seedSessionActivitySegments} writes. `subagent_id` is the
 * load-bearing entry — it is the one added by a LATER migration (0022) than the
 * table itself (0011), so it is the column a table-only schema wait can miss.
 */
const ACTIVITY_SEGMENT_REQUIRED_COLUMNS = [
  "phase",
  "start_ms",
  "end_ms",
  "confidence",
  "evidence_layers",
  "version",
  "work_item_ref",
  "subagent_id",
  "observed_at",
] as const;

/**
 * Seed a session's raw activity tiling while the app is DOWN, so the next
 * launch's real session-detail read projects it — the phase strip renders these
 * spans verbatim and the Activity breakdown derives its per-phase rows from the
 * SAME spans through the shared `@repo/lib` aggregator.
 *
 * The session row must already exist (`seedSessionsList`): segments carry no FK
 * cascade, but the detail read joins through `sessions`. Write no transcript for
 * the session — the boot classifier backfill enumerates transcript FILES, so a
 * transcript-less session is never re-tiled and the seeded rows cannot be
 * overwritten between the seed and the assertion.
 */
export async function seedSessionActivitySegments(
  userDataDir: string,
  sessionId: string,
  segments: readonly ActivitySegmentSeed[],
  options: { classifierVersion?: number; schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForColumnsPresent(
      client,
      ACTIVITY_SEGMENTS_TABLE,
      ACTIVITY_SEGMENT_REQUIRED_COLUMNS,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );
    const observedAt = new Date().toISOString();
    const version = options.classifierVersion ?? 1;
    await client.batch(
      segments.map((segment, index) => ({
        sql: `INSERT INTO session_activity_segments
                (id, session_id, phase, start_ms, end_ms, confidence,
                 evidence_layers, version, work_item_ref, subagent_id, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        args: [
          `${sessionId}-segment-${index}`,
          sessionId,
          segment.phase,
          segment.startMs,
          segment.endMs,
          segment.confidence ?? 1,
          JSON.stringify(segment.evidenceLayers ?? []),
          version,
          observedAt,
        ],
      })),
      "write"
    );
    // Checkpoint so the next launch's fresh connection reads the rows from the
    // main db file rather than a WAL segment this process still owns.
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Block until the activity-segment schema {@link seedSessionActivitySegments}
 * writes is fully migrated. Call this on the FIRST launch, while the migrating
 * db host is still UP — a schema wait only makes progress when some process is
 * applying migrations.
 *
 * `waitForBranchesSchema` is NOT a substitute: its last requirement is
 * `sessions.last_activity_at` (migration 0005), whereas this table arrives in
 * 0011 and its `subagent_id` column only in 0022. On a cold or slow runner the
 * branch wait can therefore return mid-sequence; if the launch is then torn
 * down, {@link seedSessionActivitySegments} has no migration host left to create
 * the columns it polls for and can only spin until its own timeout.
 */
export async function waitForActivitySegmentsSchema(
  userDataDir: string,
  timeoutMs = SEED_SCHEMA_TIMEOUT_MS
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopBusyTimeout(client);
    await waitForColumnsPresent(
      client,
      ACTIVITY_SEGMENTS_TABLE,
      ACTIVITY_SEGMENT_REQUIRED_COLUMNS,
      timeoutMs
    );
  } finally {
    client.close();
  }
}

/**
 * Block until the per-event cost schema is fully migrated before a launched
 * app is stopped and a later offline seed writes canonical spend evidence.
 */
export async function waitForActivityTokenEventsSchema(
  userDataDir: string,
  timeoutMs = SEED_SCHEMA_TIMEOUT_MS
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopBusyTimeout(client);
    await waitForColumnsPresent(
      client,
      TOKEN_EVENTS_TABLE,
      TOKEN_EVENT_REQUIRED_COLUMNS,
      timeoutMs
    );
  } finally {
    client.close();
  }
}

/**
 * The PER-EVENT priced token table. Deliberately NOT `token_usage`: the two are
 * different producers of the same dollars on this screen, and telling them apart
 * is the whole point of the ISS-5128 fixture.
 *
 * - `token_events` prices the activity PHASES. `mapDetail`
 *   (`shared-agent-sessions-api.ts`) calls
 *   `buildActivitySegments(session.activitySegmentRows, session.tokenEvents)`,
 *   and `session.tokenEvents` is `sync-source.ts`'s `SELECT … FROM token_events`
 *   mapped through `mapSyncedTokenEvent`, whose `estimatedCostUsd` is this
 *   table's `cost_usd_estimated`.
 * - `token_usage` prices the SESSION. `mapListItem` sets `estimatedCost` from
 *   `sumTokenUsage(session)`, which sums `tokenUsageByModel[].estimatedCostUsd`
 *   — the `token_usage` rows `pricedTokenUsageBatchItem` (`seed-branches-db.ts`,
 *   via `SessionListSeed.estimatedCost`) writes.
 *
 * Seeding the two INDEPENDENTLY is what makes the panel's Derived mode reachable
 * with a per-phase sum that is strictly less than the session's own cost — the
 * production shape a tiling-only seed cannot produce (with no token events every
 * phase costs $0 and the panel resolves to `CostUnavailable`).
 */
const TOKEN_EVENTS_TABLE = "token_events";

/**
 * The columns {@link seedSessionTokenEvents} writes. `transport_id` is the
 * load-bearing entry — the table lands in `0001_init` while that column arrives
 * only in `0043_iss4881_token_event_provenance`, so it is the column a
 * table-only schema wait can miss.
 */
const TOKEN_EVENT_REQUIRED_COLUMNS = [
  "session_id",
  "transport_id",
  "model",
  "created_at",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_usd_estimated",
] as const;

/** Model for seeded token events; any string is fine (nothing reprices them). */
const SEED_TOKEN_EVENT_MODEL = "seed-model";

/**
 * One already-priced token event. Mirrors the `token_events` row shape the
 * desktop sync source reads, so a seeded event is indistinguishable from a
 * collected one to the detail read.
 */
export type ActivityTokenEventSeed = {
  /** ISO-8601 instant. Binned into the tiling span containing it. */
  createdAt: string;
  /** Already-priced per-event cost in USD — the phase's Cost cell comes from here. */
  costUsd: number;
  /** Uncached input tokens (defaults to 0). */
  inputTokens?: number;
  /** Output tokens (defaults to 0). */
  outputTokens?: number;
};

/**
 * Seed a session's already-priced per-event token rows while the app is DOWN, so
 * the next launch's real session-detail read prices the activity phases from
 * them.
 *
 * Pair with {@link seedSessionActivitySegments}: the tiling supplies the phases
 * and their durations, these events supply the per-phase cost/tokens, and
 * `buildActivitySegments` bins each event into the half-open `[startMs, endMs)`
 * span containing its `createdAt` (an event outside every span accrues to the
 * honest `other` remainder and would add a row).
 *
 * Cache tokens are deliberately left at 0 rather than exposed as options: the
 * boot cost-lane heal (`token-cost-maintenance.ts`) rewrites the component cost
 * columns of any `token_events` row with `cache_read_tokens > 0 OR
 * cache_write_tokens > 0` and a NULL `cache_creation_cost_usd_estimated`, so a
 * cache-bearing seed would invite the app to mutate the fixture between the seed
 * and the assertion. It never touches `cost_usd_estimated`, but keeping the
 * predicate false keeps the fixture provably inert.
 */
export async function seedSessionTokenEvents(
  userDataDir: string,
  sessionId: string,
  events: readonly ActivityTokenEventSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForColumnsPresent(
      client,
      TOKEN_EVENTS_TABLE,
      TOKEN_EVENT_REQUIRED_COLUMNS,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );
    await client.batch(
      events.map((event, index) => ({
        sql: `INSERT INTO token_events
                (session_id, transport_id, model, created_at,
                 input_tokens, output_tokens, cache_read_tokens,
                 cache_write_tokens, cost_usd_estimated)
              VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        args: [
          sessionId,
          `${sessionId}-token-event-${index}`,
          SEED_TOKEN_EVENT_MODEL,
          event.createdAt,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          event.costUsd,
        ],
      })),
      "write"
    );
    // Checkpoint so the next launch's fresh connection reads the rows from the
    // main db file rather than a WAL segment this process still owns.
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
