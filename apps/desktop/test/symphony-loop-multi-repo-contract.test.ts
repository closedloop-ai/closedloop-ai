/**
 * Contract tests for multi-repo PLAN requests.
 *
 * 1. PLAN rejects nonexistent branch (branchExists returns false) — HTTP 400 + PreRunValidationFailed event
 * 2. resolveAdditionalRepos rejects > 5 entries
 * 3. additionalRepoDisambiguator distinguishes repos with the same basename
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { WorktreeProvider } from "../src/server/operations/symphony-loop.js";
import {
  AdditionalRepoError,
  additionalRepoDisambiguator,
  resolveAdditionalRepos,
} from "../src/server/operations/symphony-loop.js";
import {
  makeFakeWorktreeProvider,
  makeMultiRepoGateway,
  makeMultiRepoTestHarness,
  PRD_PEER_COMMANDS,
  startMockApiServer,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/multi-repo-contract-test"
);

const { serversToClose, mockServersToClose, tempPathsToClean, cleanup } =
  makeMultiRepoTestHarness();
afterEach(cleanup);

/** Create a gateway server with a mock API backend and the extended worktreeProvider. */
function createTestGateway(
  tmpDir: string,
  mockPort: number,
  worktreeProvider?: WorktreeProvider
) {
  return makeMultiRepoGateway({
    tmpDir,
    mockPort,
    machineName: "multi-repo-contract-test",
    worktreeProvider: worktreeProvider ?? fakeWorktreeProvider,
    serversToClose,
  });
}

// ---------------------------------------------------------------------------
// PLAN rejects nonexistent branch (branchExists returns false)
//   — assert HTTP 400 and PreRunValidationFailed error event
// ---------------------------------------------------------------------------

