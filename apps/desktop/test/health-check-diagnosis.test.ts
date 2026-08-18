import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  CheckSeverity,
  resolveCheckSeverity,
} from "@closedloop-ai/loops-api/compute-target";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { _setRunCommandForTesting } from "../src/server/operations/health-check.js";
import {
  checkAppVersion,
  classifyGatewayBuild,
  GatewayBuildKind,
} from "../src/server/operations/health-check-app-version.js";
import {
  applyClaudeCliBlockedChecks,
  CLAUDE_CLI_CHECK_ID,
} from "../src/server/operations/health-check-blocked.js";
import type { GatewayCheckResult as CheckResult } from "../src/server/operations/health-check-types.js";
import { GatewayRouter } from "../src/server/router.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  createInstallPath,
  dispatchHealthCheck,
  findAppVersion,
  findCheck,
  findPluginCheck,
  getChecks,
  makeTempHome,
  parsePayload,
  registerHealthCheckWithAppVersion,
  registerHealthCheckWithPluginList,
  registerHealthCheckWithStubbedBinaries,
  removeTempHomes,
  writeAllUserScopedPlugins,
} from "./fixtures/health-check-route.js";
import { dispatchMockRequest } from "./gateway-server-test-doubles.js";

const originalHome = process.env.HOME;
const serversToClose: DesktopGatewayServer[] = [];

afterEach(async () => {
  _setRunCommandForTesting();
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }
  await removeTempHomes();
});

