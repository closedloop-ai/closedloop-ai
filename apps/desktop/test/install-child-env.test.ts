/**
 * @file install-child-env.test.ts
 * @description Focused coverage for the child-process execution context that
 * ISS-5138 extracted out of `install-orchestrator.ts`.
 *
 * These units were reachable only through `streamRun` before the split and had
 * no direct tests: the env allowlist is the security boundary that keeps
 * Closedloop tokens out of a catalog pack's install subprocess, and
 * `resolveSpawnCwd` is what stops a project-relative command running at the
 * filesystem root or in the app's launch directory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  buildAllowedChildEnv,
  looksProjectRelative,
  resolveSpawnCwd,
} from "../src/main/packs/install-child-env.js";

const tempDirs: string[] = [];
/** The single error code `resolveSpawnCwd` rejects with. */
const BAD_CWD = "EBADCWD";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildAllowedChildEnv", () => {
  test("passes allowlisted variables through and drops everything else", () => {
    const env = buildAllowedChildEnv({
      CLERK_SECRET_KEY: "sk_live_should_never_leak",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      NEXT_PUBLIC_POSTHOG_KEY: "phc_should_never_leak",
      PATH: "/usr/bin",
      TERM: "xterm",
    });

    assert.deepEqual(env, {
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin",
      TERM: "xterm",
    });
  });

  test("prefers an explicit PATH override over the parent PATH", () => {
    const env = buildAllowedChildEnv(
      { HOME: "/home/tester", PATH: "/inherited/bin" },
      null,
      "/resolved/shell/bin"
    );

    assert.equal(env.PATH, "/resolved/shell/bin");
  });

  test("falls back to the parent PATH when the override is empty", () => {
    const env = buildAllowedChildEnv(
      { HOME: "/home/tester", PATH: "/inherited/bin" },
      null,
      ""
    );

    assert.equal(env.PATH, "/inherited/bin");
  });

  test("substitutes the real home directory when the parent env has no HOME", () => {
    const env = buildAllowedChildEnv({ PATH: "/usr/bin" });

    assert.equal(env.HOME, os.homedir());
  });

  test("advertises the resolved cwd to the child as INIT_CWD and PWD", () => {
    const env = buildAllowedChildEnv(
      { HOME: "/home/tester", PATH: "/usr/bin" },
      "/projects/app"
    );

    assert.equal(env.INIT_CWD, "/projects/app");
    assert.equal(env.PWD, "/projects/app");
  });

  test("omits INIT_CWD and PWD when the run has no explicit cwd", () => {
    const env = buildAllowedChildEnv({
      HOME: "/home/tester",
      PATH: "/usr/bin",
    });

    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.PWD, undefined);
  });
});

describe("looksProjectRelative", () => {
  test("flags the unambiguous writes-to-cwd argument forms", () => {
    assert.equal(looksProjectRelative("npx create-thing --directory ."), true);
    assert.equal(looksProjectRelative("npx create-thing --directory=."), true);
    assert.equal(looksProjectRelative("make -C . install"), true);
  });

  test("also flags a relative subdirectory, which still needs a project cwd", () => {
    // `--directory ./packages/app` contains the `--directory .` hint. That is
    // the safe direction for this guard: a relative target is still resolved
    // against the process cwd, so the run must not start without one.
    assert.equal(
      looksProjectRelative("npx create-thing --directory ./packages/app"),
      true
    );
  });

  test("does not flag a command with no cwd-relative argument", () => {
    assert.equal(looksProjectRelative("brew install rtk"), false);
    assert.equal(
      looksProjectRelative("git clone repo ~/.claude/skills/pack"),
      false
    );
    assert.equal(
      looksProjectRelative("npx create-thing --directory /abs/path"),
      false
    );
  });
});

describe("resolveSpawnCwd", () => {
  test("treats an absent or blank request as 'no cwd'", () => {
    assert.equal(resolveSpawnCwd(undefined), null);
    assert.equal(resolveSpawnCwd(null), null);
    assert.equal(resolveSpawnCwd("   "), null);
  });

  test("resolves an existing absolute directory", () => {
    const dir = makeTempDir("install-child-env-cwd-");

    // Trimmed and normalized, but NOT symlink-resolved: `path.resolve`, not
    // `realpath`, is what the production path uses.
    assert.equal(resolveSpawnCwd(` ${dir} `), path.resolve(dir));
  });

  test("rejects a relative path", () => {
    assert.deepEqual(
      rejection(() => resolveSpawnCwd("./packages/app")),
      {
        code: BAD_CWD,
        message: "cwd must be an absolute path",
      }
    );
  });

  test("rejects a path that does not exist", () => {
    const dir = makeTempDir("install-child-env-missing-");
    const missing = path.join(dir, "nope");

    assert.deepEqual(
      rejection(() => resolveSpawnCwd(missing)),
      {
        code: BAD_CWD,
        message: `cwd does not exist: ${missing}`,
      }
    );
  });

  test("rejects a file", () => {
    const dir = makeTempDir("install-child-env-file-");
    const file = path.join(dir, "install.sh");
    fs.writeFileSync(file, "#!/bin/sh\n");

    assert.deepEqual(
      rejection(() => resolveSpawnCwd(file)),
      {
        code: BAD_CWD,
        message: `not a directory: ${file}`,
      }
    );
  });

  test("refuses to spawn at the filesystem root", () => {
    assert.deepEqual(
      rejection(() => resolveSpawnCwd("/")),
      {
        code: BAD_CWD,
        message: "refusing to spawn at filesystem root",
      }
    );
  });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * The `.code` and `.message` of whatever `fn` threw. Every `resolveSpawnCwd`
 * rejection is the `EBADCWD`-coded class, and each carries its own message —
 * pinning both stops a future edit from swapping one rejection's wording for
 * another's. A call that did NOT throw reports `"<no throw>"` so the assertion
 * fails rather than passing vacuously.
 */
function rejection(fn: () => unknown): {
  code: string | undefined;
  message: string;
} {
  try {
    fn();
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    return { code: err.code, message: err.message };
  }
  return { code: "<no throw>", message: "<no throw>" };
}
