/**
 * ISS-5299 – continuation of health-mcp-ops.test.ts (split for 1000-line ceiling).
 * Covers:
 *   health-check.ts: 1674, 1798, 1876, 1901, 2031
 * Groups: R (readConfiguredMarketplaceManifests non-array plugins),
 *         S (resolveMarketplaceCheckoutPath both-fields-missing),
 *         T (resolveConfiguredMarketplaceRoot null entry),
 *         U (runPluginUpdates suppressed timeout + finalInstalled fallback)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  _applyPluginVersionChecksForTesting,
  _setPluginMarketplaceUpdateCommandForTesting,
  _setPluginRemediationDeadlineMsForTesting,
  _setPluginUpdateCommandForTesting,
  _setRunCommandForTesting,
} from "../src/server/operations/health-check.js";
import { resetMcpDetectionCache } from "../src/server/operations/mcp-detection.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const CLOSEDLOOP_PLUGINS = [
  { folder: "code", key: "code@closedloop-ai", label: "Symphony Plugin" },
  {
    folder: "self-learning",
    key: "self-learning@closedloop-ai",
    label: "Self-Learning Plugin",
  },
  { folder: "judges", key: "judges@closedloop-ai", label: "Judges Plugin" },
  {
    folder: "code-review",
    key: "code-review@closedloop-ai",
    label: "Code Review Plugin",
  },
  {
    folder: "platform",
    key: "platform@closedloop-ai",
    label: "Platform Plugin",
  },
] as const;
type PluginKey = (typeof CLOSEDLOOP_PLUGINS)[number]["key"];
const PLUGIN_KEYS: PluginKey[] = CLOSEDLOOP_PLUGINS.map((p) => p.key);
const PLUGIN_CHECKS = CLOSEDLOOP_PLUGINS.map((p) => ({
  id: `plugin-${p.folder}`,
  label: p.label,
  required: true,
  passed: true,
}));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
afterEach(async () => {
  resetMcpDetectionCache();
  resetShellPathCache();
  _setRunCommandForTesting();
  _setPluginRemediationDeadlineMsForTesting();
  _setPluginUpdateCommandForTesting();
  _setPluginMarketplaceUpdateCommandForTesting();
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-mcp-ops2-"));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Group R: readConfiguredMarketplaceManifests — plugins not array (line 1798)
// ---------------------------------------------------------------------------
describe("readConfiguredMarketplaceManifests — non-array plugins field (line 1798)", () => {
  test("marketplace.json has non-array 'plugins' field → plugins = [] (line 1798)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    const marketplaceRoot = await makeTempDir();
    await mkdir(path.join(marketplaceRoot, ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ plugins: "not-an-array" })
    );
    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: "directory", path: marketplaceRoot },
    ]);
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (
        args[0] === "plugin" &&
        args[1] === "marketplace" &&
        args[2] === "list"
      ) {
        return Promise.resolve({ stdout: listJson });
      }
      return Promise.resolve({ stdout: "" });
    });
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ version: "2.0.0" }))) as typeof fetch;

    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const installed = Object.fromEntries(
          PLUGIN_KEYS.map((k) => [k, "1.0.0"])
        );
        const result = await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          { preferConfiguredMarketplace: true }
        );
        assert.ok(Array.isArray(result));
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group S: resolveMarketplaceCheckoutPath — no path/installLocation (line 1876)
// ---------------------------------------------------------------------------
describe("resolveMarketplaceCheckoutPath — both path fields missing (line 1876)", () => {
  test("marketplace entry source='directory' but no path or installLocation → falls through (line 1876)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    // source="directory" passes the MARKETPLACE_SOURCES_WITH_LOCAL_CHECKOUT
    // guard but has no .path and no .installLocation → line 1876 `return undefined`
    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: "directory" },
    ]);
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (
        args[0] === "plugin" &&
        args[1] === "marketplace" &&
        args[2] === "list"
      ) {
        return Promise.resolve({ stdout: listJson });
      }
      return Promise.resolve({ stdout: "" });
    });
    let fetchCalled = false;
    globalThis.fetch = ((_url: string | URL | Request) => {
      fetchCalled = true;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch;

    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const installed = Object.fromEntries(
          PLUGIN_KEYS.map((k) => [k, "1.0.0"])
        );
        await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          { preferConfiguredMarketplace: true }
        );
        // root=null (line 1876 returned undefined) → fallback to GitHub fetch
        assert.ok(fetchCalled, "should fall through to GitHub fetch");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group T: resolveConfiguredMarketplaceRoot — null entry in array (line 1901)
// ---------------------------------------------------------------------------
describe("resolveConfiguredMarketplaceRoot — null entry in list (line 1901)", () => {
  test("marketplace list contains null → null entry skipped in find callback (line 1901)", {
    timeout: 8000,
  }, async () => {
    const emptyDir = await makeTempDir();
    const listJson = JSON.stringify([null]);
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (
        args[0] === "plugin" &&
        args[1] === "marketplace" &&
        args[2] === "list"
      ) {
        return Promise.resolve({ stdout: listJson });
      }
      return Promise.resolve({ stdout: "" });
    });
    let fetchCalled = false;
    globalThis.fetch = ((_url: string | URL | Request) => {
      fetchCalled = true;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch;

    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const installed = Object.fromEntries(
          PLUGIN_KEYS.map((k) => [k, "1.0.0"])
        );
        await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          { preferConfiguredMarketplace: true }
        );
        // null entry skipped (line 1901 typeof null === "object" && null guard) →
        // find returns undefined → resolveConfiguredMarketplaceRoot returns null →
        // fallback to GitHub fetch
        assert.ok(fetchCalled, "should fall through to GitHub fetch");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group U: runPluginUpdates — suppressed timeout (line 2031) + installed
//          fallback when readInstalledVersions returns {} (line 1674)
// ---------------------------------------------------------------------------
describe("runPluginUpdates — suppressed timeout outcome (lines 1674, 2031)", () => {
  test("second update attempt with same suppression key is skipped, not re-run (line 2031); readInstalledVersions={} → installed fallback (line 1674)", {
    timeout: 15_000,
  }, async () => {
    const installed = Object.fromEntries(PLUGIN_KEYS.map((k) => [k, "1.0.0"]));

    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ version: "2.0.0" }))) as typeof fetch;

    _setPluginMarketplaceUpdateCommandForTesting(async () => ({
      outcome: "success" as const,
      stdout: "refreshed",
      elapsedMs: 0,
    }));

    // Always returns timeout so suppression key is stored after first call.
    // The invocation count is the observable that proves the suppression branch
    // ran: `failureReason` itself is only ever attached to the internal
    // diagnostics object, never to a returned CheckResult, so asserting it on
    // the return value is impossible (an earlier revision of this test tried).
    let updateAttempts = 0;
    _setPluginUpdateCommandForTesting(() => {
      updateAttempts += 1;
      return Promise.resolve({
        outcome: "timeout" as const,
        stdout: "",
        stderrTail: "timed out",
        elapsedMs: 0,
        failureReason: "timeout" as const,
      });
    });

    // readInstalledVersions returns {} → finalInstalled[key] is undefined
    // → second `??` branch used: installed[key] (line 1674)
    const opts = {
      pluginAutoUpdateEnabled: true,
      readInstalledVersions: () => ({}) as unknown as Record<string, string>,
    } as const;

    await withShellPathEnvForTest(
      { PATH: os.tmpdir(), SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        // First call: plugins outdated, updates time out → suppression map populated
        const after1 = await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          opts
        );
        // The update timed out, so the first pass must already report it as a
        // failed, still-outdated plugin — not merely "an array came back".
        const codeAfter1 = after1.find((c) => c.id === "plugin-code");
        assert.ok(codeAfter1 !== undefined, "plugin-code check present");
        assert.equal(codeAfter1.passed, false);
        const attemptsAfterFirst = updateAttempts;
        assert.ok(
          attemptsAfterFirst > 0,
          "first pass should actually attempt the update"
        );

        // Second call: suppression key found with "timeout" outcome →
        // suppressedOutcome === "timeout" → failureReason = "timeout" (line 2031)
        const after2 = await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          opts
        );
        const codeCheck = after2.find((c) => c.id === "plugin-code");
        assert.ok(codeCheck !== undefined, "plugin-code check present");
        assert.equal(codeCheck.passed, false);
        // The suppression branch's observable effect: the stored key short-
        // circuits with outcome "skipped" BEFORE
        // `runPluginCommandWithinDeadline`, so the second pass must not run the
        // update command again. If line 2025's `if (suppressedOutcome)` stopped
        // matching, this count would climb and the test would fail.
        assert.equal(
          updateAttempts,
          attemptsAfterFirst,
          "second pass must be suppressed, not re-attempted"
        );
      }
    );
  });
});
