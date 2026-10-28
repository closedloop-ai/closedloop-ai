/**
 * ISS-11596 red-first: the dev-mode update commands no longer block the event
 * loop while resolving git on a cold login-shell PATH cache (PLN-2165 AC-005,
 * sites S16 and S17). No git override is configured, so every resolution
 * probes the fake login shell; see `git-path-resolution-fixtures.ts` for why an
 * unacknowledged probe means the event loop was blocked. S16's second
 * resolution follows the `fetch` child, which announces itself so the observer
 * resets the cache first.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import {
  installFakePnpm,
  writeDesktopManifest,
} from "./helpers/dev-update-repo-fixture.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import { resetElectronModuleStub } from "./helpers/electron-module-stub.js";
import { createGitOpTempDirs } from "./helpers/git-gateway-op-harness.js";
import {
  assertProbesNeverBlocked,
  CacheScope,
  type ColdShellProbe,
  coldShellProbe,
  snapshotEnv,
  withColdShell,
} from "./helpers/git-path-resolution-fixtures.js";

const { makeTempDir } = createGitOpTempDirs("iss11596-mt-devupdate-");
const restoreEnv = snapshotEnv(["PATH"]);

let root = "";
let probe: ColdShellProbe;
let electronMock: ElectronModuleMock;

beforeEach(async () => {
  configureBinaryPathsResolver(null);
  electronMock = registerElectronModuleMock();
  resetElectronModuleStub();
  root = makeTempDir();
  probe = await coldShellProbe({ root, scope: CacheScope.Context });
  await fs.writeFile(
    path.join(probe.binDir, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = fetch ]; then',
      ...probe.announceLines("fetch").map((line) => `  ${line}`),
      "fi",
      `if [ "$1" = rev-parse ]; then printf '0123456789abcdef0123456789abcdef01234567\\n'; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
});

afterEach(() => {
  probe.stop();
  restoreEnv();
  electronMock.deregister();
  resetElectronModuleStub();
});

async function loadDevUpdateCommands() {
  return await import("../src/main/update/dev-update-commands.js");
}

describe("S16, S17: dev-mode update git resolution on a cold PATH cache", () => {
  test("S16 fetch: the first resolution leaves the event loop free", async () => {
    const { checkForDevUpdate } = await loadDevUpdateCommands();

    await withColdShell(probe, () => checkForDevUpdate(root));

    await assertProbesNeverBlocked(probe);
  });

  test("S16 rev-parse: the resolution after fetch leaves the event loop free", async () => {
    const { checkForDevUpdate } = await loadDevUpdateCommands();

    await withColdShell(probe, () => checkForDevUpdate(root));

    await assertProbesNeverBlocked(probe, "fetch");
  });

  test("S17 pull: the resolution leaves the event loop free", async () => {
    const entry = await writeDesktopManifest(root);
    await installFakePnpm(root, { entry });
    const { applyDevUpdate } = await loadDevUpdateCommands();

    await withColdShell(probe, () => applyDevUpdate(root));

    await assertProbesNeverBlocked(probe);
  });
});
