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

async function writeDesktopInstallerVerifierJq(binDir: string) {
  await writeExecutable(
    join(binDir, "jq"),
    `#!${process.execPath}
const fs = require("node:fs");

const args = process.argv.slice(2);
const argValues = {};
let filter = "";
let filePath = "";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "-r" || arg === "-e") {
    continue;
  }
  if (arg === "--arg") {
    argValues[args[index + 1]] = args[index + 2];
    index += 2;
    continue;
  }
  if (!filter) {
    filter = arg;
    continue;
  }
  if (!filePath) {
    filePath = arg;
  }
}

const raw = filePath ? fs.readFileSync(filePath, "utf-8") : fs.readFileSync(0, "utf-8");
const data = JSON.parse(raw || "null");
const key = argValues.key;

if (filter.includes('.plugins[$key][]?') && filter.includes('select(.scope == "user")')) {
  for (const entry of data.plugins?.[key] ?? []) {
    if (entry.scope === "user" && entry.installPath) {
      console.log(entry.installPath);
    }
  }
  process.exit(0);
}

if (filter.includes('select(.id == $key and .scope == "user")')) {
  const matches = data.filter((entry) => entry.id === key && entry.scope === "user");
  if (matches.length === 0) {
    console.log("missing");
  } else if (matches.some((entry) => entry.enabled === false)) {
    console.log("disabled");
  } else {
    console.log("enabled");
  }
  process.exit(0);
}

throw new Error(\`Unsupported jq filter: \${filter}\`);
`
  );
}

async function writeDesktopInstallerVerifierClaude(binDir: string) {
  await writeExecutable(
    join(binDir, "claude"),
    `#!${process.execPath}
const fs = require("node:fs");

const args = process.argv.slice(2);
const listPath = process.env.PLUGIN_LIST_FILE;
const logPath = process.env.CALL_LOG;
const scenario = process.env.PLUGIN_VERIFY_SCENARIO || "";

fs.appendFileSync(logPath, \`claude \${args.join(" ")}\\n\`);

if (args.join(" ") === "plugin list --json") {
  process.stdout.write(fs.readFileSync(listPath, "utf-8"));
  process.exit(0);
}

if (args.length === 5 && args[0] === "plugin" && args[1] === "enable" && args[3] === "--scope" && args[4] === "user") {
  const ref = args[2];
  if (scenario === "enable-fails" && ref === "code@closedloop-ai") {
    process.exit(1);
  }
  if (scenario !== "enable-still-disabled") {
    const entries = JSON.parse(fs.readFileSync(listPath, "utf-8"));
    for (const entry of entries) {
      if (entry.id === ref && entry.scope === "user") {
        entry.enabled = true;
      }
    }
    fs.writeFileSync(listPath, JSON.stringify(entries));
  }
  process.exit(0);
}

throw new Error(\`Unexpected claude call: \${args.join(" ")}\`);
`
  );
}

