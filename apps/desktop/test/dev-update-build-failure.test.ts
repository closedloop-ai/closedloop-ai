/**
 * ISS-12479: a dev update must not leave the checkout unable to launch. The
 * desktop `build` script deletes `dist` before it writes anything, so before
 * this the first failing build step left no entry for the next `electron .` and
 * the user hit Electron's "Error launching app" until some later build
 * succeeded.
 *
 * `dev-update-commands.ts` imports `electron` at module scope, so it is loaded
 * through the recording Electron stub with a dynamic import.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import {
  DESKTOP_ENTRY_MAIN,
  installFakePnpm,
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
import { snapshotEnv } from "./helpers/git-path-resolution-fixtures.js";

const MOVED_ENTRY_MAIN = "dist/main/renamed-entry.js";
const BUILD_STDERR = "vite: could not resolve src/main/index.ts";
const PREVIOUS_BUNDLE = "// the bundle the app is running from";

let repoRoot = "";
let electronMock: ElectronModuleMock;
const restoreEnv = snapshotEnv(["PATH"]);

beforeEach(async () => {
  repoRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "iss12479-devupdate-"))
  );
  electronMock = registerElectronModuleMock();
  resetElectronModuleStub();
  await installFakeGit();
});

afterEach(async () => {
  configureBinaryPathsResolver(null);
  restoreEnv();
  electronMock.deregister();
  resetElectronModuleStub();
  vi.restoreAllMocks();
  await fs.rm(repoRoot, { recursive: true, force: true, maxRetries: 3 });
});

async function installFakeGit(): Promise<void> {
  const gitPath = path.join(repoRoot, "git");
  await fs.writeFile(gitPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  configureBinaryPathsResolver(() => ({ git: gitPath }));
}

async function loadDevUpdateCommands() {
  return await import("../src/main/update/dev-update-commands.js");
}

/** Writes a bundle at `entry` standing in for the build the app is running. */
async function seedPreviousBundle(entry: string): Promise<void> {
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, PREVIOUS_BUNDLE);
}

describe("applyDevUpdate: a failed build leaves the checkout launchable", () => {
  test("the previous bundle survives the build that wipes dist", async () => {
    const entry = await writeDesktopManifest(repoRoot);
    await seedPreviousBundle(entry);
    await installFakePnpm(repoRoot, { failWith: BUILD_STDERR });
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(applyDevUpdate(repoRoot));

    assert.equal(await fs.readFile(entry, "utf8"), PREVIOUS_BUNDLE);
    assert.deepEqual(electronAppLifecycleCalls(), []);
  });

  test("the failure is logged with the entry path and the build stderr", async () => {
    const entry = await writeDesktopManifest(repoRoot);
    await seedPreviousBundle(entry);
    await installFakePnpm(repoRoot, { failWith: BUILD_STDERR });
    const logged = vi.spyOn(gatewayLog, "error");
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(applyDevUpdate(repoRoot));

    const messages = logged.mock.calls.map(([, message]) => message);
    assert.equal(
      messages.filter(
        (message) => message.includes(entry) && message.includes(BUILD_STDERR)
      ).length,
      1
    );
  });

  test("a build that leaves no entry rejects before relaunch or exit", async () => {
    const entry = await writeDesktopManifest(repoRoot);
    await installFakePnpm(repoRoot, {});
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(applyDevUpdate(repoRoot), (error: Error) =>
      error.message.includes(entry)
    );
    assert.deepEqual(electronAppLifecycleCalls(), []);
  });
});

describe("applyDevUpdate: the entry comes from the desktop manifest", () => {
  test("a moved entry the build writes is accepted", async () => {
    const entry = await writeDesktopManifest(repoRoot, MOVED_ENTRY_MAIN);
    await installFakePnpm(repoRoot, { entry });
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await applyDevUpdate(repoRoot);

    assert.deepEqual(electronAppLifecycleCalls(), ["relaunch", "exit:0"]);
    assert.deepEqual(
      (await fs.readdir(path.join(repoRoot, "apps", "desktop"))).sort(),
      ["dist", "package.json"]
    );
  });

  test("a build writing only the old entry path is refused", async () => {
    const movedEntry = await writeDesktopManifest(repoRoot, MOVED_ENTRY_MAIN);
    await installFakePnpm(repoRoot, {
      entry: path.join(repoRoot, "apps", "desktop", DESKTOP_ENTRY_MAIN),
    });
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await assert.rejects(applyDevUpdate(repoRoot), (error: Error) =>
      error.message.includes(movedEntry)
    );
    assert.deepEqual(electronAppLifecycleCalls(), []);
  });
});
