import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

/**
 * ISS-8897 / ISS-8896 — the presence clock and the drain lease.
 *
 * WHY THIS FILE EXISTS. Both columns are NULLABLE with no default, so Prisma's
 * drift check is satisfied by the `ALTER TABLE` lines alone and every functional
 * suite stays green without the BACKFILL — which is the one statement here whose
 * absence is a production incident rather than a test failure.
 *
 * Left out, `presence_at` ships NULL for the entire existing fleet. The idle
 * drain reads NULL as "the relay presence trigger has never covered this
 * target" and measures silence from `created_at`, which is correct for a row
 * created after the migration and catastrophic for one created weeks before it:
 * every such target crosses the 24h give-up horizon on the first tick after
 * deploy, so the sweep abandons exactly the recently-disconnected desktops it
 * exists to serve until each one reconnects. Nothing else in the repo fails
 * when that statement is missing.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION = "20260911130000_iss8897_presence_clock_and_drain_lease";

/**
 * Repeated as literals rather than derived from the schema, deliberately. These
 * are PINS: a rename has to change this file too, so it becomes a decision
 * somebody makes rather than one that rides along silently.
 */
const PRESENCE_COLUMN = "presence_at";
const LEASE_COLUMN = "command_drain_lease_until";
const SOURCE_COLUMN = "last_seen_at";

const WHITESPACE_G = /\s+/g;

/** The column modifiers this migration must NOT carry, and the DDL it must not emit. */
const ADD_COLUMN_NOT_NULL_RE = /ADD COLUMN[^;]*NOT NULL/i;
const ADD_COLUMN_DEFAULT_RE = /ADD COLUMN[^;]*DEFAULT/i;
const DROP_COLUMN_RE = /DROP COLUMN/i;
const RENAME_RE = /RENAME/i;
const ALTER_LAST_SEEN_AT_RE = /ALTER COLUMN "last_seen_at"/i;

/**
 * The migration's SQL with runs of whitespace collapsed, so an assertion can
 * name a multi-line statement as the single string it reads as. `migrationDdl`
 * has already stripped the line comments, which matters here because this
 * migration's prose names both columns and a substring assertion a comment
 * could satisfy would prove nothing.
 */
function flatStatements(): string {
  return migrationDdl(MIGRATION).replace(WHITESPACE_G, " ").trim();
}

describe(`${MIGRATION} migration DDL`, () => {
  it("adds both columns nullable, with no default", () => {
    // NULLABLE is the contract, not an oversight. A NOT NULL DEFAULT now() on
    // `presence_at` would assert a presence frame that never arrived, and a
    // NOT NULL DEFAULT epoch would strand the whole fleet past the give-up
    // horizon — so the column has to be able to say "unknown" and the drain has
    // to resolve that itself.
    const ddl = flatStatements();

    expect(ddl).toContain(
      `ALTER TABLE "compute_targets" ADD COLUMN "${PRESENCE_COLUMN}" TIMESTAMP(3);`
    );
    expect(ddl).toContain(
      `ALTER TABLE "compute_targets" ADD COLUMN "${LEASE_COLUMN}" TIMESTAMP(3);`
    );
    expect(ddl).not.toMatch(ADD_COLUMN_NOT_NULL_RE);
    expect(ddl).not.toMatch(ADD_COLUMN_DEFAULT_RE);
  });

  it("seeds the presence clock from last_seen_at, so the existing fleet is not abandoned on deploy", () => {
    // THE STATEMENT NOTHING ELSE FAILS WITHOUT. `last_seen_at` is a superset of
    // presence, so seeding from it is an upper bound on the truth rather than a
    // claim of presence that could not have happened, and it decays to the real
    // value on the connected fleet's next heartbeat.
    expect(flatStatements()).toContain(
      `UPDATE "compute_targets" SET "${PRESENCE_COLUMN}" = "${SOURCE_COLUMN}";`
    );
  });

  it("does not touch last_seen_at itself", () => {
    // The positive sibling of the seed above, and the whole point of the split:
    // `presence_at` is a NEW reader's clock. Redefining, renaming or dropping
    // `last_seen_at` would silently change every existing consumer — the stale
    // -offline sweep, the ingestion-health sampler, the ack-timeout split.
    const ddl = flatStatements();

    expect(ddl).not.toMatch(DROP_COLUMN_RE);
    expect(ddl).not.toMatch(RENAME_RE);
    expect(ddl).not.toMatch(ALTER_LAST_SEEN_AT_RE);
  });
});
