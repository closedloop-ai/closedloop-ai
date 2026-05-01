import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_INSTALLER_SCRIPT } from "../desktop-installer-script";
import { buildDesktopOnboardingCommand } from "../desktop-managed-onboarding";

type ScriptResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const INSTALLER_SCRIPT_TEST_TIMEOUT_MS = 15_000;

async function writeExecutable(filePath: string, content: string) {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

function runBashScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [scriptPath], { env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

describe("buildDesktopOnboardingCommand", () => {
  it("includes only installer handoff values and excludes trusted origins/secrets", () => {
    const command = buildDesktopOnboardingCommand({
      onboardingAttemptId: "attempt-123",
      webAppOrigin: "https://app.closedloop.ai",
      desktopDownloadUrl: "https://github.com/closedloop-ai/release.dmg",
      installerScriptUrl: "https://app.closedloop.ai/api/desktop/install.sh",
      sandboxBaseDirectory: "~/workspace",
    });

    expect(command).toContain("CL_ONBOARDING_ATTEMPT_ID='attempt-123'");
    expect(command).toContain("CL_WEB_APP_ORIGIN='https://app.closedloop.ai'");
    expect(command).toContain(
      "CL_DESKTOP_DOWNLOAD_URL='https://github.com/closedloop-ai/release.dmg'"
    );
    expect(command).toContain("CL_SANDBOX_BASE_DIRECTORY='~/workspace'");
    expect(command).toContain("/api/desktop/install.sh");
    expect(command).toContain("curl -fsSL");
    expect(command).toContain('-o "$install_script"');
    expect(command).toContain('/bin/bash "$install_script"');
    expect(command).not.toContain("$(curl");
    expect(command).not.toContain("api.closedloop.ai");
    expect(command).not.toContain("relay.closedloop.ai");
    expect(command).not.toContain("sk_live_");
  });
});

describe("DESKTOP_INSTALLER_SCRIPT", () => {
  it("fails fast on unsupported operating systems before installer side effects", () => {
    const mainBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("main()")
    );
    const platformCheckIndex = mainBody.indexOf("ensure_supported_platform");
    const dependencyCheckIndex = mainBody.indexOf("ensure_brew_package git");

    expect(DESKTOP_INSTALLER_SCRIPT).toContain('[ "$(uname -s)" != "Darwin" ]');
    expect(platformCheckIndex).toBeGreaterThanOrEqual(0);
    expect(dependencyCheckIndex).toBeGreaterThan(platformCheckIndex);
  });

  it("writes the exact handoff file contract with 0600 permissions", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HANDOFF_DIR=");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Library/Application Support/ClosedLoop Desktop"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HANDOFF_FILE=");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("pending-onboarding.json");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      '{"onboardingAttemptId":"%s","webAppOrigin":"%s","sandboxBaseDirectory":"%s","createdAt":"%s"}'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('chmod 700 "$HANDOFF_DIR"');
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'handoff_tmp="$(mktemp "$HANDOFF_DIR/pending-onboarding.XXXXXX")"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('chmod 600 "$handoff_tmp"');
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'mv "$handoff_tmp" "$HANDOFF_FILE"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'sandbox="$(json_escape "$VALIDATED_SANDBOX_BASE_DIRECTORY")"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('[ -L "$HANDOFF_DIR" ]');
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain('> "$HANDOFF_FILE"');
  });

  it("does not create a handoff in non-interactive mode", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Non-interactive mode complete. No onboarding handoff was created."
    );
  });

  it("uses one retry only for retryable external-operation failures", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("sleep 3");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("is_retryable_log");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("is_permission_or_4xx_log");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HTTP[ /]5");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HTTP[ /]4");
  });

  it("wraps the Homebrew installer download before running it", () => {
    const homebrewBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_homebrew()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_brew_package()")
    );
    const downloadIndex = homebrewBody.indexOf(
      'run_external_step "homebrew_download" "raw.githubusercontent.com" curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$install_script"'
    );
    const installIndex = homebrewBody.indexOf(
      'run_external_step "homebrew_install" "raw.githubusercontent.com" /bin/bash "$install_script"'
    );

    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(downloadIndex);
    expect(homebrewBody).not.toContain(
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    );
  });

  it("uses executable checks before falling back to Homebrew packages", () => {
    const packageBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_brew_package()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_python3()")
    );
    const executableCheckIndex = packageBody.indexOf(
      'ensure_usable_command "$binary" "$binary" '
    );
    const homebrewIndex = packageBody.indexOf("ensure_homebrew");

    expect(DESKTOP_INSTALLER_SCRIPT).toContain("ensure_usable_command()");
    expect(packageBody).toContain("check_args[@]");
    expect(executableCheckIndex).toBeGreaterThanOrEqual(0);
    expect(homebrewIndex).toBeGreaterThan(executableCheckIndex);
  });

  it("bounds non-interactive command probes with a timeout", () => {
    const usableCommandBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_usable_command()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_brew_package()")
    );

    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "COMMAND_CHECK_TIMEOUT_SECONDS=15"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("run_with_timeout()");
    expect(usableCommandBody).toContain(
      'run_with_timeout "$COMMAND_CHECK_TIMEOUT_SECONDS" "$@"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("/usr/bin/perl");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("alarm $timeout");
  });

  it(
    "treats a hung command probe as unusable",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-timeout-")
      );
      const binDir = join(tempDir, "bin");
      const scriptPath = join(tempDir, "timeout-check.sh");
      const timeoutScript = DESKTOP_INSTALLER_SCRIPT.replace(
        "COMMAND_CHECK_TIMEOUT_SECONDS=15",
        "COMMAND_CHECK_TIMEOUT_SECONDS=1"
      ).replace(
        'main "$@"',
        "ensure_usable_command slowtool slowtool --version"
      );
      await mkdir(binDir, { recursive: true });
      await writeFile(scriptPath, timeoutScript);
      await chmod(scriptPath, 0o755);
      await writeExecutable(
        join(binDir, "slowtool"),
        `#!/usr/bin/env bash
sleep 5
`
      );

      const startedAt = Date.now();
      const result = await runBashScript(scriptPath, {
        ...process.env,
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });

      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(result.code).toBe(1);
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it("covers Desktop health-check CLI prerequisites in automated setup", () => {
    const mainBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("main()")
    );

    expect(mainBody).toContain("ensure_brew_package git git --version");
    expect(mainBody).toContain("ensure_brew_package gh gh --version");
    expect(mainBody).toContain("ensure_gh_auth");
    expect(mainBody).toContain("ensure_python3");
    expect(mainBody).toContain("ensure_claude_cli");
    expect(mainBody).toContain("ensure_closedloop_plugins");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "ensure_brew_package jq jq --version"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "npm install -g @anthropic-ai/claude-code"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("python@3.13");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'prepend_path_dir "$python_prefix/libexec/bin"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("refresh_npm_global_path");
  });

  it("downloads the ClosedLoop plugin installer before running it", () => {
    const pluginsBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_closedloop_plugins()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("quit_running_desktop()")
    );
    const downloadIndex = pluginsBody.indexOf(
      'run_external_step "plugins_download" "raw.githubusercontent.com" curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh -o "$install_script"'
    );
    const installIndex = pluginsBody.indexOf(
      'run_external_step "plugins_install" "raw.githubusercontent.com" /bin/bash "$install_script"'
    );

    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "without requiring a web-app deploy"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain(
      "CL_CLAUDE_PLUGINS_INSTALL_REF"
    );
    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(downloadIndex);
    expect(pluginsBody).not.toContain(
      "curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh | bash"
    );
  });

  it("verifies required ClosedLoop plugins before continuing", () => {
    const pluginsBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_closedloop_plugins()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("quit_running_desktop()")
    );
    const installIndex = pluginsBody.indexOf(
      'run_external_step "plugins_install"'
    );
    const verifyIndex = pluginsBody.indexOf("verify_closedloop_plugins");

    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "REQUIRED_CLOSEDLOOP_PLUGINS=(code platform judges code-review self-learning)"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Missing required ClosedLoop plugins after install"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "$HOME/.claude/plugins/installed_plugins.json"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      ".plugins[$key][]?.installPath // empty"
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(installIndex);
  });

  it(
    "checks remaining required prerequisites after one prerequisite fails",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-test-")
      );
      const binDir = join(tempDir, "bin");
      const homeDir = join(tempDir, "home");
      const logPath = join(tempDir, "calls.log");
      const scriptPath = join(tempDir, "install.sh");
      const workspaceDir = join(homeDir, "workspace");
      await mkdir(binDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(logPath, "");
      await writeFile(scriptPath, DESKTOP_INSTALLER_SCRIPT);
      await chmod(scriptPath, 0o755);

      await writeExecutable(
        join(binDir, "uname"),
        `#!/usr/bin/env bash
echo Darwin
`
      );
      await writeExecutable(
        join(binDir, "git"),
        `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$CALL_LOG"
echo 'git version 2.0.0'
`
      );
      await writeExecutable(
        join(binDir, "gh"),
        `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
      );
      await writeExecutable(
        join(binDir, "brew"),
        `#!/usr/bin/env bash
printf 'brew %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "list" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [ "$2" = "gh" ]; then
  echo 'gh install failed' >&2
  exit 1
fi
exit 0
`
      );
      await writeExecutable(
        join(binDir, "python3"),
        `#!/usr/bin/env bash
printf 'python3 %s\\n' "$*" >> "$CALL_LOG"
exit 0
`
      );
      await writeExecutable(
        join(binDir, "claude"),
        `#!/usr/bin/env bash
printf 'claude %s\\n' "$*" >> "$CALL_LOG"
echo '1.0.0'
`
      );
      await writeExecutable(
        join(binDir, "npm"),
        `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
      );
      await writeExecutable(
        join(binDir, "jq"),
        `#!/usr/bin/env bash
printf 'jq %s\\n' "$*" >> "$CALL_LOG"
key=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--arg" ] && [ "$2" = "key" ]; then
    key="$3"
    shift 3
  else
    shift
  fi
done
plugin="$(printf '%s' "$key" | sed 's/@closedloop-ai$//')"
plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
if [ -d "$plugin_path" ]; then
  echo "$plugin_path"
fi
`
      );
      await writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cat > "$output" <<'PLUGIN_INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.claude/plugins"
for plugin in code platform judges code-review self-learning; do
  mkdir -p "$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
done
cat > "$HOME/.claude/plugins/installed_plugins.json" <<'JSON'
{"plugins":{}}
JSON
PLUGIN_INSTALLER
chmod +x "$output"
`
      );

      const result = await runBashScript(scriptPath, {
        ...process.env,
        CALL_LOG: logPath,
        CL_SANDBOX_BASE_DIRECTORY: "~/workspace",
        CL_DESKTOP_NONINTERACTIVE: "1",
        HOME: homeDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const callLog = await readFile(logPath, "utf-8");

      expect(result.code).toBe(1);
      expect((await stat(workspaceDir)).isDirectory()).toBe(true);
      expect(combinedOutput).toContain("Workspace directory is ready:");
      expect(combinedOutput).toContain(
        "ClosedLoop Desktop prerequisite check failed at"
      );
      expect(combinedOutput).toContain(
        "Continuing to check remaining required prerequisites."
      );
      expect(combinedOutput).toContain(
        "ClosedLoop Desktop automated setup could not finish because"
      );
      expect(combinedOutput).toContain("GitHub CLI");
      expect(combinedOutput).toContain(
        "GitHub CLI authentication - skipped because GitHub CLI is unavailable"
      );
      expect(combinedOutput).not.toContain(
        "ClosedLoop Desktop installer failed at"
      );
      expect(callLog).toContain("brew install gh");
      expect(callLog).toContain("python3 -c");
      expect(callLog).toContain("claude --version");
      expect(callLog).toContain("jq --version");
      expect(callLog).toContain(
        "curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh"
      );
      expect(combinedOutput).not.toContain("desktop_download");
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it(
    "fails before Desktop install when the workspace directory cannot be created",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-workspace-")
      );
      const binDir = join(tempDir, "bin");
      const homeDir = join(tempDir, "home");
      const blockedPath = join(homeDir, "blocked");
      const logPath = join(tempDir, "calls.log");
      const scriptPath = join(tempDir, "install.sh");
      await mkdir(binDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(blockedPath, "not a directory");
      await writeFile(logPath, "");
      await writeFile(scriptPath, DESKTOP_INSTALLER_SCRIPT);
      await chmod(scriptPath, 0o755);

      await writeExecutable(
        join(binDir, "uname"),
        `#!/usr/bin/env bash
echo Darwin
`
      );
      await writeExecutable(
        join(binDir, "brew"),
        `#!/usr/bin/env bash
printf 'brew %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "shellenv" ]; then
  echo 'export PATH="$PATH"'
  exit 0
fi
exit 1
`
      );
      await writeExecutable(
        join(binDir, "git"),
        `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$CALL_LOG"
echo 'git version 2.0.0'
`
      );
      await writeExecutable(
        join(binDir, "gh"),
        `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
echo 'gh version 2.0.0'
`
      );
      await writeExecutable(
        join(binDir, "python3"),
        `#!/usr/bin/env bash
printf 'python3 %s\\n' "$*" >> "$CALL_LOG"
exit 0
`
      );
      await writeExecutable(
        join(binDir, "claude"),
        `#!/usr/bin/env bash
printf 'claude %s\\n' "$*" >> "$CALL_LOG"
echo '1.0.0'
`
      );
      await writeExecutable(
        join(binDir, "npm"),
        `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
      );
      await writeExecutable(
        join(binDir, "jq"),
        `#!/usr/bin/env bash
printf 'jq %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "--version" ]; then
  echo 'jq-1.7'
  exit 0
fi
key=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--arg" ] && [ "$2" = "key" ]; then
    key="$3"
    shift 3
  else
    shift
  fi
done
plugin="$(printf '%s' "$key" | sed 's/@closedloop-ai$//')"
plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
if [ -d "$plugin_path" ]; then
  echo "$plugin_path"
fi
`
      );
      await writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cat > "$output" <<'PLUGIN_INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.claude/plugins"
