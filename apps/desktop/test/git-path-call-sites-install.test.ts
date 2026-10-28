/**
 * ISS-11596 characterization: `streamRun` keeps its observable behavior when
 * its login-shell PATH lookup (S20 in PLN-2165) moves from `getShellPathSync()`
 * to `await getShellPath()`. Every assertion must pass UNCHANGED on
 * `origin/main` and on the branch.
 *
 * The PATH comes from a fake login shell on a cold cache, so the case drives
 * the real resolution rather than a pinned PATH. Neither resolver can throw
 * (both catch a failed shell and fall back), so there is no failure case: the
 * PATH decides which harness CLI `auto` installs onto.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { streamRun } from "../src/main/packs/install-orchestrator.js";
import { withShellPathEnvForTest } from "../src/server/shell-path.js";
import {
  HARNESS_AUTO,
  StreamRunErrorCode,
} from "../src/shared/install-run-contract.js";
import { makeCatalogEntry } from "./support/catalog-entry-fixture.js";
import {
  FAKE_RUN_ID,
  makeStreamRunFakeDb,
} from "./support/stream-run-db-fixture.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** A fake login shell reporting `binDir` (plus the system dirs) as PATH. */
function loginShellEnv(binDir: string): NodeJS.ProcessEnv {
  const root = makeTempDir("iss11596-install-shell-");
  const shell = path.join(root, "fake-login-shell");
  fs.writeFileSync(
    shell,
    `#!/bin/sh\necho "__CLPATH_START__${binDir}:/usr/bin:/bin__CLPATH_END__"\n`,
    { mode: 0o755 }
  );
  return { ...process.env, SHELL: shell, PATH: "/usr/bin:/bin" };
}

function makeBinDir(binaries: string[]): string {
  const dir = makeTempDir("iss11596-install-bin-");
  for (const name of binaries) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  return dir;
}

function codexOnlyEntry(): ReturnType<typeof makeCatalogEntry> {
  return makeCatalogEntry({
    harnesses: ["codex"],
    installCommands: { codex: "true codex-install" },
    packId: "iss11596-codex-pack",
  });
}

describe("S20: streamRun reads the login-shell PATH to pick harness CLIs", () => {
  test("a codex CLI on the login-shell PATH starts the codex install", async () => {
    const entry = codexOnlyEntry();
    const db = makeStreamRunFakeDb(entry);

    const result = await withShellPathEnvForTest(
      loginShellEnv(makeBinDir(["codex"])),
      () =>
        streamRun(db, {
          action: "install",
          getWindow: () => null,
          harness: HARNESS_AUTO,
          pack_id: entry.packId,
        })
    );

    assert.equal(result.error, undefined);
    assert.equal(result.started, true);
    assert.equal(result.runId, FAKE_RUN_ID);
    assert.deepEqual(db.startedCommands, ["true codex-install"]);
  });

  test("no harness CLI on the login-shell PATH fails with no CLI detected", async () => {
    const entry = codexOnlyEntry();
    const db = makeStreamRunFakeDb(entry);

    const result = await withShellPathEnvForTest(
      loginShellEnv(makeBinDir([])),
      () =>
        streamRun(db, {
          action: "install",
          getWindow: () => null,
          harness: HARNESS_AUTO,
          pack_id: entry.packId,
        })
    );

    assert.equal(result.started, false);
    assert.equal(result.error?.code, StreamRunErrorCode.NoCli);
    assert.deepEqual(db.startedCommands, []);
  });
});
