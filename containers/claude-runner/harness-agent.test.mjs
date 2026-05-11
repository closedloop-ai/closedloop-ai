import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import {
  LoopArtifactFile,
  LoopArtifactType,
} from "@closedloop-ai/loops-api/artifacts";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  LoopErrorCode,
  RunnerErrorSubcode,
} from "@closedloop-ai/loops-api/error-codes";
import { MULTI_REPO_POLICY } from "@closedloop-ai/loops-api/multi-repo-policy";

import {
  buildClaudeDirectArgs,
  buildCommand,
  buildEventResult,
  buildRepoList,
  buildRunLoopArgs,
  cloneAdditionalRepos,
  config,
  ERROR_CODES,
  extractPrimaryPrInfo,
  extractSessionId,
  finalizeRepo,
  finalizeRepos,
  findExistingRunDir,
  getHomeStateTransferPrefix,
  getWorkspaceStateRestorePrefixes,
  getWorkspaceStateUploadPrefixes,
  HarnessError,
  isPeerWriteEnabled,
  parsePrInfo,
  parseTokenUsage,
  parseTokenUsageFromJsonl,
  parseTokenUsageFromJsonlFile,
  parseTokenUsageFromRegex,
  redactSensitive,
  refreshGitHubToken,
  registerSecret,
  reportFinalStatus,
  resetHarnessState,
  setConfigEnvKey,
  snapshotTokens,
  syncPlanFromContextPack,
  validateConfig,
  validatePreRunInputs,
  validateSecrets,
  writeContextPackFiles,
  writeExecutionResult,
  writeExecutionResultV2,
  writeFeatureEvaluationPrdFile,
  writePrdFile,
} from "./harness-agent.mjs";
import {
  signUserVisibleLoopFailure,
  USER_VISIBLE_LOOP_FAILURE_FILE,
} from "./lib/user-visible-loop-failure.mjs";

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
 * Build a self-contained local git fixture for cloneAdditionalRepos tests:
 *   - bare repo at <parentDir>/origin.git on `main` with one empty commit
 *   - fake HOME with .gitconfig rewriting https://github.com/<repo>.git to
 *     the bare repo path (so cloneAdditionalRepos performs no network I/O)
 *   - empty peers/ dir for the clone target
 *
 * The fake HOME is only consulted by git when buildGitAuthEnv() forwards it,
 * which happens whenever a non-null githubToken is provided.
 */
function makeLocalGitFixture({ rewriteFullName = "org/repo" } = {}) {
  const parentDir = makeTempDir();
  const bareRepoPath = path.join(parentDir, "origin.git");
  const wcDir = path.join(parentDir, "wc");
  const fakeHome = path.join(parentDir, "fakehome");
  const peersDir = path.join(parentDir, "peers");

  const gitCommitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };

  execFileSync("git", ["init", "--bare", "-b", "main", bareRepoPath]);
  execFileSync("git", ["clone", bareRepoPath, wcDir]);
  execFileSync("git", ["-C", wcDir, "commit", "--allow-empty", "-m", "init"], {
    env: gitCommitEnv,
  });
  execFileSync("git", ["-C", wcDir, "push", "origin", "main"]);

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".gitconfig"),
    `[url "${bareRepoPath}"]\n\tinsteadOf = https://github.com/${rewriteFullName}.git\n`
  );

  return { parentDir, bareRepoPath, peersDir, fakeHome };
}

/**
 * Run `fn` with process.env.HOME swapped to `fakeHome`, restoring the original
 * value (including the unset case) on completion. Use to guarantee that the
 * git subprocess in cloneAdditionalRepos picks up the fake gitconfig without
 * leaking HOME into other tests.
 */
function withFakeHome(fakeHome, fn) {
  const hadHome = Object.hasOwn(process.env, "HOME");
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn();
  } finally {
    if (hadHome) {
      process.env.HOME = origHome;
    } else {
      Reflect.deleteProperty(process.env, "HOME");
    }
  }
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
// EVALUATE_FEATURE — buildClaudeDirectArgs skill invocation tests
// ---------------------------------------------------------------------------

test("buildClaudeDirectArgs with EVALUATE_FEATURE invokes judges:run-judges with artifact-type feature", () => {
  const workDir = makeTempDir();
  resetConfig({ command: "EVALUATE_FEATURE" });

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
    prompt.includes("--artifact-type feature"),
    `prompt must contain --artifact-type feature; got: ${prompt}`
  );
  assert.ok(
    prompt.includes(`--workdir ${workDir}`),
    `prompt must contain --workdir <workDir>; got: ${prompt}`
  );
  // --artifact-type feature is embedded in the prompt string, not a separate argv entry
  assert.equal(
    args.indexOf("--artifact-type"),
    -1,
    "args must NOT contain --artifact-type as a separate flag (it belongs inside the prompt)"
  );
  // Feature evaluation is repo-less — no REPO_PATH= in the prompt
  assert.ok(
    !prompt.includes("REPO_PATH="),
    `prompt must NOT contain REPO_PATH= for EVALUATE_FEATURE (feature evaluation is repo-less); got: ${prompt}`
  );
});

test("buildClaudeDirectArgs with EVALUATE_FEATURE uses symphonyWD (run directory) for --workdir when provided", () => {
  const workDir = makeTempDir();
  const symphonyWD = makeTempDir();
  resetConfig({ command: "EVALUATE_FEATURE" });

  const { args } = buildClaudeDirectArgs(workDir, symphonyWD);

  const prompt = args.find(
    (a) => typeof a === "string" && a.includes("judges:run-judges")
  );
  assert.ok(
    prompt !== undefined,
    `args must contain a prompt referencing judges:run-judges; got: ${JSON.stringify(args)}`
  );
  assert.ok(
    prompt.includes(`--workdir ${symphonyWD}`),
    `prompt must contain --workdir <symphonyWD> when symphonyWD is provided; got: ${prompt}`
  );
  assert.ok(
    !prompt.includes(`--workdir ${workDir}`),
    `prompt must NOT contain --workdir <workDir> when symphonyWD is provided (symphonyWD is the run directory); got: ${prompt}`
  );
});

// ---------------------------------------------------------------------------
// EVALUATE_FEATURE — validateConfig and validateSecrets tests
// ---------------------------------------------------------------------------

describe("EVALUATE_FEATURE validation", () => {
  for (const scenario of [
    {
      name: "validateConfig does not require targetRepo",
      config: { command: "EVALUATE_FEATURE", targetRepo: undefined },
      validate: validateConfig,
    },
    {
      name: "validateSecrets does not require githubToken",
      config: {
        command: "EVALUATE_FEATURE",
        targetRepo: null,
        anthropicApiKey: "sk-test",
        githubToken: null,
      },
      validate: validateSecrets,
    },
  ]) {
    test(scenario.name, () => {
      resetConfig(scenario.config);

      assert.doesNotThrow(() => scenario.validate());
    });
  }
});

// ---------------------------------------------------------------------------
// EVALUATE_FEATURE — artifact upload list includes FeatureJudges
// ---------------------------------------------------------------------------

