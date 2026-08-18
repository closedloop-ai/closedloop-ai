/**
 * ISS-5299 – branch coverage for health-check.ts operations (part 1).
 * Covers lines not yet reached by health-check.test.ts or health-check-mcp.test.ts.
 * Groups H-J (marketplace/configured-marketplace branches) are in health-check-ops-2.test.ts.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _applyPluginVersionChecksForTesting,
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
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
} from "../src/server/operations/health-check-types.js";
import type { McpDetectionResult } from "../src/server/operations/mcp-detection.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

// ---------------------------------------------------------------------------
// Module-level regex constants (Biome useTopLevelRegex)
// ---------------------------------------------------------------------------
const XCODE_SELECT_REGEX = /xcode-select/;
const GIT_SCM_REGEX = /git-scm\.com/;
const BREW_GH_REGEX = /brew install gh/;
const CLI_GITHUB_REGEX = /cli\.github\.com/;
const BREW_PYTHON_REGEX = /brew install python/;
const PYTHON_ORG_REGEX = /python\.org/;
const SHELL_WORD_REGEX = /\bshell\b/;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;
let savedPlatform: string = process.platform;
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
  updateAttempted?: boolean;
  updateOutcome?: string;
  version?: string;
  debug?: Record<string, unknown>;
};

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
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  if (originalShell === undefined) {
    Reflect.deleteProperty(process.env, "SHELL");
  } else {
    process.env.SHELL = originalShell;
  }
  Object.defineProperty(process, "platform", {
    value: savedPlatform,
    configurable: true,
  });
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const unavailableMcp = async (): Promise<McpDetectionResult> => ({
  available: false,
  serverName: null,
  matchedUrl: null,
  checkedAt: "2026-01-01T00:00:00.000Z",
  closedloopAvailable: false,
});

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

/** Throws a typed Error instead of using assert.ok so Biome noMisplacedAssertion stays quiet. */
function findCheck(checks: CheckResult[], id: string): CheckResult {
  const c = checks.find((ch) => ch.id === id);
  if (!c) {
    throw new Error(
      `check "${id}" not found in [${checks.map((ch) => ch.id).join(", ")}]`
    );
  }
  return c;
}

/** Stub: all --version calls throw the given error; plugin list returns []. */
function makeEnoentStub(
  code = "ENOENT",
  stderr = "",
  message = "spawn ENOENT"
) {
  return (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "--version") {
      throw Object.assign(new Error(message), { code, stderr });
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return Promise.resolve({ stdout: "[]" });
    }
    if (args[0] === "auth") {
      throw Object.assign(new Error("not found"), {
        code: "ENOENT",
        stderr: "",
      });
    }
    return Promise.resolve({ stdout: "" });
  };
}

/** Stub: all --version calls succeed; plugin list returns []. */
function makeSuccessStub() {
  return (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
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
  };
}

// Plugin constants aligned with CLOSEDLOOP_USER_PLUGINS
const PLUGIN_KEYS = [
  "code@closedloop-ai",
  "platform@closedloop-ai",
  "judges@closedloop-ai",
  "code-review@closedloop-ai",
  "self-learning@closedloop-ai",
] as const;

const PLUGIN_CHECKS: CheckResult[] = [
  { id: "plugin-code", label: "Symphony Plugin", required: true, passed: true },
  {
    id: "plugin-platform",
    label: "Platform Plugin",
    required: true,
    passed: true,
  },
  {
    id: "plugin-judges",
    label: "Judges Plugin",
    required: true,
    passed: true,
  },
  {
    id: "plugin-code-review",
    label: "Code Review Plugin",
    required: true,
    passed: true,
  },
  {
    id: "plugin-self-learning",
    label: "Self-Learning Plugin",
    required: true,
    passed: true,
  },
];

