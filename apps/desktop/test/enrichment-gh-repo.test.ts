/**
 * @file enrichment-gh-repo.test.ts
 * @description FEA-1899 Desktop KLOC Attribution Engine — I/O-boundary helpers:
 *   - gh-enrichment.ts: `gh` CLI invocation + JSON parsing/mapping.
 *   - repo-identity.ts: SQLite-backed repo/worktree resolution that gates which
 *     local cwds Desktop will run git against.
 *
 * `gitExec` is an ESM named import resolved at module-eval time, so
 * `mock.method()` cannot intercept it across the boundary (see the note in
 * codex-spawn-enoent.test.ts). Instead the gh tests point `ghPath` at a throwaway
 * executable that emits canned `gh` output, exercising the real gitExec → parse
 * path end-to-end.
 *
 * repo-identity + historical-backfill run on the single `DesktopPrisma` client —
 * typed delegates for the reads
 * (`resolveRepoForCwd`/`resolveRepoByFullName`/`isKnownRepoPath`) and raw
 * `$queryRawUnsafe`/`$executeRawUnsafe` (inside `prisma.write`) only for the
 * COALESCE-preserve upserts (`upsertRepo` RETURNING / `upsertWorktree`) and the
 * historical-backfill candidate anti-join. The repo-identity tests build
 * `DesktopPrisma` via the shared `openTestPrisma` helper (electron-free, runs
 * locally AND in CI) and exercise
 * the conversion: the typed resolvers, the RETURNING upsert via a real `git init`
 * repo, and the candidate anti-join excluding already-mapped session cwds.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  ghGetCommitStats,
  ghGetPrMetadata,
  ghListPrForBranch,
  isGhAvailable,
  isGitHubRepoFullName,
  resetGhCache,
} from "../src/main/enrichment/gh-enrichment.js";
import { runHistoricalBackfill } from "../src/main/enrichment/historical-backfill.js";
import {
  captureRepoIdentity,
  cwdExists,
  isKnownRepoPath,
  resolveRepoByFullName,
  resolveRepoForCwd,
} from "../src/main/enrichment/repo-identity.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fake `gh`/`git` binary harness
// ---------------------------------------------------------------------------

/**
 * Write a throwaway executable into `dir` that prints `stdout` and exits with
 * `exitCode`. Real `gitExec` spawns it, so the production parse path runs
 * verbatim. Returns the absolute path to hand to the function under test as its
 * `ghPath`.
 */
async function writeFakeBinary(
  dir: string,
  name: string,
  stdout: string,
  exitCode = 0
): Promise<string> {
  const file = path.join(dir, name);
  // base64 the payload so arbitrary JSON (quotes, newlines) survives the shell.
  const encoded = Buffer.from(stdout, "utf8").toString("base64");
  await writeFile(
    file,
    `#!/usr/bin/env bash\nprintf '%s' '${encoded}' | base64 -d\nexit ${exitCode}\n`
  );
  await chmod(file, 0o755);
  return file;
}

async function writeCountingFailureBinary(
  dir: string,
  name: string,
  countFile: string,
  stderr: string
): Promise<string> {
  const file = path.join(dir, name);
  const encoded = Buffer.from(stderr, "utf8").toString("base64");
  await writeFile(
    file,
    [
      "#!/usr/bin/env bash",
      `count="$(cat '${countFile}' 2>/dev/null || true)"`,
      'if [ -z "$count" ]; then count=0; fi',
      `printf '%s\\n' "$((count + 1))" > '${countFile}'`,
      `printf '%s' '${encoded}' | base64 -d >&2`,
      "exit 1",
      "",
    ].join("\n")
  );
  await chmod(file, 0o755);
  return file;
}

async function writeCountingSuccessBinary(
  dir: string,
  name: string,
  countFile: string,
  stdout: string
): Promise<string> {
  const file = path.join(dir, name);
  const encoded = Buffer.from(stdout, "utf8").toString("base64");
  await writeFile(
    file,
    [
      "#!/usr/bin/env bash",
      `count="$(cat '${countFile}' 2>/dev/null || true)"`,
      'if [ -z "$count" ]; then count=0; fi',
      `printf '%s\\n' "$((count + 1))" > '${countFile}'`,
      `printf '%s' '${encoded}' | base64 -d`,
      "exit 0",
      "",
    ].join("\n")
  );
  await chmod(file, 0o755);
  return file;
}

