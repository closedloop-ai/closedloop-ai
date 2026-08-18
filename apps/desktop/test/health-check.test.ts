import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _applyPluginVersionChecksForTesting,
  _getPluginUpdateStderrTailForTesting,
  _runDefaultCommandForTesting,
  _runDefaultPluginUpdateCommandForTesting,
  _setKnownBinaryLocationsForTesting,
  _setRunCommandForTesting,
  _shouldEnablePluginAutoUpdateForTesting,
  registerHealthCheckRoutes,
} from "../src/server/operations/health-check.js";
import type { McpDetectionResult } from "../src/server/operations/mcp-detection.js";
import {
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const TARGET_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);
const MISSING_ENV_VALUE = "__missing__";
const tempDirs: string[] = [];

afterEach(async () => {
  resetShellPathCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("health-check Claude probe env", () => {
  test("claude --version stays on plain shell env", async () => {
    const { capture, readyEnv } = await runCapturedClaudeCommand(
      async (fakeClaude) => {
        await _runDefaultCommandForTesting(fakeClaude, ["--version"]);
      }
    );

    assert.deepEqual(missingReadyInjectedKeys(readyEnv), []);
    assert.equal(capture.ARGS, "--version");
    assert.deepEqual(leakedOtelEnvKeys(capture), []);
  });

  test("claude plugin list stays on plain shell env", async () => {
    const { capture, readyEnv } = await runCapturedClaudeCommand(
      async (fakeClaude) => {
        await _runDefaultCommandForTesting(fakeClaude, [
          "plugin",
          "list",
          "--json",
        ]);
      }
    );

    assert.deepEqual(missingReadyInjectedKeys(readyEnv), []);
    assert.equal(capture.ARGS, "plugin list --json");
    assert.deepEqual(leakedOtelEnvKeys(capture), []);
  });

  test("claude plugin update stays on plain shell env", async () => {
    const { capture, readyEnv } = await runCapturedClaudeCommand(
      async (fakeClaude) => {
        await _runDefaultPluginUpdateCommandForTesting("code@closedloop-ai", {
          claudeOverride: fakeClaude,
        });
      }
    );

    assert.deepEqual(missingReadyInjectedKeys(readyEnv), []);
    assert.equal(capture.ARGS, "plugin update code@closedloop-ai --scope user");
    assert.deepEqual(leakedOtelEnvKeys(capture), []);
  });
});

async function runCapturedClaudeCommand(
  runner: (fakeClaude: string) => Promise<void>
): Promise<{
  capture: Record<string, string>;
  readyEnv: Record<string, string>;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "health-otel-env-"));
  tempDirs.push(tempDir);
  const fakeClaude = path.join(tempDir, "claude");
  const capturePath = path.join(tempDir, "env.txt");
  await writeFakeClaude(fakeClaude);
  const readyProvider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
    getBaseShellEnv: async () => ({ PATH: tempDir }),
  });
  const readyEnv = await readyProvider();

  await withShellPathEnvForTest(
    {
      PATH: tempDir,
      SHELL: "/bin/sh",
      HOME: tempDir,
      CAPTURE_FILE: capturePath,
    },
    async () => {
      setShellPathForTest();
      await runner(fakeClaude);
    }
  );

  const rawCapture = await readFile(capturePath, "utf-8");
  const capture = Object.fromEntries(
    rawCapture
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
  return { capture, readyEnv };
}

async function writeFakeClaude(fakeClaude: string): Promise<void> {
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "print_capture() {",
      "  value=$(printenv \"$1\" || printf '__missing__')",
      '  printf \'%s=%s\\n\' "$1" "$value"',
      "}",
      "{",
      "  printf 'ARGS=%s\\n' \"$*\"",
      "  print_capture CLAUDE_CODE_ENABLE_TELEMETRY",
      "  print_capture OTEL_METRICS_EXPORTER",
      "  print_capture OTEL_LOGS_EXPORTER",
      "  print_capture OTEL_EXPORTER_OTLP_PROTOCOL",
      "  print_capture OTEL_EXPORTER_OTLP_ENDPOINT",
      '} >> "$CAPTURE_FILE"',
      'if [ "$1" = "--version" ]; then',
      "  printf 'claude 1.0.0\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
      "  printf '[]\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "plugin" ] && [ "$2" = "update" ]; then',
      "  printf 'updated\\n'",
      "  exit 0",
      "fi",
      "printf 'ok\\n'",
      "",
    ].join("\n")
  );
  await chmod(fakeClaude, 0o755);
}

