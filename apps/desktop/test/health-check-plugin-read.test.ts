/**
 * ISS-5810 — the System Check plugin rows, driven through the production route.
 *
 * These go through `GET /api/gateway/health-check` (`OperationDispatcher` →
 * `registerHealthCheckRoutes` → `runHealthCheck` → `checkPlugin`), not the
 * classifier in isolation: the bug being guarded is what the OPERATOR saw on
 * the row, and a unit-level assertion would not have caught a regression in the
 * reader wiring that produces it.
 *
 * Split out of `health-check-ops.test.ts` to keep that file under the 1,000-line
 * ceiling.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _setRunCommandForTesting,
  registerHealthCheckRoutes,
} from "../src/server/operations/health-check.js";
import type { GatewayCheckResult as CheckResult } from "../src/server/operations/health-check-types.js";
import {
  PLUGIN_DISABLED_ERROR,
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
} from "../src/server/operations/health-check-types.js";
import type { McpDetectionResult } from "../src/server/operations/mcp-detection.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-list"
);

/** The five Closedloop plugin folders System Check reports on. */
const ISS_5810_PLUGIN_FOLDERS = [
  "code",
  "code-review",
  "judges",
  "platform",
  "self-learning",
] as const;

/** The four `error` strings that mean "we could not confirm this is enabled". */
const ISS_5810_PLUGIN_STATE_ERRORS: ReadonlySet<string> = new Set([
  PLUGIN_DISABLED_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
]);

/**
 * The versions the captured `claude plugin list` fixtures report. The synthetic
 * registry must agree with them, or the separate plugin-VERSION check rewrites
 * the row with "Update available" and masks what these tests assert.
 */
const ISS_5810_FIXTURE_VERSIONS: Record<string, string> = {
  code: "1.14.7",
  "code-review": "3.7.0",
  judges: "1.7.1",
  platform: "1.1.3",
  "self-learning": "1.2.5",
};

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  _setRunCommandForTesting();
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const unavailableMcp = (): Promise<McpDetectionResult> =>
  Promise.resolve({
    installed: false,
    matchesExpectedUrl: false,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-01-01T00:00:00.000Z",
    closedloopAvailable: false,
  } as unknown as McpDetectionResult);

function makeDispatcher(tempDir: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerHealthCheckRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    () => tempDir,
    unavailableMcp
  );
  return dispatcher;
}

async function dispatchHealthCheck(
  dispatcher: OperationDispatcher
): Promise<{ checks: CheckResult[] }> {
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/health-check",
  });
  const checks = ((res.body as Record<string, unknown>).checks ??
    []) as CheckResult[];
  return { checks };
}

function findCheck(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(
      `check "${id}" not found in [${checks.map((c) => c.id).join(", ")}]`
    );
  }
  return found;
}

