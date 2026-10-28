import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * ISS-11670: per-migration DDL contract guard for the per-user invites marker on
 * `onboarding_attempts`, and for the backfill that seeds it.
 *
 * This file previously asserted the migration had NO backfill, on the reasoning
 * that NULL was the true answer for every existing row. Operator ruling
 * 2026-09-30 obsoleted that expectation in as many words — "no, onboared users
 * should not get re-prompted" / "Backfill invites sent at or we'll run into #1
 * which we don't want" — so the backfill IS the named mechanism and the old
 * assertion is inverted rather than weakened: the cases below fail if it is
 * absent, and fail if it reaches wider than the ruling's cohort.
 *
 * The scope of the backfill is the part worth guarding. Stamping every row
 * would suppress the invite prompt for new users, which is the defect this
 * ticket exists to remove, pointing the other way.
 *
 * It does NOT read the whole schema.prisma.
 */

const MIGRATION_DIR = "20260930180000_iss11670_per_user_invites_sent_at";
const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    MIGRATION_DIR,
    "migration.sql"
  ),
  "utf8"
);

const ADD_COLUMN_STATEMENT =
  /ALTER TABLE\s+"onboarding_attempts"\s+ADD COLUMN\s+"invites_sent_at"\s+([^;]*);/i;
const BACKFILL_STATEMENT =
  /UPDATE\s+"onboarding_attempts"\s+SET\s+"invites_sent_at"\s*=\s*([^\s]+)\s+WHERE\s+([^;]*);/i;
const NOT_NULL = /NOT NULL/i;
const DEFAULT_CLAUSE = /DEFAULT/i;
const INSERT_STATEMENT =
  /INSERT INTO\s+"onboarding_attempts"\s*\(([^)]*)\)([\s\S]*?);/i;
const EXISTING_USERS_ONLY =
  /u\."created_at"\s*<\s*TIMESTAMP\s+'2026-09-30 18:00:00'/i;
const CURRENT_TIMESTAMP_BOUND = /"created_at"\s*<\s*CURRENT_TIMESTAMP/i;
const SKIPS_USERS_WITH_A_RUN = /NOT EXISTS/i;
const CONFLICT_BACKSTOP = /ON CONFLICT[\s\S]*DO NOTHING/i;
const SETTLED_STATE_PAYLOAD =
  /"phase":"ready".*"history":\["dashboard_available"\].*"organizationEstablished":true/;
const COMPLETED_RUNS_ONLY = /"completed_at"\s+IS NOT NULL/i;
const UNSTAMPED_ROWS_ONLY = /"invites_sent_at"\s+IS NULL/i;
const SQL_COMMENT = /--[^\n]*/g;
const STATEMENT_TERMINATOR = /;/g;

/** The statements, with every explanatory comment stripped. */
function executableSql(): string {
  return MIGRATION_SQL.replace(SQL_COMMENT, "");
}

describe("ISS-11670 per-user invites_sent_at migration", () => {
  it("adds the column to onboarding_attempts as a timestamp", () => {
    const match = MIGRATION_SQL.match(ADD_COLUMN_STATEMENT);

    expect(match).not.toBeNull();
    expect(match?.[1]?.trim()).toBe("TIMESTAMP(3)");
  });

  it("adds it nullably and with no default", () => {
    const statement = MIGRATION_SQL.match(ADD_COLUMN_STATEMENT)?.[1] ?? "";

    // Scoped to the ADD COLUMN statement itself, not the whole file: the header
    // comment says the words "NOT NULL" while explaining why it is not wanted,
    // so a file-wide substring match would assert nothing.
    expect(statement).not.toMatch(NOT_NULL);
    expect(statement).not.toMatch(DEFAULT_CLAUSE);
  });

  it("backfills the marker, and does so in this migration", () => {
    // Operator ruling 2026-09-30: the backfill is what stops an already-
    // onboarded reader being re-prompted. Its absence is the regression.
    expect(executableSql()).toMatch(BACKFILL_STATEMENT);
    expect(executableSql().match(STATEMENT_TERMINATOR)).toHaveLength(3);
  });

  it("stamps only runs that completed, and never rewrites an existing stamp", () => {
    const where = MIGRATION_SQL.match(BACKFILL_STATEMENT)?.[2] ?? "";

    // Both predicates, asserted on the UPDATE's own WHERE rather than the file:
    // the completion scope is what keeps a new user's in-flight run unstamped,
    // and the NULL guard is what makes a re-run idempotent.
    expect(where).toMatch(COMPLETED_RUNS_ONLY);
    expect(where).toMatch(UNSTAMPED_ROWS_ONLY);
  });

  it("stamps the run's own completion time rather than the migration's clock", () => {
    const value = MIGRATION_SQL.match(BACKFILL_STATEMENT)?.[1] ?? "";

    // There is no record of when these users actually sent, so `now()` would
    // assert a send that happened during a migration. The run's own
    // `completed_at` is a real recorded timestamp and the honest upper bound.
    expect(value).toBe('"completed_at"');
  });
});

/*
 * The second cohort, added under operator ruling 2026-09-30: "actually,
 * nevermind - let's do a backfill for existing users to set it; that's the most
 * appropriate." An existing user with no run row has nothing for the `UPDATE`
 * to stamp, so the migration creates the row. What is guarded here is the scope
 * and the payload — a row for the wrong user suppresses the prompt the ticket
 * exists to deliver, and a `state` the restorer rejects would reopen the
 * first-run takeover for every existing user.
 */
describe("ISS-11670 existing-user backfill", () => {
  it("inserts a run row for users who have none", () => {
    expect(executableSql()).toMatch(INSERT_STATEMENT);
  });

  it("scopes it to users who predate the migration, by a literal bound", () => {
    const predicate = MIGRATION_SQL.match(INSERT_STATEMENT)?.[2] ?? "";

    expect(predicate).toMatch(EXISTING_USERS_ONLY);
    // Not `CURRENT_TIMESTAMP`: a deploy applies this after the branch is cut,
    // and a moving bound would stamp — and so stop prompting — users who signed
    // up in that window. The literal errs toward prompting, which is the
    // ticket's direction.
    expect(predicate).not.toMatch(CURRENT_TIMESTAMP_BOUND);
  });

  it("skips any user who already has a run", () => {
    const predicate = MIGRATION_SQL.match(INSERT_STATEMENT)?.[2] ?? "";

    // Both idempotency guards: the anti-join, and the unique as a backstop
    // against a run created concurrently with this statement.
    expect(predicate).toMatch(SKIPS_USERS_WITH_A_RUN);
    expect(predicate).toMatch(CONFLICT_BACKSTOP);
  });

  it("writes the state the read path already reports for these readers", () => {
    const payload = MIGRATION_SQL.match(INSERT_STATEMENT)?.[2] ?? "";

    // `settledOnboardingState`'s own shape. A `ready` phase is not blocking, so
    // the row cannot reopen the takeover; anything the restorer rejects would
    // recover to `Welcome`, which is blocking, and hand every existing user a
    // full-screen first run.
    expect(payload).toMatch(SETTLED_STATE_PAYLOAD);
  });
});
