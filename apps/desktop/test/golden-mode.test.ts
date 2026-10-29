import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  GOLDEN_CORPUS_DIR_ENV_VAR,
  GOLDEN_MODE_ENV_VAR,
  GOLDEN_USER_DATA_DIR_ENV_VAR,
  type GoldenModeConfig,
  GoldenModeConfigError,
  goldenModeConfigErrors,
  pathsOverlap,
  resolveGoldenModeConfig,
} from "../src/main/settings/golden-mode.js";

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

/**
 * The canonical form the resolver reports back, derived from `node:fs` rather
 * than from `canonicalizePathForPolicy`, so an expectation cannot be satisfied
 * by re-running the production transform it is meant to pin. Every target here
 * either exists or has an existing parent, which is the nearest-ancestor rule
 * the resolver applies to a not-yet-created `userDataDir`.
 */
function canonical(target: string): string {
  if (fs.existsSync(target)) {
    return fs.realpathSync.native(target);
  }
  return path.join(
    fs.realpathSync.native(path.dirname(target)),
    path.basename(target)
  );
}

/**
 * The `GoldenModeConfigError` a call rejects with, so the test body owns the
 * assertion. Asserting only the error class lets any of the nine throw sites
 * satisfy any of these tests, so a guard that fires on the wrong branch still
 * reads green (ISS-7589) — the message is what names the branch.
 */
function rejectionOf(
  resolve: () => GoldenModeConfig | null
): GoldenModeConfigError {
  try {
    resolve();
  } catch (error) {
    if (error instanceof GoldenModeConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    "expected resolveGoldenModeConfig to reject, but it returned a config"
  );
}

/**
 * The `mkdir` failure text the resolver appends, captured from the same call it
 * makes so the expectation carries the platform's own errno wording instead of
 * a hardcoded one.
 */
function mkdirFailureReason(target: string): string {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    return error instanceof Error ? error.message : "unknown error";
  }
  throw new Error(`expected mkdir to fail for ${target}, but it succeeded`);
}

/** The exact config the resolver must report for these inputs. */
function expectedConfig(corpus: string, userData: string): GoldenModeConfig {
  return { corpusDir: canonical(corpus), userDataDir: canonical(userData) };
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
  assert.deepEqual(result, expectedConfig(corpus, ud));
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
  assert.deepEqual(result, expectedConfig(corpus, ud));
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
  assert.deepEqual(result, expectedConfig(corpus, ud));
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
  assert.deepEqual(result, expectedConfig(corpus, ud));
});

// --- Missing required env vars ---

test("rejects with the corpusDir-not-set message when CLOSEDLOOP_GOLDEN_CORPUS_DIR is missing", () => {
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        { [GOLDEN_MODE_ENV_VAR]: "1" },
        { realUserDataDir: "/unused" }
      )
    ).message,
    goldenModeConfigErrors.corpusDirNotSet()
  );
});

test("rejects with the userDataDir-not-set message when CLOSEDLOOP_GOLDEN_USER_DATA_DIR is missing", () => {
  const corpus = makeCorpusDir();
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
        },
        { realUserDataDir: "/unused" }
      )
    ).message,
    goldenModeConfigErrors.userDataDirNotSet()
  );
});

// --- corpusDir validation ---

test("rejects with the corpusDir-missing message when corpusDir does not exist", () => {
  const real = makeRealDir();
  const ud = freshUdPath();
  const missingCorpus = path.join(
    os.tmpdir(),
    `gm-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: missingCorpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.corpusDirMissing(canonical(missingCorpus))
  );
});

test("rejects with the not-a-directory message when corpusDir is a file", () => {
  const corpusFile = path.join(
    os.tmpdir(),
    `gm-file-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(corpusFile, "not a directory");
  const real = makeRealDir();
  const ud = freshUdPath();
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpusFile,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.corpusDirNotADirectory(canonical(corpusFile))
  );
});

