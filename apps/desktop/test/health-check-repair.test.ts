import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  APP_VERSION_CHECK_ID,
  CheckSeverity,
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { Observability } from "../src/main/telemetry/observability.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _setPluginEnableCommandForTesting,
  _setPluginMarketplaceUpdateCommandForTesting,
  _setPluginRemediationDeadlineMsForTesting,
  _setPluginUpdateCommandForTesting,
  _setRunCommandForTesting,
} from "../src/server/operations/health-check.js";
import {
  _resetHealthCheckRepairStateForTesting,
  type HealthCheckRepairDeps,
  type HealthCheckRepairResult,
  registerHealthCheckRepairRoutes,
  repairHealthCheck,
} from "../src/server/operations/health-check-repair.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  buildPluginListJson,
  CLOSEDLOOP_PLUGINS,
  cleanupTempDirs,
  findPluginCheck,
  getChecks,
  makeResponse,
  makeTempHome,
  parsePayload,
  tempDirs,
  unavailableMcp,
  writeAllUserScopedPlugins,
} from "./helpers/health-check-fixtures.js";

const RE_CLAUDE_CLI = /Claude CLI/;
const RE_THAT_MACHINE = /that machine/;

const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  _resetHealthCheckRepairStateForTesting();
  _setPluginEnableCommandForTesting();
  _setPluginMarketplaceUpdateCommandForTesting();
  _setPluginRemediationDeadlineMsForTesting();
  _setPluginUpdateCommandForTesting();
  _setRunCommandForTesting();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await cleanupTempDirs();
  await Observability.shutdown();
  Observability.reset();
});

type RepairHarness = {
  deps: HealthCheckRepairDeps;
  enableCalls: string[];
  patches: Partial<Record<string, string | null>>[];
  /** Ordered log of every side effect, so ordering can be asserted directly. */
  events: string[];
  binaryPaths: { claude?: string; git?: string };
};

/**
 * A gateway whose `claude` probe answers with a version and whose plugin
 * inventory is driven by `pluginListJson`. `claudeOverride` seeds the stored
 * binary-path override the repair is expected to reason about.
 */
function makeHarness(options: {
  pluginListJson: () => string;
  claudeOverride?: string;
  onEnable?: (pluginRef: string) => void;
}): RepairHarness {
  const enableCalls: string[] = [];
  const patches: Partial<Record<string, string | null>>[] = [];
  const events: string[] = [];
  const binaryPaths: { claude?: string; git?: string } = {
    claude: options.claudeOverride,
  };

  _setRunCommandForTesting((_cmd, args) => {
    if (args.join(" ") === "plugin list --json") {
      return Promise.resolve({ stdout: options.pluginListJson() });
    }
    return Promise.resolve({ stdout: "1.0.0" });
  });
  _setPluginEnableCommandForTesting((pluginRef) => {
    enableCalls.push(pluginRef);
    events.push(`enable:${pluginRef}`);
    options.onEnable?.(pluginRef);
    return Promise.resolve({
      outcome: "success" as const,
      stdout: "",
      elapsedMs: 1,
    });
  });

  return {
    enableCalls,
    patches,
    events,
    binaryPaths,
    deps: {
      processManager: {} as unknown as ProcessManager,
      getSymphonyDir: () => os.tmpdir(),
      detectMcp: unavailableMcp,
      getBinaryPaths: () => ({ ...binaryPaths }),
      applyBinaryPathPatch: (patch) => {
        patches.push(patch);
        events.push(`patch:${JSON.stringify(patch)}`);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            delete binaryPaths[key as "claude" | "git"];
          } else {
            binaryPaths[key as "claude" | "git"] = value;
          }
        }
        return binaryPaths;
      },
    },
  };
}

/** An absolute path that is guaranteed not to exist — a provably stale override. */
async function makeStaleOverridePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-override-"));
  tempDirs.push(dir);
  return path.join(dir, "claude-that-was-uninstalled");
}

function findStep(
  result: HealthCheckRepairResult,
  action: (typeof HealthCheckRepairAction)[keyof typeof HealthCheckRepairAction]
) {
  return result.steps.find((step) => step.action === action);
}

