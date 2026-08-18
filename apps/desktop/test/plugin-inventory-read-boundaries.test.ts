/**
 * ISS-5810 review — the plugin inventory read at its MALFORMED-INPUT
 * boundaries.
 *
 * `plugin-enabled-state-read.test.ts` covers the shapes the CLI actually
 * emitted. This file covers the shapes it might emit that the reader got wrong,
 * each one named by a reviewer on PR #4767:
 *
 *  - a third-party plugin header interrupting a Closedloop record in the plain
 *    listing, which the text parser used to attribute to the record before it;
 *  - valid JSON whose members are not entries (`[1]`, `[{"id":null}]`), which
 *    used to become a successful EMPTY inventory — indistinguishable, to the
 *    caller, from "the CLI listed nothing";
 *  - a `--json` response that ran but could not be read, which used to return
 *    without ever trying the plain listing the fallback exists for;
 *  - one id reported at two scopes, where last-write-wins let an enabled
 *    project entry stand in for a still-disabled user install;
 *  - `command_failed` and `unreadable` folded into one "unavailable" post-enable
 *    read, which relabelled an unverifiable enable as a failed one and handed
 *    back `claude plugin enable` — the command that fails by design on an
 *    already-enabled plugin, i.e. the loop this work exists to break.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import {
  applyPluginEnableChecks,
  type PluginEnableRuntime,
  type PluginInventoryResult,
} from "../src/server/operations/health-check-plugin-enable.js";
import {
  type PluginInventoryRuntime,
  readClaudePluginInventory,
  readClaudePluginList,
} from "../src/server/operations/health-check-plugin-inventory.js";
import {
  type GatewayCheckResult,
  PLUGIN_DISABLED_ERROR,
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
  pluginCheckId,
} from "../src/server/operations/health-check-types.js";
import {
  getPluginInstallStatus,
  interpretPluginListOutput,
  PluginEnabledUnverifiedReason,
  parseClaudePluginListText,
  toPluginInventoryMap,
} from "../src/server/operations/plugin-cache.js";

const CODE_PLUGIN_REF = "code@closedloop-ai";
const CODE_CHECK_ID = pluginCheckId("code");
const PLUGIN_ENABLE_COMMAND_REGEX = /plugin enable/;
const TIMEOUT_MESSAGE = "Plugin remediation timed out";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** A registry whose `code` install path exists, so the plugin IS installed. */
async function writeInstalledRegistry(): Promise<string> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "iss5810-boundary-"));
  tempDirs.push(homeDir);
  const pluginsDir = path.join(homeDir, ".claude", "plugins");
  const installPath = path.join(pluginsDir, "cache", "closedloop-ai", "code");
  await mkdir(installPath, { recursive: true });
  const registryPath = path.join(pluginsDir, "installed_plugins.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      plugins: {
        [CODE_PLUGIN_REF]: [{ scope: "user", installPath, version: "1.14.7" }],
      },
    })
  );
  return registryPath;
}

describe("ISS-5810 review — a third-party plugin header closes the record before it", () => {
  test("a disabled Closedloop plugin does not inherit the next plugin's enabled status", () => {
    const entries = parseClaudePluginListText(
      [
        "Installed plugins:",
        "",
        "  ❯ code@closedloop-ai",
        "    Version: 1.14.7",
        "    Scope: user",
        "    Status: ✘ disabled",
        "",
        "  ❯ context7@claude-plugins-official",
        "    Version: unknown",
        "    Scope: user",
        "    Status: ✔ enabled",
        "",
      ].join("\n")
    );

    const codeEntry = entries.find((entry) => entry.id === CODE_PLUGIN_REF);
    assert.ok(codeEntry, "the Closedloop entry must be parsed");
    assert.equal(
      codeEntry.enabled,
      false,
      "the third-party plugin's enabled status must not land on this record"
    );
  });

  test("an enabled Closedloop plugin does not inherit the next plugin's project scope", () => {
    const entries = parseClaudePluginListText(
      [
        "  ❯ code@closedloop-ai",
        "    Scope: user",
        "    Status: ✔ enabled",
        "",
        "  ❯ pyright-lsp@claude-plugins-official",
        "    Scope: project",
        "    Status: ✘ disabled",
      ].join("\n")
    );

    const codeEntry = entries.find((entry) => entry.id === CODE_PLUGIN_REF);
    assert.ok(codeEntry);
    assert.equal(codeEntry.scope, "user");
    assert.equal(codeEntry.enabled, true);
  });

  test("the plugin the trailing lines DO belong to is parsed as its own record", () => {
    const entries = parseClaudePluginListText(
      [
        "  ❯ code@closedloop-ai",
        "    Scope: user",
        "    Status: ✔ enabled",
        "  ❯ context7@claude-plugins-official",
        "    Scope: project",
        "    Status: ✘ disabled",
      ].join("\n")
    );

    const thirdParty = entries.find(
      (entry) => entry.id === "context7@claude-plugins-official"
    );
    assert.ok(
      thirdParty,
      "third-party plugins are parsed, then filtered by id"
    );
    assert.equal(thirdParty.scope, "project");
    assert.equal(thirdParty.enabled, false);
  });
});

