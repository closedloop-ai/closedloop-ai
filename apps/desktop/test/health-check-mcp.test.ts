import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, mock, test } from "node:test";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { Observability } from "../src/main/telemetry/observability.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _applyPluginVersionChecksForTesting,
  _getPluginUpdateStderrTailForTesting,
  _setPluginEnableCommandForTesting,
  _setPluginMarketplaceUpdateCommandForTesting,
  _setPluginRemediationDeadlineMsForTesting,
  _setPluginUpdateCommandForTesting,
  _setRunCommandForTesting,
  _shouldEnablePluginAutoUpdateForTesting,
  registerHealthCheckRoutes,
} from "../src/server/operations/health-check.js";
import { PLUGIN_LIST_COMMAND_FAILED_ERROR } from "../src/server/operations/health-check-types.js";
import type { McpDetectionResult } from "../src/server/operations/mcp-detection.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  assertInjectedMcpServers,
  buildPluginListJson,
  type CheckResultPayload,
  CLOSEDLOOP_PLUGINS,
  dispatchHealthCheck,
  findPluginCheck,
  getChecks,
  makeTempHome,
  parsePayload,
  registerHealthCheckWithPluginList,
  registerHealthCheckWithStubbedBinaries,
  removeTempHomes,
  writeAllUserScopedPlugins,
  writePluginRegistry,
} from "./fixtures/health-check-route.js";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

afterEach(async () => {
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  _setPluginEnableCommandForTesting();
  _setPluginMarketplaceUpdateCommandForTesting();
  _setPluginRemediationDeadlineMsForTesting();
  _setPluginUpdateCommandForTesting();
  _setRunCommandForTesting();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await removeTempHomes();
  await Observability.shutdown();
  Observability.reset();
});

function mockPluginManifestVersion(version: string): void {
  globalThis.fetch = (async () => Response.json({ version })) as typeof fetch;
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function writeDirectoryMarketplace(version: string): Promise<string> {
  const marketplaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "closedloop-marketplace-")
  );
  tempDirs.push(marketplaceRoot);
  await fs.mkdir(path.join(marketplaceRoot, ".claude-plugin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "closedloop-ai",
      plugins: CLOSEDLOOP_PLUGINS.map((plugin) => ({
        name: plugin.folder,
        source: `./plugins/${plugin.folder}`,
      })),
    })
  );
  for (const plugin of CLOSEDLOOP_PLUGINS) {
    const pluginManifestDir = path.join(
      marketplaceRoot,
      "plugins",
      plugin.folder,
      ".claude-plugin"
    );
    await fs.mkdir(pluginManifestDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginManifestDir, "plugin.json"),
      JSON.stringify({ name: plugin.folder, version })
    );
  }
  return marketplaceRoot;
}

function buildInstalledPluginVersions(version: string): Record<string, string> {
  return Object.fromEntries(
    CLOSEDLOOP_PLUGINS.map((plugin) => [plugin.key, version])
  );
}

function buildPassingPluginChecks(): CheckResultPayload[] {
  return CLOSEDLOOP_PLUGINS.map((plugin) => ({
    id: `plugin-${plugin.folder}`,
    label: plugin.label,
    required: true,
    passed: true,
  }));
}

function stubSuccessfulMarketplaceUpdate(): void {
  _setPluginMarketplaceUpdateCommandForTesting(async () => ({
    outcome: "success",
    stdout: "",
    elapsedMs: 5,
  }));
}

