/**
 * ISS-5810 — System Check must be able to READ a plugin's enabled state.
 *
 * System Check reported all five Closedloop plugins as "Setup required — Could
 * not verify enabled state" on a machine where every one of them was installed
 * and enabled at user scope, and prescribed a repair the machine could disprove:
 *
 *   $ claude plugin enable code@closedloop-ai --scope user
 *   ✗ Failed to enable plugin "code@closedloop-ai": Plugin
 *     "code@closedloop-ai" is already enabled at user scope
 *
 * The check could not read the state, Repair refused to act until it could, and
 * the only offered instruction failed BECAUSE the plugin was already in the
 * desired state. No exit.
 *
 * The fixtures under `fixtures/plugin-list/` are REAL output captured from
 * `claude plugin list --json` and `claude plugin list` on Claude Code 2.1.220
 * with all five plugins enabled at user scope. They are the oracle: a fixture
 * written to match the code's assumption would prove nothing. The only edit is
 * that every `installPath` home directory was replaced with the synthetic
 * `/synthetic-home` root, so no operator's username is checked in — nothing
 * reads those paths (install-path existence is checked against the registry,
 * never against the listing), and the fields the tests do read — `id`, `scope`,
 * `enabled`, `version` — are byte-for-byte as captured.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_DISABLED_ERROR,
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
} from "../src/server/operations/health-check-types.js";
import {
  getPluginInstallStatus,
  getPluginInstallStatusFromRead,
  PluginEnabledUnverifiedReason,
  type PluginListRead,
  parseClaudePluginListJson,
  parseClaudePluginListText,
} from "../src/server/operations/plugin-cache.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-list"
);

const CLOSEDLOOP_PLUGIN_FOLDERS = [
  "code",
  "code-review",
  "judges",
  "platform",
  "self-learning",
] as const;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function readFixture(name: string): Promise<string> {
  return await readFile(path.join(FIXTURE_DIR, name), "utf-8");
}

/**
 * Build an `installed_plugins.json` whose install paths exist on disk, so
 * `hasExistingUserInstallPath` is true — the operator state ISS-5810 was
 * reported from.
 */
async function writeEnabledRegistry(): Promise<string> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "iss5810-"));
  tempDirs.push(homeDir);
  const pluginsDir = path.join(homeDir, ".claude", "plugins");
  const plugins: Record<string, unknown[]> = {};

  for (const folder of CLOSEDLOOP_PLUGIN_FOLDERS) {
    const installPath = path.join(
      pluginsDir,
      "cache",
      "closedloop-ai",
      folder,
      "1.0.0"
    );
    await mkdir(installPath, { recursive: true });
    plugins[`${folder}@closedloop-ai`] = [
      { scope: "user", installPath, version: "1.0.0" },
    ];
  }

  const registryPath = path.join(pluginsDir, "installed_plugins.json");
  await writeFile(registryPath, JSON.stringify({ version: 2, plugins }));
  return registryPath;
}

describe("ISS-5810 — reading the enabled state from real CLI output", () => {
  test("real `claude plugin list --json` output proves all five plugins enabled", async () => {
    const registryPath = await writeEnabledRegistry();
    const listJson = await readFixture("claude-plugin-list.json");

    for (const folder of CLOSEDLOOP_PLUGIN_FOLDERS) {
      const status = getPluginInstallStatus(folder, registryPath, listJson);
      assert.equal(
        status.hasValidUserScopedEntry,
        true,
        `${folder} must read as enabled at user scope`
      );
      assert.equal(status.enabledStateUnverified, false);
      assert.equal(status.enabledStateUnverifiedReason, undefined);
      assert.equal(status.disabled, false);
    }
  });

  test("the real JSON output carries the scope and enabled fields the check keys off", async () => {
    const entries = parseClaudePluginListJson(
      await readFixture("claude-plugin-list.json")
    );
    const codeEntry = entries.find(
      (entry) => entry.id === "code@closedloop-ai"
    );

    assert.ok(codeEntry, "code@closedloop-ai must appear in the real output");
    assert.equal(codeEntry.scope, "user");
    assert.equal(codeEntry.enabled, true);
  });

  test("real human-readable `claude plugin list` output also proves enabled", async () => {
    const registryPath = await writeEnabledRegistry();
    const entries = parseClaudePluginListText(
      await readFixture("claude-plugin-list.txt")
    );

    // Before ISS-5810 the text parser dropped `Scope:` entirely, so even a
    // successful text read could not satisfy the user-scope predicate and fell
    // through to the same unusable "could not verify" row.
    const codeEntry = entries.find(
      (entry) => entry.id === "code@closedloop-ai"
    );
    assert.ok(codeEntry);
    assert.equal(codeEntry.scope, "user");
    assert.equal(codeEntry.enabled, true);

    for (const folder of CLOSEDLOOP_PLUGIN_FOLDERS) {
      const status = getPluginInstallStatusFromRead(
        folder,
        { status: "ok", source: "text", entries },
        registryPath
      );
      assert.equal(
        status.hasValidUserScopedEntry,
        true,
        `${folder} must read as enabled from the text listing`
      );
    }
  });
});