registry="$HOME/.claude/plugins/installed_plugins.json"
printf '{"plugins":{' > "$registry"
first=1
for plugin in code platform judges code-review self-learning; do
  plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
  mkdir -p "$plugin_path"
  if [ "$first" -eq 0 ]; then
    printf ',' >> "$registry"
  fi
  first=0
  printf '"%s@closedloop-ai":[{"installPath":"%s"}]' "$plugin" "$plugin_path" >> "$registry"
done
printf '}}\\n' >> "$registry"
PLUGIN_INSTALLER
chmod +x "$output"
`
      );

      const result = await runBashScript(scriptPath, {
        ...process.env,
        CALL_LOG: logPath,
        CL_DESKTOP_NONINTERACTIVE: "1",
        CL_SANDBOX_BASE_DIRECTORY: `${blockedPath}/Source`,
        HOME: homeDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const callLog = await readFile(logPath, "utf-8");

      expect(result.code).toBe(1);
      expect(combinedOutput).toContain("Workspace directory");
      expect(combinedOutput).toContain("Could not create workspace directory");
      expect(combinedOutput).toContain(
        "ClosedLoop Desktop prerequisite check failed at"
      );
      expect(combinedOutput).not.toContain(
        "ClosedLoop Desktop installer failed at"
      );
      expect(callLog).toContain("git --version");
      expect(callLog).toContain("claude --version");
      expect(callLog).toContain(
        "curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh"
      );
      expect(combinedOutput).not.toContain("desktop_download");
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it(
    "preserves PATH refreshes from successful prerequisite installs",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-path-")
      );
      const binDir = join(tempDir, "bin");
      const brewBinDir = join(tempDir, "homebrew", "bin");
      const npmPrefix = join(tempDir, "npm-prefix");
      const pythonPrefix = join(tempDir, "homebrew", "opt", "python@3.13");
      const homeDir = join(tempDir, "home");
      const workspaceDir = join(homeDir, "workspace");
      const jqReadyPath = join(tempDir, "jq-ready");
      const logPath = join(tempDir, "calls.log");
      const scriptPath = join(tempDir, "install.sh");
      await mkdir(binDir, { recursive: true });
      await mkdir(brewBinDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(logPath, "");
      await writeFile(scriptPath, DESKTOP_INSTALLER_SCRIPT);
      await chmod(scriptPath, 0o755);

      await writeExecutable(
        join(binDir, "uname"),
        `#!/usr/bin/env bash
