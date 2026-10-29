import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  abbreviateHomePath,
  checkPathReadable,
  checkPathReadableAsync,
  classifyAccessError,
  type PathReadability,
  probeFileAccessBlocks,
} from "../src/main/collectors/engine/file-access-probe.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-access-probe-"));
  tempDirs.push(dir);
  return dir;
}

describe("classifyAccessError", () => {
  test("EACCES and EPERM (incl. macOS TCC) are blocks", () => {
    assert.equal(classifyAccessError({ code: "EACCES" }), "blocked");
    assert.equal(classifyAccessError({ code: "EPERM" }), "blocked");
  });

  test("ENOENT is absent, not a block — the harness just isn't installed", () => {
    assert.equal(classifyAccessError({ code: "ENOENT" }), "absent");
  });

  test("any other / non-error stays unknown so we never over-report a block", () => {
    assert.equal(classifyAccessError({ code: "EIO" }), "unknown");
    assert.equal(classifyAccessError(new Error("no code")), "unknown");
    assert.equal(classifyAccessError("nope"), "unknown");
    assert.equal(classifyAccessError(null), "unknown");
  });
});

describe("checkPathReadable", () => {
  test("a readable directory is readable", () => {
    assert.equal(checkPathReadable(makeTempDir()), "readable");
  });

  test("a nonexistent path is absent, not blocked", () => {
    const missing = path.join(makeTempDir(), "does-not-exist");
    assert.equal(checkPathReadable(missing), "absent");
  });

  // Exercise a real permission-denied directory (not just the injected fake
  // checker) so the probe is proven against the syscall it actually issues.
  // Skipped where it can't be simulated: root bypasses mode bits, and Windows
  // has no POSIX chmod semantics.
  const cannotDenyRead = process.getuid === undefined || process.getuid() === 0;
  test("a permission-denied directory is blocked", {
    skip: cannotDenyRead,
  }, () => {
    const denied = makeTempDir();
    fs.chmodSync(denied, 0o000);
    try {
      assert.equal(checkPathReadable(denied), "blocked");
    } finally {
      // Restore read/exec so the afterEach recursive cleanup can traverse it.
      fs.chmodSync(denied, 0o700);
    }
  });
});

// ISS-12521 made this the main-thread probe for a user-picked path, where
// `opendirSync` against a stalled network volume would freeze the app
// (marisolashgrove, PR #8917). Same verdicts, so the sync suite's cases are
// mirrored here against the real syscall rather than restated in prose.
describe("checkPathReadableAsync", () => {
  test("a readable directory is readable", async () => {
    assert.equal(await checkPathReadableAsync(makeTempDir()), "readable");
  });

  test("a nonexistent path is absent, not blocked", async () => {
    const missing = path.join(makeTempDir(), "does-not-exist");
    assert.equal(await checkPathReadableAsync(missing), "absent");
  });

  // A regular file is the `ENOTDIR` case: not nameable as a denial, so it is
  // `unknown`, which ISS-12521's handler treats as unreadable.
  test("a regular file is unknown, not readable", async () => {
    const file = path.join(makeTempDir(), "transcript.jsonl");
    fs.writeFileSync(file, "{}");
    assert.equal(await checkPathReadableAsync(file), "unknown");
  });

  const cannotDenyReadAsync =
    process.getuid === undefined || process.getuid() === 0;
  test("a permission-denied directory is blocked", {
    skip: cannotDenyReadAsync,
  }, async () => {
    const denied = makeTempDir();
    fs.chmodSync(denied, 0o000);
    try {
      assert.equal(await checkPathReadableAsync(denied), "blocked");
    } finally {
      fs.chmodSync(denied, 0o700);
    }
  });
});

describe("abbreviateHomePath", () => {
  const home = os.homedir();

  test("a descendant of home is abbreviated", () => {
    assert.equal(
      abbreviateHomePath(path.join(home, "code", "orbit-api")),
      path.join("~", "code", "orbit-api")
    );
  });

  test("home itself is ~", () => {
    assert.equal(abbreviateHomePath(home), "~");
  });

  // tamsinb, PR #8917: a bare `startsWith(home)` turned `/Users/bobby/code`
  // into `~by/code` for home `/Users/bob`. The picker hands this any folder
  // the user chooses, so a sibling whose name merely starts with the home
  // basename must stay absolute.
  test("a sibling whose name merely starts with home's is not abbreviated", () => {
    const sibling = `${home}by${path.sep}code`;
    assert.equal(abbreviateHomePath(sibling), sibling);
  });

  test("a path outside home is returned unchanged", () => {
    assert.equal(abbreviateHomePath("/opt/orbit/ledger"), "/opt/orbit/ledger");
  });
});

describe("probeFileAccessBlocks", () => {
  const home = os.homedir();
  const codexRoot = path.join(home, ".codex", "sessions");
  const claudeRoot = path.join(home, ".claude", "projects");

  const fakeChecker =
    (verdicts: Record<string, PathReadability>) =>
    (root: string): PathReadability =>
      verdicts[root] ?? "readable";

  test("reports one home-abbreviated block per harness with an unreadable root", () => {
    const blocks = probeFileAccessBlocks(
      [{ harness: "codex", roots: [codexRoot] }],
      fakeChecker({ [codexRoot]: "blocked" })
    );
    assert.deepEqual(blocks, [{ harness: "codex", path: "~/.codex/sessions" }]);
  });

  test("readable and absent roots are not blocks", () => {
    const blocks = probeFileAccessBlocks(
      [
        { harness: "codex", roots: [codexRoot] },
        { harness: "claude", roots: [claudeRoot] },
      ],
      fakeChecker({ [codexRoot]: "readable", [claudeRoot]: "absent" })
    );
    assert.deepEqual(blocks, []);
  });

  test("a harness is reported once (its first blocked root), not per subdir", () => {
    const archived = path.join(home, ".codex", "archived_sessions");
    const blocks = probeFileAccessBlocks(
      [{ harness: "codex", roots: [codexRoot, archived] }],
      fakeChecker({ [codexRoot]: "blocked", [archived]: "blocked" })
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.path, "~/.codex/sessions");
  });

  test("only blocked harnesses are reported across a mixed set", () => {
    const blocks = probeFileAccessBlocks(
      [
        { harness: "claude", roots: [claudeRoot] },
        { harness: "codex", roots: [codexRoot] },
      ],
      fakeChecker({ [claudeRoot]: "readable", [codexRoot]: "blocked" })
    );
    assert.deepEqual(
      blocks.map((block) => block.harness),
      ["codex"]
    );
  });
});
