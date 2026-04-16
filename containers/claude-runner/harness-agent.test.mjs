import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { LoopArtifactType } from "@closedloop-ai/loops-api/artifacts";

import {
  buildClaudeDirectArgs,
  buildCommand,
  config,
  ERROR_CODES,
  extractSessionId,
  findExistingRunDir,
  getHomeStateTransferPrefix,
  getWorkspaceStateRestorePrefixes,
  getWorkspaceStateUploadPrefixes,
  HarnessError,
  parsePrInfo,
  parseTokenUsage,
  parseTokenUsageFromJsonl,
  parseTokenUsageFromJsonlFile,
  parseTokenUsageFromRegex,
  syncPlanFromContextPack,
  validateConfig,
  validatePreRunInputs,
  validateSecrets,
  writeContextPackFiles,
  writeExecutionResult,
  writePrdFile,
} from "./harness-agent.mjs";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Create a temporary directory. Cleanup happens in the after() hook above.
 */
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write prompt.md into the expected context directory under workDir.
 */
function writePromptFile(workDir, content = "Evaluate this PRD.") {
  const contextDir = path.join(workDir, ".closedloop-ai", "context");
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, "prompt.md"), content);
}

/**
 * Reset shared config to a known baseline. Must be called in each test that
 * reads or mutates config — it is module-level shared state in harness-agent.
 */
function resetConfig(overrides = {}) {
  config.loopId = "test-loop-id";
  config.command = "EVALUATE_PRD";
  config.authToken = "test-auth-token";
  config.apiBaseUrl = "https://api.example.com";
  config.targetRepo = null;
  config.targetBranch = "main";
  config.anthropicApiKey = null;
  config.githubToken = null;
  config.parentSessionId = null;
  config.parentBranchName = null;
  Object.assign(config, overrides);
}

// ---------------------------------------------------------------------------
// (a) buildCommand() returns { cmd: "claude" } for EVALUATE_PRD
// ---------------------------------------------------------------------------

test("buildCommand returns cmd=claude for EVALUATE_PRD", () => {
  const workDir = makeTempDir();
  writePromptFile(workDir);
  resetConfig({ command: "EVALUATE_PRD" });

  const { cmd } = buildCommand(workDir, null, null);

  assert.equal(cmd, "claude");
});

// ---------------------------------------------------------------------------
// (b) buildClaudeDirectArgs with EVALUATE_PRD produces a judges:run-judges
//     skill invocation with --artifact-type prd embedded in the prompt string
// ---------------------------------------------------------------------------

test("buildClaudeDirectArgs with EVALUATE_PRD invokes judges:run-judges with artifact-type prd", () => {
  const workDir = makeTempDir();
  resetConfig({ command: "EVALUATE_PRD" });

  const { cmd, args } = buildClaudeDirectArgs(workDir, null);

  assert.equal(cmd, "claude");

  const prompt = args.find(
    (a) => typeof a === "string" && a.includes("judges:run-judges")
  );
  assert.ok(
    prompt !== undefined,
    `args must contain a prompt referencing judges:run-judges; got: ${JSON.stringify(args)}`
  );
  assert.ok(
    prompt.includes("--artifact-type prd"),
    `prompt must contain --artifact-type prd; got: ${prompt}`
  );
  assert.ok(
    prompt.includes(`--workdir ${workDir}`),
    `prompt must contain --workdir <workDir>; got: ${prompt}`
  );
  // --artifact-type prd is embedded in the prompt string, not a separate argv entry
  assert.equal(
    args.indexOf("--artifact-type"),
    -1,
    "args must NOT contain --artifact-type as a separate flag (it belongs inside the prompt)"
  );
});

// ---------------------------------------------------------------------------
// (d) validateConfig does not push targetRepo to requiredEnv for EVALUATE_PRD
// ---------------------------------------------------------------------------

test("validateConfig does not require targetRepo for EVALUATE_PRD", () => {
  resetConfig({ command: "EVALUATE_PRD", targetRepo: undefined });

  assert.doesNotThrow(() => validateConfig());
});

