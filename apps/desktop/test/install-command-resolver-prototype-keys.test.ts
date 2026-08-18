/**
 * @file install-command-resolver-prototype-keys.test.ts
 * @description ISS-5248: every command lookup in the install path is
 * `cmdMap?.[harness]`, and the LOOKUP key is externally influenced — an
 * explicit `harness` reaches `resolveRunCommand` from the cloud via the relay
 * and the gateway's member-pack install. On a plain object a harness literally
 * named `"constructor"`, `"toString"`, or `"valueOf"` resolves to an inherited
 * FUNCTION off `Object.prototype`, and `"__proto__"` resolves to
 * `Object.prototype` itself — all truthy. A bare `if (command)` therefore
 * accepted one of those as real command text and handed it to the installer as
 * the script to spawn.
 *
 * These assert through production entry points rather than mocks: the exported
 * resolvers (`pickSingleInstallCommand`, `resolveAutoCommand`), and `streamRun`
 * itself for the explicit-harness gate. The companion null-prototype ingest fix
 * is covered in `catalog-store-contract.test.ts`, where the map is built from a
 * real DB row.
 *
 * Which of these actually fail without the fix, stated exactly so nobody reads
 * more into them than they prove — 8 of the 22 do:
 *
 * - `pickSingleInstallCommand uninstall` (x4) and `resolveAutoCommand uninstall:
 *   single_install` (x4) FAIL pre-fix. Uninstall deliberately skips the
 *   `isHarnessInstalled` gate — on-disk artifacts outlive a CLI — so the lookup
 *   is reached directly and the inherited function arrives as `command`.
 * - `resolveAutoCommand uninstall: non-single_install` (x4) PASS pre-fix. That
 *   path already had `isNonEmptyString` on `main`; it is here as the control
 *   showing the asymmetry ISS-5248 reported, not as proof.
 * - The INSTALL (x4) and `isHarnessInstalled` (x4) cases are contract locks, not
 *   live exploits: `HARNESS_CLI_BINARIES` maps four fixed names, so a
 *   prototype-named harness never reaches the install lookup today. They pin the
 *   pairing so it stays that way.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isHarnessInstalled } from "../src/main/packs/install-child-env.js";
import {
  pickSingleInstallCommand,
  resolveAutoCommand,
} from "../src/main/packs/install-command-resolver.js";
import { streamRun } from "../src/main/packs/install-orchestrator.js";
import { StreamRunErrorCode } from "../src/shared/install-run-contract.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { makeCatalogEntry } from "./support/catalog-entry-fixture.js";

/** Names that resolve to something truthy on a plain object with no such key. */
const INHERITED_KEYS = ["constructor", "toString", "valueOf", "__proto__"];

/** No CLI on PATH — the install path must not depend on the host's binaries. */
const NO_CLI_ENV = { PATH: "" };

