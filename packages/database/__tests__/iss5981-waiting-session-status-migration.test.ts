import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260817120000_iss5981_backfill_waiting_session_status";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);

const LINE_COMMENT_RE = /^\s*--.*$/gm;
const WHITESPACE_RUN_RE = /\s+/g;
/**
 * A clock reading. Nothing in this migration may invent a timestamp.
 */
const FABRICATED_CLOCK_RE =
  /\bnow\s*\(|\bcurrent_timestamp\b|\blocaltimestamp\b|\bstatement_timestamp\s*\(|\bclock_timestamp\s*\(/i;
/**
 * Every status literal the migration WRITES: the plain assignment plus both arms
 * of the terminal `CASE`. Deliberately does not match the `a."status" = '…'`
 * predicate, which reads the retired spelling rather than writing one.
 */
const WRITTEN_STATUS_LITERAL_RE = /(?:SET "status" = |THEN |ELSE )'([a-z_]+)'/g;

describe("ISS-5981 stored-`waiting` backfill migration", () => {
  it("collapses a STILL-RUNNING row onto the lifecycle value the canonical fold maps `waiting` to, and only where an anchor already carries the bit", async () => {
    const [liveUpdate] = await readStatements();

    expect(liveUpdate).toContain('UPDATE "artifacts"');
    expect(liveUpdate).toContain(`SET "status" = '${SESSION_STATUS.ACTIVE}'`);
    expect(liveUpdate).toContain("AND a.\"status\" = 'waiting'");
    expect(liveUpdate).toContain('AND sd."session_ended_at" IS NULL');
    expect(liveUpdate).toContain('AND sd."awaiting_input_since" IS NOT NULL');
  });

  /**
   * An ended run written `active` is read three incompatible ways:
   * `projectDisplayedSessionStatus` badges it Active/Stale,
   * `deriveAgentSessionFallbackState` calls the same row Completed, and
   * `resolveSessionDurationWindow` treats `active` as Running and measures the
   * duration to `now()` forever. The terminal value is resolved from the row's
   * own `ends_with_error`, the same column and the same split the stale-session
   * reaper already uses to declare a run over.
   */
  it("classifies an ENDED row terminal from its own persisted verdict, never `active`", async () => {
    const [, endedUpdate] = await readStatements();

    expect(endedUpdate).toContain('AND sd."session_ended_at" IS NOT NULL');
    expect(endedUpdate).toContain(
      `WHEN sd."ends_with_error" IS TRUE THEN '${SESSION_STATUS.ERROR}' ELSE '${SESSION_STATUS.INACTIVE}'`
    );
    expect(endedUpdate).not.toContain(
      `SET "status" = '${SESSION_STATUS.ACTIVE}'`
    );
  });

  it("writes only lifecycle values — no fourth session status is introduced", async () => {
    const written = (await readStatements()).flatMap((statement) => [
      ...statement.matchAll(WRITTEN_STATUS_LITERAL_RE),
    ]);

    expect(written.length).toBeGreaterThan(0);
    for (const [, value] of written) {
      expect(Object.values(SESSION_STATUS)).toContain(value);
    }
  });

  /**
   * The whole point of the review that produced this shape: `last_activity_at`
   * and `session_started_at` record when a session was ALIVE or BEGAN, never
   * when it ASKED for input. Persisting either as the anchor would make the
   * elapsed-waiting display present a proxy as an exact fact. The strongest
   * statement of that is not "no `now()`" but "no write to the column at all".
   */
  it("writes no awaiting-input anchor at all, so no timestamp can be synthesized for a row that has none", async () => {
    for (const statement of await readStatements()) {
      expect(statement).not.toContain('"awaiting_input_since" =');
      expect(statement).not.toContain('SET "awaiting_input_since"');
    }
  });

  it("invents no clock reading", async () => {
    for (const statement of await readStatements()) {
      expect(FABRICATED_CLOCK_RE.test(statement)).toBe(false);
    }
  });

  it("writes no `updated_at`, so historical sessions keep their place in the recently-updated views", async () => {
    for (const statement of await readStatements()) {
      expect(statement).not.toContain('"updated_at" =');
    }
  });

  it.each([
    ["live", 0],
    ["ended", 1],
  ])(
    "scopes the %s arm to SESSION artifacts, so another subtype's identically-spelled status is untouched",
    async (_label, index) => {
      const statements = await readStatements();

      expect(statements[index]).toContain(`a."type" = 'SESSION'`);
    }
  );

  it.each([
    ["live", 0],
    ["ended", 1],
  ])(
    "correlates the %s arm to the session row it is judging, so the UPDATE ... FROM is not a cross product",
    async (_label, index) => {
      const statements = await readStatements();

      expect(statements[index]).toContain('sd."artifact_id" = a."id"');
    }
  );

  it("writes no new `waiting` spelling anywhere", async () => {
    for (const statement of await readStatements()) {
      expect(statement).not.toContain("SET \"status\" = 'waiting'");
    }
  });

  it("is the whole migration — two statements, no schema change", async () => {
    const statements = await readStatements();

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.startsWith("UPDATE ")).toBe(true);
    }
  });
});

/**
 * The migration's executable statements, comment-stripped and whitespace-
 * normalized so an assertion cannot be satisfied by the surrounding prose —
 * which necessarily spells out `waiting`, `active`, and the column names it is
 * explaining.
 */
async function readStatements(): Promise<string[]> {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  return sql
    .replace(LINE_COMMENT_RE, "")
    .split(";")
    .map((statement) => statement.replace(WHITESPACE_RUN_RE, " ").trim())
    .filter((statement) => statement.length > 0);
}