const NOT_VERIFIED_REGEX = /not verified/i;
const LOCAL_BUILD_VERSION_REGEX = /^1\.0\.0 \(local build/;
const CLAUDE_CLI_REMEDIATION =
  "Update binary path in Settings, or clear the override";
const CLAUDE_CLI_FALLBACK_REMEDIATION = "Fix the Claude CLI check first";
const PLUGIN_ENABLE_REMEDIATION =
  "Run: claude plugin enable code@closedloop-ai --scope user, then rerun System Check";

function failingClaudeCli(): CheckResult {
  return {
    id: CLAUDE_CLI_CHECK_ID,
    label: "Claude CLI",
    required: true,
    passed: false,
    error: "Override path does not exist or is not executable",
    remediation: CLAUDE_CLI_REMEDIATION,
  };
}

/** The row `checkPlugin` emits when `claude plugin list` could not be read. */
function unverifiedPluginCheck(folder: string): CheckResult {
  return {
    id: `plugin-${folder}`,
    label: folder,
    required: true,
    passed: false,
    severity: CheckSeverity.Unknown,
    error: "Could not verify enabled state",
    remediation: PLUGIN_ENABLE_REMEDIATION,
  };
}

describe("ISS-5369 Part 1: the Claude CLI cascade", () => {
  test("unresolvable Claude binary yields blocked plugin rows, not five failures", () => {
    const folders = [
      "code",
      "code-review",
      "judges",
      "platform",
      "self-learning",
    ];
    const result = applyClaudeCliBlockedChecks(
      folders.map(unverifiedPluginCheck),
      failingClaudeCli()
    );

    assert.equal(result.length, 5);
    for (const check of result) {
      assert.equal(
        resolveCheckSeverity(check),
        CheckSeverity.Blocked,
        `${check.id} must read as blocked, not as a proven failure`
      );
      assert.equal(check.blockedBy, CLAUDE_CLI_CHECK_ID);
      assert.notEqual(check.error, "Could not verify enabled state");
    }

    // The distinction that matters: none of these rows still claims a fault of
    // its own, and none is a plain `error`.
    assert.equal(
      result.filter((c) => resolveCheckSeverity(c) === CheckSeverity.Error)
        .length,
      0
    );
  });

  test("no blocked row shows a remediation that cannot succeed", () => {
    const result = applyClaudeCliBlockedChecks(
      [unverifiedPluginCheck("code")],
      failingClaudeCli()
    );

    const [blocked] = result;
    assert.ok(
      !blocked.remediation?.includes("claude plugin enable"),
      `blocked row must not tell the user to run a claude subcommand while the binary is unresolvable, got: ${blocked.remediation}`
    );
    // It points at the one row that IS actionable, reusing that row's own text.
    assert.ok(blocked.remediation?.includes(CLAUDE_CLI_REMEDIATION));
  });

  test("blocked rows retain generic guidance when the Claude CLI has no remediation detail", () => {
    const [blocked] = applyClaudeCliBlockedChecks(
      [unverifiedPluginCheck("code")],
      {
        passed: false,
        remediation: undefined,
      }
    );

    assert.equal(blocked.remediation, CLAUDE_CLI_FALLBACK_REMEDIATION);
  });

  test("a plugin proven disabled keeps its own actionable remediation", () => {
    const disabled: CheckResult = {
      id: "plugin-code",
      label: "code",
      required: true,
      passed: false,
      error: "Disabled",
      remediation: "Run: claude plugin enable code@closedloop-ai --scope user",
    };

    const [result] = applyClaudeCliBlockedChecks(
      [disabled],
      failingClaudeCli()
    );

    assert.deepEqual(result, disabled);
    assert.equal(resolveCheckSeverity(result), CheckSeverity.Error);
  });

  test("a passing Claude CLI leaves unverified rows untouched", () => {
    const unverified = unverifiedPluginCheck("code");
    const [result] = applyClaudeCliBlockedChecks([unverified], {
      passed: true,
      remediation: undefined,
    });

    assert.deepEqual(result, unverified);
    assert.equal(result.blockedBy, undefined);
  });

  test("an absent Claude CLI row cannot manufacture a blocked state", () => {
    const unverified = unverifiedPluginCheck("code");
    const [result] = applyClaudeCliBlockedChecks([unverified], undefined);

    assert.deepEqual(result, unverified);
  });
});

describe("ISS-5369 Part 3: Gateway Version", () => {
  test("classifies the build from app.isPackaged, and stays unknown without it", () => {
    assert.equal(classifyGatewayBuild(false), GatewayBuildKind.Source);
    assert.equal(classifyGatewayBuild(true), GatewayBuildKind.Packaged);
    assert.equal(classifyGatewayBuild(undefined), GatewayBuildKind.Unknown);
  });

  test("a source build never reports an update, and never blocks", () => {
    const result = checkAppVersion(
      "0.16.69",
      "0.99.0",
      GatewayBuildKind.Source,
      "cb5bc5cae2f5b40b388282d3fa5b13c98b50e303"
    );

    assert.equal(result.required, false, "a version finding must not block");
    assert.equal(resolveCheckSeverity(result), CheckSeverity.Passed);
    assert.equal(result.error, undefined);
    assert.ok(
      !JSON.stringify(result).includes("Update available"),
      "comparing a dev build against the release manifest is a category error"
    );
    assert.equal(result.version, "0.16.69 (local build cb5bc5c)");
  });

  test("a packaged build behind the manifest warns, and still does not block", () => {
    const result = checkAppVersion(
      "0.16.69",
      "0.17.0",
      GatewayBuildKind.Packaged
    );

    assert.equal(result.required, false);
    assert.equal(
      result.passed,
      true,
      "an old web build must not block on this"
    );
    assert.equal(resolveCheckSeverity(result), CheckSeverity.Warning);
    assert.equal(result.error, "Update available: 0.17.0");
  });

  test("a packaged build at the latest version passes clean", () => {
    const result = checkAppVersion(
      "0.17.0",
      "0.17.0",
      GatewayBuildKind.Packaged
    );

    assert.equal(resolveCheckSeverity(result), CheckSeverity.Passed);
    assert.equal(result.error, undefined);
    assert.equal(result.required, false);
  });

  test("an unclassifiable build reports unknown, not out-of-date", () => {
    const result = checkAppVersion(
      "0.16.69",
      "0.17.0",
      GatewayBuildKind.Unknown
    );

    assert.equal(resolveCheckSeverity(result), CheckSeverity.Unknown);
    assert.ok(!result.error?.includes("Update available"));
    assert.equal(result.required, false);
  });

  test("an unclassifiable build at or ahead of the manifest is still unknown", () => {
    // `Unknown` means no release claim is supported at all, so a build that
    // happens to compare >= the manifest must not fall through as Passed —
    // it may not be in the published-release sequence in the first place.
    for (const current of ["0.17.0", "0.18.0"]) {
      const result = checkAppVersion(
        current,
        "0.17.0",
        GatewayBuildKind.Unknown
      );

      assert.equal(
        resolveCheckSeverity(result),
        CheckSeverity.Unknown,
        `${current} against 0.17.0 must not claim a verified release state`
      );
      assert.match(result.error ?? "", NOT_VERIFIED_REGEX);
      assert.equal(result.required, false);
    }
  });

  test("a packaged build with no release manifest reports unknown, not nothing", () => {
    const result = checkAppVersion(
      "0.16.69",
      undefined,
      GatewayBuildKind.Packaged
    );

    assert.equal(resolveCheckSeverity(result), CheckSeverity.Unknown);
    assert.match(result.error ?? "", NOT_VERIFIED_REGEX);
    assert.equal(result.version, "0.16.69");
    assert.equal(result.required, false);
  });

  test("a source build needs no release manifest at all", () => {
    const result = checkAppVersion(
      "1.0.0",
      undefined,
      GatewayBuildKind.Source,
      "cb5bc5cae2f5b40b388282d3fa5b13c98b50e303"
    );

    assert.equal(resolveCheckSeverity(result), CheckSeverity.Passed);
    assert.equal(result.error, undefined);
    assert.equal(result.version, "1.0.0 (local build cb5bc5c)");
  });

  test("an unparseable version reports unknown rather than a failure", () => {
    const result = checkAppVersion(
      "not-a-version",
      "0.17.0",
      GatewayBuildKind.Packaged
    );

    assert.equal(resolveCheckSeverity(result), CheckSeverity.Unknown);
    assert.equal(result.required, false);
    assert.equal(result.passed, true);
  });
});

describe("ISS-5369: severity is version-skew tolerant in both directions", () => {
  test("a gateway that omits severity falls back to the legacy derivation", () => {
    assert.equal(resolveCheckSeverity({ passed: false }), CheckSeverity.Error);
    assert.equal(
      resolveCheckSeverity({ passed: true, error: "Update available: 1.0.0" }),
      CheckSeverity.Warning
    );
    assert.equal(resolveCheckSeverity({ passed: true }), CheckSeverity.Passed);
  });

  test("a severity this build does not know falls back rather than breaking", () => {
    const fromNewerGateway = {
      passed: false,
      error: "something new",
      severity: "quarantined" as unknown as CheckSeverity,
    };

    assert.equal(resolveCheckSeverity(fromNewerGateway), CheckSeverity.Error);
  });
});

describe("ISS-5369 Part 1: the cascade through the real health-check route", () => {
  test("a stale Claude binary override blocks the plugin rows instead of failing five of them", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const dispatcher = new OperationDispatcher();
    // A binary-path override pointing at a path that does not exist — exactly
    // the fault Mike hit. `resolveBinaryFromLoginShell` reports
    // `override_invalid`, so `claude plugin list --json` never runs.
    registerHealthCheckWithStubbedBinaries(dispatcher, {
      claude: path.join(homeDir, "does", "not", "exist", "claude"),
    });

    const payload = parsePayload(await dispatchHealthCheck(dispatcher));
    const claudeCli = findCheck(payload, CLAUDE_CLI_CHECK_ID);
    const checks = getChecks(payload);

    // The one real fault still reads as a real fault.
    assert.equal(claudeCli?.passed, false);
    assert.equal(
      resolveCheckSeverity(claudeCli as CheckResult),
      CheckSeverity.Error
    );

    const pluginRows = checks.filter((check) => check.id.startsWith("plugin-"));
    assert.equal(pluginRows.length, 5);
    for (const row of pluginRows) {
      assert.equal(
        resolveCheckSeverity(row as CheckResult),
        CheckSeverity.Blocked,
        `${row.id} must be blocked, not a fabricated "could not verify" failure`
      );
      assert.equal(row.blockedBy, CLAUDE_CLI_CHECK_ID);
      assert.ok(
        !row.remediation?.includes("claude plugin enable"),
        `${row.id} must not prescribe a command that cannot succeed: ${row.remediation}`
      );
    }

    // One actionable fault across the Claude CLI + plugin rows, not six.
    // (Other rows in this harness fail for unrelated environment reasons —
    // scope the count to the group the cascade actually spans.)
    const cascadeRows = checks.filter(
      (check) =>
        check.id === CLAUDE_CLI_CHECK_ID || check.id.startsWith("plugin-")
    );
    assert.equal(cascadeRows.length, 6);
    assert.deepEqual(
      cascadeRows
        .filter(
          (check) =>
            resolveCheckSeverity(check as CheckResult) === CheckSeverity.Error
        )
        .map((check) => check.id),
      [CLAUDE_CLI_CHECK_ID]
    );
  });

  test("a plugin the registry proves disabled stays Disabled when plugin list is unavailable", async () => {
    // Both signals fire at once here: `claude plugin list` cannot be read (so
    // the enabled state is unverified) AND the local registry entry says
    // `enabled: false` (so it is provably disabled). The proven finding must
    // win, because "Disabled" is directly fixable and "could not verify" is
    // not.
    const homeDir = await makeTempHome();
    const installPath = await createInstallPath(homeDir, "code");
    await writeAllUserScopedPlugins(homeDir, {
      "code@closedloop-ai": [
        { enabled: false, installPath, scope: "user", version: "1.0.0" },
      ],
    });
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, null);

    const payload = parsePayload(await dispatchHealthCheck(dispatcher));
    const code = findPluginCheck(getChecks(payload), "code");

    assert.equal(code?.error, "Disabled");
    assert.equal(
      resolveCheckSeverity(code as CheckResult),
      CheckSeverity.Error,
      "a proven-disabled plugin is a real finding, not an unknown"
    );
    assert.ok(code?.remediation?.includes("claude plugin enable"));

    // Its siblings, which the registry does NOT prove disabled, stay unknown.
    const judges = findPluginCheck(getChecks(payload), "judges");
    assert.equal(
      resolveCheckSeverity(judges as CheckResult),
      CheckSeverity.Unknown
    );
  });
});

