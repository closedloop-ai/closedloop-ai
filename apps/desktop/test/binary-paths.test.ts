/**
 * T-3.14: Tests for the GET/PATCH /api/gateway/settings/binary-paths route
 * and the T-3.13 guard (desktop:update-settings rejecting binaryPaths).
 * T-4.1: Unit tests for resolveHarnessBinary.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { SettingsStore } from "../src/main/settings-store.js";
import { resolveHarnessBinary } from "../src/server/operations/binary-paths.js";
import { resetMcpDetectionCache } from "../src/server/operations/mcp-detection.js";
import {
  configureBinaryPathsResolver,
  resetResolvedClaudePath,
} from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.PATH = originalPath;
  process.env.HOME = originalHome;
  resetShellPathCache();
  resetResolvedClaudePath();
  resetMcpDetectionCache();
  configureBinaryPathsResolver(null);

  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type BinaryPathMap = {
  claude?: string;
  gh?: string;
  codex?: string;
  cursor?: string;
  opencode?: string;
  python3?: string;
  git?: string;
};

/**
 * Create a DesktopGatewayServer that has binary-path routes wired and
 * full health-check support. The in-memory store starts empty.
 */
async function createServerWithBinaryPaths(opts?: {
  initialPaths?: BinaryPathMap;
  binDir?: string;
  symphonyDir?: string;
}): Promise<{
  server: DesktopGatewayServer;
  store: SettingsStore;
  tmpDir: string;
  binDir: string;
  symphonyDir: string;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-paths-test-"));
  tempDirs.push(tmpDir);

  const binDir = opts?.binDir ?? path.join(tmpDir, "bin");
  const symphonyDir = opts?.symphonyDir ?? path.join(tmpDir, "symphony");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(symphonyDir, { recursive: true });

  // Write minimal fake binaries so health-check can pass
  const fakeBinaries: [string, string][] = [
    ["git", '#!/bin/sh\necho "git version 2.40.0"'],
    ["claude", '#!/bin/sh\necho "1.5.0"'],
    [
      "gh",
      '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\necho "gh version 2.40.0 (2024-01-01)"\n',
    ],
    ["codex", '#!/bin/sh\necho "0.1.0"'],
    ["cursor", '#!/bin/sh\necho "0.1.0"'],
    ["opencode", '#!/bin/sh\necho "0.1.0"'],
    ["python3", '#!/bin/sh\necho "Python 3.11.0"'],
  ];
  for (const [name, content] of fakeBinaries) {
    const binPath = path.join(binDir, name);
    fs.writeFileSync(binPath, content, { mode: 0o755 });
  }

  // Minimal symphony config so worktree-dir check passes
  const configDir = path.join(symphonyDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "repos.json"),
    JSON.stringify({
      settings: {
        worktreeParentDir: "/tmp/worktrees",
        worktreeParentDirConfirmed: true,
      },
    }),
    "utf-8"
  );

  // Minimal plugins dir so plugin checks pass
  const homeDir = path.join(tmpDir, "home");
  const pluginsDir = path.join(homeDir, ".claude", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pluginNames = [
    "code",
    "platform",
    "judges",
    "code-review",
    "self-learning",
  ];
  const pluginsRecord: Record<
    string,
    Array<{ installPath: string; version: string }>
  > = {};
  for (const name of pluginNames) {
    const installPath = path.join(tmpDir, `plugin-${name}`);
    fs.mkdirSync(installPath, { recursive: true });
    pluginsRecord[`${name}@closedloop-ai`] = [
      { installPath, version: "1.0.0" },
    ];
  }
  fs.writeFileSync(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: pluginsRecord }),
    "utf-8"
  );

  process.env.HOME = homeDir;
  process.env.PATH = binDir;
  setShellPathForTest();

  // In-memory settings store
  const storeName = "test-binary-paths";
  const storeDir = path.join(tmpDir, "store");
  fs.mkdirSync(storeDir, { recursive: true });
  const initialData = opts?.initialPaths
    ? { binaryPaths: opts.initialPaths }
    : {};
  fs.writeFileSync(
    path.join(storeDir, `${storeName}.json`),
    JSON.stringify(initialData)
  );
  const store = new SettingsStore({ cwd: storeDir, name: storeName });

  function getBinaryPaths(): BinaryPathMap {
    return store.getBinaryPaths();
  }

  function applyPatch(
    patch: Partial<
      Record<
        "claude" | "gh" | "codex" | "cursor" | "opencode" | "python3" | "git",
        string | null
      >
    >
  ): BinaryPathMap {
    // Mirror app.ts applyBinaryPathPatchAndInvalidateCaches validation
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null && value !== undefined) {
        const expanded = value.replace(/^~/, os.homedir());
        if (!path.isAbsolute(expanded)) {
          throw new Error(
            `Binary path for ${key} must be an absolute path: ${value}`
          );
        }
      }
    }
    const expandedPatch: Partial<
      Record<
        "claude" | "gh" | "codex" | "cursor" | "opencode" | "python3" | "git",
        string | null
      >
    > = {};
    for (const [key, value] of Object.entries(patch)) {
      expandedPatch[
        key as
          | "claude"
          | "gh"
          | "codex"
          | "cursor"
          | "opencode"
          | "python3"
          | "git"
      ] =
        value !== null && value !== undefined
          ? value.replace(/^~/, os.homedir())
          : value;
    }
    const updated = store.patchBinaryPaths(
      expandedPatch as Record<string, string | null>
    );
    resetResolvedClaudePath();
    resetMcpDetectionCache();
    return updated;
  }

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.example.test",
    getAllowedDirectories: () => [tmpDir],
    machineName: "binary-paths-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
    getGatewayId: () => "test-gateway-id",
    getBinaryPaths,
    applyBinaryPathPatch: applyPatch,
  });
  serversToClose.push(server);
  await server.start();

  return { server, store, tmpDir, binDir, symphonyDir };
}

