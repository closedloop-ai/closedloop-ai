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
 * ISS-12776 — the covering index behind the by-type and by-tool insights
 * bucket reads. An index changes plan choice, never results, so no value test
 * fails when this DDL is wrong; the plan guard is
 * `apps/api/app/insights/service/iss12776-event-bucket-plan.integration.test.ts`.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME =
  "20261021150000_iss12776_agent_session_events_covering_index";

/** A literal pin: renaming the index has to change this file too. */
const INDEX_NAME = "agent_session_events_session_time_cover_idx";

/**
 * The first two keys are the per-session range the reads probe; the last two
 * are the columns they group by. A different order still holds the same four
 * columns, so the assertion is on the ordered array.
 */
const ORDERED_KEYS = [
  "agent_session_id",
  "event_created_at",
  "event_type",
  "tool_name",
];

describe(`${MIGRATION_NAME} migration DDL`, () => {
  it("creates exactly one index", () => {
    expect(
      migrationDdl(MIGRATION_NAME).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION_NAME)).toHaveLength(1);
  });

  it("covers the per-session event range with the grouped columns", () => {
    const index = indexNamed(MIGRATION_NAME, INDEX_NAME);

    expect(index.table).toBe("agent_session_events");
    expect(index.keys).toEqual(ORDERED_KEYS);
    expect(index.method).toBe("btree");
    expect(index.predicate).toBeNull();
  });

  it("builds CONCURRENTLY without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION_NAME, INDEX_NAME);

    // A plain build blocks every session-event write for its duration.
    expect(index.concurrently).toBe(true);
    // IF NOT EXISTS would no-op over an INVALID remnant of a cancelled build
    // and record the migration as applied with no usable index.
    expect(index.ifNotExists).toBe(false);
  });

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    expect(
      migrationDdl(MIGRATION_NAME).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("keeps the index name inside Postgres' identifier limit", () => {
    expect(INDEX_NAME.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });
});
