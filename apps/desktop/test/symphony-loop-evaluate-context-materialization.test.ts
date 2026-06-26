import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  createEvaluateTestHarness,
  initGitRepo,
  postToLoopEndpoint,
  setupStubClaudeBlocking,
} from "./symphony-test-utils.js";

const execFileAsync = promisify(execFile);
const originalFetch = globalThis.fetch;
const harness = createEvaluateTestHarness("evaluate-context-materialization");
const { makeTempDir, makeGatewayServer, startEventServer } = harness;

beforeEach(() => {
  globalThis.fetch = originalFetch;
  harness.beforeEach();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await harness.afterEach();
});

describe("evaluate runtime context materialization", () => {
  test("EVALUATE_PRD writes the primary PRD and two supporting refs under context", async () => {
    const run = await startBlockedEvaluateLoop({
      tmpLabel: "evaluate-prd-context",
      loopId: "58500001-0000-0000-0000-000000000001",
      body: {
        loopId: "58500001-0000-0000-0000-000000000001",
        command: LoopCommand.EvaluatePrd,
        closedLoopAuthToken: "cl-token",
        artifacts: [
          { id: "primary-prd", type: "PRD", content: "# Primary PRD" },
        ],
        supportingArtifacts: [
          { id: "ref-one", type: "PRD", content: "# Ref One" },
          { id: "ref-two", type: "FEATURE", content: "# Ref Two" },
        ],
      },
    });

    try {
      assert.equal(
        await fs.readFile(path.join(run.claudeWorkDir, "prd.md"), "utf-8"),
        "# Primary PRD"
      );
      assert.equal(
        await fs.readFile(
          path.join(
            run.claudeWorkDir,
            ".closedloop-ai",
            "context",
            "artifacts",
            "000-prd-ref-one.md"
          ),
          "utf-8"
        ),
        "# Ref One"
      );
      assert.equal(
        await fs.readFile(
          path.join(
            run.claudeWorkDir,
            ".closedloop-ai",
            "context",
            "artifacts",
            "001-feature-ref-two.md"
          ),
          "utf-8"
        ),
        "# Ref Two"
      );
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });

  test("EVALUATE_FEATURE writes legacy prd.md, feature.md, and supporting PRD", async () => {
    const run = await startBlockedEvaluateLoop({
      tmpLabel: "evaluate-feature-context",
      loopId: "58500002-0000-0000-0000-000000000002",
      body: {
        loopId: "58500002-0000-0000-0000-000000000002",
        command: LoopCommand.EvaluateFeature,
        closedLoopAuthToken: "cl-token",
        artifacts: [
          {
            id: "primary-feature",
            type: "FEATURE",
            content: "# Primary Feature",
          },
        ],
        supportingArtifacts: [
          { id: "support-prd", type: "PRD", content: "# Supporting PRD" },
        ],
      },
    });

    try {
      assert.equal(
        await fs.readFile(path.join(run.claudeWorkDir, "prd.md"), "utf-8"),
        "# Primary Feature"
      );
      assert.equal(
        await fs.readFile(path.join(run.claudeWorkDir, "feature.md"), "utf-8"),
        "# Primary Feature"
      );
      assert.equal(
        await fs.readFile(
          path.join(
            run.claudeWorkDir,
            ".closedloop-ai",
            "context",
            "artifacts",
            "000-prd-support-prd.md"
          ),
          "utf-8"
        ),
        "# Supporting PRD"
      );
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });

  test("EVALUATE_PLAN writes plan, prompt context, prior summaries, and repo info", async () => {
    const tmpDir = makeTempDir("evaluate-plan-context");
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const run = await startBlockedEvaluateLoop({
      tmpDir,
      loopId: "58500003-0000-0000-0000-000000000003",
      allowedDirs: [tmpDir],
      body: {
        loopId: "58500003-0000-0000-0000-000000000003",
        command: LoopCommand.EvaluatePlan,
        closedLoopAuthToken: "cl-token",
        localRepoPath: repoDir,
        artifacts: [
          { id: "primary-prd", type: "PRD", content: "# Primary PRD" },
          {
            id: "primary-plan",
            type: "IMPLEMENTATION_PLAN",
            content: "# Primary Plan",
          },
        ],
        prompt: "Prioritize migrations before UI work.",
        priorLoopSummaries: [
          { loopId: "prior-1", summary: "Created the first API draft." },
        ],
      },
    });

    try {
      const contextDir = path.join(
        run.claudeWorkDir,
        ".closedloop-ai",
        "context"
      );
      assert.equal(
        await fs.readFile(path.join(run.claudeWorkDir, "plan.md"), "utf-8"),
        "# Primary Plan"
      );
      assert.equal(
        await fs.readFile(path.join(contextDir, "prompt.md"), "utf-8"),
        "Prioritize migrations before UI work."
      );
      assert.deepEqual(
        await readJson(path.join(contextDir, "prior-loop-summaries.json")),
        [{ loopId: "prior-1", summary: "Created the first API draft." }]
      );
      assert.deepEqual(
        await readJson(path.join(contextDir, "repo-info.json")),
        {
          localRepoPath: repoDir,
        }
      );
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });

  test("optional repo commands do not materialize rejected localRepoPath", async () => {
    const tmpDir = makeTempDir("evaluate-prd-rejected-path");
    const rejectedRepoPath = path.join(
      os.tmpdir(),
      `outside-fea-585-repo-${process.pid}-${Date.now()}`
    );
    await fs.mkdir(rejectedRepoPath, { recursive: true });

    const run = await startBlockedEvaluateLoop({
      tmpDir,
      loopId: "58500007-0000-0000-0000-000000000007",
      allowedDirs: [tmpDir],
      body: {
        loopId: "58500007-0000-0000-0000-000000000007",
        command: LoopCommand.EvaluatePrd,
        closedLoopAuthToken: "cl-token",
        localRepoPath: rejectedRepoPath,
        artifacts: [
          { id: "primary-prd", type: "PRD", content: "# Primary PRD" },
        ],
        supportingArtifacts: [
          { id: "support-prd", type: "PRD", content: "# Supporting PRD" },
        ],
      },
    });

    try {
      const contextDir = path.join(
        run.claudeWorkDir,
        ".closedloop-ai",
        "context"
      );
      assert.equal(
        await pathExists(path.join(contextDir, "repo-info.json")),
        false
      );
      assert.equal(
        await fs.readFile(
          path.join(contextDir, "artifacts", "000-prd-support-prd.md"),
          "utf-8"
        ),
        "# Supporting PRD"
      );
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });

  test("EVALUATE_CODE materializes repo-known code context and attachments", async () => {
    const tmpDir = makeTempDir("evaluate-code-context");
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await execFileAsync("git", ["checkout", "-b", "feature/evaluate-code"], {
      cwd: repoDir,
    });

    const attachmentFetches: string[] = [];
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (
        url.startsWith("https://closedloop-files.s3.us-east-1.amazonaws.com/")
      ) {
        attachmentFetches.push(url);
        return new Response("attachment-bytes", { status: 200 });
      }
      return originalFetch(input, init);
    };

    const loopId = "58500004-0000-0000-0000-000000000004";
    const run = await startBlockedEvaluateLoop({
      tmpDir,
      loopId,
      allowedDirs: [tmpDir],
      body: {
        loopId,
        command: LoopCommand.EvaluateCode,
        closedLoopAuthToken: "cl-token",
        localRepoPath: repoDir,
        repo: { fullName: "org/repo", branch: "main" },
        artifacts: [
          {
            id: "primary-plan",
            type: "IMPLEMENTATION_PLAN",
            content: "# Implementation Plan",
          },
        ],
        supportingArtifacts: [
          {
            id: "parent-prd",
            type: "PRD",
            filename: "parent-prd.md",
            content: "# Parent PRD",
          },
          {
            id: "design",
            type: "IMPLEMENTATION_PLAN",
            filename: "design.json",
            content: '{"status":"approved"}',
          },
        ],
        priorLoopSummaries: [{ loopId: "prior-2", summary: "Prior loop" }],
        attachments: [
          {
            id: "att-1",
            filename: "screen.png",
            signedUrl:
              "https://closedloop-files.s3.us-east-1.amazonaws.com/user/screen.png?X-Amz-Signature=test",
            signedUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            sizeBytes: "attachment-bytes".length,
          },
        ],
        codeEvaluationContext: {
          parentBranchName: "main",
          parentSessionId: "session-123",
          artifactSlug: "PLN-573",
          pullRequest: {
            number: 573,
            url: "https://github.com/org/repo/pull/573",
            headBranch: "feature/evaluate-code",
            baseBranch: "main",
            headSha: "abc1234",
            repositoryFullName: "org/repo",
          },
        },
      },
    });

    try {
      const contextDir = path.join(
        run.claudeWorkDir,
        ".closedloop-ai",
        "context"
      );
      const codeContext = await readJson(
        path.join(contextDir, "code-context.json")
      );
      assert.equal(codeContext.schemaVersion, 1);
      assert.deepEqual(codeContext.repo, {
        fullName: "org/repo",
        branch: "main",
      });
      assert.equal(codeContext.localRepoPath, repoDir);
      assert.equal(codeContext.parentBranchName, "main");
      assert.equal(codeContext.parentSessionId, "session-123");
      assert.equal(codeContext.artifactSlug, "PLN-573");
      assert.equal(codeContext.pullRequest.number, 573);
      assert.equal(codeContext.detected.branch, "feature/evaluate-code");
      assert.match(codeContext.detected.headSha, /^[0-9a-f]{40}$/);
      assert.equal(codeContext.detected.gitDetectionError, null);

      assert.deepEqual(
        await readJson(path.join(contextDir, "repo-info.json")),
        {
          repo: { fullName: "org/repo", branch: "main" },
          localRepoPath: repoDir,
        }
      );
      assert.equal(
        await fs.readFile(
          path.join(contextDir, "artifacts", "000-prd-parent-prd.md"),
          "utf-8"
        ),
        "# Parent PRD"
      );
      assert.equal(
        await fs.readFile(
          path.join(
            contextDir,
            "artifacts",
            "001-implementation-plan-design.json"
          ),
          "utf-8"
        ),
        '{"status":"approved"}'
      );
      assert.equal(
        await fs.readFile(
          path.join(
            run.claudeWorkDir,
            ".closedloop-ai",
            "work",
            "attachments",
            "att-1-screen.png"
          ),
          "utf-8"
        ),
        "attachment-bytes"
      );
      assert.equal(
        await pathExists(path.join(run.claudeWorkDir, "attachments")),
        false
      );
      assert.equal(attachmentFetches.length, 1);
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });

  test("localRepoPath-only EVALUATE_CODE records git detection failures and continues", async () => {
    const tmpDir = makeTempDir("evaluate-code-local-only");
    const repoDir = path.join(tmpDir, "not-a-git-repo");
    await fs.mkdir(repoDir, { recursive: true });

    const loopId = "58500005-0000-0000-0000-000000000005";
    const run = await startBlockedEvaluateLoop({
      tmpDir,
      loopId,
      allowedDirs: [tmpDir],
      body: {
        loopId,
        command: LoopCommand.EvaluateCode,
        closedLoopAuthToken: "cl-token",
        localRepoPath: repoDir,
        artifacts: [
          {
            id: "primary-plan",
            type: "IMPLEMENTATION_PLAN",
            content: "# Implementation Plan",
          },
        ],
      },
    });

    try {
      const codeContext = await readJson(
        path.join(
          run.claudeWorkDir,
          ".closedloop-ai",
          "context",
          "code-context.json"
        )
      );
      assert.equal(codeContext.schemaVersion, 1);
      assert.equal(codeContext.localRepoPath, repoDir);
      assert.equal(codeContext.repo, undefined);
      assert.equal(typeof codeContext.detected.gitDetectionError, "string");
      assert.ok(codeContext.detected.gitDetectionError.length > 0);
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });

  test("old primary-only evaluate bodies remain compatible", async () => {
    const run = await startBlockedEvaluateLoop({
      tmpLabel: "evaluate-prd-primary-only",
      loopId: "58500006-0000-0000-0000-000000000006",
      body: {
        loopId: "58500006-0000-0000-0000-000000000006",
        command: LoopCommand.EvaluatePrd,
        closedLoopAuthToken: "cl-token",
        artifacts: [{ id: "primary-prd", type: "PRD", content: "# Primary" }],
      },
    });

    try {
      assert.equal(
        await fs.readFile(path.join(run.claudeWorkDir, "prd.md"), "utf-8"),
        "# Primary"
      );
      assert.equal(
        await pathExists(
          path.join(run.claudeWorkDir, ".closedloop-ai", "context")
        ),
        false
      );
    } finally {
      await finishBlockedEvaluateLoop(run);
    }
  });
});

async function startBlockedEvaluateLoop(options: {
  tmpLabel?: string;
  tmpDir?: string;
  loopId: string;
  allowedDirs?: string[];
  body: Record<string, unknown>;
}): Promise<{
  claudeWorkDir: string;
  eventServer: Awaited<ReturnType<typeof startEventServer>>;
  release: () => Promise<void>;
}> {
  const tmpDir =
    options.tmpDir ?? makeTempDir(options.tmpLabel ?? "evaluate-context");
  const releaseSentinel = path.join(tmpDir, `release-${options.loopId}`);
  const stub = await setupStubClaudeBlocking(tmpDir, releaseSentinel);
  const eventServer = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventServer.port}`;
  const server = makeGatewayServer({
    allowedDirs: options.allowedDirs ?? [tmpDir],
    getApiOrigin: () => apiBaseUrl,
    tmpDir,
  });
  await server.start();

  const response = await postToLoopEndpoint(server.getActivePort(), {
    ...options.body,
    apiBaseUrl,
  });
  assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

  const command = String(options.body.command)
    .toLowerCase()
    .replaceAll("_", "-");
  return {
    claudeWorkDir: path.join(
      os.tmpdir(),
      `symphony-${command}-${options.loopId.slice(0, 8)}`
    ),
    eventServer,
    release: stub.release,
  };
}

async function finishBlockedEvaluateLoop(run: {
  eventServer: Awaited<ReturnType<typeof startEventServer>>;
  release: () => Promise<void>;
}): Promise<void> {
  await run.release();
  await run.eventServer.waitForEvent(
    (body) => body.type === "completed" || body.type === "error",
    15_000
  );
}

async function readJson(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<
    string,
    any
  >;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
