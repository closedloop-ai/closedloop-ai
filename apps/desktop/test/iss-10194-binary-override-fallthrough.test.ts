/**
 * ISS-10194 — the desktop suite must not silently run the REAL git.
 *
 * Three independent ways a fake `git` stopped being the one that ran, each
 * measured on `main` on 2026-09-16 before this file existed. The first two made
 * a unit suite reach `https://github.com/...`; the third is the guard that
 * catches any fourth way nobody has found yet.
 *
 * 1. An explicitly-configured override that cannot be executed degraded to the
 *    host git with no signal (`getResolvedGitPath`). Probed: override
 *    `/bin/false` (absent on macOS) → `/usr/bin/git`.
 * 2. `GatewayRouter`'s constructor cleared a previously-configured resolver when
 *    the caller passed no `getBinaryPaths`. Probed: `{"git":…}` → `null`, then
 *    `cloneRepoViaGit` returned `remote: Repository not found.` — a github.com
 *    RESPONSE — in 521ms.
 * 3. `GIT_ALLOW_PROTOCOL=file` now rides in `HERMETIC_GIT_ENV`, so a git that
 *    escaped its fake by any route is refused locally before DNS.
 *
 * Every case here drives the production decision and asserts on its outcome;
 * none asserts that a guard merely exists.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  DESKTOP_TEST_STRICT_ENV,
  hermeticGitEnv,
} from "../scripts/hermetic-git-env.mjs";
import {
  configureBinaryPathsResolver,
  getResolvedGitPath,
  getResolvedGitPathAsync,
  STRICT_BINARY_OVERRIDES_ENV_VAR,
} from "../src/server/operations/binary-path-overrides.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  resolveBinaryFromLoginShellSync,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

/** An absolute path that cannot exist, so the override is unusable on any host. */
const UNUSABLE_OVERRIDE = path.join(os.tmpdir(), "iss-10194-no-such-git");
const STRICT_KEYS = Object.keys(DESKTOP_TEST_STRICT_ENV);
const OVERRIDE_NAMED_PATTERN = new RegExp(UNUSABLE_OVERRIDE);
const ENV_VAR_NAMED_PATTERN = new RegExp(STRICT_BINARY_OVERRIDES_ENV_VAR);
const HTTPS_REFUSED_PATTERN = /transport 'https' not allowed/;
const NOT_FOUND_PATTERN = /[Rr]epository not found/;

const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remember a var's exact prior state so `afterEach` can restore absence as absence. */
function stashEnv(key: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
}

function setEnv(key: string, value: string): void {
  stashEnv(key);
  process.env[key] = value;
}

function unsetEnv(key: string): void {
  stashEnv(key);
  Reflect.deleteProperty(process.env, key);
}

/**
 * Leave the process holding ONLY what the runner's own object declares.
 *
 * Clearing the name the source reads first is the load-bearing half: this suite
 * runs inside a lane that already exports that var, so applying the object on
 * top of it would satisfy the assertion whatever the object is called, and a key
 * renamed in `hermetic-git-env.mjs` alone would go green. Verified by mutation:
 * renaming it there must redden the two cases below.
 */
function applyStrictEnv(): void {
  unsetEnv(STRICT_BINARY_OVERRIDES_ENV_VAR);
  for (const [key, value] of Object.entries(DESKTOP_TEST_STRICT_ENV)) {
    setEnv(key, value);
  }
}

function clearStrictEnv(): void {
  unsetEnv(STRICT_BINARY_OVERRIDES_ENV_VAR);
  for (const key of STRICT_KEYS) {
    unsetEnv(key);
  }
}

/**
 * A git child env whose ONLY source of `GIT_ALLOW_PROTOCOL` is
 * `HERMETIC_GIT_ENV`.
 *
 * `hermeticGitEnv()` layers onto `process.env` by default, and this lane's own
 * process already carries the allowlist, so the bare call would keep the cases
 * below green even with the key deleted from the module they exist to pin.
 */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return hermeticGitEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
  });
}

function writeFakeGit(dir: string): string {
  const gitPath = path.join(dir, "git");
  mkdirSync(dir, { recursive: true });
  writeFileSync(gitPath, ["#!/bin/sh", "exit 0"].join("\n"), {
    mode: 0o755,
  });
  return gitPath;
}

function makeFakeGitFixture(prefix: string): {
  root: string;
  sandboxDir: string;
  fakeGit: string;
} {
  const root = makeTempDir(prefix);
  const sandboxDir = path.join(root, "sandbox");
  mkdirSync(sandboxDir, { recursive: true });
  return {
    root,
    sandboxDir,
    fakeGit: writeFakeGit(path.join(root, "fake-bin")),
  };
}

function makeServer(
  root: string,
  sandboxDir: string,
  getBinaryPaths?: () => { git: string }
): DesktopGatewayServer {
  return new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [sandboxDir],
    machineName: "iss-10194",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(root, "electron-port"),
    getSymphonyDir: () => root,
    getGatewayId: () => "iss-10194",
    getBinaryPaths,
  });
}