async function writeSequentialSuccessBinary(
  dir: string,
  name: string,
  countFile: string,
  stdoutByCall: readonly string[]
): Promise<string> {
  const file = path.join(dir, name);
  const cases = stdoutByCall.map((stdout, index) => {
    const encoded = Buffer.from(stdout, "utf8").toString("base64");
    return `${index + 1}) printf '%s' '${encoded}' | base64 -d ;;`;
  });
  const fallback = Buffer.from(stdoutByCall.at(-1) ?? "", "utf8").toString(
    "base64"
  );
  await writeFile(
    file,
    [
      "#!/usr/bin/env bash",
      `count="$(cat '${countFile}' 2>/dev/null || true)"`,
      'if [ -z "$count" ]; then count=0; fi',
      'next="$((count + 1))"',
      `printf '%s\\n' "$next" > '${countFile}'`,
      'case "$next" in',
      ...cases,
      `*) printf '%s' '${fallback}' | base64 -d ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  await chmod(file, 0o755);
  return file;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1899-ghrepo-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// isGitHubRepoFullName (pure)
// ---------------------------------------------------------------------------

test("isGitHubRepoFullName: accepts canonical owner/repo", () => {
  assert.equal(isGitHubRepoFullName("closedloop-ai/symphony-alpha"), true);
});

test("isGitHubRepoFullName: accepts dots and underscores in segments", () => {
  assert.equal(isGitHubRepoFullName("my.org_1/repo.name_2"), true);
});

test("isGitHubRepoFullName: rejects nested GitLab-style subgroup path", () => {
  assert.equal(isGitHubRepoFullName("group/subgroup/repo"), false);
});

test("isGitHubRepoFullName: rejects bare owner with no repo", () => {
  assert.equal(isGitHubRepoFullName("justowner"), false);
});

test("isGitHubRepoFullName: rejects segment with a space", () => {
  assert.equal(isGitHubRepoFullName("org/re po"), false);
});

test("isGitHubRepoFullName: rejects null", () => {
  assert.equal(isGitHubRepoFullName(null), false);
});

test("isGitHubRepoFullName: rejects undefined", () => {
  assert.equal(isGitHubRepoFullName(undefined), false);
});

test("isGitHubRepoFullName: rejects empty string", () => {
  assert.equal(isGitHubRepoFullName(""), false);
});

// ---------------------------------------------------------------------------
// ghGetPrMetadata
// ---------------------------------------------------------------------------

test("ghGetPrMetadata: parses a merged PR with full fields", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({
        state: "MERGED",
        additions: 100,
        deletions: 20,
        changedFiles: 5,
        mergeCommit: { oid: "abc1234def" },
        baseRefName: "main",
        createdAt: "2026-06-01T08:00:00.000Z",
        mergedAt: "2026-06-02T09:30:00.000Z",
        closedAt: "2026-06-02T09:30:00.000Z",
      })
    );
    const result = await ghGetPrMetadata(gh, "org/repo", 42);
    assert.deepEqual(result, {
      prState: "merged",
      additions: 100,
      deletions: 20,
      changedFiles: 5,
      mergeCommitSha: "abc1234def",
      baseRefName: "main",
      headRefName: null,
      openedAt: "2026-06-01T08:00:00.000Z",
      // The AUTHORITATIVE GitHub merge/close instants flow through verbatim —
      // these become the branch's "last active", so they must be the real times.
      mergedAt: "2026-06-02T09:30:00.000Z",
      closedAt: "2026-06-02T09:30:00.000Z",
    });
  });
});

test("ghGetPrMetadata: maps CLOSED state and tolerates a null mergeCommit", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({
        state: "CLOSED",
        additions: 3,
        deletions: 1,
        changedFiles: 2,
        mergeCommit: null,
        baseRefName: "develop",
        closedAt: "2026-05-20T12:00:00.000Z",
      })
    );
    const result = await ghGetPrMetadata(gh, "org/repo", 7);
    assert.equal(result?.prState, "closed");
    assert.equal(result?.mergeCommitSha, null);
    assert.equal(result?.baseRefName, "develop");
    // A closed-not-merged PR carries a real closedAt but no mergedAt.
    assert.equal(result?.closedAt, "2026-05-20T12:00:00.000Z");
    assert.equal(result?.mergedAt, null);
  });
});

test("ghGetPrMetadata: maps OPEN state and defaults absent numeric fields to 0", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ state: "OPEN" })
    );
    const result = await ghGetPrMetadata(gh, "org/repo", 1);
    assert.deepEqual(result, {
      prState: "open",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      mergeCommitSha: null,
      baseRefName: null,
      headRefName: null,
      openedAt: null,
      mergedAt: null,
      closedAt: null,
    });
  });
});

test("ghGetPrMetadata: treats the Go zero time as absent merge/close (no synthesized instant)", async () => {
  await withTmpDir(async (dir) => {
    // `gh ... --json mergedAt,closedAt` emits the Go zero time for unset fields in
    // some versions; it must NOT be persisted as a real lifecycle timestamp.
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({
        state: "OPEN",
        createdAt: "2026-06-01T08:00:00.000Z",
        mergedAt: "0001-01-01T00:00:00Z",
        closedAt: "0001-01-01T00:00:00Z",
      })
    );
    const result = await ghGetPrMetadata(gh, "org/repo", 5);
    assert.equal(result?.openedAt, "2026-06-01T08:00:00.000Z");
    assert.equal(result?.mergedAt, null);
    assert.equal(result?.closedAt, null);
  });
});

test("ghGetPrMetadata: keeps explicit JSON null merge/close times null", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ state: "OPEN", mergedAt: null, closedAt: null })
    );
    const result = await ghGetPrMetadata(gh, "org/repo", 6);
    assert.equal(result?.mergedAt, null);
    assert.equal(result?.closedAt, null);
  });
});

test("ghGetPrMetadata: unknown state string falls back to open", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ state: "DRAFT" })
    );
    const result = await ghGetPrMetadata(gh, "org/repo", 1);
    assert.equal(result?.prState, "open");
  });
});

test("ghGetPrMetadata: returns null on non-zero exit", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "no such PR", 1);
    const result = await ghGetPrMetadata(gh, "org/repo", 999);
    assert.equal(result, null);
  });
});

test("ghGetPrMetadata: returns null on malformed JSON (exit 0)", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "not json at all");
    const result = await ghGetPrMetadata(gh, "org/repo", 1);
    assert.equal(result, null);
  });
});

test("ghGetPrMetadata: does not fall back to REST when bundled GraphQL is rate limited", async () => {
  await withTmpDir(async (dir) => {
    const countFile = path.join(dir, "gh-count");
    const gh = await writeCountingFailureBinary(
      dir,
      "gh",
      countFile,
      "API rate limit exceeded"
    );

    const result = await ghGetPrMetadata(gh, "org/repo", 42);

    assert.equal(result, null);
    assert.equal(await readFile(countFile, "utf8"), "1\n");
  });
});

test("ghGetPrMetadata: does not fall back to REST when bundled GraphQL is low budget and omits the PR", async () => {
  await withTmpDir(async (dir) => {
    const countFile = path.join(dir, "gh-count");
    const gh = await writeCountingSuccessBinary(
      dir,
      "gh",
      countFile,
      JSON.stringify({
        rateLimit: {
          cost: 1,
          remaining: 1,
          resetAt: "2026-07-03T02:00:00Z",
        },
        repository: { pullRequests: { nodes: [] } },
      })
    );

    const result = await ghGetPrMetadata(gh, "org/repo", 42);

    assert.equal(result, null);
    assert.equal(await readFile(countFile, "utf8"), "1\n");
  });
});

test("ghGetPrMetadata: falls back to exact gh view when bounded bundled scan misses the target", async () => {
  await withTmpDir(async (dir) => {
    const countFile = path.join(dir, "gh-count");
    const gh = await writeSequentialSuccessBinary(dir, "gh", countFile, [
      JSON.stringify({
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-07-03T02:00:00Z",
        },
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-500" },
            nodes: Array.from({ length: 500 }, (_, index) => ({
              id: `PR_${index + 1}`,
              number: index + 1,
              title: `Newer PR ${index + 1}`,
              url: `https://github.com/org/repo/pull/${index + 1}`,
            })),
          },
        },
      }),
      JSON.stringify({
        state: "MERGED",
        additions: 12,
        deletions: 4,
        changedFiles: 3,
        mergeCommit: { oid: "merged-sha" },
        baseRefName: "main",
        headRefName: "feature/old-target",
        createdAt: "2026-01-01T08:00:00.000Z",
        mergedAt: "2026-01-02T09:30:00.000Z",
        closedAt: "2026-01-02T09:30:00.000Z",
      }),
    ]);

    const result = await ghGetPrMetadata(gh, "org/repo", 750);

    assert.deepEqual(result, {
      prState: "merged",
      additions: 12,
      deletions: 4,
      changedFiles: 3,
      mergeCommitSha: "merged-sha",
      baseRefName: "main",
      headRefName: "feature/old-target",
      openedAt: "2026-01-01T08:00:00.000Z",
      mergedAt: "2026-01-02T09:30:00.000Z",
      closedAt: "2026-01-02T09:30:00.000Z",
    });
    assert.equal(await readFile(countFile, "utf8"), "2\n");
  });
});