it("PLAN with nonexistent branch in additionalRepo returns HTTP 400 and PreRunValidationFailed event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "multi-repo-nobranch-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });

  const additionalRepo = path.join(tmpDir, "additional-repo");
  await fs.mkdir(additionalRepo, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  // Use a worktreeProvider whose branchExists always returns false
  const branchNotFoundProvider: WorktreeProvider = {
    ...fakeWorktreeProvider,
    branchExists: async () => false,
  };
  const server = await createTestGateway(
    tmpDir,
    mock.port,
    branchNotFoundProvider
  );

  const loopId = "00000000-0000-0000-0000-000000003004";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `multi-repo-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
        additionalRepos: [
          {
            localRepoPath: additionalRepo,
            branch: "nonexistent-branch",
          },
        ],
      }),
    }
  );

  assert.equal(
    response.status,
    400,
    "PLAN with nonexistent branch in additionalRepo should return HTTP 400"
  );

  // The error event with code PRE_RUN_VALIDATION_FAILED must be posted to the API
  const errorEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(errorEvent.type, "error");
  assert.equal(
    errorEvent.code,
    "PRE_RUN_VALIDATION_FAILED",
    `Expected error code PRE_RUN_VALIDATION_FAILED, got: ${JSON.stringify(errorEvent.code)}`
  );
});

// ---------------------------------------------------------------------------
// Per-command branch-not-found assertion: the same scenario must surface a
// PRE_RUN_VALIDATION_FAILED event with the offending peer's fullName for
// every peer-enabled command that goes through resolveAdditionalRepos.
//
// Today we exercise GENERATE_PRD and REQUEST_PRD_CHANGES (PLAN above and
// EXECUTE in -execute remain the AC-009 regression signal). Iterating
// MULTI_REPO_POLICY directly inside the test body would require resolving
// the `@closedloop-ai/loops-api/multi-repo-policy` subpath — that subpath
// only exists in loops-api 0.2.9+ (substrate ships in lockstep with PLN-459
// per PRD-244 Phase 0), so the iteration list is hard-coded here as the set
// of currently peer-enabled commands. Adding the subpath import once 0.2.9
// publishes is mechanical.
// ---------------------------------------------------------------------------

for (const command of PRD_PEER_COMMANDS) {
  it(`${command} with nonexistent branch in additionalRepo returns 400 + PRE_RUN_VALIDATION_FAILED naming the offending peer`, async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `multi-repo-prd-nobranch-${command.toLowerCase()}-`
      )
    );
    tempPathsToClean.push(tmpDir);

    const primaryRepo = path.join(tmpDir, "primary-repo");
    await fs.mkdir(primaryRepo, { recursive: true });

    const peerRepo = path.join(tmpDir, "ghost-peer");
    await fs.mkdir(peerRepo, { recursive: true });

    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });

    process.env.HOME = tmpDir;
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);

    const branchNotFoundProvider: WorktreeProvider = {
      ...fakeWorktreeProvider,
      branchExists: async () => false,
    };
    const server = await createTestGateway(
      tmpDir,
      mock.port,
      branchNotFoundProvider
    );

    const loopId = `00000000-0000-0000-0000-${command === LoopCommand.GeneratePrd ? "000000003101" : "000000003102"}`;
    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command,
          closedLoopAuthToken: "tok",
          // Both PRD commands require artifacts + a prompt; the branch check
          // happens in resolveAdditionalRepos before any spawn-side validation.
          artifacts:
            command === LoopCommand.RequestPrdChanges
              ? [
                  {
                    id: "art-1",
                    type: "prd",
                    title: "Existing PRD",
                    content: "PRD body",
                  },
                ]
              : [],
          prompt: "Generate a PRD",
          repo: {
            fullName: `multi-repo-test/${path.basename(primaryRepo)}`,
            branch: "main",
          },
          additionalRepos: [
            {
              fullName: "ghost/peer",
              localRepoPath: peerRepo,
              branch: "nonexistent-branch",
            },
          ],
        }),
      }
    );

    assert.equal(
      response.status,
      400,
      `${command} with nonexistent peer branch should return HTTP 400`
    );

    const errorEvent = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(errorEvent.type, "error");
    assert.equal(
      errorEvent.code,
      "PRE_RUN_VALIDATION_FAILED",
      `Expected PRE_RUN_VALIDATION_FAILED, got ${JSON.stringify(errorEvent.code)}`
    );
    // AC-006: the event must name the offending peer so on-call can identify
    // which peer entry failed validation, not just "a peer".
    const message = String(errorEvent.message ?? "");
    assert.ok(
      message.includes("ghost/peer"),
      `${command} validation event must include offending peer fullName 'ghost/peer'; got: ${message}`
    );
  });
}

// ---------------------------------------------------------------------------
// Unit-style tests for resolveAdditionalRepos
// ---------------------------------------------------------------------------

describe("resolveAdditionalRepos — unit-style", () => {
  it("rejects entries exceeding the maximum of 5 additional repos", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "multi-repo-unit-max-")
    );
    tempPathsToClean.push(tmpDir);

    const repos = Array.from({ length: 6 }, (_, i) =>
      path.join(tmpDir, `repo-${i}`)
    );
    await Promise.all(repos.map((r) => fs.mkdir(r, { recursive: true })));

    await assert.rejects(
      () =>
        resolveAdditionalRepos(
          repos.map((r) => ({ localRepoPath: r, branch: "main" })),
          [tmpDir],
          fakeWorktreeProvider
        ),
      (err) =>
        err instanceof AdditionalRepoError &&
        err.message.includes("exceeds maximum")
    );
  });
});

// ---------------------------------------------------------------------------
// additionalRepoDisambiguator: pure-function check that two repos sharing a
// basename but differing in absolute path get distinct disambiguators. Replaces
// the prior full-stack integration test for the same invariant.
// ---------------------------------------------------------------------------

describe("additionalRepoDisambiguator", () => {
  it("produces different disambiguators for repos with the same basename in different parents", () => {
    const a = "/tmp/work/api";
    const b = "/tmp/oss/api";

    const hashA = additionalRepoDisambiguator(a);
    const hashB = additionalRepoDisambiguator(b);

    assert.match(
      hashA,
      /^[a-f0-9]{8}$/,
      "disambiguator should be an 8-char hex string"
    );
    assert.match(
      hashB,
      /^[a-f0-9]{8}$/,
      "disambiguator should be an 8-char hex string"
    );
    assert.notEqual(
      hashA,
      hashB,
      "Repos with the same basename but distinct absolute paths must hash differently"
    );
  });

  it("is stable: same path returns the same disambiguator across calls", () => {
    const repoPath = "/tmp/work/api";
    assert.equal(
      additionalRepoDisambiguator(repoPath),
      additionalRepoDisambiguator(repoPath)
    );
  });
});
