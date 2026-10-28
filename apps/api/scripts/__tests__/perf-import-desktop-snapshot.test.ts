/**
 * Unit tests for the ISS-5288 perf-lane desktop-snapshot import.
 *
 * The mapping cases build a REAL SQLite database in the test with the desktop
 * schema's own physical column names, map it, and then parse the result with the
 * REAL wire schema (`desktopAgentSessionsPayloadObjectSchema`). Asserting
 * against the production validator is the point: a fixture that only satisfied a
 * hand-written expectation would pass while the fold rejected every batch.
 *
 * `@repo/database` is mocked so the compute-target write is exercised without a
 * server. The fold entrypoint is mocked at its module
 * boundary and asserted on from the test body, because the contract under test
 * is which payload the import hands it.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  handleDesktopAgentSessionsEvent: vi.fn(),
  generate: vi.fn(),
}));

// PARTIAL mock: the fold's module graph pulls real enums (ArtifactType, …) off
// this package at import time, so replacing the whole module breaks the import
// rather than the database call this needs to intercept.
vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});
vi.mock("@/lib/desktop-agent-sessions-handler", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/desktop-agent-sessions-handler")
    >();
  return {
    ...actual,
    handleDesktopAgentSessionsEvent: mocks.handleDesktopAgentSessionsEvent,
  };
});
vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: { generate: mocks.generate },
}));

import { DesktopAgentSessionsAckReason } from "@repo/api/src/types/agent-session";
import { z } from "zod";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import {
  BATCH_BYTE_BUDGET,
  batchSessions,
  buildBatchPayload,
  checkSnapshotPath,
  ensurePerfComputeTarget,
  ImportRefusalCode,
  importSnapshot,
  mintPerfApiBearer,
  PERF_CREDENTIALS_FILENAME,
  PERF_IMPORT_MACHINE_NAME,
  parseImportArgs,
  resolveCredentialsPath,
  runPreflight,
} from "../perf-import-desktop-snapshot";
import {
  GuardRefusalCode,
  PERF_API_KEY_NAME,
  writeCredentialsFile,
} from "../perf-import-desktop-snapshot-guards";
import {
  OMITTED_WIRE_FIELDS,
  SkipReason,
} from "../perf-import-desktop-snapshot-mapping";

const PERF_URL =
  "postgresql://postgres:postgres@localhost:5432/closedloop_perf";
const ORG_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const USER_ID = "0192f0a0-0000-7000-8000-0000000000b1";
const TARGET_ID = "0192f0a0-0000-7000-8000-0000000000c1";
const IDENTITY = { organizationId: ORG_ID, userId: USER_ID };

/** A directory git really ignores in this worktree, and one it really does not. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const IGNORED_OUT = join(REPO_ROOT, ".perf", "import-summary.json");
const TRACKED_OUT = join(REPO_ROOT, "apps", "api", "scripts", "summary.json");

import {
  insertSession,
  mapSnapshot,
  seedRichSession,
  withSnapshot,
} from "./perf-import-snapshot-fixture";

function makeFakeDb() {
  return {
    computeTarget: { upsert: vi.fn() },
  };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = makeFakeDb();
  mocks.withDb.mockImplementation((cb: (c: FakeDb) => unknown) => cb(db));
  mocks.handleDesktopAgentSessionsEvent.mockResolvedValue({ accepted: true });
});

describe("parseImportArgs", () => {
  it("parses the flags the justfile target passes", () => {
    const result = parseImportArgs([
      "--snapshot",
      "/tmp/agent-dashboard.sqlite",
      "--out",
      "/tmp/import-summary.json",
    ]);

    expect(result.ok === true && result.value.snapshot).toBe(
      "/tmp/agent-dashboard.sqlite"
    );
    expect(result.ok === true && result.value.out).toBe(
      "/tmp/import-summary.json"
    );
    // The default has to survive omission — the justfile never passes it.
    expect(result.ok === true && result.value.batchSize).toBe(100);
  });

  it("refuses a missing flag, an unknown flag, and an out-of-range batch size", () => {
    const required = ["--snapshot", "/tmp/s.sqlite", "--out", "/tmp/o.json"];
    for (const argv of [
      ["--out", "/tmp/summary.json"],
      // `--out` is REQUIRED: it is where the bearer handoff is written, so a run
      // without it would mint a credential with nowhere to put it.
      ["--snapshot", "/tmp/s.sqlite"],
      [...required, "--danger", "1"],
      [...required, "--batch-size", "0"],
      [...required, "--batch-size", "5000"],
    ]) {
      const result = parseImportArgs(argv);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe(
        GuardRefusalCode.ArgsInvalid
      );
    }
  });
});

describe("checkSnapshotPath", () => {
  it("accepts a real SQLite snapshot", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => {
        expect(checkSnapshotPath(path).ok).toBe(true);
      }
    );
  });

  it("refuses a path that is absent or is a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "perf-import-dir-"));
    try {
      for (const path of [join(dir, "nope.sqlite"), dir]) {
        const result = checkSnapshotPath(path);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error.code).toBe(
          ImportRefusalCode.SnapshotMissing
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a readable file that is not a SQLite database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "perf-import-junk-"));
    const path = join(dir, "not-a-db.sqlite");
    try {
      await writeFile(path, "hello world");

      // SQLite opens a text file happily and only rejects it on the first read,
      // so a probe that merely opened the handle would accept this.
      const result = checkSnapshotPath(path);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe(
        ImportRefusalCode.SnapshotUnreadable
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a real SQLite database that is not a desktop snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "perf-import-wrong-"));
    const path = join(dir, "other.sqlite");
    try {
      const other = new DatabaseSync(path);
      other.exec("CREATE TABLE unrelated (id TEXT)");
      other.close();

      const result = checkSnapshotPath(path);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe(
        ImportRefusalCode.SnapshotNotDesktopSchema
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runPreflight", () => {
  // `.perf/` is git-ignored but need not exist in a fresh clone, and preflight
  // now requires the --out directory to be real. Creating it keeps the passing
  // case from depending on whatever a previous perf run happened to leave behind.
  beforeAll(() => mkdir(dirname(IGNORED_OUT), { recursive: true }));

  it("passes on the local perf database with a real snapshot and an ignored --out", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => {
        const result = runPreflight(
          ["--snapshot", path, "--out", IGNORED_OUT],
          { DATABASE_URL: PERF_URL }
        );
        expect(result.ok).toBe(true);
      }
    );
  });

  it("refuses a remote host and a non-perf database before opening the snapshot", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => {
        const cases: [string, string][] = [
          [
            "postgresql://u:p@db.stage.internal:5432/closedloop_perf",
            GuardRefusalCode.DatabaseUrlNotLocal,
          ],
          [
            "postgresql://postgres:postgres@localhost:5432/symphony",
            GuardRefusalCode.DatabaseUrlNotPerfDatabase,
          ],
        ];
        for (const [databaseUrl, code] of cases) {
          const result = runPreflight(
            ["--snapshot", path, "--out", IGNORED_OUT],
            { DATABASE_URL: databaseUrl }
          );
          expect(result.ok).toBe(false);
          expect(result.ok === false && result.error.code).toBe(code);
        }
      }
    );
  });

  it("refuses when DATABASE_URL is unset", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => {
        const result = runPreflight(
          ["--snapshot", path, "--out", IGNORED_OUT],
          {}
        );
        expect(result.ok === false && result.error.code).toBe(
          GuardRefusalCode.DatabaseUrlMissing
        );
      }
    );
  });

  it("refuses an --out directory that does not exist, before anything is written", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => {
        const result = runPreflight(
          [
            "--snapshot",
            path,
            "--out",
            join(REPO_ROOT, ".perf", "no-such-run", "import-summary.json"),
          ],
          { DATABASE_URL: PERF_URL }
        );

        // Both writes happen after the org-policy flip and the key mint, so this
        // has to refuse in preflight rather than ENOENT mid-run.
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error.code).toBe(
          ImportRefusalCode.OutDirectoryMissing
        );
      }
    );
  });

  it("refuses an --out directory git would commit, because a live bearer lands there", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => {
        const result = runPreflight(
          ["--snapshot", path, "--out", TRACKED_OUT],
          { DATABASE_URL: PERF_URL }
        );
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error.code).toBe(
          GuardRefusalCode.OutPathNotGitIgnored
        );
      }
    );
  });
});

describe("mapSnapshotSession", () => {
  it("maps a fully-populated session into a payload the REAL wire schema accepts", async () => {
    const { sessions, skips } = await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => mapSnapshot(path)
    );

    expect(skips).toStrictEqual({});
    const parsed = desktopAgentSessionsPayloadObjectSchema.safeParse(
      buildBatchPayload(sessions)
    );
    expect(parsed.success ? "" : z.prettifyError(parsed.error)).toBe("");
    const session = parsed.success ? parsed.data.sessions[0] : undefined;
    expect(session?.externalSessionId).toBe("s1");
    expect(session?.status).toBe("active");
    expect(session?.startedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(session?.harness).toBe("claude");
    expect(session?.billingMode).toBe("subscription");
    expect(session?.dataRevision).toBe(79);
    expect(session?.endsWithError).toBe(false);
    expect(session?.attribution?.repositoryFullName).toBe(
      "closedloop-ai/symphony"
    );
  });

  it("folds the compaction baselines into the effective token totals", async () => {
    const { sessions } = await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => mapSnapshot(path)
    );

    // The desktop producer syncs `current + baseline`; sending the raw
    // post-compaction counts would undercount every compacted session.
    expect(sessions[0]?.tokenUsageByModel).toStrictEqual([
      {
        model: "claude-opus-4-6",
        inputTokens: 107,
        outputTokens: 208,
        cacheReadTokens: 309,
        cacheWriteTokens: 410,
        cacheWrite5mTokens: 150,
        cacheWrite1hTokens: 250,
        estimatedCostUsd: 1.5,
      },
    ]);
  });

  it("carries no turn text on the wire", async () => {
    const { sessions } = await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => mapSnapshot(path)
    );

    // FEA-2718 removed `summary`/`data` from this lane, and ISS-6894 removed
    // `agent.task` outright — the producer no longer selects the column and the
    // ingest schema has no such key. Serializing the whole session is the only
    // assertion that catches the text leaking through any field.
    const serialized = JSON.stringify(sessions[0]);
    expect(serialized).not.toContain("turn text that must not ride this lane");
    expect(serialized).not.toContain("do the thing");
    const agents = sessions[0]?.agents as Record<string, unknown>[];
    expect(agents[0]).not.toHaveProperty("task");
  });

  it("maps the related rows a perf corpus is measured on", async () => {
    const { sessions } = await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => mapSnapshot(path)
    );
    const session = sessions[0] ?? {};

    expect(session.events).toStrictEqual([
      {
        externalEventId: "event-s1",
        agentExternalId: "agent-s1",
        eventType: "PreToolUse",
        toolName: "Read",
        createdAt: "2026-08-01T10:05:00.000Z",
      },
    ]);
    expect(session.tokenEvents).toStrictEqual([
      {
        externalEventId: "transport-s1",
        agentExternalId: null,
        model: "claude-opus-4-6",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        createdAt: "2026-08-01T10:06:00.000Z",
        estimatedCostUsd: 0.25,
        sourceIdentity: {
          availability: "available",
          scheme: "claude.transcript.entry.uuid",
          sourceRecordIds: ["a"],
        },
        costSummary: {
          completeness: "partial",
          reason: "legacy_record",
          subtotalUsd: 0.25,
          lanes: [{ basis: "api_estimated", subtotalUsd: 0.25 }],
        },
      },
    ]);
    expect(session.activitySegmentRows).toStrictEqual([
      {
        phase: "implement",
        startMs: 1_786_151_948_897,
        endMs: 1_786_151_954_944,
        confidence: 0.75,
        evidenceLayers: ["structural"],
        version: 16,
        workItemRef: null,
        subagentId: null,
      },
    ]);
    expect(session.components).toHaveLength(1);
    expect(session.sessionAnalytics).toMatchObject({
      isHuman: true,
      humanTurns: 3,
      agentTurns: 5,
      estimatedCostUsd: 1.5,
      runtimeMs: 3_600_000,
    });
  });

  it("omits an optional section entirely when the snapshot has no rows for it", async () => {
    const { sessions } = await withSnapshot(
      (database) => insertSession(database, { id: "bare" }),
      (path) => mapSnapshot(path)
    );
    const session = sessions[0] ?? {};

    // An OMITTED section means "no replacement data" and leaves previously
    // persisted cloud rows untouched; an explicit `[]` would clear them.
    expect("tokenEvents" in session).toBe(false);
    expect("activitySegmentRows" in session).toBe(false);
    expect("components" in session).toBe(false);
    expect("sessionAnalytics" in session).toBe(false);
    // The three required arrays are still present and empty.
    expect(session.agents).toStrictEqual([]);
    expect(session.events).toStrictEqual([]);
    expect(session.tokenUsageByModel).toStrictEqual([]);
  });

  it("sends no value for a field the snapshot cannot source honestly", async () => {
    const { sessions } = await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) => mapSnapshot(path)
    );
    const session = sessions[0] ?? {};

    // The documented omissions are a CONTRACT, not a note: each of these is
    // derived by the desktop's trace builder, so emitting one here would be this
    // lane inventing a value and seeding a perf corpus that disagrees with what
    // a real sync produces. Adding a key to the payload without removing it from
    // OMITTED_WIRE_FIELDS fails here.
    for (const field of Object.keys(OMITTED_WIRE_FIELDS)) {
      expect({ field, present: field in session }).toStrictEqual({
        field,
        present: false,
      });
    }
  });

  it("skips a session whose required timestamps the snapshot cannot supply", async () => {
    const { sessions, skips } = await withSnapshot(
      (database) => {
        seedRichSession(database, "good");
        insertSession(database, { id: "no-start", startedAt: null });
        insertSession(database, { id: "no-update", updatedAt: null });
      },
      (path) => mapSnapshot(path)
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.externalSessionId).toBe("good");
    expect(skips).toStrictEqual({ [SkipReason.SessionMissingTimestamps]: 2 });
  });

  it("skips only the unrepresentable rows, keeping the session", async () => {
    const { sessions, skips } = await withSnapshot(
      (database) => {
        seedRichSession(database, "s1");
        database
          .prepare(
            `INSERT INTO agents (id, session_id, name, type, status)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run("agent-nameless", "s1", null, "primary", "running");
        database
          .prepare(
            `INSERT INTO events (id, session_id, event_type, created_at)
             VALUES (?, ?, ?, ?)`
          )
          .run("event-undated", "s1", "PreToolUse", null);
        database
          .prepare(
            `INSERT INTO token_events (session_id, transport_id, model, created_at)
             VALUES (?, ?, ?, ?)`
          )
          .run("s1", null, "claude-opus-4-6", "2026-08-01T10:07:00.000Z");
        database
          .prepare(
            `INSERT INTO session_activity_segments (id, session_id, phase,
               start_ms, end_ms, confidence, evidence_layers, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run("seg-degenerate", "s1", "other", 500, 500, 0.5, "[]", 16);
      },
      (path) => mapSnapshot(path)
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agents).toHaveLength(1);
    expect(sessions[0]?.events).toHaveLength(1);
    expect(sessions[0]?.tokenEvents).toHaveLength(1);
    expect(sessions[0]?.activitySegmentRows).toHaveLength(1);
    expect(skips).toStrictEqual({
      [SkipReason.AgentMissingIdentity]: 1,
      [SkipReason.EventMissingTimestamp]: 1,
      [SkipReason.TokenEventMissingTransportId]: 1,
      [SkipReason.ActivitySegmentBoundsInvalid]: 1,
    });
  });

  it("drops a cache-write TTL subdivision that exceeds its own parent", async () => {
    const { sessions } = await withSnapshot(
      (database) => {
        insertSession(database, { id: "s1" });
        database
          .prepare(
            `INSERT INTO token_usage (session_id, model, cache_write_tokens,
               cache_write_5m_tokens, cache_write_1h_tokens)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run("s1", "claude-opus-4-6", 100, 90, 90);
      },
      (path) => mapSnapshot(path)
    );
    const [session] = sessions;
    expect(session).toBeDefined();
    const usage = (session.tokenUsageByModel as Record<string, unknown>[])[0];

    // The wire schema rejects a subdivision larger than `cacheWriteTokens`, and
    // one bad row would fail the whole batch — so the pair is dropped, not bent.
    expect("cacheWrite5mTokens" in (usage ?? {})).toBe(false);
    expect("cacheWrite1hTokens" in (usage ?? {})).toBe(false);
    expect(usage?.cacheWriteTokens).toBe(100);
  });
});

describe("batchSessions", () => {
  const small = () => ({ externalSessionId: "x", events: [] });

  it("bounds a batch by the session count", () => {
    const batches = batchSessions(Array.from({ length: 25 }, small), 10);
    expect(batches.map((batch) => batch.length)).toStrictEqual([10, 10, 5]);
  });

  it("bounds a batch by the byte budget before the count cap is reached", () => {
    // Two sessions that each occupy more than half the budget cannot share a
    // batch even though the count cap would happily allow 100.
    const heavy = () => ({
      externalSessionId: "x",
      blob: "a".repeat(BATCH_BYTE_BUDGET * 0.6),
    });
    const batches = batchSessions([heavy(), heavy(), heavy()], 100);
    expect(batches.map((batch) => batch.length)).toStrictEqual([1, 1, 1]);
  });

  it("never drops a session that alone exceeds the budget", () => {
    const oversized = {
      externalSessionId: "big",
      blob: "a".repeat(BATCH_BYTE_BUDGET * 2),
    };
    const batches = batchSessions([oversized, small()], 100);
    expect(batches.flat()).toHaveLength(2);
  });
});

describe("importSnapshot", () => {
  it("drives the PRODUCTION fold entrypoint with a payload it really parses", async () => {
    const summary = await withSnapshot(
      (database) => {
        seedRichSession(database, "s1");
        seedRichSession(database, "s2");
      },
      (path) =>
        importSnapshot(
          {
            snapshot: path,
            identity: IDENTITY,
            computeTargetId: TARGET_ID,
            batchSize: 100,
          },
          // No `handle` override: the default must be the real handler, so
          // deleting that default fails this test rather than silently
          // importing through nothing.
          { log: () => undefined }
        )
    );

    expect(mocks.handleDesktopAgentSessionsEvent).toHaveBeenCalledTimes(1);
    const [payload, context] =
      mocks.handleDesktopAgentSessionsEvent.mock.calls[0] ?? [];
    expect(context).toStrictEqual({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetId: TARGET_ID,
    });
    // The payload the fold receives must satisfy the real validator, not merely
    // resemble it.
    expect(
      desktopAgentSessionsPayloadObjectSchema.safeParse(payload).success
    ).toBe(true);
    expect(summary.sessionsRead).toBe(2);
    expect(summary.sessionsSent).toBe(2);
    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(0);
  });

  it("counts the sessions the fold says it PERSISTED, not the ones sent", async () => {
    mocks.handleDesktopAgentSessionsEvent.mockResolvedValue({
      accepted: true,
      acceptedSessionIds: ["s1"],
    });

    const summary = await withSnapshot(
      (database) => {
        seedRichSession(database, "s1");
        seedRichSession(database, "s2");
      },
      (path) =>
        importSnapshot(
          {
            snapshot: path,
            identity: IDENTITY,
            computeTargetId: TARGET_ID,
            batchSize: 100,
          },
          { log: () => undefined }
        )
    );

    // Two sessions were sent; the fold echoed one. Reporting the sent count
    // here would claim a landing that never happened.
    expect(summary.sessionsSent).toBe(2);
    expect(summary.sessionsPersisted).toBe(1);
  });

  it("reports a rejected batch as a NAMED failure carrying the ack reason", async () => {
    mocks.handleDesktopAgentSessionsEvent.mockResolvedValue({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      detail: "sessions.0.status: required",
    });

    const summary = await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) =>
        importSnapshot(
          {
            snapshot: path,
            identity: IDENTITY,
            computeTargetId: TARGET_ID,
            batchSize: 100,
          },
          { log: () => undefined }
        )
    );

    expect(summary.rejected).toBe(1);
    expect(summary.sessionsPersisted).toBe(0);
    expect(summary.rejections).toStrictEqual([
      {
        batchIndex: 0,
        sentSessions: 1,
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
        detail: "sessions.0.status: required",
      },
    ]);
  });

  it("requests the per-session ack echo so the persisted count can be honest", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) =>
        importSnapshot(
          {
            snapshot: path,
            identity: IDENTITY,
            computeTargetId: TARGET_ID,
            batchSize: 100,
          },
          { log: () => undefined }
        )
    );

    const [payload] = mocks.handleDesktopAgentSessionsEvent.mock.calls[0] ?? [];
    expect(
      (payload as { wantsAcceptedSessionIds?: boolean }).wantsAcceptedSessionIds
    ).toBe(true);
  });

  it("stubs no ingest gate — every check runs for real", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      (path) =>
        importSnapshot(
          {
            snapshot: path,
            identity: IDENTITY,
            computeTargetId: TARGET_ID,
            batchSize: 100,
          },
          { log: () => undefined }
        )
    );

    const deps = mocks.handleDesktopAgentSessionsEvent.mock.calls[0]?.[2] ?? {};
    // NO ingest gate is stubbed, which is what makes the import exercise the
    // production path. ISS-8022 removed the PostHog rollout gate that USED to be
    // stubbed here, and ISS-11449 removed the org session-sync policy gate the
    // import used to satisfy with a real row write, so the import supplies no
    // gate answer at all.
    expect("upsertBatch" in deps).toBe(false);
    expect("isFeatureEnabled" in deps).toBe(false);
  });

  it("leaves the snapshot unmodified", async () => {
    await withSnapshot(
      (database) => seedRichSession(database, "s1"),
      async (path) => {
        const before = await readFile(path);
        await importSnapshot(
          {
            snapshot: path,
            identity: IDENTITY,
            computeTargetId: TARGET_ID,
            batchSize: 100,
          },
          { log: () => undefined }
        );
        expect(await readFile(path)).toStrictEqual(before);
      }
    );
  });
});

describe("perf database setup", () => {
  it("reuses one deterministic compute target per user", async () => {
    db.computeTarget.upsert.mockResolvedValue({ id: TARGET_ID });

    expect(await ensurePerfComputeTarget(IDENTITY)).toBe(TARGET_ID);
    expect(db.computeTarget.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_machineName: {
            userId: USER_ID,
            machineName: PERF_IMPORT_MACHINE_NAME,
          },
        },
        create: expect.objectContaining({
          organizationId: ORG_ID,
          userId: USER_ID,
          machineName: PERF_IMPORT_MACHINE_NAME,
        }),
        update: {},
      })
    );
  });
});

describe("PERF_API_BEARER handoff", () => {
  it("mints through the production api-keys service for the resolved identity", async () => {
    mocks.generate.mockResolvedValue({ id: "key-1", plaintext: "sk_live_abc" });

    const credentials = await mintPerfApiBearer(IDENTITY);

    // Same service, same (organizationId, userId) argument order the live key
    // flow uses — a hand-rolled key row could drift from the real key shape.
    expect(mocks.generate).toHaveBeenCalledWith(ORG_ID, USER_ID, {
      name: PERF_API_KEY_NAME,
    });
    expect(credentials).toStrictEqual({
      apiBearer: "sk_live_abc",
      organizationId: ORG_ID,
      userId: USER_ID,
    });
  });

  it("lands beside --out under the name the measurement recipes read", () => {
    expect(resolveCredentialsPath("/tmp/run-7/import-summary.json")).toBe(
      join("/tmp/run-7", PERF_CREDENTIALS_FILENAME)
    );
    expect(PERF_CREDENTIALS_FILENAME).toBe("credentials.json");
  });

  it("writes the bearer owner-only (0600) under the published key name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "perf-import-creds-"));
    try {
      const credentials = {
        apiBearer: "sk_live_abc",
        organizationId: ORG_ID,
        userId: USER_ID,
      };

      const path = await writeCredentialsFile(
        resolveCredentialsPath(join(dir, "import-summary.json")),
        credentials
      );

      // `% 0o1000` masks off the file-type bits.
      expect((await stat(path)).mode % 0o1000).toBe(0o600);
      // `apiBearer` is the key `just profile-web-stack` jq's out — renaming it
      // silently breaks the recipe, so it is asserted, not assumed.
      expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual(
        credentials
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The suite above aliases `server-only` to an empty stub, so it CANNOT catch the
 * script's real entrypoint breaking. This runs the REAL `tsx` runner in a child
 * process, exactly the way the package script invokes it, and proves the script
 * loads and reaches its own refusal.
 *
 * There is deliberately NO companion case asserting the script fails without
 * `--conditions=react-server`. Nothing in its module graph carries the
 * `server-only` marker today, so the flag is defensive rather than load-bearing
 * and the script loads either way; a case pinning the failure would only assert
 * which of its dependencies happens to import the marker.
 *
 * The invocation passes a REMOTE `DATABASE_URL`, so the run refuses during
 * preflight and no database is ever contacted.
 */