test("ghGetPrMetadata: preserves openedAt from bundled GraphQL createdAt", async () => {
  await withTmpDir(async (dir) => {
    const countFile = path.join(dir, "gh-count");
    const gh = await writeCountingSuccessBinary(
      dir,
      "gh",
      countFile,
      JSON.stringify({
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-07-03T02:00:00Z",
        },
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_42",
                number: 42,
                title: "GraphQL PR",
                url: "https://github.com/org/repo/pull/42",
                state: "OPEN",
                isDraft: false,
                additions: 10,
                deletions: 3,
                changedFiles: 2,
                createdAt: "2026-06-01T08:00:00.000Z",
                baseRefName: "main",
                headRefName: "feature",
                headRefOid: "abc123",
              },
            ],
          },
        },
      })
    );

    const result = await ghGetPrMetadata(gh, "org/repo", 42);

    assert.equal(result?.openedAt, "2026-06-01T08:00:00.000Z");
    assert.equal(await readFile(countFile, "utf8"), "1\n");
  });
});

// ---------------------------------------------------------------------------
// ghGetCommitStats
// ---------------------------------------------------------------------------

test("ghGetCommitStats: parses additions/deletions/files into a final git_api result", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ additions: 30, deletions: 12, files: 4 })
    );
    const result = await ghGetCommitStats(gh, "org/repo", "deadbeef");
    assert.deepEqual(result, {
      stats: { linesAdded: 30, linesRemoved: 12, filesChanged: 4 },
      state: "final",
      source: "gh_api",
    });
  });
});

