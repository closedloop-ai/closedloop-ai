import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  assertRepoAllowed,
  expandHome,
  readLaunchMetadata,
  readLaunchMetadataAsync,
  resolveWorktreeDir,
  resolveWorktreeParentDir,
  sanitizeTicketId,
} from "../src/server/operations/symphony-utils.js";
import { DirectoryNotAllowedError } from "../src/server/security.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const tempPaths: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `symphony-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

// --- readLaunchMetadata ---

describe("readLaunchMetadata", () => {
  test("returns null when file is missing", () => {
    const dir = makeTempDir();
    assert.equal(readLaunchMetadata(dir), null);
  });

  test("returns baseBranch and parentTicketId from valid file", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "launch-metadata.json"),
      JSON.stringify({ baseBranch: "main", parentTicketId: "AI-100" })
    );

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: "main",
      issueId: undefined,
      parentTicketId: "AI-100",
      ticketTitle: undefined,
    });
  });

  test("async reader matches sync metadata parsing", async () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "launch-metadata.json"),
      JSON.stringify({ artifactId: "FEA-2015", loopId: "loop-1" })
    );

    assert.deepEqual(
      await readLaunchMetadataAsync(dir),
      readLaunchMetadata(dir)
    );
  });

  test("returns null for malformed JSON", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(path.join(claudeWorkDir, "launch-metadata.json"), "not json");

    assert.equal(readLaunchMetadata(dir), null);
  });

  test("ignores non-string fields", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "launch-metadata.json"),
      JSON.stringify({ baseBranch: 123, parentTicketId: null })
    );

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: undefined,
      issueId: undefined,
      parentTicketId: undefined,
      ticketTitle: undefined,
    });
  });
});

// --- sanitizeTicketId ---

describe("sanitizeTicketId", () => {
  test("passes through alphanumeric and dashes", () => {
    assert.equal(sanitizeTicketId("AI-100"), "AI-100");
  });

  test("replaces special characters with underscores", () => {
    assert.equal(sanitizeTicketId("AI/100 (foo)"), "AI_100__foo_");
  });
});

// ─── ISS-9170 — pure/utility exports with no direct coverage elsewhere ─────
//
// Moved here from a generic `gateway-*-coverage` bucket so these cases sit
// with the module they exercise.
//
// Structurally unreachable and deliberately not covered: `assertRepoAllowed`'s
// catch has an else arm that rethrows verbatim, but `assertPathAllowed` only
// ever throws `DirectoryNotAllowedError`, so that arm is dead.

describe("ISS-9170 — symphony-utils pure helpers", () => {
  const ENV_KEYS = ["SYMPHONY_WORKTREE_PARENT_DIR"] as const;
  let savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    restoreEnvVars(savedEnv);
    savedEnv = {};
  });

  // ─── expandHome ───────────────────────────────────────────────────────────

  test("expandHome expands a bare ~ and a ~/-prefixed path, and leaves other paths unchanged", () => {
    assert.equal(expandHome("~"), os.homedir());
    assert.equal(
      expandHome("~/projects/repo"),
      path.join(os.homedir(), "projects/repo")
    );
    assert.equal(expandHome("/tmp/already-absolute"), "/tmp/already-absolute");
  });

  // ─── resolveWorktreeParentDir / resolveWorktreeDir ─────────────────────────

  test("resolveWorktreeParentDir falls back to the repo's dirname when the env var is unset", () => {
    savedEnv = saveEnvVars(ENV_KEYS);
    Reflect.deleteProperty(process.env, "SYMPHONY_WORKTREE_PARENT_DIR");

    const repoPath = "/tmp/some/my-repo";
    assert.equal(resolveWorktreeParentDir(repoPath), path.dirname(repoPath));
  });

  test("resolveWorktreeParentDir falls back to dirname when the env var is whitespace-only", () => {
    savedEnv = saveEnvVars(ENV_KEYS);
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = "   ";

    const repoPath = "/tmp/some/my-repo";
    assert.equal(resolveWorktreeParentDir(repoPath), path.dirname(repoPath));
  });

  test("resolveWorktreeParentDir uses the expanded configured dir when the env var is set, and resolveWorktreeDir joins it with the sanitized ticket suffix", () => {
    savedEnv = saveEnvVars(ENV_KEYS);
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = "~/custom-worktrees";

    const repoPath = "/tmp/some/my-repo";
    const expectedParent = path.join(os.homedir(), "custom-worktrees");
    assert.equal(resolveWorktreeParentDir(repoPath), expectedParent);

    const worktreeDir = resolveWorktreeDir(repoPath, "ISS 123/456");
    assert.equal(worktreeDir, path.join(expectedParent, "my-repo-ISS_123_456"));
  });

  // ─── assertRepoAllowed ──────────────────────────────────────────────────────

  test("assertRepoAllowed expands ~ and returns the expanded path when it is allowed", () => {
    const result = assertRepoAllowed("~", [os.homedir()]);
    assert.equal(result, os.homedir());
  });

  test("assertRepoAllowed throws DirectoryNotAllowedError when the path is outside every allowed directory", () => {
    const allowed = makeTempDir();
    assert.throws(
      () => assertRepoAllowed("/definitely/not/allowed", [allowed]),
      DirectoryNotAllowedError
    );
  });
});
