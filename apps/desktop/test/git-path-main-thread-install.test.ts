/**
 * ISS-11596 red-first: `streamRun` no longer blocks the event loop while it
 * reads the login-shell PATH on a cold cache (PLN-2165 AC-005, site S20). See
 * `git-path-resolution-fixtures.ts` for why an unacknowledged probe means the
 * event loop was blocked.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { streamRun } from "../src/main/packs/install-orchestrator.js";
import { HARNESS_AUTO } from "../src/shared/install-run-contract.js";
import { createGitOpTempDirs } from "./helpers/git-gateway-op-harness.js";
import {
  assertProbesNeverBlocked,
  CacheScope,
  type ColdShellProbe,
  coldShellProbe,
  withColdShell,
} from "./helpers/git-path-resolution-fixtures.js";
import { makeCatalogEntry } from "./support/catalog-entry-fixture.js";
import { makeStreamRunFakeDb } from "./support/stream-run-db-fixture.js";

const { makeTempDir } = createGitOpTempDirs("iss11596-mt-install-");

let probe: ColdShellProbe;

beforeEach(async () => {
  probe = await coldShellProbe({
    root: makeTempDir(),
    scope: CacheScope.Context,
  });
  await fs.writeFile(path.join(probe.binDir, "codex"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
});

afterEach(() => {
  probe.stop();
});

describe("S20: streamRun's login-shell PATH read on a cold cache", () => {
  test("the PATH read leaves the event loop free", async () => {
    const entry = makeCatalogEntry({
      harnesses: ["codex"],
      installCommands: { codex: "true codex-install" },
      packId: "iss11596-mt-codex-pack",
    });
    const db = makeStreamRunFakeDb(entry);

    await withColdShell(probe, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: HARNESS_AUTO,
        pack_id: entry.packId,
      })
    );

    await assertProbesNeverBlocked(probe);
  });
});