describe("ISS-5810 review — valid JSON with undecodable members is unreadable, not an empty inventory", () => {
  test("a container whose members do not decode is never a successful read", () => {
    for (const payload of [
      "[1]",
      '[{"id":null}]',
      '{"installed":[1,2]}',
      '[{"noIdHere":true}]',
    ]) {
      const read = interpretPluginListOutput(payload);
      assert.equal(
        read.status,
        "unreadable",
        `${payload} must not report a successful read`
      );
    }
  });

  test("a genuinely empty inventory still reads as ok — that IS a readable answer", () => {
    for (const payload of ["[]", '{"installed":[]}']) {
      const read = interpretPluginListOutput(payload);
      assert.equal(read.status, "ok", `${payload} must stay a successful read`);
      assert.deepEqual(read.status === "ok" ? read.entries : null, []);
    }
  });

  test("a container with one decodable member keeps that member", () => {
    const read = interpretPluginListOutput(
      JSON.stringify([1, { id: CODE_PLUGIN_REF, scope: "user", enabled: true }])
    );
    assert.equal(read.status, "ok");
    assert.deepEqual(
      read.status === "ok" ? read.entries.map((entry) => entry.id) : [],
      [CODE_PLUGIN_REF]
    );
  });

  test("undecodable members produce a STATED unreadable, distinct from a missing enabled state", async () => {
    const registryPath = await writeInstalledRegistry();

    for (const payload of ["[1]", '[{"id":null}]']) {
      const status = getPluginInstallStatus("code", registryPath, payload);
      assert.equal(status.hasValidUserScopedEntry, false);
      assert.equal(status.enabledStateUnverified, true);
      assert.equal(
        status.enabledStateUnverifiedReason,
        PluginEnabledUnverifiedReason.Unreadable,
        `${payload} must be reported as unreadable output`
      );
    }

    // The contrast that makes the above meaningful: an EMPTY inventory is a
    // read that succeeded and simply did not list the plugin.
    const empty = getPluginInstallStatus("code", registryPath, "[]");
    assert.equal(
      empty.enabledStateUnverifiedReason,
      PluginEnabledUnverifiedReason.EnabledStateMissing
    );
  });
});

