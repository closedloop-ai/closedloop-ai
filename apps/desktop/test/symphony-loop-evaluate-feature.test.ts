/** Tests for symphony-loop EVALUATE_FEATURE command. */

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LoopArtifactType } from "@closedloop-ai/loops-api/artifacts";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  EvaluateArtifact,
  readEvaluateOutputs,
  writeFeatureArtifact,
} from "../src/server/operations/symphony-loop.js";
import {
  createEvaluateTestHarness,
  postToLoopEndpoint,
  setupStubClaudeBlocking,
} from "./symphony-test-utils.js";

const harness = createEvaluateTestHarness("evaluate-feature-test-machine");
const { makeTempDir, makeGatewayServer, startEventServer } = harness;

beforeEach(() => harness.beforeEach());
afterEach(() => harness.afterEach());

function buildEvaluateFeatureBody(
  overrides?: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    loopId: "fe000001-0000-0000-0000-000000000001",
    command: LoopCommand.EvaluateFeature,
    closedLoopAuthToken: "cl-token",
    apiBaseUrl: "https://api.example.com",
    artifacts: [{ type: "FEATURE", content: "Feature content for evaluation" }],
    ...overrides,
  };
}

describe("EVALUATE_FEATURE dispatch validation", () => {
  test("rejects requests without a Feature artifact with 400", async () => {
    const server = makeGatewayServer();
    await server.start();

    const response = await postToLoopEndpoint(
      server.getActivePort(),
      buildEvaluateFeatureBody({
        loopId: "fe000099-0000-0000-0000-000000000099",
        artifacts: [{ type: "PRD", content: "PRD content" }],
      })
    );

    assert.equal(
      response.status,
      400,
      `Expected 400 when no Feature artifact provided, got ${response.status}`
    );
    const body = (await response.json()) as { error: string };
    assert.ok(
      body.error.includes("EVALUATE_FEATURE requires"),
      `Error message should mention EVALUATE_FEATURE requires, got: ${body.error}`
    );
  });
});

describe("EVALUATE_FEATURE", () => {
  test("starts without a repo and writes the Feature artifact into the judge workdir", async () => {
    const tmpDir = makeTempDir("evaluate-feature-no-repo");
    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const releaseSentinel = path.join(tmpDir, "release-stub");
    const stub = await setupStubClaudeBlocking(tmpDir, releaseSentinel);
    const server = makeGatewayServer({ getApiOrigin: () => apiBaseUrl });
    await server.start();

    const loopId = "fe000004-0000-0000-0000-000000000004";
    const featureContent = "# Feature: User Authentication\n\nDetails here.";
    const response = await postToLoopEndpoint(
      server.getActivePort(),
      buildEvaluateFeatureBody({
        loopId,
        apiBaseUrl,
        artifacts: [{ type: "FEATURE", content: featureContent }],
      })
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const claudeWorkDir = path.join(
      os.tmpdir(),
      `symphony-evaluate-feature-${loopId.slice(0, 8)}`
    );
    const prdFile = path.join(claudeWorkDir, "prd.md");
    const promptFile = path.join(claudeWorkDir, "evaluate-feature-prompt.txt");

    assert.equal(await fs.readFile(prdFile, "utf-8"), featureContent);
    assert.ok(
      existsSync(promptFile),
      `Prompt file should exist at ${promptFile}`
    );
    const promptContent = await fs.readFile(promptFile, "utf-8");
    assert.ok(
      promptContent.includes("Evaluate the feature artifact"),
      `Prompt should ask Claude to evaluate the feature artifact, got: ${promptContent}`
    );
    assert.ok(
      promptContent.includes(
        "Write feature judge results as JSON to feature-judges.json."
      ),
      `Prompt should contain the feature judge output contract, got: ${promptContent}`
    );
    assert.ok(
      promptContent.includes(`Use work directory: ${claudeWorkDir}.`),
      `Prompt should contain the Claude work directory, got: ${promptContent}`
    );
    assert.ok(
      !promptContent.includes("REPO_PATH"),
      `Prompt should omit REPO_PATH when no repo is linked, got: ${promptContent}`
    );

    await stub.release();
    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );
  });
});

