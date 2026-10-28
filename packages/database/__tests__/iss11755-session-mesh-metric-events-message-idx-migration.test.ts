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
 * ISS-11755/ISS-11812 — the index the Session Mesh insights rollup seeks on when
 * it joins `session_mesh_metric_events` to the delivery cohort.
 *
 * WHY THIS FILE EXISTS. An index changes PLAN CHOICE and never results, so every
 * Mesh suite stays green on a missing, reordered, or wrong-table index, and the
 * Prisma drift check compares the migration against `schema.prisma`, so a
 * matching PAIR of mistakes is green there too. `packages/database/AGENTS.md`
 * requires focused DDL coverage on every new index migration for that reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20261001224500_session_mesh_metric_events_message_idx";

/**
 * A PIN, repeated as a literal rather than derived. `@@index([organizationId,
 * messageId, userId])` spells out to 65 characters, past Postgres's 63-byte
 * limit, and Prisma truncates to 59 characters plus `_idx` while Postgres would
 * truncate the full literal to its first 63 bytes — the two do not agree. This
 * is the name `prisma migrate diff --from-empty --to-schema` emits; a
 * hand-spelled one left `migrate dev` generating drift-repair migrations.
 */
const INDEX = "session_mesh_metric_events_organization_id_message_id_user__idx";

/**
 * The join predicate is `event.organization_id = <org> AND event.message_id =
 * cohort.message_id AND event.user_id = cohort.recipient_user_id`
 * (apps/api/app/session-mesh/service/insights.ts). Order is load-bearing: with
 * `message_id` anywhere but second the planner cannot seek a cohort message and
 * falls back to scanning the organization's whole event history, which is the
 * scan that pushed the rollup past Prisma's 5s transaction budget.
 */
const ORDERED_KEYS = ["organization_id", "message_id", "user_id"];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes the metric events on org, message and user in that order", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("session_mesh_metric_events");
    // `toEqual` on the ordered array, never a contains-check: the same three
    // columns in any other order cannot seek a single cohort message.
    expect(index.keys).toEqual(ORDERED_KEYS);
    expect(index.method).toBe("btree");
  });

  it("is not partial", () => {
    // The rollup reaches any retained event row, so there is no subset to
    // restrict to; a predicate would quietly exclude rows from the seek.
    expect(indexNamed(MIGRATION, INDEX).predicate).toBeNull();
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // session_mesh_metric_events is append-heavy; a plain build holds a SHARE
    // lock that blocks writes to it for the whole build.
    expect(index.concurrently).toBe(true);
    // With CONCURRENTLY a cancelled build leaves a same-named INVALID index.
    // `IF NOT EXISTS` would make the retry no-op over it and the existing P3018
    // recovery would then record the migration as applied — a green deploy with
    // an unusable index (packages/database/AGENTS.md).
    expect(index.ifNotExists).toBe(false);
  });

  it("keeps the file to bare statements Prisma will not wrap in a transaction", () => {
    // Prisma runs each statement outside a transaction ONLY if every statement
    // is bare. A `DO $$ … $$`, `BEGIN`/`COMMIT`, or `DROP INDEX` defeats the
    // splitter, the file is wrapped, and CONCURRENTLY fails with SQLSTATE 25001.
    expect(
      migrationDdl(MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("names an index Postgres will not silently truncate", () => {
    // At 64+ bytes Postgres truncates and the name diverges from Prisma's,
    // which the drift check then reports forever.
    expect(INDEX.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });
});
