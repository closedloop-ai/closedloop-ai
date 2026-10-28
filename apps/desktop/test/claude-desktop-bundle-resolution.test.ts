/**
 * ISS-7203 — resolving the copy of Claude Code that Claude Desktop ships and
 * manages itself, outside PATH, under a per-version directory.
 *
 * The load-bearing case is the first describe block: a macOS `.app` is a bundle
 * DIRECTORY that PASSES `access(X_OK)`, so a resolver that probes X_OK alone
 * reports a directory as a resolved binary — `isResolvedOnHost` true, and a
 * failure deferred to spawn. That is strictly worse than an honest "not
 * installed", and it applies to BOTH resolution tiers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  claudeDesktopBundleRoot,
  discoverBundledClaudeBinaries,
} from "../src/server/claude-desktop-bundle.js";
import {
  _setClaudeDesktopHostForTest,
  _setKnownBinaryLocationsForResolverTest,
  resetShellPathCache,
  resolveBinaryFromLoginShell,
  resolveBinaryFromLoginShellSync,
  resolveExecutablesOnPath,
  resolveExecutablesOnPathSync,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const BUNDLED_VERSION = "2.1.219";

const tempDirs: string[] = [];
const originalEnv = saveEnvVars(["PATH", "SHELL", "HOME"]);

afterEach(() => {
  restoreEnvVars(originalEnv);
  resetShellPathCache();
  _setKnownBinaryLocationsForResolverTest(null);
  _setClaudeDesktopHostForTest(null);
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
 * Build a synthetic macOS HOME whose Claude Desktop support dir holds one
 * `<version>/claude.app/Contents/MacOS/claude` per requested version, each an
 * executable script printing that version the way the real binary does.
 *
 * Tests inject `home` (not `root`) so the probe runs its real
 * `claudeDesktopBundleRoot` composition instead of being handed the answer —
 * see `_setClaudeDesktopHostForTest`. The support-dir layout comes from that
 * same production function rather than a second literal copy of the path, and
 * the literal it must produce is pinned separately below.
 */
function makeBundleHome(versions: readonly string[]): {
  home: string;
  root: string;
  binaryFor: (version: string) => string;
  appDirFor: (version: string) => string;
} {
  const home = makeTempDir("claude-desktop-home-");
  const root = claudeDesktopBundleRoot("darwin", home);
  if (root === null) {
    throw new Error("the darwin support root must be composable");
  }
  const appDirFor = (version: string) => path.join(root, version, "claude.app");
  const binaryFor = (version: string) =>
    path.join(appDirFor(version), "Contents", "MacOS", "claude");
  fs.mkdirSync(root, { recursive: true });
  for (const version of versions) {
    const binPath = binaryFor(version);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, `#!/bin/sh\necho '${version} (Claude Code)'\n`, {
      mode: 0o755,
    });
  }
  return { home, root, binaryFor, appDirFor };
}

/** Point the probe at a synthetic macOS host, exercising the real composition. */
function pinDarwinHome(homeDir: string): void {
  _setClaudeDesktopHostForTest({ platform: "darwin", homeDir });
}

/** Pin the login-shell PATH to a directory holding no binaries at all. */
function pinEmptyShellPath(prefix: string): void {
  process.env.PATH = makeTempDir(prefix);
  setShellPathForTest();
}

// ---------------------------------------------------------------------------
// The trap: a directory must never resolve as a binary
// ---------------------------------------------------------------------------

