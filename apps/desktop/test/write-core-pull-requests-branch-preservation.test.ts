/**
 * @file write-core-pull-requests-branch-preservation.test.ts
 * @description cr-11829 [P1]: a REFERENCED PR must not wipe a stored head ref.
 *
 * `persistNormalizedPullRequests` only receives a head branch for a PR the
 * session created. Once observed, that value is retained as evidence; repository
 * authority, not a name heuristic in this writer, decides product eligibility.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { persistNormalizedPullRequests } from "../src/main/database/write-core-pull-requests.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const REPO = "closedloop-ai/symphony-alpha";
const PR_NUMBER = "11829";
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const NOW = "2026-08-10T00:00:00.000Z";

async function persistReference(
  prisma: Awaited<ReturnType<typeof openTestPrisma>>["prisma"],
  sessionId: string
): Promise<number> {
  const session = makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: null,
    artifacts: {
      repo: REPO,
      prs: [{ number: PR_NUMBER, url: PR_URL }],
      issues: [],
    },
  });
  // Empty created-head-branch map => this PR is REFERENCED, not created, so the
  // writer passes branch_name = NULL.
  return await prisma.write((client) =>
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
}

async function storedBranchName(
  prisma: Awaited<ReturnType<typeof openTestPrisma>>["prisma"]
): Promise<string | null> {
  const rows = await prisma.client.$queryRawUnsafe<
    { branch_name: string | null }[]
  >("SELECT branch_name FROM artifacts WHERE kind = 'pull_request'");
  return rows[0]?.branch_name ?? null;
}

async function seedSession(
  store: Awaited<ReturnType<typeof openTestPrisma>>["db"],
  sessionId: string
): Promise<void> {
  await store.query(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, $2, $3, $3, 'claude', 'metered_api')`,
    [sessionId, SESSION_STATUS.INACTIVE, NOW]
  );
}

test("a referenced PR does not wipe a stored default-branch head ref", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "s-11829");
    assert.equal(await persistReference(prisma, "s-11829"), 1);

    // A confirmed head ref that happens to BE a default branch — the case the
    // dropped `enrichment_state = 'final'` arm used to protect.
    await store.query(
      "UPDATE artifacts SET branch_name = 'main' WHERE kind = 'pull_request'"
    );

    await seedSession(store, "s-11829-b");
    await persistReference(prisma, "s-11829-b");

    assert.equal(
      await storedBranchName(prisma),
      "main",
      "a second referencing session nulled the stored head ref"
    );
  } finally {
    await close();
  }
});

test("later exact head evidence supersedes a stored weak fallback", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "s-11829-c");
    assert.equal(await persistReference(prisma, "s-11829-c"), 1);
    await store.query(
      "UPDATE artifacts SET branch_name = 'main' WHERE kind = 'pull_request'"
    );

    await seedSession(store, "s-11829-d");
    const created = makeSession({
      sessionId: "s-11829-d",
      startedAt: NOW,
      endedAt: null,
      artifacts: {
        repo: REPO,
        prs: [{ number: PR_NUMBER, url: PR_URL }],
        issues: [],
      },
    });
    await prisma.write((client) =>
      client.$transaction((tx) =>
        persistNormalizedPullRequests(
          tx,
          created,
          "claude",
          NOW,
          new Map([[`${REPO}#${PR_NUMBER}`, "feat/real-head-ref"]]),
          new Map()
        )
      )
    );

    assert.equal(
      await storedBranchName(prisma),
      "feat/real-head-ref",
      "exact created-PR evidence did not heal the stored fallback"
    );
  } finally {
    await close();
  }
});