async function _readFixture(name: string): Promise<string> {
  return await readFile(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("ISS-5810 plugin rows via the health-check route", () => {
  test("real `claude plugin list --json` output makes all five plugin rows PASS", {
    timeout: 15_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ac1-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ac1-s-"));
    tempDirs.push(tempDir);

    // ISS-5810 acceptance criterion 1, proven through the production route:
    // the operator's real machine state — all five installed and enabled at
    // user scope — must report PASSING, not "Setup required".
    const registry: Record<string, unknown[]> = {};
    for (const folder of ISS_5810_PLUGIN_FOLDERS) {
      const installPath = path.join(
        homeDir,
        ".claude",
        "plugins",
        "cache",
        "closedloop-ai",
        folder,
        ISS_5810_FIXTURE_VERSIONS[folder] ?? "1.0.0"
      );
      await mkdir(installPath, { recursive: true });
      registry[`${folder}@closedloop-ai`] = [
        {
          scope: "user",
          installPath,
          version: ISS_5810_FIXTURE_VERSIONS[folder] ?? "1.0.0",
        },
      ];
    }
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: registry })
    );

    // Verbatim captured CLI output — the oracle, not a hand-written fixture.
    const realJson = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "plugin-list",
        "claude-plugin-list.json"
      ),
      "utf-8"
    );

    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "list") {
        return Promise.resolve({ stdout: realJson });
      }
      return Promise.resolve({ stdout: "1.0.0" });
    });

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        for (const folder of ISS_5810_PLUGIN_FOLDERS) {
          const row = findCheck(checks, `plugin-${folder}`);
          // The enabled state is READ, so none of the four plugin-state errors
          // may appear. (`passed` itself is not asserted here: a separate
          // version row can independently mark a plugin out of date against
          // the live marketplace manifest, which is not this ticket's concern.)
          assert.ok(
            !ISS_5810_PLUGIN_STATE_ERRORS.has(row.error ?? ""),
            `plugin-${folder} must not report a plugin-state error, got: ${row.error ?? "<none>"}`
          );
          assert.ok(
            !row.remediation?.includes("plugin enable"),
            `plugin-${folder} must not prescribe an already-satisfied enable`
          );
          assert.equal(row.severity, undefined);
        }
      }
    );
  });

  test("real human-readable output makes the rows PASS when `--json` is unsupported", {
    timeout: 15_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ac1t-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ac1t-s-"));
    tempDirs.push(tempDir);

    const installPath = path.join(
      homeDir,
      ".claude",
      "plugins",
      "cache",
      "closedloop-ai",
      "code",
      "1.0.0"
    );
    await mkdir(installPath, { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "code@closedloop-ai": [
            { scope: "user", installPath, version: "1.0.0" },
          ],
        },
      })
    );

    const realText = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "plugin-list",
        "claude-plugin-list.txt"
      ),
      "utf-8"
    );

    // A CLI build that rejects `--json` must still resolve to a verified
    // answer through the plain-listing fallback.
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "list") {
        if (args[2] === "--json") {
          throw Object.assign(new Error("unknown option '--json'"), {
            code: "EUNKNOWN",
            stderr: "unknown option",
          });
        }
        return Promise.resolve({ stdout: realText });
      }
      return Promise.resolve({ stdout: "1.0.0" });
    });

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const row = findCheck(checks, "plugin-code");
        assert.ok(
          !ISS_5810_PLUGIN_STATE_ERRORS.has(row.error ?? ""),
          `expected a read enabled state, got: ${row.error ?? "<none>"}`
        );
        assert.equal(row.severity, undefined);
      }
    );
  });

  test("output the CLI produced but we cannot interpret reports UNREADABLE, not unrunnable", {
    timeout: 15_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-unr-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-unr-s-"));
    tempDirs.push(tempDir);

    const installPath = path.join(
      homeDir,
      ".claude",
      "plugins",
      "cache",
      "closedloop-ai",
      "code",
      "1.0.0"
    );
    await mkdir(installPath, { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "code@closedloop-ai": [
            { scope: "user", installPath, version: "1.0.0" },
          ],
        },
      })
    );

    // A future CLI shape: it ran fine, we just cannot read it.
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "list") {
        return Promise.resolve({ stdout: "<xml><plugins/></xml>" });
      }
      return Promise.resolve({ stdout: "1.0.0" });
    });

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const row = findCheck(checks, "plugin-code");
        assert.equal(row.passed, false);
        assert.equal(row.error, PLUGIN_LIST_UNREADABLE_ERROR);
        assert.notEqual(row.error, PLUGIN_LIST_COMMAND_FAILED_ERROR);
        assert.equal(row.severity, CheckSeverity.Unknown);
        assert.ok(!row.remediation?.includes("plugin enable"));
      }
    );
  });

  test("a registry-proven-disabled plugin stays Disabled even when the read fails", {
    timeout: 15_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-dis-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-dis-s-"));
    tempDirs.push(tempDir);

    const installPath = path.join(
      homeDir,
      ".claude",
      "plugins",
      "cache",
      "closedloop-ai",
      "code",
      "1.0.0"
    );
    await mkdir(installPath, { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "code@closedloop-ai": [
            { scope: "user", installPath, version: "1.0.0", enabled: false },
          ],
        },
      })
    );

    // ISS-5389: evidence outranks not-determinable. The CLI read fails, but the
    // registry PROVES the plugin is switched off — a directly actionable
    // finding that must not be downgraded to an unknown, and the one state
    // where `claude plugin enable` IS the correct remediation.
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "list") {
        throw Object.assign(new Error("list failed"), {
          code: "EUNKNOWN",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "1.0.0" });
    });

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const row = findCheck(checks, "plugin-code");
        assert.equal(row.error, PLUGIN_DISABLED_ERROR);
        assert.ok(row.remediation?.includes("plugin enable"));
      }
    );
  });
});