// ---------------------------------------------------------------------------
// Group A — defaultRunPluginUpdateCommand override_invalid (line 468)
// ---------------------------------------------------------------------------
describe("defaultRunPluginUpdateCommand — claude override_invalid", () => {
  test("nonexistent claudeOverride path → outcome=failed, failureReason=cli_unavailable (line 468)", {
    timeout: 5000,
  }, async () => {
    await withShellPathEnvForTest(
      { PATH: os.tmpdir(), SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const result = await _runDefaultPluginUpdateCommandForTesting(
          "code@closedloop-ai",
          {
            claudeOverride: path.join(os.tmpdir(), "nonexistent-claude-zzz-99"),
          }
        );
        assert.equal(result.outcome, "failed");
        assert.equal(result.failureReason, "cli_unavailable");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group B — getInstallRemediation platform branches (lines 723, 729, 731, 737, 739, 745)
// ---------------------------------------------------------------------------
describe("getInstallRemediation — platform-specific remediation text", () => {
  test("darwin → xcode-select for git, brew-gh for gh, brew-python for python3 (lines 723, 731, 739)", {
    timeout: 10_000,
  }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-darwin-"));
    tempDirs.push(tempDir);
    savedPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeEnoentStub() as Parameters<typeof _setRunCommandForTesting>[0]
    );
    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const git = findCheck(checks, "git");
        const gh = findCheck(checks, "gh-cli");
        const python3 = findCheck(checks, "python3");
        assert.ok(
          XCODE_SELECT_REGEX.test(git.remediation ?? ""),
          `git remediation on darwin: ${git.remediation}`
        );
        assert.ok(
          BREW_GH_REGEX.test(gh.remediation ?? ""),
          `gh remediation on darwin: ${gh.remediation}`
        );
        assert.ok(
          BREW_PYTHON_REGEX.test(python3.remediation ?? ""),
          `python3 remediation on darwin: ${python3.remediation}`
        );
      }
    );
  });

  test("win32/default → git-scm for git, cli.github for gh, python.org for python3 (lines 729, 737, 745)", {
    timeout: 10_000,
  }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-win32-"));
    tempDirs.push(tempDir);
    savedPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeEnoentStub() as Parameters<typeof _setRunCommandForTesting>[0]
    );
    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const git = findCheck(checks, "git");
        const gh = findCheck(checks, "gh-cli");
        const python3 = findCheck(checks, "python3");
        assert.ok(
          GIT_SCM_REGEX.test(git.remediation ?? ""),
          `git remediation on win32: ${git.remediation}`
        );
        assert.ok(
          CLI_GITHUB_REGEX.test(gh.remediation ?? ""),
          `gh remediation on win32: ${gh.remediation}`
        );
        assert.ok(
          PYTHON_ORG_REGEX.test(python3.remediation ?? ""),
          `python3 remediation on win32: ${python3.remediation}`
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group C — expandTilde and SHELL env branches (lines 755, 812, 866)
// ---------------------------------------------------------------------------
describe("expandTilde and SHELL fallback", () => {
  test("known location '~' triggers expandTilde and runs without error (line 755)", {
    timeout: 10_000,
  }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-tilde-"));
    tempDirs.push(tempDir);
    _setKnownBinaryLocationsForTesting({
      git: ["~"],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeEnoentStub() as Parameters<typeof _setRunCommandForTesting>[0]
    );
    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const git = findCheck(checks, "git");
        // expandTilde("~") ran; git is checked and fails as expected
        assert.equal(git.passed, false);
      }
    );
  });

  test("SHELL unset + binary at known location → remediation uses 'shell' fallback (lines 812, 866)", {
    timeout: 10_000,
  }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-shell-"));
    tempDirs.push(tempDir);
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-shell-e-"));
    tempDirs.push(emptyDir);

    // executable git at known location, not in PATH
    const fakeGit = path.join(tempDir, "git");
    await writeFile(fakeGit, "#!/bin/sh\nexit 0\n");
    await chmod(fakeGit, 0o755);

    _setKnownBinaryLocationsForTesting({
      git: [fakeGit],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeEnoentStub() as Parameters<typeof _setRunCommandForTesting>[0]
    );
    // Unset SHELL so debug.shell is "" and classifyBinaryRemediation uses "shell" fallback
    Reflect.deleteProperty(process.env, "SHELL");

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest({ PATH: emptyDir }, async () => {
      setShellPathForTest();
      const { checks } = await dispatchHealthCheck(dispatcher);
      const git = findCheck(checks, "git");
      assert.equal(git.passed, false);
      // git is found at fakeGit (known location) but not on PATH
      assert.ok(
        git.error?.includes("Found at"),
        `expected 'Found at' in error: ${git.error}`
      );
      // remediation must use fallback "shell" word (not "zsh"/"bash")
      assert.ok(
        SHELL_WORD_REGEX.test(git.remediation ?? ""),
        `expected 'shell' in remediation: ${git.remediation}`
      );
      assert.ok(
        git.remediation?.includes("PATH"),
        `expected 'PATH' in remediation: ${git.remediation}`
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Group D — classifyBinaryError EUNKNOWN false branch (line 854)
// ---------------------------------------------------------------------------
describe("classifyBinaryError — EUNKNOWN fallback branches", () => {
  test("EUNKNOWN with empty stderr → falls back to message field (line 854 false branch)", {
    timeout: 10_000,
  }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-eunk-"));
    tempDirs.push(tempDir);
    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeEnoentStub("EUNKNOWN", "", "pipe broke unexpectedly") as Parameters<
        typeof _setRunCommandForTesting
      >[0]
    );
    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const git = findCheck(checks, "git");
        assert.ok(
          git.error?.includes("pipe broke unexpectedly"),
          `expected message text in error: ${git.error}`
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group E — checkPlugin branches (lines 1301, 1326)
// ---------------------------------------------------------------------------
describe("checkPlugin — enableOutcome:skipped and install path missing", () => {
  test("unrunnable plugin list + existing installPath + no pluginAutoUpdate → enableOutcome:skipped", {
    timeout: 10_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ph1-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ph1-s-"));
    tempDirs.push(tempDir);

    // create install path on disk so hasExistingUserInstallPath = true
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
    await mkdir(path.join(homeDir, ".claude", "plugins"), {
      recursive: true,
    });
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

    // Every `plugin list` form throws, so the command could not be RUN at all.
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "list") {
        throw Object.assign(new Error("list failed"), {
          code: "EUNKNOWN",
          stderr: "",
        });
      }
      if (args[0] === "--version") {
        return Promise.resolve({ stdout: "1.0.0" });
      }
      if (args[0] === "auth") {
        return Promise.resolve({ stdout: "" });
      }
      return Promise.resolve({ stdout: "" });
    });

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        // no pluginAutoUpdate → pluginAutoUpdateEnabled = false
        const { checks } = await dispatchHealthCheck(dispatcher);
        const codeCheck = findCheck(checks, "plugin-code");
        // ISS-5810: a command that could not run reports THAT, not the generic
        // unverified state — and must never prescribe `claude plugin enable`,
        // which fails by design once the plugin is already enabled.
        assert.equal(codeCheck.error, PLUGIN_LIST_COMMAND_FAILED_ERROR);
        assert.ok(!codeCheck.remediation?.includes("plugin enable"));
        assert.equal(codeCheck.enableOutcome, "skipped");
      }
    );
  });

  test("plugin list runs but omits the plugin → states that, and never prescribes `plugin enable`", {
    timeout: 10_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ph3-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ph3-s-"));
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

    // The command RUNS and parses — it just reports an empty inventory. Before
    // ISS-5810 this rendered identically to a command that never ran.
    _setRunCommandForTesting((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "list") {
        return Promise.resolve({ stdout: "[]" });
      }
      return Promise.resolve({ stdout: "1.0.0" });
    });

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const codeCheck = findCheck(checks, "plugin-code");
        assert.equal(codeCheck.error, PLUGIN_STATE_UNVERIFIED_ERROR);
        assert.notEqual(codeCheck.error, PLUGIN_LIST_COMMAND_FAILED_ERROR);
        // The closed loop: `claude plugin enable` errors out once the plugin is
        // already enabled, so it must never be the offered next step here.
        assert.ok(!codeCheck.remediation?.includes("plugin enable"));
      }
    );
  });

  test("user-scoped registry entry + nonexistent installPath → 'Install path missing' (line 1326)", {
    timeout: 10_000,
  }, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ph2-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-ops-ph2-s-"));
    tempDirs.push(tempDir);

    const missingPath = path.join(homeDir, "nonexistent-install-dir-zzz");
    await mkdir(path.join(homeDir, ".claude", "plugins"), {
      recursive: true,
    });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "code@closedloop-ai": [{ scope: "user", installPath: missingPath }],
        },
      })
    );

    // empty plugin list → no disabled/enabled signals
    _setRunCommandForTesting(
      makeSuccessStub() as Parameters<typeof _setRunCommandForTesting>[0]
    );

    const dispatcher = makeDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { checks } = await dispatchHealthCheck(dispatcher);
        const codeCheck = findCheck(checks, "plugin-code");
        assert.equal(codeCheck.error, "Install path missing");
        assert.ok(
          codeCheck.remediation?.includes("claude plugin install"),
          `remediation: ${codeCheck.remediation}`
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group F — applyPluginVersionChecks non-plugin passthrough (line 1716)
// ---------------------------------------------------------------------------
describe("applyPluginVersionChecks — non-plugin check passthrough", () => {
  test("non-plugin check id passes through unchanged (line 1716)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ version: "2.0.0" }))) as typeof fetch;

    const gitCheck: CheckResult = {
      id: "git",
      label: "Git",
      required: true,
      passed: true,
    };
    const allChecks = [...PLUGIN_CHECKS, gitCheck] as unknown as Parameters<
      typeof _applyPluginVersionChecksForTesting
    >[0];
    const installed = Object.fromEntries(PLUGIN_KEYS.map((k) => [k, "2.0.0"]));

    const result = await _applyPluginVersionChecksForTesting(
      allChecks,
      installed
    );

    const resultGit = result.find((c) => c.id === "git");
    assert.deepEqual(resultGit, gitCheck);
  });
});

// ---------------------------------------------------------------------------
// Group G — fetchPluginManifests GitHub fetch result branches (lines 1767, 1769)
// ---------------------------------------------------------------------------
describe("fetchPluginManifests — GitHub fetch result branches", () => {
  test("fetch returns JSON with string version → latestVersion set on all checks (line 1767)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ version: "3.1.0" }))) as typeof fetch;

    const installed = Object.fromEntries(PLUGIN_KEYS.map((k) => [k, "3.1.0"]));
    const result = await _applyPluginVersionChecksForTesting(
      PLUGIN_CHECKS as unknown as Parameters<
        typeof _applyPluginVersionChecksForTesting
      >[0],
      installed
    );

    // All plugins should show passed:true (same version)
    for (const check of result.filter((c) => c.id.startsWith("plugin-"))) {
      assert.equal(check.passed, true, `${check.id} should pass`);
    }
  });

  test("fetch returns JSON with non-string version → error:manifest_unavailable (line 1769)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ version: 42 }))) as typeof fetch;

    const installed = Object.fromEntries(PLUGIN_KEYS.map((k) => [k, "1.0.0"]));
    const result = await _applyPluginVersionChecksForTesting(
      PLUGIN_CHECKS as unknown as Parameters<
        typeof _applyPluginVersionChecksForTesting
      >[0],
      installed
    );

    // Non-string version → manifest_unavailable → check becomes "could not verify"
    for (const check of result.filter((c) => c.id.startsWith("plugin-"))) {
      assert.equal(
        check.error,
        "Could not verify latest version",
        `${check.id}: ${check.error}`
      );
    }
  });
});