describe("registerHealthCheckRoutes — MCP injection", () => {
  const expectedMcpUrl = "https://mcp.closedloop.ai/mcp";

  test("response includes mcpServers from injected detectMcp stub", async () => {
    const dispatcher = new OperationDispatcher();
    const claudeStub: McpDetectionResult = {
      available: true,
      serverName: "team-prod",
      matchedUrl: expectedMcpUrl,
      checkedAt: "2026-04-12T00:00:00.000Z",
      closedloopAvailable: true,
    };
    const codexStub: McpDetectionResult = {
      available: false,
      serverName: "team-prod",
      matchedUrl: expectedMcpUrl,
      checkedAt: "2026-04-12T00:00:00.000Z",
      closedloopAvailable: false,
    };
    const detectMcp = async (
      provider: "claude" | "codex",
      _expectedMcpUrl?: string
    ): Promise<McpDetectionResult> =>
      provider === "claude" ? claudeStub : codexStub;

    registerHealthCheckRoutes(
      dispatcher,
      {} as unknown as ProcessManager,
      () => os.tmpdir(),
      detectMcp
    );

    const captured = await dispatchHealthCheck(dispatcher, { expectedMcpUrl });
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.ended, true);

    const payload = parsePayload(captured);
    getChecks(payload);
    assert.equal(typeof payload.allRequiredPassed, "boolean");

    const mcpServers = payload.mcpServers as Record<string, unknown>;
    assertInjectedMcpServers(mcpServers, claudeStub, codexStub);
  });

  test("invokes detectMcp once per provider with the correct argument", async () => {
    const dispatcher = new OperationDispatcher();
    const calls: Array<{
      provider: "claude" | "codex";
      expectedMcpUrl?: string;
    }> = [];
    const detectMcp = async (
      provider: "claude" | "codex",
      expectedMcpUrlArg?: string
    ): Promise<McpDetectionResult> => {
      calls.push({ provider, expectedMcpUrl: expectedMcpUrlArg });
      return {
        available: true,
        serverName: "team-prod",
        matchedUrl: expectedMcpUrl,
        checkedAt: "2026-04-12T00:00:00.000Z",
        closedloopAvailable: true,
      };
    };

    registerHealthCheckRoutes(
      dispatcher,
      {} as unknown as ProcessManager,
      () => os.tmpdir(),
      detectMcp
    );

    await dispatchHealthCheck(dispatcher, { expectedMcpUrl });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, [
      { provider: "claude", expectedMcpUrl },
      { provider: "codex", expectedMcpUrl },
    ]);
  });

  test("includes mcpServers even when both providers report unavailable", async () => {
    const dispatcher = new OperationDispatcher();
    const detectMcp = async (): Promise<McpDetectionResult> => ({
      available: false,
      serverName: null,
      matchedUrl: null,
      checkedAt: "2026-04-12T00:00:00.000Z",
      closedloopAvailable: false,
    });

    registerHealthCheckRoutes(
      dispatcher,
      {} as unknown as ProcessManager,
      () => os.tmpdir(),
      detectMcp
    );

    const captured = await dispatchHealthCheck(dispatcher, { expectedMcpUrl });
    const payload = parsePayload(captured);
    const mcpServers = payload.mcpServers as Record<
      string,
      {
        available: boolean;
        serverName: string | null;
        closedloopAvailable: boolean;
      }
    >;
    assert.equal(mcpServers.claude.available, false);
    assert.equal(mcpServers.claude.serverName, null);
    assert.equal(mcpServers.claude.closedloopAvailable, false);
    assert.equal(mcpServers.codex.available, false);
    assert.equal(mcpServers.codex.serverName, null);
    assert.equal(mcpServers.codex.closedloopAvailable, false);
  });
});