function url(server: DesktopGatewayServer, p: string): string {
  return `http://127.0.0.1:${server.getActivePort()}${p}`;
}

// ---------------------------------------------------------------------------
// GET /api/gateway/settings/binary-paths
// ---------------------------------------------------------------------------

describe("GET /api/gateway/settings/binary-paths", () => {
  test("returns empty binaryPaths when none are set", async () => {
    const { server } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { binaryPaths: BinaryPathMap };
    assert.deepEqual(body.binaryPaths, {});
  });

  test("returns current binary paths when set", async () => {
    const { server } = await createServerWithBinaryPaths({
      initialPaths: { claude: "/usr/local/bin/claude", git: "/usr/bin/git" },
    });
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { binaryPaths: BinaryPathMap };
    assert.equal(body.binaryPaths.claude, "/usr/local/bin/claude");
    assert.equal(body.binaryPaths.git, "/usr/bin/git");
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/gateway/settings/binary-paths -- valid inputs
// ---------------------------------------------------------------------------

describe("PATCH /api/gateway/settings/binary-paths: valid inputs", () => {
  test("PATCH with claude absolute path -> 200, path persisted", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claude: "/absolute/path/to/claude" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { binaryPaths: BinaryPathMap };
    assert.equal(body.binaryPaths.claude, "/absolute/path/to/claude");
    assert.equal(store.getBinaryPaths().claude, "/absolute/path/to/claude");
  });

  test("PATCH with gh absolute path -> 200, persisted correctly", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gh: "/absolute/path/to/gh" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { binaryPaths: BinaryPathMap };
    assert.equal(body.binaryPaths.gh, "/absolute/path/to/gh");
    assert.equal(store.getBinaryPaths().gh, "/absolute/path/to/gh");
  });

  test("PATCH with codex absolute path -> 200, persisted correctly", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codex: "/usr/local/bin/codex" }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBinaryPaths().codex, "/usr/local/bin/codex");
  });

  test("PATCH with cursor absolute path -> 200, persisted correctly", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor: "/usr/local/bin/cursor" }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBinaryPaths().cursor, "/usr/local/bin/cursor");
  });

  test("PATCH with opencode absolute path -> 200, persisted correctly", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opencode: "/usr/local/bin/opencode" }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBinaryPaths().opencode, "/usr/local/bin/opencode");
  });

  test("PATCH with python3 absolute path -> 200, persisted correctly", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ python3: "/usr/bin/python3" }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBinaryPaths().python3, "/usr/bin/python3");
  });

  test("PATCH with git absolute path -> 200, persisted correctly", async () => {
    const { server, store } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ git: "/usr/bin/git" }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBinaryPaths().git, "/usr/bin/git");
  });

  test("PATCH with null value clears key", async () => {
    const { server, store } = await createServerWithBinaryPaths({
      initialPaths: { git: "/usr/bin/git" },
    });
    assert.equal(store.getBinaryPaths().git, "/usr/bin/git");

    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ git: null }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBinaryPaths().git, undefined);
  });

  test("after PATCH, GET returns updated paths", async () => {
    const { server } = await createServerWithBinaryPaths();

    // Patch
    await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claude: "/absolute/path/to/claude" }),
    });

    // GET should reflect the change
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"));
    const body = (await res.json()) as { binaryPaths: BinaryPathMap };
    assert.equal(body.binaryPaths.claude, "/absolute/path/to/claude");
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/gateway/settings/binary-paths -- invalid inputs (400)
// ---------------------------------------------------------------------------

