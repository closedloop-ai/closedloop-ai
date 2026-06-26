import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  type AdditionalWorktreeEntry,
  type ExecuteFinalizationResult,
  finalizeAdditionalReposAndPersist,
} from "../src/server/operations/symphony-loop.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "finalize-add-repos-test-")
  );
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

const baseArgs = (claudeWorkDir: string) => ({
  claudeWorkDir,
  primaryFullName: "owner/primary",
  primaryBaseBranch: "main",
  loopId: "loop-1",
  apiBaseUrl: "http://127.0.0.1:0",
  token: "token",
  webAppOrigin: "",
  getAllowedDirectories: () => [] as string[],
});

const successFinalization: ExecuteFinalizationResult = {
  status: "success",
  path: "llm-success",
  prUrl: "https://github.com/owner/primary/pull/1",
  prNumber: 1,
  branchName: "symphony/loop-1",
  commitSha: "deadbeefcafebabedeadbeefcafebabedeadbeef",
  executionResultPersisted: true,
};

test("finalizeAdditionalReposAndPersist returns skipped:no-additionals when entries is empty", async () => {
  const claudeWorkDir = path.join(tempRoot, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const outcome = await finalizeAdditionalReposAndPersist({
    ...baseArgs(claudeWorkDir),
    additionalEntries: [],
    executeFinalization: successFinalization,
  });

  assert.equal(outcome.status, "skipped:no-additionals");
});

test("finalizeAdditionalReposAndPersist is idempotent: skips when on-disk V2 already has multiple results", async () => {
  const claudeWorkDir = path.join(tempRoot, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const existingMultiRepoEnvelope = {
    schemaVersion: 2,
    results: [
      {
        status: "success",
        fullName: "owner/primary",
        prUrl: "https://github.com/owner/primary/pull/1",
        prNumber: 1,
        branchName: "symphony/loop-1",
        baseBranch: "main",
        hasChanges: true,
        commitSha: "0000000000000000000000000000000000000001",
      },
      {
        status: "success",
        fullName: "owner/additional",
        prUrl: "https://github.com/owner/additional/pull/2",
        prNumber: 2,
        branchName: "symphony/loop-1-add",
        baseBranch: "main",
        hasChanges: true,
        commitSha: "0000000000000000000000000000000000000002",
      },
    ],
  };
  await fs.writeFile(
    path.join(claudeWorkDir, "execution-result.json"),
    JSON.stringify(existingMultiRepoEnvelope)
  );

  const additionalEntries: AdditionalWorktreeEntry[] = [
    {
      dir: path.join(tempRoot, "wt-add"),
      repoPath: path.join(tempRoot, "repo-add"),
      fullName: "owner/additional",
      baseBranch: "main",
    },
  ];

  const outcome = await finalizeAdditionalReposAndPersist({
    ...baseArgs(claudeWorkDir),
    additionalEntries,
    executeFinalization: successFinalization,
  });

  assert.equal(outcome.status, "skipped:already-finalized");

  // V2 envelope on disk is unchanged
  const persisted = JSON.parse(
    await fs.readFile(
      path.join(claudeWorkDir, "execution-result.json"),
      "utf-8"
    )
  );
  assert.deepEqual(persisted, existingMultiRepoEnvelope);
});

test("finalizeAdditionalReposAndPersist returns skipped:incomplete-metadata for entries persisted by older builds", async () => {
  const claudeWorkDir = path.join(tempRoot, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  // No execution-result.json present (fresh recovery, primary not yet finalized).
  const additionalEntries: AdditionalWorktreeEntry[] = [
    {
      dir: path.join(tempRoot, "wt-old"),
      repoPath: path.join(tempRoot, "repo-old"),
      // fullName + baseBranch deliberately absent — older persisted shape.
    },
  ];

  const outcome = await finalizeAdditionalReposAndPersist({
    ...baseArgs(claudeWorkDir),
    additionalEntries,
    executeFinalization: successFinalization,
  });

  assert.equal(outcome.status, "skipped:incomplete-metadata");
  if (outcome.status === "skipped:incomplete-metadata") {
    assert.deepEqual(outcome.missingRepoPaths, [
      path.join(tempRoot, "repo-old"),
    ]);
  }

  // No execution-result.json should have been written
  const exists = await fs
    .access(path.join(claudeWorkDir, "execution-result.json"))
    .then(() => true)
    .catch(() => false);
  assert.equal(
    exists,
    false,
    "should not write execution-result when bailing on incomplete metadata"
  );
});