describe("plugin health checks", () => {
  test("fails project-scoped plugin entries with user-scope remediation", async () => {
    const homeDir = await makeTempHome();
    const projectPath = path.join(homeDir, "project");
    const projectInstallPath = path.join(projectPath, "code-plugin");
    await fs.mkdir(projectInstallPath, { recursive: true });
    await writeAllUserScopedPlugins(homeDir, {
      "code@closedloop-ai": [
        {
          installPath: projectInstallPath,
          projectPath,
          scope: "project",
          version: "1.0.0",
        },
      ],
    });
    const pluginListJson = JSON.stringify(
      CLOSEDLOOP_PLUGINS.map((plugin) =>
        plugin.folder === "code"
          ? {
              id: plugin.key,
              projectPath,
              scope: "project",
              version: "1.0.0",
            }
          : {
              enabled: true,
              id: plugin.key,
              scope: "user",
              version: "1.0.0",
            }
      )
    );
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, pluginListJson);

    const captured = await dispatchHealthCheck(dispatcher);
    const payload = parsePayload(captured);
    const codePlugin = findPluginCheck(getChecks(payload), "code");

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.error, "Installed at project scope");
    assert.match(
      codePlugin?.remediation ?? "",
      /claude plugin uninstall code@closedloop-ai --scope project/
    );
    assert.match(
      codePlugin?.remediation ?? "",
      /claude plugin install code@closedloop-ai --scope user/
    );
    assert.equal(payload.allRequiredPassed, false);
  });

  test("fails project-scoped plugin entries without projectPath with user-scope remediation", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir, {
      "code@closedloop-ai": [
        {
          scope: "project",
          version: "1.0.0",
        },
      ],
    });
    const pluginListJson = JSON.stringify(
      CLOSEDLOOP_PLUGINS.map((plugin) =>
        plugin.folder === "code"
          ? {
              id: plugin.key,
              scope: "project",
              version: "1.0.0",
            }
          : {
              enabled: true,
              id: plugin.key,
              scope: "user",
              version: "1.0.0",
            }
      )
    );
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, pluginListJson);

    const captured = await dispatchHealthCheck(dispatcher);
    const payload = parsePayload(captured);
    const codePlugin = findPluginCheck(getChecks(payload), "code");

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.error, "Installed at project scope");
    assert.match(
      codePlugin?.remediation ?? "",
      /claude plugin uninstall code@closedloop-ai --scope project/
    );
    assert.match(
      codePlugin?.remediation ?? "",
      /claude plugin install code@closedloop-ai --scope user/
    );
    assert.equal(payload.allRequiredPassed, false);
  });

  test("fails disabled user-scoped entries with enable remediation", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const pluginListJson = buildPluginListJson([
      {
        enabled: false,
        id: "code@closedloop-ai",
        scope: "user",
        version: "1.0.0",
      },
    ]);
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, pluginListJson);

    const captured = await dispatchHealthCheck(dispatcher);
    const codePlugin = findPluginCheck(
      getChecks(parsePayload(captured)),
      "code"
    );

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.error, "Disabled");
    assert.equal(
      codePlugin?.remediation,
      "Run: claude plugin enable code@closedloop-ai --scope user"
    );
  });

  test("fails user-scoped entries when enabled state cannot be verified", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, null);

    const captured = await dispatchHealthCheck(dispatcher);
    const codePlugin = findPluginCheck(
      getChecks(parsePayload(captured)),
      "code"
    );

    assert.equal(codePlugin?.passed, false);
    // ISS-5810: an unrunnable `claude plugin list` says so, and never
    // prescribes `claude plugin enable` (it fails once already enabled).
    assert.equal(codePlugin?.error, PLUGIN_LIST_COMMAND_FAILED_ERROR);
    assert.ok(!codePlugin?.remediation?.includes("plugin enable"));
  });

  test("passes enabled user-scoped entries and omits bootstrap readiness", async () => {
    const homeDir = await makeTempHome();
    const projectPath = path.join(homeDir, "project");
    const projectInstallPath = path.join(projectPath, "code-plugin");
    await fs.mkdir(projectInstallPath, { recursive: true });
    const allEntries = await writeAllUserScopedPlugins(homeDir);
    await writePluginRegistry(homeDir, {
      ...allEntries,
      "code@closedloop-ai": [
        {
          installPath: projectInstallPath,
          projectPath,
          scope: "project",
          version: "0.9.0",
        },
        ...(allEntries["code@closedloop-ai"] ?? []),
      ],
    });
    mockPluginManifestVersion("1.0.0");
    const pluginListJson = buildPluginListJson([
      {
        id: "code@closedloop-ai",
        projectPath,
        scope: "project",
        version: "0.9.0",
      },
    ]);
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, pluginListJson);

    const captured = await dispatchHealthCheck(dispatcher);
    const checks = getChecks(parsePayload(captured));
    const codePlugin = findPluginCheck(checks, "code");
    const bootstrapPlugin = findPluginCheck(checks, "bootstrap");

    assert.equal(codePlugin?.passed, true);
    assert.equal(codePlugin?.version, "1.0.0");
    assert.equal(bootstrapPlugin, undefined);
  });

  test("auto-enables disabled user-scoped plugin and verifies post-state", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    mockPluginManifestVersion("1.0.0");
    let codeEnabled = false;
    const enableCalls: string[] = [];
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, () =>
      buildPluginListJson([
        {
          enabled: codeEnabled,
          id: "code@closedloop-ai",
          scope: "user",
          version: "1.0.0",
        },
      ])
    );
    _setPluginEnableCommandForTesting(async (pluginRef) => {
      enableCalls.push(pluginRef);
      codeEnabled = true;
      return { outcome: "success", stdout: "", elapsedMs: 1 };
    });

    const captured = await dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: true,
    });
    const payload = parsePayload(captured);
    const codePlugin = findPluginCheck(getChecks(payload), "code");

    assert.equal(codePlugin?.passed, true);
    assert.equal(codePlugin?.enableAttempted, true);
    assert.equal(codePlugin?.enableOutcome, "success");
    assert.deepEqual(codePlugin?.enablePluginIds, ["code@closedloop-ai"]);
    assert.deepEqual(enableCalls, ["code@closedloop-ai"]);
  });

  test("plugin enable deadline returns timeout metadata and skips remaining enable runners", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    _setPluginRemediationDeadlineMsForTesting(10);
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const enableCalls: string[] = [];
    const enableStarted = createDeferred();
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, () =>
      buildPluginListJson([
        {
          enabled: false,
          id: "code@closedloop-ai",
          scope: "user",
          version: "1.0.0",
        },
        {
          enabled: false,
          id: "platform@closedloop-ai",
          scope: "user",
          version: "1.0.0",
        },
      ])
    );
    _setPluginEnableCommandForTesting((pluginRef) => {
      enableCalls.push(pluginRef);
      enableStarted.resolve();
      return new Promise<never>(() => {});
    });

    const capturedPromise = dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: true,
    });
    await enableStarted.promise;
    mock.timers.tick(10);
    const captured = await capturedPromise;
    const checks = getChecks(parsePayload(captured));
    const codePlugin = findPluginCheck(checks, "code");
    const platformPlugin = findPluginCheck(checks, "platform");

    assert.equal(captured.statusCode, 200);
    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.enableAttempted, true);
    assert.equal(codePlugin?.enableOutcome, "timeout");
    assert.equal(codePlugin?.error, "Enable timed out");
    assert.equal(platformPlugin?.passed, false);
    assert.equal(platformPlugin?.enableAttempted, true);
    assert.equal(platformPlugin?.enableOutcome, "timeout");
    assert.equal(platformPlugin?.error, "Enable timed out");
    assert.deepEqual(enableCalls, ["code@closedloop-ai"]);
  });

  test("plugin enable remediation uses the default aggregate forty second deadline", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const codeEnableStarted = createDeferred();
    const platformEnableStarted = createDeferred();
    const enableCalls: string[] = [];
    const dispatcher = new OperationDispatcher();
    registerHealthCheckWithPluginList(dispatcher, () =>
      buildPluginListJson([
        {
          enabled: false,
          id: "code@closedloop-ai",
          scope: "user",
          version: "1.0.0",
        },
        {
          enabled: false,
          id: "platform@closedloop-ai",
          scope: "user",
          version: "1.0.0",
        },
      ])
    );
    _setPluginEnableCommandForTesting((pluginRef) => {
      enableCalls.push(pluginRef);
      if (pluginRef === "code@closedloop-ai") {
        codeEnableStarted.resolve();
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ outcome: "success", stdout: "", elapsedMs: 20_000 });
          }, 20_000);
        });
      }
      platformEnableStarted.resolve();
      return new Promise<never>(() => {});
    });

    let capturedSettled = false;
    const capturedPromise = dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: true,
    }).then((captured) => {
      capturedSettled = true;
      return captured;
    });
    await codeEnableStarted.promise;
    mock.timers.tick(20_000);
    await platformEnableStarted.promise;
    mock.timers.tick(19_999);
    await Promise.resolve();

    assert.equal(capturedSettled, false);

    mock.timers.tick(1);
    const captured = await capturedPromise;
    const checks = getChecks(parsePayload(captured));
    const codePlugin = findPluginCheck(checks, "code");
    const platformPlugin = findPluginCheck(checks, "platform");

    assert.equal(captured.statusCode, 200);
    assert.equal(codePlugin?.enableOutcome, "timeout");
    assert.equal(platformPlugin?.enableOutcome, "timeout");
    assert.deepEqual(enableCalls, [
      "code@closedloop-ai",
      "platform@closedloop-ai",
    ]);
  });

  test("plugin auto-update route returns when initial plugin list exceeds the deadline", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    _setPluginRemediationDeadlineMsForTesting(10);
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    /*
     * ISS-5453: BOTH deadline-bounded probes must hang. `checkClaudeCli` runs
     * `--version` through this same aggregate deadline, so a stub that answered
     * it successfully made the claude-cli row PASS — and the `unknown ->
     * blocked` upgrade in applyClaudeCliBlockedChecks fires only when that row
     * failed. That left the assertions below riding on whether the tick landed
     * before the probe: locally it always did (the probe short-circuited on the
     * expired deadline and never ran at all), on CI it did not, the probe
     * returned 1.0.0, and the plugin row stayed `unknown`. With both probes
     * hanging the claude-cli row fails under either ordering — the timer fires
     * on the tick if the probe started first, the probe short-circuits if the
     * tick did — and whichever command runs first releases the tick, so a
     * flipped ordering cannot deadlock the test either.
     */
    const deadlineProbeStarted = createDeferred();
    const dispatcher = new OperationDispatcher();
    _setRunCommandForTesting(async (_cmd, args) => {
      if (["plugin list --json", "--version"].includes(args.join(" "))) {
        deadlineProbeStarted.resolve();
        return new Promise<never>(() => {});
      }
      return { stdout: "1.0.0" };
    });
    registerHealthCheckWithStubbedBinaries(dispatcher);

    const capturedPromise = dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: true,
    });
    await deadlineProbeStarted.promise;
    mock.timers.tick(10);
    const captured = await capturedPromise;
    const checks = getChecks(parsePayload(captured));
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(captured.statusCode, 200);
    /*
     * Precondition, asserted rather than assumed (ISS-5453): everything below
     * depends on the claude-cli row having FAILED. When this regressed it
     * regressed here, and surfaced two assertions later as an unexplained
     * `unknown !== blocked`.
     */
    const claudeCli = checks.find((check) => check.id === "claude-cli");
    assert.equal(claudeCli?.passed, false, "claude-cli must fail to upgrade");
    assert.equal(codePlugin?.passed, false);
    /*
     * ISS-5369: the Claude CLI probe hit the same deadline, so the plugin's
     * enabled state is not determinable rather than proven bad — and the row
     * must not prescribe a `claude plugin enable` that cannot run.
     */
    assert.equal(codePlugin?.severity, CheckSeverity.Blocked);
    assert.equal(codePlugin?.blockedBy, "claude-cli");
    assert.ok(!codePlugin?.remediation?.includes("claude plugin enable"));
  });

  test("plugin auto-update route returns when a base CLI probe exceeds the deadline", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    _setPluginRemediationDeadlineMsForTesting(10);
    const baseProbeStarted = createDeferred();
    const dispatcher = new OperationDispatcher();
    _setRunCommandForTesting(async (_cmd, args) => {
      const command = args.join(" ");
      if (command === "plugin list --json") {
        throw {
          code: "EUNKNOWN",
          stderr: "",
          message: "plugin list unavailable",
        };
      }
      if (command === "--version") {
        baseProbeStarted.resolve();
        return new Promise<never>(() => {});
      }
      return { stdout: "1.0.0" };
    });
    registerHealthCheckWithStubbedBinaries(dispatcher);

    const capturedPromise = dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: true,
    });
    await baseProbeStarted.promise;
    mock.timers.tick(10);
    const captured = await capturedPromise;
    const claudeCheck = getChecks(parsePayload(captured)).find(
      (check) => check.id === "claude-cli"
    );

    assert.equal(captured.statusCode, 200);
    assert.equal(claudeCheck?.passed, false);
    assert.equal(claudeCheck?.required, true);
  });

  test("plugin enable deadline covers post-enable inventory reads", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    _setPluginRemediationDeadlineMsForTesting(10);
    const postInventoryStarted = createDeferred();
    const enableCalls: string[] = [];
    const dispatcher = new OperationDispatcher();
    let pluginListCalls = 0;
    _setRunCommandForTesting(async (_cmd, args) => {
      if (args.join(" ") === "plugin list --json") {
        pluginListCalls += 1;
        if (pluginListCalls === 1) {
          return {
            stdout: buildPluginListJson([
              {
                enabled: false,
                id: "code@closedloop-ai",
                scope: "user",
                version: "1.0.0",
              },
            ]),
          };
        }
        postInventoryStarted.resolve();
        return new Promise<never>(() => {});
      }
      return { stdout: "1.0.0" };
    });
    _setPluginEnableCommandForTesting(async (pluginRef) => {
      enableCalls.push(pluginRef);
      return { outcome: "success", stdout: "", elapsedMs: 1 };
    });
    registerHealthCheckWithStubbedBinaries(dispatcher);

    const capturedPromise = dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: true,
    });
    await postInventoryStarted.promise;
    mock.timers.tick(10);
    const captured = await capturedPromise;
    const codePlugin = findPluginCheck(
      getChecks(parsePayload(captured)),
      "code"
    );

    assert.equal(captured.statusCode, 200);
    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.enableAttempted, true);
    assert.equal(codePlugin?.enableOutcome, "timeout");
    assert.equal(codePlugin?.error, "Enable timed out");
    assert.deepEqual(enableCalls, ["code@closedloop-ai"]);
  });
});

