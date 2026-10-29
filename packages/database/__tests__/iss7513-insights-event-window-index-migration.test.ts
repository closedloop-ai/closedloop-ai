import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseIndexes,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-7513 — the time-leading index on `agent_session_events` that backs the
 * four windowed reads behind the dashboard's utilization and agents sections
 * (`countEvents`, `fetchEventTypeBuckets`, `fetchToolUsageBuckets`,
 * `fetchEventVolume`).
 *
 * WHY THIS FILE EXISTS AT ALL (#5818 review, whitlockk and codex). Nothing else in
 * the repo fails when this DDL is wrong. The event-query integration suite
 * states outright that it does not depend on this index — correctly, because an
 * index changes only PLAN CHOICE, never results — so every one of those tests
 * stays green if this migration builds the wrong index, indexes the wrong
 * table, reverses the key order, or loses `CONCURRENTLY`. The Prisma drift check
 * compares the migration against `schema.prisma`, so a matching pair of MISTAKES
 * is green there too. `packages/database/AGENTS.md` requires focused DDL
 * coverage for every new index migration for exactly this reason.
 *
 * The regression each assertion below actually catches is named at the
 * assertion, not summarized here.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260823140000_iss7513_insights_event_window_index";

/**
 * Repeated as a literal rather than derived, deliberately. This is a PIN: the
 * point is that changing the migration's index name has to change this file
 * too, so a rename is a decision somebody makes rather than one that rides
 * along silently.
 */
const INDEX_NAME = "agent_session_events_event_created_at_agent_session_id_idx";

const TABLE = "agent_session_events";

/**
 * Order is the whole point of the migration. `event_created_at` LEADS because
 * every one of the four reads filters `event_created_at BETWEEN start AND end`
 * and then joins out for the org scope; the pre-existing
 * `(agent_session_id, event_created_at)` index is session-leading and could only
 * be used by looping one probe per session.
 */
const ORDERED_KEYS = ["event_created_at", "agent_session_id"];

const ddl = () => migrationDdl(MIGRATION_NAME);

describe(`${MIGRATION_NAME} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(ddl().match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(1);
    expect(parseIndexes(MIGRATION_NAME)).toHaveLength(1);
  });

  it("indexes the event window on the right table, time-leading", () => {
    const index = indexNamed(MIGRATION_NAME, INDEX_NAME);

    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered array, never a contains-check: an index on
    // (agent_session_id, event_created_at) holds exactly the same two columns
    // and is the SESSION-leading index this migration exists to stop relying on.
    // A membership assertion would accept it.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what answers a BETWEEN range scan. A hash or GIN index here
    // would still be a valid index, would pass a name-and-columns check, and
    // would silently fail to serve the window predicate.
    expect(index.method).toBe("btree");
  });

  it("builds CONCURRENTLY so the apply takes no write lock", () => {
    // A plain `CREATE INDEX` produces an IDENTICAL index, passes the Prisma
    // drift check, and passes every other assertion in this file. It just holds
    // a SHARE lock on agent_session_events for the whole build and blocks every
    // session-event write until it finishes — which is what got FEA-3638's
    // first attempt reverted in production.
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).concurrently).toBe(true);
  });

  it("omits IF NOT EXISTS so a retry after a cancelled build fails closed", () => {
    // The property the last commit on this branch added, pinned so it cannot be
    // undone by a later "make the migration idempotent" edit. A cancelled or
    // crashed CONCURRENTLY build leaves a same-named INVALID index that Postgres
    // ignores for planning; with IF NOT EXISTS the retry would no-op over it and
    // record the migration as APPLIED while the index stays permanently
    // unusable — a green deploy with no index. Without the clause the retry
    // errors and an operator drops the remnant first.
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).ifNotExists).toBe(false);
  });

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Prisma
    // splits a migration per statement UNLESS one carries dollar-quoting or
    // embedded semicolons, in which case it wraps the whole file and the build
    // fails with SQLSTATE 25001. Comments are stripped first — this migration's
    // header legitimately DESCRIBES every one of these constructs while telling
    // the next author not to add them.
    expect(ddl().match(TRANSACTION_WRAP_TRIGGER_G)).toBeNull();
  });

  it("keeps the index name inside Postgres' identifier limit", () => {
    // A name past 63 chars is truncated SILENTLY, and the truncated form is
    // what Prisma's drift check would then disagree with.
    expect(INDEX_NAME.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).name).toBe(INDEX_NAME);
  });
});
