/**
 * @file data-revision-rebuild-pr-branch-propagation.test.ts
 * @description PLN-1535 M5 — what the rebuild may copy from a PR artifact onto
 * the rebuilt `pull_requests` row, now that `enrichment_state` is gone.
 *
 * `runRebuildSessionTransaction` DELETEs the session's `pull_requests` rows and
 * re-imports them, then back-fills `branch_name` from the PR artifact. The
 * branch name is retained as raw observation regardless of product eligibility;
 * authoritative repository metadata owns that later decision.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

const REPO = "closedloop-ai/symphony-alpha";
const PR_NUMBER = 1535;
const SID = "pln1535-branch-propagation";

type Outcome = {
  readonly rebuilt: number;
  readonly pullRequestBranch: string | null;
  readonly artifactBranch: string | null;
};

/**
 * Import a session that REFERENCES a PR (so both branch columns start NULL),
 * stamp `artifactBranch` onto the PR artifact, then run the real rebuild and
 * report what each column holds afterwards.
 */
async function rebuildWithArtifactBranch(
  artifactBranch: string
): Promise<Outcome> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pln1535-pr-branch-"));
  const db = await openTestDb(dir);
  try {
    const session = makeSession({
      sessionId: SID,
      artifacts: {
        prs: [
          {
            number: String(PR_NUMBER),
            repo: REPO,
            url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
          },
        ],
        issues: [],
        repo: REPO,
      },
    });
    await db.importer.importSession(session, "claude");
    await db.run(
      "UPDATE artifacts SET branch_name = $1 WHERE kind = 'pull_request' AND pr_number = $2",
      artifactBranch,
      PR_NUMBER
    );

    await db.run(
      "UPDATE sessions SET data_revision = 1, status = $1 WHERE id = $2",
      SESSION_STATUS.INACTIVE,
      SID
    );
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () => Promise.resolve([session]),
          sessionIdForSource: () => SID,
        }),
      ],
      db,
    });
    const rows = await db.prisma.client.$queryRawUnsafe<
      { pr_branch: string | null; artifact_branch: string | null }[]
    >(
      `SELECT p.branch_name AS pr_branch, a.branch_name AS artifact_branch
         FROM pull_requests p
         JOIN artifacts a
           ON a.kind = 'pull_request'
          AND a.repo_full_name = p.repo_full_name
          AND a.pr_number = p.pr_number
        WHERE p.session_id = $1`,
      SID
    );
    return {
      rebuilt: result.rebuilt,
      pullRequestBranch: rows[0]?.pr_branch ?? null,
      artifactBranch: rows[0]?.artifact_branch ?? null,
    };
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a default-looking artifact head ref is preserved on the rebuilt PR row", async () => {
  const outcome = await rebuildWithArtifactBranch("main");
  assert.equal(outcome.rebuilt, 1, "precondition: the session was rebuilt");
  assert.equal(
    outcome.pullRequestBranch,
    "main",
    "the rebuild discarded observed branch evidence"
  );
  assert.equal(outcome.artifactBranch, "main");
});

test("a non-default artifact head ref is still propagated onto the rebuilt PR row", async () => {
  const outcome = await rebuildWithArtifactBranch("feat/pln-1535");
  assert.equal(outcome.rebuilt, 1, "precondition: the session was rebuilt");
  assert.equal(
    outcome.pullRequestBranch,
    "feat/pln-1535",
    "the rebuild lost real branch attribution the artifact still carried"
  );
});