function leakedOtelEnvKeys(capture: Record<string, string>): string[] {
  return TARGET_ENV_KEYS.filter((key) => capture[key] !== MISSING_ENV_VALUE);
}

function missingReadyInjectedKeys(env: Record<string, string>): string[] {
  return [
    env[ClaudeCodeOtelEnvVar.EnableTelemetry] === "1"
      ? ""
      : ClaudeCodeOtelEnvVar.EnableTelemetry,
    env[ClaudeCodeOtelEnvVar.OtlpEndpoint] === "http://127.0.0.1:4318"
      ? ""
      : ClaudeCodeOtelEnvVar.OtlpEndpoint,
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Local type for assertions (not imported — internal type is not exported)
// ---------------------------------------------------------------------------
type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
};

// ---------------------------------------------------------------------------
// Shared helper: build a health-check dispatcher with a fake MCP detector and
// a temp symphony dir (no repos.json → worktree check fails gracefully).
// ---------------------------------------------------------------------------
function makeHealthCheckDispatcher(
  symphonyTempDir: string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerHealthCheckRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    () => symphonyTempDir,
    async () =>
      ({
        available: false,
        serverName: null,
        matchedUrl: null,
        checkedAt: new Date().toISOString(),
        closedloopAvailable: false,
      }) as McpDetectionResult
  );
  return dispatcher;
}

// Shared runCommand stub that makes all binary --version calls throw a given
// error code, returns an empty plugin list, and rejects gh auth.
function makeVersionErrorStub(
  code: string,
  stderr: string,
  message: string
): (cmd: string, args: string[]) => Promise<{ stdout: string }> {
  return (_cmd, args) => {
    if (args[0] === "--version") {
      throw Object.assign(new Error(message), { code, stderr });
    }
    if (args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
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

// ---------------------------------------------------------------------------
// Group A — defaultRunCommand error paths
// ---------------------------------------------------------------------------
describe("defaultRunCommand options and error paths", () => {
  test("explicit timeoutMs is used when options is defined (line 334 path 0)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-cmd-opts-"));
    tempDirs.push(tempDir);
    const fakeCmd = path.join(tempDir, "mybin");
    await writeFile(fakeCmd, "#!/bin/sh\nprintf 'mybin 1.0.0'\n");
    await chmod(fakeCmd, 0o755);

    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const { stdout } = await _runDefaultCommandForTesting(
          fakeCmd,
          ["--version"],
          {
            timeoutMs: 5000,
          }
        );
        assert.ok(stdout.includes("1.0.0"));
      }
    );
  });

  test("killed process sets code to ETIMEDOUT (line 343)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-cmd-kill-"));
    tempDirs.push(tempDir);
    const hang = path.join(tempDir, "hang");
    // Use a pure shell busy-loop (no external commands) so the script is
    // immune to whatever PATH is in the env passed to execFileAsync.
    await writeFile(hang, "#!/bin/sh\nwhile :; do :; done\n");
    await chmod(hang, 0o755);

    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        let threw = false;
        try {
          await _runDefaultCommandForTesting(hang, [], { timeoutMs: 50 });
        } catch (err) {
          threw = true;
          const e = err as { code: string };
          assert.equal(e.code, "ETIMEDOUT");
        }
        assert.ok(threw, "expected a throw on timeout");
      }
    );
  });

  test("non-zero exit → error carries stderr and message (lines 344, 348)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-cmd-err-"));
    tempDirs.push(tempDir);
    const failScript = path.join(tempDir, "fail");
    await writeFile(
      failScript,
      "#!/bin/sh\nprintf 'bad thing happened' >&2\nexit 1\n"
    );
    await chmod(failScript, 0o755);

    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        let threw = false;
        try {
          await _runDefaultCommandForTesting(failScript, []);
        } catch (err) {
          threw = true;
          const e = err as { code: string; stderr: string; message: string };
          assert.equal(typeof e.stderr, "string");
          assert.ok(
            e.stderr.includes("bad thing"),
            `expected stderr content, got: ${e.stderr}`
          );
          assert.equal(typeof e.message, "string");
          assert.ok(e.message.length > 0, "expected non-empty message");
        }
        assert.ok(threw, "expected a throw on non-zero exit");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group B — pure helper functions