describe("EVALUATE_FEATURE with primaryArtifactId", () => {
  test("writes the primary Feature artifact (child) to prd.md when primaryArtifactId points to child", async () => {
    const tmpDir = makeTempDir("evaluate-feature-primary-artifact-id");
    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const releaseSentinel = path.join(tmpDir, "release-stub");
    const stub = await setupStubClaudeBlocking(tmpDir, releaseSentinel);
    const server = makeGatewayServer({ getApiOrigin: () => apiBaseUrl });
    await server.start();

    const loopId = "fe000010-0000-0000-0000-000000000010";
    const response = await postToLoopEndpoint(server.getActivePort(), {
      loopId,
      command: LoopCommand.EvaluateFeature,
      closedLoopAuthToken: "cl-token",
      apiBaseUrl,
      artifacts: [
        {
          id: "parent-feature-001",
          type: "FEATURE",
          content: "PARENT FEATURE CONTENT",
          title: "Parent",
        },
        {
          id: "child-feature-002",
          type: "FEATURE",
          content: "PRIMARY FEATURE CONTENT",
          title: "Child",
        },
      ],
      primaryArtifactId: "child-feature-002",
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const claudeWorkDir = path.join(
      os.tmpdir(),
      `symphony-evaluate-feature-${loopId.slice(0, 8)}`
    );
    const prdFile = path.join(claudeWorkDir, "prd.md");

    assert.equal(
      await fs.readFile(prdFile, "utf-8"),
      "PRIMARY FEATURE CONTENT"
    );

    await stub.release();
    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );
  });
});

describe("writeFeatureArtifact", () => {
  test("writes Feature content to prd.md and rejects non-Feature inputs", async () => {
    const tmpDir = makeTempDir("write-feature-artifact");
    await writeFeatureArtifact(tmpDir, [
      {
        id: "artifact-001",
        type: LoopArtifactType.Feature,
        content: "This is the Feature content",
      },
    ]);
    assert.equal(
      await fs.readFile(path.join(tmpDir, "prd.md"), "utf-8"),
      "This is the Feature content"
    );

    await assert.rejects(
      () => writeFeatureArtifact(tmpDir, []),
      /no FEATURE artifact found/
    );
    await assert.rejects(
      () =>
        writeFeatureArtifact(tmpDir, [
          {
            id: "artifact-002",
            type: LoopArtifactType.Prd,
            content: "PRD content",
          },
        ]),
      /no FEATURE artifact found/
    );
  });

  test("picks the primary Feature when a Feature context ref precedes it", async () => {
    // Backend appends the primary artifact last; refs (which preserve their
    // underlying document type) come first. For a Feature-from-Feature loop
    // both entries share LoopArtifactType.Feature — the primary is the trailing
    // one, and writing the leading ref would cause judges to score the wrong
    // document.
    const tmpDir = makeTempDir("write-feature-artifact-ordering");
    await writeFeatureArtifact(tmpDir, [
      {
        id: "artifact-003",
        type: LoopArtifactType.Feature,
        content: "PARENT FEATURE (context ref)",
      },
      {
        id: "artifact-004",
        type: LoopArtifactType.Feature,
        content: "PRIMARY FEATURE",
      },
    ]);
    assert.equal(
      await fs.readFile(path.join(tmpDir, "prd.md"), "utf-8"),
      "PRIMARY FEATURE"
    );
  });

  test("delegates to resolvePrimaryArtifact: primaryArtifactId selects first artifact over findLast", async () => {
    // Both artifacts share LoopArtifactType.Feature. Without primaryArtifactId,
    // findLast would return the last (second) artifact. With primaryArtifactId
    // pointing to the first artifact's id, id-based selection wins.
    const tmpDir = makeTempDir("write-feature-artifact-primary-id");
    await writeFeatureArtifact(
      tmpDir,
      [
        {
          id: "feat-primary",
          type: LoopArtifactType.Feature,
          content: "FIRST FEATURE (primary)",
        },
        {
          id: "feat-last",
          type: LoopArtifactType.Feature,
          content: "SECOND FEATURE (trailing)",
        },
      ],
      "feat-primary"
    );
    assert.equal(
      await fs.readFile(path.join(tmpDir, "prd.md"), "utf-8"),
      "FIRST FEATURE (primary)"
    );
  });
});

describe("readEvaluateOutputs(EvaluateArtifact.Feature)", () => {
  test("returns featureJudges from feature-judges.json", () => {
    const tmpDir = makeTempDir("read-feature-outputs");
    const featureJudgesData = { scores: [{ judge: "quality", score: 9 }] };
    writeFileSync(
      path.join(tmpDir, "feature-judges.json"),
      JSON.stringify(featureJudgesData)
    );

    const result = readEvaluateOutputs(tmpDir, EvaluateArtifact.Feature);
    assert.deepEqual(result.featureJudges, featureJudgesData);
  });
});
