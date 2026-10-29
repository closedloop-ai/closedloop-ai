import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { getCodePluginVersion } from "../src/server/operations/plugin-cache.js";

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

  test("returns 'unknown' when the user-scoped install is disabled", async () => {
    const tmpDir = await makeTempDir();
    delete process.env.CL_PLUGIN_VERSION;
    const registry = {
      version: 2,
      plugins: {
        "code@closedloop-ai": [
          {
            installPath: tmpDir,
            scope: "user",
            version: "1.2.3",
            enabled: false,
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
