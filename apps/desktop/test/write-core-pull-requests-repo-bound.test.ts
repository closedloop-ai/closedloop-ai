/**
 * @file write-core-pull-requests-repo-bound.test.ts
 * @description ISS-8882: `persistNormalizedPullRequests` is the second producer
 * of `repo_full_name` (after prose mentions), building `${owner}/${repo}` from a
 * `github.com/…/pull/N` URL. A slug past `REPOSITORY_FULL_NAME_MAX_LENGTH` must
 * neither be persisted nor fall back onto the session's own repo — the URL
 * named a different repository, and filing the PR on this one fabricates a link.
 * The at-bound slug is the over-rejection guard.
 */
import assert from "node:assert/strict";
import { REPOSITORY_FULL_NAME_MAX_LENGTH } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { persistNormalizedPullRequests } from "../src/main/database/write-core-pull-requests.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SESSION_REPO = "acme/repo";
const OWNER = "acme/";
const AT_BOUND_REPO =
  OWNER + "a".repeat(REPOSITORY_FULL_NAME_MAX_LENGTH - OWNER.length);
const OVER_BOUND_REPO = `${AT_BOUND_REPO}a`;
const NOW = "2026-08-07T00:00:00.000Z";

test("ISS-8882: a PR URL naming an over-bound repo persists nothing and is not filed on the session repo", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES ($1, 'inactive', $2, $2, 'claude', 'metered_api')`,
      ["s-8882", NOW]
    );
    const session = makeSession({
      sessionId: "s-8882",
      startedAt: NOW,
      endedAt: null,
      artifacts: {
        repo: SESSION_REPO,
        prs: [
          { number: "7", url: `https://github.com/${OVER_BOUND_REPO}/pull/7` },
          { number: "8", url: `https://github.com/${AT_BOUND_REPO}/pull/8` },
        ],
        issues: [],
      },
    });

    const captured = await prisma.write((client) =>
      client.$transaction((tx) =>
        persistNormalizedPullRequests(
          tx,
          session,
          "claude",
          NOW,
          new Map(),
          new Map()
        )
      )
    );
    assert.equal(captured, 1, "only the at-bound PR persists");

    const prs = await prisma.client.$queryRawUnsafe<
      { repo_full_name: string; pr_number: number }[]
    >("SELECT repo_full_name, pr_number FROM pull_requests ORDER BY pr_number");
    assert.deepEqual(prs, [{ repo_full_name: AT_BOUND_REPO, pr_number: 8 }]);

    const artifacts = await prisma.client.$queryRawUnsafe<
      { repo_full_name: string | null }[]
    >("SELECT repo_full_name FROM artifacts WHERE kind = 'pull_request'");
    assert.deepEqual(
      artifacts.map((row) => row.repo_full_name),
      [AT_BOUND_REPO],
      "PR #7 is neither stored under its own slug nor under the session repo"
    );
  } finally {
    await close();
  }
});

test("ISS-8882: an explicit over-bound pr.repo with no URL is dropped, not filed under the session repo", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES ($1, 'inactive', $2, $2, 'claude', 'metered_api')`,
      ["s-8882-repo", NOW]
    );
    const session = makeSession({
      sessionId: "s-8882-repo",
      startedAt: NOW,
      endedAt: null,
      artifacts: {
        repo: SESSION_REPO,
        // No `url` on either, so the slug can only come from `pr.repo`. Before
        // the bound, `normalizeRepoFullName` returned the over-bound slug
        // verbatim; now it returns null, and without the explicit refusal the
        // `?? defaultRepo` fallback would file PR #9 on SESSION_REPO — a
        // repository this record never named.
        prs: [
          { number: "9", repo: OVER_BOUND_REPO },
          { number: "10", repo: AT_BOUND_REPO },
        ],
        issues: [],
      },
    });

    const captured = await prisma.write((client) =>
      client.$transaction((tx) =>
        persistNormalizedPullRequests(
          tx,
          session,
          "claude",
          NOW,
          new Map(),
          new Map()
        )
      )
    );
    assert.equal(captured, 1, "only the at-bound PR persists");

    const prs = await prisma.client.$queryRawUnsafe<
      { repo_full_name: string; pr_number: number }[]
    >("SELECT repo_full_name, pr_number FROM pull_requests ORDER BY pr_number");
    assert.deepEqual(prs, [{ repo_full_name: AT_BOUND_REPO, pr_number: 10 }]);
    assert.equal(
      prs.filter((row) => row.repo_full_name === SESSION_REPO).length,
      0,
      "PR #9 is not re-homed onto the session repo"
    );
  } finally {
    await close();
  }
});

test("ISS-8882: an over-bound URL that is not a parseable PR URL falls back to the explicit pr.repo, as a malformed URL always has", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES ($1, 'inactive', $2, $2, 'claude', 'metered_api')`,
      ["s-8882-fallback", NOW]
    );
    const session = makeSession({
      sessionId: "s-8882-fallback",
      startedAt: NOW,
      endedAt: null,
      artifacts: {
        repo: SESSION_REPO,
        // The slug bound must be the ONLY reason a URL is treated as
        // non-fallbackable. This URL carries no usable PR number, so
        // `parseGitHubPrUrl` refuses it for a second, unrelated reason and its
        // over-bound slug is irrelevant — the record still has a valid explicit
        // repo and number, and the malformed-URL path has always kept it.
        prs: [
          {
            number: "11",
            repo: "other/repo",
            url: `https://github.com/${OVER_BOUND_REPO}/pull/not-a-number`,
          },
        ],
        issues: [],
      },
    });

    const captured = await prisma.write((client) =>
      client.$transaction((tx) =>
        persistNormalizedPullRequests(
          tx,
          session,
          "claude",
          NOW,
          new Map(),
          new Map()
        )
      )
    );
    assert.equal(captured, 1);

    const prs = await prisma.client.$queryRawUnsafe<
      { repo_full_name: string; pr_number: number }[]
    >("SELECT repo_full_name, pr_number FROM pull_requests");
    assert.deepEqual(prs, [{ repo_full_name: "other/repo", pr_number: 11 }]);
  } finally {
    await close();
  }
});
