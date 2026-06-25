import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backfillArtifactLinksFromTranscripts } from "../src/main/collectors/artifact-link-backfill.js";
import { LAUNCH_METADATA_REF_METHOD } from "../src/main/collectors/artifact-ref-extractor.js";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

test("artifact-link backfill uses injected parser for transcript scans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-parser-"));
  const transcriptPath = join(dir, "backfill-worker.jsonl");
  const parseCalls: string[] = [];
  const queries: Array<{ query: string; params?: unknown[] }> = [];
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({
      existingSessionIds: ["backfill-worker"],
      onQuery: (query, params) => {
        queries.push({ query, params });
      },
    });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      parseSessionFile: (filePath) => {
        parseCalls.push(filePath);
        return Promise.resolve(makeSession("backfill-worker"));
      },
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.errors, 0);
    assert.deepEqual(parseCalls, [transcriptPath]);
    assert.equal(
      queries.some(({ query }) =>
        query.includes("INSERT INTO artifact_link_backfill_seen")
      ),
      true
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill yields after maintenance writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-yield-"));
  const transcriptPath = join(dir, "backfill-yield.jsonl");
  const delayCalls: number[] = [];
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({ existingSessionIds: ["backfill-yield"] });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      cooperativeDelay: (ms) => {
        delayCalls.push(ms);
        return Promise.resolve();
      },
      parseSessionFile: () => Promise.resolve(makeSession("backfill-yield")),
    });

    assert.equal(result.scanned, 1);
    assert.deepEqual(delayCalls, [50]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill preserves launch-metadata artifact links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-launch-link-"));
  const transcriptPath = join(dir, "launch-link.jsonl");
  const queries: Array<{ query: string; params?: unknown[] }> = [];
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({
      existingSessionIds: ["launch-link"],
      onQuery: (query, params) => {
        queries.push({ query, params });
      },
    });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      parseSessionFile: () => Promise.resolve(makeSession("launch-link")),
    });

    assert.equal(result.scanned, 1);
    const deleteQuery = queries.find(({ query }) =>
      query.includes("DELETE FROM session_artifact_links")
    );
    assert.ok(deleteQuery);
    assert.equal(deleteQuery.query.includes("method NOT IN"), true);
    assert.equal(deleteQuery.params?.[0], "launch-link");
    assert.equal(
      deleteQuery.params?.includes(LAUNCH_METADATA_REF_METHOD),
      true
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill does not mark seen after partial link persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-partial-"));
  const transcriptPath = join(dir, "partial.jsonl");
  const queries: string[] = [];
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({
      existingSessionIds: ["partial"],
      failArtifactInsert: true,
      onQuery: (query) => {
        queries.push(query);
      },
    });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      parseSessionFile: () =>
        Promise.resolve(
          makeSession("partial", {
            toolUses: [
              {
                name: "mcp__closedloop__get_document",
                timestamp: "2026-06-07T12:01:00.000Z",
                input: { documentId: "FEA-1967" },
              },
            ],
          })
        ),
    });

    assert.equal(result.errors, 1);
    assert.equal(
      queries.some((query) =>
        query.includes("INSERT INTO artifact_link_backfill_seen")
      ),
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill stops after seen-cache lookup when cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-seen-cancel-"));
  const transcriptPath = join(dir, "seen-cancel.jsonl");
  let shouldContinueCalls = 0;
  let parseCalls = 0;
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({ existingSessionIds: ["seen-cancel"] });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      shouldContinue: () => ++shouldContinueCalls === 1,
      parseSessionFile: () => {
        parseCalls++;
        return Promise.resolve(makeSession("seen-cancel"));
      },
    });

    assert.equal(result.scanned, 0);
    assert.equal(parseCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill default transcript listing rejects symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-symlink-"));
  const outsideDir = mkdtempSync(
    join(tmpdir(), "artifact-backfill-symlink-out-")
  );
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const parseCalls: string[] = [];
  try {
    const projectDir = join(dir, "projects", "encoded-project");
    mkdirSync(projectDir, { recursive: true });
    const realTranscript = join(projectDir, "real.jsonl");
    const outsideTranscript = join(outsideDir, "outside.jsonl");
    const linkedTranscript = join(projectDir, "linked.jsonl");
    writeFileSync(realTranscript, "{}\n");
    writeFileSync(outsideTranscript, "{}\n");
    symlinkSync(outsideTranscript, linkedTranscript);
    process.env.CLAUDE_HOME = dir;
    const db = fakeBackfillDb({ existingSessionIds: ["real"] });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      parseSessionFile: (filePath) => {
        parseCalls.push(filePath);
        return Promise.resolve(makeSession("real"));
      },
    });

    assert.equal(result.scanned, 1);
    assert.deepEqual(parseCalls, [realTranscript]);
  } finally {
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("artifact-link backfill stops before parsing when cancellation hook is false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-cancel-"));
  const transcriptPath = join(dir, "cancelled.jsonl");
  let parseCalls = 0;
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb();

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      shouldContinue: () => false,
      parseSessionFile: () => {
        parseCalls++;
        return Promise.resolve(makeSession("cancelled"));
      },
    });

    assert.equal(result.scanned, 0);
    assert.equal(parseCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill skips transcripts whose session is not imported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-missing-session-"));
  const transcriptPath = join(dir, "not-imported.jsonl");
  let parseCalls = 0;
  try {
    writeFileSync(transcriptPath, "{}\n");
    // sessions table is empty — the session has no FK target yet.
    const db = fakeBackfillDb({ existingSessionIds: [] });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      parseSessionFile: () => {
        parseCalls++;
        return Promise.resolve(makeSession("not-imported"));
      },
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.scanned, 0);
    assert.equal(result.errors, 0);
    assert.equal(parseCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(
  sessionId: string,
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return {
    sessionId,
    name: sessionId,
    cwd: "/workspace/project",
    model: "gpt-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: Harness.Claude,
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    artifacts: {
      prs: [],
      issues: [],
      repo: null,
    },
    ...overrides,
  };
}

function fakeBackfillDb(options?: {
  onQuery?: (query: string, params?: unknown[]) => void;
  failArtifactInsert?: boolean;
  /** session ids present in the `sessions` table (drives the FK existence guard). */
  existingSessionIds?: string[];
}): DesktopPrisma {
  const sessionRows = (options?.existingSessionIds ?? []).map((id) => ({ id }));
  // Route every read/write through one string-matching responder so the tests
  // can intercept queries (via onQuery) and drive the FK-existence guard
  // (existingSessionIds) and the partial-persist failure (failArtifactInsert)
  // exactly as the legacy SqliteExecutor mock did — now over the DesktopPrisma
  // surface the converted backfill calls (`client.$queryRawUnsafe` for reads,
  // `write(client => client.$transaction(tx => tx.$executeRawUnsafe(...)))` for
  // the rederive / seen / marker-touch writes).
  const run = (query: string, params: unknown[]): Promise<unknown[]> => {
    options?.onQuery?.(query, params);
    // The link INSERT is the partial-persist failure point under test. Rejecting
    // it only exercises the intended path if the per-ref artifact upsert above
    // succeeds first (otherwise persistArtifactLinks throws on the empty
    // RETURNING result before the link INSERT ever runs), which is why the
    // artifact-upsert branch below returns a row.
    if (
      options?.failArtifactInsert &&
      query.includes("INSERT INTO session_artifact_links")
    ) {
      return Promise.reject(new Error("insert failed"));
    }
    if (query.includes("SELECT id FROM sessions")) {
      return Promise.resolve(sessionRows);
    }
    // The artifact upsert returns its row id via RETURNING; persistArtifactLinks
    // calls requireArtifactUpsertId, which throws (caught per-ref, leaving
    // captured at 0) on an empty result. Hand back a row so the link INSERT —
    // the real partial-persist path — is reached.
    if (query.includes("INSERT INTO artifacts")) {
      return Promise.resolve([{ id: "artifact-id" }]);
    }
    return Promise.resolve([]);
  };
  const queryRawUnsafe = (query: string, ...params: unknown[]) =>
    run(query, params);
  const executeRawUnsafe = (query: string, ...params: unknown[]) =>
    run(query, params).then(() => 0);
  const tx = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
  };
  const writeClient = {
    ...tx,
    $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  return {
    client: { $queryRawUnsafe: queryRawUnsafe },
    write: (fn: (client: typeof writeClient) => unknown) => fn(writeClient),
    disconnect: () => Promise.resolve(),
  } as unknown as DesktopPrisma;
}