test("ghGetCommitStats: non-numeric files coerces filesChanged to 0", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ additions: 5, deletions: 0, files: null })
    );
    const result = await ghGetCommitStats(gh, "org/repo", "cafe123");
    assert.equal(result?.stats?.filesChanged, 0);
    assert.equal(result?.stats?.linesAdded, 5);
  });
});

test("ghGetCommitStats: returns null when additions is not a number", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ additions: null, deletions: 1, files: 1 })
    );
    const result = await ghGetCommitStats(gh, "org/repo", "abc1234");
    assert.equal(result, null);
  });
});

test("ghGetCommitStats: returns null on non-zero exit", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "404", 1);
    const result = await ghGetCommitStats(gh, "org/repo", "abc1234");
    assert.equal(result, null);
  });
});

test("ghGetCommitStats: returns null on malformed JSON", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "<<garbage>>");
    const result = await ghGetCommitStats(gh, "org/repo", "abc1234");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// ghListPrForBranch
// ---------------------------------------------------------------------------

test("ghListPrForBranch: maps each PR row with state mapping and numeric defaults", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify([
        { number: 10, state: "MERGED", additions: 50, deletions: 5 },
        { number: 11, state: "OPEN" },
      ])
    );
    const result = await ghListPrForBranch(gh, "org/repo", "feat/x");
    assert.deepEqual(result, [
      { prNumber: 10, state: "merged", additions: 50, deletions: 5 },
      { prNumber: 11, state: "open", additions: 0, deletions: 0 },
    ]);
  });
});

