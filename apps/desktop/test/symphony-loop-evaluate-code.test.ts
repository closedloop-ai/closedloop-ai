/** Tests for symphony-loop EVALUATE_CODE command. */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  createEvaluateTestHarness,
  postToLoopEndpoint,
  setupStubClaude,
} from "./symphony-test-utils.js";

// ---------------------------------------------------------------------------
// Shared test harness
// ---------------------------------------------------------------------------

const harness = createEvaluateTestHarness("evaluate-code-test-machine");
const { makeTempDir, makeGatewayServer, startEventServer } = harness;

beforeEach(() => harness.beforeEach());
afterEach(() => harness.afterEach());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid EVALUATE_CODE request body. */
function buildEvaluateCodeBody(
  overrides?: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    loopId: "ec000001-0000-0000-0000-000000000001",
    command: LoopCommand.EvaluateCode,
    closedLoopAuthToken: "cl-token",
    artifacts: [{ type: "IMPLEMENTATION_PLAN", content: "Plan content" }],
    repo: { fullName: "org/repo", branch: "main" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EVALUATE_CODE-specific validation
// ---------------------------------------------------------------------------

describe("T-5.2: EVALUATE_CODE dispatch validation", () => {
  test("(1) without repo returns 400", async () => {
    const server = makeGatewayServer();
    await server.start();

    const response = await postToLoopEndpoint(
      server.getActivePort(),
      buildEvaluateCodeBody({
        loopId: "ec000001-0000-0000-0000-000000000001",
        repo: undefined,
      })
    );

    assert.equal(
      response.status,
      400,
      `Expected 400 when no repo provided, got ${response.status}`
    );
  });

  test("(2) missing plan artifact returns 400", async () => {
    const server = makeGatewayServer();
    await server.start();

    const response = await postToLoopEndpoint(
      server.getActivePort(),
      buildEvaluateCodeBody({
        loopId: "ec000002-0000-0000-0000-000000000002",
        artifacts: [],
      })
    );

    assert.equal(
      response.status,
      400,
      `Expected 400 for missing plan artifact, got ${response.status}`
    );
    const body = (await response.json()) as { error: string };
    assert.ok(
      body.error.includes("EVALUATE_CODE requires"),
      `Error message should mention EVALUATE_CODE requires, got: ${body.error}`
    );
  });
});
// ---------------------------------------------------------------------------
// Prompt content (merged: artifact-type + --workdir + REPO_PATH)
// ---------------------------------------------------------------------------

describe("T-5.2: EVALUATE_CODE prompt content", () => {
  test("prompt contains --artifact-type code, --workdir, and REPO_PATH=", async () => {
    const tmpDir = makeTempDir("evaluate-code-test");
    await setupStubClaude(tmpDir);

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const repoName = "test-repo";
    const repoDir = path.join(tmpDir, repoName);
    await fs.mkdir(repoDir, { recursive: true });

    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const loopId = "a0000001-0000-0000-0000-000000000007";
    const response = await postToLoopEndpoint(server.getActivePort(), {
      loopId,
      command: LoopCommand.EvaluateCode,
      closedLoopAuthToken: "cl-token",
      artifacts: [{ type: "IMPLEMENTATION_PLAN", content: "Plan content" }],
      repo: { fullName: `org/${repoName}`, branch: "main" },
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const claudeWorkDir = path.join(
      os.tmpdir(),
      `symphony-evaluate-code-${loopId.slice(0, 8)}`
    );
    const promptFile = path.join(claudeWorkDir, "evaluate-code-prompt.txt");
    assert.ok(
      existsSync(promptFile),
      `Prompt file should exist at ${promptFile}`
    );
    const promptContent = await fs.readFile(promptFile, "utf-8");

    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    assert.ok(
      promptContent.includes("Evaluate the code artifact"),
      `Prompt should ask Claude to evaluate the code artifact, got: ${promptContent}`
    );
    assert.ok(
      promptContent.includes(
        "Write code judge results as JSON to code-judges.json."
      ),
      `Prompt should contain the code judge output contract, got: ${promptContent}`
    );
    assert.ok(
      promptContent.includes(`Use work directory: ${claudeWorkDir}.`),
      `Prompt should contain the Claude work directory, got: ${promptContent}`
    );
    assert.ok(
      promptContent.includes("REPO_PATH="),
      `Prompt should contain REPO_PATH= unconditionally, got: ${promptContent}`
    );
  });

  test("plan.md contains raw artifact content", async () => {
    const tmpDir = makeTempDir("evaluate-code-test");
    await setupStubClaude(tmpDir);

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const repoName = "plan-content-test-repo";
    const repoDir = path.join(tmpDir, repoName);
    await fs.mkdir(repoDir, { recursive: true });

    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const loopId = "a0000003-0000-0000-0000-000000000009";
    const planContent =
      "This is the raw implementation plan content for testing.";

    const response = await postToLoopEndpoint(server.getActivePort(), {
      loopId,
      command: LoopCommand.EvaluateCode,
      closedLoopAuthToken: "cl-token",
      artifacts: [{ type: "IMPLEMENTATION_PLAN", content: planContent }],
      repo: { fullName: `org/${repoName}`, branch: "main" },
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const claudeWorkDir = path.join(
      os.tmpdir(),
      `symphony-evaluate-code-${loopId.slice(0, 8)}`
    );
    const planFile = path.join(claudeWorkDir, "plan.md");
    assert.ok(existsSync(planFile), `plan.md should exist at ${planFile}`);
    const planFileContent = await fs.readFile(planFile, "utf-8");

    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    assert.equal(
      planFileContent,
      planContent,
      "plan.md content should match raw artifact content"
    );
  });
});
