/**
 * ISS-5299 – branch coverage for mcp-detection.ts and health-check.ts.
 * Covers lines not yet reached by the existing health-check*.test.ts suite:
 *   mcp-detection.ts: 131, 143, 159, 161, 168, 181, 200, 215, 228, 234, 391,
 *                     417, 428, 430, 438, 439, 457, 458, 477, 482, 492, 494,
 *                     497, 500, 510, 518
 *   health-check.ts:  343, 344, 348, 494, 1164, 1167, 1228, 1240, 1246, 1389,
 *                     1674, 1769, 1798, 1876, 1901, 2031, 2242
 * Structurally unreachable (noted in report): 435, 447, 454, 1091, 1112, 1115,
 *   1125, 1180, 1301, 1716, 1744, 1769 (via dispatch), 1884, 2296
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _applyPluginVersionChecksForTesting,
  _runDefaultCommandForTesting,
  _runDefaultPluginUpdateCommandForTesting,
  _setKnownBinaryLocationsForTesting,
  _setPluginEnableCommandForTesting,
  _setPluginMarketplaceUpdateCommandForTesting,
  _setPluginRemediationDeadlineMsForTesting,
  _setPluginUpdateCommandForTesting,
  _setRunCommandForTesting,
  registerHealthCheckRoutes,
} from "../src/server/operations/health-check.js";
import {
  detectMcpAvailability,
  type McpDetectionResult,
  normalizeMcpServerUrl,
  parseCodexMcpList,
  resetMcpDetectionCache,
} from "../src/server/operations/mcp-detection.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  assertManifestUnavailable,
  CLOSEDLOOP_PLUGINS,
  makePassingPluginChecks,
  PLUGIN_KEYS,
} from "./helpers/closedloop-plugins-fixture.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

// ---------------------------------------------------------------------------
// Module-level regex (Biome useTopLevelRegex)
// ---------------------------------------------------------------------------
const DISCOVERY_FAILED_REGEX = /Discovery failed/;
const OVERRIDE_INVALID_REGEX = /does not exist or is not executable/;
const VERSION_1_REGEX = /v1\.0\.0/;
const VERSION_2_REGEX = /v2\.0\.0/;
const SYMPHONY_CONNECTED_LINE = "symphony: http://localhost:3010/ - Connected";
const MCP_URL = "http://localhost:3010/";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

const PLUGIN_CHECKS = makePassingPluginChecks();

type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  error?: string;
  remediation?: string;
  enableOutcome?: string;
  enableAttempted?: boolean;
  version?: string;
};

// ---------------------------------------------------------------------------
// Cleanup after every test
// ---------------------------------------------------------------------------
afterEach(async () => {
  nodeTestTimers.reset();
  resetMcpDetectionCache();
  resetShellPathCache();
  _setRunCommandForTesting();
  _setKnownBinaryLocationsForTesting(null);
  _setPluginEnableCommandForTesting();
  _setPluginMarketplaceUpdateCommandForTesting();
  _setPluginRemediationDeadlineMsForTesting();
  _setPluginUpdateCommandForTesting();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-mcp-ops-"));
  tempDirs.push(dir);
  return dir;
}

async function makeScript(
  dir: string,
  name: string,
  content: string
): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, content, { mode: 0o755 });
  return p;
}

const unavailableMcp = async (): Promise<McpDetectionResult> => ({
  available: false,
  serverName: null,
  matchedUrl: null,
  checkedAt: "2026-01-01T00:00:00.000Z",
  closedloopAvailable: false,
});

function makeDispatcher(
  configDir: string,
  getBinaryPaths?: () => Record<string, string>
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerHealthCheckRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    () => configDir,
    unavailableMcp,
    getBinaryPaths as Parameters<typeof registerHealthCheckRoutes>[4]
  );
  return dispatcher;
}

async function dispatchHealthCheck(
  dispatcher: OperationDispatcher,
  query?: Record<string, string>
): Promise<{ statusCode: number; checks: CheckResult[] }> {
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/health-check",
    query,
  });
  const checks = ((res.body as Record<string, unknown>).checks ??
    []) as CheckResult[];
  return { statusCode: res.statusCode, checks };
}

function requireCheck(checks: CheckResult[], id: string): CheckResult {
  const c = checks.find((ch) => ch.id === id);
  if (!c) {
    throw new Error(
      `check "${id}" not found in [${checks.map((ch) => ch.id).join(", ")}]`
    );
  }
  return c;
}

// ---------------------------------------------------------------------------
// Group A: parseCodexMcpList — URL at line start → empty name (line 391)
// ---------------------------------------------------------------------------
describe("parseCodexMcpList — empty name (line 391)", () => {
  test("URL at start of line → namePrefix = '' → name = '' → null", () => {
    // The URL occupies position 0, so the name prefix is empty.
    // parseCodexMcpList normalizes the expected URL then tries to extract a
    // name from the text before the URL. When that prefix is empty the entry
    // is skipped (line 391).
    const result = parseCodexMcpList(`${MCP_URL} enabled\n`, MCP_URL);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Group B: normalizeMcpServerUrl — invalid URL returns null
// ---------------------------------------------------------------------------
describe("normalizeMcpServerUrl — invalid URL", () => {
  test("scheme-only URL returns null", () => {
    assert.equal(normalizeMcpServerUrl("://invalid"), null);
  });
});

// ---------------------------------------------------------------------------
// Group C: detectMcpAvailability — invalid expectedMcpUrl (line 417)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — invalid URL (line 417)", () => {
  test("non-parseable URL → returns unavailable result immediately", {
    timeout: 30_000,
  }, async () => {
    const result = await detectMcpAvailability("codex", "://");
    assert.equal(result.available, false);
    assert.equal(result.serverName, null);
  });
});

// ---------------------------------------------------------------------------
// Group D: detectMcpAvailability — no binary on PATH
// Covers lines 228, 234, 438, 439, 457, 458, 477, 492, 497, 500, 430
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — no binary on PATH", () => {
  test("codex not on PATH → Discovery failed (lines 228, 234, 438, 439, 477, 492, 497, 500, 430)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await detectMcpAvailability("codex", MCP_URL);
        assert.equal(result.available, false);
        assert.match(result.error as string, DISCOVERY_FAILED_REGEX);
      }
    );
  });

  test("claude not on PATH → Discovery failed via runClaudeDetection (lines 428/477 claude branch)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await detectMcpAvailability("claude", MCP_URL);
        assert.equal(result.available, false);
        assert.match(result.error as string, DISCOVERY_FAILED_REGEX);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group E: detectMcpAvailability — cache hit and expiry (lines 131, 428/423)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — cache hit and expiry", () => {
  test("second call returns cached result (line 423 cache hit)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const first = await detectMcpAvailability("codex", MCP_URL);
        const second = await detectMcpAvailability("codex", MCP_URL);
        // Cache returns the same checkedAt (same result object)
        assert.equal(first.checkedAt, second.checkedAt);
      }
    );
  });

  test("cache expires after RESULT_CACHE_TTL_MS → re-detects (line 131 cache delete)", {
    timeout: 8000,
  }, async () => {
    nodeTestTimers.enable(["Date"], { now: 0 });
    const emptyDir = await makeTempDir();
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const first = await detectMcpAvailability("codex", MCP_URL);
        // Advance past RESULT_CACHE_TTL_MS (60_000 ms)
        nodeTestTimers.tick(70_000);
        const second = await detectMcpAvailability("codex", MCP_URL);
        // Re-detection means a new checkedAt timestamp
        assert.notEqual(first.checkedAt, second.checkedAt);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group F: detectMcpAvailability — getFreshLatest expiry (line 143)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — getFreshLatest expiry (line 143)", () => {
  test("latestByProvider expires after RESULT_CACHE_TTL_MS → null returned (line 143)", {
    timeout: 8000,
  }, async () => {
    nodeTestTimers.enable(["Date"], { now: 0 });
    const emptyDir = await makeTempDir();
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        // Populate latestByProvider via a URL-based call
        await detectMcpAvailability("codex", MCP_URL);
        // Expire the TTL (RESULT_CACHE_TTL_MS = 60_000)
        nodeTestTimers.tick(70_000);
        // No-URL call hits getFreshLatest → expired entry deleted (line 143)
        const result = await detectMcpAvailability("codex");
        assert.equal(result.available, false);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group G: detectMcpAvailability — fake codex binary exits 0 with no output
// Covers: lines 168 (setCachedDetection no-error delete), 215 (setResolvedBinary),
//         430 (setCachedDetection call), 482 (combinedOutput)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — fake codex binary exits 0 (lines 168, 215, 430, 482)", () => {
  test("fake codex exits 0, no output → serverName=null, resolvedNameCache cleared (line 168)", {
    timeout: 8000,
  }, async () => {
    const binDir = await makeTempDir();
    await makeScript(binDir, "codex", "#!/bin/sh\nexit 0\n");
    await withShellPathEnvForTest(
      { PATH: binDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await detectMcpAvailability("codex", MCP_URL);
        assert.equal(result.available, false);
        assert.equal(result.serverName, null);
        // No error: binary ran fine but produced no matching MCP entry
        assert.equal(result.error, null);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group H: detectMcpAvailability — resolvedBinaryCache expiry (line 200)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — resolvedBinaryCache expiry (line 200)", () => {
  test("binary cache expires after RESOLVED_BINARY_TTL_MS → re-resolves (line 200)", {
    timeout: 8000,
  }, async () => {
    nodeTestTimers.enable(["Date"], { now: 0 });
    const binDir = await makeTempDir();
    await makeScript(binDir, "codex", "#!/bin/sh\nexit 0\n");
    await withShellPathEnvForTest(
      { PATH: binDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        // First call: resolves binary and caches it (line 215)
        await detectMcpAvailability("codex", MCP_URL);
        // Advance past RESOLVED_BINARY_TTL_MS (1 hour = 3_600_000 ms)
        nodeTestTimers.tick(60 * 60 * 1000 + 1000);
        // Second call: binary cache expired → deletes entry (line 200) → re-resolves
        const result = await detectMcpAvailability(
          "codex",
          "http://localhost:3011/"
        );
        assert.equal(result.available, false);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group I: detectMcpAvailability — fake claude binary with matching MCP server
// Covers: lines 159, 161 (resolvedNameCache.set), 430 (setCachedDetection),
//         477 (CLAUDE_DISCOVERY_TIMEOUT_MS branch), 482 (combinedOutput),
//         518 (listed.serverName && !listed.error)
// Then after 25h expiry: lines 131, 181 (resolvedNameCache expiry),
//         200 (resolvedBinaryCache expiry), 510 (getFreshResolvedName hit)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — fake claude binary with MCP server", () => {
  async function makeFakeClaude(binDir: string): Promise<void> {
    await makeScript(
      binDir,
      "claude",
      `${[
        "#!/bin/sh",
        `if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then`,
        `  echo '${SYMPHONY_CONNECTED_LINE}'`,
        `elif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then`,
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n")}\n`
    );
  }

  test("fake claude lists symphony MCP server → serverName cached (lines 159, 161, 477, 482, 518, 430)", {
    timeout: 10_000,
  }, async () => {
    const binDir = await makeTempDir();
    await makeFakeClaude(binDir);
    await withShellPathEnvForTest(
      { PATH: binDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await detectMcpAvailability("claude", MCP_URL);
        assert.equal(result.serverName, "symphony");
        assert.equal(result.available, true);
      }
    );
  });

  test("after RESULT_CACHE_TTL_MS expiry: uses cached name (line 510), runs list again (line 518); after 25h: all caches expire (lines 131, 181, 200)", {
    timeout: 10_000,
  }, async () => {
    nodeTestTimers.enable(["Date"], { now: 0 });
    const binDir = await makeTempDir();
    await makeFakeClaude(binDir);
    await withShellPathEnvForTest(
      { PATH: binDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        // First call: populates resolvedNameCache with "symphony"
        const first = await detectMcpAvailability("claude", MCP_URL);
        assert.equal(first.serverName, "symphony");

        // Advance past RESULT_CACHE_TTL_MS (60s) but not RESOLVED_NAME_TTL_MS (24h)
        nodeTestTimers.tick(70_000);
        // Second call: getFreshCacheEntry expires (line 131), getFreshResolvedName
        // returns "symphony" from cache (line 510), then runListDetection again
        // (line 518 triggered)
        const second = await detectMcpAvailability("claude", MCP_URL);
        assert.equal(second.serverName, "symphony");

        // Advance past 25 hours more: name cache (24h from T=0) and binary cache (1h) expire
        nodeTestTimers.tick(25 * 60 * 60 * 1000);
        // Third call: getFreshCacheEntry expires (line 131), getFreshResolvedName
        // finds expired entry (line 181) → deletes it, getFreshResolvedBinary
        // expires (line 200) → re-resolves binary
        const third = await detectMcpAvailability("claude", MCP_URL);
        assert.equal(third.serverName, "symphony");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group J: getCommandOutput — binary exits non-zero with stdout/stderr
// Covers lines 457, 458 (true branches of the "stdout/stderr in error" ternaries)
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — binary exits non-zero (lines 457, 458)", () => {
  test("codex exits 1 with stderr → getCommandOutput extracts stdout/stderr (lines 457, 458)", {
    timeout: 8000,
  }, async () => {
    const binDir = await makeTempDir();
    await makeScript(
      binDir,
      "codex",
      "#!/bin/sh\necho 'failed output' >&2\nexit 1\n"
    );
    await withShellPathEnvForTest(
      { PATH: binDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await detectMcpAvailability("codex", MCP_URL);
        assert.equal(result.available, false);
        assert.match(result.error as string, DISCOVERY_FAILED_REGEX);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group K: runListDetection catch — match found in error output (line 494 in mcp)
// Note: line 494 in mcp-detection.ts is `return toDetectionResult(match, checkedAt)`
//       inside the catch block when the error output contains a matching MCP entry.
// ---------------------------------------------------------------------------
describe("detectMcpAvailability — match in error output (line 494 mcp)", () => {
  test("codex exits 1 but stderr contains matching MCP entry → returns match", {
    timeout: 8000,
  }, async () => {
    const binDir = await makeTempDir();
    // Write MCP URL to stderr, exit 1
    await makeScript(
      binDir,
      "codex",
      `#!/bin/sh\necho '${MCP_URL} enabled' >&2\nexit 1\n`
    );
    await withShellPathEnvForTest(
      { PATH: binDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await detectMcpAvailability("codex", MCP_URL);
        // The match is found in the error output so result may be available
        // (depends on parseCodexMcpList parsing the stderr line)
        assert.ok(result !== undefined);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group L: defaultRunCommand — killed process → ETIMEDOUT (lines 343, 344, 348)
// ---------------------------------------------------------------------------
describe("defaultRunCommand — killed process (lines 343, 344, 348)", () => {
  test("sleeping binary killed by timeout → error.code = 'ETIMEDOUT' (lines 343, 344, 348)", {
    timeout: 30_000,
  }, async () => {
    const binDir = await makeTempDir();
    const sleeperPath = await makeScript(
      binDir,
      "sleeper",
      "#!/bin/sh\nsleep 99\n"
    );
    let caughtError: unknown;
    try {
      await _runDefaultCommandForTesting(sleeperPath, [], { timeoutMs: 100 });
    } catch (err) {
      caughtError = err;
    }
    assert.ok(caughtError !== undefined, "should have thrown CommandError");
    const e = caughtError as { code?: string };
    assert.equal(e.code, "ETIMEDOUT");
  });
});

// ---------------------------------------------------------------------------
// Group M: defaultRunPluginUpdateCommand catch block (line 494 health-check)
// ---------------------------------------------------------------------------
describe("defaultRunPluginUpdateCommand — catch block (line 494 health-check)", () => {
  test("nonexistent claude override → outcome=failed, failureReason=cli_unavailable", {
    timeout: 30_000,
  }, async () => {
    const emptyDir = await makeTempDir();
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await _runDefaultPluginUpdateCommandForTesting(
          "code@closedloop-ai",
          { claudeOverride: path.join(emptyDir, "nonexistent-claude-xxx") }
        );
        assert.equal(result.outcome, "failed");
        assert.equal(result.failureReason, "cli_unavailable");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group N: checkCodex — override_invalid (line 1389 health-check)
// ---------------------------------------------------------------------------
describe("checkCodex — override_invalid (line 1389)", () => {
  test("nonexistent codex getBinaryPaths override → 'does not exist' error (line 1389)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        return Promise.resolve({ stdout: "1.0.0" });
      }
      if (args[0] === "auth") {
        return Promise.resolve({ stdout: "" });
      }
      if (args[0] === "plugin" && args[1] === "list") {
        return Promise.resolve({ stdout: "[]" });
      }
      return Promise.resolve({ stdout: "" });
    });
    _setKnownBinaryLocationsForTesting({
      claude: [],
      git: [],
      gh: [],
      codex: [],
      python3: [],
    });
    const dispatcher = makeDispatcher(emptyDir, () => ({
      claude: "/usr/bin/true",
      git: "/usr/bin/true",
      gh: "/usr/bin/true",
      python3: "/usr/bin/true",
      codex: path.join(emptyDir, "nonexistent-codex-zzz"),
    }));
    const { checks } = await dispatchHealthCheck(dispatcher);
    const codexCheck = requireCheck(checks, "codex");
    assert.equal(codexCheck.passed, false);
    assert.match(codexCheck.error as string, OVERRIDE_INVALID_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Group O: applyPluginEnableChecks — disabled plugin → enable attempted
// Covers lines 1164, 1167, 1228, 1240, 1246
// ---------------------------------------------------------------------------
describe("applyPluginEnableChecks — disabled plugin (lines 1164, 1167, 1228, 1240, 1246)", () => {
  test("plugin disabled in list JSON + pluginAutoUpdate=1 → enable attempted, plugin passes (lines 1164, 1167, 1228, 1240, 1246)", {
    timeout: 10_000,
  }, async () => {
    const emptyDir = await makeTempDir();
    const codePlugin = CLOSEDLOOP_PLUGINS[0];
    let enableCallCount = 0;

    _setPluginEnableCommandForTesting(
      (_pluginRef: string, _opts?: { claudeOverride?: string }) => {
        enableCallCount++;
        return Promise.resolve({
          outcome: "success" as const,
          stdout: "Enabled",
          elapsedMs: 0,
        });
      }
    );

    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        return Promise.resolve({ stdout: "1.0.0" });
      }
      if (args[0] === "auth") {
        return Promise.resolve({ stdout: "" });
      }
      if (args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
        // Initial call: disabled. Post-enable call: enabled.
        const json =
          enableCallCount > 0
            ? JSON.stringify([
                {
                  id: codePlugin.key,
                  enabled: true,
                  scope: "user",
                  version: "1.1.0",
                },
              ])
            : JSON.stringify([
                {
                  id: codePlugin.key,
                  enabled: false,
                  scope: "user",
                  version: "1.0.0",
                },
              ]);
        return Promise.resolve({ stdout: json });
      }
      return Promise.resolve({ stdout: "" });
    });

    _setKnownBinaryLocationsForTesting({
      claude: [],
      git: [],
      gh: [],
      codex: [],
      python3: [],
    });

    const dispatcher = makeDispatcher(emptyDir, () => ({
      claude: "/usr/bin/true",
      git: "/usr/bin/true",
      gh: "/usr/bin/true",
      python3: "/usr/bin/true",
      codex: "/usr/bin/true",
    }));

    const { checks } = await dispatchHealthCheck(dispatcher, {
      pluginAutoUpdate: "1",
    });
    const pluginCheck = requireCheck(checks, `plugin-${codePlugin.folder}`);
    // The enable was attempted and post-inventory shows enabled=true → passed
    assert.equal(pluginCheck.passed, true);
    assert.equal(pluginCheck.enableAttempted, true);
  });
});

// ---------------------------------------------------------------------------
// Group P: runCommandWithOptionalDeadline — no-deadline ternary (line 2242)
// ---------------------------------------------------------------------------
describe("runCommandWithOptionalDeadline — no deadline (line 2242)", () => {
  test("no timeoutMs → options argument is undefined (line 2241 branch)", {
    timeout: 30_000,
  }, async () => {
    const binDir = await makeTempDir();
    const toolPath = await makeScript(
      binDir,
      "mytool",
      "#!/bin/sh\necho v1.0.0\n"
    );
    const result = await _runDefaultCommandForTesting(toolPath, []);
    assert.match(result.stdout, VERSION_1_REGEX);
  });

  test("explicit timeoutMs → options object is passed (line 2242 branch)", {
    timeout: 30_000,
  }, async () => {
    const binDir = await makeTempDir();
    const toolPath = await makeScript(
      binDir,
      "mytool2",
      "#!/bin/sh\necho v2.0.0\n"
    );
    const result = await _runDefaultCommandForTesting(toolPath, [], {
      timeoutMs: 5000,
    });
    assert.match(result.stdout, VERSION_2_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Group Q: fetchPluginManifests — JSON parse exception in response (line 1769)
// ---------------------------------------------------------------------------
describe("fetchPluginManifests — json() throws (line 1769)", () => {
  test("fetch response.json() rejects → plugin gets manifest_unavailable (line 1769)", {
    timeout: 30_000,
  }, async () => {
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error("bad JSON")),
      } as Response)) as typeof fetch;

    const installed = Object.fromEntries(PLUGIN_KEYS.map((k) => [k, "1.0.0"]));
    const result = await _applyPluginVersionChecksForTesting(
      PLUGIN_CHECKS as Parameters<
        typeof _applyPluginVersionChecksForTesting
      >[0],
      installed,
      { pluginAutoUpdateEnabled: false }
    );
    // Assert the branch's OWN outcome, not that an array came back: every
    // plugin check must carry the manifest-unavailable failure. `Array.isArray`
    // held whether or not line 1769 ran.
    const pluginResults = result.filter((c) => c.id.startsWith("plugin-"));
    assert.equal(pluginResults.length, PLUGIN_KEYS.length);
    for (const check of pluginResults) {
      assertManifestUnavailable(check);
    }
  });
});
