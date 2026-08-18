/**
 * @file session-terminal-end-advance.test.ts
 * @description ISS-5182 (review thread 3): a terminal session's `ended_at` is
 * frozen against observed activity, but NOT against its own source.
 *
 * ISS-5182 makes `ended_at` authoritative for duration — a later
 * `events.created_at` / `last_activity_at` can no longer extend a finished
 * session's span. That is right for the corruption case and wrong for the
 * legitimate one: a session that terminated, was RESUMED, and is reimported
 * OUTSIDE the recently-active window is not reactivated, and every existing-row
 * write of `ended_at` in `importPhaseSessionAndMainAgent` goes through
 * `COALESCE(ended_at, …)`, which can fill a NULL but never move a non-NULL one.
 * Without the advance this suite pins, that continuation is truncated to the
 * pre-resume end forever.
 *
 * The discriminator under test is the SOURCE of the later instant, not its
 * lateness: the parser's own re-read `endedAt` is adopted; a bare later event
 * with no parser end is not.
 *
 * Driven through the production importer (`db.importer.importSession`) and
 * asserted on the stored rows, never on the helper in isolation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss5182-terminal-end-advance";
const MAIN_AGENT_ID = `${SESSION_ID}-main`;
const STARTED_AT = "2026-06-07T10:00:00.000Z";
/** The end frozen at the first terminal transition. */
const FIRST_END = "2026-06-07T11:00:00.000Z";
/** The end the resumed transcript re-parses to, 4h later. */
const RESUMED_END = "2026-06-07T15:00:00.000Z";
/** An end EARLIER than what is stored — a worker-truncated reparse. */
const EARLIER_END = "2026-06-07T10:30:00.000Z";
const FIRST_IMPORT_CLOCK = "2026-06-07T11:05:00.000Z";
const SECOND_IMPORT_CLOCK = "2026-06-09T09:00:00.000Z";

type StoredEnds = {
  sessionEndedAt: string | null;
  sessionUpdatedAt: string;
  agentEndedAt: string | null;
};

/**
 * Import the session terminal at {@link FIRST_END}, then re-import it with
 * `secondEnd` as the freshly-parsed end, and report the stored ends.
 *
 * `messageTimestamps` on the second parse always extends past
 * {@link RESUMED_END}, so the row's own recomputed `last_activity_at` is late in
 * EVERY case — that is what keeps the "later activity alone does not advance"
 * assertion honest rather than vacuous.
 */
async function importThenReimport(
  dir: string,
  secondEnd: string | null
): Promise<StoredEnds> {
  let clock = FIRST_IMPORT_CLOCK;
  const db = await openTestDb(dir, { now: () => clock });
  try {
    await db.importer.importSession(
      makePopulatedSession({
        endedAt: FIRST_END,
        sessionId: SESSION_ID,
        startedAt: STARTED_AT,
      }),
      "claude"
    );

    clock = SECOND_IMPORT_CLOCK;
    await db.importer.importSession(
      makePopulatedSession({
        endedAt: secondEnd,
        messageTimestamps: ["2026-06-07T10:00:30.000Z", RESUMED_END],
        sessionId: SESSION_ID,
        startedAt: STARTED_AT,
      }),
      "claude"
    );

    const [sessionRow] = await db.prisma.client.$queryRawUnsafe<
      { ended_at: string | null; updated_at: string }[]
    >("SELECT ended_at, updated_at FROM sessions WHERE id = $1", SESSION_ID);
    const [agentRow] = await db.prisma.client.$queryRawUnsafe<
      { ended_at: string | null }[]
    >("SELECT ended_at FROM agents WHERE id = $1", MAIN_AGENT_ID);
    return {
      agentEndedAt: agentRow?.ended_at ?? null,
      sessionEndedAt: sessionRow.ended_at,
      sessionUpdatedAt: sessionRow.updated_at,
    };
  } finally {
    await db.close();
  }
}

async function withTempDir(
  label: string,
  run: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), label));
  try {
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("ISS-5182: a terminal ended_at advances only from its own source", () => {
  test("a resumed transcript's later parsed end advances the frozen end and re-syncs", async () => {
    await withTempDir("iss5182-advance-", async (dir) => {
      const stored = await importThenReimport(dir, RESUMED_END);

      assert.equal(
        stored.sessionEndedAt,
        RESUMED_END,
        "the re-parsed end must replace the pre-resume one, not COALESCE away"
      );
      assert.equal(
        stored.agentEndedAt,
        RESUMED_END,
        "the main agent's own end must move with the session's"
      );
      assert.equal(
        stored.sessionUpdatedAt,
        SECOND_IMPORT_CLOCK,
        "the sync watermark must advance so the corrected duration reaches the cloud"
      );
    });
  });

  test("later activity with no later parsed end leaves the frozen end alone", async () => {
    await withTempDir("iss5182-activity-only-", async (dir) => {
      // Same late `messageTimestamps` tail as the advancing case, but the parse
      // reports no end of its own. That is the population ISS-5182 exists to
      // surface as a defect, so it must NOT become an anchor.
      const stored = await importThenReimport(dir, null);

      assert.equal(
        stored.sessionEndedAt,
        FIRST_END,
        "a bare later event is not evidence the run continued"
      );
      assert.equal(stored.agentEndedAt, FIRST_END);
    });
  });

  test("an earlier parsed end never back-dates the stored end", async () => {
    await withTempDir("iss5182-no-backdate-", async (dir) => {
      // A worker-truncated reparse keeps a correct scalar `endedAt` while its
      // event tail is dropped; adopting it unconditionally would shrink a
      // correct span.
      const stored = await importThenReimport(dir, EARLIER_END);

      assert.equal(
        stored.sessionEndedAt,
        FIRST_END,
        "the advance is strictly forward-only"
      );
      assert.equal(stored.agentEndedAt, FIRST_END);
    });
  });
});
