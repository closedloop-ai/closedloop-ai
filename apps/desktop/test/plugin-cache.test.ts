import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  CLOSEDLOOP_REQUIRED_PLUGIN_IDS,
  compareSemverDescending,
  findPluginScript,
  findPluginVersions,
  getCodePluginVersion,
  getPluginCacheRoot,
  getPluginInstallStatus,
  isPluginInstalled,
  parseClaudePluginListJson,
  parseClaudePluginListText,
} from "../src/server/operations/plugin-cache.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-cache-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("getPluginCacheRoot", () => {
  test("returns homedir-based path by default", () => {
    const result = getPluginCacheRoot();
    assert.equal(
      result,
      path.join(os.homedir(), ".claude", "plugins", "cache", "closedloop-ai")
    );
  });

  test("returns override when provided", () => {
    const override = "/custom/cache/root";
    assert.equal(getPluginCacheRoot(override), override);
  });
});

describe("compareSemverDescending", () => {
  test("sorts higher version first", () => {
    assert.ok(compareSemverDescending("2.0.0", "1.0.0") < 0);
  });

  test("sorts lower version last", () => {
    assert.ok(compareSemverDescending("1.0.0", "2.0.0") > 0);
  });

  test("returns 0 for equal versions", () => {
    assert.equal(compareSemverDescending("1.2.3", "1.2.3"), 0);
  });

  test("compares minor versions", () => {
    assert.ok(compareSemverDescending("1.1.0", "1.2.0") > 0);
  });

  test("compares patch versions", () => {
    assert.ok(compareSemverDescending("1.0.2", "1.0.1") < 0);
  });
});

describe("Claude plugin inventory parsing", () => {
  test("parses JSON inventory with enabled plugin fields", () => {
    const entries = parseClaudePluginListJson(
      JSON.stringify([
        {
          id: "code@closedloop-ai",
          version: "1.2.3",
          enabled: true,
          installPath: "/tmp/code",
        },
      ])
    );

    assert.deepEqual(entries, [
      {
        id: "code@closedloop-ai",
        version: "1.2.3",
        enabled: true,
        installPath: "/tmp/code",
      },
    ]);
  });

  test("parses real CLI JSON object with installed plugins", () => {
    const entries = parseClaudePluginListJson(
      JSON.stringify({
        installed: [
          {
            name: "code@closedloop-ai",
            version: "1.2.3",
            enabled: true,
            installPath: "/tmp/code",
          },
        ],
      })
    );

    assert.deepEqual(entries, [
      {
        id: "code@closedloop-ai",
        version: "1.2.3",
        enabled: true,
        installPath: "/tmp/code",
      },
    ]);
  });

  test("treats missing JSON enabled field as unknown", () => {
    const entries = parseClaudePluginListJson(
      JSON.stringify([{ id: "judges@closedloop-ai", version: "1.0.0" }])
    );

    assert.deepEqual(entries, [
      {
        id: "judges@closedloop-ai",
        version: "1.0.0",
        enabled: "unknown",
      },
    ]);
  });

  test("parses text fallback enabled and disabled status", () => {
    const entries = parseClaudePluginListText(`
code@closedloop-ai
  Status: enabled

platform@closedloop-ai
  Status: disabled
`);

    assert.deepEqual(entries, [
      { id: "code@closedloop-ai", enabled: true },
      { id: "platform@closedloop-ai", enabled: false },
    ]);
  });

  test("required Closedloop plugin inventory excludes bootstrap", () => {
    assert.deepEqual(
      [...CLOSEDLOOP_REQUIRED_PLUGIN_IDS],
      [
        "code@closedloop-ai",
        "code-review@closedloop-ai",
        "judges@closedloop-ai",
        "platform@closedloop-ai",
        "self-learning@closedloop-ai",
      ]
    );
  });
});