describe("app-version check (ISS-5369: warn, never block)", () => {
  test("keeps the row when no release manifest arrived, rather than dropping it", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(
      dispatcher,
      () => "1.0.0",
      () => true
    );

    const captured = await dispatchHealthCheck(dispatcher);
    const payload = parsePayload(captured);
    const appVersion = findAppVersion(payload);

    assert.ok(
      appVersion,
      "a missing release manifest must not remove the Gateway Version row"
    );
    assert.equal(appVersion.severity, CheckSeverity.Unknown);
    assert.equal(appVersion.version, "1.0.0");
    assert.match(appVersion.error ?? "", NOT_VERIFIED_REGEX);
    assert.ok(!blockingFailureIds(payload).includes("app-version"));
  });

  test("a source build still reports its local build with no manifest", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(
      dispatcher,
      () => "1.0.0",
      () => false
    );

    const captured = await dispatchHealthCheck(dispatcher);
    const appVersion = findAppVersion(parsePayload(captured));

    assert.equal(appVersion?.severity, CheckSeverity.Passed);
    assert.match(appVersion?.version ?? "", LOCAL_BUILD_VERSION_REGEX);
    assert.equal(appVersion?.error, undefined);
  });

  test("passes when latestVersion equals currentVersion", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(
      dispatcher,
      () => "1.0.0",
      () => true
    );

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "1.0.0",
    });
    const appVersion = findAppVersion(parsePayload(captured));

    assert.deepEqual(appVersion, {
      id: "app-version",
      label: "Gateway Version",
      required: false,
      passed: true,
      version: "1.0.0",
      severity: CheckSeverity.Passed,
    });
  });

  test("a packaged build behind the manifest warns without blocking the command", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(
      dispatcher,
      () => "1.0.0",
      () => true
    );

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "2.0.0",
    });
    const payload = parsePayload(captured);
    const appVersion = findAppVersion(payload);

    assert.equal(appVersion?.required, false);
    assert.equal(appVersion?.severity, CheckSeverity.Warning);
    assert.equal(appVersion?.version, "1.0.0");
    assert.equal(appVersion?.error, "Update available: 2.0.0");
    assert.ok(appVersion?.remediation);
    // The point of the change: a newer release existing no longer stops the
    // user from running the command. (Other rows can fail for unrelated
    // environment reasons in this harness, so assert on the blocking SET.)
    assert.ok(!blockingFailureIds(payload).includes("app-version"));
  });

  test("a source build never claims an update is available", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(
      dispatcher,
      () => "1.0.0",
      () => false
    );

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "2.0.0",
    });
    const payload = parsePayload(captured);
    const appVersion = findAppVersion(payload);

    assert.equal(appVersion?.severity, CheckSeverity.Passed);
    assert.equal(appVersion?.error, undefined);
    assert.match(appVersion?.version ?? "", LOCAL_BUILD_VERSION_REGEX);
    assert.ok(!blockingFailureIds(payload).includes("app-version"));
  });

  test("an unclassifiable build reports unknown rather than out-of-date", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(dispatcher, () => "1.0.0");

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "2.0.0",
    });
    const appVersion = findAppVersion(parsePayload(captured));

    assert.equal(appVersion?.severity, CheckSeverity.Unknown);
    assert.equal(appVersion?.required, false);
    assert.ok(!appVersion?.error?.includes("Update available"));
  });

  test("omits app-version when getAppVersion is not provided", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(dispatcher);

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "2.0.0",
    });
    const payload = parsePayload(captured);

    assert.equal(findAppVersion(payload), undefined);
  });

  test("omits app-version when getAppVersion returns undefined", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(dispatcher, () => undefined);

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "2.0.0",
    });
    const payload = parsePayload(captured);

    assert.equal(findAppVersion(payload), undefined);
  });

  test("reports unrecognized formats as unknown without failing the health check", async () => {
    const cases: Array<{
      name: string;
      currentVersion: string;
      latestVersion: string;
    }> = [
      { name: "current", currentVersion: "dev-build", latestVersion: "2.0.0" },
      { name: "latest", currentVersion: "1.0.0", latestVersion: "latest" },
    ];

    for (const testCase of cases) {
      const dispatcher = new OperationDispatcher();
      registerHealthCheckWithAppVersion(
        dispatcher,
        () => testCase.currentVersion,
        () => true
      );

      const captured = await dispatchHealthCheck(dispatcher, {
        latestVersion: testCase.latestVersion,
      });
      const appVersion = findAppVersion(parsePayload(captured));

      assert.equal(appVersion?.required, false, testCase.name);
      assert.equal(appVersion?.passed, true, testCase.name);
      assert.equal(appVersion?.severity, CheckSeverity.Unknown, testCase.name);
      assert.match(appVersion?.error ?? "", NOT_VERIFIED_REGEX, testCase.name);
    }
  });

  test("normalizes a leading v prefix before comparing and formatting the update warning", async () => {
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithAppVersion(
      dispatcher,
      () => "1.0.0",
      () => true
    );

    const captured = await dispatchHealthCheck(dispatcher, {
      latestVersion: "v2.0.0",
    });
    const appVersion = findAppVersion(parsePayload(captured));

    assert.equal(appVersion?.required, false);
    assert.equal(appVersion?.severity, CheckSeverity.Warning);
    assert.equal(appVersion?.version, "1.0.0");
    assert.equal(appVersion?.error, "Update available: 2.0.0");
  });
});