describe("plugin-version check", () => {
  test("keeps up-to-date plugin rows required and passing with installed versions", async () => {
    mockPluginManifestVersion("1.0.0");

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0")
    );

    assert.equal(
      checks.some((check) => check.id === "plugin-versions"),
      false
    );
    assert.deepEqual(findPluginCheck(checks, "code"), {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: true,
      version: "1.0.0",
    });
  });

  test("marks outdated plugin rows as required health check failures", async () => {
    mockPluginManifestVersion("2.0.0");
    let updateCalls = 0;
    _setPluginUpdateCommandForTesting(async () => {
      updateCalls += 1;
      return { outcome: "success", stdout: "", elapsedMs: 1 };
    });

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0")
    );
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(
      checks.some((check) => check.id === "plugin-versions"),
      false
    );
    assert.equal(codePlugin?.label, "Symphony Plugin");
    assert.equal(codePlugin?.required, true);
    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.version, "1.0.0");
    assert.equal(codePlugin?.error, "Update available: 2.0.0");
    assert.match(
      codePlugin?.remediation ?? "",
      /claude plugin update code@closedloop-ai/
    );
    assert.equal(codePlugin?.updateAttempted, undefined);
    assert.equal(updateCalls, 0);
  });

  test("uses the configured directory marketplace as latest-version source", async () => {
    const marketplaceRoot = await writeDirectoryMarketplace("3.0.0");
    _setRunCommandForTesting(async (_cmd, args) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return {
          stdout: JSON.stringify([
            {
              name: "closedloop-ai",
              source: "directory",
              path: marketplaceRoot,
              installLocation: marketplaceRoot,
            },
          ]),
        };
      }
      return { stdout: "1.0.0" };
    });

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        preferConfiguredMarketplace: true,
      }
    );
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.error, "Update available: 3.0.0");
  });

  test("prefers a github-sourced marketplace's local checkout over the GitHub main manifest (FEA-2751)", async () => {
    // GitHub main HEAD is ahead of what the installer can actually apply.
    mockPluginManifestVersion("9.9.9");
    // The local marketplace checkout (what `claude plugin update` installs from)
    // is in sync with the installed version.
    const marketplaceRoot = await writeDirectoryMarketplace("1.0.0");
    _setRunCommandForTesting(async (_cmd, args) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return {
          // Mirrors the real `claude plugin marketplace list --json` shape for a
          // github-sourced marketplace (Claude Code 2.1.169): both `repo` and
          // `installLocation` are emitted, and `path` is absent. The check must
          // use `installLocation` (the local clone) as the latest-version source.
          stdout: JSON.stringify([
            {
              name: "closedloop-ai",
              source: "github",
              repo: "closedloop-ai/claude-plugins",
              installLocation: marketplaceRoot,
            },
          ]),
        };
      }
      return { stdout: "1.0.0" };
    });

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        preferConfiguredMarketplace: true,
      }
    );
    const codePlugin = findPluginCheck(checks, "code");

    // Must NOT report an unresolvable "out of date" against GitHub main HEAD.
    assert.equal(codePlugin?.passed, true);
    assert.equal(codePlugin?.version, "1.0.0");
    assert.equal(codePlugin?.error, undefined);
  });

  test("falls back to the GitHub manifest when the marketplace checkout is missing (FEA-2751)", async () => {
    mockPluginManifestVersion("2.0.0");
    _setRunCommandForTesting(async (_cmd, args) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return {
          stdout: JSON.stringify([
            {
              name: "closedloop-ai",
              source: "github",
              repo: "closedloop-ai/claude-plugins",
              installLocation: path.join(
                os.tmpdir(),
                "closedloop-marketplace-missing-checkout"
              ),
            },
          ]),
        };
      }
      return { stdout: "1.0.0" };
    });

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        preferConfiguredMarketplace: true,
      }
    );
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.error, "Update available: 2.0.0");
  });

  test("auto-update success returns post-update passing metadata only when opted in", async () => {
    mockPluginManifestVersion("2.0.0");
    const calls: string[] = [];
    _setPluginMarketplaceUpdateCommandForTesting(async () => {
      calls.push("marketplace:update:closedloop-ai");
      return { outcome: "success", stdout: "", elapsedMs: 5 };
    });
    _setPluginUpdateCommandForTesting(async (pluginRef) => {
      calls.push(`plugin:update:${pluginRef}`);
      return { outcome: "success", stdout: "", elapsedMs: 5 };
    });

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("2.0.0"),
      }
    );
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(calls[0], "marketplace:update:closedloop-ai");
    assert.deepEqual(
      calls.slice(1).sort(),
      CLOSEDLOOP_PLUGINS.map((plugin) => `plugin:update:${plugin.key}`).sort()
    );
    assert.equal(codePlugin?.passed, true);
    assert.equal(codePlugin?.version, "2.0.0");
    assert.equal(codePlugin?.updateAttempted, true);
    assert.equal(codePlugin?.updateOutcome, "success");
    assert.ok(codePlugin?.updatePluginIds?.includes("plugin-code"));
  });

  test("marketplace refresh deadline returns timeout metadata without update runners", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    _setPluginRemediationDeadlineMsForTesting(10);
    mockPluginManifestVersion("2.0.0");
    const updateCalls: string[] = [];
    const marketplaceStarted = createDeferred();
    _setPluginMarketplaceUpdateCommandForTesting(() => {
      marketplaceStarted.resolve();
      return new Promise<never>(() => {});
    });
    _setPluginUpdateCommandForTesting(async (pluginRef) => {
      updateCalls.push(pluginRef);
      return { outcome: "success", stdout: "", elapsedMs: 1 };
    });

    const checksPromise = _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    await marketplaceStarted.promise;
    mock.timers.tick(10);
    const checks = await checksPromise;
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.updateAttempted, true);
    assert.equal(codePlugin?.updateOutcome, "timeout");
    assert.deepEqual(updateCalls, []);
  });

  test("plugin update deadline skips remaining update runners with timeout metadata", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    _setPluginRemediationDeadlineMsForTesting(10);
    mockPluginManifestVersion("2.0.0");
    const updateCalls: string[] = [];
    const updateStarted = createDeferred();
    _setPluginMarketplaceUpdateCommandForTesting(async () => ({
      outcome: "success",
      stdout: "",
      elapsedMs: 1,
    }));
    _setPluginUpdateCommandForTesting((pluginRef) => {
      updateCalls.push(pluginRef);
      updateStarted.resolve();
      return new Promise<never>(() => {});
    });

    const checksPromise = _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    await updateStarted.promise;
    mock.timers.tick(10);
    const checks = await checksPromise;
    const codePlugin = findPluginCheck(checks, "code");
    const platformPlugin = findPluginCheck(checks, "platform");

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.updateAttempted, true);
    assert.equal(codePlugin?.updateOutcome, "timeout");
    assert.equal(platformPlugin?.passed, false);
    assert.equal(platformPlugin?.updateAttempted, true);
    assert.equal(platformPlugin?.updateOutcome, "timeout");
    assert.deepEqual(updateCalls, ["code@closedloop-ai"]);
  });

  test("plugin auto-update is gated on a passing Claude CLI row", () => {
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(true, [
        { id: "claude-cli", passed: false },
        { id: "plugin-code", passed: true },
      ]),
      false
    );
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(true, [
        { id: "claude-cli", passed: true },
        { id: "plugin-code", passed: true },
      ]),
      true
    );
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(false, [
        { id: "claude-cli", passed: true },
      ]),
      false
    );
  });

  test("auto-update success that remains outdated reports failed metadata and telemetry", async () => {
    mockPluginManifestVersion("2.0.0");
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });
    stubSuccessfulMarketplaceUpdate();
    _setPluginUpdateCommandForTesting(async () => ({
      outcome: "success",
      stdout: "",
      elapsedMs: 5,
    }));

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    const codePlugin = findPluginCheck(checks, "code");
    const failureTelemetry = telemetryEvents.find(
      (event) => event.category === "plugin_update.failed"
    );

    assert.equal(codePlugin?.passed, false);
    assert.equal(codePlugin?.version, "1.0.0");
    assert.equal(codePlugin?.updateAttempted, true);
    assert.equal(codePlugin?.updateOutcome, "failed");
    assert.equal(
      failureTelemetry?.diagnostics?.pluginUpdate?.failureReason,
      "still_outdated"
    );
    assert.equal(
      failureTelemetry?.diagnostics?.pluginUpdate?.outcomes[
        "code@closedloop-ai"
      ],
      "failed"
    );
  });

  test("plugin update failure telemetry falls back to bounded stdout tail", async () => {
    mockPluginManifestVersion("2.0.0");
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });
    stubSuccessfulMarketplaceUpdate();
    _setPluginUpdateCommandForTesting(async () => ({
      outcome: "failed",
      stdout: `stdout-prefix-${"x".repeat(700)}-stdout-tail-cause`,
      elapsedMs: 5,
      exitCode: 1,
      failureReason: "command_failed",
    }));

    await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    const failureTelemetry = telemetryEvents.find(
      (event) => event.category === "plugin_update.failed"
    );
    const stderrTail = failureTelemetry?.diagnostics?.pluginUpdate?.stderrTail;

    assert.equal(stderrTail?.length, 512);
    assert.equal(stderrTail?.includes("stdout-prefix-"), false);
    assert.equal(stderrTail?.endsWith("-stdout-tail-cause"), true);
  });

  test("auto-update failure returns explicit failure metadata and structured remediation link", async () => {
    mockPluginManifestVersion("2.0.0");
    stubSuccessfulMarketplaceUpdate();
    _setPluginUpdateCommandForTesting(async () => ({
      outcome: "failed",
      stdout: "",
      stderrTail: "permission denied",
      elapsedMs: 5,
      exitCode: 1,
      failureReason: "command_failed",
    }));

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(codePlugin?.passed, false);
    assert.match(codePlugin?.error ?? "", /Automatic update was attempted/);
    assert.match(
      codePlugin?.remediation ?? "",
      /claude plugin update code@closedloop-ai --scope user/
    );
    assert.equal(codePlugin?.updateAttempted, true);
    assert.equal(codePlugin?.updateOutcome, "failed");
    assert.deepEqual(codePlugin?.remediationLinks, [
      {
        label: "Update Closedloop plugins manually",
        url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
      },
    ]);
  });

  test("repeated failed auto-update tuple is suppressed in the same session", async () => {
    mockPluginManifestVersion("2.0.0");
    let calls = 0;
    stubSuccessfulMarketplaceUpdate();
    _setPluginUpdateCommandForTesting(async () => {
      calls += 1;
      return {
        outcome: "timeout",
        stdout: "",
        stderrTail: "timed out",
        elapsedMs: 30_000,
        failureReason: "timeout",
      };
    });

    await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    const secondChecks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0"),
      {
        pluginAutoUpdateEnabled: true,
        readInstalledVersions: () => buildInstalledPluginVersions("1.0.0"),
      }
    );
    const codePlugin = findPluginCheck(secondChecks, "code");

    assert.equal(calls, CLOSEDLOOP_PLUGINS.length);
    assert.equal(codePlugin?.updateOutcome, "skipped");
  });

  test("plugin update stderrTail preserves the stderr suffix", () => {
    const stderr = `prefix-${"x".repeat(700)}-tail-cause`;
    const tail = _getPluginUpdateStderrTailForTesting(stderr);

    assert.equal(tail.length, 512);
    assert.equal(tail.includes("prefix-"), false);
    assert.equal(tail.endsWith("-tail-cause"), true);
  });

  test("marks unverifiable plugin rows as required health check failures", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;

    const checks = await _applyPluginVersionChecksForTesting(
      buildPassingPluginChecks(),
      buildInstalledPluginVersions("1.0.0")
    );
    const codePlugin = findPluginCheck(checks, "code");

    assert.equal(
      checks.some((check) => check.id === "plugin-versions"),
      false
    );
    assert.equal(codePlugin?.label, "Symphony Plugin");
    assert.equal(codePlugin?.required, true);
    // ISS-5369: the plugin is installed and enabled; only "is there a newer
    // one?" is unanswered. Unknown is not out-of-date, so it must not block.
    assert.equal(codePlugin?.passed, true);
    assert.equal(codePlugin?.severity, CheckSeverity.Unknown);
    assert.equal(codePlugin?.error, "Could not verify latest version");
  });
});