// ---------------------------------------------------------------------------
describe("_shouldEnablePluginAutoUpdateForTesting", () => {
  test("returns true when requested and claude-cli passed", () => {
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(true, [
        { id: "claude-cli", passed: true },
      ]),
      true
    );
  });

  test("returns false when requested but claude-cli not passed", () => {
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(true, [
        { id: "claude-cli", passed: false },
      ]),
      false
    );
  });

  test("returns false when not requested even if claude-cli passed", () => {
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(false, [
        { id: "claude-cli", passed: true },
      ]),
      false
    );
  });

  test("returns false when no claude-cli check is present", () => {
    assert.equal(
      _shouldEnablePluginAutoUpdateForTesting(true, [
        { id: "git", passed: true },
      ]),
      false
    );
  });

  test("returns false for empty check list", () => {
    assert.equal(_shouldEnablePluginAutoUpdateForTesting(true, []), false);
  });
});

describe("_getPluginUpdateStderrTailForTesting", () => {
  test("undefined returns empty string", () => {
    assert.equal(_getPluginUpdateStderrTailForTesting(undefined), "");
  });

  test("empty string returns empty string", () => {
    assert.equal(_getPluginUpdateStderrTailForTesting(""), "");
  });

  test("short string is returned unchanged", () => {
    assert.equal(
      _getPluginUpdateStderrTailForTesting("error message"),
      "error message"
    );
  });

  test("Buffer is converted to string", () => {
    assert.equal(
      _getPluginUpdateStderrTailForTesting(Buffer.from("buf error")),
      "buf error"
    );
  });

  test("string longer than 512 chars is trimmed to last 512", () => {
    const long = "x".repeat(600);
    const tail = _getPluginUpdateStderrTailForTesting(long);
    assert.equal(tail.length, 512);
    assert.equal(tail, "x".repeat(512));
  });
});

