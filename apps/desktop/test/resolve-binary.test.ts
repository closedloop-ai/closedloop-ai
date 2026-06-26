/**
 * Tests for async and sync login-shell binary resolution from shell-path.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  type BinaryName,
  type BinaryResolveResult,
  resetShellPathCache,
  resolveBinaryFromLoginShell,
  resolveBinaryFromLoginShellSync,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const tempDirs: string[] = [];
const originalEnv = saveEnvVars(["PATH", "SHELL", "CL_TEST_SHELL_PATH_OUTPUT"]);

afterEach(() => {
  restoreEnvVars(originalEnv);
  resetShellPathCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a temporary directory with an executable file at the given name.
 * Returns the directory path and the full path to the fake binary.
 */
function makeTempBin(name: string): { dir: string; binPath: string } {
  const dir = makeTempDir("resolve-binary-test-");
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode: 0o755 });
  return { dir, binPath };
}

/**
 * Create a temporary directory with a non-executable file at the given name.
 * Returns the directory path and the full path to the fake binary.
 */
function makeTempNonExecutableBin(name: string): {
  dir: string;
  binPath: string;
} {
  const dir = makeTempDir("resolve-binary-noexec-");
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode: 0o644 });
  return { dir, binPath };
}

function makeFakeShell(): string {
  const dir = makeTempDir("resolve-binary-shell-");
  const shellPath = path.join(dir, "fake-shell");
  fs.writeFileSync(
    shellPath,
    [
      "#!/bin/sh",
      "printf '__CLPATH_START__%s__CLPATH_END__\\n' \"$CL_TEST_SHELL_PATH_OUTPUT\"",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return shellPath;
}

async function expectParity(
  name: BinaryName,
  override: string | undefined,
  expected: BinaryResolveResult
): Promise<void> {
  const asyncResult = await resolveBinaryFromLoginShell(name, override);
  const syncResult = resolveBinaryFromLoginShellSync(name, override);

  assert.deepEqual(asyncResult, expected);
  assert.deepEqual(syncResult, expected);
}

const ALL_BINARY_NAMES: BinaryName[] = [
  "claude",
  "gh",
  "codex",
  "python3",
  "git",
];

// ---------------------------------------------------------------------------
// resolveBinaryFromLoginShell (async)
// ---------------------------------------------------------------------------

describe("resolveBinaryFromLoginShell: override valid (file exists and is executable)", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "override" with override path`, async () => {
      const { binPath } = makeTempBin(name);
      const result = await resolveBinaryFromLoginShell(name, binPath);
      assert.equal(result.source, "override");
      assert.equal(result.path, binPath);
    });
  }
});

describe("resolveBinaryFromLoginShell: override invalid (file does not exist)", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "override_invalid" with override path (no PATH fallback)`, async () => {
      const dir = makeTempDir("resolve-binary-missing-");
      const nonExistentPath = path.join(dir, name);

      const { dir: binDir, binPath: realBin } = makeTempBin(name);
      process.env.PATH = binDir;
      setShellPathForTest();

      const result = await resolveBinaryFromLoginShell(name, nonExistentPath);
      assert.equal(result.source, "override_invalid");
      assert.equal(result.path, nonExistentPath);
      assert.notEqual(result.path, realBin);
    });
  }
});

describe("resolveBinaryFromLoginShell: override invalid (file exists but not executable)", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "override_invalid"`, async () => {
      const { binPath } = makeTempNonExecutableBin(name);
      const result = await resolveBinaryFromLoginShell(name, binPath);
      assert.equal(result.source, "override_invalid");
      assert.equal(result.path, binPath);
    });
  }
});

describe("resolveBinaryFromLoginShell: no override, binary on PATH", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "path"`, async () => {
      const { dir, binPath } = makeTempBin(name);
      process.env.PATH = dir;
      setShellPathForTest();

      const result = await resolveBinaryFromLoginShell(name);
      assert.equal(result.source, "path");
      assert.equal(result.path, binPath);
    });
  }
});

describe("resolveBinaryFromLoginShell: no override, binary not on PATH", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "fallback" with bare binary name`, async () => {
      process.env.PATH = makeTempDir("resolve-binary-empty-");
      setShellPathForTest();

      const result = await resolveBinaryFromLoginShell(name);
      assert.equal(result.source, "fallback");
      assert.equal(result.path, name);
    });
  }
});

// ---------------------------------------------------------------------------
// resolveBinaryFromLoginShellSync (sync)
// ---------------------------------------------------------------------------

describe("resolveBinaryFromLoginShellSync: override valid (file exists and is executable)", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "override" with override path`, () => {
      const { binPath } = makeTempBin(name);
      const result = resolveBinaryFromLoginShellSync(name, binPath);
      assert.equal(result.source, "override");
      assert.equal(result.path, binPath);
    });
  }
});