afterEach(() => {
  configureBinaryPathsResolver(null);
  resetShellPathCache();
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ISS-10194 case 1: an unusable override must not degrade to the host git", () => {
  test("getResolvedGitPath throws under the runner's strict env, naming the override", () => {
    applyStrictEnv();
    configureBinaryPathsResolver(() => ({ git: UNUSABLE_OVERRIDE }));

    assert.throws(
      () => getResolvedGitPath(),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, OVERRIDE_NAMED_PATTERN);
        assert.match(message, ENV_VAR_NAMED_PATTERN);
        return true;
      }
    );
  });

  test("getResolvedGitPathAsync throws the same way", async () => {
    applyStrictEnv();
    configureBinaryPathsResolver(() => ({ git: UNUSABLE_OVERRIDE }));

    await assert.rejects(getResolvedGitPathAsync(), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, OVERRIDE_NAMED_PATTERN);
      return true;
    });
  });

  test("with the strict var unset the production fallback still resolves a working git", () => {
    // The fallback is deliberate: a user whose configured path went stale must
    // still get a working git rather than a dead app. Strictness is gated, the
    // fallback is not removed.
    clearStrictEnv();
    configureBinaryPathsResolver(() => ({ git: UNUSABLE_OVERRIDE }));

    const resolved = getResolvedGitPath();

    assert.notEqual(resolved, UNUSABLE_OVERRIDE);
    assert.equal(
      execFileSync(resolved, ["--version"], { encoding: "utf8" }).startsWith(
        "git version"
      ),
      true
    );
  });
});

describe("ISS-10194 case 2: a resolver set before gateway construction is cleared by it", () => {
  test("a server built WITHOUT getBinaryPaths clears it, so the fake is no longer the git that resolves", () => {
    clearStrictEnv();
    const { sandboxDir, fakeGit, root } =
      makeFakeGitFixture("iss10194-cleared-");
    configureBinaryPathsResolver(() => ({ git: fakeGit }));
    assert.equal(getResolvedGitPath(), fakeGit);

    // The documented order, violated on purpose: the constructor runs
    // `configureBinaryPathsResolver(options.getBinaryPaths ?? null)`, so a
    // resolver installed BEFORE it is gone afterwards. What ISS-10194 fixes is
    // the SILENCE, not the reset.
    assert.ok(makeServer(root, sandboxDir));

    assert.notEqual(getResolvedGitPath(), fakeGit);
  });

  test("installing the fake VIA getBinaryPaths is the order that works", () => {
    clearStrictEnv();
    const { sandboxDir, fakeGit, root } = makeFakeGitFixture("iss10194-adopt-");

    assert.ok(makeServer(root, sandboxDir, () => ({ git: fakeGit })));

    assert.equal(getResolvedGitPath(), fakeGit);
  });
});

describe("ISS-10194 case 3: the suite's git env refuses the network", () => {
  test("a real git clone of an https github.com url is refused locally", () => {
    const root = makeTempDir("iss10194-net-");
    const dest = path.join(root, "never-created");
    setShellPathForTest();
    const realGit = resolveBinaryFromLoginShellSync("git").path;

    let stderr = "";
    // Flagged, not `assert.fail`ed inside the try: the catch two lines down
    // would swallow the AssertionError, and an AssertionError carries no
    // `stderr`, so the failure would surface as a stderr-did-not-match diff
    // against the literal "AssertionError [ERR_ASSERTION]: …". That is exactly
    // the case this test exists for — the real git reached github.com and the
    // repo existed — and it is the one that must not report the least useful
    // message (tamsinb).
    let cloneSucceeded = false;
    try {
      execFileSync(
        realGit,
        [
          "clone",
          "--",
          "https://github.com/closedloop-ai/iss-10194-never-cloned.git",
          dest,
        ],
        {
          env: isolatedGitEnv(),
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      cloneSucceeded = true;
    } catch (err) {
      stderr = String((err as { stderr?: unknown }).stderr ?? err);
    }

    assert.equal(
      cloneSucceeded,
      false,
      "the clone SUCCEEDED -- git reached github.com, so GIT_ALLOW_PROTOCOL was not applied"
    );
    // `transport 'https' not allowed` is produced by git itself, before any DNS
    // or TCP — a network failure cannot print it, so this assertion cannot be
    // satisfied by the machine simply being offline. The failure it replaces
    // (`Repository not found`) is a github.com response, so it is asserted
    // absent rather than merely unmentioned.
    assert.match(stderr, HTTPS_REFUSED_PATTERN);
    assert.doesNotMatch(stderr, NOT_FOUND_PATTERN);
    assert.equal(existsSync(dest), false);
  });

  test("the same env still clones a local bare remote", () => {
    const root = makeTempDir("iss10194-file-");
    const origin = path.join(root, "origin.git");
    const dest = path.join(root, "clone");
    const options = { env: isolatedGitEnv(), encoding: "utf8" as const };
    setShellPathForTest();
    const realGit = resolveBinaryFromLoginShellSync("git").path;

    execFileSync(realGit, ["init", "--quiet", "--bare", origin], options);
    execFileSync(realGit, ["clone", "--quiet", "--", origin, dest], options);

    // The positive control: without it, blanking the allowlist entirely would
    // pass the case above while breaking every fixture in the suite.
    assert.equal(existsSync(path.join(dest, ".git")), true);
  });
});
