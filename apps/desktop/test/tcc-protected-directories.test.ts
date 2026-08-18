import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { isGitRepository } from "../src/shared/git-utils.js";
import {
  isPathAtOrUnder,
  isTccProtectedBasename,
  isTccProtectedDirectory,
  pathsEqualIgnoreCase,
  TCC_PROTECTED_HOME_SUBDIRS,
  tccProtectedDirectories,
} from "../src/shared/sandbox-policy.js";

// FEA-3641: TCC-protected user folders (Music, Pictures, Documents, …) must
// never be stat'd/probed. These tests pin the policy + the git-utils
// short-circuit that skips the `.git` probe (the "music files" symptom).

describe("isTccProtectedBasename", () => {
  test("matches the protected home subdirectory names case-insensitively", () => {
    for (const name of TCC_PROTECTED_HOME_SUBDIRS) {
      assert.equal(isTccProtectedBasename(name), true, name);
      assert.equal(isTccProtectedBasename(name.toLowerCase()), true, name);
      assert.equal(isTccProtectedBasename(name.toUpperCase()), true, name);
    }
  });

  test("matches the Photos library bundle", () => {
    assert.equal(isTccProtectedBasename("Photos Library.photoslibrary"), true);
  });

  test("does not match ordinary project folders", () => {
    assert.equal(isTccProtectedBasename("Source"), false);
    assert.equal(isTccProtectedBasename("Code"), false);
    assert.equal(isTccProtectedBasename("my-documents-app"), false);
  });
});

describe("isTccProtectedDirectory", () => {
  test("flags protected folders directly under home", () => {
    const home = os.homedir();
    assert.equal(isTccProtectedDirectory(path.join(home, "Music")), true);
    assert.equal(isTccProtectedDirectory(path.join(home, "Pictures")), true);
    assert.equal(isTccProtectedDirectory(path.join(home, "Documents")), true);
    assert.equal(isTccProtectedDirectory("~/Downloads"), true);
  });

  test("flags a .photoslibrary bundle anywhere", () => {
    assert.equal(
      isTccProtectedDirectory("/Users/x/Pictures/My.photoslibrary"),
      true
    );
  });

  test("does NOT flag a same-named folder that is not directly under home", () => {
    // A project folder called "Documents" nested inside a repo is fine.
    assert.equal(
      isTccProtectedDirectory("/Users/x/Source/app/Documents"),
      false
    );
  });

  test("does not flag ordinary project folders under home", () => {
    assert.equal(
      isTccProtectedDirectory(path.join(os.homedir(), "Source")),
      false
    );
  });

  test("handles null/undefined/blank", () => {
    assert.equal(isTccProtectedDirectory(null), false);
    assert.equal(isTccProtectedDirectory(undefined), false);
    assert.equal(isTccProtectedDirectory(""), false);
  });
});

describe("tccProtectedDirectories", () => {
  test("returns absolute paths under the current home directory", () => {
    const dirs = tccProtectedDirectories();
    const home = os.homedir();
    assert.equal(dirs.length, TCC_PROTECTED_HOME_SUBDIRS.length);
    assert.ok(dirs.includes(path.join(home, "Music")));
    assert.ok(dirs.every((d) => d.startsWith(home + path.sep)));
  });
});

// FEA-3641 follow-up: the shared case-folding primitives that back both the
// risky-dir guard (sandbox-policy) and the file-search exclusion
// (filesystem-search). macOS/Windows are case-insensitive, so any protected-root
// comparison must fold case or a differently-cased path defeats the check.
describe("pathsEqualIgnoreCase", () => {
  test("matches identical paths regardless of case", () => {
    assert.equal(
      pathsEqualIgnoreCase("/Users/x/Music", "/Users/x/music"),
      true
    );
    assert.equal(
      pathsEqualIgnoreCase("/Users/x/MUSIC", "/Users/x/Music"),
      true
    );
  });

  test("does not match genuinely different paths", () => {
    assert.equal(
      pathsEqualIgnoreCase("/Users/x/Music", "/Users/x/Movies"),
      false
    );
  });
});

describe("isPathAtOrUnder", () => {
  test("matches the root itself and descendants case-insensitively", () => {
    const root = path.join(os.homedir(), "Documents");
    assert.equal(isPathAtOrUnder(root, root), true);
    assert.equal(
      isPathAtOrUnder(root.toLowerCase(), root),
      true,
      "lowercased target still under protected root"
    );
    assert.equal(
      isPathAtOrUnder(path.join(os.homedir(), "documents", "workspace"), root),
      true,
      "differently-cased descendant is still under the protected root"
    );
  });

  test("does not match a sibling or a prefix-only string", () => {
    const root = path.join(os.homedir(), "Documents");
    assert.equal(
      isPathAtOrUnder(path.join(os.homedir(), "Downloads"), root),
      false
    );
    // "Documents-backup" shares a prefix but is NOT under "Documents".
    assert.equal(isPathAtOrUnder(`${root}-backup`, root), false);
  });
});

describe("isGitRepository skips the .git probe for TCC-protected dirs", () => {
  const originalHomedir = os.homedir;

  afterEach(() => {
    (os as { homedir: typeof os.homedir }).homedir = originalHomedir;
  });

  test("returns false for a protected home subdir WITHOUT touching the filesystem", () => {
    // Point homedir at a temp dir so we can materialize a real `.git` inside a
    // "protected" folder and prove we never stat it.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tcc-home-"));
    (os as { homedir: typeof os.homedir }).homedir = () => fakeHome;

    const musicDir = path.join(fakeHome, "Music");
    fs.mkdirSync(path.join(musicDir, ".git"), { recursive: true });

    // Even though `<home>/Music/.git` exists on disk, the probe is skipped and
    // we report false — no stat, hence no macOS TCC prompt.
    assert.equal(isGitRepository(musicDir), false);

    (os as { homedir: typeof os.homedir }).homedir = originalHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("still detects a real git repo in a non-protected dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcc-repo-"));
    fs.mkdirSync(path.join(dir, ".git"));
    assert.equal(isGitRepository(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