describe("PATCH /api/gateway/settings/binary-paths: invalid inputs -> 400", () => {
  test("empty string value -> 400", async () => {
    const { server } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claude: "" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.includes("empty"),
      `Expected 'empty' in error: ${body.error}`
    );
  });

  test("unknown key -> 400", async () => {
    const { server } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "/usr/bin/node" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.includes("unknown key") || body.error.includes("node"),
      `Unexpected error: ${body.error}`
    );
  });

  test("relative path -> 400 (absolute path validation)", async () => {
    const { server } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claude: "relative/path/claude" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.includes("absolute") || body.error.includes("relative"),
      `Expected path validation error, got: ${body.error}`
    );
  });

  test("non-string non-null value -> 400", async () => {
    const { server } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claude: 42 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.includes("string") || body.error.includes("null"),
      `Unexpected error: ${body.error}`
    );
  });

  test("array body -> 400", async () => {
    const { server } = await createServerWithBinaryPaths();
    const res = await fetch(url(server, "/api/gateway/settings/binary-paths"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ claude: "/usr/bin/claude" }]),
    });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Integration: PATCH then health-check uses the override
// ---------------------------------------------------------------------------

describe("health-check uses binary path override after PATCH", () => {
  test("claude override_invalid appears in health-check when override path doesn't exist", async () => {
    const { server } = await createServerWithBinaryPaths();

    // PATCH with a non-existent claude path
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-hc-test-"));
    tempDirs.push(fakeDir);
    const fakeClaude = path.join(fakeDir, "claude");
    // Do NOT create the file

    const patchRes = await fetch(
      url(server, "/api/gateway/settings/binary-paths"),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claude: fakeClaude }),
      }
    );
    assert.equal(patchRes.status, 200);

    // Health-check should now show the override was tried
    const hcRes = await fetch(url(server, "/api/gateway/health-check"));
    assert.equal(hcRes.status, 200);
    const body = (await hcRes.json()) as {
      checks: Array<{
        id: string;
        passed: boolean;
        error?: string;
        debug?: { overrideUsed?: string };
      }>;
    };
    const claudeCheck = body.checks.find((c) => c.id === "claude-cli");
    assert.ok(claudeCheck, "claude-cli check should be present");
    assert.equal(
      claudeCheck.passed,
      false,
      "claude-cli should fail with invalid override"
    );
    assert.ok(
      claudeCheck.debug?.overrideUsed === fakeClaude ||
        claudeCheck.error?.includes("Override"),
      `Expected override reference in health-check result. error=${claudeCheck.error}, overrideUsed=${claudeCheck.debug?.overrideUsed}`
    );
  });

  test("gh override_invalid appears in health-check when override path doesn't exist", async () => {
    const { server } = await createServerWithBinaryPaths();

    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-hc-gh-test-"));
    tempDirs.push(fakeDir);
    const fakeGh = path.join(fakeDir, "gh");

    const patchRes = await fetch(
      url(server, "/api/gateway/settings/binary-paths"),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gh: fakeGh }),
      }
    );
    assert.equal(patchRes.status, 200);

    const hcRes = await fetch(url(server, "/api/gateway/health-check"));
    assert.equal(hcRes.status, 200);
    const body = (await hcRes.json()) as {
      checks: Array<{ id: string; passed: boolean; error?: string }>;
    };
    const ghCheck = body.checks.find((c) => c.id === "gh-cli");
    assert.ok(ghCheck, "gh-cli check should be present");
    assert.equal(ghCheck.passed, false);
    assert.ok(
      ghCheck.error?.includes("Override") ||
        ghCheck.error?.includes("not exist"),
      `Expected override-related error, got: ${ghCheck.error}`
    );
  });

  test("git override_invalid appears in health-check when override path doesn't exist", async () => {
    const { server } = await createServerWithBinaryPaths();

    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-hc-git-test-"));
    tempDirs.push(fakeDir);
    const fakeGit = path.join(fakeDir, "git");

    const patchRes = await fetch(
      url(server, "/api/gateway/settings/binary-paths"),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ git: fakeGit }),
      }
    );
    assert.equal(patchRes.status, 200);

    const hcRes = await fetch(url(server, "/api/gateway/health-check"));
    assert.equal(hcRes.status, 200);
    const body = (await hcRes.json()) as {
      checks: Array<{ id: string; passed: boolean; error?: string }>;
    };
    const gitCheck = body.checks.find((c) => c.id === "git");
    assert.ok(gitCheck, "git check should be present");
    assert.equal(gitCheck.passed, false);
    assert.ok(
      gitCheck.error?.includes("Override") ||
        gitCheck.error?.includes("not exist"),
      `Expected override-related error, got: ${gitCheck.error}`
    );
  });

  test("valid override path (executable) allows binary check to succeed", async () => {
    const { server, binDir } = await createServerWithBinaryPaths();

    // claude binary in binDir is executable -- patch to its absolute path
    const claudeBinPath = path.join(binDir, "claude");

    const patchRes = await fetch(
      url(server, "/api/gateway/settings/binary-paths"),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claude: claudeBinPath }),
      }
    );
    assert.equal(patchRes.status, 200);

    const hcRes = await fetch(url(server, "/api/gateway/health-check"));
    assert.equal(hcRes.status, 200);
    const body = (await hcRes.json()) as {
      checks: Array<{ id: string; passed: boolean }>;
    };
    const claudeCheck = body.checks.find((c) => c.id === "claude-cli");
    assert.ok(claudeCheck, "claude-cli check should be present");
    assert.equal(
      claudeCheck.passed,
      true,
      "claude-cli should pass with valid override"
    );
  });
});