describe("ISS-5369: isPackagedBuild reaches the route through real wiring", () => {
  // The suites above inject `isPackagedBuild` straight into
  // `registerHealthCheckRoutes`, which proves the check but NOT that anything
  // hands it that value in production. These two drive the same route through
  // the real `GatewayRouter` and the real `DesktopGatewayServer`, so dropping
  // the option from either forwarding hop turns them red.
  test("GatewayRouter forwards isPackagedBuild to the Gateway Version check", async () => {
    const router = new GatewayRouter({
      webAppOrigin: "https://app.closedloop.ai",
      getAllowedDirectories: () => [os.tmpdir()],
      machineName: "health-check-wiring-machine",
      version: "1.0.0",
      capabilities: EMPTY_CAPABILITIES,
      getActivePort: () => 0,
      getGatewayId: () => "test-gateway-id",
      schedulers: new LoopSchedulerContext(),
      isPackagedBuild: () => false,
    });

    const response = await dispatchMockRequest({
      router,
      method: "GET",
      path: "/api/gateway/health-check?latestVersion=99.0.0",
    });

    assert.equal(response.statusCode, 200);
    const appVersion = findAppVersion(
      response.json() as Record<string, unknown>
    );
    assert.equal(appVersion?.severity, CheckSeverity.Passed);
    assert.match(appVersion?.version ?? "", LOCAL_BUILD_VERSION_REGEX);
  });

  test("DesktopGatewayServer forwards isPackagedBuild to the Gateway Version check", async () => {
    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.closedloop.ai",
      getAllowedDirectories: () => [os.tmpdir()],
      machineName: "health-check-wiring-machine",
      version: "1.0.0",
      capabilities: EMPTY_CAPABILITIES,
      discoveryFilePath: path.join(await makeTempHome(), "electron-port"),
      getGatewayId: () => "test-gateway-id",
      isPackagedBuild: () => true,
    });
    serversToClose.push(server);
    await server.start();

    const res = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check?latestVersion=99.0.0`
    );

    assert.equal(res.status, 200);
    const appVersion = findAppVersion(
      (await res.json()) as Record<string, unknown>
    );
    // Packaged and behind the manifest: a warning, never a source-build row.
    assert.equal(appVersion?.severity, CheckSeverity.Warning);
    assert.equal(appVersion?.error, "Update available: 99.0.0");
  });
});

/** Ids of the required checks that would block the command. */
function blockingFailureIds(payload: Record<string, unknown>): string[] {
  return getChecks(payload)
    .filter((check) => check.required && !check.passed)
    .map((check) => check.id);
}