test("rejects with the not-creatable message when userDataDir's parent is a file", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  const parentFile = path.join(
    os.tmpdir(),
    `gm-parent-file-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(parentFile, "not a directory");
  const ud = path.join(parentFile, "profile");
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirNotCreatable(
      canonical(ud),
      mkdirFailureReason(canonical(ud))
    )
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
  assert.deepEqual(result, expectedConfig(corpus, ud));
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
  const result = resolveGoldenModeConfig(
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
  assert.deepEqual(result, expectedConfig(corpus, ud));
});

test("creates userDataDir recursively when intermediate parents are missing", () => {
  const corpus = makeCorpusDir();
  // Two missing segments below an existing root, so the resolver only succeeds
  // if it passes `recursive`. A plain `mkdirSync(userDataDir)` throws ENOENT
  // here and the call rejects with `userDataDirNotCreatable` instead.
  const udRoot = freshUdPath();
  const udParent = path.join(udRoot, "level-a");
  const ud = path.join(udParent, "level-b");
  const real = makeRealDir();
  assert.ok(
    !fs.existsSync(udRoot),
    "precondition: no part of the userDataDir chain may exist before the call"
  );
  const result = resolveGoldenModeConfig(
    {
      [GOLDEN_MODE_ENV_VAR]: "1",
      [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
      [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
    },
    { realUserDataDir: real }
  );
  assert.ok(
    fs.statSync(udParent).isDirectory(),
    "the missing intermediate parent must have been created by the call"
  );
  assert.ok(
    fs.statSync(ud).isDirectory(),
    "userDataDir must have been created by the call"
  );
  assert.deepEqual(result, expectedConfig(corpus, ud));
});

// --- Path overlap guards: userDataDir vs realUserDataDir ---

test("rejects with the real-profile overlap message when userDataDir equals realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: real,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsRealProfile(
      canonical(real),
      canonical(real)
    )
  );
});

test("rejects with the real-profile overlap message when userDataDir is inside realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  const innerUd = path.join(real, "golden-ud");
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: innerUd,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsRealProfile(
      canonical(innerUd),
      canonical(real)
    )
  );
});

test("rejects with the real-profile overlap message when realUserDataDir is inside userDataDir", () => {
  const corpus = makeCorpusDir();
  const outerUd = fs.mkdtempSync(path.join(os.tmpdir(), "gm-outer-"));
  const innerReal = path.join(outerUd, "real-profile");
  fs.mkdirSync(innerReal);
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: outerUd,
        },
        { realUserDataDir: innerReal }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsRealProfile(
      canonical(outerUd),
      canonical(innerReal)
    )
  );
});

test("rejects with the real-profile overlap message when userDataDir is a symlink that resolves to realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  const symlinkPath = path.join(
    os.tmpdir(),
    `gm-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  // Symlink at symlinkPath → real directory; canonicalizePathForPolicy follows it
  // via realpathSync.native and returns realDir, matching realUserDataDir.
  fs.symlinkSync(real, symlinkPath);
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: symlinkPath,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsRealProfile(
      canonical(symlinkPath),
      canonical(real)
    )
  );
});

test("rejects with the real-profile overlap message when a not-yet-created userDataDir sits under a symlinked ancestor resolving into realUserDataDir", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  const symlinkedParent = path.join(
    os.tmpdir(),
    `gm-symlink-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.symlinkSync(real, symlinkedParent);
  // The leaf does not exist, so the overlap guard can only see through the
  // symlink via the nearest-existing-ancestor realpath the resolver documents.
  // Canonicalizing a missing path to itself instead would leave this outside
  // `real`, report no overlap, and then create a directory inside the real
  // profile — the exact harm the guard exists to prevent.
  const ud = path.join(symlinkedParent, "profile");
  assert.ok(!fs.existsSync(ud), "precondition: ud must not exist before call");
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: ud,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsRealProfile(
      canonical(ud),
      canonical(real)
    )
  );
  assert.ok(
    !fs.existsSync(ud),
    "the rejected userDataDir must not have been created inside the real profile"
  );
});

// --- Path overlap guards: userDataDir vs corpusDir ---

test("rejects with the corpus overlap message when userDataDir equals corpusDir", () => {
  const real = makeRealDir();
  const shared = makeCorpusDir();
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: shared,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: shared,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsCorpus(
      canonical(shared),
      canonical(shared)
    )
  );
});

test("rejects with the corpus overlap message when userDataDir is inside corpusDir", () => {
  const real = makeRealDir();
  const corpus = makeCorpusDir();
  const innerUd = path.join(corpus, "ud-inside-corpus");
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: innerUd,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsCorpus(
      canonical(innerUd),
      canonical(corpus)
    )
  );
});

test("rejects with the corpus overlap message when corpusDir is inside userDataDir", () => {
  const real = makeRealDir();
  const outerUd = fs.mkdtempSync(path.join(os.tmpdir(), "gm-outer-"));
  const innerCorpus = path.join(outerUd, "corpus-inside-ud");
  fs.mkdirSync(innerCorpus);
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: innerCorpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: outerUd,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirOverlapsCorpus(
      canonical(outerUd),
      canonical(innerCorpus)
    )
  );
});

// --- Relative path forms (rejected — absolute-path contract) ---

test("relative userDataDir is rejected with the userDataDir-not-absolute message", () => {
  const corpus = makeCorpusDir();
  const real = makeRealDir();
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: corpus,
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: "some/relative/profile",
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.userDataDirNotAbsolute("some/relative/profile")
  );
});

test("relative corpusDir is rejected with the corpusDir-not-absolute message", () => {
  const real = makeRealDir();
  const userData = freshUdPath();
  assert.equal(
    rejectionOf(() =>
      resolveGoldenModeConfig(
        {
          [GOLDEN_MODE_ENV_VAR]: "1",
          [GOLDEN_CORPUS_DIR_ENV_VAR]: "packages/golden-sessions",
          [GOLDEN_USER_DATA_DIR_ENV_VAR]: userData,
        },
        { realUserDataDir: real }
      )
    ).message,
    goldenModeConfigErrors.corpusDirNotAbsolute("packages/golden-sessions")
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
