import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backfillArtifactLinksFromTranscripts } from "../src/main/collectors/parsing/artifact-link-backfill.js";
import {
  EXTRACTOR_VERSION,
  LAUNCH_METADATA_REF_METHOD,
} from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

// Column count of the `artifacts` upsert in write-core.ts. The fake artifacts
// responder echoes the id (first column) of every 14-column VALUES tuple so
// resolution flows end to end through the batched persist path.
const ARTIFACT_UPSERT_COLUMN_COUNT = 14;

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

test("artifact-link backfill skips a transcript already seen at its current mtime (BigInt column)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-seen-bigint-"));
  try {
    const db = await openTestDb(dir);
    try {
      // A real, imported session: the FK target plus an existingSessionIds member.
      await db.run(
        `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
         VALUES ($1, 'completed', $2, $2, 'claude', 'api')`,
        "seen-bigint",
        "2026-06-07T12:00:00.000Z"
      );

      const transcriptPath = join(dir, "seen-bigint.jsonl");
      writeFileSync(transcriptPath, "{}\n");
      // Pin a deterministic mtime far above 2^31 so the value round-trips through
      // the BIGINT column rather than a small INTEGER.
      const mtimeSeconds = 1_700_000_000;
      utimesSync(transcriptPath, mtimeSeconds, mtimeSeconds);
      const flooredMtimeMs = Math.floor(statSync(transcriptPath).mtimeMs);

      // What a prior boot wrote: seen at the current mtime + extractor version.
      // file_mtime_ms is a BIGINT column, so a raw read returns a JS bigint;
      // without normalization the `bigint === number` skip check is always false
      // and the transcript would be re-parsed every boot.
      await db.run(
        `INSERT INTO artifact_link_backfill_seen
           (session_id, file_path, file_mtime_ms, extractor_version, scanned_at)
         VALUES ($1, $2, $3, $4, $5)`,
        "seen-bigint",
        transcriptPath,
        flooredMtimeMs,
        EXTRACTOR_VERSION,
        "2026-06-07T12:00:00.000Z"
      );

      let parseCalls = 0;
      const result = await backfillArtifactLinksFromTranscripts(db.prisma, {
        listTranscriptFiles: () => [transcriptPath],
        sessionIdFromPath: () => "seen-bigint",
        parseSessionFile: () => {
          parseCalls++;
          return Promise.resolve(makeSession("seen-bigint"));
        },
      });

      assert.equal(
        result.skipped,
        1,
        "a transcript already seen at its current mtime must be skipped"
      );
      assert.equal(result.scanned, 0);
      assert.equal(parseCalls, 0, "a skipped transcript must not be parsed");
    } finally {
      await db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill refreshes the repo resolver mid-sweep so repos captured after it starts still resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-repo-refresh-"));
  // The refresh fires on the same cadence as the cooperative yield (every 50
  // transcripts). Process enough transcripts that at least one refresh runs, so
  // a session handled after it sees the mid-sweep repo capture.
  const transcriptCount = 60;
  const sessionIds = Array.from(
    { length: transcriptCount },
    (_, i) => `repo-refresh-${i}`
  );
  const transcriptPaths = sessionIds.map((id) => join(dir, `${id}.jsonl`));
  const capturedRepo = "closedloop-ai/symphony-alpha";
  // `git_dir` basename ("symphony-alpha") is what resolves the bare ref below.
  const capturedGitDir = "/home/dev/Workspace/symphony-alpha/.git";
  // artifacts INSERT params: [artifactId, identityKey, kind, repoFullName, gitDir, ...].
  const insertedRepoNames: Array<string | null> = [];
  try {
    for (const path of transcriptPaths) {
      writeFileSync(path, "{}\n");
    }
    const db = fakeBackfillDb({
      existingSessionIds: sessionIds,
      // Build 1 (up-front snapshot) sees no repos — the repo is captured
      // fire-and-forget from onPostImport only AFTER the sweep starts. Build 2+
      // (the cadence refresh) sees it.
      reposForBuild: (buildNumber) =>
        buildNumber >= 2
          ? [{ repo_full_name: capturedRepo, git_dir: capturedGitDir }]
          : [],
      onQuery: (query, params) => {
        if (query.includes("INSERT INTO artifacts")) {
          insertedRepoNames.push((params?.[3] as string | null) ?? null);
        }
      },
    });

    const sessionById = new Map(
      sessionIds.map((id) => [
        id,
        makeSession(id, {
          // A bare repo name + a (non-default) branch produces a `start_branch`
          // branch ref whose repoFullName is the bare "symphony-alpha", which the
          // resolver canonicalizes once the repo row exists.
          gitBranch: "feat/repo-refresh",
          artifacts: { prs: [], issues: [], repo: "symphony-alpha" },
        }),
      ])
    );

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => transcriptPaths,
      sessionIdFromPath: (filePath) =>
        filePath.split("/").at(-1)?.replace(".jsonl", "") ?? "",
      parseSessionFile: (filePath) => {
        const id = filePath.split("/").at(-1)?.replace(".jsonl", "") ?? "";
        return Promise.resolve(sessionById.get(id) ?? null);
      },
    });

    assert.equal(result.scanned, transcriptCount);
    assert.equal(result.errors, 0);
    // Once the mid-sweep refresh lands the repo, later sessions resolve the bare
    // "symphony-alpha" ref to its canonical owner/repo. A once-at-start snapshot
    // would leave EVERY row bare, so the canonical name never appearing is the
    // regression this guards.
    assert.ok(
      insertedRepoNames.includes(capturedRepo),
      "a repo captured mid-sweep must be resolved to canonical owner/repo after the resolver refresh"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill leaves a session unseen when its bare repo can't be resolved yet (FEA-2875)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-unresolved-bare-"));
  const transcriptPath = join(dir, "unresolved.jsonl");
  const seenSessionIds: Array<string | null> = [];
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({
      existingSessionIds: ["unresolved"],
      // `repos` never contains the bare "symphony-alpha", so it stays unresolved
      // for every resolver build and the write path null-drops it (FEA-2866).
      reposForBuild: () => [],
      onQuery: (query, params) => {
        if (query.includes("INSERT INTO artifact_link_backfill_seen")) {
          seenSessionIds.push((params?.[0] as string | null) ?? null);
        }
      },
    });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      sessionIdFromPath: () => "unresolved",
      parseSessionFile: () =>
        Promise.resolve(
          makeSession("unresolved", {
            gitBranch: "feat/unresolved",
            artifacts: { prs: [], issues: [], repo: "symphony-alpha" },
          })
        ),
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.errors, 0);
    assert.ok(
      result.captured > 0,
      "the artifact still persists (with a null repo_full_name)"
    );
    // The seen-stamp would otherwise make the seen-guard skip this session on
    // every later boot — even after the repo lands in `repos` — and the repair
    // sweep can't rescue a NULL repo_full_name. Leaving it unseen is the retry
    // path this fix restores.
    assert.ok(
      !seenSessionIds.includes("unresolved"),
      "a session whose bare repo was null-dropped must be left unseen so a later sweep retries it"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-link backfill still marks a session seen once its bare repo resolves (FEA-2875)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-backfill-resolved-bare-"));
  const transcriptPath = join(dir, "resolved.jsonl");
  const seenSessionIds: Array<string | null> = [];
  try {
    writeFileSync(transcriptPath, "{}\n");
    const db = fakeBackfillDb({
      existingSessionIds: ["resolved"],
      // The repo is already in `repos`, so the bare "symphony-alpha" resolves to
      // its canonical owner/repo and nothing is dropped.
      reposForBuild: () => [
        {
          repo_full_name: "closedloop-ai/symphony-alpha",
          git_dir: "/home/dev/Workspace/symphony-alpha/.git",
        },
      ],
      onQuery: (query, params) => {
        if (query.includes("INSERT INTO artifact_link_backfill_seen")) {
          seenSessionIds.push((params?.[0] as string | null) ?? null);
        }
      },
    });

    const result = await backfillArtifactLinksFromTranscripts(db, {
      listTranscriptFiles: () => [transcriptPath],
      sessionIdFromPath: () => "resolved",
      parseSessionFile: () =>
        Promise.resolve(
          makeSession("resolved", {
            gitBranch: "feat/resolved",
            artifacts: { prs: [], issues: [], repo: "symphony-alpha" },
          })
        ),
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.errors, 0);
    // A fully-resolved session must still be stamped seen — the FEA-2875 guard
    // must not regress the seen-cache for the common (resolvable) case.
    assert.ok(
      seenSessionIds.includes("resolved"),
      "a session whose bare repo resolves must be marked seen"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(
  sessionId: string,
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/workspace/project",
    model: "gpt-5",
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    entrypoint: Harness.Claude,
    ...overrides,
  });
}

type ReposRow = { repo_full_name: string; git_dir: string };

function fakeBackfillDb(options?: {
  onQuery?: (query: string, params?: unknown[]) => void;
  failArtifactInsert?: boolean;
  /** session ids present in the `sessions` table (drives the FK existence guard). */
  existingSessionIds?: string[];
  /**
   * Rows returned by each successive `SELECT … FROM repos` (the `buildRepoResolver`
   * source). Simulates the `repos` table changing mid-sweep: the 1-based index is
   * the resolver-build number, so `reposForBuild(1)` is the up-front build and
   * `reposForBuild(2)` is the first cadence refresh. Defaults to empty (the
   * pre-FEA-2777 fakes returned `[]` for every read that wasn't special-cased).
   */
  reposForBuild?: (buildNumber: number) => ReposRow[];
}): DesktopPrisma {
  const sessionRows = (options?.existingSessionIds ?? []).map((id) => ({ id }));
  let repoResolverBuilds = 0;
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
    // buildRepoResolver's read. Each invocation advances the build counter so a
    // test can hand back a different repos snapshot per resolver build and prove
    // the sweep picks up a repo captured mid-sweep.
    if (query.includes("FROM repos")) {
      repoResolverBuilds++;
      return Promise.resolve(
        options?.reposForBuild?.(repoResolverBuilds) ?? []
      );
    }
    // The artifact upsert returns its row id via RETURNING; persistArtifactLinks
    // calls requireArtifactUpsertId, which throws (caught per-ref, leaving
    // captured at 0) on an empty result, and the batched path only links refs
    // whose RETURNING id matches the computed artifactId. Echo back the id of
    // each row (the first column of every 14-column tuple) so resolution flows
    // through end to end; the link INSERT — the real partial-persist path — is
    // still reached for the failArtifactInsert case.
    if (query.includes("INSERT INTO artifacts")) {
      const ids: Array<{ id: string }> = [];
      for (let i = 0; i < params.length; i += ARTIFACT_UPSERT_COLUMN_COUNT) {
        ids.push({ id: params[i] as string });
      }
      return Promise.resolve(ids);
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