test("ghListPrForBranch: empty array yields empty result", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "[]");
    const result = await ghListPrForBranch(gh, "org/repo", "feat/none");
    assert.deepEqual(result, []);
  });
});

test("ghListPrForBranch: non-array JSON returns null", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(
      dir,
      "gh",
      JSON.stringify({ not: "an array" })
    );
    const result = await ghListPrForBranch(gh, "org/repo", "feat/x");
    assert.equal(result, null);
  });
});

test("ghListPrForBranch: returns null on non-zero exit", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "error", 1);
    const result = await ghListPrForBranch(gh, "org/repo", "feat/x");
    assert.equal(result, null);
  });
});

test("ghListPrForBranch: returns null on malformed JSON", async () => {
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "{broken");
    const result = await ghListPrForBranch(gh, "org/repo", "feat/x");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// isGhAvailable / resetGhCache (cache TTL behaviour)
// ---------------------------------------------------------------------------

test("isGhAvailable: true when `gh auth status` exits 0", async () => {
  resetGhCache();
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "Logged in", 0);
    assert.equal(await isGhAvailable(gh), true);
  });
  resetGhCache();
});

test("isGhAvailable: false when `gh auth status` exits non-zero", async () => {
  resetGhCache();
  await withTmpDir(async (dir) => {
    const gh = await writeFakeBinary(dir, "gh", "not logged in", 1);
    assert.equal(await isGhAvailable(gh), false);
  });
  resetGhCache();
});

test("isGhAvailable: false when the binary cannot be spawned", async () => {
  resetGhCache();
  // Nonexistent path: gitExec rethrows the spawn error, which isGhAvailable
  // swallows into a cached `false`.
  assert.equal(await isGhAvailable("/nonexistent/definitely/not/gh"), false);
  resetGhCache();
});

test("isGhAvailable: caches the first result within the TTL window", async () => {
  resetGhCache();
  await withTmpDir(async (dir) => {
    // First check sees a logged-in gh and caches `true`.
    const ghOk = await writeFakeBinary(dir, "gh", "Logged in", 0);
    assert.equal(await isGhAvailable(ghOk), true);

    // Point at a binary that would report failure. Because the cached value is
    // still fresh, isGhAvailable must NOT re-spawn and must keep returning true.
    const ghFail = await writeFakeBinary(dir, "gh-fail", "nope", 1);
    assert.equal(await isGhAvailable(ghFail), true);
  });
  resetGhCache();
});

test("isGhAvailable: resetGhCache forces a fresh re-check", async () => {
  resetGhCache();
  await withTmpDir(async (dir) => {
    const ghOk = await writeFakeBinary(dir, "gh", "Logged in", 0);
    assert.equal(await isGhAvailable(ghOk), true);

    // After a reset the cache is cold, so the next call re-runs the (now
    // failing) check and flips to false.
    resetGhCache();
    const ghFail = await writeFakeBinary(dir, "gh-fail", "nope", 1);
    assert.equal(await isGhAvailable(ghFail), false);
  });
  resetGhCache();
});

// ---------------------------------------------------------------------------
// repo-identity: SQLite-backed resolution helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-18T00:00:00.000Z";

// repo-identity runs on the single `DesktopPrisma` client, so this harness uses
// the shared `openTestPrisma` — which builds the client over a migrated libSQL
// file with the PRODUCTION `createWriteQueue` (electron-free, so it runs locally
// AND in the node-test job). The functions under test read/write through
// `db.prisma`; seeding/assertion SQL uses the raw `db.store` handle on the SAME
// file (WAL → cross-connection
// visibility), as in production.
type TestDb = { prisma: OpenTestPrisma["prisma"]; store: OpenTestPrisma["db"] };

async function withDb(fn: (db: TestDb) => Promise<void>): Promise<void> {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await fn({ prisma, store });
  } finally {
    await close();
  }
}

