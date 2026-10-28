import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

/**
 * ISS-8517: what the two-armed `estimated_cost` repair is allowed to do.
 *
 * This file pins the SQL TEXT. Its sibling
 * `integration/iss8517-backfill-session-detail-estimated-cost.integration.test.ts`
 * executes the same shipped file against real Postgres and asserts the rows it
 * moves; the two are complementary and neither replaces the other. A text pin
 * catches the edit that quietly widens what a statement is willing to write —
 * which is the failure that matters most here, because both writes are
 * irreversible and a wrong predicate is discovered only after production rows
 * already hold the wrong value.
 *
 * The negative pins are the point of the file. Each encodes a ruling that cost
 * real investigation, and each names a way this migration could be "fixed" into
 * a defect:
 *
 *  - SOURCING a cost from `agent_session_token_usage` would reintroduce the
 *    token-only figure ISS-7176 ruled is not a cost source, and that ISS-8517's
 *    own acceptance criteria name as the value no later sync may restore. Arm 2
 *    may PROBE that table for existence — that is how it proves nothing was
 *    measured — but no column of it may be read and no value from it may reach
 *    a `SET`;
 *  - dropping arm 1's `> 0` would let the source's `NOT NULL DEFAULT 0` write a
 *    fabricated `$0` over an unknown, which is the conflation the whole
 *    ISS-7818 family exists to remove;
 *  - dropping either population predicate would let a statement LOWER a real
 *    stored figure;
 *  - splitting an arm's selection from its write would reopen the Read
 *    Committed window that let an uncounted row into the ceiling-bounded set.
 */
const MIGRATION =
  "20260903140000_iss8517_backfill_session_detail_estimated_cost";