describe("ISS-5810 review — an unreadable `--json` response still falls back to the plain listing", () => {
  test("the plain listing runs and its inventory wins", async () => {
    const invocations: string[][] = [];
    const runtime: PluginInventoryRuntime = {
      resolveClaudeBinary: () =>
        Promise.resolve({ path: "/usr/bin/claude", source: "path" }),
      runCommand: (_cmd, args) => {
        invocations.push(args);
        if (args.includes("--json")) {
          return Promise.resolve({
            stdout: "error: unknown option '--json'",
          });
        }
        return Promise.resolve({
          stdout: [
            "  ❯ code@closedloop-ai",
            "    Scope: user",
            "    Status: ✔ enabled",
          ].join("\n"),
        });
      },
    };

    const read = await readClaudePluginList(runtime);

    assert.deepEqual(invocations, [
      ["plugin", "list", "--json"],
      ["plugin", "list"],
    ]);
    assert.equal(read.status, "ok");
    assert.equal(read.status === "ok" ? read.source : null, "text");
    assert.deepEqual(
      read.status === "ok" ? read.entries.map((entry) => entry.id) : [],
      [CODE_PLUGIN_REF]
    );
  });

  test("a plain listing that then throws leaves the read unreadable, not unrunnable", async () => {
    const runtime: PluginInventoryRuntime = {
      resolveClaudeBinary: () =>
        Promise.resolve({ path: "/usr/bin/claude", source: "path" }),
      runCommand: (_cmd, args) => {
        if (args.includes("--json")) {
          return Promise.resolve({ stdout: "surprise new output shape" });
        }
        return Promise.reject(new Error("spawn ENOENT"));
      },
    };

    const read = await readClaudePluginList(runtime);

    // The command RAN. Reporting `command_failed` here would send the operator
    // after the Claude CLI for a problem that is ours to read.
    assert.equal(read.status, "unreadable");
  });

  test("a command that never runs is still command_failed", async () => {
    const runtime: PluginInventoryRuntime = {
      resolveClaudeBinary: () =>
        Promise.resolve({ path: "/usr/bin/claude", source: "path" }),
      runCommand: () => Promise.reject(new Error("spawn ENOENT")),
    };

    const read = await readClaudePluginList(runtime);

    assert.equal(read.status, "command_failed");
    assert.equal(
      read.status === "command_failed" ? read.detail : undefined,
      "spawn ENOENT"
    );
  });
});

describe("ISS-5810 review — one id at two scopes cannot be resolved by write order", () => {
  test("a user-scoped entry outranks a project-scoped one regardless of order", () => {
    const userDisabled = {
      id: CODE_PLUGIN_REF,
      scope: "user",
      enabled: false,
    } as const;
    const projectEnabled = {
      id: CODE_PLUGIN_REF,
      scope: "project",
      enabled: true,
    } as const;

    for (const entries of [
      [userDisabled, projectEnabled],
      [projectEnabled, userDisabled],
    ]) {
      const map = toPluginInventoryMap([...entries]);
      assert.equal(map.size, 1);
      assert.equal(
        map.get(CODE_PLUGIN_REF)?.enabled,
        false,
        "the user-scoped entry is the one the user-scope question is about"
      );
    }
  });

  test("an enabled project entry does not report a still-disabled user install as fixed", async () => {
    const checks = await runEnableWithPostInventory({
      source: "json",
      entries: toPluginInventoryMap([
        { id: CODE_PLUGIN_REF, scope: "user", enabled: false },
        { id: CODE_PLUGIN_REF, scope: "project", enabled: true },
      ]),
    });

    const row = requirePluginRow(checks);
    assert.equal(row.passed, false, "the user install is still disabled");
    assert.equal(row.error, "Automatic enable failed");
  });

  test("a project-scoped entry alone is not proof the user install was enabled", async () => {
    const checks = await runEnableWithPostInventory({
      source: "json",
      entries: toPluginInventoryMap([
        { id: CODE_PLUGIN_REF, scope: "project", enabled: true },
      ]),
    });

    assert.equal(requirePluginRow(checks).passed, false);
  });

  test("an entry the listing carries no scope for is still accepted as proof", async () => {
    // The plain listing on some CLI builds has no `Scope:` line at all.
    // Requiring an explicit "user" here would regress every text-only read.
    const checks = await runEnableWithPostInventory({
      source: "text",
      entries: toPluginInventoryMap([{ id: CODE_PLUGIN_REF, enabled: true }]),
    });

    assert.equal(requirePluginRow(checks).passed, true);
  });
});