echo Darwin
`
      );
      await writeExecutable(
        join(binDir, "git"),
        `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$CALL_LOG"
echo 'git version 2.0.0'
`
      );
      await writeExecutable(
        join(binDir, "gh"),
        `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
echo 'gh version 2.0.0'
`
      );
      await writeExecutable(
        join(binDir, "python3"),
        `#!/usr/bin/env bash
printf 'python3 %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
      );
      await writeExecutable(
        join(binDir, "jq"),
        `#!/usr/bin/env bash
printf 'jq %s\\n' "$*" >> "$CALL_LOG"
if [ ! -f "$FAKE_JQ_READY" ]; then
  exit 1
fi
if [ "$1" = "--version" ]; then
  echo 'jq-1.7'
  exit 0
fi
key=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--arg" ] && [ "$2" = "key" ]; then
    key="$3"
    shift 3
  else
    shift
  fi
done
plugin="$(printf '%s' "$key" | sed 's/@closedloop-ai$//')"
plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
if [ -d "$plugin_path" ]; then
  echo "$plugin_path"
fi
`
      );
      await writeExecutable(
        join(binDir, "brew"),
        `#!/usr/bin/env bash
printf 'brew %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "shellenv" ]; then
  if [ "\${2:-}" != "bash" ]; then
    echo 'set -gx PATH "$FAKE_BREW_BIN" $PATH'
    exit 0
  fi
  echo "export PATH=\\"$FAKE_BREW_BIN:\\$PATH\\""
  exit 0
fi
if [ "$1" = "--prefix" ] && [ "$2" = "python@3.13" ]; then
  echo "$FAKE_PYTHON_PREFIX"
  exit 0
fi
if [ "$1" = "list" ]; then
  case "$2" in
    python@3.13) [ -x "$FAKE_PYTHON_PREFIX/libexec/bin/python3" ] ;;
    jq) [ -x "$FAKE_BREW_BIN/jq" ] ;;
    node) [ -x "$FAKE_BREW_BIN/npm" ] ;;
    *) exit 1 ;;
  esac
  exit $?
fi
if [ "$1" = "install" ] && [ "$2" = "python@3.13" ]; then
  mkdir -p "$FAKE_PYTHON_PREFIX/libexec/bin"
  cat > "$FAKE_PYTHON_PREFIX/libexec/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
printf 'python3 %s\\n' "$*" >> "$CALL_LOG"
exit 0
PYTHON
  chmod +x "$FAKE_PYTHON_PREFIX/libexec/bin/python3"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "jq" ]; then
  touch "$FAKE_JQ_READY"
  exit 0
fi
exit 0
`
      );
      await writeExecutable(
        join(binDir, "npm"),
        `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "--version" ]; then
  echo '10.0.0'
  exit 0
fi
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
  echo "$FAKE_NPM_PREFIX"
  exit 0
fi
if [ "$1" = "install" ]; then
  mkdir -p "$FAKE_NPM_PREFIX/bin"
  cat > "$FAKE_NPM_PREFIX/bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'claude %s\\n' "$*" >> "$CALL_LOG"
echo '1.0.0'
CLAUDE
  chmod +x "$FAKE_NPM_PREFIX/bin/claude"
  exit 0
fi
exit 1
`
      );
      await writeExecutable(
        join(binDir, "claude"),
        `#!/usr/bin/env bash
printf 'claude %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
      );
      await writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cat > "$output" <<'PLUGIN_INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.claude/plugins"
registry="$HOME/.claude/plugins/installed_plugins.json"
printf '{"plugins":{' > "$registry"
first=1
for plugin in code platform judges code-review self-learning; do
  plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
  mkdir -p "$plugin_path"
  if [ "$first" -eq 0 ]; then
    printf ',' >> "$registry"
  fi
  first=0
  printf '"%s@closedloop-ai":[{"installPath":"%s"}]' "$plugin" "$plugin_path" >> "$registry"
done
printf '}}\\n' >> "$registry"
PLUGIN_INSTALLER
chmod +x "$output"
`
      );
      await writeExecutable(
        join(binDir, "osascript"),
        `#!/usr/bin/env bash
printf 'osascript %s\\n' "$*" >> "$CALL_LOG"
exit 0
`
      );
      await writeExecutable(
        join(binDir, "pgrep"),
        `#!/usr/bin/env bash
printf 'pgrep %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
      );

      const result = await runBashScript(scriptPath, {
        ...process.env,
        CALL_LOG: logPath,
        CL_SANDBOX_BASE_DIRECTORY: "~/workspace",
        CL_DESKTOP_NONINTERACTIVE: "1",
        FAKE_BREW_BIN: brewBinDir,
        FAKE_JQ_READY: jqReadyPath,
        FAKE_NPM_PREFIX: npmPrefix,
        FAKE_PYTHON_PREFIX: pythonPrefix,
        HOME: homeDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SHELL: "/usr/local/bin/fish",
      });

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const callLog = await readFile(logPath, "utf-8");

      expect(result.code).toBe(1);
      expect((await stat(workspaceDir)).isDirectory()).toBe(true);
      expect(combinedOutput).toContain("desktop_download");
      expect(combinedOutput).not.toContain(
        "ClosedLoop Desktop automated setup could not finish"
      );
      expect(callLog).toContain("brew shellenv bash");
      expect(callLog).toContain("brew install python@3.13");
      expect(callLog).toContain("python3 -c");
      expect(callLog).toContain("npm prefix -g");
      expect(callLog).toContain("npm install -g @anthropic-ai/claude-code");
      expect(callLog).toContain("claude --version");
      expect(callLog).toContain("brew install jq");
      expect(callLog).toContain("jq --version");
      expect(callLog).toContain(
        "curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh"
      );
      expect(callLog).toContain(
        'osascript -e quit app id "ai.closedloop.desktop"'
      );
      expect(callLog).toContain("pgrep -x ClosedLoop");
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it("validates the Desktop download URL before downloading", () => {
    const installBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("validate_desktop_download_url()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_node_npm()")
    );

    expect(installBody).toContain(
      "https://github.com/closedloop-ai/closedloop-electron/releases/download/*/*.dmg*"
    );
    expect(installBody).not.toContain("https://objects.githubusercontent.com");
    expect(installBody).toContain(
      "must be an HTTPS ClosedLoop Desktop release asset"
    );
  });

  it("stages and verifies the downloaded Desktop app before replacing an existing app", () => {
    const installBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("install_desktop_app()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("json_escape()")
    );
    const validateIndex = installBody.indexOf("validate_desktop_download_url");
    const downloadIndex = installBody.indexOf(
      'run_external_step "desktop_download"'
    );
    const sourceCheckIndex = installBody.indexOf('if [ -z "$app_source" ]');
    const stageCopyIndex = installBody.indexOf(
      'cp -R "$app_source" "$staged_app"'
    );
    const verifyIndex = installBody.indexOf(
      'verify_desktop_app_bundle "$staged_app"'
    );
    const backupIndex = installBody.indexOf(
      'mv "$APP_PATH" "$DESKTOP_INSTALL_BACKUP_APP"'
    );
    const replaceIndex = installBody.indexOf('mv "$staged_app" "$APP_PATH"');

    expect(installBody).not.toContain(
      "ClosedLoop Desktop already installed; skipping Desktop install."
    );
    expect(installBody).not.toContain('rm -rf "$APP_PATH"');
    expect(installBody).toContain(
      'DESKTOP_INSTALL_STAGING_ROOT="$(mktemp -d "/Applications/.closedloop-install.XXXXXX")"'
    );
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBeGreaterThan(validateIndex);
    expect(sourceCheckIndex).toBeGreaterThan(downloadIndex);
    expect(stageCopyIndex).toBeGreaterThan(sourceCheckIndex);
    expect(verifyIndex).toBeGreaterThan(stageCopyIndex);
    expect(backupIndex).toBeGreaterThan(verifyIndex);
    expect(replaceIndex).toBeGreaterThan(backupIndex);
    expect(installBody).toContain(
      'if [ -n "$DESKTOP_INSTALL_BACKUP_APP" ] && [ -d "$DESKTOP_INSTALL_BACKUP_APP" ] && [ ! -e "$APP_PATH" ]; then'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier'"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'codesign --verify --deep --strict "$candidate_app"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'spctl --assess --type execute "$candidate_app"'
    );
  });

  it("quits any running Desktop instance before replacing the app", () => {
    const quitBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("quit_running_desktop()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("install_desktop_app()")
    );
    const mainBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("main()")
    );
    const quitIndex = mainBody.indexOf("quit_running_desktop");
    const installIndex = mainBody.indexOf("install_desktop_app");

    expect(quitBody).toContain('osascript -e "quit app id \\"$BUNDLE_ID\\""');
    expect(quitBody).toContain('pgrep -x "$APP_NAME"');
    expect(quitBody).toContain('fail_step "desktop_quit"');
    expect(quitIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(quitIndex);
  });

  it("uses cleanup traps for temp installer and Desktop install artifacts", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "trap 'rm -f \"$install_script\"' EXIT"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "trap cleanup_desktop_install EXIT"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'hdiutil detach "$DESKTOP_INSTALL_MOUNT_ROOT"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'rm -f "$DESKTOP_INSTALL_DMG_PATH"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'rm -rf "$DESKTOP_INSTALL_STAGING_ROOT"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('copy_err_file="$(mktemp)"');
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain(
      "/tmp/closedloop-desktop-remove.err"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain(
      "/tmp/closedloop-desktop-copy.err"
    );
  });

  it(
    "keeps Desktop install cleanup state visible to the EXIT trap",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-cleanup-")
      );
      const binDir = join(tempDir, "bin");
      const applicationsDir = join(tempDir, "Applications");
      const logPath = join(tempDir, "calls.log");
      const dmgPathFile = join(tempDir, "dmg-path.txt");
      const scriptPath = join(tempDir, "install.sh");
      const cleanupScript = DESKTOP_INSTALLER_SCRIPT.replace(
        String.raw`APP_PATH="/Applications/\${APP_NAME}.app"`,
        `APP_PATH="${applicationsDir}/\${APP_NAME}.app"`
      )
        .replace(
          'DESKTOP_INSTALL_STAGING_ROOT="$(mktemp -d "/Applications/.closedloop-install.XXXXXX")"',
          `DESKTOP_INSTALL_STAGING_ROOT="$(mktemp -d "${applicationsDir}/.closedloop-install.XXXXXX")"`
        )
        .replace('main "$@"', "install_desktop_app");
      await mkdir(binDir, { recursive: true });
      await mkdir(applicationsDir, { recursive: true });
      await writeFile(logPath, "");
      await writeFile(scriptPath, cleanupScript);
      await chmod(scriptPath, 0o755);

      await writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
printf '%s' "$output" > "$DMG_PATH_FILE"
printf 'fake dmg' > "$output"
`
      );
      await writeExecutable(
        join(binDir, "hdiutil"),
        `#!/usr/bin/env bash
printf 'hdiutil %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "attach" ]; then
  mountpoint=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-mountpoint" ]; then
      mountpoint="$2"
      shift 2
    else
      shift
    fi
  done
  mkdir -p "$mountpoint/ClosedLoop.app/Contents"
  printf 'not a plist' > "$mountpoint/ClosedLoop.app/Contents/Info.plist"
  exit 0
fi
if [ "$1" = "detach" ]; then
  rm -rf "$2"
  exit 0
fi
exit 1
`
      );

      const result = await runBashScript(scriptPath, {
        ...process.env,
        CALL_LOG: logPath,
        CL_DESKTOP_DOWNLOAD_URL:
          "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.14.4/ClosedLoop-0.14.4-universal.dmg",
        DMG_PATH_FILE: dmgPathFile,
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const callLog = await readFile(logPath, "utf-8");
      const dmgPath = await readFile(dmgPathFile, "utf-8");
      const applicationEntries = await readdir(applicationsDir);

      expect(result.code).toBe(1);
      expect(combinedOutput).toContain("desktop_verify");
      expect(callLog).toContain("hdiutil detach");
      await expect(stat(dmgPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        applicationEntries.filter((entry) =>
          entry.startsWith(".closedloop-install.")
        )
      ).toEqual([]);
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it("rejects handoff values containing JSON control characters", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("reject_json_control_chars()");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'reject_json_control_chars "CL_ONBOARDING_ATTEMPT_ID"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'reject_json_control_chars "CL_WEB_APP_ORIGIN"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'reject_json_control_chars "CL_SANDBOX_BASE_DIRECTORY"'
    );
  });

  it("validates the workspace directory before writing the handoff", () => {
    const workspaceBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_workspace_directory()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("write_handoff_file()")
    );
    const mainBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("main()")
    );
    const workspaceIndex = mainBody.indexOf("ensure_workspace_directory");
    const finishIndex = mainBody.indexOf("finish_required_prerequisites");

    expect(workspaceBody).toContain("CL_SANDBOX_BASE_DIRECTORY");
    expect(workspaceBody).toContain("VALIDATED_SANDBOX_BASE_DIRECTORY");
    expect(workspaceBody).toContain("pwd -P");
    expect(workspaceBody).toContain("mkdir -p");
    expect(workspaceBody).toContain(".closedloop-write-test");
    expect(workspaceBody).toContain("not the root or home directory");
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    const captureIndex = mainBody.indexOf(
      "capture_validated_workspace_directory"
    );
    expect(captureIndex).toBeGreaterThan(workspaceIndex);
    expect(finishIndex).toBeGreaterThan(captureIndex);
  });

  it(
    "rejects root and home as automated setup workspace directories",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-workspace-root-")
      );
      const homeDir = join(tempDir, "home");
      const scriptPath = join(tempDir, "workspace-check.sh");
      const validatorScript = DESKTOP_INSTALLER_SCRIPT.replace(
        'main "$@"',
        "ensure_workspace_directory"
      );
      await mkdir(homeDir, { recursive: true });
      await writeFile(scriptPath, validatorScript);
      await chmod(scriptPath, 0o755);

      for (const workspaceValue of ["~", "/"]) {
        const result = await runBashScript(scriptPath, {
          ...process.env,
          CL_SANDBOX_BASE_DIRECTORY: workspaceValue,
          HOME: homeDir,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        });
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        expect(result.code).toBe(1);
        expect(combinedOutput).toContain("not the root or home directory");
      }
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it(
    "writes the canonical validated workspace path into the handoff",
    async () => {
      const tempDir = await mkdtemp(
        join(tmpdir(), "closedloop-installer-handoff-path-")
      );
      const homeDir = join(tempDir, "home");
      const scriptPath = join(tempDir, "handoff-check.sh");
      const workspaceDir = join(homeDir, "workspace");
      const rawWorkspacePath = `${workspaceDir}/../workspace`;
      const handoffScript = DESKTOP_INSTALLER_SCRIPT.replace(
        'main "$@"',
        'run_required_prerequisite "workspace_directory" "Workspace directory" ensure_workspace_directory; capture_validated_workspace_directory; finish_required_prerequisites; write_handoff_file'
      );
      await mkdir(homeDir, { recursive: true });
      await writeFile(scriptPath, handoffScript);
      await chmod(scriptPath, 0o755);

      const result = await runBashScript(scriptPath, {
        ...process.env,
        CL_ONBOARDING_ATTEMPT_ID: "attempt-123",
        CL_SANDBOX_BASE_DIRECTORY: rawWorkspacePath,
        CL_WEB_APP_ORIGIN: "http://localhost:3000",
        HOME: homeDir,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      });
      const handoff = JSON.parse(
        await readFile(
          join(
            homeDir,
            "Library",
            "Application Support",
            "ClosedLoop Desktop",
            "pending-onboarding.json"
          ),
          "utf-8"
        )
      ) as { sandboxBaseDirectory?: string };

      expect(result.code).toBe(0);
      await expect(realpath(workspaceDir)).resolves.toBe(
        handoff.sandboxBaseDirectory
      );
      expect(handoff.sandboxBaseDirectory).not.toBe(rawWorkspacePath);
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it("dispatches the handoff to the installed app path instead of bundle-id resolution", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'open -a "$APP_PATH" "$HANDOFF_FILE"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain('open -b "$BUNDLE_ID"');
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "automatic file-open dispatch failed"
    );
  });
});