// ---------------------------------------------------------------------------
// T-3.13 guard: SettingsStore.update() must not accept binaryPaths
// ---------------------------------------------------------------------------

describe("T-3.13 guard: SettingsStore.update() does not accept binaryPaths", () => {
  function makeTempStore(): SettingsStore {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "settings-guard-test-")
    );
    tempDirs.push(tmpDir);
    const storeName = "guard-test";
    fs.writeFileSync(
      path.join(tmpDir, `${storeName}.json`),
      JSON.stringify({})
    );
    return new SettingsStore({ cwd: tmpDir, name: storeName });
  }

  test("SettingsStore.update() silently ignores binaryPaths (whitelist behavior)", () => {
    // The update() method has an explicit whitelist; binaryPaths is NOT in the whitelist.
    // It should be silently ignored (not persisted), matching the existing whitelist behavior.
    const store = makeTempStore();

    // Cast to bypass TypeScript check to simulate what a rogue caller could send
    store.update({ sandboxBaseDirectory: "/tmp/sandbox" } as Parameters<
      typeof store.update
    >[0]);
    assert.equal(store.getAll().sandboxBaseDirectory, "/tmp/sandbox");

    // binaryPaths must not be persisted via update()
    (store.update as (p: Record<string, unknown>) => void)({
      binaryPaths: { claude: "/evil/path" },
    });
    assert.deepEqual(
      store.getBinaryPaths(),
      {},
      "binaryPaths should not be written via update()"
    );
  });
});