test("validateConfig requires targetRepo for PLAN", () => {
  resetConfig({ command: "PLAN", targetRepo: undefined });

  assert.throws(
    () => validateConfig(),
    (err) => {
      assert.ok(err instanceof HarnessError, "must be a HarnessError");
      assert.equal(err.code, ERROR_CODES.config);
      assert.match(err.message, /targetRepo/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (e) validateSecrets pushes githubToken only when config.targetRepo is set
// ---------------------------------------------------------------------------

test("validateSecrets does not require githubToken for EVALUATE_PRD without targetRepo", () => {
  resetConfig({
    command: "EVALUATE_PRD",
    targetRepo: null,
    anthropicApiKey: "sk-test",
    githubToken: null,
  });

  assert.doesNotThrow(() => validateSecrets());
});

test("validateSecrets requires githubToken for EVALUATE_PRD when targetRepo is set", () => {
  resetConfig({
    command: "EVALUATE_PRD",
    targetRepo: "owner/repo",
    anthropicApiKey: "sk-test",
    githubToken: null,
  });

  assert.throws(
    () => validateSecrets(),
    (err) => {
      assert.ok(err instanceof HarnessError, "must be a HarnessError");
      assert.equal(err.code, ERROR_CODES.secrets);
      assert.match(err.message, /githubToken/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (f) validatePreRunInputs throws HarnessError with preRunValidation when
//     contextPack.artifacts is empty for EVALUATE_PRD
// ---------------------------------------------------------------------------

test("validatePreRunInputs throws preRunValidation for EVALUATE_PRD with empty artifacts array", () => {
  assert.throws(
    () => validatePreRunInputs("EVALUATE_PRD", { artifacts: [] }),
    (err) => {
      assert.ok(err instanceof HarnessError, "must be a HarnessError");
      assert.equal(err.code, ERROR_CODES.preRunValidation);
      return true;
    }
  );
});

test("validatePreRunInputs throws preRunValidation for EVALUATE_PRD with no artifacts key", () => {
  assert.throws(
    () => validatePreRunInputs("EVALUATE_PRD", {}),
    (err) => {
      assert.ok(err instanceof HarnessError, "must be a HarnessError");
      assert.equal(err.code, ERROR_CODES.preRunValidation);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (g) validatePreRunInputs does NOT throw when artifacts is non-empty and
//     prompt is absent for EVALUATE_PRD
// ---------------------------------------------------------------------------

test("validatePreRunInputs does not throw for EVALUATE_PRD with non-empty artifacts and no prompt", () => {
  const contextPack = {
    artifacts: [
      { id: "1", type: LoopArtifactType.Prd, content: "some prd content" },
    ],
    // prompt intentionally absent
  };

  assert.doesNotThrow(() => validatePreRunInputs("EVALUATE_PRD", contextPack));
});

describe("writeContextPackFiles context directory", () => {
  test("writes prompt/artifacts under .closedloop-ai/context (not .claude/context)", async () => {
    const workDir = makeTempDir();
    const pack = {
      prompt: "Use this context prompt",
      artifacts: [
        {
          id: "artifact-123",
          type: "PRD",
          title: "Source PRD",
          content: "PRD body content",
        },
      ],
      repoInfo: { fullName: "owner/repo", branch: "main" },
      priorLoopSummaries: [
        {
          loopId: "loop-1",
          command: "PLAN",
          summary: "Completed prior run",
        },
      ],
    };

    await writeContextPackFiles(workDir, pack);

    const closedloopContextDir = path.join(
      workDir,
      ".closedloop-ai",
      "context"
    );
    const claudeContextDir = path.join(workDir, ".claude", "context");
    const promptPath = path.join(closedloopContextDir, "prompt.md");
    const artifactPath = path.join(
      closedloopContextDir,
      "artifacts",
      "prd-artifact-123.md"
    );
    const repoInfoPath = path.join(closedloopContextDir, "repo-info.json");
    const priorLoopsPath = path.join(closedloopContextDir, "prior-loops.md");

    assert.ok(
      fs.existsSync(promptPath),
      "prompt.md should exist under closedloop context"
    );
    assert.equal(
      fs.readFileSync(promptPath, "utf-8"),
      "Use this context prompt",
      "prompt.md content should match pack prompt"
    );

    assert.ok(
      fs.existsSync(artifactPath),
      "artifact markdown should exist under .closedloop-ai/context/artifacts"
    );
    const artifactContent = fs.readFileSync(artifactPath, "utf-8");
    assert.ok(
      artifactContent.includes("# Source PRD"),
      "artifact markdown should include title header"
    );
    assert.ok(
      artifactContent.includes("PRD body content"),
      "artifact markdown should include artifact content"
    );

    assert.ok(fs.existsSync(repoInfoPath), "repo-info.json should exist");
    assert.ok(fs.existsSync(priorLoopsPath), "prior-loops.md should exist");

    assert.ok(
      !fs.existsSync(claudeContextDir),
      ".claude/context should not be created by writeContextPackFiles"
    );
  });
});

describe("buildClaudeDirectArgs context path", () => {
  test("DECOMPOSE reads prompt from .closedloop-ai/context/prompt.md", () => {
    const workDir = makeTempDir();
    const closedloopContextDir = path.join(
      workDir,
      ".closedloop-ai",
      "context"
    );
    const claudeContextDir = path.join(workDir, ".claude", "context");
    fs.mkdirSync(closedloopContextDir, { recursive: true });
    fs.mkdirSync(claudeContextDir, { recursive: true });

    fs.writeFileSync(
      path.join(closedloopContextDir, "prompt.md"),
      "prompt-from-closedloop"
    );
    fs.writeFileSync(
      path.join(claudeContextDir, "prompt.md"),
      "prompt-from-claude"
    );

    resetConfig({ command: "DECOMPOSE" });
    const { args } = buildClaudeDirectArgs(workDir, null);

    assert.ok(
      args.includes("prompt-from-closedloop"),
      "DECOMPOSE should load prompt from .closedloop-ai/context"
    );
    assert.ok(
      !args.includes("prompt-from-claude"),
      "DECOMPOSE should not load prompt from .claude/context"
    );
  });
});

describe("findExistingRunDir workspace path", () => {
  test("uses .closedloop-ai/runs and ignores .claude/runs", () => {
    const workDir = makeTempDir();
    const closedloopRuns = path.join(workDir, ".closedloop-ai", "runs");
    const legacyRuns = path.join(workDir, ".claude", "runs");

    fs.mkdirSync(path.join(closedloopRuns, "20260407-120000-loop-new"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(legacyRuns, "20260407-120001-loop-legacy"), {
      recursive: true,
    });

    const resolved = findExistingRunDir(workDir);
    assert.equal(
      resolved,
      path.join(closedloopRuns, "20260407-120000-loop-new"),
      "findExistingRunDir should resolve from .closedloop-ai/runs"
    );
  });
});

describe("state transfer prefixes", () => {
  test("builds restore prefixes with legacy fallback", () => {
    assert.deepEqual(getWorkspaceStateRestorePrefixes("loops/parent-123"), [
      "loops/parent-123/closedloop-state",
      "loops/parent-123/claude-state",
    ]);
  });

  test("builds upload prefixes for workspace and home state", () => {
    assert.deepEqual(getWorkspaceStateUploadPrefixes("loops/current-456"), [
      "loops/current-456/closedloop-state",
      "loops/current-456/claude-state",
    ]);
    assert.equal(
      getHomeStateTransferPrefix("loops/current-456"),
      "loops/current-456/home-claude-state"
    );
  });
});

// ---------------------------------------------------------------------------
// writeContextPackFiles — attachment file writing
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid attachment object for testing.
 */
function makeAttachment(overrides = {}) {
  const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
  return {
    id: "att-001",
    filename: "report.pdf",
    signedUrl: "https://example.com/signed/report.pdf",
    signedUrlExpiresAt: futureDate,
    sizeBytes: 11,
    ...overrides,
  };
}

/**
 * Install a mock fetch on globalThis and return a restore function.
 * The mock returns the provided response for every call.
 */
function mockFetch(responseFn) {
  const original = globalThis.fetch;
  globalThis.fetch = responseFn;
  return () => {
    globalThis.fetch = original;
  };
}

describe("writeContextPackFiles attachments", () => {
  // (1) Attachments present writes files with `{id}-{sanitizedName}` disk name
  test("writes attachment files with {id}-{sanitizedName} disk name in attachments dir", async () => {
    const workDir = makeTempDir();
    const fileContent = Buffer.from("hello world");
    const restore = mockFetch(async (_url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        fileContent.buffer.slice(
          fileContent.byteOffset,
          fileContent.byteOffset + fileContent.byteLength
        ),
    }));

    try {
      const attachment = makeAttachment({
        id: "att-001",
        filename: "report.pdf",
        sizeBytes: fileContent.length,
      });
      await writeContextPackFiles(workDir, { attachments: [attachment] });

      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      const expectedFile = path.join(attachmentsDir, "att-001-report.pdf");
      assert.ok(
        fs.existsSync(expectedFile),
        `Expected file ${expectedFile} to exist`
      );
      const written = fs.readFileSync(expectedFile);
      assert.deepEqual(written, fileContent);
    } finally {
      restore();
    }
  });

  // (2) No `attachments` field is a no-op
  test("no attachments field is a no-op and does not throw", async () => {
    const workDir = makeTempDir();
    const restore = mockFetch(async () => {
      throw new Error("fetch should not be called");
    });

    try {
      await writeContextPackFiles(workDir, { prompt: "hello" });
      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      assert.ok(
        !fs.existsSync(attachmentsDir),
        "attachments directory should not be created when no attachments in pack"
      );
    } finally {
      restore();
    }
  });

  // (3) Expired `signedUrlExpiresAt` skips file and calls log('warn', ...)
  test("expired signedUrlExpiresAt skips file download", async () => {
    const workDir = makeTempDir();
    let fetchCalled = false;
    const restore = mockFetch(async (_url) => {
      fetchCalled = true;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("data").buffer,
      };
    });

    try {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      const attachment = makeAttachment({
        id: "att-expired",
        filename: "secret.txt",
        signedUrlExpiresAt: pastDate,
        sizeBytes: 4,
      });
      await writeContextPackFiles(workDir, { attachments: [attachment] });

      assert.ok(
        !fetchCalled,
        "fetch should not be called for expired attachment"
      );
      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      const expectedFile = path.join(attachmentsDir, "att-expired-secret.txt");
      assert.ok(
        !fs.existsSync(expectedFile),
        "expired attachment file should not be written"
      );
    } finally {
      restore();
    }
  });

  // (4) fetch returns non-200 response skips file and warns
  test("non-200 fetch response skips file download", async () => {
    const workDir = makeTempDir();
    const restore = mockFetch(async (_url) => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      arrayBuffer: async () => Buffer.alloc(0).buffer,
    }));

    try {
      const attachment = makeAttachment({
        id: "att-403",
        filename: "doc.txt",
        sizeBytes: 100,
      });
      await writeContextPackFiles(workDir, { attachments: [attachment] });

      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      const expectedFile = path.join(attachmentsDir, "att-403-doc.txt");
      assert.ok(
        !fs.existsSync(expectedFile),
        "file should not be written when fetch returns 403"
      );
    } finally {
      restore();
    }
  });

  // (5) Path traversal filename `../../etc/passwd` is sanitized by path.basename to `passwd`
  //     but resolved-path prefix assertion skips the file
  test("path traversal filename is sanitized by path.basename to a safe name", async () => {
    const workDir = makeTempDir();
    const fileContent = Buffer.from("pwned");
    const restore = mockFetch(async (_url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        fileContent.buffer.slice(
          fileContent.byteOffset,
          fileContent.byteOffset + fileContent.byteLength
        ),
    }));

    try {
      const attachment = makeAttachment({
        id: "att-traversal",
        filename: "../../etc/passwd",
        sizeBytes: fileContent.length,
      });
      await writeContextPackFiles(workDir, { attachments: [attachment] });

      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );

      // path.basename("../../etc/passwd") → "passwd", sanitized → "passwd"
      // The resulting disk path stays inside attachmentsDir, so the file IS written
      // (the traversal is neutralized by basename, not by the prefix guard).
      const safeFile = path.join(attachmentsDir, "att-traversal-passwd");
      assert.ok(
        fs.existsSync(safeFile),
        "basename-sanitized file should be written safely inside attachments dir"
      );

      // The original traversal path must NOT exist on disk
      const traversalTarget = "/etc/passwd";
      const originalContent = fs.existsSync(traversalTarget)
        ? fs.readFileSync(traversalTarget, "utf-8")
        : null;
      if (originalContent !== null) {
        assert.notEqual(
          fs.readFileSync(traversalTarget, "utf-8"),
          "pwned",
          "original /etc/passwd must not have been overwritten"
        );
      }
    } finally {
      restore();
    }
  });

  // (6) Byte count of downloaded buffer exceeds `attachment.sizeBytes` skips file
  test("buffer size exceeding sizeBytes skips file and does not write", async () => {
    const workDir = makeTempDir();
    const oversizedContent = Buffer.from(
      "this is way too large for declared size"
    );
    const restore = mockFetch(async (_url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        oversizedContent.buffer.slice(
          oversizedContent.byteOffset,
          oversizedContent.byteOffset + oversizedContent.byteLength
        ),
    }));

    try {
      const attachment = makeAttachment({
        id: "att-oversized",
        filename: "small.txt",
        sizeBytes: 5, // declared 5 bytes, but download returns 39 bytes
      });
      await writeContextPackFiles(workDir, { attachments: [attachment] });

      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      const expectedFile = path.join(attachmentsDir, "att-oversized-small.txt");
      assert.ok(
        !fs.existsSync(expectedFile),
        "oversized attachment file should not be written"
      );
    } finally {
      restore();
    }
  });

  // (7) Two attachments with same original filename but different IDs are both written
  test("two attachments with same filename but different IDs are both written without collision", async () => {
    const workDir = makeTempDir();
    const content1 = Buffer.from("content one");
    const content2 = Buffer.from("content two");
    let callCount = 0;
    const restore = mockFetch(async (_url) => {
      callCount++;
      const buf = callCount === 1 ? content1 : content2;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    });

    try {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const attachments = [
        {
          id: "id-aaa",
          filename: "notes.txt",
          signedUrl: "https://example.com/signed/aaa",
          signedUrlExpiresAt: futureDate,
          sizeBytes: content1.length,
        },
        {
          id: "id-bbb",
          filename: "notes.txt",
          signedUrl: "https://example.com/signed/bbb",
          signedUrlExpiresAt: futureDate,
          sizeBytes: content2.length,
        },
      ];
      await writeContextPackFiles(workDir, { attachments });

      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      const file1 = path.join(attachmentsDir, "id-aaa-notes.txt");
      const file2 = path.join(attachmentsDir, "id-bbb-notes.txt");

      assert.ok(fs.existsSync(file1), "first attachment file should exist");
      assert.ok(fs.existsSync(file2), "second attachment file should exist");
      assert.deepEqual(
        fs.readFileSync(file1),
        content1,
        "first file content must match"
      );
      assert.deepEqual(
        fs.readFileSync(file2),
        content2,
        "second file content must match"
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// parseTokenUsage
// ---------------------------------------------------------------------------

describe("parseTokenUsage", () => {
  test("parses single model usage line", () => {
    const result = parseTokenUsage([
      { line: "Model: claude-opus-4-6  Input: 12,345  Output: 6,789" },
    ]);
    assert.deepEqual(result.tokensByModel, {
      "claude-opus-4": { input: 12_345, output: 6789 },
    });
    assert.equal(result.totalInput, 12_345);
    assert.equal(result.totalOutput, 6789);
  });

  test("parses cache creation and read tokens", () => {
    const result = parseTokenUsage([
      {
        line: "Model: claude-sonnet-4-5  Input: 1,000  Output: 500  Cache creation: 200  Cache read: 300",
      },
    ]);
    const model = result.tokensByModel["claude-sonnet-4-5"];
    assert.equal(model.input, 1000);
    assert.equal(model.output, 500);
    assert.equal(model.cacheCreation, 200);
    assert.equal(model.cacheRead, 300);
  });

  test("accumulates multiple lines for the same model", () => {
    const result = parseTokenUsage([
      { line: "Model: claude-opus-4  Input: 100  Output: 50" },
      { line: "Model: claude-opus-4  Input: 200  Output: 75" },
    ]);
    assert.deepEqual(result.tokensByModel["claude-opus-4"], {
      input: 300,
      output: 125,
    });
  });

  test("parses multiple models", () => {
    const result = parseTokenUsage([
      { line: "Model: claude-opus-4  Input: 100  Output: 50" },
      { line: "Model: claude-haiku-4-5  Input: 500  Output: 200" },
    ]);
    assert.equal(Object.keys(result.tokensByModel).length, 2);
    assert.equal(result.totalInput, 600);
    assert.equal(result.totalOutput, 250);
  });

  test("returns null tokensByModel when no model lines found", () => {
    const result = parseTokenUsage([
      { line: "Total input tokens: 5,000" },
      { line: "Total output tokens: 2,000" },
    ]);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 5000);
    assert.equal(result.totalOutput, 2000);
  });

  test("returns zeros for empty output", () => {
    const result = parseTokenUsage([]);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 0);
    assert.equal(result.totalOutput, 0);
  });

  test("prefers model sum over total lines when both present", () => {
    const result = parseTokenUsage([
      { line: "Model: claude-opus-4  Input: 100  Output: 50" },
      { line: "Total input tokens: 999" },
      { line: "Total output tokens: 888" },
    ]);
    // Model sum (100, 50) takes precedence over total lines (999, 888)
    assert.equal(result.totalInput, 100);
    assert.equal(result.totalOutput, 50);
  });

  test("handles lines without .line property", () => {
    const result = parseTokenUsage([{}, { line: "" }, { other: "field" }]);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 0);
  });

  test("normalizes model names with date suffixes", () => {
    const result = parseTokenUsage([
      { line: "Model: claude-sonnet-4-5-20250929  Input: 100  Output: 50" },
    ]);
    assert.ok(result.tokensByModel["claude-sonnet-4-5"]);
    assert.equal(result.tokensByModel["claude-sonnet-4-5"].input, 100);
  });
});

// ---------------------------------------------------------------------------
// parsePrInfo — output scanning logic (git-dependent branch detection is
// tested indirectly; we focus on the PR URL extraction from output lines)
// ---------------------------------------------------------------------------

describe("parsePrInfo", () => {
  // parsePrInfo calls detectBranchName(workDir) which requires a git repo.
  // For unit tests we pass a non-repo dir so branch is null, isolating
  // the output-scanning logic.

  test("extracts PR URL from output lines (scans backward)", () => {
    const workDir = makeTempDir();
    const lines = [
      { line: "Compiling..." },
      { line: "https://github.com/org/repo/pull/42" },
      { line: "Done." },
    ];
    const result = parsePrInfo(workDir, lines);
    assert.equal(result.prUrl, "https://github.com/org/repo/pull/42");
    assert.equal(result.prNumber, 42);
  });

  test("returns last PR URL when multiple are present", () => {
    const workDir = makeTempDir();
    const lines = [
      { line: "https://github.com/org/repo/pull/1" },
      { line: "some output" },
      { line: "https://github.com/org/repo/pull/99" },
    ];
    // Scans backward — finds 99 first
    const result = parsePrInfo(workDir, lines);
    assert.equal(result.prNumber, 99);
  });

  test("returns null when no PR URL and no branch", () => {
    const workDir = makeTempDir();
    const result = parsePrInfo(workDir, [{ line: "no pr here" }, { line: "" }]);
    assert.equal(result, null);
  });

  test("handles empty output lines", () => {
    const workDir = makeTempDir();
    const result = parsePrInfo(workDir, []);
    assert.equal(result, null);
  });

  test("extracts PR number from embedded URL", () => {
    const workDir = makeTempDir();
    const lines = [
      {
        line: "Created PR: https://github.com/closedloop-ai/symphony/pull/123 for review",
      },
    ];
    const result = parsePrInfo(workDir, lines);
    assert.equal(
      result.prUrl,
      "https://github.com/closedloop-ai/symphony/pull/123"
    );
    assert.equal(result.prNumber, 123);
  });
});

// ---------------------------------------------------------------------------
// writePrdFile — content priority logic
// ---------------------------------------------------------------------------

describe("writePrdFile", () => {
  test("uses prompt when present", () => {
    const dir = makeTempDir();
    const result = writePrdFile(dir, { prompt: "My PRD content" });
    assert.ok(result);
    assert.equal(fs.readFileSync(result, "utf-8"), "My PRD content");
  });

  test("falls back to PRD artifact when no prompt", () => {
    const dir = makeTempDir();
    const result = writePrdFile(dir, {
      artifacts: [
        { id: "1", type: LoopArtifactType.Prd, content: "PRD from artifact" },
      ],
    });
    assert.ok(result);
    assert.equal(fs.readFileSync(result, "utf-8"), "PRD from artifact");
  });

  test("falls back to FEATURE artifact when no prompt or PRD", () => {
    const dir = makeTempDir();
    const result = writePrdFile(dir, {
      artifacts: [
        {
          id: "1",
          type: LoopArtifactType.Feature,
          content: "Feature description",
        },
      ],
    });
    assert.ok(result);
    assert.equal(fs.readFileSync(result, "utf-8"), "Feature description");
  });

  test("prefers PRD over FEATURE artifact", () => {
    const dir = makeTempDir();
    const result = writePrdFile(dir, {
      artifacts: [
        { id: "1", type: LoopArtifactType.Feature, content: "Feature text" },
        { id: "2", type: LoopArtifactType.Prd, content: "PRD text" },
      ],
    });
    assert.ok(result);
    assert.equal(fs.readFileSync(result, "utf-8"), "PRD text");
  });

  test("prompt takes priority over PRD artifact", () => {
    const dir = makeTempDir();
    const result = writePrdFile(dir, {
      prompt: "Prompt wins",
      artifacts: [
        { id: "1", type: LoopArtifactType.Prd, content: "PRD loses" },
      ],
    });
    assert.equal(fs.readFileSync(result, "utf-8"), "Prompt wins");
  });

  test("returns null when no content available", () => {
    const dir = makeTempDir();
    assert.equal(writePrdFile(dir, {}), null);
    assert.equal(writePrdFile(dir, { artifacts: [] }), null);
    assert.equal(writePrdFile(dir, null), null);
  });

  test("writes to prd.md filename", () => {
    const dir = makeTempDir();
    const result = writePrdFile(dir, { prompt: "content" });
    assert.equal(path.basename(result), "prd.md");
  });
});

// ---------------------------------------------------------------------------
// syncPlanFromContextPack — plan.json content merge
// ---------------------------------------------------------------------------

describe("syncPlanFromContextPack", () => {
  test("updates content field in existing plan.json", () => {
    const dir = makeTempDir();
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        content: "old content",
        pendingTasks: ["task1"],
        openQuestions: [],
      })
    );

    syncPlanFromContextPack(dir, {
      artifacts: [
        {
          id: "1",
          type: LoopArtifactType.ImplementationPlan,
          content: "new content",
        },
      ],
    });

    const updated = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    assert.equal(updated.content, "new content");
    assert.deepEqual(updated.pendingTasks, ["task1"]);
    assert.deepEqual(updated.openQuestions, []);
  });

  test("finds IMPLEMENTATION_PLAN artifact even when not first", () => {
    const dir = makeTempDir();
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify({ content: "old" }));

    syncPlanFromContextPack(dir, {
      artifacts: [
        { id: "1", type: LoopArtifactType.Prd, content: "prd text" },
        { id: "2", type: LoopArtifactType.Feature, content: "feature text" },
        {
          id: "3",
          type: LoopArtifactType.ImplementationPlan,
          content: "plan text",
        },
      ],
    });

    const updated = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    assert.equal(updated.content, "plan text");
  });

  test("skips when plan.json does not exist", () => {
    const dir = makeTempDir();
    // No plan.json — should not throw
    syncPlanFromContextPack(dir, {
      artifacts: [
        {
          id: "1",
          type: LoopArtifactType.ImplementationPlan,
          content: "new content",
        },
      ],
    });
    assert.ok(!fs.existsSync(path.join(dir, "plan.json")));
  });

  test("skips when no artifacts", () => {
    const dir = makeTempDir();
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify({ content: "unchanged" }));

    syncPlanFromContextPack(dir, { artifacts: [] });
    syncPlanFromContextPack(dir, {});
    syncPlanFromContextPack(dir, null);

    const result = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    assert.equal(result.content, "unchanged");
  });

  test("skips PRD and FEATURE artifacts as primary", () => {
    const dir = makeTempDir();
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify({ content: "original" }));

    syncPlanFromContextPack(dir, {
      artifacts: [
        { id: "1", type: LoopArtifactType.Prd, content: "should not replace" },
        {
          id: "2",
          type: LoopArtifactType.Feature,
          content: "should not replace either",
        },
      ],
    });

    const result = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    assert.equal(result.content, "original");
  });
});

// ---------------------------------------------------------------------------
// writeExecutionResult — sentinel value construction
// ---------------------------------------------------------------------------

describe("writeExecutionResult", () => {
  test("writes execution-result.json with PR info", () => {
    const dir = makeTempDir();
    resetConfig({ targetBranch: "main" });

    writeExecutionResult(dir, {
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      branchName: "symphony/abc",
    });

    const filePath = path.join(dir, "execution-result.json");
    assert.ok(fs.existsSync(filePath));
    const result = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(result.has_changes, true);
    assert.equal(result.pr_url, "https://github.com/org/repo/pull/42");
    assert.equal(result.pr_number, 42);
    assert.equal(result.branch_name, "symphony/abc");
    assert.equal(result.base_ref, "main");
  });

  test("writes empty sentinels when no PR info", () => {
    const dir = makeTempDir();
    resetConfig({ targetBranch: "develop" });

    writeExecutionResult(dir, null);

    const result = JSON.parse(
      fs.readFileSync(path.join(dir, "execution-result.json"), "utf-8")
    );
    assert.equal(result.has_changes, false);
    assert.equal(result.pr_url, "");
    assert.equal(result.pr_number, 0);
    assert.equal(result.branch_name, "");
    assert.equal(result.base_ref, "develop");
  });

  test("does not overwrite existing execution-result.json", () => {
    const dir = makeTempDir();
    resetConfig();
    const filePath = path.join(dir, "execution-result.json");
    fs.writeFileSync(filePath, '{"llm_wrote_this": true}');

    writeExecutionResult(dir, {
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
      branchName: "branch",
    });

    const result = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(result.llm_wrote_this, true);
    assert.equal(result.pr_url, undefined);
  });

  test("uses config.targetBranch for base_ref", () => {
    const dir = makeTempDir();
    resetConfig({ targetBranch: "staging" });

    writeExecutionResult(dir, null);

    const result = JSON.parse(
      fs.readFileSync(path.join(dir, "execution-result.json"), "utf-8")
    );
    assert.equal(result.base_ref, "staging");
  });
});

// ---------------------------------------------------------------------------
// parseTokenUsageFromJsonl — structured JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Build a JSONL assistant record matching Claude CLI --output-format stream-json.
 */
function makeAssistantJsonl(model, usage) {
  return {
    line: JSON.stringify({
      type: "assistant",
      message: { model, usage },
    }),
  };
}

describe("parseTokenUsageFromJsonl", () => {
  test("parses single assistant record with input/output tokens", () => {
    const lines = [
      makeAssistantJsonl("claude-opus-4-6-20260407", {
        input_tokens: 1000,
        output_tokens: 500,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(result.totalInput, 1000);
    assert.equal(result.totalOutput, 500);
    assert.ok(result.tokensByModel["claude-opus-4"]);
    assert.equal(result.tokensByModel["claude-opus-4"].input, 1000);
    assert.equal(result.tokensByModel["claude-opus-4"].output, 500);
  });

  test("parses cache creation and read tokens", () => {
    const lines = [
      makeAssistantJsonl("claude-sonnet-4-5-20250929", {
        input_tokens: 2000,
        output_tokens: 800,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 150,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    const model = result.tokensByModel["claude-sonnet-4-5"];
    assert.equal(model.input, 2000);
    assert.equal(model.output, 800);
    assert.equal(model.cacheCreation, 300);
    assert.equal(model.cacheRead, 150);
  });

  test("accumulates across multiple assistant records for same model", () => {
    const lines = [
      makeAssistantJsonl("claude-opus-4-6", {
        input_tokens: 100,
        output_tokens: 50,
      }),
      makeAssistantJsonl("claude-opus-4-6", {
        input_tokens: 200,
        output_tokens: 75,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(result.tokensByModel["claude-opus-4"].input, 300);
    assert.equal(result.tokensByModel["claude-opus-4"].output, 125);
    assert.equal(result.totalInput, 300);
    assert.equal(result.totalOutput, 125);
  });

  test("tracks multiple models separately", () => {
    const lines = [
      makeAssistantJsonl("claude-opus-4-6", {
        input_tokens: 100,
        output_tokens: 50,
      }),
      makeAssistantJsonl("claude-haiku-4-5-20251001", {
        input_tokens: 500,
        output_tokens: 200,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(Object.keys(result.tokensByModel).length, 2);
    assert.equal(result.tokensByModel["claude-opus-4"].input, 100);
    assert.equal(result.tokensByModel["claude-haiku-4-5"].input, 500);
    assert.equal(result.totalInput, 600);
    assert.equal(result.totalOutput, 250);
  });

  test("skips non-assistant JSONL records", () => {
    const lines = [
      {
        line: JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "abc",
        }),
      },
      { line: JSON.stringify({ type: "tool_use", tool: "Bash" }) },
      makeAssistantJsonl("claude-opus-4", {
        input_tokens: 100,
        output_tokens: 50,
      }),
      { line: JSON.stringify({ type: "result", is_error: false }) },
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(result.totalInput, 100);
    assert.equal(result.totalOutput, 50);
    assert.equal(Object.keys(result.tokensByModel).length, 1);
  });

  test("skips non-JSON lines", () => {
    const lines = [
      { line: "Some human-readable output" },
      { line: "[child] Starting..." },
      makeAssistantJsonl("claude-opus-4", {
        input_tokens: 100,
        output_tokens: 50,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(result.totalInput, 100);
  });

  test("skips malformed JSON lines", () => {
    const lines = [
      { line: "{not valid json" },
      { line: '{"type":"assistant","message":' }, // truncated
      makeAssistantJsonl("claude-opus-4", {
        input_tokens: 100,
        output_tokens: 50,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(result.totalInput, 100);
  });

  test("returns null when no assistant records found", () => {
    const lines = [
      { line: JSON.stringify({ type: "system", subtype: "init" }) },
      { line: JSON.stringify({ type: "result", is_error: false }) },
    ];
    assert.equal(parseTokenUsageFromJsonl(lines), null);
  });

  test("returns null for empty output", () => {
    assert.equal(parseTokenUsageFromJsonl([]), null);
  });

  test("handles assistant record with missing usage", () => {
    const lines = [
      {
        line: JSON.stringify({
          type: "assistant",
          message: { model: "claude-opus-4" },
        }),
      },
    ];
    assert.equal(parseTokenUsageFromJsonl(lines), null);
  });

  test("preserves totals when assistant record has usage but no model", () => {
    const lines = [
      {
        line: JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 100, output_tokens: 50 } },
        }),
      },
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(result.totalInput, 100);
    assert.equal(result.totalOutput, 50);
    assert.equal(result.tokensByModel, null);
  });

  test("does not set cacheCreation/cacheRead when zero", () => {
    const lines = [
      makeAssistantJsonl("claude-opus-4", {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const result = parseTokenUsageFromJsonl(lines);
    assert.ok(result);
    assert.equal(
      result.tokensByModel["claude-opus-4"].cacheCreation,
      undefined
    );
    assert.equal(result.tokensByModel["claude-opus-4"].cacheRead, undefined);
  });

  test("handles lines without .line property", () => {
    const lines = [{}, { line: "" }, { other: "field" }];
    assert.equal(parseTokenUsageFromJsonl(lines), null);
  });
});

// ---------------------------------------------------------------------------
// parseTokenUsageFromJsonlFile — JSONL file on disk (run-loop.sh path)
// ---------------------------------------------------------------------------

describe("parseTokenUsageFromJsonlFile", () => {
  test("parses token usage from a JSONL file on disk", () => {
    const dir = makeTempDir();
    const jsonlPath = path.join(dir, "claude-output.jsonl");
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "abc-123",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: { input_tokens: 5000, output_tokens: 2000 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input_tokens: 3000,
            output_tokens: 1000,
            cache_creation_input_tokens: 400,
            cache_read_input_tokens: 100,
          },
        },
      }),
      JSON.stringify({ type: "result", is_error: false }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n"));

    const result = parseTokenUsageFromJsonlFile(jsonlPath);
    assert.ok(result);
    assert.equal(result.totalInput, 8000);
    assert.equal(result.totalOutput, 3000);
    assert.equal(Object.keys(result.tokensByModel).length, 2);
    assert.equal(result.tokensByModel["claude-opus-4"].input, 5000);
    assert.equal(result.tokensByModel["claude-sonnet-4-5"].cacheCreation, 400);
    assert.equal(result.tokensByModel["claude-sonnet-4-5"].cacheRead, 100);
  });

  test("returns null when file does not exist", () => {
    const result = parseTokenUsageFromJsonlFile(
      "/nonexistent/path/claude-output.jsonl"
    );
    assert.equal(result, null);
  });

  test("returns null when file has no assistant records", () => {
    const dir = makeTempDir();
    const jsonlPath = path.join(dir, "claude-output.jsonl");
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({ type: "system", subtype: "init" })
    );
    assert.equal(parseTokenUsageFromJsonlFile(jsonlPath), null);
  });

  test("returns null for empty file", () => {
    const dir = makeTempDir();
    const jsonlPath = path.join(dir, "claude-output.jsonl");
    fs.writeFileSync(jsonlPath, "");
    assert.equal(parseTokenUsageFromJsonlFile(jsonlPath), null);
  });
});

// ---------------------------------------------------------------------------
// parseTokenUsageFromRegex — human-readable output parsing
// ---------------------------------------------------------------------------

describe("parseTokenUsageFromRegex", () => {
  test("parses single model usage line", () => {
    const result = parseTokenUsageFromRegex([
      { line: "Model: claude-opus-4-6  Input: 12,345  Output: 6,789" },
    ]);
    assert.deepEqual(result.tokensByModel, {
      "claude-opus-4": { input: 12_345, output: 6789 },
    });
    assert.equal(result.totalInput, 12_345);
    assert.equal(result.totalOutput, 6789);
  });

  test("parses cache tokens from regex line", () => {
    const result = parseTokenUsageFromRegex([
      {
        line: "Model: claude-sonnet-4-5  Input: 1,000  Output: 500  Cache creation: 200  Cache read: 300",
      },
    ]);
    const model = result.tokensByModel["claude-sonnet-4-5"];
    assert.equal(model.cacheCreation, 200);
    assert.equal(model.cacheRead, 300);
  });

  test("returns null tokensByModel when no model lines found", () => {
    const result = parseTokenUsageFromRegex([
      { line: "Total input tokens: 5,000" },
      { line: "Total output tokens: 2,000" },
    ]);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 5000);
    assert.equal(result.totalOutput, 2000);
  });

  test("returns zeros for empty output", () => {
    const result = parseTokenUsageFromRegex([]);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 0);
    assert.equal(result.totalOutput, 0);
  });
});

// ---------------------------------------------------------------------------
// parseTokenUsage — JSONL-first with regex fallback
// ---------------------------------------------------------------------------

describe("parseTokenUsage (unified)", () => {
  test("prefers JSONL over regex when both are present", () => {
    const lines = [
      // JSONL assistant record
      makeAssistantJsonl("claude-opus-4-6", {
        input_tokens: 1000,
        output_tokens: 500,
      }),
      // Regex summary line (should be ignored when JSONL succeeds)
      { line: "Model: claude-opus-4  Input: 999  Output: 888" },
    ];
    const result = parseTokenUsage(lines);
    // JSONL values win
    assert.equal(result.totalInput, 1000);
    assert.equal(result.totalOutput, 500);
  });

  test("falls back to regex when no JSONL assistant records", () => {
    const lines = [
      { line: "Model: claude-opus-4  Input: 12,345  Output: 6,789" },
      { line: "Total input tokens: 12,345" },
    ];
    const result = parseTokenUsage(lines);
    assert.ok(result.tokensByModel);
    assert.equal(result.tokensByModel["claude-opus-4"].input, 12_345);
  });

  test("falls back to regex totals when no model data anywhere", () => {
    const lines = [
      { line: "Total input tokens: 5,000" },
      { line: "Total output tokens: 2,000" },
    ];
    const result = parseTokenUsage(lines);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 5000);
    assert.equal(result.totalOutput, 2000);
  });

  test("returns zeros for completely empty output", () => {
    const result = parseTokenUsage([]);
    assert.equal(result.tokensByModel, null);
    assert.equal(result.totalInput, 0);
    assert.equal(result.totalOutput, 0);
  });
});

// ---------------------------------------------------------------------------
// extractSessionId — JSONL init record and regex fallback
// ---------------------------------------------------------------------------

describe("extractSessionId", () => {
  test("extracts session ID from JSONL init record", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    assert.equal(
      extractSessionId(line),
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  test("extracts session ID from human-readable Session: line", () => {
    const line = "Session: a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    assert.equal(
      extractSessionId(line),
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  test("falls through to regex for non-init JSONL records with session_id", () => {
    // Non-init records skip the JSONL path but the regex fallback still
    // matches "session_id": "<uuid>" in the serialized JSON string.
    const line = JSON.stringify({
      type: "system",
      subtype: "config",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    assert.equal(
      extractSessionId(line),
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  test("returns null for assistant JSONL records", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4" },
    });
    assert.equal(extractSessionId(line), null);
  });

  test("returns null for non-JSON, non-session lines", () => {
    assert.equal(extractSessionId("Compiling..."), null);
    assert.equal(extractSessionId(""), null);
    assert.equal(extractSessionId("[child] Starting up"), null);
  });

  test("returns null for malformed JSON starting with {", () => {
    assert.equal(extractSessionId("{not valid json"), null);
  });

  test("prefers JSONL init over regex when line is valid JSONL init", () => {
    // A JSONL init record that also happens to contain a Session: pattern
    // should use the structured session_id field
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(
      extractSessionId(line),
      "11111111-2222-3333-4444-555555555555"
    );
  });

  test("handles JSONL init record with missing session_id", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      apiKeySource: "environment",
    });
    assert.equal(extractSessionId(line), null);
  });

  test("extracts session ID embedded with quotes in JSON-like output", () => {
    const line = '"session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"';
    assert.equal(
      extractSessionId(line),
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });
});

// ---------------------------------------------------------------------------
// buildClaudeDirectArgs — --output-format stream-json flag
// ---------------------------------------------------------------------------

describe("buildClaudeDirectArgs output format", () => {
  test("includes -p and --output-format stream-json for DECOMPOSE", () => {
    const workDir = makeTempDir();
    writePromptFile(workDir, "Decompose this feature");
    resetConfig({ command: "DECOMPOSE" });

    const { args } = buildClaudeDirectArgs(workDir, null);
    assert.ok(args.includes("-p"), "args must contain -p (print mode)");
    const fmtIdx = args.indexOf("--output-format");
    assert.ok(fmtIdx !== -1, "args must contain --output-format");
    assert.equal(args[fmtIdx + 1], "stream-json");
    assert.ok(args.indexOf("-p") < fmtIdx, "-p must precede --output-format");
  });

  test("includes -p and --output-format stream-json for CHAT", () => {
    const workDir = makeTempDir();
    writePromptFile(workDir, "Hello");
    resetConfig({ command: "CHAT" });

    const { args } = buildClaudeDirectArgs(workDir, null);
    assert.ok(args.includes("-p"), "args must contain -p (print mode)");
    const fmtIdx = args.indexOf("--output-format");
    assert.ok(fmtIdx !== -1, "args must contain --output-format");
    assert.equal(args[fmtIdx + 1], "stream-json");
  });

  test("includes -p and --output-format stream-json for EVALUATE_PRD", () => {
    const workDir = makeTempDir();
    resetConfig({ command: "EVALUATE_PRD" });

    const { args } = buildClaudeDirectArgs(workDir, null);
    assert.ok(args.includes("-p"), "args must contain -p (print mode)");
    const fmtIdx = args.indexOf("--output-format");
    assert.ok(fmtIdx !== -1, "args must contain --output-format");
    assert.equal(args[fmtIdx + 1], "stream-json");
  });

  test("includes -p and --output-format stream-json for REQUEST_CHANGES", () => {
    const workDir = makeTempDir();
    writePromptFile(workDir, "Fix the bug");
    resetConfig({ command: "REQUEST_CHANGES" });

    const { args } = buildClaudeDirectArgs(workDir, workDir);
    assert.ok(args.includes("-p"), "args must contain -p (print mode)");
    const fmtIdx = args.indexOf("--output-format");
    assert.ok(fmtIdx !== -1, "args must contain --output-format");
    assert.equal(args[fmtIdx + 1], "stream-json");
  });
});
