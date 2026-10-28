/**
 * ISS-12552 (PRD-800 "Proving usage"): the cloud dedupes copies of
 * one session (the same transcript synced from two machines) by the token
 * event's external id. That id must not depend on the machine: the same
 * transcript imported into two separate stores yields the same ids, for a
 * Claude session id and for OpenCode's `opencode-` prefixed one, whether the
 * second machine imported the series whole or appended it from the live hook.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  Harness,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  appendTokenEvents,
  replaceTokenEvents,
} from "../src/main/database/token-event-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-10-20T07:00:00.000Z";
const CLAUDE_SESSION = "176c6aa1-2d54-427d-82fa-31cfd38c277e";
const OPENCODE_SESSION = "opencode-ses_fa6832d22ffeP9RQlLpkf7UK4e";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
type Write = "replace" | "append";

describe("token event ids across machines (ISS-12552)", () => {
  for (const [sessionId, harness] of [
    [CLAUDE_SESSION, Harness.Claude],
    [OPENCODE_SESSION, Harness.OpenCode],
  ] as const) {
    test(`${harness}: the same transcript gets the same event ids on two machines`, async () => {
      const first = await transportIdsOnMachine(sessionId, harness, "replace");
      const second = await transportIdsOnMachine(sessionId, harness, "replace");
      const live = await transportIdsOnMachine(sessionId, harness, "append");

      assert.equal(first.length, records().length);
      assert.deepEqual(second, first);
      assert.deepEqual(live, first);
    });
  }
});

/** The ids one fresh store gives the series, in insertion order. */
async function transportIdsOnMachine(
  sessionId: string,
  harness: Harness,
  write: Write
): Promise<string[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-event-copies-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    await db.importer.importSession(
      makeSession({
        sessionId,
        model: "claude-opus-4-5",
        startedAt: "2026-10-19T19:45:12.969Z",
        tokensByModel: {},
        tokenSeries: [],
      }),
      harness
    );
    await db.prisma.write((tx) =>
      write === "replace"
        ? replaceTokenEvents(tx, sessionId, records())
        : appendTokenEvents(tx, sessionId, records())
    );
    return await readTransportIds(db, sessionId);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTransportIds(db: Db, sessionId: string): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { transport_id: string }[]
  >(
    `SELECT transport_id FROM token_events WHERE session_id = $1
      ORDER BY created_at ASC, transport_id ASC`,
    sessionId
  );
  return rows.map((row) => row.transport_id);
}

/** Two turns of one model, the second repeating the first's counts. */
function records(): NormalizedTokenRecord[] {
  const turn = {
    model: "claude-opus-4-5",
    input: 10,
    output: 5,
    cacheRead: 100,
    cacheWrite: 0,
  };
  return [
    { ...turn, timestamp: "2026-10-19T19:45:13.000Z" },
    { ...turn, timestamp: "2026-10-19T19:45:20.000Z" },
  ];
}
