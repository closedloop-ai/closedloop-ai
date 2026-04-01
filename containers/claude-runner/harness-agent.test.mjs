import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  buildClaudeDirectArgs,
  buildCommand,
  config,
  ERROR_CODES,
  HarnessError,
  validateConfig,
  validatePreRunInputs,
  validateSecrets,
  writeContextPackFiles,
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
    artifacts: [{ id: "1", type: "PRD", content: "some prd content" }],
    // prompt intentionally absent
  };

  assert.doesNotThrow(() => validatePreRunInputs("EVALUATE_PRD", contextPack));
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
      arrayBuffer: async () => fileContent.buffer.slice(
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

      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");
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
      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");
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

      assert.ok(!fetchCalled, "fetch should not be called for expired attachment");
      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");
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
      const attachment = makeAttachment({ id: "att-403", filename: "doc.txt", sizeBytes: 100 });
      await writeContextPackFiles(workDir, { attachments: [attachment] });

      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");
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
      arrayBuffer: async () => fileContent.buffer.slice(
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

      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");

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
    const oversizedContent = Buffer.from("this is way too large for declared size");
    const restore = mockFetch(async (_url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => oversizedContent.buffer.slice(
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

      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");
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
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
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

      const attachmentsDir = path.join(workDir, ".closedloop-ai", "work", "attachments");
      const file1 = path.join(attachmentsDir, "id-aaa-notes.txt");
      const file2 = path.join(attachmentsDir, "id-bbb-notes.txt");

      assert.ok(fs.existsSync(file1), "first attachment file should exist");
      assert.ok(fs.existsSync(file2), "second attachment file should exist");
      assert.deepEqual(fs.readFileSync(file1), content1, "first file content must match");
      assert.deepEqual(fs.readFileSync(file2), content2, "second file content must match");
    } finally {
      restore();
    }
  });
});