describe("findPluginVersions", () => {
  test("returns semver directories sorted descending", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "1.0.0"));
    await fs.mkdir(path.join(dir, "2.1.0"));
    await fs.mkdir(path.join(dir, "1.5.3"));

    const versions = findPluginVersions(dir);
    assert.deepEqual(versions, ["2.1.0", "1.5.3", "1.0.0"]);
  });

  test("returns empty array for missing directory", () => {
    const versions = findPluginVersions("/nonexistent/path");
    assert.deepEqual(versions, []);
  });

  test("excludes non-semver names", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "1.0.0"));
    await fs.mkdir(path.join(dir, "latest"));
    await fs.mkdir(path.join(dir, ".hidden"));
    await fs.writeFile(path.join(dir, "readme.txt"), "");

    const versions = findPluginVersions(dir);
    assert.deepEqual(versions, ["1.0.0"]);
  });

  test("handles empty directory", async () => {
    const dir = await makeTempDir();
    const versions = findPluginVersions(dir);
    assert.deepEqual(versions, []);
  });
});

describe("findPluginScript", () => {
  test("returns script from highest version", async () => {
    const cacheRoot = await makeTempDir();
    const scriptsDir1 = path.join(cacheRoot, "code", "1.0.0", "scripts");
    const scriptsDir2 = path.join(cacheRoot, "code", "2.0.0", "scripts");
    await fs.mkdir(scriptsDir1, { recursive: true });
    await fs.mkdir(scriptsDir2, { recursive: true });
    await fs.writeFile(path.join(scriptsDir1, "run-loop.sh"), "#!/bin/bash");
    await fs.writeFile(path.join(scriptsDir2, "run-loop.sh"), "#!/bin/bash");

    const result = findPluginScript("code", "run-loop.sh", cacheRoot);
    assert.equal(result, path.join(scriptsDir2, "run-loop.sh"));
  });

  test("skips versions missing the script", async () => {
    const cacheRoot = await makeTempDir();
    const scriptsDir1 = path.join(cacheRoot, "code", "1.0.0", "scripts");
    const scriptsDir2 = path.join(cacheRoot, "code", "2.0.0", "scripts");
    await fs.mkdir(scriptsDir1, { recursive: true });
    await fs.mkdir(scriptsDir2, { recursive: true });
    await fs.writeFile(path.join(scriptsDir1, "run-loop.sh"), "#!/bin/bash");
    // 2.0.0 does NOT have run-loop.sh

    const result = findPluginScript("code", "run-loop.sh", cacheRoot);
    assert.equal(result, path.join(scriptsDir1, "run-loop.sh"));
  });

  test("returns null when plugin directory missing", async () => {
    const cacheRoot = await makeTempDir();
    const result = findPluginScript("nonexistent", "run-loop.sh", cacheRoot);
    assert.equal(result, null);
  });

  test("returns null when no version has the script", async () => {
    const cacheRoot = await makeTempDir();
    const scriptsDir = path.join(cacheRoot, "code", "1.0.0", "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    // No run-loop.sh anywhere

    const result = findPluginScript("code", "run-loop.sh", cacheRoot);
    assert.equal(result, null);
  });
});

describe("isPluginInstalled", () => {
  test("returns true when plugin is registered and install path exists", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(
      tmpDir,
      "cache",
      "closedloop-ai",
      "code",
      "1.0.0"
    );
    await fs.mkdir(installPath, { recursive: true });

    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath, scope: "user", version: "1.0.0" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), true);
  });

  test("returns false when plugin is registered but install path missing", async () => {
    const tmpDir = await makeTempDir();
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          {
            installPath: path.join(tmpDir, "nonexistent"),
            scope: "user",
            version: "1.0.0",
          },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), false);
  });

  test("returns false when plugin is not in registry", async () => {
    const tmpDir = await makeTempDir();
    const registry = { version: 2, plugins: {} };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), false);
  });

  test("returns false when registry file does not exist", async () => {
    const tmpDir = await makeTempDir();
    assert.equal(
      isPluginInstalled("code", path.join(tmpDir, "missing.json")),
      false
    );
  });

  test("returns false for project-only entries even when install path exists", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "project-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          {
            installPath,
            projectPath: tmpDir,
            scope: "project",
            version: "1.0.0",
          },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), false);
  });

  test("returns true for legacy missing-scope entries with an existing install path", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "legacy-user-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [{ installPath, version: "1.0.0" }],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), true);
  });

  test("returns false for missing-scope entries without an existing install path", async () => {
    const tmpDir = await makeTempDir();
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          {
            installPath: path.join(tmpDir, "missing-plugin"),
            version: "1.0.0",
          },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), false);
  });

  test("returns false for disabled user-scoped entries", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "disabled-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { enabled: false, installPath, scope: "user", version: "1.0.0" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(isPluginInstalled("code", registryPath), false);
  });
});