const WHITESPACE_G = /\s+/g;
const ROW_DESTRUCTION_RE = /\b(DELETE|TRUNCATE|INSERT)\b/i;
const SCHEMA_CHANGE_RE = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i;
const GROUP_BY_RE = /\bGROUP\s+BY\b/i;
const SUM_CALL_RE = /\bsum\s*\(/i;

/**
 * Every `SET` clause in the file, captured between `SET` and `FROM`.
 *
 * Captured as whole clauses rather than matched per-assignment: a
 * `/SET "col" =/g` scan sees only the FIRST target, because the second
 * assignment in `SET "a" = …, "b" = …` has no `SET` before it — so it reads
 * "one column assigned" for a statement that assigns two. Verified by mutation.
 */
const SET_CLAUSE_G = /SET\s+(.+?)\s+FROM\s/g;

/**
 * ARM 1, whole. Held as ONE constant rather than asserted clause by clause for
 * two reasons: the safety argument is that these conjuncts appear TOGETHER, and
 * separate `toContain` calls would still pass if a future edit split them across
 * two statements — which is precisely the split that reopens the Read Committed
 * window. The `MATERIALIZED` candidate CTE and the data-modifying CTE that
 * writes it are ONE statement and therefore ONE snapshot; that is the fix for
 * the preflight/UPDATE race, and it is what this constant pins.
 *
 * The UPDATE re-states the population predicate against its own target on
 * purpose. Read Committed re-evaluates that clause against a row a concurrent
 * writer has just changed, so a session that acquired a real figure between
 * snapshot and write keeps it.
 */
const ARM_1_STATEMENT =
  "WITH candidates AS MATERIALIZED ( " +
  'SELECT s."artifact_id", r."estimated_cost" AS repaired_cost ' +
  'FROM "session_detail" AS s ' +
  'JOIN "agent_session_usage_rollups" AS r ' +
  'ON r."artifact_id" = s."artifact_id" ' +
  'WHERE r."estimated_cost" > 0 ' +
  'AND (s."estimated_cost" IS NULL OR s."estimated_cost" = 0) ' +
  'AND s."estimated_cost" IS DISTINCT FROM r."estimated_cost" ' +
  "LIMIT max_inline_rows + 1 " +
  "), repaired AS ( " +
  'UPDATE "session_detail" AS s ' +
  'SET "estimated_cost" = c."repaired_cost" ' +
  "FROM candidates AS c " +
  'WHERE s."artifact_id" = c."artifact_id" ' +
  'AND (s."estimated_cost" IS NULL OR s."estimated_cost" = 0) ' +
  'AND s."estimated_cost" IS DISTINCT FROM c."repaired_cost" ' +
  'RETURNING s."artifact_id" ' +
  ") " +
  "SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM repaired) " +
  "INTO priced_selected, priced_written;";

/**
 * ARM 2, whole — the fabricated-zero clear.
 *
 * Its two `NOT EXISTS` probes are the entire claim that nothing measured this
 * session: no per-model token row, and no rollup carrying either a positive
 * cost OR a positive token count. Dropping either probe would start writing
 * NULL over a session something HAD measured, which is the mirror image of the
 * fabricated `$0` this arm exists to remove.
 *
 * `= 0` and not `IS NULL OR = 0`: a row that is already NULL is already saying
 * "unknown", so touching it would be a write with no meaning. It is also half
 * of why the two arms are disjoint — the other half being that a row arm 1
 * repairs has a positive rollup, which fails the second probe.
 */
const ARM_2_STATEMENT =
  "WITH candidates AS MATERIALIZED ( " +
  'SELECT s."artifact_id" ' +
  'FROM "session_detail" AS s ' +
  'WHERE s."estimated_cost" = 0 ' +
  "AND NOT EXISTS ( " +
  'SELECT 1 FROM "agent_session_token_usage" AS u ' +
  'WHERE u."agent_session_id" = s."artifact_id" ' +
  ") " +
  "AND NOT EXISTS ( " +
  'SELECT 1 FROM "agent_session_usage_rollups" AS r ' +
  'WHERE r."artifact_id" = s."artifact_id" ' +
  'AND (r."estimated_cost" > 0 ' +
  'OR r."input_tokens" + r."output_tokens" ' +
  '+ r."cache_read_tokens" + r."cache_write_tokens" > 0) ' +
  ") " +
  "LIMIT max_inline_rows + 1 " +
  "), cleared AS ( " +
  'UPDATE "session_detail" AS s ' +
  'SET "estimated_cost" = NULL ' +
  "FROM candidates AS c " +
  'WHERE s."artifact_id" = c."artifact_id" ' +
  'AND s."estimated_cost" = 0 ' +
  'RETURNING s."artifact_id" ' +
  ") " +
  "SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM cleared) " +
  "INTO unknown_selected, unknown_written;";

/** The one place arm 2 is allowed to name the per-model token table. */
const TOKEN_USAGE_EXISTENCE_PROBE =
  "NOT EXISTS ( " +
  'SELECT 1 FROM "agent_session_token_usage" AS u ' +
  'WHERE u."agent_session_id" = s."artifact_id" ' +
  ")";

const TOKEN_USAGE_TABLE = '"agent_session_token_usage"';

/** Each arm's guard, in file order. */
const ARM_1_GUARD = "IF priced_selected > max_inline_rows THEN";
const ARM_2_GUARD = "IF unknown_selected > max_inline_rows THEN";

/**
 * The `USING HINT` string literals, taken from the RAW file rather than from
 * {@link migrationDdl}.
 *
 * That helper strips `--` comments, and the hints necessarily contain
 * `--rolled-back`, so the flattened view truncates them mid-sentence. Postgres
 * is unaffected — `--` inside a quoted literal is not a comment — but an
 * assertion made against the stripped text would be asserting about a string the
 * database never sees.
 *
 * Scoped to the literals, NOT to the whole raw file: this migration's own header
 * spells out the same recovery path in prose, so a raw-file `toContain` would
 * pass even if a hint itself lost it. `''` is SQL's escape for a quote inside a
 * literal, hence the alternation.
 */
const USING_HINT_LITERAL_G = /USING HINT =\s*'((?:[^']|'')*)'/g;

/**
 * The `RAISE EXCEPTION` message literals — where each arm's recovery path has to
 * live.
 *
 * Not the hint: `packages/database/scripts/migrate-deploy-recovery.ts`
 * classifies P0001 with `/Database error:\s*(?:ERROR:\s*)?([^\n]+)/`, the first
 * LINE of the message, and prints exactly that as `Invariant:`. Postgres carries
 * HINT as a separate error field, so a hint-only remedy is dropped before an
 * operator sees it — which is precisely when they need it.
 */
const RAISE_MESSAGE_LITERAL_G = /RAISE EXCEPTION\s+'((?:[^']|'')*)'/g;

function rawSql(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );
}

