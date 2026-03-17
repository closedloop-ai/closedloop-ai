import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  buildClaudeDirectArgs,
  buildCommand,
  CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES,
  config,
  ERROR_CODES,
  HarnessError,
  validateConfig,
  validatePreRunInputs,
  validateSecrets,
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
  const contextDir = path.join(workDir, ".claude", "context");
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
// (b) buildClaudeDirectArgs with EVALUATE_PRD reads prompt.md from
//     .claude/context/prompt.md and produces args including the prompt content
//     (--artifact-type prd is inside the prompt string, not a separate argv)
// ---------------------------------------------------------------------------

test("buildClaudeDirectArgs with EVALUATE_PRD includes prompt content and no separate --artifact-type argv", () => {
  const workDir = makeTempDir();
  const promptText = "Evaluate this PRD content.";
  writePromptFile(workDir, promptText);
  resetConfig({ command: "EVALUATE_PRD" });

  const { cmd, args } = buildClaudeDirectArgs(workDir, null);

  assert.equal(cmd, "claude");

  assert.ok(
    args.includes(promptText),
    `args must include the prompt text; got: ${JSON.stringify(args)}`
  );
  // --artifact-type prd is embedded in the prompt string, not a separate argv entry
  assert.equal(
    args.indexOf("--artifact-type"),
    -1,
    "args must NOT contain --artifact-type as a separate flag (it belongs inside the prompt)"
  );
});

// ---------------------------------------------------------------------------
// (c) buildClaudeDirectArgs with EVALUATE_PRD and missing prompt.md throws
// ---------------------------------------------------------------------------

test("buildClaudeDirectArgs with EVALUATE_PRD throws Error when prompt.md is absent", () => {
  const workDir = makeTempDir();
  // Intentionally do NOT write prompt.md
  resetConfig({ command: "EVALUATE_PRD" });

  assert.throws(
    () => buildClaudeDirectArgs(workDir, null),
    (err) => {
      assert.ok(err instanceof Error, "must throw an Error");
      assert.match(err.message, /No prompt found/i);
      return true;
    }
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
    artifacts: [{ id: "1", type: "PRD", content: "some prd content" }],
    // prompt intentionally absent
  };

  assert.doesNotThrow(() => validatePreRunInputs("EVALUATE_PRD", contextPack));
});

// ---------------------------------------------------------------------------
// (h) CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES includes "prd-judges.json"
// ---------------------------------------------------------------------------

test('CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES includes "prd-judges.json"', () => {
  assert.ok(
    Array.isArray(CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES),
    "must be an array"
  );
  assert.ok(
    CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES.includes("prd-judges.json"),
    `expected "prd-judges.json" in list; got: ${JSON.stringify(CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES)}`
  );
});