describe("getPluginInstallStatus", () => {
  test("passes enabled user-scope entries and selects user version", async () => {
    const tmpDir = await makeTempDir();
    const projectPath = path.join(tmpDir, "project-plugin");
    const userPath = path.join(tmpDir, "user-plugin");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(userPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          {
            installPath: projectPath,
            projectPath: tmpDir,
            scope: "project",
            version: "0.9.0",
          },
          { installPath: userPath, scope: "user", version: "1.2.3" },
        ],
      },
    };
    const listJson = JSON.stringify([
      {
        id: "code@closedloop-ai",
        projectPath: tmpDir,
        scope: "project",
        version: "0.9.0",
      },
      {
        enabled: true,
        id: "code@closedloop-ai",
        scope: "user",
        version: "1.2.3",
      },
    ]);
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    const status = getPluginInstallStatus("code", registryPath, listJson);

    assert.equal(status.hasValidUserScopedEntry, true);
    assert.equal(status.disabled, false);
    assert.equal(status.hasProjectScopedEntry, true);
    assert.deepEqual(status.projectScopedPaths, [tmpDir]);
    assert.equal(status.selectedUserVersion, "1.2.3");
  });

  test("detects project scope even when the list entry has no project path", async () => {
    const tmpDir = await makeTempDir();
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [{ scope: "project", version: "1.2.3" }],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    const status = getPluginInstallStatus(
      "code",
      registryPath,
      JSON.stringify([
        { id: "code@closedloop-ai", scope: "project", version: "1.2.3" },
      ])
    );

    assert.equal(status.hasValidUserScopedEntry, false);
    assert.equal(status.hasProjectScopedEntry, true);
    assert.deepEqual(status.projectScopedPaths, []);
  });

  test("classifies legacy missing-scope registry entries as user scoped", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "legacy-user-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 1,
      plugins: {
        "code@closedloop-ai": [{ installPath, version: "1.2.3" }],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    const status = getPluginInstallStatus("code", registryPath);

    assert.equal(status.hasValidUserScopedEntry, true);
    assert.equal(status.hasUserScopedEntry, true);
    assert.equal(status.hasExistingUserInstallPath, true);
    assert.equal(status.selectedUserVersion, "1.2.3");
  });

  test("marks list parse failures as unverifiable when a user install path exists", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "user-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath, scope: "user", version: "1.2.3" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    const status = getPluginInstallStatus("code", registryPath, "{not-json");

    assert.equal(status.hasValidUserScopedEntry, false);
    assert.equal(status.enabledStateUnverified, true);
  });

  test("marks a missing user entry in the list snapshot as unverifiable", async () => {
    const tmpDir = await makeTempDir();
    const installPath = path.join(tmpDir, "user-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath, scope: "user", version: "1.2.3" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    const status = getPluginInstallStatus(
      "code",
      registryPath,
      JSON.stringify([
        { enabled: true, id: "platform@closedloop-ai", scope: "user" },
      ])
    );

    assert.equal(status.hasValidUserScopedEntry, false);
    assert.equal(status.enabledStateUnverified, true);
  });
});