describe("known-location tier rejects non-files (ISS-7203)", () => {
  test("a `.app` bundle directory passes X_OK but must NOT resolve", async () => {
    const { appDirFor } = makeBundleHome([BUNDLED_VERSION]);
    const appDir = appDirFor(BUNDLED_VERSION);

    // Pin the premise this whole ticket rests on. If macOS ever stopped
    // granting X_OK on a bundle directory, the assertion below would pass for
    // a reason that has nothing to do with the guard under test.
    assert.doesNotThrow(
      () => fs.accessSync(appDir, fs.constants.X_OK),
      "premise: a .app bundle directory is executable (searchable)"
    );

    _setKnownBinaryLocationsForResolverTest({ claude: [appDir] });
    pinEmptyShellPath("iss7203-appdir-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "fallback");
    assert.equal(result.path, "claude");
  });

  test("the sync resolver rejects the same `.app` directory", () => {
    const { appDirFor } = makeBundleHome([BUNDLED_VERSION]);
    _setKnownBinaryLocationsForResolverTest({
      claude: [appDirFor(BUNDLED_VERSION)],
    });
    pinEmptyShellPath("iss7203-appdir-sync-");

    const result = resolveBinaryFromLoginShellSync("claude");
    assert.equal(result.source, "fallback");
    assert.equal(result.path, "claude");
  });

  test("a directory named `claude` ON PATH must NOT resolve either", async () => {
    // The PATH tier outranks the known-location tier, so guarding only the
    // latter would leave the higher-precedence door open.
    const pathDir = makeTempDir("iss7203-path-dir-");
    fs.mkdirSync(path.join(pathDir, "claude"));
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    process.env.PATH = pathDir;
    setShellPathForTest();

    assert.deepEqual(await resolveExecutablesOnPath("claude", pathDir), []);
    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "fallback");
    assert.equal(result.path, "claude");
  });

  test("the sync PATH scan rejects that same directory", () => {
    const pathDir = makeTempDir("iss7203-path-dir-sync-");
    fs.mkdirSync(path.join(pathDir, "claude"));
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    process.env.PATH = pathDir;
    setShellPathForTest();

    assert.deepEqual(resolveExecutablesOnPathSync("claude", pathDir), []);
    assert.equal(resolveBinaryFromLoginShellSync("claude").source, "fallback");
  });

  test("a directory earlier in the list does not shadow a real binary after it", async () => {
    const { appDirFor, binaryFor } = makeBundleHome([BUNDLED_VERSION]);
    _setKnownBinaryLocationsForResolverTest({
      claude: [appDirFor(BUNDLED_VERSION), binaryFor(BUNDLED_VERSION)],
    });
    pinEmptyShellPath("iss7203-appdir-then-file-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "known_location");
    assert.equal(result.path, binaryFor(BUNDLED_VERSION));
  });
});

// ---------------------------------------------------------------------------
// The bundled binary resolves
// ---------------------------------------------------------------------------

describe("Claude Desktop bundle tier (ISS-7203)", () => {
  test("resolves the bundled executable when claude is nowhere else", async () => {
    const { home, binaryFor } = makeBundleHome([BUNDLED_VERSION]);
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinDarwinHome(home);
    pinEmptyShellPath("iss7203-bundle-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "known_location");
    assert.equal(result.path, binaryFor(BUNDLED_VERSION));
  });

  test("the sync resolver finds the bundled executable too", () => {
    const { home, binaryFor } = makeBundleHome([BUNDLED_VERSION]);
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinDarwinHome(home);
    pinEmptyShellPath("iss7203-bundle-sync-");

    const result = resolveBinaryFromLoginShellSync("claude");
    assert.equal(result.source, "known_location");
    assert.equal(result.path, binaryFor(BUNDLED_VERSION));
  });

  test("with several versions installed, the newest wins numerically", async () => {
    // "2.1.9" sorts after "2.1.219" as a string; the rule is version order.
    const { home, binaryFor } = makeBundleHome(["2.0.300", "2.1.9", "2.1.219"]);
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinDarwinHome(home);
    pinEmptyShellPath("iss7203-multi-version-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.path, binaryFor("2.1.219"));
  });

  test("an older version still serves when the newest has no executable", async () => {
    const { home, root, binaryFor } = makeBundleHome(["2.1.219"]);
    fs.mkdirSync(path.join(root, "2.2.0"), { recursive: true });
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinDarwinHome(home);
    pinEmptyShellPath("iss7203-partial-version-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "known_location");
    assert.equal(result.path, binaryFor("2.1.219"));
  });

  test("a PATH install still wins over the Claude Desktop copy", async () => {
    const { home } = makeBundleHome([BUNDLED_VERSION]);
    const pathDir = makeTempDir("iss7203-path-wins-");
    const onPath = path.join(pathDir, "claude");
    fs.writeFileSync(onPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinDarwinHome(home);
    process.env.PATH = pathDir;
    setShellPathForTest();

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "path");
    assert.equal(result.path, onPath);
  });

  test("a static known location still wins over the Claude Desktop copy", async () => {
    const { home } = makeBundleHome([BUNDLED_VERSION]);
    const knownDir = makeTempDir("iss7203-static-wins-");
    const knownBin = path.join(knownDir, "claude");
    fs.writeFileSync(knownBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    _setKnownBinaryLocationsForResolverTest({ claude: [knownBin] });
    pinDarwinHome(home);
    pinEmptyShellPath("iss7203-static-wins-path-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.path, knownBin);
  });

  test("an absent Claude Desktop install still resolves to `fallback`", async () => {
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinDarwinHome(makeTempDir("iss7203-absent-home-"));
    pinEmptyShellPath("iss7203-absent-path-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "fallback");
    assert.equal(result.path, "claude");
  });

  test("the SAME populated home resolves on darwin but not on linux", async () => {
    // The negative control for the platform gate. Both halves run against one
    // identical bundle, so the `linux` miss can only come from the scope-out —
    // not from a home that happened to be empty.
    const { home, binaryFor } = makeBundleHome([BUNDLED_VERSION]);
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinEmptyShellPath("iss7203-platform-gate-");

    pinDarwinHome(home);
    const onDarwin = await resolveBinaryFromLoginShell("claude");
    assert.equal(onDarwin.source, "known_location");
    assert.equal(onDarwin.path, binaryFor(BUNDLED_VERSION));

    resetShellPathCache();
    setShellPathForTest();
    _setClaudeDesktopHostForTest({ platform: "linux", homeDir: home });
    const onLinux = await resolveBinaryFromLoginShell("claude");
    assert.equal(onLinux.source, "fallback");
    assert.equal(onLinux.path, "claude");
  });

  test("a pinned static list keeps the real host's bundle out", async () => {
    // Without a host injection the probe must stay off entirely, so a machine
    // that really does have Claude Desktop cannot turn an asserted `fallback`
    // into a `known_location` on that one box.
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    pinEmptyShellPath("iss7203-no-host-leak-");

    const result = await resolveBinaryFromLoginShell("claude");
    assert.equal(result.source, "fallback");
    assert.equal(result.path, "claude");
  });

  test("only claude gets the bundle tier — other binaries are untouched", async () => {
    const { home } = makeBundleHome([BUNDLED_VERSION]);
    _setKnownBinaryLocationsForResolverTest({ codex: [] });
    pinDarwinHome(home);
    pinEmptyShellPath("iss7203-other-binary-");

    const result = await resolveBinaryFromLoginShell("codex");
    assert.equal(result.source, "fallback");
  });
});

// ---------------------------------------------------------------------------
// Platform scope-out and discovery unit behavior
// ---------------------------------------------------------------------------

describe("claudeDesktopBundleRoot platform scoping (ISS-7203)", () => {
  test("macOS gets the Application Support path", () => {
    assert.equal(
      claudeDesktopBundleRoot("darwin", "/home/tester"),
      path.join(
        "/home/tester",
        "Library",
        "Application Support",
        "Claude",
        "claude-code"
      )
    );
  });

  test("Windows and Linux are explicitly out of scope, not guessed at", () => {
    assert.equal(claudeDesktopBundleRoot("win32", "/home/tester"), null);
    assert.equal(claudeDesktopBundleRoot("linux", "/home/tester"), null);
  });

  test("discovery of an unreadable root yields no candidates", () => {
    const missing = path.join(makeTempDir("iss7203-unreadable-"), "nope");
    assert.deepEqual(discoverBundledClaudeBinaries(missing), []);
  });

  test("discovery skips plain files sitting beside the version directories", () => {
    const { root, binaryFor } = makeBundleHome([BUNDLED_VERSION]);
    fs.writeFileSync(path.join(root, ".verified"), "{}");

    assert.deepEqual(discoverBundledClaudeBinaries(root), [
      binaryFor(BUNDLED_VERSION),
    ]);
  });
});