// ---------------------------------------------------------------------------
// Group C — classifyBinaryError / classifyBinaryRemediation via route
// ---------------------------------------------------------------------------
describe("classifyBinaryError and classifyBinaryRemediation via route", () => {
  afterEach(() => {
    _setRunCommandForTesting();
    _setKnownBinaryLocationsForTesting(null);
  });

  test("unknown error code → raw error and 'See diagnostics' remediation (lines 854, 888)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-eunk-"));
    tempDirs.push(tempDir);

    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeVersionErrorStub(
        "EUNKNOWN",
        "socket hang up",
        "spawn error"
      ) as Parameters<typeof _setRunCommandForTesting>[0]
    );

    const dispatcher = makeHealthCheckDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const res = await dispatchOperation({
          dispatcher,
          method: "GET",
          pathname: "/api/gateway/health-check",
        });
        assert.equal(res.statusCode, 200);
        const checks = (res.body as { checks: CheckResult[] }).checks;
        const gitCheck = checks.find((c) => c.id === "git");
        assert.ok(gitCheck, "git check must be present");
        assert.equal(gitCheck.passed, false);
        assert.ok(
          gitCheck.error?.startsWith("EUNKNOWN:"),
          `error should start with EUNKNOWN:, got: ${gitCheck.error}`
        );
        assert.equal(gitCheck.remediation, "See diagnostics tab for details");
      }
    );
  });

  test("ENOENT with binary at known location → 'Found at X but not on PATH' (lines 827, 864, 866)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-enoent-found-"));
    tempDirs.push(tempDir);
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "hc-empty-a-"));
    tempDirs.push(emptyDir);

    // Place an executable "git" at a known location (tempDir/git).
    const fakeGit = path.join(tempDir, "git");
    await writeFile(fakeGit, "#!/bin/sh\nexit 0\n");
    await chmod(fakeGit, 0o755);

    // Override: only git has our fake path; all others are empty.
    _setKnownBinaryLocationsForTesting({
      git: [fakeGit],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makeVersionErrorStub("ENOENT", "", "spawn ENOENT") as Parameters<
        typeof _setRunCommandForTesting
      >[0]
    );

    const dispatcher = makeHealthCheckDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const res = await dispatchOperation({
          dispatcher,
          method: "GET",
          pathname: "/api/gateway/health-check",
        });
        assert.equal(res.statusCode, 200);
        const checks = (res.body as { checks: CheckResult[] }).checks;
        const gitCheck = checks.find((c) => c.id === "git");
        assert.ok(gitCheck, "git check must be present");
        assert.equal(gitCheck.passed, false);
        assert.ok(
          gitCheck.error?.includes("Found at") &&
            gitCheck.error?.includes(fakeGit),
          `expected "Found at <path>" in error, got: ${gitCheck.error}`
        );
        assert.ok(
          gitCheck.remediation?.includes("PATH"),
          `expected PATH in remediation, got: ${gitCheck.remediation}`
        );
      }
    );
  });

  test("EACCES with non-executable at known location → 'not executable' (lines 840, 844, 877, 881)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-eacces-"));
    tempDirs.push(tempDir);
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "hc-empty-b-"));
    tempDirs.push(emptyDir);

    // Place a non-executable "git" at a known location.
    const fakeGit = path.join(tempDir, "git");
    await writeFile(fakeGit, "#!/bin/sh\nexit 0\n");
    await chmod(fakeGit, 0o644);

    _setKnownBinaryLocationsForTesting({
      git: [fakeGit],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting((_cmd, args) => {
      if (args[0] === "--version") {
        throw Object.assign(new Error("spawn EACCES"), {
          code: "EACCES",
          stderr: "",
        });
      }
      if (args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
        return Promise.resolve({ stdout: "[]" });
      }
      if (args[0] === "auth") {
        throw Object.assign(new Error("not found"), {
          code: "EACCES",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "" });
    });

    const dispatcher = makeHealthCheckDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const res = await dispatchOperation({
          dispatcher,
          method: "GET",
          pathname: "/api/gateway/health-check",
        });
        assert.equal(res.statusCode, 200);
        const checks = (res.body as { checks: CheckResult[] }).checks;
        const gitCheck = checks.find((c) => c.id === "git");
        assert.ok(gitCheck, "git check must be present");
        assert.equal(gitCheck.passed, false);
        assert.ok(
          gitCheck.error?.includes("not executable") &&
            gitCheck.error?.includes(fakeGit),
          `expected "not executable at <path>" in error, got: ${gitCheck.error}`
        );
        assert.ok(
          gitCheck.remediation?.includes("chmod"),
          `expected chmod in remediation, got: ${gitCheck.remediation}`
        );
      }
    );
  });

  test("ETIMEDOUT with binary at known location → 'Timed out running X --version' (line 851)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-etimedout-"));
    tempDirs.push(tempDir);
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "hc-empty-c-"));
    tempDirs.push(emptyDir);

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
      makeVersionErrorStub("ETIMEDOUT", "", "timeout") as Parameters<
        typeof _setRunCommandForTesting
      >[0]
    );

    const dispatcher = makeHealthCheckDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: emptyDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const res = await dispatchOperation({
          dispatcher,
          method: "GET",
          pathname: "/api/gateway/health-check",
        });
        assert.equal(res.statusCode, 200);
        const checks = (res.body as { checks: CheckResult[] }).checks;
        const gitCheck = checks.find((c) => c.id === "git");
        assert.ok(gitCheck, "git check must be present");
        assert.equal(gitCheck.passed, false);
        assert.ok(
          gitCheck.error?.includes("Timed out running") &&
            gitCheck.error?.includes(fakeGit),
          `expected "Timed out running <path>" in error, got: ${gitCheck.error}`
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Group D — checkPlugin branches via route
// ---------------------------------------------------------------------------

// Stub that returns specific JSON for plugin list and rejects everything else.
function makePluginListStub(
  listJson: string
): (cmd: string, args: string[]) => Promise<{ stdout: string }> {
  return (_cmd, args) => {
    if (args[0] === "--version") {
      throw Object.assign(new Error("not found"), {
        code: "ENOENT",
        stderr: "",
      });
    }
    if (args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
      return Promise.resolve({ stdout: listJson });
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

describe("checkPlugin branches via route", () => {
  afterEach(() => {
    _setRunCommandForTesting();
    _setKnownBinaryLocationsForTesting(null);
  });

  test("empty plugin list → all plugins report 'Not found' (default branch)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-plugin-nf-"));
    tempDirs.push(tempDir);

    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makePluginListStub("[]") as Parameters<typeof _setRunCommandForTesting>[0]
    );

    // Override HOME so readInstalledPluginsFile finds no registry, ensuring
    // hasExistingUserInstallPath=false regardless of the host's plugin state.
    const savedHomeEnv = saveEnvVars(["HOME"]);
    process.env.HOME = tempDir;
    const dispatcher = makeHealthCheckDispatcher(tempDir);
    try {
      await withShellPathEnvForTest(
        { PATH: tempDir, SHELL: "/bin/sh" },
        async () => {
          setShellPathForTest();
          const res = await dispatchOperation({
            dispatcher,
            method: "GET",
            pathname: "/api/gateway/health-check",
          });
          assert.equal(res.statusCode, 200);
          const checks = (res.body as { checks: CheckResult[] }).checks;
          const codeCheck = checks.find((c) => c.id === "plugin-code");
          assert.ok(codeCheck, "plugin-code check must be present");
          assert.equal(codeCheck.passed, false);
          assert.equal(codeCheck.error, "Not found");
        }
      );
    } finally {
      restoreEnvVars(savedHomeEnv);
    }
  });

  test("plugin disabled in list → error is 'Disabled' (line 1305)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-plugin-dis-"));
    tempDirs.push(tempDir);
    const disabledJson = JSON.stringify([
      { id: "code@closedloop-ai", scope: "user", enabled: false },
    ]);

    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makePluginListStub(disabledJson) as Parameters<
        typeof _setRunCommandForTesting
      >[0]
    );

    const dispatcher = makeHealthCheckDispatcher(tempDir);
    await withShellPathEnvForTest(
      { PATH: tempDir, SHELL: "/bin/sh" },
      async () => {
        setShellPathForTest();
        const res = await dispatchOperation({
          dispatcher,
          method: "GET",
          pathname: "/api/gateway/health-check",
        });
        assert.equal(res.statusCode, 200);
        const checks = (res.body as { checks: CheckResult[] }).checks;
        const codeCheck = checks.find((c) => c.id === "plugin-code");
        assert.ok(codeCheck, "plugin-code check must be present");
        assert.equal(codeCheck.passed, false);
        assert.equal(codeCheck.error, "Disabled");
        assert.ok(
          codeCheck.remediation?.includes("plugin enable"),
          `expected 'plugin enable' in remediation, got: ${codeCheck.remediation}`
        );
      }
    );
  });

  test("plugin only at project scope → 'Installed at project scope' (line 1317)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hc-plugin-proj-"));
    tempDirs.push(tempDir);
    const projectJson = JSON.stringify([
      { id: "code@closedloop-ai", scope: "project", enabled: true },
    ]);

    _setKnownBinaryLocationsForTesting({
      git: [],
      claude: [],
      gh: [],
      codex: [],
      python3: [],
    });
    _setRunCommandForTesting(
      makePluginListStub(projectJson) as Parameters<
        typeof _setRunCommandForTesting
      >[0]
    );

    // Override HOME so readInstalledPluginsFile finds no registry, ensuring
    // hasExistingUserInstallPath=false (required to reach the project-scope branch).
    const savedHomeEnv = saveEnvVars(["HOME"]);
    process.env.HOME = tempDir;
    const dispatcher = makeHealthCheckDispatcher(tempDir);
    try {
      await withShellPathEnvForTest(
        { PATH: tempDir, SHELL: "/bin/sh" },
        async () => {
          setShellPathForTest();
          const res = await dispatchOperation({
            dispatcher,
            method: "GET",
            pathname: "/api/gateway/health-check",
          });
          assert.equal(res.statusCode, 200);
          const checks = (res.body as { checks: CheckResult[] }).checks;
          const codeCheck = checks.find((c) => c.id === "plugin-code");
          assert.ok(codeCheck, "plugin-code check must be present");
          assert.equal(codeCheck.passed, false);
          assert.equal(codeCheck.error, "Installed at project scope");
        }
      );
    } finally {
      restoreEnvVars(savedHomeEnv);
    }
  });
});

