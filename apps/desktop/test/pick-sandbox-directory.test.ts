import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { isGitRepository } from "../src/shared/git-utils.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

// Unit tests for the .git detection logic used by the
// `desktop:pick-sandbox-directory` IPC handler in app.ts.

const { makeTempDir } = createTempDirManager("pick-sandbox-");

describe("isGitRepository — .git detection logic for desktop:pick-sandbox-directory", () => {
  test("returns true when selected directory contains a .git subdirectory", async () => {
    const selectedPath = makeTempDir();
    await fs.mkdir(path.join(selectedPath, ".git"));

    assert.equal(isGitRepository(selectedPath), true);
  });

  test("returns false when selected directory does NOT contain a .git subdirectory", () => {
    const selectedPath = makeTempDir();

    assert.equal(isGitRepository(selectedPath), false);
  });

  test("returns true when .git is a file (e.g. git worktree)", async () => {
    const selectedPath = makeTempDir();
    // git worktrees use a `.git` file pointing elsewhere; existsSync is true
    // for files too — this test documents that our detection is path-existence
    // based (matches the IPC handler behaviour).
    await fs.writeFile(
      path.join(selectedPath, ".git"),
      "gitdir: /other/.git\n"
    );

    assert.equal(isGitRepository(selectedPath), true);
  });
});