describe("ISS-5810 review — an unverifiable post-enable read stays unknown", () => {
  test("readClaudePluginInventory states WHICH failure made it unavailable", async () => {
    const unreadable = await readClaudePluginInventory({
      resolveClaudeBinary: () =>
        Promise.resolve({ path: "/usr/bin/claude", source: "path" }),
      runCommand: () => Promise.resolve({ stdout: "unrecognized shape" }),
    });
    assert.equal(unreadable.source, "unavailable");
    assert.equal(unreadable.unavailableReason, "unreadable");

    const commandFailed = await readClaudePluginInventory({
      resolveClaudeBinary: () =>
        Promise.resolve({ path: "/usr/bin/claude", source: "path" }),
      runCommand: () => Promise.reject(new Error("spawn ENOENT")),
    });
    assert.equal(commandFailed.source, "unavailable");
    assert.equal(commandFailed.unavailableReason, "command_failed");

    assert.notEqual(
      unreadable.unavailableReason,
      commandFailed.unavailableReason
    );
  });

  test("an unreadable verification read never claims the enable failed", async () => {
    const checks = await runEnableWithPostInventory({
      source: "unavailable",
      unavailableReason: "unreadable",
      entries: new Map(),
    });

    const row = requirePluginRow(checks);
    assert.equal(row.passed, false);
    assert.equal(row.severity, CheckSeverity.Unknown);
    assert.equal(row.error, PLUGIN_LIST_UNREADABLE_ERROR);
    assert.notEqual(row.error, "Automatic enable failed");
    assert.doesNotMatch(row.remediation ?? "", PLUGIN_ENABLE_COMMAND_REGEX);
    assert.equal(
      row.enableOutcome,
      undefined,
      "no outcome badge may claim a result nothing measured"
    );
    assert.equal(row.enableAttempted, true);
  });

  test("a verification read that could not run says so, and differently", async () => {
    const checks = await runEnableWithPostInventory({
      source: "unavailable",
      unavailableReason: "command_failed",
      entries: new Map(),
    });

    const row = requirePluginRow(checks);
    assert.equal(row.error, PLUGIN_LIST_COMMAND_FAILED_ERROR);
    assert.equal(row.severity, CheckSeverity.Unknown);
    assert.doesNotMatch(row.remediation ?? "", PLUGIN_ENABLE_COMMAND_REGEX);
  });

  test("a read that succeeded and still shows the plugin disabled IS a failed enable", async () => {
    // The unknown branch must not swallow real failures: here the CLI answered,
    // and its answer is that the plugin is still off.
    const checks = await runEnableWithPostInventory({
      source: "json",
      entries: toPluginInventoryMap([
        { id: CODE_PLUGIN_REF, scope: "user", enabled: false },
      ]),
    });

    const row = requirePluginRow(checks);
    assert.equal(row.error, "Automatic enable failed");
    assert.equal(row.enableOutcome, "failed");
    assert.equal(row.severity, undefined);
  });

  test("a timed-out verification read keeps its own timeout reporting", async () => {
    const checks = await runEnableWithPostInventory({
      source: "unavailable",
      entries: new Map(),
      error: TIMEOUT_MESSAGE,
    });

    const row = requirePluginRow(checks);
    assert.equal(row.error, "Enable timed out");
    assert.equal(row.enableOutcome, "timeout");
  });
});

function requirePluginRow(checks: GatewayCheckResult[]): GatewayCheckResult {
  const row = checks.find((check) => check.id === CODE_CHECK_ID);
  if (!row) {
    throw new Error("the code plugin row must survive the enable pass");
  }
  return row;
}

function createEnableRuntime(): PluginEnableRuntime {
  return {
    createDeadline: () => ({ startedAt: Date.now(), timeoutMs: 60_000 }),
    hasDeadlineExpired: () => false,
    createTimeoutResult: () => ({
      outcome: "timeout",
      stdout: "",
      elapsedMs: 0,
    }),
    runEnableWithinDeadline: () =>
      Promise.resolve({ outcome: "success", stdout: "Enabled", elapsedMs: 0 }),
    readInventoryWithinDeadline: (readInventory) => readInventory(),
    timeoutMessage: TIMEOUT_MESSAGE,
    getOutputTail: () => "",
  };
}

/**
 * Drive the production `applyPluginEnableChecks` over a disabled `code` row,
 * with the enable command reporting SUCCESS, so the row that comes back is
 * decided entirely by the post-enable inventory under test.
 */
async function runEnableWithPostInventory(
  postInventory: PluginInventoryResult
): Promise<GatewayCheckResult[]> {
  const disabledRow: GatewayCheckResult = {
    id: CODE_CHECK_ID,
    label: "Symphony Plugin",
    required: true,
    passed: false,
    error: PLUGIN_DISABLED_ERROR,
    remediation: `Run: claude plugin enable ${CODE_PLUGIN_REF} --scope user`,
    enableAttempted: false,
    enablePluginIds: [CODE_PLUGIN_REF],
  };

  return await applyPluginEnableChecks([disabledRow], {
    readInventory: () => Promise.resolve(postInventory),
    runtime: createEnableRuntime(),
  });
}