async function seedRepo(
  db: TestDb,
  opts: {
    id: string;
    gitDir: string;
    repoFullName?: string | null;
    defaultBranch?: string | null;
    remoteUrl?: string | null;
  }
): Promise<void> {
  await db.store.query(
    `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      opts.id,
      opts.gitDir,
      opts.remoteUrl ?? null,
      opts.repoFullName ?? null,
      opts.defaultBranch ?? null,
      NOW,
    ]
  );
}

async function seedWorktree(
  db: TestDb,
  opts: {
    id: string;
    repoId: string;
    worktreePath: string;
    branchName?: string | null;
  }
): Promise<void> {
  await db.store.query(
    `INSERT INTO repo_worktrees (id, repo_id, worktree_path, branch_name, last_seen_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.id, opts.repoId, opts.worktreePath, opts.branchName ?? null, NOW]
  );
}

// --- isKnownRepoPath ---

test("isKnownRepoPath: true when path matches a repo git_dir exactly", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    assert.equal(await isKnownRepoPath(db.prisma, "/home/u/proj/.git"), true);
  });
});

test("isKnownRepoPath: true when path is the worktree root of a repo (path/.git)", async () => {
  await withDb(async (db) => {
    // Repo stored with the .git suffix; passing the working-tree root must match
    // via the `${path}/.git` arm.
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    assert.equal(await isKnownRepoPath(db.prisma, "/home/u/proj"), true);
  });
});

test("isKnownRepoPath: true when path matches a registered worktree_path", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    await seedWorktree(db, {
      id: "w1",
      repoId: "r1",
      worktreePath: "/home/u/proj-feature",
    });
    assert.equal(
      await isKnownRepoPath(db.prisma, "/home/u/proj-feature"),
      true
    );
  });
});

test("isKnownRepoPath: false for an unknown path", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    assert.equal(
      await isKnownRepoPath(db.prisma, "/some/unrelated/path"),
      false
    );
  });
});

// --- resolveRepoForCwd ---

test("resolveRepoForCwd: resolves via an exact worktree_path match", async () => {
  await withDb(async (db) => {
    await seedRepo(db, {
      id: "r1",
      gitDir: "/home/u/proj/.git",
      repoFullName: "org/proj",
    });
    await seedWorktree(db, {
      id: "w1",
      repoId: "r1",
      worktreePath: "/home/u/proj-feature",
    });
    const repo = await resolveRepoForCwd(db.prisma, "/home/u/proj-feature");
    assert.equal(repo?.id, "r1");
    assert.equal(repo?.repo_full_name, "org/proj");
    // Pin the camelCase→snake_case `git_dir` mapping (toRepoRow) — the field
    // historical-backfill consumes downstream.
    assert.equal(repo?.git_dir, "/home/u/proj/.git");
  });
});

test("resolveRepoForCwd: walks ancestors to find the repo by git_dir", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    // cwd is a nested subdir; the ancestor walk reaches /home/u/proj → .git.
    const repo = await resolveRepoForCwd(
      db.prisma,
      "/home/u/proj/packages/app/src"
    );
    assert.equal(repo?.id, "r1");
    assert.equal(repo?.git_dir, "/home/u/proj/.git");
  });
});

test("resolveRepoForCwd: returns null when nothing matches", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    const repo = await resolveRepoForCwd(db.prisma, "/elsewhere/unknown");
    assert.equal(repo, null);
  });
});

// --- resolveRepoByFullName ---

test("resolveRepoByFullName: matches lowercased repo_full_name", async () => {
  await withDb(async (db) => {
    await seedRepo(db, {
      id: "r1",
      gitDir: "/home/u/proj/.git",
      repoFullName: "org/proj",
    });
    // Caller passes mixed case; helper lowercases before querying.
    const repo = await resolveRepoByFullName(db.prisma, "Org/Proj");
    assert.equal(repo?.id, "r1");
    assert.equal(repo?.git_dir, "/home/u/proj/.git");
  });
});

test("resolveRepoByFullName: returns null for an unknown full name", async () => {
  await withDb(async (db) => {
    await seedRepo(db, {
      id: "r1",
      gitDir: "/home/u/proj/.git",
      repoFullName: "org/proj",
    });
    const repo = await resolveRepoByFullName(db.prisma, "org/other");
    assert.equal(repo, null);
  });
});

// --- cwdExists ---

test("cwdExists: true for a directory that exists", async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await cwdExists(dir), true);
  });
});

test("cwdExists: false for a path that does not exist", async () => {
  assert.equal(await cwdExists("/no/such/path/fea1899-xyz"), false);
});