describe("resolveBinaryFromLoginShellSync: override invalid (file does not exist)", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "override_invalid" with override path (no PATH fallback)`, () => {
      const dir = makeTempDir("resolve-binary-sync-missing-");
      const nonExistentPath = path.join(dir, name);

      const { dir: binDir, binPath: realBin } = makeTempBin(name);
      process.env.PATH = binDir;
      setShellPathForTest();

      const result = resolveBinaryFromLoginShellSync(name, nonExistentPath);
      assert.equal(result.source, "override_invalid");
      assert.equal(result.path, nonExistentPath);
      assert.notEqual(result.path, realBin);
    });
  }
});

describe("resolveBinaryFromLoginShellSync: override invalid (file exists but not executable)", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "override_invalid"`, () => {
      const { binPath } = makeTempNonExecutableBin(name);
      const result = resolveBinaryFromLoginShellSync(name, binPath);
      assert.equal(result.source, "override_invalid");
      assert.equal(result.path, binPath);
    });
  }
});

describe("resolveBinaryFromLoginShellSync: no override, binary on PATH", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "path"`, () => {
      const { dir, binPath } = makeTempBin(name);
      process.env.PATH = dir;
      setShellPathForTest();

      const result = resolveBinaryFromLoginShellSync(name);
      assert.equal(result.source, "path");
      assert.equal(result.path, binPath);
    });
  }
});

describe("resolveBinaryFromLoginShellSync: no override, binary not on PATH", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: returns source "fallback" with bare binary name`, () => {
      process.env.PATH = makeTempDir("resolve-binary-sync-empty-");
      setShellPathForTest();

      const result = resolveBinaryFromLoginShellSync(name);
      assert.equal(result.source, "fallback");
      assert.equal(result.path, name);
    });
  }
});

// ---------------------------------------------------------------------------
// Sync/async parity
// ---------------------------------------------------------------------------

describe("resolveBinaryFromLoginShell sync/async parity", () => {
  for (const name of ALL_BINARY_NAMES) {
    test(`${name}: valid override`, async () => {
      const { binPath } = makeTempBin(name);
      await expectParity(name, binPath, { path: binPath, source: "override" });
    });

    test(`${name}: invalid missing override`, async () => {
      const missingOverride = path.join(
        makeTempDir("resolve-binary-parity-missing-"),
        name
      );
      const { dir } = makeTempBin(name);
      process.env.PATH = dir;
      setShellPathForTest();

      await expectParity(name, missingOverride, {
        path: missingOverride,
        source: "override_invalid",
      });
    });

    test(`${name}: login-shell PATH hit`, async () => {
      const { dir, binPath } = makeTempBin(name);
      process.env.PATH = dir;
      setShellPathForTest();

      await expectParity(name, undefined, { path: binPath, source: "path" });
    });

    test(`${name}: missing binary fallback`, async () => {
      process.env.PATH = makeTempDir("resolve-binary-parity-empty-");
      setShellPathForTest();

      await expectParity(name, undefined, { path: name, source: "fallback" });
    });
  }
});

// ---------------------------------------------------------------------------
// GUI PATH regression coverage
// ---------------------------------------------------------------------------

describe("resolveBinaryFromLoginShellSync: login shell drives discovery, not process.env.PATH", () => {
  test("finds claude via fake login shell when inherited PATH excludes its dir", () => {
    const { dir, binPath } = makeTempBin("claude");
    const env = {
      ...process.env,
      SHELL: makeFakeShell(),
      CL_TEST_SHELL_PATH_OUTPUT: dir,
      PATH: makeTempDir("resolve-binary-gui-empty-"),
    };

    const result = withShellPathEnvForTest(env, () =>
      resolveBinaryFromLoginShellSync("claude")
    );

    assert.equal(result.source, "path");
    assert.equal(result.path, binPath);
  });
});

// ---------------------------------------------------------------------------
// FEA-935: async resolver honors getShellPath independently of inherited PATH
// ---------------------------------------------------------------------------

describe("resolveBinaryFromLoginShell: getShellPath drives discovery, not process.env.PATH (FEA-935)", () => {
  test("finds binary via getShellPath() even when process.env.PATH excludes its dir", async () => {
    const { dir, binPath } = makeTempBin("claude");

    process.env.PATH = dir;
    setShellPathForTest();

    const emptyDir = makeTempDir("fea935-empty-");
    process.env.PATH = emptyDir;

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "path");
    assert.equal(result.path, binPath);
  });

  test("returns 'fallback' only when binary is absent from getShellPath", async () => {
    process.env.PATH = makeTempDir("fea935-truly-empty-");
    setShellPathForTest();

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "fallback");
    assert.equal(result.path, "claude");
  });
});

// ---------------------------------------------------------------------------
// BinaryName compile-time type check
// ---------------------------------------------------------------------------
// This is intentionally a type-only assertion. All five names are accepted
// as BinaryName at compile time; no runtime assertion is needed.
const _typeCheck: BinaryName[] = ["claude", "gh", "codex", "python3", "git"];
void _typeCheck;
