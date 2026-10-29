/**
 * ISS-11596 characterization: the dev-mode (unpackaged) update commands keep
 * their observable behavior when their git resolutions (S16 `checkForDevUpdate`
 * before `fetch` and before `rev-parse`; S17 `applyDevUpdate` before `pull`;
 * numbered as in PLN-2165) move to `await getResolvedGitPathAsync()`. Every
 * assertion must pass UNCHANGED on `origin/main` and on the branch.
 *
 * `dev-update-commands.ts` imports `electron` at module scope, so it is loaded
 * through the recording Electron stub with a dynamic import.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { BUILD_COMMIT_HASH } from "../src/shared/build-info.js";
import {
  installFakePnpm,
  loggedCommands,
  writeDesktopManifest,
} from "./helpers/dev-update-repo-fixture.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  electronAppLifecycleCalls,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import {
  assertStrictBinaryOverrides,
  type RevocableBinary,
  revocableBinary,
  snapshotEnv,
  strictRefusalPattern,
} from "./helpers/git-path-resolution-fixtures.js";

const REMOTE_HASH: string = "0123456789abcdef0123456789abcdef01234567";

let tmpDir = "";
let electronMock: ElectronModuleMock;
const restoreEnv = snapshotEnv(["PATH"]);

beforeEach(async () => {
  tmpDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "iss11596-devupdate-"))
  );
  electronMock = registerElectronModuleMock();
  resetElectronModuleStub();
});

afterEach(async () => {
  configureBinaryPathsResolver(null);
  restoreEnv();
  electronMock.deregister();
  resetElectronModuleStub();
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

async function loadDevUpdateCommands() {
  return await import("../src/main/update/dev-update-commands.js");
}

/** Which git subcommand makes the override unusable after it runs. */
const RevokeAfter = {
  Never: "never",
  Fetch: "fetch",
} as const;
type RevokeAfter = (typeof RevokeAfter)[keyof typeof RevokeAfter];

/** A fake git that logs each argv line and answers `rev-parse` with a hash. */
function configureFakeGit(revokeAfter: RevokeAfter): {
  git: RevocableBinary;
  logFile: string;
} {
  const logFile = path.join(tmpDir, "git-argv.log");
  const revokeOnFetch =
    revokeAfter === RevokeAfter.Fetch
      ? 'if [ "$1" = fetch ]; then chmod 644 "$0"; fi'
      : ":";
  const git = revocableBinary(
    tmpDir,
    "git",
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      revokeOnFetch,
      `if [ "$1" = rev-parse ]; then printf '${REMOTE_HASH}\\n'; fi`,
      "exit 0",
      "",
    ].join("\n")
  );
  configureBinaryPathsResolver(() => ({ git: git.path }));
  return { git, logFile };
}

describe("S16: checkForDevUpdate", () => {
  test("a working override fetches, then reports the remote hash", async () => {
    const { logFile } = configureFakeGit(RevokeAfter.Never);
    const { checkForDevUpdate } = await loadDevUpdateCommands();

    const result = await checkForDevUpdate(tmpDir);

    assert.deepEqual(result, {
      updateAvailable: REMOTE_HASH !== BUILD_COMMIT_HASH,
      currentHash: BUILD_COMMIT_HASH,
      remoteHash: REMOTE_HASH,
    });
    assert.deepEqual(await loggedCommands(logFile), [
      "fetch origin main",
      "rev-parse origin/main",
    ]);
  });

  test("an unusable override rejects before any git runs", async () => {
    assertStrictBinaryOverrides();
    const { git, logFile } = configureFakeGit(RevokeAfter.Never);
    git.revoke();
    const { checkForDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(
      checkForDevUpdate(tmpDir),
      strictRefusalPattern(git.path)
    );
    assert.deepEqual(await loggedCommands(logFile), []);
  });

  test("an override made unusable after fetch rejects before rev-parse runs", async () => {
    assertStrictBinaryOverrides();
    const { git, logFile } = configureFakeGit(RevokeAfter.Fetch);
    const { checkForDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(
      checkForDevUpdate(tmpDir),
      strictRefusalPattern(git.path)
    );
    assert.deepEqual(await loggedCommands(logFile), ["fetch origin main"]);
  });
});

describe("S17: applyDevUpdate", () => {
  async function installBuildableCheckout(): Promise<string> {
    const entry = await writeDesktopManifest(tmpDir);
    return await installFakePnpm(tmpDir, { entry });
  }

  test("a working override pulls, rebuilds, then relaunches and exits", async () => {
    const { logFile } = configureFakeGit(RevokeAfter.Never);
    const pnpmLog = await installBuildableCheckout();
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await applyDevUpdate(tmpDir);

    assert.deepEqual(await loggedCommands(logFile), [
      "pull --rebase origin main",
    ]);
    assert.deepEqual(await loggedCommands(pnpmLog), ["-C apps/desktop build"]);
    assert.deepEqual(electronAppLifecycleCalls(), ["relaunch", "exit:0"]);
  });

  test("an unusable override rejects before pull, build, relaunch or exit", async () => {
    assertStrictBinaryOverrides();
    const { git, logFile } = configureFakeGit(RevokeAfter.Never);
    git.revoke();
    const pnpmLog = await installBuildableCheckout();
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(
      applyDevUpdate(tmpDir),
      strictRefusalPattern(git.path)
    );
    assert.deepEqual(await loggedCommands(logFile), []);
    assert.deepEqual(await loggedCommands(pnpmLog), []);
    assert.deepEqual(electronAppLifecycleCalls(), []);
  });
});