describe("ISS-5248 — inherited-key harness names resolve as absent", () => {
  for (const harness of INHERITED_KEYS) {
    test(`pickSingleInstallCommand uninstall: '${harness}' with no configured command picks nothing`, () => {
      const entry = makeCatalogEntry({
        singleInstall: true,
        harnesses: [harness],
        uninstallCommands: {},
      });

      const picked = pickSingleInstallCommand(entry, "uninstall", NO_CLI_ENV);

      assert.equal(picked.command, null);
      assert.deepEqual(picked.commands, []);
      assert.deepEqual(picked.registerHarnesses, []);
    });

    test(`pickSingleInstallCommand install: '${harness}' with no configured command picks nothing`, () => {
      const entry = makeCatalogEntry({
        singleInstall: true,
        harnesses: [harness],
        installCommands: {},
      });

      const picked = pickSingleInstallCommand(entry, "install", NO_CLI_ENV);

      assert.equal(picked.command, null);
      assert.deepEqual(picked.commands, []);
    });

    test(`resolveAutoCommand uninstall: single_install '${harness}' is unavailable, not a spawned function`, () => {
      const entry = makeCatalogEntry({
        singleInstall: true,
        harnesses: [harness],
        uninstallCommands: {},
      });

      const resolved = resolveAutoCommand(
        entry,
        entry.packId,
        "uninstall",
        NO_CLI_ENV
      );

      assert.equal(resolved.command, null);
      assert.equal(resolved.unavailable?.code, StreamRunErrorCode.NoCommand);
    });

    test(`resolveAutoCommand uninstall: non-single_install '${harness}' is unavailable`, () => {
      const entry = makeCatalogEntry({
        harnesses: [harness],
        uninstallCommands: {},
      });

      const resolved = resolveAutoCommand(
        entry,
        entry.packId,
        "uninstall",
        NO_CLI_ENV
      );

      assert.equal(resolved.command, null);
      assert.equal(resolved.unavailable?.code, StreamRunErrorCode.NoCommand);
    });

    test(`isHarnessInstalled: '${harness}' is not a known harness binary`, () => {
      // Non-empty PATH: the pre-fix map returned an inherited function here and
      // only avoided using it because `path.join` threw into the catch.
      assert.equal(
        isHarnessInstalled(harness, { PATH: "/usr/bin:/bin" }),
        false
      );
    });
  }

  test("a real configured command on a same-named harness still resolves", () => {
    // The guard must reject INHERITED values, not the harness name itself: a
    // catalog row that genuinely configures one keeps working.
    const entry = makeCatalogEntry({
      singleInstall: true,
      harnesses: ["constructor"],
      uninstallCommands: { constructor: "rm -rf ~/.weird-pack" },
    });

    const picked = pickSingleInstallCommand(entry, "uninstall", NO_CLI_ENV);

    assert.equal(picked.command, "rm -rf ~/.weird-pack");
    assert.deepEqual(picked.commands, ["rm -rf ~/.weird-pack"]);
    assert.deepEqual(picked.registerHarnesses, ["constructor"]);
  });

  test("an empty-string command is treated as absent, not as a no-op script", () => {
    const entry = makeCatalogEntry({
      singleInstall: true,
      harnesses: ["claude"],
      uninstallCommands: { claude: "" },
    });

    const picked = pickSingleInstallCommand(entry, "uninstall", NO_CLI_ENV);

    assert.equal(picked.command, null);
    assert.deepEqual(picked.commands, []);
  });
});

describe("ISS-5248 — streamRun rejects an inherited-key harness without spawning", () => {
  for (const harness of INHERITED_KEYS) {
    test(`streamRun install with harness '${harness}' fails ENOCOMMAND`, async () => {
      const { prisma, db, close } = await openTestPrisma();
      try {
        await db.query(
          `INSERT INTO pack_catalog (pack_id, display_name, github_url, install_commands, seed_version)
           VALUES ('alpha', 'Alpha', 'https://github.com/acme/alpha', $1, 1)`,
          [JSON.stringify({ claude: "claude plugin install alpha" })]
        );

        // The explicit-harness path in `resolveRunCommand` — the one gate the
        // externally-supplied gateway `harness` actually reaches. It must
        // report "no command" rather than spawning an inherited function.
        const result = await streamRun(
          {
            prisma,
            recordPackInstallRunStart: unusedRunRecorder,
            recordPackInstallRunEnd: unusedRunRecorder,
          } as Parameters<typeof streamRun>[0],
          {
            pack_id: "alpha",
            harness,
            action: "install",
            getWindow: () => null,
          }
        );

        assert.equal(result.started, false);
        assert.equal(result.error?.code, StreamRunErrorCode.NoCommand);
      } finally {
        await close();
      }
    });
  }

  test("streamRun still resolves a configured harness", async () => {
    const { prisma, db, close } = await openTestPrisma();
    try {
      await db.query(
        `INSERT INTO pack_catalog (pack_id, display_name, github_url, install_commands, seed_version)
         VALUES ('alpha', 'Alpha', 'https://github.com/acme/alpha', $1, 1)`,
        [JSON.stringify({ claude: "claude plugin install alpha" })]
      );

      // Proves the guard rejects INHERITED values, not real configured ones,
      // without ever spawning: an unusable `cwd` trips the validation gate that
      // sits immediately AFTER command resolution, so reaching `EBADCWD` is
      // itself evidence the command gate was cleared.
      const result = await streamRun(
        {
          prisma,
          recordPackInstallRunStart: unusedRunRecorder,
          recordPackInstallRunEnd: unusedRunRecorder,
        } as Parameters<typeof streamRun>[0],
        {
          pack_id: "alpha",
          harness: "claude",
          action: "install",
          cwd: "/iss-5248/definitely/not/a/real/directory",
          getWindow: () => null,
        }
      );

      assert.equal(result.started, false);
      assert.equal(result.error?.code, StreamRunErrorCode.BadCwd);
    } finally {
      await close();
    }
  });
});

/** Never reached: every case here fails before an install-run row is written. */
function unusedRunRecorder(): never {
  throw new Error("install-run recorder must not be reached");
}