function sqlLiterals(pattern: RegExp, label: string): string[] {
  const found = [...rawSql().matchAll(pattern)].map((match) =>
    match[1].replaceAll("''", "'")
  );
  if (found.length === 0) {
    throw new Error(`${MIGRATION}: no ${label} literal found`);
  }
  return found;
}

function flatDdl(): string {
  return migrationDdl(MIGRATION).replace(WHITESPACE_G, " ");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe(`${MIGRATION} arm 1: copy the priced rollup`, () => {
  // The whole safety case in one assertion. Every conjunct is load-bearing: the
  // PK-to-PK join is what makes fan-out impossible, `> 0` is what keeps a
  // fabricated zero out, the population predicate is what stops the statement
  // lowering a figure that is already real, and the single-statement shape is
  // what keeps the selected set and the written set the same set.
  it("repairs positive-only, from the PK-joined rollup, over unknowns only", () => {
    expect(flatDdl()).toContain(ARM_1_STATEMENT);
  });

  // `artifact_id` is the PRIMARY KEY of both tables, so 1:1 is structural. An
  // aggregate would mean the source had been changed to something that is not,
  // which is exactly the rewrite this file exists to catch.
  it("cannot fan out: no aggregate over the source, no grouping", () => {
    const flat = flatDdl();
    expect(flat).not.toMatch(GROUP_BY_RE);
    expect(flat).not.toMatch(SUM_CALL_RE);
  });
});

describe(`${MIGRATION} arm 2: clear the fabricated zero`, () => {
  // Mirrors `sessionEstimatedCostSql` in apps/desktop: NULL when nothing was
  // measured, and a real $0 from priced rows stays 0. The two `NOT EXISTS`
  // probes ARE that rule; dropping either would start writing NULL over a
  // session something had actually measured.
  it("clears only the zeros no source can vouch for", () => {
    expect(flatDdl()).toContain(ARM_2_STATEMENT);
  });

  // ISS-7176 (2026-08-20) ruled token_usage is NOT a cost source, and
  // `persistSessionAnalytics` — not `resolveTokenRollupColumns` — is the writer
  // that wins on this column. Arm 2 reads that table as EVIDENCE (does a row
  // exist at all?) and never as a VALUE: one appearance, inside the existence
  // probe, with no column of it read anywhere. `u."estimated_cost"` appearing
  // would be the exact reversal this pin exists to prevent.
  it("probes the per-model token table for existence and never reads a value from it", () => {
    const flat = flatDdl();
    expect(flat).toContain(TOKEN_USAGE_EXISTENCE_PROBE);
    expect(occurrences(flat, TOKEN_USAGE_TABLE)).toBe(1);
    expect(flat).not.toContain('u."estimated_cost"');
    expect(flat).not.toContain('u."input_tokens"');
  });

  // Disjointness, stated as text. A row arm 1 wrote holds a positive value and
  // has a rollup with `estimated_cost > 0`, so it fails BOTH `s."estimated_cost"
  // = 0` and the second probe. A row already NULL fails `= 0`. Widening this to
  // `IS NULL OR = 0` would make arm 2 rewrite rows that already say "unknown".
  it("touches only an exact stored zero, never a NULL and never arm 1's output", () => {
    expect(flatDdl()).toContain(
      'FROM "session_detail" AS s WHERE s."estimated_cost" = 0 AND NOT EXISTS'
    );
  });
});

describe(`${MIGRATION} writes`, () => {
  // `updated_at` is a Prisma `@updatedAt` column with no database default and no
  // trigger, so a raw UPDATE that omits it leaves it alone — which is what this
  // migration wants, because that value is the Sessions list's "Updated" column
  // and its `sortBy=updated` key. Bumping it would jerk every repaired session
  // to the top of that sort for a change no user made. Exactly two SET clauses
  // in the file, each assigning exactly one column.
  it("assigns estimated_cost and nothing else, in both arms", () => {
    const clauses = [...flatDdl().matchAll(SET_CLAUSE_G)].map(
      (match) => match[1]
    );
    expect(clauses).toEqual([
      '"estimated_cost" = c."repaired_cost"',
      '"estimated_cost" = NULL',
    ]);
  });

  // A data repair, not a schema change. `schema.prisma` is untouched by this
  // ticket, so any DDL here would be drift the ORM does not know about.
  it("changes no schema", () => {
    expect(flatDdl()).not.toMatch(SCHEMA_CHANGE_RE);
  });

  // Each arm may only ever move one column on rows that already exist.
  it("deletes, truncates and inserts nothing", () => {
    expect(flatDdl()).not.toMatch(ROW_DESTRUCTION_RE);
  });
});

describe(`${MIGRATION} inline ceiling`, () => {
  // `prisma migrate deploy` applies a file, not a loop, so every rewritten row
  // holds its row lock until the migration commits. The ceiling is the number
  // that keeps that bounded; measured at ~3,450 rows/s. ONE declaration, shared
  // by both arms, so the two can never drift apart.
  it("declares one ceiling and guards both arms against it", () => {
    const flat = flatDdl();
    expect(occurrences(flat, "max_inline_rows CONSTANT bigint := 250000")).toBe(
      1
    );
    expect(occurrences(flat, "RAISE EXCEPTION")).toBe(2);
    expect(flat).toContain(ARM_1_GUARD);
    expect(flat).toContain(ARM_2_GUARD);
  });

  // The `LIMIT` is a HARD CAP on rows touched, not merely on a number that gets
  // compared: it lives in the candidate CTE that the write consumes, so a
  // population of ten million still puts at most `max_inline_rows + 1` rows
  // under lock. One per arm.
  it("caps each arm's selected set at the ceiling plus one", () => {
    expect(occurrences(flatDdl(), "LIMIT max_inline_rows + 1")).toBe(2);
  });

  // Order within the file. Arm 1's guard raises before arm 2 runs at all, so a
  // deploy that trips the first ceiling never reaches the second write — and
  // `RAISE EXCEPTION` aborts the transaction, so neither arm's rows commit.
  it("aborts on arm 1's ceiling before arm 2 runs", () => {
    const flat = flatDdl();
    expect(flat.indexOf(ARM_1_STATEMENT)).toBeLessThan(
      flat.indexOf(ARM_1_GUARD)
    );
    expect(flat.indexOf(ARM_1_GUARD)).toBeLessThan(
      flat.indexOf(ARM_2_STATEMENT)
    );
    expect(flat.indexOf(ARM_2_STATEMENT)).toBeLessThan(
      flat.indexOf(ARM_2_GUARD)
    );
  });

  // A migration that fails without telling an operator how to recover is a
  // migration that blocks every later deploy until someone reverse-engineers
  // the remedy. Both messages name all three steps, and each names its own arm's
  // drain — the two drains select different populations, so running the wrong
  // one never clears the ceiling the re-run has to get under.
  it("names the operator recovery path where the P0001 handler will show it", () => {
    const messages = sqlLiterals(RAISE_MESSAGE_LITERAL_G, "RAISE EXCEPTION");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toContain(
        `prisma migrate resolve --rolled-back ${MIGRATION}`
      );
      expect(message).toContain("batched drain");
      expect(message).toContain("re-run the deploy");
      // One line, or the first-line-only parse truncates the remedy anyway.
      expect(message).not.toContain("\n");
    }
    expect(messages[0]).toContain("arm 1 batched drain");
    expect(messages[1]).toContain("arm 2 batched drain");
  });

  // The hint is where the psql reader learns that the abort committed nothing —
  // the property that makes a fired ceiling a failed deploy rather than a
  // half-applied repair.
  it("still carries a hint for the psql reader", () => {
    const hints = sqlLiterals(USING_HINT_LITERAL_G, "USING HINT");
    expect(hints).toHaveLength(2);
    for (const hint of hints) {
      expect(hint).toContain("stands alone");
      expect(hint).toContain("Nothing it wrote was committed");
    }
  });
});

describe(`${MIGRATION} blast radius`, () => {
  // NOTHING RUNS OUTSIDE THE GUARDED BLOCK. This is the real contract, and it is
  // not the one an earlier draft claimed: the single block is NOT what lets the
  // integration test execute the shipped file (node-pg runs a multi-statement
  // string over the simple query protocol and a split file would abort on RAISE
  // identically — verified, not assumed). What the shape does buy is that every
  // statement in this file sits INSIDE the block the ceiling protects. A bare
  // `UPDATE` appended after the block would run unguarded, at any row count, and
  // no other assertion here would notice.
  it("puts no statement outside the guarded block", () => {
    const statements = flatDdl()
      .split("$iss8517$")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // "DO", the block body, and the trailing ";" — no fourth fragment, which is
    // what a second top-level statement would add.
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("DO");
    expect(statements[2]).toBe(";");
  });
});