async function writeClosedloopPluginVerifierState(
  homeDir: string,
  listPath: string,
  options: {
    readonly codeScope?: "project" | "user";
    readonly codeEnabled?: boolean;
  } = {}
) {
  const registryPath = join(
    homeDir,
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
  const registry: Record<string, Record<string, string>[]> = {};
  const listEntries: Record<string, string | boolean>[] = [];

  await mkdir(join(homeDir, ".claude", "plugins"), { recursive: true });
  for (const plugin of [
    "bootstrap",
    "code",
    "code-review",
    "judges",
    "platform",
    "self-learning",
  ]) {
    const scope = plugin === "code" ? (options.codeScope ?? "user") : "user";
    const pluginPath = join(
      homeDir,
      ".claude",
      "plugins",
      "cache",
      "closedloop-ai",
      plugin,
      scope,
      "1.0.0"
    );
    await mkdir(pluginPath, { recursive: true });
    registry[`${plugin}@closedloop-ai`] = [
      {
        installPath: pluginPath,
        scope,
        version: "1.0.0",
      },
    ];
    listEntries.push({
      enabled: plugin === "code" ? (options.codeEnabled ?? true) : true,
      id: `${plugin}@closedloop-ai`,
      scope,
      version: "1.0.0",
    });
  }

  await writeFile(registryPath, JSON.stringify({ plugins: registry }));
  await writeFile(listPath, JSON.stringify(listEntries));
}

async function runClosedloopPluginVerifier(
  options: {
    readonly codeScope?: "project" | "user";
    readonly codeEnabled?: boolean;
    readonly scenario?: string;
  } = {}
) {
  const tempDir = await mkdtemp(join(tmpdir(), "closedloop-plugin-verify-"));
  const binDir = join(tempDir, "bin");
  const homeDir = join(tempDir, "home");
  const listPath = join(tempDir, "plugin-list.json");
  const logPath = join(tempDir, "calls.log");
  const scriptPath = join(tempDir, "verify-plugins.sh");
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(logPath, "");
  await writeDesktopInstallerVerifierJq(binDir);
  await writeDesktopInstallerVerifierClaude(binDir);
  await writeClosedloopPluginVerifierState(homeDir, listPath, options);
  await writeFile(
    scriptPath,
    DESKTOP_INSTALLER_SCRIPT.replace('main "$@"', "verify_closedloop_plugins")
  );
  await chmod(scriptPath, 0o755);

  const result = await runBashScript(scriptPath, {
    ...process.env,
    CALL_LOG: logPath,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PLUGIN_LIST_FILE: listPath,
    PLUGIN_VERIFY_SCENARIO: options.scenario ?? "",
  });

  return {
    ...result,
    log: await readFile(logPath, "utf-8"),
  };
}

async function runDesktopDownloadUrlValidation(downloadUrl: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "closedloop-desktop-url-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "calls.log");
  const scriptPath = join(tempDir, "validate-download-url.sh");
  await mkdir(binDir, { recursive: true });
  await writeFile(logPath, "");
  for (const command of ["curl", "hdiutil"]) {
    await writeExecutable(
      join(binDir, command),
      `#!/usr/bin/env bash
printf '${command} %s\\n' "$*" >> "$CALL_LOG"
exit 1
`
    );
  }
  await writeFile(
    scriptPath,
    DESKTOP_INSTALLER_SCRIPT.replace(
      'main "$@"',
      "validate_desktop_download_url"
    )
  );
  await chmod(scriptPath, 0o755);

  const result = await runBashScript(scriptPath, {
    ...process.env,
    CALL_LOG: logPath,
    CL_DESKTOP_DOWNLOAD_URL: downloadUrl,
    HOME: tempDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  });

  return {
    ...result,
    log: await readFile(logPath, "utf-8"),
  };
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

  it("handles the pre-rename ClosedLoop app during the brand transition (FEA-2101)", () => {
    // Quit wait must probe BOTH the new and legacy process names, otherwise a
    // still-running legacy ClosedLoop process blocks the replace undetected.
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('OLD_APP_NAME="ClosedLoop"');
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      `OLD_APP_PATH="/Applications/\${OLD_APP_NAME}.app"`
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'while pgrep -x "$APP_NAME" >/dev/null 2>&1 || pgrep -x "$OLD_APP_NAME" >/dev/null 2>&1; do'
    );

    // The stale-bundle removal MUST keep its -ef same-file guard: on the default
    // case-insensitive macOS volume OLD_APP_PATH and APP_PATH resolve to the same
    // directory, so without -ef the rm -rf would delete the app just installed.
    const installBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("install_desktop_app()")
    );
    expect(installBody).toContain(
      '[ "$OLD_APP_PATH" != "$APP_PATH" ] && [ -d "$OLD_APP_PATH" ] && [ -d "$APP_PATH" ] && ! [ "$OLD_APP_PATH" -ef "$APP_PATH" ]'
    );
    expect(installBody).toContain('rm -rf "$OLD_APP_PATH"');
    // The removal must run only AFTER the new bundle is moved into place.
    expect(installBody.indexOf('mv "$staged_app" "$APP_PATH"')).toBeLessThan(
      installBody.indexOf('rm -rf "$OLD_APP_PATH"')
    );
  });

  it("accepts a legacy ClosedLoop-* download URL and bundle during the transition (FEA-2101)", () => {
    // The server's release-resolution path now surfaces legacy DMG URLs, so the
    // download-URL validation must accept both casings, not just Closedloop-*.
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "/Closed[Ll]oop-([0-9]+\\.[0-9]+\\.[0-9]+)-universal\\.dmg$"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain(
      "/Closedloop-([0-9]+\\.[0-9]+\\.[0-9]+)-universal\\.dmg$"
    );

    // A legacy DMG mounts as ClosedLoop.app; the search must find either bundle
    // name (the staged copy normalizes to Closedloop.app on install).
    const installBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("install_desktop_app()")
    );
    expect(installBody).toContain(
      `\\( -name "\${APP_NAME}.app" -o -name "\${OLD_APP_NAME}.app" \\) -type d`
    );
    expect(installBody).toContain(
      `staged_app="$DESKTOP_INSTALL_STAGING_ROOT/\${APP_NAME}.app"`
    );
  });

  it("writes the exact handoff file contract with 0600 permissions", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HANDOFF_DIR=");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Library/Application Support/Closedloop Desktop"
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

  it("downloads the Closedloop plugin installer before running it", () => {
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

  it("verifies required Closedloop plugins before continuing", () => {
    const pluginsBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_closedloop_plugins()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("quit_running_desktop()")
    );
    const installIndex = pluginsBody.indexOf(
      'run_external_step "plugins_install"'
    );
    const verifyIndex = pluginsBody.indexOf("verify_closedloop_plugins");

    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "REQUIRED_CLOSEDLOOP_PLUGINS=(code code-review judges platform self-learning)"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Closedloop plugins must be installed at user scope"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "$HOME/.claude/plugins/installed_plugins.json"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'select(.scope == "user") | .installPath // empty'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'claude plugin enable "$key" --scope user'
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(installIndex);
  });

  it(
    "fails verifier when code plugin is project-scope-only",
    async () => {
      const result = await runClosedloopPluginVerifier({
        codeScope: "project",
      });
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      expect(result.code).toBe(1);
      expect(combinedOutput).toContain(
        "Closedloop plugins must be installed at user scope with enabled state verified"
      );
      expect(combinedOutput).toContain(
        "Missing or invalid: code@closedloop-ai"
      );
      expect(combinedOutput).toContain(
        'claude plugin install "$p@closedloop-ai" --scope user'
      );
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it(
    "enables a disabled user-scoped plugin and passes after re-read",
    async () => {
      const result = await runClosedloopPluginVerifier({
        codeEnabled: false,
      });

      expect(result.code).toBe(0);
      expect(result.log).toContain(
        "claude plugin enable code@closedloop-ai --scope user"
      );
      expect(result.stderr).not.toContain("plugins_verify");
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it(
    "fails verifier when enabling a disabled plugin exits nonzero",
    async () => {
      const result = await runClosedloopPluginVerifier({
        codeEnabled: false,
        scenario: "enable-fails",
      });
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      expect(result.code).toBe(1);
      expect(result.log).toContain(
        "claude plugin enable code@closedloop-ai --scope user"
      );
      expect(combinedOutput).toContain("disabled: code@closedloop-ai");
      expect(combinedOutput).toContain(
        'claude plugin enable "$p@closedloop-ai" --scope user'
      );
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it(
    "fails verifier when post-enable re-read still reports disabled",
    async () => {
      const result = await runClosedloopPluginVerifier({
        codeEnabled: false,
        scenario: "enable-still-disabled",
      });
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      expect(result.code).toBe(1);
      expect(result.log).toContain(
        "claude plugin enable code@closedloop-ai --scope user"
      );
      expect(combinedOutput).toContain("disabled: code@closedloop-ai");
      expect(combinedOutput).toContain(
        'claude plugin enable "$p@closedloop-ai" --scope user'
      );
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

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
args="$*"
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
case "$args" in
  *enabled*)
    cat >/dev/null
    if [ -d "$plugin_path" ]; then
      echo enabled
    else
      echo missing
    fi
    exit 0
    ;;
esac
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
for plugin in bootstrap code code-review judges platform self-learning; do
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
        "Closedloop Desktop prerequisite check failed at"
      );
      expect(combinedOutput).toContain(
        "Continuing to check remaining required prerequisites."
      );
      expect(combinedOutput).toContain(
        "Closedloop Desktop automated setup could not finish because"
      );
      expect(combinedOutput).toContain("GitHub CLI");
      expect(combinedOutput).toContain(
        "GitHub CLI authentication - skipped because GitHub CLI is unavailable"
      );
      expect(combinedOutput).not.toContain(
        "Closedloop Desktop installer failed at"
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
args="$*"
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
case "$args" in
  *enabled*)
    cat >/dev/null
    if [ -d "$plugin_path" ]; then
      echo enabled
    else
      echo missing
    fi
    exit 0
    ;;
esac
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
for plugin in bootstrap code code-review judges platform self-learning; do
  plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
  mkdir -p "$plugin_path"
  if [ "$first" -eq 0 ]; then
    printf ',' >> "$registry"
  fi
  first=0
  printf '"%s@closedloop-ai":[{"installPath":"%s","scope":"user"}]' "$plugin" "$plugin_path" >> "$registry"
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
        "Closedloop Desktop prerequisite check failed at"
      );
      expect(combinedOutput).not.toContain(
        "Closedloop Desktop installer failed at"
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
args="$*"
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
case "$args" in
  *enabled*)
    cat >/dev/null
    if [ -d "$plugin_path" ]; then
      echo enabled
    else
      echo missing
    fi
    exit 0
    ;;
esac
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
for plugin in bootstrap code code-review judges platform self-learning; do
  plugin_path="$HOME/.claude/plugins/cache/closedloop-ai/$plugin/1.0.0"
  mkdir -p "$plugin_path"
  if [ "$first" -eq 0 ]; then
    printf ',' >> "$registry"
  fi
  first=0
  printf '"%s@closedloop-ai":[{"installPath":"%s","scope":"user"}]' "$plugin" "$plugin_path" >> "$registry"
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
        "Closedloop Desktop automated setup could not finish"
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
      expect(callLog).toContain("pgrep -x Closedloop");
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

  it("validates the Desktop download URL before downloading", () => {
    const installBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("validate_desktop_download_url()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_node_npm()")
    );

    expect(installBody).toContain(
      "closedloop-ai/symphony-alpha/releases/download/desktop-v"
    );
    // Dual-casing during the brand-rename transition (FEA-2101): accepts both
    // Closedloop-* and legacy ClosedLoop-* DMG URLs.
    expect(installBody).toContain("Closed[Ll]oop-([0-9]+");
    expect(installBody).toContain("BASH_REMATCH[1]");
    expect(installBody).toContain("BASH_REMATCH[2]");
    expect(installBody).not.toContain("https://objects.githubusercontent.com");
    expect(installBody).not.toContain("closedloop-electron release");
    expect(installBody).toContain(
      "must be an HTTPS Closedloop Desktop release asset"
    );
  });

  it.each([
    [
      "old repo",
      "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
    ],
    [
      "non-HTTPS",
      "http://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg",
    ],
    [
      "userinfo",
      "https://token@github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg",
    ],
    [
      "query string",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg?download=1",
    ],
    [
      "hash",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg#asset",
    ],
    [
      "encoded traversal",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-..%2F0.15.115-universal.dmg",
    ],
    [
      "extra path segment",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg/extra",
    ],
    [
      "wrong asset suffix",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal-mac.zip",
    ],
    [
      "mismatched asset version",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-9.9.9-universal.dmg",
    ],
    [
      "non-Desktop symphony-alpha release",
      "https://github.com/closedloop-ai/symphony-alpha/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
    ],
  ])(
    "fails before download side effects for invalid Desktop URL: %s",
    async (_name, downloadUrl) => {
      const result = await runDesktopDownloadUrlValidation(downloadUrl);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      expect(result.code).toBe(1);
      expect(combinedOutput).toContain("desktop_download");
      expect(result.log).not.toContain("curl ");
      expect(result.log).not.toContain("hdiutil ");
    },
    INSTALLER_SCRIPT_TEST_TIMEOUT_MS
  );

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
      "Closedloop Desktop already installed; skipping Desktop install."
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
  mkdir -p "$mountpoint/Closedloop.app/Contents"
  printf 'not a plist' > "$mountpoint/Closedloop.app/Contents/Info.plist"
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
          "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg",
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
      const handoffEntrypoint = [
        // This test only needs the prerequisite subshell plus parent-shell
        // capture flow. PATH refresh can invoke Homebrew/npm probes and make
        // the shell-out slow enough to flake under the parallel repo build.
        "refresh_installer_path() { :; }",
        'run_required_prerequisite "workspace_directory" "Workspace directory" ensure_workspace_directory',
        "capture_validated_workspace_directory",
        "finish_required_prerequisites",
        "write_handoff_file",
      ].join("; ");
      const handoffScript = DESKTOP_INSTALLER_SCRIPT.replace(
        'main "$@"',
        handoffEntrypoint
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
            "Closedloop Desktop",
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