describe("System Check repair", () => {
  test("repairs the root before the cascade: the stale override is cleared before any plugin enable runs", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const stalePath = await makeStaleOverridePath();
    const harness = makeHarness({
      claudeOverride: stalePath,
      pluginListJson: () =>
        buildPluginListJson([
          { enabled: false, id: "code@closedloop-ai", scope: "user" },
        ]),
    });

    const result = await repairHealthCheck(harness.deps);

    // Root: the override is cleared, once, with an explicit null.
    assert.deepEqual(harness.patches, [{ claude: null }]);
    const clearStep = findStep(
      result,
      HealthCheckRepairAction.ClearBinaryOverride
    );
    assert.equal(clearStep?.status, HealthCheckRepairStepStatus.Succeeded);
    assert.deepEqual(clearStep?.checkIds, ["claude-cli"]);
    assert.match(clearStep?.detail ?? "", RE_CLAUDE_CLI);

    // Ordering, not just occurrence: every `claude plugin enable` that ran, ran
    // AFTER binary resolution was repaired. Firing them first is the doomed
    // sequence ISS-5389 exists to end.
    const firstEnableIndex = harness.events.findIndex((event) =>
      event.startsWith("enable:")
    );
    const patchIndex = harness.events.findIndex((event) =>
      event.startsWith("patch:")
    );
    assert.notEqual(patchIndex, -1);
    // Guarding the ordering assertion behind `!== -1` let the whole claim pass
    // vacuously if no enable ever ran — which is the exact regression this test
    // exists to catch (ISS-5389 review). Demand the enable happened, THEN
    // demand it happened second.
    assert.notEqual(
      firstEnableIndex,
      -1,
      "expected at least one plugin enable to run"
    );
    assert.ok(patchIndex < firstEnableIndex);
  });

  test("fires ZERO plugin enables while the Claude CLI is still unresolvable, and names the root fault", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const stalePath = await makeStaleOverridePath();
    const harness = makeHarness({
      claudeOverride: stalePath,
      pluginListJson: () =>
        buildPluginListJson([
          { enabled: false, id: "code@closedloop-ai", scope: "user" },
        ]),
    });
    // The gateway accepts the patch but the override survives — the machine
    // still cannot resolve `claude`, so the plugin rows stay blocked on the root.
    harness.deps.applyBinaryPathPatch = () => ({});

    const result = await repairHealthCheck(harness.deps);
    const enableStep = findStep(result, HealthCheckRepairAction.EnablePlugins);

    // Not one of the five doomed commands was sent.
    assert.deepEqual(harness.enableCalls, []);
    assert.equal(enableStep?.status, HealthCheckRepairStepStatus.Skipped);
    assert.match(enableStep?.detail ?? "", RE_CLAUDE_CLI);
    assert.ok((enableStep?.checkIds.length ?? 0) > 0);
  });

  test("runs the existing enable runner and returns the re-checked inventory", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    globalThis.fetch = (async () =>
      Response.json({ version: "1.0.0" })) as typeof fetch;
    let codeEnabled = false;
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      onEnable: () => {
        codeEnabled = true;
      },
      pluginListJson: () =>
        buildPluginListJson([
          {
            enabled: codeEnabled,
            id: "code@closedloop-ai",
            scope: "user",
            version: "1.0.0",
          },
        ]),
    });

    const result = await repairHealthCheck(harness.deps);

    // The runner was invoked with the plugin the checker said was disabled …
    assert.deepEqual(harness.enableCalls, ["code@closedloop-ai"]);
    // … and the response carries the RE-CHECKED inventory, not the pre-repair
    // one: the row the user was looking at is now green in place.
    const codePlugin = findPluginCheck(result.result.checks, "code");
    assert.equal(codePlugin?.passed, true);
    assert.equal(codePlugin?.enableAttempted, true);
    assert.equal(codePlugin?.enableOutcome, "success");

    const enableStep = findStep(result, HealthCheckRepairAction.EnablePlugins);
    assert.equal(enableStep?.status, HealthCheckRepairStepStatus.Succeeded);
    // A working override is never rewritten.
    assert.deepEqual(harness.patches, []);
  });

  test("a working override is left alone", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      pluginListJson: () => buildPluginListJson(),
    });

    const result = await repairHealthCheck(harness.deps);

    assert.deepEqual(harness.patches, []);
    assert.equal(
      findStep(result, HealthCheckRepairAction.ClearBinaryOverride),
      undefined
    );
  });

  test("a second press joins the in-flight repair instead of double-running", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    globalThis.fetch = (async () =>
      Response.json({ version: "1.0.0" })) as typeof fetch;
    let codeEnabled = false;
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      onEnable: () => {
        codeEnabled = true;
      },
      pluginListJson: () =>
        buildPluginListJson([
          {
            enabled: codeEnabled,
            id: "code@closedloop-ai",
            scope: "user",
            version: "1.0.0",
          },
        ]),
    });

    const [first, second] = await Promise.all([
      repairHealthCheck(harness.deps),
      repairHealthCheck(harness.deps),
    ]);

    assert.deepEqual(harness.enableCalls, ["code@closedloop-ai"]);
    assert.equal(first.joinedInFlight, undefined);
    assert.equal(second.joinedInFlight, true);
    assert.deepEqual(second.steps, first.steps);
  });

  test("a caller with different context does NOT inherit the first caller's verdict", async () => {
    // `latestVersion` is an input to the re-check the response carries, so
    // joining across contexts would cache one caller's app-version verdict under
    // the other caller's query key (ISS-5389 review).
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      pluginListJson: () => buildPluginListJson(),
    });
    harness.deps.getAppVersion = () => "1.0.0";
    // Classified as a packaged build so the version row actually compares
    // against the manifest; an unclassified build asserts nothing (ISS-5369).
    harness.deps.isPackagedBuild = () => true;

    const [behind, current] = await Promise.all([
      repairHealthCheck(harness.deps, { latestVersion: "9.9.9" }),
      repairHealthCheck(harness.deps, { latestVersion: "1.0.0" }),
    ]);

    const findAppVersion = (result: HealthCheckRepairResult) =>
      result.result.checks.find((check) => check.id === APP_VERSION_CHECK_ID);

    assert.equal(behind.joinedInFlight, undefined);
    assert.equal(current.joinedInFlight, undefined);
    // Each caller got the verdict for the version IT asked about. `passed` is
    // deliberately true on every version branch post-ISS-5369, so the verdict
    // lives in `severity` / `error` — assert there or this proves nothing.
    assert.equal(findAppVersion(behind)?.severity, CheckSeverity.Warning);
    assert.equal(findAppVersion(behind)?.error, "Update available: 9.9.9");
    assert.equal(findAppVersion(current)?.severity, CheckSeverity.Passed);
    assert.equal(findAppVersion(current)?.error, undefined);
  });

  test("a second press with identical context still joins", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      pluginListJson: () => buildPluginListJson(),
    });

    const [first, second] = await Promise.all([
      repairHealthCheck(harness.deps, { latestVersion: "9.9.9" }),
      repairHealthCheck(harness.deps, { latestVersion: "9.9.9" }),
    ]);

    assert.equal(first.joinedInFlight, undefined);
    assert.equal(second.joinedInFlight, true);
  });

  test("annotates failing rows the gateway cannot repair with a reason", async () => {
    const homeDir = await makeTempHome();
    // One plugin is genuinely absent — from the registry AND from
    // `claude plugin list` — so this test owns a failing row outright.
    //
    // It used to install everything and lean on the app-version row to supply
    // the failure, which it never can (`baseAppVersionResult` is `passed: true`
    // on every branch). The only thing left failing was the plugin VERSION
    // sweep, which `allPluginsInstalled` gates and which reaches
    // raw.githubusercontent.com over the real network — so the assertions below
    // silently depended on network availability and on the live contents of an
    // external repo, failing deterministically offline (ISS-5389 review).
    // A missing plugin is both a deterministic failure and short of
    // `allPluginsInstalled`, so the version sweep never runs and nothing here
    // touches the network.
    const missingPlugin = "judges";
    await writeAllUserScopedPlugins(homeDir, { "judges@closedloop-ai": [] });
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      pluginListJson: () =>
        JSON.stringify(
          CLOSEDLOOP_PLUGINS.filter(
            (plugin) => plugin.folder !== missingPlugin
          ).map((plugin) => ({
            enabled: true,
            id: plugin.key,
            scope: "user",
            version: "1.0.0",
          }))
        ),
    });
    harness.deps.getAppVersion = () => "0.1.0";

    const result = await repairHealthCheck(harness.deps, {
      latestVersion: "9.9.9",
    });
    const failing = result.result.checks.filter((check) => !check.passed);

    // The row this test owns: absent, so Repair must say so rather than claim
    // an action it does not have.
    const missingRow = findPluginCheck(result.result.checks, missingPlugin);
    assert.equal(missingRow?.passed, false);
    assert.equal(missingRow?.repair?.repairable, false);

    // The whole point of the annotation: a red row is never a dead affordance.
    assert.ok(failing.length > 0, "expected at least one failing row");
    for (const check of failing) {
      assert.ok(check.repair, `${check.id} failed without a repair annotation`);
      if (check.repair?.repairable === false) {
        assert.ok(
          (check.repair.reason ?? "").length > 0,
          `${check.id} is not repairable but gives no reason`
        );
      }
    }

    // A plugin that is not installed states plainly that Repair cannot install
    // it, rather than offering a control that would do nothing. Asserted on the
    // row this test deliberately left absent — it used to key off `plugin-code`,
    // which only failed because the networked plugin-version sweep failed with
    // it (ISS-5389 review).
    assert.match(missingRow?.repair?.reason ?? "", RE_THAT_MACHINE);
  });

  test("the POST route serves the repair through the gateway dispatcher", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeHarness({
      claudeOverride: "/usr/bin/true",
      pluginListJson: () => buildPluginListJson(),
    });
    const dispatcher = new OperationDispatcher();
    registerHealthCheckRepairRoutes(dispatcher, harness.deps);

    const captured = makeResponse();
    const handled = await dispatcher.dispatch({
      method: "POST",
      pathname: "/api/gateway/health-check/repair",
      params: {},
      query: new URLSearchParams(),
      rawBody: Buffer.alloc(0),
      body: "",
      request: {} as IncomingMessage,
      response: captured.response,
    });

    assert.equal(handled, true);
    assert.equal(captured.statusCode, 200);
    const payload = parsePayload(captured);
    assert.ok(Array.isArray(payload.steps));
    assert.ok(getChecks(payload.result as Record<string, unknown>).length > 0);
  });
});
