/**
 * @file ISS-11283 branch coverage for
 * database/session-analytics-maintenance.ts paths the existing suites never
 * exercise: the `error instanceof Error ? error.message : String(error)`
 * ternary in each of the seven boot-maintenance passes' per-chunk catch
 * block (every existing test drives the happy path, where the write never
 * throws), plus `recomputeLegacyMessageAgentTurnBuckets`'s "derives nothing"
 * filter arm.
 *
 * Each write is made to fail via a REAL SQLite fault: dropping a table the
 * WRITE path touches but that function's own SELECT does not, so the
 * candidate-selection query still succeeds and the chunk loop's write throws
 * a genuine "no such table" error — never a faked rejection. SQLite/Prisma
 * errors are always real `Error` instances, so the ternary's non-Error arm
 * (`String(error)`) has no reachable real-behavior trigger here; that arm is
 * out of scope for all seven passes.
 */
import { describe, expect, it } from "vitest";
import {
  backfillSessionAnalytics,
  backfillSessionTurnBuckets,
  recomputeHeadlessSessionAnalytics,
  recomputeHeadlessTurnBuckets,
  recomputeImportedAgentTurnAnalytics,
  recomputeLegacyMessageAgentTurnBuckets,
  recomputeLegacySessionAnalyticsCost,
} from "../src/main/database/session-analytics-maintenance.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type Store = OpenTestPrisma["db"];

const ERROR_CLASS_PREFIX = /^\w*Error: /;

async function insertSession(
  store: Store,
  id: string,
  metadata: string | null
): Promise<void> {
  await store.query("INSERT INTO sessions (id, metadata) VALUES ($1, $2)", [
    id,
    metadata,
  ]);
}

async function insertSessionAnalytics(
  store: Store,
  sessionId: string,
  overrides: { isHuman?: number; agentTurns?: number; estCost?: number } = {}
): Promise<void> {
  await store.query(
    `INSERT INTO session_analytics (session_id, is_human, agent_turns, est_cost)
     VALUES ($1, $2, $3, $4)`,
    [
      sessionId,
      overrides.isHuman ?? 0,
      overrides.agentTurns ?? 0,
      overrides.estCost ?? 0,
    ]
  );
}

async function insertHumanTurnBucket(
  store: Store,
  sessionId: string
): Promise<void> {
  await store.query(
    `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
     VALUES ($1, $2, 'human', 1)`,
    [sessionId, "2025-06-01T00:00:00Z"]
  );
}

/** The text after `prefix` on every log line that starts with it. The catch
 *  logs `error.message`; the `String(error)` mutant would prepend the class
 *  name ("PrismaClientKnownRequestError: "), which ERROR_CLASS_PREFIX detects. */
function loggedDetails(logs: string[], prefix: string): string[] {
  return logs
    .filter((message) => message.startsWith(prefix))
    .map((message) => message.slice(prefix.length));
}

function collectLogs(): { log: (message: string) => void; logs: string[] } {
  const logs: string[] = [];
  return { log: (message) => logs.push(message), logs };
}

