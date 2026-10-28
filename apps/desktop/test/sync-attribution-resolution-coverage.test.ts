/**
 * @file sync-attribution-resolution-coverage.test.ts
 * @description ISS-8730 coverage for `database/sync-attribution-resolution.ts` —
 * the per-session repo attribution tiering (live -> stored -> ISS-4431 branch
 * provenance) and its durable write-back.
 *
 * `resolveSyncAttributions` calls the REAL live-cwd resolver
 * (`resolveSessionAttributionWithSourceAsync`), which spawns real `git`. Rather
 * than mock that non-DB dependency, this suite drives it with real hermetic git
 * fixtures (`attribution-test-helpers.ts`, already used by
 * `attribution-path-memo.test.ts`) so every assertion exercises the production
 * code path end to end: a plain (non-git) temp dir is a genuine "no live repo"
 * case, and a fixture repo with a real `origin` remote is a genuine "live repo
 * resolved" case. `persistResolvedRepoFullNames` (the one actual DB dependency)
 * is covered with a simple recording Prisma mock.
 *
 * Pins CURRENT behavior; does not fix source.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import type { SessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import { resetAttributionPathMemo } from "../src/main/agent-sync/attribution-path-memo.js";
import type {
  SqliteArtifactLinkRow,
  SqliteSessionRow,
} from "../src/main/database/db-row-types.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  persistResolvedRepoFullNames,
  type RepoFullNameWriteBack,
  resolveSyncAttributions,
} from "../src/main/database/sync-attribution-resolution.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import {
  emptyAttributionCache,
  initGitRepoWithOrigin,
} from "./attribution-test-helpers.js";

let realGitPath = "";

beforeAll(() => {
  realGitPath = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
});

beforeEach(() => {
  // Skip the (cached, but potentially slow on a cold run) login-shell binary
  // resolution entirely — same convention as attribution-path-memo.test.ts.
  configureBinaryPathsResolver(() => ({ git: realGitPath }));
});

const tempDirs: string[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  resetAttributionPathMemo();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function makePlainDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sync-attr-plain-"));
  tempDirs.push(dir);
  return dir;
}

async function makeGitRepoWithRemote(orgRepo: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sync-attr-git-"));
  tempDirs.push(dir);
  initGitRepoWithOrigin(dir, orgRepo);
  return dir;
}

function makeSessionRow(
  overrides: Partial<SqliteSessionRow> & { id: string }
): SqliteSessionRow {
  return {
    name: null,
    priority: null,
    status: SESSION_STATUS.INACTIVE,
    cwd: null,
    repo_full_name: null,
    model: null,
    started_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ended_at: null,
    awaiting_input_since: null,
    ends_with_error: null,
    metadata: null,
    harness: null,
    billing_mode: null,
    user_id: null,
    organization_id: null,
    cost_usd_estimated: null,
    cost_currency: null,
    cost_source: null,
    data_revision: 1,
    ...overrides,
  };
}

function makeArtifactLinkRow(
  overrides: Partial<SqliteArtifactLinkRow>
): SqliteArtifactLinkRow {
  return {
    session_id: "s1",
    target_kind: "branch",
    slug: null,
    is_primary: true,
    method: "git_push",
    repo_full_name: null,
    pr_number: null,
    url: null,
    relation: "workspace",
    sha: null,
    title: null,
    branch_name: "feature/x",
    priority: null,
    link_observed_at: null,
    artifact_committed_at: null,
    artifact_observed_at: null,
    artifact_last_seen_at: null,
    base_ref: null,
    pr_opened_at: null,
    ...overrides,
  };
}

function cache(): SessionAttributionResolverCache {
  return emptyAttributionCache();
}

describe("resolveSyncAttributions", () => {
  test("a live resolution differing from the stored repo wins and queues a write-back", async () => {
    const cwd = await makeGitRepoWithRemote("acme/web");
    const rows = [
      makeSessionRow({ id: "s1", cwd, repo_full_name: "stale/name" }),
    ];

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    assert.equal(result.bySessionId.get("s1")?.repositoryFullName, "acme/web");
    assert.deepEqual(result.writeBacks, [
      { id: "s1", repoFullName: "acme/web" },
    ]);
  });

  test("a live resolution matching the stored repo produces no write-back", async () => {
    const cwd = await makeGitRepoWithRemote("acme/web");
    const rows = [
      makeSessionRow({ id: "s1", cwd, repo_full_name: "acme/web" }),
    ];

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    assert.equal(result.bySessionId.get("s1")?.repositoryFullName, "acme/web");
    assert.deepEqual(result.writeBacks, []);
  });

  test("no live repo falls back to the durable stored repo name (worktree deleted)", async () => {
    const cwd = await makePlainDir();
    const rows = [
      makeSessionRow({ id: "s1", cwd, repo_full_name: "stored/repo" }),
    ];

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    // The live resolution still carries a non-null attribution (worktreePath
    // alone is a truthy field), so the stored fallback is spread ONTO it
    // rather than synthesizing a fresh repo-only object.
    assert.deepEqual(result.bySessionId.get("s1"), {
      repositoryFullName: "stored/repo",
      worktreePath: cwd,
      sourceArtifactId: null,
      baseBranch: null,
    });
    assert.deepEqual(result.writeBacks, []);
  });

  test("ISS-4431: no live repo, no stored repo -> a CREATED branch-provenance link wins and queues a write-back", async () => {
    const cwd = await makePlainDir();
    const rows = [makeSessionRow({ id: "s1", cwd, repo_full_name: null })];
    const links = new Map([
      [
        "s1",
        [
          makeArtifactLinkRow({
            target_kind: "branch",
            relation: "workspace",
            repo_full_name: "wrong/repo",
          }),
          makeArtifactLinkRow({
            target_kind: "branch",
            relation: "created",
            repo_full_name: "right/repo",
          }),
        ],
      ],
    ]);

    const result = await resolveSyncAttributions(rows, cache(), links);

    assert.equal(
      result.bySessionId.get("s1")?.repositoryFullName,
      "right/repo"
    );
    assert.deepEqual(result.writeBacks, [
      { id: "s1", repoFullName: "right/repo" },
    ]);
  });

  test("ISS-4431: branch provenance falls back to the first non-null branch-link repo when nothing was created", async () => {
    const cwd = await makePlainDir();
    const rows = [makeSessionRow({ id: "s1", cwd, repo_full_name: null })];
    const links = new Map([
      [
        "s1",
        [
          makeArtifactLinkRow({
            target_kind: "pull_request",
            relation: "referenced",
            repo_full_name: "ignored/pr-repo",
          }),
          makeArtifactLinkRow({
            target_kind: "branch",
            relation: "referenced",
            repo_full_name: null,
          }),
          makeArtifactLinkRow({
            target_kind: "branch",
            relation: "referenced",
            repo_full_name: "fallback/repo",
          }),
        ],
      ],
    ]);

    const result = await resolveSyncAttributions(rows, cache(), links);

    assert.equal(
      result.bySessionId.get("s1")?.repositoryFullName,
      "fallback/repo"
    );
    assert.deepEqual(result.writeBacks, [
      { id: "s1", repoFullName: "fallback/repo" },
    ]);
  });

  test("no live repo, no stored repo, no branch links -> the bare live attribution (worktreePath only, no repo)", async () => {
    const cwd = await makePlainDir();
    const rows = [makeSessionRow({ id: "s1", cwd, repo_full_name: null })];

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    // Falls through every tier to whatever the live resolver produced. A live
    // resolution against a real (if repo-less) path is NOT null -- `buildAttribution`
    // treats a truthy `worktreePath` alone as "some attribution", so the row keeps
    // that bare worktree-only object rather than collapsing to null.
    assert.deepEqual(result.bySessionId.get("s1"), {
      repositoryFullName: null,
      worktreePath: cwd,
      sourceArtifactId: null,
      baseBranch: null,
    });
    assert.deepEqual(result.writeBacks, []);
  });

  test("a null cwd never resolves live and falls straight to the stored repo", async () => {
    const rows = [
      makeSessionRow({ id: "s1", cwd: null, repo_full_name: "stored/only" }),
    ];

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    assert.equal(
      result.bySessionId.get("s1")?.repositoryFullName,
      "stored/only"
    );
  });

  test("sessions sharing one cwd resolve from a single deduplicated live lookup", async () => {
    const cwd = await makeGitRepoWithRemote("acme/shared");
    const rows = [
      makeSessionRow({ id: "s1", cwd, repo_full_name: "old" }),
      makeSessionRow({ id: "s2", cwd, repo_full_name: "old" }),
    ];

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    assert.equal(
      result.bySessionId.get("s1")?.repositoryFullName,
      "acme/shared"
    );
    assert.equal(
      result.bySessionId.get("s2")?.repositoryFullName,
      "acme/shared"
    );
    assert.deepEqual(result.writeBacks.map((w) => w.id).sort(), ["s1", "s2"]);
  });

  test("ISS-5272: more unique cwds than the spawn-concurrency batch width all still resolve", async () => {
    const dirs = await Promise.all(
      Array.from({ length: 10 }, () => makePlainDir())
    );
    const rows = dirs.map((cwd, i) =>
      makeSessionRow({ id: `s${i}`, cwd, repo_full_name: "stored/repo" })
    );

    const result = await resolveSyncAttributions(rows, cache(), new Map());

    for (const row of rows) {
      assert.equal(
        result.bySessionId.get(row.id)?.repositoryFullName,
        "stored/repo",
        `row ${row.id} should have resolved`
      );
    }
  });

  test("ISS-5272 C3: an unproven cached write-back candidate is revalidated live before it is queued", async () => {
    const cwd = await makeGitRepoWithRemote("acme/real");
    const seededCache = cache();
    // Simulate a memo/per-call cache hit for this cwd, which the resolver marks
    // as NOT provenly live (repoSource !== "live") -- so it must be revalidated
    // before a differing value is trusted for the durable write-back.
    seededCache.attributionByCwd.set(cwd, {
      repositoryFullName: "stale-memo/name",
      worktreePath: cwd,
      sourceArtifactId: null,
      baseBranch: null,
    });
    const rows = [
      makeSessionRow({ id: "s1", cwd, repo_full_name: "stored/name" }),
    ];

    const result = await resolveSyncAttributions(rows, seededCache, new Map());

    // The revalidated (real) value wins, not the stale cached one.
    assert.equal(result.bySessionId.get("s1")?.repositoryFullName, "acme/real");
    assert.deepEqual(result.writeBacks, [
      { id: "s1", repoFullName: "acme/real" },
    ]);
  });

  test("ISS-5272 C3: revalidation finding the worktree really gone falls through to the stored repo", async () => {
    const cwd = await makePlainDir();
    const seededCache = cache();
    seededCache.attributionByCwd.set(cwd, {
      repositoryFullName: "stale-memo/name",
      worktreePath: cwd,
      sourceArtifactId: null,
      baseBranch: null,
    });
    const rows = [
      makeSessionRow({ id: "s1", cwd, repo_full_name: "stored/name" }),
    ];

    const result = await resolveSyncAttributions(rows, seededCache, new Map());

    assert.equal(
      result.bySessionId.get("s1")?.repositoryFullName,
      "stored/name"
    );
    assert.deepEqual(result.writeBacks, []);
  });
});

describe("persistResolvedRepoFullNames", () => {
  function makeWritePrisma(
    updateMany: (args: {
      where: { id: string };
      data: { repoFullName: string };
    }) => Promise<unknown>
  ): DesktopPrisma {
    const fakeClient = { session: { updateMany } };
    return {
      write: (fn: (client: typeof fakeClient) => Promise<unknown>) =>
        fn(fakeClient),
    } as unknown as DesktopPrisma;
  }

  test("is a no-op when there are no write-backs (write() is never called)", async () => {
    let writeCalled = false;
    const prisma = {
      write: () => {
        writeCalled = true;
        return Promise.resolve();
      },
    } as unknown as DesktopPrisma;

    await persistResolvedRepoFullNames(prisma, []);

    assert.equal(writeCalled, false);
  });

  test("issues one updateMany per write-back, in order", async () => {
    const calls: Array<{
      where: { id: string };
      data: { repoFullName: string };
    }> = [];
    const prisma = makeWritePrisma((args) => {
      calls.push(args);
      return Promise.resolve();
    });
    const writeBacks: RepoFullNameWriteBack[] = [
      { id: "s1", repoFullName: "acme/one" },
      { id: "s2", repoFullName: "acme/two" },
    ];

    await persistResolvedRepoFullNames(prisma, writeBacks);

    assert.deepEqual(calls, [
      { where: { id: "s1" }, data: { repoFullName: "acme/one" } },
      { where: { id: "s2" }, data: { repoFullName: "acme/two" } },
    ]);
  });

  test("a per-row updateMany failure is swallowed and the rest of the batch still persists", async () => {
    const attempted: string[] = [];
    const prisma = makeWritePrisma((args) => {
      attempted.push(args.where.id);
      if (args.where.id === "s1") {
        throw new Error("locked");
      }
      return Promise.resolve();
    });

    await persistResolvedRepoFullNames(prisma, [
      { id: "s1", repoFullName: "acme/one" },
      { id: "s2", repoFullName: "acme/two" },
    ]);

    assert.deepEqual(attempted, ["s1", "s2"]);
  });

  test("a failed write transaction is swallowed and never propagates (best-effort cache refresh)", async () => {
    const prisma = {
      write: () => Promise.reject(new Error("database is locked")),
    } as unknown as DesktopPrisma;

    await assert.doesNotReject(() =>
      persistResolvedRepoFullNames(prisma, [
        { id: "s1", repoFullName: "acme/one" },
      ])
    );
  });
});
