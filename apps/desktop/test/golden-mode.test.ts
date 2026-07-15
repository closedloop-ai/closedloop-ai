import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GOLDEN_CORPUS_DIR_ENV_VAR,
  GOLDEN_MODE_ENV_VAR,
  GOLDEN_USER_DATA_DIR_ENV_VAR,
  GoldenModeConfigError,
  pathsOverlap,
  resolveGoldenModeConfig,
} from "../src/main/golden-mode.js";

// --- Helpers ---

function makeCorpusDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gm-corpus-"));
}

function makeRealDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gm-real-"));
}

/** Returns a path that does not yet exist; the function under test creates it. */
function freshUdPath(): string {
  return path.join(
    os.tmpdir(),
    `gm-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

// --- CLOSEDLOOP_GOLDEN_MODE falsy values → null ---

test("returns null when CLOSEDLOOP_GOLDEN_MODE is unset", () => {
  assert.equal(
    resolveGoldenModeConfig({}, { realUserDataDir: "/unused" }),
    null
  );
});

test("returns null when CLOSEDLOOP_GOLDEN_MODE is empty string", () => {
  assert.equal(
    resolveGoldenModeConfig(
      { [GOLDEN_MODE_ENV_VAR]: "" },
      { realUserDataDir: "/unused" }
    ),
    null
  );
});

test("returns null when CLOSEDLOOP_GOLDEN_MODE is '0'", () => {
  assert.equal(
    resolveGoldenModeConfig(
      { [GOLDEN_MODE_ENV_VAR]: "0" },
      { realUserDataDir: "/unused" }
    ),
    null
  );
});

test("returns null when CLOSEDLOOP_GOLDEN_MODE is 'false'", () => {
  assert.equal(
    resolveGoldenModeConfig(
      { [GOLDEN_MODE_ENV_VAR]: "false" },
      { realUserDataDir: "/unused" }
    ),
    null
  );
});

test("returns null when CLOSEDLOOP_GOLDEN_MODE is 'no'", () => {
  assert.equal(
    resolveGoldenModeConfig(
      { [GOLDEN_MODE_ENV_VAR]: "no" },
      { realUserDataDir: "/unused" }
    ),
    null
  );
});

// --- Enable value forms ---

test("resolves when CLOSEDLOOP_GOLDEN_MODE is '1' with valid paths", () => {
  const corpus = makeCorpusDir();
  const ud = freshUdPath();
  const real = makeRealDir();
  const result = resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: "1",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(result !== null);
});

test("resolves when CLOSEDLOOP_GOLDEN_MODE is 'true'", () => {
  const corpus = makeCorpusDir();
  const ud = freshUdPath();
  const real = makeRealDir();
  const result = resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: "true",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(result !== null);
});

test("resolves when CLOSEDLOOP_GOLDEN_MODE is 'yes'", () => {
  const corpus = makeCorpusDir();
  const ud = freshUdPath();
  const real = makeRealDir();
  const result = resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: "yes",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(result !== null);
});

test("resolves when CLOSEDLOOP_GOLDEN_MODE is ' TRUE ' (trimmed, case-insensitive)", () => {
  const corpus = makeCorpusDir();
  const ud = freshUdPath();
  const real = makeRealDir();
  const result = resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: " TRUE ",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(result !== null);
});

// --- Missing required env vars ---

test("throws GoldenModeConfigError when CLOSEDLOOP_GOLDEN_CORPUS_DIR is missing", () => {
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        { [GOLDEN_MODE_ENV_VAR]: "1" },
        { realUserDataDir: "/unused" }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when CLOSEDLOOP_GOLDEN_USER_DATA_DIR is missing", () => {
  const corpus = makeCorpusDir();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
        },
        { realUserDataDir: "/unused" }
      ),
    GoldenModeConfigError
  );
});

// --- corpusDir validation ---

test("throws GoldenModeConfigError when corpusDir does not exist", () => {
  const real = makeRealDir();
  const ud = freshUdPath();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: path.join(
            os.tmpdir(),
            `gm-nonexistent-${Date.now()}`
          ),
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when corpusDir is a file, not a directory", () => {
  const corpusFile = path.join(os.tmpdir(), `gm-file-${Date.now()}`);
  fs.writeFileSync(corpusFile, "not a directory");
  const real = makeRealDir();
  const ud = freshUdPath();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpusFile,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

// --- Valid case ---

test("returns canonicalized absolute corpusDir and userDataDir on valid input", () => {
  const corpus = makeCorpusDir();
  const ud = freshUdPath();
  const real = makeRealDir();
  const result = resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: "1",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(result !== null);
  assert.ok(path.isAbsolute(result.corpusDir), "corpusDir must be absolute");
  assert.ok(
    path.isAbsolute(result.userDataDir),
    "userDataDir must be absolute"
  );
  assert.ok(
    fs.statSync(result.corpusDir).isDirectory(),
    "corpusDir must exist as a directory"
  );
  assert.ok(
    fs.statSync(result.userDataDir).isDirectory(),
    "userDataDir must exist as a directory"
  );
});

test("creates userDataDir when it does not exist before the call", () => {
  const corpus = makeCorpusDir();
  const ud = freshUdPath();
  const real = makeRealDir();
  assert.ok(!fs.existsSync(ud), "precondition: ud must not exist before call");
  resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: "1",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(
    fs.existsSync(ud) && fs.statSync(ud).isDirectory(),
    "userDataDir must have been created by the call"
  );
});

// --- Path overlap guards: userDataDir vs realUserDataDir ---

test("throws GoldenModeConfigError when userDataDir equals realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: real,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when userDataDir is inside realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  const innerUd = path.join(real, "golden-ud");
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: innerUd,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when realUserDataDir is inside userDataDir", () => {
  const corpus = makeCorpusDir();
  const outerUd = fs.mkdtempSync(path.join(os.tmpdir(), "gm-outer-"));
  const innerReal = path.join(outerUd, "real-profile");
  fs.mkdirSync(innerReal);
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: outerUd,
        },
        { realUserDataDir: innerReal }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when userDataDir is a symlink that resolves to realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  const symlinkPath = path.join(
    os.tmpdir(),
    `gm-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  // Symlink at symlinkPath → real directory; canonicalizePathForPolicy follows it
  // via realpathSync.native and returns realDir, matching realUserDataDir.
  fs.symlinkSync(real, symlinkPath);
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: symlinkPath,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

// --- Path overlap guards: userDataDir vs corpusDir ---

test("throws GoldenModeConfigError when userDataDir equals corpusDir", () => {
  const real = makeRealDir();
  const shared = makeCorpusDir();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: shared,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: shared,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when userDataDir is inside corpusDir", () => {
  const real = makeRealDir();
  const corpus = makeCorpusDir();
  const innerUd = path.join(corpus, "ud-inside-corpus");
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: innerUd,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

test("throws GoldenModeConfigError when corpusDir is inside userDataDir", () => {
  const real = makeRealDir();
  const outerUd = fs.mkdtempSync(path.join(os.tmpdir(), "gm-outer-"));
  const innerCorpus = path.join(outerUd, "corpus-inside-ud");
  fs.mkdirSync(innerCorpus);
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: innerCorpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: outerUd,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

// --- Relative path forms (rejected — absolute-path contract) ---

test("relative userDataDir is rejected with GoldenModeConfigError", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: "some/relative/profile",
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

test("relative corpusDir is rejected with GoldenModeConfigError", () => {
  const real = makeRealDir();
  const userData = freshUdPath();
  assert.throws(
    () =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: "packages/golden-sessions",
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: userData,
        },
        { realUserDataDir: real }
      ),
    GoldenModeConfigError
  );
});

// --- pathsOverlap unit tests ---

test("pathsOverlap: equal paths → true", () => {
  assert.equal(pathsOverlap("/a/b/c", "/a/b/c"), true);
});

test("pathsOverlap: a is a child of b → true", () => {
  assert.equal(pathsOverlap("/a/b/c", "/a/b"), true);
});

test("pathsOverlap: b is a child of a → true", () => {
  assert.equal(pathsOverlap("/a/b", "/a/b/c"), true);
});

test("pathsOverlap: disjoint sibling directories → false", () => {
  assert.equal(pathsOverlap("/a/foo", "/a/bar"), false);
});

test("pathsOverlap: '/a/bc' vs '/a/b' — shared prefix without separator is not containment → false", () => {
  assert.equal(pathsOverlap("/a/bc", "/a/b"), false);
});
