/**
 * ISS-5761: direct-SQLite seeding of ALREADY-SPLIT per-event token costs, so a
 * desktop E2E can dictate a session's per-bucket `cIn`/`cOut`/`cCache` exactly.
 *
 * Its own module rather than another concern piled onto `seed-activity-segments.ts`
 * — that file is already past the size smell threshold and owns a different
 * table's row shape (the ISS-4896 precedent in its own header). The shared
 * connection/schema-wait substrate lives in `desktop-seed-core.ts`.
 *
 * ## Why the existing `seedSessionTokenEvents` cannot be used here
 *
 * That seeder writes only the ROLLUP `cost_usd_estimated` and leaves the four
 * component columns NULL. `buildTraceActivityFields`
 * (apps/desktop/src/main/database/session-trace.ts) never reads the rollup: it
 * reads the four components, and when ALL FOUR are null it falls back to
 * `estimateTokenCost({ model, ... })`. The existing seeder's `"seed-model"` has
 * no pricing entry, so that fallback yields nothing and every bucket comes out
 * `cIn/cOut/cCache = 0` — a strip whose rail prints nothing, for the wrong
 * reason. A density spec seeded that way would pass while asserting nothing.
 *
 * Writing the components is also what makes the fixture INERT: with them
 * non-null the fallback branch is never taken, so the seeded money is the
 * rendered money and no pricing table sits between the two.
 *
 * ## The two boot-heal predicates this fixture must stay clear of
 *
 * Both live in `apps/desktop/src/main/database/token-cost-maintenance.ts`, and
 * both run at launch — i.e. BETWEEN the seed and the assertion. A fixture that
 * matches either would be rewritten by the app under test:
 *
 * - `healCacheCostSplit` claims rows where `cost_usd_estimated IS NOT NULL AND
 *   (cache_read_tokens > 0 OR cache_write_tokens > 0) AND
 *   cache_creation_cost_usd_estimated IS NULL`. Both cache TOKEN counts are
 *   therefore pinned at 0 and not exposed as options. Cache COST still works —
 *   it comes from the cost columns, which is the whole point of this seeder —
 *   so nothing is lost by holding the token counts down.
 * - the reprice lane claims rows `WHERE cost_usd_estimated IS NULL`, so the
 *   rollup is written as the sum of the components rather than left null. It is
 *   not read by the bucket build; it exists purely to keep this predicate false.
 */

import {
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForColumnsPresent,
} from "./desktop-seed-core";

const TOKEN_EVENTS_TABLE = "token_events";

/**
 * The columns {@link seedPricedTokenEvents} writes.
 *
 * `transport_id` is the load-bearing entry for the schema WAIT — the table lands
 * in `0001_init` while that column arrives only in
 * `0043_iss4881_token_event_provenance`, so a table-only wait can race it. The
 * four `*_cost_usd_estimated` components ship with the table itself.
 */
const PRICED_TOKEN_EVENT_REQUIRED_COLUMNS = [
  "session_id",
  "transport_id",
  "model",
  "created_at",
  "cost_usd_estimated",
  "input_cost_usd_estimated",
  "output_cost_usd_estimated",
  "cache_read_cost_usd_estimated",
  "cache_creation_cost_usd_estimated",
] as const;

/**
 * Model string for seeded priced events. Any value is fine BECAUSE the component
 * costs are non-null: `buildTraceActivityFields` only consults the model when it
 * has to price the row itself, and this seeder guarantees it never does.
 *
 * It does still reach the render — the bucket tooltip's per-model table keys off
 * it — so it is spelled as something a reader of a failing screenshot will
 * recognise as fixture rather than as a real harness model.
 */
const SEED_PRICED_MODEL = "seed-priced-model";

/** One already-split token event: the exact money one bucket will report. */
export type PricedTokenEventSeed = {
  /** ISO-8601 instant. Binned into the bucket whose half-open span contains it. */
  createdAt: string;
  /** USD attributed to uncached input — lands in the bucket's `cIn`. */
  inputCostUsd: number;
  /** USD attributed to output — lands in the bucket's `cOut`. */
  outputCostUsd: number;
  /** USD attributed to cache reads — lands in the bucket's `cCache`. */
  cacheReadCostUsd: number;
  /** USD attributed to cache creation — also lands in the bucket's `cCache`. */
  cacheCreationCostUsd: number;
};

/**
 * Seed a session's already-priced token rows while the app is DOWN, so the next
 * launch's real local session-detail read projects them into activity buckets.
 *
 * There is no `activity_buckets` column: the buckets are DERIVED at read time
 * from the activity extent of these rows (plus any timeline rows), so the
 * spacing of `createdAt` across the corpus is what decides the COLUMN COUNT and
 * these costs are what decide each column's height and label.
 */
export async function seedPricedTokenEvents(
  userDataDir: string,
  sessionId: string,
  events: readonly PricedTokenEventSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForColumnsPresent(
      client,
      TOKEN_EVENTS_TABLE,
      PRICED_TOKEN_EVENT_REQUIRED_COLUMNS,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );
    await client.batch(
      events.map((event, index) => ({
        sql: `INSERT INTO token_events
                (session_id, transport_id, model, created_at,
                 input_tokens, output_tokens, cache_read_tokens,
                 cache_write_tokens, cost_usd_estimated,
                 input_cost_usd_estimated, output_cost_usd_estimated,
                 cache_read_cost_usd_estimated, cache_creation_cost_usd_estimated)
              VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)`,
        args: [
          sessionId,
          `${sessionId}-priced-token-event-${index}`,
          SEED_PRICED_MODEL,
          event.createdAt,
          event.inputCostUsd +
            event.outputCostUsd +
            event.cacheReadCostUsd +
            event.cacheCreationCostUsd,
          event.inputCostUsd,
          event.outputCostUsd,
          event.cacheReadCostUsd,
          event.cacheCreationCostUsd,
        ],
      })),
      "write"
    );
    // Checkpoint so the next launch's fresh connection reads these rows from the
    // main db file rather than from a WAL segment this process still owns.
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