// ---------------------------------------------------------------------------
// captureRepoIdentity: non-git cwd short-circuits to an empty result
// ---------------------------------------------------------------------------

test("captureRepoIdentity: returns an empty identity for a non-git directory", async () => {
  await withDb(async (db) => {
    await withTmpDir(async (cwd) => {
      // A fresh temp dir is not a git work tree, so isInsideWorkTree → false and
      // the capture short-circuits without touching the DB.
      const result = await captureRepoIdentity("git", cwd, db.prisma, NOW);
      assert.deepEqual(result, {
        repoId: null,
        gitDir: null,
        repoFullName: null,
        isWorktree: false,
      });
      const repos = await db.store.query("SELECT COUNT(*) AS n FROM repos");
      assert.equal((repos.rows[0] as { n: number | string }).n, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// captureRepoIdentity: real git repo → the RAW COALESCE-preserve upsert (RETURNING)
// ---------------------------------------------------------------------------

test("captureRepoIdentity: persists a repos row via the RETURNING upsert and is idempotent", async () => {
  await withDb(async (db) => {
    await withTmpDir(async (repoDir) => {
      // A real (remote-less) git work tree, so isInsideWorkTree → true and the
      // capture reaches upsertRepo — the raw `$queryRawUnsafe` INSERT … ON
      // CONFLICT … RETURNING id run through `prisma.write`.
      await execFileAsync("git", ["init"], { cwd: repoDir });

      const first = await captureRepoIdentity("git", repoDir, db.prisma, NOW);
      assert.ok(first.repoId, "repoId returned from the RETURNING upsert");
      assert.equal(first.isWorktree, false);

      const after = await db.store.query<{ id: string; git_dir: string }>(
        "SELECT id, git_dir FROM repos"
      );
      assert.equal(after.rows.length, 1, "one repos row persisted");
      assert.equal(after.rows[0]?.id, first.repoId);

      // A second capture conflicts on git_dir and RETURNs the SAME existing id
      // (not a fresh uuid) — the DO UPDATE branch's RETURNING.
      const second = await captureRepoIdentity("git", repoDir, db.prisma, NOW);
      assert.equal(second.repoId, first.repoId, "conflict returns existing id");
      const count = await db.store.query("SELECT COUNT(*) AS n FROM repos");
      assert.equal((count.rows[0] as { n: number | string }).n, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// runHistoricalBackfill: the candidate anti-join excludes already-mapped cwds
// ---------------------------------------------------------------------------

test("runHistoricalBackfill: skips sessions whose cwd already maps to a worktree or repo (anti-join)", async () => {
  await withDb(async (db) => {
    // A repo (resolvable by full name) whose git_dir also covers session C's cwd,
    // plus a worktree covering session B's cwd.
    await seedRepo(db, {
      id: "rp-proj",
      gitDir: "/covered2/.git",
      repoFullName: "owner/proj",
    });
    await seedWorktree(db, {
      id: "wt",
      repoId: "rp-proj",
      worktreePath: "/covered",
    });

    const meta = '{"repoFullName":"owner/proj"}';
    const seedSession = (id: string, cwd: string, startedAt: string) =>
      db.store.query(
        "INSERT INTO sessions (id, cwd, metadata, started_at) VALUES ($1, $2, $3, $4)",
        [id, cwd, meta, startedAt]
      );
    // A: uncovered cwd → a candidate; resolves via the mined repoFullName.
    await seedSession("sA", "/uncovered-A", "2026-06-18T03:00:00.000Z");
    // B: cwd IS a registered worktree_path → excluded by the first NOT EXISTS.
    await seedSession("sB", "/covered", "2026-06-18T02:00:00.000Z");
    // C: cwd || '/.git' IS a repos.git_dir → excluded by the second NOT EXISTS.
    await seedSession("sC", "/covered2", "2026-06-18T01:00:00.000Z");

    // Only sA survives the anti-join; cwdExists('/uncovered-A') is false, so it
    // resolves through resolveRepoByFullName('owner/proj') → 1. If the anti-join
    // failed to exclude B/C, they would also be processed (and could resolve via
    // the same metadata), so the exact count of 1 pins the exclusion.
    const resolved = await runHistoricalBackfill("git", db.prisma, 50, NOW);
    assert.equal(resolved, 1);
  });
});