describe("backfillSessionTurnBuckets: catch ternary over a real write failure", () => {
  it("logs error.message when the write's token_events read hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await insertSession(store, "s1", "{}");
      // token_events is read inside rebuildSessionTurnBuckets (the write), not
      // in this function's own candidate SELECT (sessions + session_turn_bucket
      // only), so dropping it fails only the write.
      await store.query("DROP TABLE token_events");
      const { log, logs } = collectLogs();

      await backfillSessionTurnBuckets(prisma, log);

      const details = loggedDetails(
        logs,
        "session-turn-bucket backfill failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining("SQLITE_ERROR: no such table: token_events"),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});

describe("recomputeHeadlessTurnBuckets: catch ternary over a real write failure", () => {
  it("logs error.message when the write's token_events read hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await insertSession(store, "s2", '{"entrypoint":"sdk-x"}');
      await insertHumanTurnBucket(store, "s2");
      await store.query("DROP TABLE token_events");
      const { log, logs } = collectLogs();

      await recomputeHeadlessTurnBuckets(prisma, log);

      const details = loggedDetails(
        logs,
        "headless turn-bucket recompute failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining("SQLITE_ERROR: no such table: token_events"),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});

describe("backfillSessionAnalytics: catch ternary over a real write failure", () => {
  it("logs error.message when the rollup write's agent_component_session_usage step hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      // No session_analytics row for s3, so the anti-join SELECT (which never
      // touches agent_component_session_usage) selects it.
      await insertSession(store, "s3", "{}");
      await store.query("DROP TABLE agent_component_session_usage");
      const { log, logs } = collectLogs();

      await backfillSessionAnalytics(prisma, log);

      const details = loggedDetails(
        logs,
        "session-analytics backfill failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining(
          "SQLITE_ERROR: no such table: agent_component_session_usage"
        ),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});

describe("recomputeHeadlessSessionAnalytics: catch ternary over a real write failure", () => {
  it("logs error.message when the rollup write's agent_component_session_usage step hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await insertSession(store, "s4", '{"entrypoint":"sdk-x"}');
      await insertSessionAnalytics(store, "s4", { isHuman: 1 });
      await store.query("DROP TABLE agent_component_session_usage");
      const { log, logs } = collectLogs();

      await recomputeHeadlessSessionAnalytics(prisma, log);

      const details = loggedDetails(
        logs,
        "headless session-analytics recompute failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining(
          "SQLITE_ERROR: no such table: agent_component_session_usage"
        ),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});

describe("recomputeImportedAgentTurnAnalytics: catch ternary over a real write failure", () => {
  it("logs error.message when the rollup write's agent_component_session_usage step hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      // Stale: the transcript-derived assistantMessages count (5) disagrees
      // with the stored agent_turns (0), so the SELECT (sessions +
      // session_analytics only) selects it.
      await insertSession(store, "s5", '{"assistantMessages":5}');
      await insertSessionAnalytics(store, "s5", { agentTurns: 0 });
      await store.query("DROP TABLE agent_component_session_usage");
      const { log, logs } = collectLogs();

      await recomputeImportedAgentTurnAnalytics(prisma, log);

      const details = loggedDetails(
        logs,
        "imported agent-turn recompute failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining(
          "SQLITE_ERROR: no such table: agent_component_session_usage"
        ),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});

describe("recomputeLegacySessionAnalyticsCost: catch ternary over a real write failure", () => {
  it("logs error.message when the rollup write's agent_component_session_usage step hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      // Stale: est_cost is stored (0, NOT NULL) but the derived cost is NULL —
      // no token_usage rows at all makes the "fully priced" CASE fall through
      // to its ELSE NULL branch (zero priced rows, zero web-search cost).
      await insertSession(store, "s6", "{}");
      await insertSessionAnalytics(store, "s6", { estCost: 0 });
      await store.query("DROP TABLE agent_component_session_usage");
      const { log, logs } = collectLogs();

      await recomputeLegacySessionAnalyticsCost(prisma, log);

      const details = loggedDetails(
        logs,
        "legacy analytics cost recompute failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining(
          "SQLITE_ERROR: no such table: agent_component_session_usage"
        ),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});

describe("recomputeLegacyMessageAgentTurnBuckets: derives-nothing filter and catch ternary", () => {
  it("skips a candidate whose messages derive zero turn buckets (does not count it as done)", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      // Qualifies for the candidate SELECT (non-empty $.messages array, no
      // token_events row) but derives NOTHING: a message entry with none of
      // the fields collectHumanTurnUnits/collectLegacyAgentMessageUnits read
      // (no role, no timestamp).
      await insertSession(store, "s7", '{"messages":[{}]}');
      const { log, logs } = collectLogs();

      await recomputeLegacyMessageAgentTurnBuckets(prisma, log);

      // Silent: nothing qualified after the in-memory derives-nothing filter
      // dropped the only candidate (see the function's own "Silent when
      // nothing qualified" comment).
      expect(logs).toEqual([]);
      const rows = await store.query(
        "SELECT session_id FROM session_turn_bucket WHERE session_id = $1",
        ["s7"]
      );
      expect(rows.rows.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("does not touch an existing stored bucket when the current derivation is empty (never treats empty as delete)", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      // Qualifies for the candidate SELECT (non-empty $.messages, no
      // token_events), but derives nothing NOW. It already has a stored
      // human bucket from an earlier import — the empty-derivation filter
      // must skip it so that row survives, rather than falling through to
      // the fingerprint comparison (empty vs non-empty always differs) and
      // wiping it.
      await insertSession(store, "s9", '{"messages":[{}]}');
      await insertHumanTurnBucket(store, "s9");
      const { log, logs } = collectLogs();

      await recomputeLegacyMessageAgentTurnBuckets(prisma, log);

      expect(logs).toEqual([]);
      const rows = await store.query<{ turn_kind: string }>(
        "SELECT turn_kind FROM session_turn_bucket WHERE session_id = $1",
        ["s9"]
      );
      expect(rows.rows).toEqual([{ turn_kind: "human" }]);
    } finally {
      await close();
    }
  });

  it("logs error.message when the write's rebuild step hits a dropped table", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      // Qualifies AND derives a real human turn bucket, so the chunk reaches
      // the write. session_turn_bucket is read (storedRows) and written
      // (rebuildSessionTurnBuckets) inside the try block, but is not touched
      // by the initial candidate SELECT (sessions + token_events only).
      await insertSession(
        store,
        "s8",
        '{"messages":[{"role":"human","timestamp":"2025-06-01T00:00:00Z"}]}'
      );
      await store.query("DROP TABLE session_turn_bucket");
      const { log, logs } = collectLogs();

      await recomputeLegacyMessageAgentTurnBuckets(prisma, log);

      const details = loggedDetails(
        logs,
        "legacy-message agent turn-bucket recompute failed for 1 session(s): "
      );
      expect(details).toEqual([
        expect.stringContaining(
          "SQLITE_ERROR: no such table: session_turn_bucket"
        ),
      ]);
      expect(details[0]).not.toMatch(ERROR_CLASS_PREFIX);
    } finally {
      await close();
    }
  });
});