// ---------------------------------------------------------------------------
// T-3.13 guard: app.ts desktop:update-settings handler rejects binaryPaths
// ---------------------------------------------------------------------------

describe("T-3.13 guard: applyBinaryPathPatchAndInvalidateCaches validates absolute paths", () => {
  function makeApplyPatch(store: SettingsStore) {
    // Replicate the validation from app.ts applyBinaryPathPatchAndInvalidateCaches
    return function applyPatch(
      patch: Partial<
        Record<
          "claude" | "gh" | "codex" | "cursor" | "opencode" | "python3" | "git",
          string | null
        >
      >
    ): BinaryPathMap {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== null && value !== undefined) {
          const expanded = value.replace(/^~/, os.homedir());
          if (!path.isAbsolute(expanded)) {
            throw new Error(
              `Binary path for ${key} must be an absolute path: ${value}`
            );
          }
        }
      }
      return store.patchBinaryPaths(patch as Record<string, string | null>);
    };
  }

  test("relative path throws an error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-test-"));
    tempDirs.push(tmpDir);
    const store = new SettingsStore({ cwd: tmpDir, name: "apply-patch-test" });
    const applyPatch = makeApplyPatch(store);

    assert.throws(
      () => applyPatch({ claude: "relative/path/to/claude" }),
      /absolute path/i
    );
    assert.deepEqual(store.getBinaryPaths(), {});
  });

  test("absolute path does not throw", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "apply-patch-abs-test-")
    );
    tempDirs.push(tmpDir);
    const store = new SettingsStore({
      cwd: tmpDir,
      name: "apply-patch-abs-test",
    });
    const applyPatch = makeApplyPatch(store);

    assert.doesNotThrow(() =>
      applyPatch({ claude: "/absolute/path/to/claude" })
    );
    assert.equal(store.getBinaryPaths().claude, "/absolute/path/to/claude");
  });

  test("null value (clear) does not throw", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "apply-patch-null-test-")
    );
    tempDirs.push(tmpDir);
    const store = new SettingsStore({
      cwd: tmpDir,
      name: "apply-patch-null-test",
    });
    const applyPatch = makeApplyPatch(store);

    applyPatch({ claude: "/absolute/path" });
    assert.doesNotThrow(() => applyPatch({ claude: null }));
    assert.equal(store.getBinaryPaths().claude, undefined);
  });
});

// ---------------------------------------------------------------------------
// T-4.1: resolveHarnessBinary unit tests
// ---------------------------------------------------------------------------

describe("resolveHarnessBinary", () => {
  test('"claude" harness returns "claude"', () => {
    assert.equal(resolveHarnessBinary("claude"), "claude");
  });

  test('"codex" harness returns "codex"', () => {
    assert.equal(resolveHarnessBinary("codex"), "codex");
  });

  test('"cursor" harness returns "cursor"', () => {
    assert.equal(resolveHarnessBinary("cursor"), "cursor");
  });

  test('"opencode" harness returns "opencode"', () => {
    assert.equal(resolveHarnessBinary("opencode"), "opencode");
  });

  test('undefined harness defaults to "claude"', () => {
    assert.equal(resolveHarnessBinary(undefined), "claude");
  });
});
