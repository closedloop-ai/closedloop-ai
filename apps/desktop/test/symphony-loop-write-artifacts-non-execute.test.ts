/**
 * T-3.1: Unit tests for the non-EXECUTE branch of writeArtifactsForExecuteOrAmend.
 *
 * When an ImplementationPlan artifact has content that is NOT valid JSON (raw
 * markdown), the function must write it to plan-source.md instead of plan.json.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { LoopArtifactType } from "@closedloop-ai/loops-api/artifacts";
import { writeArtifactsForExecuteOrAmend } from "../src/server/operations/symphony-loop.js";
import { PLAN_SOURCE_MARKDOWN_FILE } from "../src/shared/plan-artifact-utils.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const { makeTempDir } = createTempDirManager("write-artifacts-non-execute-");

describe("writeArtifactsForExecuteOrAmend – non-EXECUTE branch, valid JSON artifact content", () => {
  test("writes plan.json when artifact content is valid JSON", async () => {
    const tmpDir = makeTempDir();
    const validJson =
      '{"content":"# Test Plan","pendingTasks":[],"completedTasks":[]}';

    await writeArtifactsForExecuteOrAmend(
      tmpDir,
      [
        {
          id: "plan-json-001",
          type: LoopArtifactType.ImplementationPlan,
          content: validJson,
        },
      ],
      undefined,
      undefined,
      { command: "REQUEST_CHANGES", loopId: "test-loop-id-json" }
    );

    const writtenContent = await fs.readFile(
      path.join(tmpDir, "plan.json"),
      "utf-8"
    );
    assert.equal(writtenContent, validJson);
  });

  test("does NOT write plan-source.md when artifact content is valid JSON", async () => {
    const tmpDir = makeTempDir();
    const validJson =
      '{"content":"# Test Plan","pendingTasks":[],"completedTasks":[]}';

    await writeArtifactsForExecuteOrAmend(
      tmpDir,
      [
        {
          id: "plan-json-002",
          type: LoopArtifactType.ImplementationPlan,
          content: validJson,
        },
      ],
      undefined,
      undefined,
      { command: "REQUEST_CHANGES", loopId: "test-loop-id-json-2" }
    );

    await assert.rejects(
      () => fs.readFile(path.join(tmpDir, PLAN_SOURCE_MARKDOWN_FILE), "utf-8"),
      { code: "ENOENT" },
      "plan-source.md must not be written when artifact content is valid JSON"
    );
  });
});

describe("writeArtifactsForExecuteOrAmend – non-EXECUTE branch, non-JSON artifact content", () => {
  test("writes plan-source.md when artifact content is raw markdown (not valid JSON)", async () => {
    const tmpDir = makeTempDir();
    const rawMarkdown = "# My Plan\n\nThis is a raw markdown plan, not JSON.";

    await writeArtifactsForExecuteOrAmend(
      tmpDir,
      [
        {
          id: "plan-001",
          type: LoopArtifactType.ImplementationPlan,
          content: rawMarkdown,
        },
      ],
      undefined,
      undefined,
      { command: "REQUEST_CHANGES", loopId: "test-loop-id" }
    );

    const writtenContent = await fs.readFile(
      path.join(tmpDir, PLAN_SOURCE_MARKDOWN_FILE),
      "utf-8"
    );
    assert.equal(writtenContent, rawMarkdown);
  });

  test("does NOT write plan.json when artifact content is raw markdown (not valid JSON)", async () => {
    const tmpDir = makeTempDir();
    const rawMarkdown = "# My Plan\n\nThis is raw markdown, not JSON at all.";

    await writeArtifactsForExecuteOrAmend(
      tmpDir,
      [
        {
          id: "plan-002",
          type: LoopArtifactType.ImplementationPlan,
          content: rawMarkdown,
        },
      ],
      undefined,
      undefined,
      { command: "REQUEST_CHANGES", loopId: "test-loop-id" }
    );

    await assert.rejects(
      () => fs.readFile(path.join(tmpDir, "plan.json"), "utf-8"),
      { code: "ENOENT" },
      "plan.json must not be written when artifact content is non-JSON markdown"
    );
  });

  test("removes stale plan.json when artifact content is raw markdown", async () => {
    const tmpDir = makeTempDir();
    const rawMarkdown = "# Updated Plan\n\nUse this markdown plan.";
    await fs.writeFile(
      path.join(tmpDir, "plan.json"),
      JSON.stringify({ content: "# Stale Plan" })
    );

    await writeArtifactsForExecuteOrAmend(
      tmpDir,
      [
        {
          id: "plan-004",
          type: LoopArtifactType.ImplementationPlan,
          content: rawMarkdown,
        },
      ],
      undefined,
      undefined,
      { command: "REQUEST_CHANGES", loopId: "test-loop-id-stale" }
    );

    await assert.rejects(
      () => fs.readFile(path.join(tmpDir, "plan.json"), "utf-8"),
      { code: "ENOENT" },
      "stale plan.json must be removed when importing raw markdown"
    );
    const written = await fs.readFile(
      path.join(tmpDir, PLAN_SOURCE_MARKDOWN_FILE),
      "utf-8"
    );
    assert.equal(written, rawMarkdown);
  });

  test("writes plan-source.md with exact raw content preserved", async () => {
    const tmpDir = makeTempDir();
    const markdownContent =
      "## Tasks\n\n- [ ] Task A\n- [ ] Task B\n\nSome prose with special chars: <>&\"'";

    await writeArtifactsForExecuteOrAmend(
      tmpDir,
      [
        {
          id: "plan-003",
          type: LoopArtifactType.ImplementationPlan,
          content: markdownContent,
        },
      ],
      undefined,
      undefined,
      { command: "REQUEST_CHANGES", loopId: "test-loop-id-2" }
    );

    const written = await fs.readFile(
      path.join(tmpDir, PLAN_SOURCE_MARKDOWN_FILE),
      "utf-8"
    );
    assert.equal(written, markdownContent);
  });
});