describe("ISS-5810 — a failed read states WHICH failure it was", () => {
  test("a command that could not run is not the same as output that could not be read", async () => {
    const registryPath = await writeEnabledRegistry();

    const commandFailed = getPluginInstallStatusFromRead(
      "code",
      { status: "command_failed", detail: "spawn ENOENT" },
      registryPath
    );
    assert.equal(commandFailed.enabledStateUnverified, true);
    assert.equal(
      commandFailed.enabledStateUnverifiedReason,
      PluginEnabledUnverifiedReason.CommandFailed
    );

    const unreadable = getPluginInstallStatusFromRead(
      "code",
      { status: "unreadable", detail: "unrecognized format" },
      registryPath
    );
    assert.equal(unreadable.enabledStateUnverified, true);
    assert.equal(
      unreadable.enabledStateUnverifiedReason,
      PluginEnabledUnverifiedReason.Unreadable
    );

    assert.notEqual(
      commandFailed.enabledStateUnverifiedReason,
      unreadable.enabledStateUnverifiedReason
    );
  });

  test("a successful read that omits the plugin reports a missing enabled state", async () => {
    const registryPath = await writeEnabledRegistry();
    // Reproduces a real, observed outcome: `claude plugin list --json` exiting 0
    // with an empty inventory. The registry says installed, the CLI says
    // nothing — a contradiction that must be stated, never silently passed and
    // never reported as "not installed".
    const status = getPluginInstallStatusFromRead(
      "code",
      { status: "ok", source: "json", entries: [] },
      registryPath
    );

    assert.equal(status.hasValidUserScopedEntry, false);
    assert.equal(status.enabledStateUnverified, true);
    assert.equal(
      status.enabledStateUnverifiedReason,
      PluginEnabledUnverifiedReason.EnabledStateMissing
    );
  });

  test("a plugin the CLI reports as disabled stays proven disabled, not unknown", async () => {
    const registryPath = await writeEnabledRegistry();
    const status = getPluginInstallStatusFromRead(
      "code",
      {
        status: "ok",
        source: "json",
        entries: [{ id: "code@closedloop-ai", scope: "user", enabled: false }],
      },
      registryPath
    );

    assert.equal(status.disabled, true);
    assert.equal(status.enabledStateUnverified, false);
    assert.equal(status.hasValidUserScopedEntry, false);
  });
});

describe("ISS-5810 — unknown CLI shapes degrade to a stated unknown", () => {
  test("an unparseable payload is unreadable, never a silent pass", async () => {
    const registryPath = await writeEnabledRegistry();

    for (const payload of [
      "not json at all",
      "{",
      '{"unexpected":"envelope"}',
      "",
    ]) {
      const status = getPluginInstallStatus("code", registryPath, payload);
      assert.equal(
        status.hasValidUserScopedEntry,
        false,
        `"${payload}" must not read as enabled`
      );
      assert.equal(status.enabledStateUnverified, true);
      assert.equal(
        status.enabledStateUnverifiedReason,
        PluginEnabledUnverifiedReason.Unreadable
      );
    }
  });

  test("a future entry shape with no scope cannot prove a user-scoped install", async () => {
    const registryPath = await writeEnabledRegistry();
    const read: PluginListRead = {
      status: "ok",
      source: "json",
      entries: [{ id: "code@closedloop-ai", enabled: true }],
    };

    const status = getPluginInstallStatusFromRead("code", read, registryPath);
    assert.equal(status.hasValidUserScopedEntry, false);
    assert.equal(
      status.enabledStateUnverifiedReason,
      PluginEnabledUnverifiedReason.EnabledStateMissing
    );
  });

  test("an unknown shape never throws", async () => {
    const registryPath = await writeEnabledRegistry();
    for (const payload of ["[]", "null", "[1,2,3]", '[{"id":null}]']) {
      assert.doesNotThrow(() =>
        getPluginInstallStatus("code", registryPath, payload)
      );
    }
  });
});

describe("ISS-5810 — every unreadable state carries a distinct, non-empty error", () => {
  test("the four plugin error strings stay distinct", () => {
    const errors = new Set([
      PLUGIN_DISABLED_ERROR,
      PLUGIN_STATE_UNVERIFIED_ERROR,
      PLUGIN_LIST_COMMAND_FAILED_ERROR,
      PLUGIN_LIST_UNREADABLE_ERROR,
    ]);
    assert.equal(errors.size, 4);
    for (const error of errors) {
      assert.ok(error.length > 0);
    }
  });
});