describe("getCodePluginVersion", () => {
  const originalEnv = process.env.CL_PLUGIN_VERSION;

  afterEach(() => {
    // Restore env var after each test that may have mutated it.
    if (originalEnv === undefined) {
      delete process.env.CL_PLUGIN_VERSION;
    } else {
      process.env.CL_PLUGIN_VERSION = originalEnv;
    }
  });

  test("returns version from registry when code@closedloop-ai is present", async () => {
    const tmpDir = await makeTempDir();
    delete process.env.CL_PLUGIN_VERSION;
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath: tmpDir, scope: "user", version: "1.2.3" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(getCodePluginVersion(registryPath), "1.2.3");
  });

  test("returns 'unknown' when code@closedloop-ai is absent from registry", async () => {
    const tmpDir = await makeTempDir();
    delete process.env.CL_PLUGIN_VERSION;
    const registry = { version: 2, plugins: {} };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(getCodePluginVersion(registryPath), "unknown");
  });

  test("returns 'unknown' when registry file does not exist", () => {
    delete process.env.CL_PLUGIN_VERSION;
    assert.equal(
      getCodePluginVersion("/nonexistent/path/installed_plugins.json"),
      "unknown"
    );
  });

  test("returns CL_PLUGIN_VERSION env var when set to a valid semver", () => {
    process.env.CL_PLUGIN_VERSION = "3.4.5";
    assert.equal(getCodePluginVersion(), "3.4.5");
  });

  test("returns CL_PLUGIN_VERSION with pre-release suffix", () => {
    process.env.CL_PLUGIN_VERSION = "1.0.0-beta.1";
    assert.equal(getCodePluginVersion(), "1.0.0-beta.1");
  });

  test("returns CL_PLUGIN_VERSION with build metadata suffix", () => {
    process.env.CL_PLUGIN_VERSION = "1.0.0+build.42";
    assert.equal(getCodePluginVersion(), "1.0.0+build.42");
  });

  test("returns 'unknown' when CL_PLUGIN_VERSION fails semver validation", () => {
    process.env.CL_PLUGIN_VERSION = "not-a-version";
    assert.equal(getCodePluginVersion(), "unknown");
  });

  test("returns 'unknown' when CL_PLUGIN_VERSION exceeds 64 chars", () => {
    process.env.CL_PLUGIN_VERSION = `1.0.0+${"a".repeat(60)}`;
    assert.equal(getCodePluginVersion(), "unknown");
  });

  test("returns 'unknown' when registry version fails semver validation", async () => {
    const tmpDir = await makeTempDir();
    delete process.env.CL_PLUGIN_VERSION;
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath: tmpDir, scope: "user", version: "installed" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(getCodePluginVersion(registryPath), "unknown");
  });

  test("env var takes precedence over registry", async () => {
    const tmpDir = await makeTempDir();
    process.env.CL_PLUGIN_VERSION = "9.9.9";
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath: tmpDir, scope: "user", version: "1.0.0" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(getCodePluginVersion(registryPath), "9.9.9");
  });

  test("returns 'unknown' when registry installPath no longer exists (stale manifest)", async () => {
    const tmpDir = await makeTempDir();
    delete process.env.CL_PLUGIN_VERSION;
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          {
            installPath: path.join(tmpDir, "gone"),
            scope: "user",
            version: "1.2.3",
          },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(getCodePluginVersion(registryPath), "unknown");
  });

  test("returns 'unknown' for project-scoped registry versions", async () => {
    const tmpDir = await makeTempDir();
    delete process.env.CL_PLUGIN_VERSION;
    const installPath = path.join(tmpDir, "project-plugin");
    await fs.mkdir(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          { installPath, scope: "project", version: "1.2.3" },
        ],
      },
    };
    const registryPath = path.join(tmpDir, "installed_plugins.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));

    assert.equal(getCodePluginVersion(registryPath), "unknown");
  });
});