describe("CLI entrypoint resolution (real tsx runner, no server-only mask)", () => {
  const SCRIPT_PATH = fileURLToPath(
    new URL("../perf-import-desktop-snapshot.ts", import.meta.url)
  );
  const TSX_BIN = fileURLToPath(
    new URL("../../node_modules/.bin/tsx", import.meta.url)
  );
  const SERVER_ONLY_THROW = "cannot be imported from a Client Component";
  // Both flags are required, so the run must carry them to get PAST arg parsing
  // and reach the DATABASE_URL refusal this case is actually about.
  const RUN_ARGS = [
    "--snapshot",
    "/tmp/does-not-matter.sqlite",
    "--out",
    IGNORED_OUT,
  ];

  function runUnderTsx(
    tsxArgs: string[]
  ): Promise<{ code: number; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        TSX_BIN,
        [...tsxArgs, SCRIPT_PATH, ...RUN_ARGS],
        {
          timeout: 60_000,
          env: {
            ...process.env,
            DATABASE_URL:
              "postgresql://u:p@remote.invalid:5432/closedloop_perf",
          },
        },
        (error, _stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 0;
          resolvePromise({ code, stderr: stderr ?? "" });
        }
      );
      child.on("error", reject);
    });
  }

  it("loads and reaches its own refusal under --conditions=react-server", async () => {
    const { code, stderr } = await runUnderTsx(["--conditions=react-server"]);

    expect(stderr).not.toContain(SERVER_ONLY_THROW);
    expect(stderr).toContain(GuardRefusalCode.DatabaseUrlNotLocal);
    expect(code).toBe(1);
  }, 60_000);

  it("ships the condition in the package script operators run", async () => {
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8"
      )
    );
    const script = manifest.scripts["perf:import-desktop-snapshot"];

    expect(script).toContain("--conditions=react-server");
    expect(script).toContain("scripts/perf-import-desktop-snapshot.ts");
  });
});