// Verify LoopArtifactFile.FeatureJudges is referenced in the
// CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES array via source inspection
// (the array is a local const, not exported).
test("CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES includes LoopArtifactFile.FeatureJudges", () => {
  const harnessSource = fs.readFileSync(
    new URL("./harness-agent.mjs", import.meta.url),
    "utf-8"
  );

  // Match the array literal body so we verify the identifier is inside this
  // specific array, not elsewhere in the file (a comment, dead code, etc.).
  const arrayMatch =
    /const\s+CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(
      harnessSource
    );
  assert.ok(
    arrayMatch !== null,
    "harness-agent.mjs must declare const CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES = [...]"
  );
  const arrayBody = arrayMatch[1];
  assert.ok(
    arrayBody.includes("LoopArtifactFile.FeatureJudges"),
    "CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES array body must contain LoopArtifactFile.FeatureJudges"
  );

  // Confirm the resolved file name matches what the backend expects.
  assert.equal(
    LoopArtifactFile.FeatureJudges,
    "feature-judges.json",
    "LoopArtifactFile.FeatureJudges must resolve to feature-judges.json"
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

test("validatePreRunInputs requires a non-empty FEATURE artifact for EVALUATE_FEATURE", () => {
  assert.throws(
    () =>
      validatePreRunInputs("EVALUATE_FEATURE", {
        artifacts: [
          {
            id: "prd-1",
            type: LoopArtifactType.Prd,
            content: "source prd content",
          },
        ],
      }),
    (err) => {
      assert.ok(err instanceof HarnessError, "must be a HarnessError");
      assert.equal(err.code, ERROR_CODES.preRunValidation);
      assert.match(err.message, /FEATURE artifact/);
      return true;
    }
  );
});

test("validatePreRunInputs accepts EVALUATE_FEATURE with a non-empty FEATURE artifact", () => {
  assert.doesNotThrow(() =>
    validatePreRunInputs("EVALUATE_FEATURE", {
      artifacts: [
        {
          id: "feature-1",
          type: LoopArtifactType.Feature,
          content: "feature content",
        },
      ],
    })
  );
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

  test("feature evaluation writes FEATURE artifact even when a PRD artifact is present", () => {
    const dir = makeTempDir();
    const result = writeFeatureEvaluationPrdFile(dir, {
      artifacts: [
        { id: "prd-1", type: LoopArtifactType.Prd, content: "Source PRD" },
        {
          id: "feature-1",
          type: LoopArtifactType.Feature,
          content: "Feature artifact",
        },
      ],
    });

    assert.ok(result);
    assert.equal(fs.readFileSync(result, "utf-8"), "Feature artifact");
  });

  test("feature evaluation ignores prompt and PRD fallback when selecting content", () => {
    const dir = makeTempDir();
    const result = writeFeatureEvaluationPrdFile(dir, {
      prompt: "Prompt text",
      artifacts: [
        { id: "prd-1", type: LoopArtifactType.Prd, content: "Source PRD" },
      ],
    });

    assert.equal(result, null);
    assert.ok(!fs.existsSync(path.join(dir, LoopArtifactFile.Prd)));
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

  test("writes plan-source.md and config.env when plan.json does not exist", () => {
    const runDir = makeTempDir();
    const workDir = makeTempDir();
    fs.mkdirSync(path.join(workDir, ".closedloop-ai"), { recursive: true });

    syncPlanFromContextPack(
      runDir,
      {
        artifacts: [
          {
            id: "1",
            type: LoopArtifactType.ImplementationPlan,
            content: "new content",
          },
        ],
      },
      workDir
    );

    // plan.json must NOT be created
    assert.ok(!fs.existsSync(path.join(runDir, "plan.json")));

    // plan-source.md must be written with the artifact content
    const planSourcePath = path.join(runDir, "plan-source.md");
    assert.ok(
      fs.existsSync(planSourcePath),
      "plan-source.md should be created"
    );
    assert.equal(fs.readFileSync(planSourcePath, "utf-8"), "new content");

    // config.env must be written to runDir (which run-loop.sh exports as
    // CLOSEDLOOP_WORKDIR) so Phase 0.9 hooks reading
    // $CLOSEDLOOP_WORKDIR/.closedloop-ai/config.env observe CLOSEDLOOP_PLAN_FILE.
    const configEnvPath = path.join(runDir, ".closedloop-ai", "config.env");
    assert.ok(
      fs.existsSync(configEnvPath),
      "config.env should be created in runDir"
    );
    const configEnvContent = fs.readFileSync(configEnvPath, "utf-8");
    assert.ok(
      configEnvContent.includes(`CLOSEDLOOP_PLAN_FILE=${planSourcePath}`),
      `config.env should contain CLOSEDLOOP_PLAN_FILE=${planSourcePath}; got: ${configEnvContent}`
    );

    // Negative assertion: nothing should be written to workDir's config.env.
    assert.ok(
      !fs.existsSync(path.join(workDir, ".closedloop-ai", "config.env")),
      "config.env must not be written to workDir"
    );
  });

  test("does not write plan-source.md or modify config.env when plan.json already exists (AC-006)", () => {
    const runDir = makeTempDir();
    const workDir = makeTempDir();
    fs.mkdirSync(path.join(runDir, ".closedloop-ai"), { recursive: true });

    const planPath = path.join(runDir, "plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        content: "old content",
        pendingTasks: ["task1"],
        openQuestions: [],
      })
    );

    // Pre-write a config.env at the path setConfigEnvKey would target so
    // we can detect unwanted mutations from a broken !fs.existsSync(plan.json) guard.
    const configEnvPath = path.join(runDir, ".closedloop-ai", "config.env");
    const originalConfigEnv = "SOME_EXISTING_VAR=value\n";
    fs.writeFileSync(configEnvPath, originalConfigEnv);

    syncPlanFromContextPack(
      runDir,
      {
        artifacts: [
          {
            id: "1",
            type: LoopArtifactType.ImplementationPlan,
            content: "updated content",
          },
        ],
      },
      workDir
    );

    // plan.json content must be updated (sibling-field preservation is covered
    // by the "preserves other plan.json fields" test above).
    const updated = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    assert.equal(updated.content, "updated content");

    // plan-source.md must NOT be created when plan.json already exists
    assert.ok(
      !fs.existsSync(path.join(runDir, "plan-source.md")),
      "plan-source.md must not be written when plan.json already exists"
    );

    // config.env must NOT be modified when plan.json already exists
    const configEnvAfter = fs.readFileSync(configEnvPath, "utf-8");
    assert.equal(
      configEnvAfter,
      originalConfigEnv,
      "config.env must not be modified when plan.json already exists"
    );
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

  test("does not write plan-source.md or config.env when plan.json absent and only PRD/Feature artifacts present", () => {
    const runDir = makeTempDir();
    const workDir = makeTempDir();

    // No plan.json in runDir — intentionally not created.
    // We do NOT pre-create runDir/.closedloop-ai so the negative assertion
    // below catches both an unexpected file write and an unexpected dir creation.

    syncPlanFromContextPack(
      runDir,
      {
        artifacts: [
          { id: "1", type: LoopArtifactType.Prd, content: "prd content" },
          {
            id: "2",
            type: LoopArtifactType.Feature,
            content: "feature content",
          },
        ],
      },
      workDir
    );

    // plan-source.md must NOT be written when no ImplementationPlan artifact is present
    assert.ok(
      !fs.existsSync(path.join(runDir, "plan-source.md")),
      "plan-source.md must not be written when only PRD/Feature artifacts are present"
    );

    // config.env must NOT be created when no ImplementationPlan artifact is present.
    // Check the path setConfigEnvKey would target so the assertion exercises the guard.
    const configEnvPath = path.join(runDir, ".closedloop-ai", "config.env");
    assert.ok(
      !fs.existsSync(configEnvPath),
      "config.env must not be created when only PRD/Feature artifacts are present"
    );
  });
});

// ---------------------------------------------------------------------------
// setConfigEnvKey — idempotency + preservation contract
// ---------------------------------------------------------------------------

describe("setConfigEnvKey", () => {
  test("replaces an existing key rather than duplicating it on repeat calls", () => {
    const targetDir = makeTempDir();

    setConfigEnvKey(targetDir, "CLOSEDLOOP_PLAN_FILE", "/first/path/plan.json");
    setConfigEnvKey(targetDir, "CLOSEDLOOP_PLAN_FILE", "/second/path/plan.json");

    const configEnvPath = path.join(targetDir, ".closedloop-ai", "config.env");
    const contents = fs.readFileSync(configEnvPath, "utf-8");
    const occurrences = contents.match(/^CLOSEDLOOP_PLAN_FILE=/gm) ?? [];
    assert.equal(
      occurrences.length,
      1,
      "CLOSEDLOOP_PLAN_FILE must appear exactly once after repeat calls"
    );
    assert.match(
      contents,
      /^CLOSEDLOOP_PLAN_FILE=\/second\/path\/plan\.json$/m,
      "the latest value must win (last-write-wins)"
    );
    assert.doesNotMatch(
      contents,
      /\/first\/path\/plan\.json/,
      "the earlier value must be removed, not retained"
    );
  });

  test("preserves unrelated pre-existing keys when setting a new key", () => {
    const targetDir = makeTempDir();
    fs.mkdirSync(path.join(targetDir, ".closedloop-ai"), { recursive: true });
    const configEnvPath = path.join(targetDir, ".closedloop-ai", "config.env");
    fs.writeFileSync(
      configEnvPath,
      "OTHER_KEY=keep-me\nANOTHER=stay\n"
    );

    setConfigEnvKey(targetDir, "CLOSEDLOOP_PLAN_FILE", "/run/plan.json");

    const contents = fs.readFileSync(configEnvPath, "utf-8");
    assert.match(contents, /^OTHER_KEY=keep-me$/m);
    assert.match(contents, /^ANOTHER=stay$/m);
    assert.match(
      contents,
      /^CLOSEDLOOP_PLAN_FILE=\/run\/plan\.json$/m
    );
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
// writeExecutionResultV2 — v2 envelope with schemaVersion + results array
// ---------------------------------------------------------------------------

describe("writeExecutionResultV2", () => {
  test("writes v2 envelope with schemaVersion 2 and results array", () => {
    const dir = makeTempDir();
    const results = [
      {
        fullName: "org/repo",
        status: "success",
        hasChanges: true,
        prUrl: "https://github.com/org/repo/pull/1",
        prNumber: 1,
        branchName: "symphony/test",
        baseBranch: "main",
        commitSha: "abc123",
      },
    ];

    writeExecutionResultV2(dir, results);

    const filePath = path.join(dir, "execution-result.json");
    assert.ok(fs.existsSync(filePath));
    const envelope = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(envelope.schemaVersion, 2);
    assert.ok(Array.isArray(envelope.results));
    assert.equal(envelope.results.length, 1);
    assert.deepEqual(envelope.results[0], results[0]);
  });

  test("single-repo runs produce length-1 results array", () => {
    const dir = makeTempDir();
    const results = [
      {
        fullName: "org/single-repo",
        status: "success",
        hasChanges: true,
        prUrl: "https://github.com/org/single-repo/pull/7",
        prNumber: 7,
        branchName: "symphony/branch",
        baseBranch: "main",
        commitSha: "def456",
      },
    ];

    writeExecutionResultV2(dir, results);

    const filePath = path.join(dir, "execution-result.json");
    const envelope = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(envelope.results.length, 1);
  });

  test("overwrites existing file unconditionally", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "execution-result.json");
    fs.writeFileSync(filePath, JSON.stringify({ old: true }));

    const results = [
      {
        fullName: "org/repo",
        status: "success",
        hasChanges: true,
        prUrl: "https://github.com/org/repo/pull/2",
        prNumber: 2,
        branchName: "symphony/new",
        baseBranch: "main",
        commitSha: "ghi789",
      },
    ];

    writeExecutionResultV2(dir, results);

    const envelope = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.old, undefined);
    assert.ok(Array.isArray(envelope.results));
  });

  test("throws HarnessError on invalid entries and refuses to write", () => {
    const dir = makeTempDir();
    // Missing required fields — schema validation must reject and throw,
    // not warn-and-write a malformed envelope downstream consumers can't parse.
    const results = [{ status: "success" }];

    assert.throws(
      () => writeExecutionResultV2(dir, results),
      (err) => err instanceof HarnessError
    );

    const filePath = path.join(dir, "execution-result.json");
    assert.ok(
      !fs.existsSync(filePath),
      "execution-result.json must not be written when validation fails"
    );
    const tmpPath = `${filePath}.tmp`;
    assert.ok(
      !fs.existsSync(tmpPath),
      "temp file must not be left behind when validation fails"
    );
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
// registerSecret + redactSensitive
// ---------------------------------------------------------------------------

describe("registerSecret + redactSensitive", () => {
  test("registered secret is replaced with [REDACTED] in subsequent calls", () => {
    const unique = `test-secret-${Date.now()}-alpha`;
    registerSecret(unique);
    const result = redactSensitive(`prefix ${unique} suffix`);
    assert.equal(result, "prefix [REDACTED] suffix");
  });

  test("redactSensitive applies x-access-token pattern even without registered secret", () => {
    const result = redactSensitive(
      "https://x-access-token:ghp_abc123@github.com/org/repo.git"
    );
    assert.equal(
      result,
      "https://x-access-token:[REDACTED]@github.com/org/repo.git"
    );
  });

  test("registerSecret ignores empty string", () => {
    // Empty string would cause all strings to be fully redacted — must be a no-op.
    registerSecret("");
    const result = redactSensitive("hello world");
    assert.equal(result, "hello world");
  });

  test("registerSecret ignores non-string values", () => {
    registerSecret(null);
    registerSecret(undefined);
    registerSecret(42);
    const result = redactSensitive("hello");
    assert.equal(result, "hello");
  });
});

// ---------------------------------------------------------------------------
// cloneAdditionalRepos — validation
// ---------------------------------------------------------------------------

describe("cloneAdditionalRepos", () => {
  test("rejects invalid fullName that fails RE_SAFE_REPO", () => {
    assert.throws(
      () =>
        cloneAdditionalRepos(
          [{ fullName: "../../etc/passwd", branch: "main", githubToken: null }],
          "/tmp"
        ),
      (err) => {
        assert.ok(err instanceof HarnessError, "must be a HarnessError");
        assert.equal(err.code, ERROR_CODES.config);
        assert.match(err.message, /fullName/);
        return true;
      }
    );
  });

  test("rejects invalid branch that fails RE_SAFE_BRANCH", () => {
    assert.throws(
      () =>
        cloneAdditionalRepos(
          [
            {
              fullName: "org/repo",
              branch: "branch with spaces",
              githubToken: null,
            },
          ],
          "/tmp"
        ),
      (err) => {
        assert.ok(err instanceof HarnessError, "must be a HarnessError");
        assert.equal(err.code, ERROR_CODES.config);
        assert.match(err.message, /branch/);
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // The tests below verify post-clone git operations (identity setup and working
  // branch creation) by running against a real local git repository.
  //
  // Strategy:
  //   1. Create a local bare git repository with one empty commit on `main`.
  //   2. Write a fake HOME/.gitconfig that rewrites the hardcoded
  //      https://github.com/org/repo.git URL to the local bare repo path.
  //      This avoids any network access.
  //   3. Temporarily override process.env.HOME so that buildGitAuthEnv() passes
  //      the fake HOME to the git subprocess (HOME is included in the env only
  //      when a non-null githubToken is provided — so a fake token is used).
  //   4. Assert observable state in the cloned repo directory: git config values
  //      and the current branch name.
  // ---------------------------------------------------------------------------

  test("sets git identity after clone", () => {
    const { peersDir, fakeHome } = makeLocalGitFixture();

    withFakeHome(fakeHome, () => {
      resetConfig({
        committerName: "Alice Tester",
        committerEmail: "alice@example.com",
      });
      const clonedDirs = cloneAdditionalRepos(
        [{ fullName: "org/repo", branch: "main", githubToken: "fake-token" }],
        peersDir
      );

      assert.equal(clonedDirs.length, 1, "expected one cloned directory");
      const cloneDir = clonedDirs[0];

      const actualName = execFileSync("git", ["config", "user.name"], {
        cwd: cloneDir,
      })
        .toString()
        .trim();
      const actualEmail = execFileSync("git", ["config", "user.email"], {
        cwd: cloneDir,
      })
        .toString()
        .trim();

      assert.equal(
        actualName,
        "Alice Tester",
        "user.name must match committerName"
      );
      assert.equal(
        actualEmail,
        "alice@example.com",
        "user.email must match committerEmail"
      );
    });
  });

  test("creates and checks out working branch", () => {
    const { peersDir, fakeHome } = makeLocalGitFixture();

    withFakeHome(fakeHome, () => {
      const loopId = "test-loop-abc123";
      resetConfig({ loopId });
      const clonedDirs = cloneAdditionalRepos(
        [{ fullName: "org/repo", branch: "main", githubToken: "fake-token" }],
        peersDir
      );

      assert.equal(clonedDirs.length, 1, "expected one cloned directory");
      const cloneDir = clonedDirs[0];

      const loopSuffix = loopId
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]/g, "-")
        .slice(0, 50);
      const expectedBranch = `symphony/${loopSuffix}`;

      const actualBranch = execFileSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd: cloneDir,
        }
      )
        .toString()
        .trim();

      assert.equal(
        actualBranch,
        expectedBranch,
        `working branch must be ${expectedBranch}`
      );
    });
  });
});

// ---------------------------------------------------------------------------
// buildRunLoopArgs — additionalRepoPaths and command gating
// ---------------------------------------------------------------------------

describe("buildRunLoopArgs", () => {
  const fakePath = "/path/to/run-loop.sh";
  const fakeWorkDir = "/workspace/repo";

  test("PLAN command includes --add-dir for each additionalRepoPath", () => {
    resetConfig({ command: "PLAN" });

    const additionalRepoPaths = [
      "/workspace/peers/org--repo-a",
      "/workspace/peers/org--repo-b",
    ];
    const { cmd, args } = buildRunLoopArgs(
      fakePath,
      fakeWorkDir,
      null,
      additionalRepoPaths
    );

    assert.equal(cmd, "bash");

    const addDirIndices = args.reduce((acc, val, idx) => {
      if (val === "--add-dir") {
        acc.push(idx);
      }
      return acc;
    }, []);

    assert.equal(
      addDirIndices.length,
      2,
      "must have two --add-dir flags for two additionalRepoPaths"
    );
    assert.equal(args[addDirIndices[0] + 1], additionalRepoPaths[0]);
    assert.equal(args[addDirIndices[1] + 1], additionalRepoPaths[1]);
  });

  test("EXECUTE command includes --add-dir for each additionalRepoPath", () => {
    resetConfig({ command: "EXECUTE" });

    const additionalRepoPaths = [
      "/workspace/peers/org--repo-a",
      "/workspace/peers/org--repo-b",
    ];
    const { cmd, args } = buildRunLoopArgs(
      fakePath,
      fakeWorkDir,
      null,
      additionalRepoPaths
    );

    assert.equal(cmd, "bash");

    const addDirIndices = args.reduce((acc, val, idx) => {
      if (val === "--add-dir") {
        acc.push(idx);
      }
      return acc;
    }, []);

    assert.equal(
      addDirIndices.length,
      2,
      "EXECUTE must emit two --add-dir flags for two additionalRepoPaths"
    );
    assert.equal(args[addDirIndices[0] + 1], additionalRepoPaths[0]);
    assert.equal(args[addDirIndices[1] + 1], additionalRepoPaths[1]);
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

// ---------------------------------------------------------------------------
// refreshGitHubToken
// ---------------------------------------------------------------------------

describe("refreshGitHubToken", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("patches contextPack.additionalRepos with fresh tokens", async () => {
    resetConfig({
      authToken: "test-auth-token",
      apiBaseUrl: "https://api.example.com",
      loopId: "test-loop-id",
      githubToken: "old-primary-token",
    });

    const contextPack = {
      additionalRepos: [
        { fullName: "owner/peer1", branch: "main", githubToken: "old-peer1" },
        { fullName: "owner/peer2", branch: "main", githubToken: "old-peer2" },
      ],
    };

    globalThis.fetch = async (url, options) => {
      assert.equal(
        url,
        "https://api.example.com/loops/test-loop-id/github-token"
      );
      assert.equal(options.headers.Authorization, "Bearer test-auth-token");
      // (a) Assert fetch body contains fullName and branch entries matching additionalRepos
      const parsedBody = JSON.parse(options.body);
      assert.deepEqual(parsedBody.additionalRepos, [
        { fullName: "owner/peer1", branch: "main" },
        { fullName: "owner/peer2", branch: "main" },
      ]);
      return {
        ok: true,
        json: async () => ({
          data: {
            token: "new-primary-token",
            additionalRepoTokens: [
              { fullName: "owner/peer1", token: "new-peer1" },
              { fullName: "owner/peer2", token: "new-peer2" },
            ],
          },
        }),
      };
    };

    await refreshGitHubToken(contextPack);

    assert.equal(config.githubToken, "new-primary-token");
    assert.equal(contextPack.additionalRepos[0].githubToken, "new-peer1");
    assert.equal(contextPack.additionalRepos[1].githubToken, "new-peer2");
  });

  test("does not crash if additionalRepoTokens is missing", async () => {
    resetConfig({
      authToken: "test-auth-token",
      apiBaseUrl: "https://api.example.com",
      loopId: "test-loop-id",
      githubToken: "old-primary-token",
    });

    const contextPack = {
      additionalRepos: [
        { fullName: "owner/peer1", branch: "main", githubToken: "old-peer1" },
      ],
    };

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          token: "new-primary-token",
        },
      }),
    });

    await refreshGitHubToken(contextPack);

    assert.equal(config.githubToken, "new-primary-token");
    assert.equal(contextPack.additionalRepos[0].githubToken, "old-peer1");
  });

  // (b) refreshGitHubToken(null) sends { additionalRepos: [] } rather than throwing
  test("called with null contextPack sends body { additionalRepos: [] } and does not throw", async () => {
    resetConfig({
      authToken: "test-auth-token",
      apiBaseUrl: "https://api.example.com",
      loopId: "test-loop-id",
      githubToken: "old-primary-token",
    });

    let capturedBody;
    globalThis.fetch = async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          data: {
            token: "new-primary-token",
          },
        }),
      };
    };

    await assert.doesNotReject(
      () => refreshGitHubToken(null),
      "refreshGitHubToken(null) must not throw or reject"
    );

    assert.deepEqual(
      capturedBody,
      { additionalRepos: [] },
      "fetch body must be { additionalRepos: [] } when contextPack is null"
    );
  });
});

// ---------------------------------------------------------------------------
// finalizeRepo — per-repo finalization helper
// ---------------------------------------------------------------------------

/**
 * Initialize a minimal local git repository with one empty commit.
 * Returns the working-copy directory path.
 */
function makeGitRepo(parentDir, branchName = "main") {
  const gitCommitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };

  const repoDir = path.join(parentDir, "repo");
  execFileSync("git", ["init", "-b", branchName, repoDir]);
  execFileSync(
    "git",
    ["-C", repoDir, "commit", "--allow-empty", "-m", "init"],
    {
      env: gitCommitEnv,
    }
  );
  // Set git identity so future commits succeed
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test Author"]);
  return repoDir;
}

describe("finalizeRepo", () => {
  test("returns skipped result when repo has no changes", async () => {
    const parentDir = makeTempDir();
    const repoDir = makeGitRepo(parentDir);

    resetConfig({ targetRepo: null, targetBranch: "main" });

    const result = await finalizeRepo({
      workDir: repoDir,
      fullName: "test/repo",
      baseBranch: "main",
      githubToken: "ghp_test123",
      safetyCommitMsg: "test commit",
    });

    assert.deepEqual(result, {
      fullName: "test/repo",
      status: "skipped",
      reason: "no_changes",
    });
  });

  test("returns failed result when PR creation returns null", async () => {
    const parentDir = makeTempDir();
    const repoDir = makeGitRepo(parentDir);

    // Create a new branch so detectBranchName returns non-null
    execFileSync("git", [
      "-C",
      repoDir,
      "checkout",
      "-b",
      "symphony/test-loop",
    ]);

    // Stage an uncommitted change
    const testFile = path.join(repoDir, "work.txt");
    fs.writeFileSync(testFile, "some work content");
    execFileSync("git", ["-C", repoDir, "add", "work.txt"]);

    // config.targetRepo = null → attemptSafetyCommit and ensureBranchPushed are no-ops.
    // createPullRequest receives override targetRepo="test/repo" so it tries, but gh
    // is unavailable in tests — the error is caught internally and returns null.
    // finalizeRepo must return status:"failed" when prInfo is null so the envelope
    // does not violate RepoExecutionResultSchema (which requires non-null
    // prUrl/prNumber for the "success" variant).
    resetConfig({ targetRepo: null, targetBranch: "main" });

    const result = await finalizeRepo({
      workDir: repoDir,
      fullName: "test/repo",
      baseBranch: "main",
      githubToken: "ghp_test123",
      safetyCommitMsg: "test commit",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.fullName, "test/repo");
    assert.equal(result.error, "PR creation failed");
  });

  test("returns failed result with string error when git status throws", async () => {
    // Pass a workDir that is not a git repository so git status throws.
    // This test only verifies the failure-shape contract; actual token
    // scrubbing is exercised in the registerSecret/redactSensitive test
    // below, since `git status` failure messages do not contain the token.
    const nonGitDir = makeTempDir();
    const sensitiveToken = `ghp_secret-${Date.now()}`;

    resetConfig({ targetRepo: null, targetBranch: "main" });

    const result = await finalizeRepo({
      workDir: nonGitDir,
      fullName: "test/repo",
      baseBranch: "main",
      githubToken: sensitiveToken,
      safetyCommitMsg: "test commit",
    });

    assert.equal(result.status, "failed");
    assert.ok(
      typeof result.error === "string",
      "result.error should be a string"
    );
    assert.ok(
      !result.error.includes(sensitiveToken),
      "result.error must not contain the raw token (catch block must redact it)"
    );
  });

  test("calls registerSecret with the provided token (observable via redactSensitive)", async () => {
    const parentDir = makeTempDir();
    const repoDir = makeGitRepo(parentDir);

    // Use a token unique enough not to collide with other test registrations
    const uniqueToken = `ghp_unique-finalize-token-${Date.now()}`;

    resetConfig({ targetRepo: null, targetBranch: "main" });

    await finalizeRepo({
      workDir: repoDir,
      fullName: "test/repo",
      baseBranch: "main",
      githubToken: uniqueToken,
      safetyCommitMsg: "test commit",
    });

    // registerSecret is called inside finalizeRepo. Its observable effect is that
    // redactSensitive now scrubs occurrences of the token.
    const scrubbed = redactSensitive(`Authorization: Bearer ${uniqueToken}`);
    assert.ok(
      !scrubbed.includes(uniqueToken),
      "token must be scrubbed after finalizeRepo registers it as a secret"
    );
    assert.ok(
      scrubbed.includes("[REDACTED]"),
      "scrubbed string must contain [REDACTED]"
    );
  });
});

// ---------------------------------------------------------------------------
// buildRepoList — repo descriptor array construction
// ---------------------------------------------------------------------------

describe("buildRepoList", () => {
  function setupPrimaryConfig() {
    resetConfig({
      targetRepo: "org/primary",
      targetBranch: "main",
      githubToken: "primary-token",
    });
  }

  function setupWithTwoPeers() {
    setupPrimaryConfig();
    resetHarnessState({
      contextPackRef: {
        additionalRepos: [
          {
            fullName: "org/peer-a",
            branch: "develop",
            githubToken: "peer-a-token",
          },
          {
            fullName: "org/peer-b",
            branch: "staging",
            githubToken: "peer-b-token",
          },
        ],
      },
    });
  }

  test("primary-only when no additionalRepos exist", () => {
    setupPrimaryConfig();
    resetHarnessState({ contextPackRef: null });

    const repos = buildRepoList("/workspace/primary");

    assert.equal(
      repos.length,
      1,
      "must have exactly one entry for primary repo"
    );
    assert.equal(repos[0].workDir, "/workspace/primary");
    assert.equal(repos[0].fullName, "org/primary");
    assert.equal(repos[0].baseBranch, "main");
    assert.equal(repos[0].githubToken, "primary-token");
  });

  test("primary + multiple peers have correct workDir path construction", () => {
    setupWithTwoPeers();

    const repos = buildRepoList("/workspace/primary");

    assert.equal(repos.length, 3, "must have primary + 2 peer entries");
    assert.equal(repos[1].workDir, "/workspace/peers/org--peer-a");
    assert.equal(repos[2].workDir, "/workspace/peers/org--peer-b");
  });

  test("primary + multiple peers have correct baseBranch per repo", () => {
    setupWithTwoPeers();

    const repos = buildRepoList("/workspace/primary");

    assert.equal(
      repos[0].baseBranch,
      "main",
      "primary baseBranch must be config.targetBranch"
    );
    assert.equal(
      repos[1].baseBranch,
      "develop",
      "peer-a baseBranch must be its own branch"
    );
    assert.equal(
      repos[2].baseBranch,
      "staging",
      "peer-b baseBranch must be its own branch"
    );
  });

  test("each peer repo uses its own githubToken (not config.githubToken)", () => {
    setupPrimaryConfig();
    resetHarnessState({
      contextPackRef: {
        additionalRepos: [
          {
            fullName: "org/peer-a",
            branch: "main",
            githubToken: "peer-a-own-token",
          },
          {
            fullName: "org/peer-b",
            branch: "main",
            githubToken: "peer-b-own-token",
          },
        ],
      },
    });

    const repos = buildRepoList("/workspace/primary");

    assert.equal(
      repos[0].githubToken,
      "primary-token",
      "primary repo must use config.githubToken"
    );
    assert.equal(
      repos[1].githubToken,
      "peer-a-own-token",
      "peer-a must use its own githubToken"
    );
    assert.equal(
      repos[2].githubToken,
      "peer-b-own-token",
      "peer-b must use its own githubToken"
    );
  });
});

// ---------------------------------------------------------------------------
// snapshotTokens — token map creation, isolation, and serialization safety
// ---------------------------------------------------------------------------

describe("snapshotTokens", () => {
  test("Map values match each repo's githubToken (keyed by fullName)", () => {
    const tokenMap = snapshotTokens([
      { fullName: "org/primary", githubToken: "primary-token" },
      { fullName: "org/peer-a", githubToken: "peer-a-token" },
      { fullName: "org/peer-b", githubToken: "peer-b-token" },
    ]);

    assert.equal(tokenMap.size, 3);
    assert.equal(tokenMap.get("org/primary"), "primary-token");
    assert.equal(tokenMap.get("org/peer-a"), "peer-a-token");
    assert.equal(tokenMap.get("org/peer-b"), "peer-b-token");
  });
});

// ---------------------------------------------------------------------------
// finalizeRepos — parallel finalization, error tolerance, and token routing
// ---------------------------------------------------------------------------

describe("finalizeRepos", () => {
  afterEach(() => {
    resetHarnessState({ lastTokenRefreshAt: Date.now() });
  });

  test("all repos finalized in parallel via injectable finalizeFn returning predetermined results", async () => {
    const repos = [
      {
        fullName: "org/repo-a",
        githubToken: "token-a",
        workDir: "/workspace/a",
        baseBranch: "main",
      },
      {
        fullName: "org/repo-b",
        githubToken: "token-b",
        workDir: "/workspace/b",
        baseBranch: "main",
      },
      {
        fullName: "org/repo-c",
        githubToken: "token-c",
        workDir: "/workspace/c",
        baseBranch: "main",
      },
    ];
    const predetermined = {
      "org/repo-a": {
        fullName: "org/repo-a",
        status: "success",
        prNumber: 1,
        prUrl: "https://github.com/org/repo-a/pull/1",
      },
      "org/repo-b": {
        fullName: "org/repo-b",
        status: "success",
        prNumber: 2,
        prUrl: "https://github.com/org/repo-b/pull/2",
      },
      "org/repo-c": { fullName: "org/repo-c", status: "skipped" },
    };
    const calls = [];
    const finalizeFn = async (repo) => {
      calls.push(repo.fullName);
      return predetermined[repo.fullName];
    };

    const tokenSnapshot = snapshotTokens(repos);
    const results = await finalizeRepos(
      repos,
      tokenSnapshot,
      "safety commit",
      finalizeFn
    );

    assert.equal(results.length, 3, "must return one result per repo");
    assert.deepEqual(results[0], predetermined["org/repo-a"]);
    assert.deepEqual(results[1], predetermined["org/repo-b"]);
    assert.deepEqual(results[2], predetermined["org/repo-c"]);
    assert.equal(
      calls.length,
      3,
      "finalizeFn must be called once for every repo"
    );
  });

  test("partial failure tolerance — failed repo gets { status: 'failed', error } with redacted error; other repos still produce results", async () => {
    const sensitiveToken = "ghp_supersecret99";
    const repos = [
      {
        fullName: "org/repo-ok",
        githubToken: "token-ok",
        workDir: "/workspace/ok",
        baseBranch: "main",
      },
      {
        fullName: "org/repo-fail",
        githubToken: sensitiveToken,
        workDir: "/workspace/fail",
        baseBranch: "main",
      },
    ];
    const successResult = {
      fullName: "org/repo-ok",
      status: "success",
      prNumber: 7,
    };

    // Register the sensitive token so redactSensitive can mask it in the error
    registerSecret(sensitiveToken);

    const finalizeFn = async (repo) => {
      if (repo.fullName === "org/repo-fail") {
        throw new Error(
          `git push failed: x-access-token:${sensitiveToken}@github.com`
        );
      }
      return successResult;
    };

    const tokenSnapshot = snapshotTokens(repos);
    const results = await finalizeRepos(
      repos,
      tokenSnapshot,
      "safety commit",
      finalizeFn
    );

    assert.equal(
      results.length,
      2,
      "must return one result per repo even when one fails"
    );

    const okResult = results.find((r) => r.fullName === "org/repo-ok");
    assert.deepEqual(
      okResult,
      successResult,
      "successful repo result must be the predetermined value"
    );

    const failResult = results.find((r) => r.fullName === "org/repo-fail");
    assert.equal(
      failResult.status,
      "failed",
      "failed repo result must have status 'failed'"
    );
    assert.ok(
      failResult.error,
      "failed repo result must include an error field"
    );
    assert.ok(
      !failResult.error.includes(sensitiveToken),
      "error message must be redacted and must not expose the sensitive token"
    );
  });

  test("token snapshot consulted for each repo — finalizeFn receives correct per-repo token from snapshot", async () => {
    const repos = [
      {
        fullName: "org/repo-x",
        githubToken: "token-x-original",
        workDir: "/workspace/x",
        baseBranch: "main",
      },
      {
        fullName: "org/repo-y",
        githubToken: "token-y-original",
        workDir: "/workspace/y",
        baseBranch: "main",
      },
    ];
    const tokenSnapshot = snapshotTokens(repos);
    // Override snapshot entries to simulate a post-refresh token value
    tokenSnapshot.set("org/repo-x", "token-x-refreshed");
    tokenSnapshot.set("org/repo-y", "token-y-refreshed");

    const receivedTokens = {};
    const finalizeFn = async (repo) => {
      receivedTokens[repo.fullName] = repo.githubToken;
      return { fullName: repo.fullName, status: "success" };
    };

    await finalizeRepos(repos, tokenSnapshot, "safety commit", finalizeFn);

    assert.equal(
      receivedTokens["org/repo-x"],
      "token-x-refreshed",
      "repo-x must receive the snapshot token, not the original"
    );
    assert.equal(
      receivedTokens["org/repo-y"],
      "token-y-refreshed",
      "repo-y must receive the snapshot token, not the original"
    );
  });
});

// ---------------------------------------------------------------------------
// extractPrimaryPrInfo — flat prInfo extraction from per-repo results array
// ---------------------------------------------------------------------------

describe("extractPrimaryPrInfo", () => {
  test("extracts flat prInfo from primary success result", () => {
    const results = [
      {
        fullName: "org/repo",
        status: "success",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        branchName: "symphony/test",
        commitSha: "abc123",
      },
    ];
    const result = extractPrimaryPrInfo(results, "org/repo");
    assert.deepEqual(result, {
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      branchName: "symphony/test",
      commitSha: "abc123",
    });
  });

  test("returns null when primary repo not found", () => {
    const results = [
      {
        fullName: "org/other-repo",
        status: "success",
        prUrl: "https://github.com/org/other-repo/pull/7",
        prNumber: 7,
        branchName: "symphony/test",
        commitSha: "def456",
      },
    ];
    const result = extractPrimaryPrInfo(results, "nonexistent/repo");
    assert.equal(result, null);
  });

  test("returns null when primary repo has failed status", () => {
    const results = [
      {
        fullName: "org/repo",
        status: "failed",
        prUrl: null,
        prNumber: null,
        branchName: "symphony/test",
        commitSha: null,
      },
    ];
    const result = extractPrimaryPrInfo(results, "org/repo");
    assert.equal(result, null);
  });

  test("returns null when primary repo has skipped status", () => {
    const results = [
      {
        fullName: "org/repo",
        status: "skipped",
        prUrl: null,
        prNumber: null,
        branchName: "symphony/test",
        commitSha: null,
      },
    ];
    const result = extractPrimaryPrInfo(results, "org/repo");
    assert.equal(result, null);
  });

  test("selects correct repo from multi-repo results", () => {
    const results = [
      {
        fullName: "org/peer-repo",
        status: "success",
        prUrl: "https://github.com/org/peer-repo/pull/10",
        prNumber: 10,
        branchName: "symphony/test",
        commitSha: "peer999",
      },
      {
        fullName: "org/primary-repo",
        status: "success",
        prUrl: "https://github.com/org/primary-repo/pull/42",
        prNumber: 42,
        branchName: "symphony/test",
        commitSha: "primary123",
      },
    ];
    const result = extractPrimaryPrInfo(results, "org/primary-repo");
    assert.deepEqual(result, {
      prUrl: "https://github.com/org/primary-repo/pull/42",
      prNumber: 42,
      branchName: "symphony/test",
      commitSha: "primary123",
    });
  });
});

// ---------------------------------------------------------------------------
// buildEventResult — flat event payload construction
// ---------------------------------------------------------------------------

describe("buildEventResult", () => {
  afterEach(() => {
    resetHarnessState({ capturedSessionId: null });
  });

  test("(a) prInfo fields are spread into the result", () => {
    const prInfo = {
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      branchName: "symphony/feature",
      commitSha: "abc123",
    };
    const result = buildEventResult(prInfo, [], {});
    assert.equal(
      result.prUrl,
      prInfo.prUrl,
      "prUrl must be spread from prInfo"
    );
    assert.equal(
      result.prNumber,
      prInfo.prNumber,
      "prNumber must be spread from prInfo"
    );
    assert.equal(
      result.branchName,
      prInfo.branchName,
      "branchName must be spread from prInfo"
    );
    assert.equal(
      result.commitSha,
      prInfo.commitSha,
      "commitSha must be spread from prInfo"
    );
  });

  test("(b) repos array included only when non-empty", () => {
    const prInfo = { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 };
    const repoResult = {
      status: "success",
      fullName: "org/repo",
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
      branchName: "symphony/feat",
      baseBranch: "main",
      hasChanges: true,
    };

    const withRepos = buildEventResult(prInfo, [repoResult], {});
    assert.ok(
      Array.isArray(withRepos.repos),
      "repos must be present when results is non-empty"
    );
    assert.equal(withRepos.repos.length, 1, "repos must contain one entry");

    const withoutRepos = buildEventResult(prInfo, [], {});
    assert.equal(
      withoutRepos.repos,
      undefined,
      "repos must be absent when results is empty"
    );
  });

  test("(c) sessionId included when capturedSessionId is set", () => {
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    resetHarnessState({ capturedSessionId: sessionId });

    const result = buildEventResult(null, [], {});
    assert.equal(
      result.sessionId,
      sessionId,
      "sessionId must equal capturedSessionId"
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-repo policy: parameterized matrix across LoopCommand
// ---------------------------------------------------------------------------

const PEER_ENABLED_COMMANDS = Object.entries(MULTI_REPO_POLICY)
  .filter(([, policy]) => policy.supportsAdditionalRepos)
  .map(([command]) => command);

const PEER_DISABLED_COMMANDS = Object.entries(MULTI_REPO_POLICY)
  .filter(([, policy]) => !policy.supportsAdditionalRepos)
  .map(([command]) => command);

// PLAN and EXECUTE go through buildRunLoopArgs, which buildCommand() resolves
// by calling findRunLoop() — that lookup is host-dependent (plugin install
// path) and would throw HarnessError(runLoopNotFound) in a clean environment.
// We exercise the run-loop path via buildRunLoopArgs directly below.
const USES_RUN_LOOP = new Set([LoopCommand.Plan, LoopCommand.Execute]);

/** Count occurrences of `--add-dir` flags in a Claude argv array. */
function countAddDirFlags(args) {
  return args.filter((token) => token === "--add-dir").length;
}

/**
 * Resolved peer metadata as produced by `buildPeerLocalPaths` from the
 * orchestration site. `buildCommand` and `buildClaudeDirectArgs` both accept
 * this shape directly so that --add-dir paths and the mount-paths footer
 * derive from a single source.
 */
function makePeerMetadata() {
  return [
    {
      fullName: "org/peer-a",
      branch: "main",
      localPath: "/workspace/peers/org--peer-a",
    },
    {
      fullName: "org/peer-b",
      branch: "develop",
      localPath: "/workspace/peers/org--peer-b",
    },
  ];
}

describe("MULTI_REPO_POLICY ↔ buildCommand peer wiring", () => {
  for (const command of PEER_ENABLED_COMMANDS) {
    if (USES_RUN_LOOP.has(command)) {
      // PLAN/EXECUTE go through buildRunLoopArgs — covered in the matrix
      // block below using a fake runLoopPath, which avoids host-dependent
      // findRunLoop() lookups.
      continue;
    }
    test(`${command}: buildCommand emits exactly N --add-dir flags for N peer paths`, () => {
      const workDir = makeTempDir();
      writePromptFile(workDir, `Peer-aware prompt for ${command}`);
      resetConfig({ command });

      const peers = makePeerMetadata();
      const { args } = buildCommand(workDir, workDir, null, peers);

      assert.equal(
        countAddDirFlags(args),
        peers.length,
        `${command} must emit one --add-dir per peer`
      );
    });

    test(`${command}: buildCommand with zero peers emits zero --add-dir flags`, () => {
      const workDir = makeTempDir();
      writePromptFile(workDir, `Empty-peers prompt for ${command}`);
      resetConfig({ command });

      const { args } = buildCommand(workDir, workDir, null, []);

      assert.equal(
        countAddDirFlags(args),
        0,
        `${command} with empty peers must be byte-identical to no-peer baseline`
      );
    });
  }

  // Exercise PLAN and EXECUTE peer wiring via buildRunLoopArgs directly so the
  // matrix is host-independent (findRunLoop() is bypassed). This keeps AC-007
  // — PLAN/EXECUTE peer behavior is policy-driven — under test coverage.
  for (const command of PEER_ENABLED_COMMANDS) {
    if (!USES_RUN_LOOP.has(command)) {
      continue;
    }
    test(`${command}: buildRunLoopArgs emits exactly N --add-dir flags for N peer paths`, () => {
      resetConfig({ command });
      const peerPaths = makePeerMetadata().map((p) => p.localPath);
      const { cmd, args } = buildRunLoopArgs(
        "/fake/run-loop.sh",
        "/workspace/repo",
        null,
        peerPaths
      );
      assert.equal(cmd, "bash");
      assert.equal(
        countAddDirFlags(args),
        peerPaths.length,
        `${command} must emit one --add-dir per peer path`
      );
    });

    test(`${command}: buildRunLoopArgs with zero peers emits zero --add-dir flags`, () => {
      resetConfig({ command });
      const { args } = buildRunLoopArgs(
        "/fake/run-loop.sh",
        "/workspace/repo",
        null,
        []
      );
      assert.equal(
        countAddDirFlags(args),
        0,
        `${command} with empty peers must be byte-identical to no-peer baseline`
      );
    });
  }

  for (const command of PEER_DISABLED_COMMANDS) {
    test(`${command}: buildCommand emits zero --add-dir flags even when peers supplied (defense-in-depth)`, () => {
      const workDir = makeTempDir();
      writePromptFile(workDir, `Defense-in-depth prompt for ${command}`);
      resetConfig({ command });

      // BOOTSTRAP and EVALUATE_FEATURE need their specific buildClaudeDirectArgs
      // case branches; some have no case at all and would throw. We exercise
      // buildCommand only for the subset that has a direct-claude branch.
      const HAS_DIRECT_CLAUDE_BRANCH = new Set([
        LoopCommand.Chat,
        LoopCommand.Explore,
        LoopCommand.Decompose,
        LoopCommand.RequestChanges,
        LoopCommand.EvaluatePrd,
        LoopCommand.EvaluatePlan,
        LoopCommand.EvaluateCode,
        LoopCommand.EvaluateFeature,
      ]);
      if (!HAS_DIRECT_CLAUDE_BRANCH.has(command)) {
        return; // BOOTSTRAP has no claude branch; skip — covered by policy unit tests
      }

      const peers = makePeerMetadata();
      const { args } = buildCommand(workDir, workDir, null, peers);

      assert.equal(
        countAddDirFlags(args),
        0,
        `${command} must NEVER emit --add-dir flags`
      );
      // Also verify no Mounted paths footer leaks into the prompt for these
      // commands (the prompt is the last positional arg in the direct-claude
      // path).
      const lastArg = args.at(-1);
      assert.ok(
        typeof lastArg !== "string" || !lastArg.includes("## Mounted paths"),
        `${command} must not contain Mounted paths footer`
      );
    });
  }
});

describe("Mounted paths footer for peer-enabled direct-claude commands", () => {
  for (const command of [
    LoopCommand.GeneratePrd,
    LoopCommand.RequestPrdChanges,
  ]) {
    test(`${command}: prompt includes a "## Mounted paths" footer when peers present`, () => {
      const workDir = makeTempDir();
      writePromptFile(workDir, `Base prompt for ${command}`);
      resetConfig({ command });

      const peers = makePeerMetadata();
      const { args } = buildClaudeDirectArgs(workDir, workDir, peers);

      const prompt = args.at(-1);
      assert.ok(
        typeof prompt === "string" && prompt.includes("## Mounted paths"),
        `${command} prompt must include Mounted paths footer`
      );
      assert.ok(
        prompt.includes("/workspace/peers/org--peer-a"),
        `${command} footer must list peer-a's mount path`
      );
      assert.ok(
        prompt.includes("/workspace/peers/org--peer-b"),
        `${command} footer must list peer-b's mount path`
      );
      assert.ok(
        prompt.includes("`org/peer-a`"),
        `${command} footer must list peer-a's fullName`
      );
      assert.ok(
        prompt.includes("`develop`"),
        `${command} footer must list peer-b's branch`
      );
    });

    test(`${command}: prompt has no Mounted paths footer when peers are absent`, () => {
      const workDir = makeTempDir();
      writePromptFile(workDir, `Empty-peers prompt for ${command}`);
      resetConfig({ command });

      const { args } = buildClaudeDirectArgs(workDir, workDir, []);
      const prompt = args.at(-1);
      assert.ok(
        typeof prompt === "string" && !prompt.includes("## Mounted paths"),
        `${command} with no peers must have no Mounted paths footer`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// peer-repos.json — written by writeContextPackFiles when peers present
// ---------------------------------------------------------------------------

describe("writeContextPackFiles peer-repos.json", () => {
  test("writes peer-repos.json with fullName, branch, and computed localPath", async () => {
    const workDir = makeTempDir();
    const pack = {
      command: LoopCommand.GeneratePrd,
      prompt: "ignore",
      additionalRepos: [
        { fullName: "org/peer-a", branch: "main", githubToken: "tok-a" },
        { fullName: "org/peer-b", branch: "develop", githubToken: "tok-b" },
      ],
    };

    await writeContextPackFiles(workDir, pack);

    const manifestPath = path.join(
      workDir,
      ".closedloop-ai",
      "context",
      "peer-repos.json"
    );
    assert.ok(
      fs.existsSync(manifestPath),
      "peer-repos.json must exist when additionalRepos is non-empty"
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.deepEqual(manifest, {
      peers: [
        {
          fullName: "org/peer-a",
          branch: "main",
          localPath: "/workspace/peers/org--peer-a",
        },
        {
          fullName: "org/peer-b",
          branch: "develop",
          localPath: "/workspace/peers/org--peer-b",
        },
      ],
    });
  });

  test("does not write peer-repos.json when additionalRepos is absent", async () => {
    const workDir = makeTempDir();
    await writeContextPackFiles(workDir, { command: LoopCommand.Chat });
    const manifestPath = path.join(
      workDir,
      ".closedloop-ai",
      "context",
      "peer-repos.json"
    );
    assert.ok(
      !fs.existsSync(manifestPath),
      "peer-repos.json must be absent when no additionalRepos"
    );
  });

  test("does not write peer-repos.json when additionalRepos is empty array", async () => {
    const workDir = makeTempDir();
    await writeContextPackFiles(workDir, {
      command: LoopCommand.GeneratePrd,
      additionalRepos: [],
    });
    const manifestPath = path.join(
      workDir,
      ".closedloop-ai",
      "context",
      "peer-repos.json"
    );
    assert.ok(
      !fs.existsSync(manifestPath),
      "peer-repos.json must be absent when additionalRepos is empty"
    );
  });
});

// ---------------------------------------------------------------------------
// buildClaudeDirectArgs — single source of truth for --add-dir + footer
// (regression coverage for the closure-read bug that allowed footer/--add-dir
// to drift if cloneAdditionalRepos were ever to partially succeed)
// ---------------------------------------------------------------------------

describe("buildClaudeDirectArgs single-source contract", () => {
  test("--add-dir paths and footer are derived from the same `peers` argument", () => {
    const workDir = makeTempDir();
    writePromptFile(workDir, "Base prompt");
    resetConfig({ command: LoopCommand.GeneratePrd });
    // Inject a CONFLICTING contextPackRef to prove the function does NOT
    // read it for footer construction. If the old closure-read regressed,
    // the footer would mention "ghost/peer-z" — which it must not.
    resetHarnessState({
      contextPackRef: {
        additionalRepos: [
          { fullName: "ghost/peer-z", branch: "main", githubToken: "ghost" },
        ],
      },
    });

    const peers = makePeerMetadata();
    const { args } = buildClaudeDirectArgs(workDir, workDir, peers);

    const addDirIndices = args.reduce((acc, val, idx) => {
      if (val === "--add-dir") {
        acc.push(idx);
      }
      return acc;
    }, []);
    const addDirPaths = addDirIndices.map((i) => args[i + 1]);

    const prompt = args.at(-1);
    assert.equal(addDirPaths.length, peers.length);
    for (const peer of peers) {
      assert.ok(
        addDirPaths.includes(peer.localPath),
        `--add-dir must include ${peer.localPath}`
      );
      assert.ok(
        prompt.includes(peer.localPath),
        `footer must include ${peer.localPath}`
      );
    }
    assert.ok(
      !prompt.includes("ghost/peer-z"),
      "footer must NOT read from contextPackRef closure"
    );
    assert.ok(
      !addDirPaths.some((p) => p.includes("ghost--peer-z")),
      "--add-dir must NOT read from contextPackRef closure"
    );
  });

  test("partial peer set: footer enumerates exactly the peers that were mounted", () => {
    const workDir = makeTempDir();
    writePromptFile(workDir, "Base prompt");
    resetConfig({ command: LoopCommand.GeneratePrd });
    // contextPackRef advertises three peers, but the orchestration site only
    // resolved two (simulating a hypothetical future partial-success path).
    resetHarnessState({
      contextPackRef: {
        additionalRepos: [
          { fullName: "org/peer-a", branch: "main", githubToken: "tok-a" },
          { fullName: "org/peer-b", branch: "develop", githubToken: "tok-b" },
          { fullName: "org/peer-c", branch: "main", githubToken: "tok-c" },
        ],
      },
    });

    // Caller supplies only two resolved peers — peer-c was not mounted.
    const peers = makePeerMetadata();
    const { args } = buildClaudeDirectArgs(workDir, workDir, peers);

    const prompt = args.at(-1);
    assert.ok(prompt.includes("org/peer-a"));
    assert.ok(prompt.includes("org/peer-b"));
    assert.ok(
      !prompt.includes("org/peer-c"),
      "footer must NOT advertise unresolved peer-c"
    );
  });

  test("undefined peers argument behaves identically to empty array (no footer, no --add-dir)", () => {
    const workDir = makeTempDir();
    writePromptFile(workDir, "Base prompt");
    resetConfig({ command: LoopCommand.GeneratePrd });
    resetHarnessState({ contextPackRef: null });

    const { args: argsUndef } = buildClaudeDirectArgs(workDir, workDir);
    const { args: argsEmpty } = buildClaudeDirectArgs(workDir, workDir, []);

    assert.deepEqual(argsUndef, argsEmpty);
    assert.equal(countAddDirFlags(argsUndef), 0);
    assert.ok(!argsUndef.at(-1).includes("## Mounted paths"));
  });
});

// ---------------------------------------------------------------------------
// isPeerWriteEnabled — read-only vs read-write contract
// ---------------------------------------------------------------------------

describe("isPeerWriteEnabled", () => {
  for (const [command, policy] of Object.entries(MULTI_REPO_POLICY)) {
    test(`${command}: matches policy.peerWriteMode === "read-write"`, () => {
      resetConfig({ command });
      const expected = policy.peerWriteMode === "read-write";
      assert.equal(
        isPeerWriteEnabled(),
        expected,
        `${command} expected isPeerWriteEnabled()=${expected} (peerWriteMode=${policy.peerWriteMode})`
      );
    });
  }

  test("read-only commands (PLAN, GENERATE_PRD, REQUEST_PRD_CHANGES) all return false", () => {
    for (const command of [
      LoopCommand.Plan,
      LoopCommand.GeneratePrd,
      LoopCommand.RequestPrdChanges,
    ]) {
      resetConfig({ command });
      assert.equal(isPeerWriteEnabled(), false, `${command} must be read-only`);
    }
  });

  test("EXECUTE returns true (the only read-write command today)", () => {
    resetConfig({ command: LoopCommand.Execute });
    assert.equal(isPeerWriteEnabled(), true);
  });
});

// ---------------------------------------------------------------------------
// refreshGitHubToken — command-agnostic for GENERATE_PRD and REQUEST_PRD_CHANGES
// ---------------------------------------------------------------------------

describe("refreshGitHubToken command-agnostic peer token refresh", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const command of [
    LoopCommand.GeneratePrd,
    LoopCommand.RequestPrdChanges,
  ]) {
    test(`${command}: peer tokens are refreshed identically to PLAN/EXECUTE`, async () => {
      resetConfig({
        command,
        authToken: "test-auth-token",
        apiBaseUrl: "https://api.example.com",
        loopId: "test-loop-id",
        githubToken: "old-primary",
      });

      const contextPack = {
        additionalRepos: [
          { fullName: "org/peer-a", branch: "main", githubToken: "old-a" },
          { fullName: "org/peer-b", branch: "develop", githubToken: "old-b" },
        ],
      };

      let capturedBody;
      globalThis.fetch = async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            data: {
              token: "new-primary",
              additionalRepoTokens: [
                { fullName: "org/peer-a", token: "new-a" },
                { fullName: "org/peer-b", token: "new-b" },
              ],
            },
          }),
        };
      };

      await refreshGitHubToken(contextPack);

      assert.ok(
        capturedBody !== undefined,
        `${command}: fetch was not called — refreshGitHubToken returned early before issuing the request`
      );
      assert.deepEqual(capturedBody.additionalRepos, [
        { fullName: "org/peer-a", branch: "main" },
        { fullName: "org/peer-b", branch: "develop" },
      ]);
      assert.equal(contextPack.additionalRepos[0].githubToken, "new-a");
      assert.equal(contextPack.additionalRepos[1].githubToken, "new-b");
      assert.equal(config.githubToken, "new-primary");
    });
  }
});

// ---------------------------------------------------------------------------
// reportFinalStatus — wiring tests for marker and JSONL auth-challenge paths
// ---------------------------------------------------------------------------

describe("reportFinalStatus auth-challenge wiring", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetConfig({
      command: LoopCommand.Plan,
      loopId: "test-loop-id",
      authToken: "test-auth-token",
      apiBaseUrl: "https://api.example.com",
      correlationId: "test-correlation-id",
      targetRepo: null,
    });
    resetHarnessState({ contextPackRef: null });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installFetchCapture() {
    const capturedCalls = [];
    globalThis.fetch = async (url, options) => {
      capturedCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({
          data: { token: "new-token", additionalRepoTokens: [] },
        }),
      };
    };
    return capturedCalls;
  }

  function getEventData(capturedCalls) {
    const eventCall = capturedCalls.findLast((c) => c.url.includes("/events"));
    if (eventCall === undefined) {
      throw new Error("expected an event POST to /events");
    }
    return JSON.parse(eventCall.options.body).data;
  }

  const tokenUsage = {
    totalInput: 1000,
    totalOutput: 200,
    tokensByModel: { "claude-3-5-sonnet": { input: 1000, output: 200 } },
  };

  async function callReportFinalStatus(workDir, overrides) {
    await reportFinalStatus(workDir, [], {
      timedOut: false,
      signal: null,
      duration: "10.0",
      tokenUsage,
      startTime: Date.now(),
      symphonyWorkDir: null,
      userVisibleLoopFailureSecret: "unused-secret",
      spawnStartedAt: 0,
      ...overrides,
    });
  }

  test("primary marker path emits error event with code/subcode/message from signed marker", async () => {
    const workDir = makeTempDir();
    const signingSecret = "test-signing-secret-abc123";
    const markerPayload = {
      code: LoopErrorCode.RunnerError,
      message: "Pre-run validation rejected the loop configuration.",
      result: { subcode: RunnerErrorSubcode.BadPlanState },
    };
    const signature = signUserVisibleLoopFailure(markerPayload, signingSecret);
    fs.writeFileSync(
      path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE),
      JSON.stringify({ ...markerPayload, signature }),
      "utf-8"
    );

    const capturedCalls = installFetchCapture();
    await callReportFinalStatus(workDir, {
      exitCode: 1,
      userVisibleLoopFailureSecret: signingSecret,
    });

    const data = getEventData(capturedCalls);
    assert.equal(data.code, markerPayload.code);
    assert.equal(data.result.subcode, markerPayload.result.subcode);
    assert.equal(data.message, markerPayload.message);
    assert.equal(data.tokensUsed.input, tokenUsage.totalInput);
    assert.equal(data.tokensUsed.output, tokenUsage.totalOutput);
    assert.deepEqual(data.tokensByModel, tokenUsage.tokensByModel);
  });

  test("JSONL 429 entry on exitCode 0 emits AuthChallenge instead of completed", async () => {
    const workDir = makeTempDir();
    fs.writeFileSync(
      path.join(workDir, "claude-output.jsonl"),
      `${JSON.stringify({
        isApiErrorMessage: true,
        error: "some unknown error text",
        apiErrorStatus: 429,
      })}\n`,
      "utf-8"
    );

    const capturedCalls = installFetchCapture();
    await callReportFinalStatus(workDir, { exitCode: 0 });

    const data = getEventData(capturedCalls);
    assert.equal(data.type, "error");
    assert.equal(data.code, LoopErrorCode.AuthChallenge);
  });

  test("no marker and clean JSONL on exitCode 0 emits completed", async () => {
    const workDir = makeTempDir();
    fs.writeFileSync(
      path.join(workDir, "claude-output.jsonl"),
      `${JSON.stringify({
        type: "result",
        is_error: false,
        result: "Completed successfully",
      })}\n`,
      "utf-8"
    );

    const capturedCalls = installFetchCapture();
    await callReportFinalStatus(workDir, { exitCode: 0 });

    const data = getEventData(capturedCalls);
    assert.equal(data.type, "completed");
    assert.equal(data.code, undefined);
  });
});