// ---------------------------------------------------------------------------
// Group E + F — _applyPluginVersionChecksForTesting
// ---------------------------------------------------------------------------
describe("_applyPluginVersionChecksForTesting version enrichment", () => {
  let savedFetch: typeof globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  test("installed version > latest → check remains passed (line 1550 path 0)", async () => {
    savedFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ version: "1.0.0" });

    const checks: CheckResult[] = [
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: true,
      },
    ];
    const result = await _applyPluginVersionChecksForTesting(
      checks,
      { "code@closedloop-ai": "2.0.0" },
      { preferConfiguredMarketplace: false }
    );
    const codeCheck = result.find((c) => c.id === "plugin-code");
    assert.ok(codeCheck, "plugin-code check must be present");
    assert.equal(codeCheck.passed, true);
    assert.equal(codeCheck.version, "2.0.0");
    assert.equal(codeCheck.error, undefined);
  });

  test("non-numeric installed version → 'Could not verify installed version' (line 1633)", async () => {
    savedFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ version: "1.0.0" });

    const checks: CheckResult[] = [
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: true,
      },
    ];
    const result = await _applyPluginVersionChecksForTesting(
      checks,
      { "code@closedloop-ai": "1.0.0-beta" },
      { preferConfiguredMarketplace: false }
    );
    const codeCheck = result.find((c) => c.id === "plugin-code");
    assert.ok(codeCheck, "plugin-code check must be present");
    assert.equal(codeCheck.passed, false);
    assert.equal(codeCheck.error, "Could not verify installed version");
    assert.ok(
      codeCheck.remediation?.includes("claude plugin install"),
      `expected 'claude plugin install' in remediation, got: ${codeCheck.remediation}`
    );
  });

  test("non-plugin check id is returned unchanged (line 1716)", async () => {
    savedFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ version: "1.0.0" });

    const gitCheck: CheckResult = {
      id: "git",
      label: "Git",
      required: true,
      passed: true,
      version: "2.43.0",
    };
    const pluginCheck: CheckResult = {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: true,
    };
    const result = await _applyPluginVersionChecksForTesting(
      [gitCheck, pluginCheck],
      { "code@closedloop-ai": "1.0.0" },
      { preferConfiguredMarketplace: false }
    );
    const resultGit = result.find((c) => c.id === "git");
    // git is not a plugin check so it must be returned exactly as passed in
    assert.deepEqual(resultGit, gitCheck);
  });

  test("pluginAutoUpdateEnabled: true is passed through explicitly (line 663)", async () => {
    savedFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ version: "1.0.0" });

    // All plugins installed at "1.0.0" which equals the latest version, so no
    // auto-update is triggered even with pluginAutoUpdateEnabled: true.
    const checks: CheckResult[] = [
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: true,
      },
    ];
    const result = await _applyPluginVersionChecksForTesting(
      checks,
      { "code@closedloop-ai": "1.0.0" },
      { pluginAutoUpdateEnabled: true, preferConfiguredMarketplace: false }
    );
    const codeCheck = result.find((c) => c.id === "plugin-code");
    assert.ok(codeCheck, "plugin-code check must be present");
    // Version equals latest → up to date, even with auto-update enabled
    assert.equal(codeCheck.passed, true);
  });
});
