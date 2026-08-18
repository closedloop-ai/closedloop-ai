/**
 * ISS-5299 – branch coverage for health-check.ts operations (part 2).
 * Covers configured-marketplace resolution branches.
 * Part 1 (Groups A-G) lives in health-check-ops.test.ts.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  _applyPluginVersionChecksForTesting,
  _setKnownBinaryLocationsForTesting,
  _setPluginEnableCommandForTesting,
  _setPluginMarketplaceUpdateCommandForTesting,
  _setPluginRemediationDeadlineMsForTesting,
  _setPluginUpdateCommandForTesting,
  _setRunCommandForTesting,
} from "../src/server/operations/health-check.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  assertManifestUnavailable,
  makePassingPluginChecks,
  PLUGIN_KEYS,
} from "./helpers/closedloop-plugins-fixture.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Local check type (mirrors the health-check.ts internal shape)
// ---------------------------------------------------------------------------
type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  error?: string;
  remediation?: string;
  enableOutcome?: string;
  version?: string;
};

const PLUGIN_CHECKS: CheckResult[] = makePassingPluginChecks();

// ---------------------------------------------------------------------------
// Cleanup after every test
// ---------------------------------------------------------------------------
afterEach(async () => {
  resetShellPathCache();
  _setRunCommandForTesting();
  _setKnownBinaryLocationsForTesting(null);
  _setPluginEnableCommandForTesting();
  _setPluginMarketplaceUpdateCommandForTesting();
  _setPluginRemediationDeadlineMsForTesting();
  _setPluginUpdateCommandForTesting();
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared helper — runs _applyPluginVersionChecksForTesting with a fake
// marketplace list command stub and an optional fetch fallback stub.
// ---------------------------------------------------------------------------
async function runWithMarketplaceListStub(
  listJson: string,
  fn: () => Promise<void>
): Promise<void> {
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
  await withShellPathEnvForTest({ PATH: os.tmpdir(), SHELL: "/bin/sh" }, fn);
}

// ---------------------------------------------------------------------------
// Group H — resolveConfiguredMarketplaceRoot branches (lines 1895, 1908, 1913, 1864)
// ---------------------------------------------------------------------------
describe("resolveConfiguredMarketplaceRoot — early-return branches", () => {
  test("marketplace list returns non-array JSON → root is null → GitHub fetch (line 1895)", {
    timeout: 5000,
  }, async () => {
    let fetchCalled = false;
    globalThis.fetch = ((_url: string | URL | Request) => {
      fetchCalled = true;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch;

    await runWithMarketplaceListStub('{"not": "array"}', async () => {
      setShellPathForTest();
      const installed = Object.fromEntries(
        PLUGIN_KEYS.map((k) => [k, "1.0.0"])
      );
      await _applyPluginVersionChecksForTesting(
        PLUGIN_CHECKS as unknown as Parameters<
          typeof _applyPluginVersionChecksForTesting
        >[0],
        installed,
        { preferConfiguredMarketplace: true }
      );
      assert.ok(
        fetchCalled,
        "should fall back to GitHub fetch when list is non-array"
      );
    });
  });

  test("marketplace list has no closedloop-ai entry → root is null → GitHub fetch (line 1908)", {
    timeout: 5000,
  }, async () => {
    let fetchCalled = false;
    globalThis.fetch = ((_url: string | URL | Request) => {
      fetchCalled = true;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch;

    const listJson = JSON.stringify([
      { name: "other-marketplace", source: "directory", path: "/tmp/other" },
    ]);
    await runWithMarketplaceListStub(listJson, async () => {
      setShellPathForTest();
      const installed = Object.fromEntries(
        PLUGIN_KEYS.map((k) => [k, "1.0.0"])
      );
      await _applyPluginVersionChecksForTesting(
        PLUGIN_CHECKS as unknown as Parameters<
          typeof _applyPluginVersionChecksForTesting
        >[0],
        installed,
        { preferConfiguredMarketplace: true }
      );
      assert.ok(
        fetchCalled,
        "should fall back to GitHub fetch when marketplace not found"
      );
    });
  });

  test("marketplace entry with non-absolute path → root is null → GitHub fetch (line 1913)", {
    timeout: 5000,
  }, async () => {
    let fetchCalled = false;
    globalThis.fetch = ((_url: string | URL | Request) => {
      fetchCalled = true;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch;

    // source is valid, but path is relative (not absolute)
    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: "directory", path: "relative/path" },
    ]);
    await runWithMarketplaceListStub(listJson, async () => {
      setShellPathForTest();
      const installed = Object.fromEntries(
        PLUGIN_KEYS.map((k) => [k, "1.0.0"])
      );
      await _applyPluginVersionChecksForTesting(
        PLUGIN_CHECKS as unknown as Parameters<
          typeof _applyPluginVersionChecksForTesting
        >[0],
        installed,
        { preferConfiguredMarketplace: true }
      );
      assert.ok(
        fetchCalled,
        "should fall back to GitHub fetch when path is not absolute"
      );
    });
  });

  test("marketplace entry with non-string source → resolveMarketplaceCheckoutPath returns undefined (line 1864)", {
    timeout: 5000,
  }, async () => {
    let fetchCalled = false;
    globalThis.fetch = ((_url: string | URL | Request) => {
      fetchCalled = true;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch;

    // source is not a string → resolveMarketplaceCheckoutPath returns undefined
    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: 42, path: "/tmp/some-root" },
    ]);
    await runWithMarketplaceListStub(listJson, async () => {
      setShellPathForTest();
      const installed = Object.fromEntries(
        PLUGIN_KEYS.map((k) => [k, "1.0.0"])
      );
      await _applyPluginVersionChecksForTesting(
        PLUGIN_CHECKS as unknown as Parameters<
          typeof _applyPluginVersionChecksForTesting
        >[0],
        installed,
        { preferConfiguredMarketplace: true }
      );
      assert.ok(
        fetchCalled,
        "should fall back to GitHub fetch when source is non-string"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Group I — resolveMarketplaceCheckoutPath path/installLocation (lines 1876, 1884)
// ---------------------------------------------------------------------------
describe("resolveMarketplaceCheckoutPath — checkout path resolution", () => {
  async function makeMarketplaceRoot(
    marketplaceJsonContent: unknown
  ): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hc-ops-mktpl-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify(marketplaceJsonContent)
    );
    return root;
  }

  test("marketplace entry with 'path' string → returns path (line 1876)", {
    timeout: 5000,
  }, async () => {
    const root = await makeMarketplaceRoot({
      plugins: [
        { name: "code", source: "./plugins/code" },
        { name: "platform", source: "./plugins/platform" },
        { name: "judges", source: "./plugins/judges" },
        { name: "code-review", source: "./plugins/code-review" },
        { name: "self-learning", source: "./plugins/self-learning" },
      ],
    });

    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: "directory", path: root },
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
    // stub fetch in case it falls through
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ version: "1.0.0" }))) as typeof fetch;

    await withShellPathEnvForTest(
      { PATH: os.tmpdir(), SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const installed = Object.fromEntries(
          PLUGIN_KEYS.map((k) => [k, "1.0.0"])
        );
        const result = await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as unknown as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          { preferConfiguredMarketplace: true }
        );
        // marketplace.json was read, and because the plugin subdirs don't exist
        // every plugin lands on the manifest-unavailable branch. Assert that
        // outcome — `Array.isArray` held either way.
        const pluginResults = result.filter((c) => c.id.startsWith("plugin-"));
        assert.equal(pluginResults.length, PLUGIN_KEYS.length);
        for (const check of pluginResults) {
          assertManifestUnavailable(check);
        }
      }
    );
  });

  test("marketplace entry with 'installLocation' string and no 'path' → returns installLocation (line 1884)", {
    timeout: 5000,
  }, async () => {
    const root = await makeMarketplaceRoot({ plugins: [] });

    // 'github' source uses installLocation (no path field)
    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: "github", installLocation: root },
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
      Promise.resolve(Response.json({ version: "1.0.0" }))) as typeof fetch;

    await withShellPathEnvForTest(
      { PATH: os.tmpdir(), SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const installed = Object.fromEntries(
          PLUGIN_KEYS.map((k) => [k, "1.0.0"])
        );
        const result = await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as unknown as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          { preferConfiguredMarketplace: true }
        );
        // The discriminator: when `installLocation` resolves, manifests are read
        // from that local checkout — which declares no plugins — so every plugin
        // lands on manifest-unavailable. Had line 1884 NOT returned it, the code
        // would have fallen back to the GitHub fetch stubbed above and every
        // plugin would have passed at version 1.0.0. `Array.isArray` could not
        // tell those two outcomes apart.
        const pluginResults = result.filter((c) => c.id.startsWith("plugin-"));
        assert.equal(pluginResults.length, PLUGIN_KEYS.length);
        for (const check of pluginResults) {
          assertManifestUnavailable(check);
        }
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group J — readConfiguredMarketplaceManifests file-read branches
//           (lines 1800, 1814, 1816, 1831, 1833)
// ---------------------------------------------------------------------------
describe("readConfiguredMarketplaceManifests — file parsing branches", () => {
  async function makeRootWithMarketplaceJson(content: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hc-ops-mj-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(root, ".claude-plugin", "marketplace.json"),
      content
    );
    return root;
  }

  async function runConfiguredMarketplaceTest(
    root: string,
    fn: (result: CheckResult[]) => void
  ): Promise<void> {
    const listJson = JSON.stringify([
      { name: "closedloop-ai", source: "directory", path: root },
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
      Promise.resolve(Response.json({ version: "99.0.0" }))) as typeof fetch;

    await withShellPathEnvForTest(
      { PATH: os.tmpdir(), SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const installed = Object.fromEntries(
          PLUGIN_KEYS.map((k) => [k, "1.0.0"])
        );
        const result = await _applyPluginVersionChecksForTesting(
          PLUGIN_CHECKS as unknown as Parameters<
            typeof _applyPluginVersionChecksForTesting
          >[0],
          installed,
          { preferConfiguredMarketplace: true }
        );
        fn(result);
      }
    );
  }

  test("marketplace.json has invalid JSON → all plugins get manifest_unavailable (line 1800)", {
    timeout: 5000,
  }, async () => {
    const root = await makeRootWithMarketplaceJson("{not valid json{{");
    await runConfiguredMarketplaceTest(root, (result) => {
      const pluginResults = result.filter((c) => c.id.startsWith("plugin-"));
      for (const check of pluginResults) {
        assert.equal(
          check.error,
          "Could not verify latest version",
          `${check.id}: ${check.error}`
        );
      }
    });
  });

  test("marketplace.json entry has no source field → plugin is manifest_unavailable (lines 1814, 1816)", {
    timeout: 5000,
  }, async () => {
    // plugins entry with no 'source' field
    const root = await makeRootWithMarketplaceJson(
      JSON.stringify({
        plugins: [
          { name: "code" },
          { name: "platform" },
          { name: "judges" },
          { name: "code-review" },
          { name: "self-learning" },
        ],
      })
    );
    await runConfiguredMarketplaceTest(root, (result) => {
      const codeCheck = result.find((c) => c.id === "plugin-code");
      assert.ok(codeCheck, "plugin-code must be in result");
      assert.equal(codeCheck.error, "Could not verify latest version");
    });
  });

  test("plugin.json exists but version is not a string → manifest_unavailable (lines 1831, 1832)", {
    timeout: 5000,
  }, async () => {
    const root = await makeRootWithMarketplaceJson(
      JSON.stringify({
        plugins: [
          { name: "code", source: "./plugins/code" },
          { name: "platform", source: "./plugins/platform" },
          { name: "judges", source: "./plugins/judges" },
          { name: "code-review", source: "./plugins/code-review" },
          { name: "self-learning", source: "./plugins/self-learning" },
        ],
      })
    );
    // create plugin dirs with plugin.json having numeric (non-string) version
    for (const folder of [
      "code",
      "platform",
      "judges",
      "code-review",
      "self-learning",
    ]) {
      const pluginDir = path.join(root, "plugins", folder, ".claude-plugin");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ version: 999 })
      );
    }
    await runConfiguredMarketplaceTest(root, (result) => {
      const codeCheck = result.find((c) => c.id === "plugin-code");
      assert.ok(codeCheck, "plugin-code must be in result");
      assert.equal(codeCheck.error, "Could not verify latest version");
    });
  });

  test("plugin.json is missing → manifest_unavailable (line 1833)", {
    timeout: 5000,
  }, async () => {
    const root = await makeRootWithMarketplaceJson(
      JSON.stringify({
        plugins: [
          { name: "code", source: "./plugins/code" },
          { name: "platform", source: "./plugins/platform" },
          { name: "judges", source: "./plugins/judges" },
          { name: "code-review", source: "./plugins/code-review" },
          { name: "self-learning", source: "./plugins/self-learning" },
        ],
      })
    );
    // create plugin dirs WITHOUT plugin.json
    for (const folder of [
      "code",
      "platform",
      "judges",
      "code-review",
      "self-learning",
    ]) {
      await mkdir(path.join(root, "plugins", folder, ".claude-plugin"), {
        recursive: true,
      });
    }
    await runConfiguredMarketplaceTest(root, (result) => {
      const codeCheck = result.find((c) => c.id === "plugin-code");
      assert.ok(codeCheck, "plugin-code must be in result");
      assert.equal(codeCheck.error, "Could not verify latest version");
    });
  });
});
