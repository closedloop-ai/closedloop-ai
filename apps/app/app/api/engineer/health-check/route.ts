import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import type { PluginCheckResult } from "@/lib/engineer/repos";
import {
  checkRequiredPlugins,
  getSymphonyScriptPath,
  loadReposConfig,
  type REQUIRED_SYMPHONY_PLUGINS,
} from "@/lib/engineer/repos";
import { clearShellPathCache, getShellPath } from "@/lib/engineer/shell-path";

const execFileAsync = promisify(execFile);

const VERSION_REGEX = /(\d+\.\d+[\w.-]*)/;

type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
};

type HealthCheckResponse = {
  checks: CheckResult[];
  allRequiredPassed: boolean;
};

/** Run a command with a 3-second timeout using the user's full shell PATH */
async function runCommand(cmd: string, args: string[]): Promise<string> {
  const shellPath = await getShellPath();
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 3000,
    env: { ...process.env, PATH: shellPath },
  });
  return stdout.trim();
}

/** Parse a version string from command output (first line matching semver-like pattern) */
function parseVersion(output: string): string | undefined {
  const match = VERSION_REGEX.exec(output);
  return match?.[1];
}

type CliCheckConfig = {
  id: string;
  label: string;
  required: boolean;
  cmd: string;
  args: string[];
  remediation: string;
};

async function checkCli(config: CliCheckConfig): Promise<CheckResult> {
  try {
    const output = await runCommand(config.cmd, config.args);
    return {
      id: config.id,
      label: config.label,
      required: config.required,
      passed: true,
      version: parseVersion(output),
    };
  } catch {
    return {
      id: config.id,
      label: config.label,
      required: config.required,
      passed: false,
      error: "Not found",
      remediation: config.remediation,
    };
  }
}

function checkGit(): Promise<CheckResult> {
  return checkCli({
    id: "git",
    label: "Git",
    required: true,
    cmd: "git",
    args: ["--version"],
    remediation:
      process.platform === "darwin"
        ? "Install via Xcode CLT: xcode-select --install"
        : "Install: sudo apt-get install git (or your distro's package manager)",
  });
}

function checkClaudeCli(): Promise<CheckResult> {
  return checkCli({
    id: "claude-cli",
    label: "Claude CLI",
    required: true,
    cmd: "claude",
    args: ["--version"],
    remediation: "Install: npm install -g @anthropic-ai/claude-code",
  });
}

function checkGhCli(): Promise<CheckResult> {
  return checkCli({
    id: "gh-cli",
    label: "GitHub CLI",
    required: true,
    cmd: "gh",
    args: ["--version"],
    remediation:
      process.platform === "darwin"
        ? "Install: brew install gh"
        : "Install: see https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
  });
}

async function checkGhAuth(): Promise<CheckResult> {
  try {
    await runCommand("gh", ["auth", "status"]);
    return {
      id: "gh-auth",
      label: "GitHub Auth",
      required: true,
      passed: true,
    };
  } catch {
    return {
      id: "gh-auth",
      label: "GitHub Auth",
      required: true,
      passed: false,
      error: "Not authenticated",
      remediation: "Run: gh auth login",
    };
  }
}

function checkSymphonyPlugins(
  pluginCheckResult: PluginCheckResult
): CheckResult {
  if (!pluginCheckResult.allInstalled) {
    let remediation: string;

    if (pluginCheckResult.reason === "manifest_missing") {
      remediation =
        "Run: claude plugin marketplace add closedloop-ai/claude-plugins && claude plugin install " +
        pluginCheckResult.missing.join(" ");
    } else if (pluginCheckResult.reason === "manifest_malformed") {
      remediation =
        "~/.claude/plugins/installed_plugins.json is corrupted. Try reinstalling plugins.";
    } else {
      // plugins_missing — split by publisher for remediation
      const closedloopMissing = pluginCheckResult.missing.filter((p) =>
        p.endsWith("@closedloop-ai")
      );
      const officialMissing = pluginCheckResult.missing.filter((p) =>
        p.endsWith("@claude-plugins-official")
      );
      const parts: string[] = [];
      if (closedloopMissing.length > 0) {
        parts.push(`claude plugin install ${closedloopMissing.join(" ")}`);
      }
      if (officialMissing.length > 0) {
        parts.push(`claude plugin install ${officialMissing.join(" ")}`);
      }
      remediation = `Run: ${parts.join(" && ")}`;
    }

    return {
      id: "symphony-plugin",
      label: "Symphony Plugins",
      required: true,
      passed: false,
      error: `Missing: ${pluginCheckResult.missing.join(", ")}`,
      remediation,
    };
  }

  // All plugins installed in manifest — verify the code plugin script is discoverable
  const scriptPath = getSymphonyScriptPath();
  if (!scriptPath) {
    return {
      id: "symphony-plugin",
      label: "Symphony Plugins",
      required: true,
      passed: false,
      error: "Plugin installed but script not found",
      remediation:
        "code@closedloop-ai is registered but run-loop.sh is missing from cache. Try: claude plugin install code@closedloop-ai",
    };
  }

  const codeVersion = pluginCheckResult.installed["code@closedloop-ai"];
  return {
    id: "symphony-plugin",
    label: "Symphony Plugins",
    required: true,
    passed: true,
    version: codeVersion,
  };
}

function checkWorktreeDir(): CheckResult {
  const config = loadReposConfig();
  const dir = config.settings.worktreeParentDir;
  const confirmed = config.settings.worktreeParentDirConfirmed;
  if (dir && confirmed) {
    return {
      id: "worktree-dir",
      label: "Worktree Directory",
      required: true,
      passed: true,
      version: dir,
    };
  }
  return {
    id: "worktree-dir",
    label: "Worktree Directory",
    required: true,
    passed: false,
    error: "Not configured",
    remediation: "Set the parent directory where git worktrees will be created",
  };
}

function checkCodex(): Promise<CheckResult> {
  return checkCli({
    id: "codex",
    label: "Codex CLI",
    required: false,
    cmd: "codex",
    args: ["--version"],
    remediation: "Optional — enables debate/review features",
  });
}

async function checkPython3(): Promise<CheckResult> {
  const REMEDIATION =
    process.platform === "darwin"
      ? "Install Python 3.10 or later: brew install python@3.13"
      : "Install Python 3.10 or later: sudo apt-get install python3 (or your distro's package manager)";
  try {
    const output = await runCommand("python3", ["--version"]);
    const version = parseVersion(output);
    if (!version) {
      return {
        id: "python3",
        label: "python3",
        required: true,
        passed: false,
        error: "Unable to determine Python version",
        remediation: REMEDIATION,
      };
    }
    // parseVersion guarantees \d+\.\d+ so this always matches
    const m = /^(\d+)\.(\d+)/.exec(version)!;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major < 3 || (major === 3 && minor < 10)) {
      return {
        id: "python3",
        label: "python3",
        required: true,
        passed: false,
        version,
        error: `Python ${version} is below the required minimum of 3.10`,
        remediation: REMEDIATION,
      };
    }
    return {
      id: "python3",
      label: "python3",
      required: true,
      passed: true,
      version,
    };
  } catch {
    return {
      id: "python3",
      label: "python3",
      required: true,
      passed: false,
      error: "Not found",
      remediation: REMEDIATION,
    };
  }
}

/**
 * Parses a strict semver string (no prerelease or build metadata allowed).
 * Returns a [major, minor, patch] tuple if the version is a valid strict semver,
 * undefined otherwise (e.g. "1.0.0-rc1", "1.0", "installed" all return undefined).
 */
function parseStrictSemver(
  version: string
): [number, number, number] | undefined {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const numericOnly = /^\d+$/;
  const [majorStr, minorStr, patchStr] = parts;
  if (
    !(
      numericOnly.test(majorStr) &&
      numericOnly.test(minorStr) &&
      numericOnly.test(patchStr)
    )
  ) {
    return undefined;
  }
  return [Number(majorStr), Number(minorStr), Number(patchStr)];
}

/**
 * Compares two strict semver strings lexicographically (major, minor, patch).
 * Returns true if installed >= latest, false if installed is behind.
 * Returns undefined if either version cannot be parsed as strict semver
 * (caller must not treat undefined as up-to-date).
 */
function compareStrictSemver(
  installed: string,
  latest: string
): boolean | undefined {
  const installedTuple = parseStrictSemver(installed);
  const latestTuple = parseStrictSemver(latest);
  if (installedTuple === undefined || latestTuple === undefined) {
    return undefined;
  }
  for (let i = 0; i < 3; i++) {
    if (installedTuple[i] > latestTuple[i]) {
      return true;
    }
    if (installedTuple[i] < latestTuple[i]) {
      return false;
    }
  }
  return true;
}

type ClosedLoopPlugin = Extract<
  (typeof REQUIRED_SYMPHONY_PLUGINS)[number],
  `${string}@closedloop-ai`
>;

/**
 * Maps each @closedloop-ai plugin key to its folder name under the
 * plugins/ directory in the closedloop-ai/claude-plugins GitHub repo.
 * code-simplifier@claude-plugins-official is intentionally absent — different publisher.
 */
const PLUGIN_VERSION_MAP: Record<ClosedLoopPlugin, string> = {
  "code@closedloop-ai": "code",
  "self-learning@closedloop-ai": "self-learning",
  "judges@closedloop-ai": "judges",
  "code-review@closedloop-ai": "code-review",
  "platform@closedloop-ai": "platform",
};

async function checkPluginVersions(
  installed: Record<string, string>
): Promise<CheckResult | undefined> {
  const entries = Object.entries(PLUGIN_VERSION_MAP) as [
    ClosedLoopPlugin,
    string,
  ][];

  const results = await Promise.allSettled(
    entries.map(([, folder]) =>
      fetch(
        `https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/plugins/${folder}/.claude-plugin/plugin.json`,
        { signal: AbortSignal.timeout(800) }
      )
    )
  );

  const outdated: { key: string; installed: string; latest: string }[] = [];
  const upToDate: string[] = [];
  let unverified = 0;

  for (let i = 0; i < entries.length; i++) {
    const [pluginKey] = entries[i];
    const result = results[i];

    if (result.status === "rejected") {
      unverified++;
      continue;
    }

    const response = result.value;
    if (!response.ok) {
      unverified++;
      continue;
    }

    let latestVer: string;
    try {
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version !== "string") {
        unverified++;
        continue;
      }
      latestVer = body.version;
    } catch {
      unverified++;
      continue;
    }

    const installedVer = installed[pluginKey] ?? "";
    const cmp = compareStrictSemver(installedVer, latestVer);

    if (cmp === undefined) {
      unverified++;
    } else if (cmp === false) {
      outdated.push({
        key: pluginKey,
        installed: installedVer,
        latest: latestVer,
      });
    } else {
      upToDate.push(pluginKey);
    }
  }

  if (outdated.length > 0) {
    return {
      id: "plugin-versions",
      label: "Plugin Versions (@closedloop-ai)",
      required: false,
      passed: false,
      error:
        "Outdated: " +
        outdated
          .map((p) => `${p.key} (${p.installed} -> ${p.latest})`)
          .join(", "),
      remediation: outdated
        .map((p) => `claude plugin install ${p.key}`)
        .join(" && "),
    };
  }

  if (unverified > 0) {
    return {
      id: "plugin-versions",
      label: "Plugin Versions (@closedloop-ai)",
      required: false,
      passed: false,
      error: `${unverified}/${entries.length} plugin manifest(s) could not be verified`,
    };
  }

  return {
    id: "plugin-versions",
    label: "Plugin Versions (@closedloop-ai)",
    required: false,
    passed: true,
  };
}

export async function GET(): Promise<NextResponse<HealthCheckResponse>> {
  // Clear cached PATH so we pick up any changes to the user's shell config
  clearShellPathCache();

  // Run Claude CLI check first — plugin check depends on CLI being available
  const claudeResult = await checkClaudeCli();
  const pluginCheckResult = checkRequiredPlugins();

  // Run remaining parallel checks (excluding plugin which depends on Claude CLI)
  const parallelResults = await Promise.allSettled([
    checkGit(),
    checkGhCli(),
    checkGhAuth(),
    checkWorktreeDir(),
    checkCodex(),
    checkPython3(),
  ]);

  const [
    gitResult,
    ghCliResult,
    ghAuthResult,
    worktreeResult,
    codexResult,
    python3Result,
  ] = parallelResults.map((r): CheckResult => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      id: "unknown",
      label: "Unknown",
      required: false,
      passed: false,
      error: "Check failed unexpectedly",
    };
  });

  // Only run plugin check if Claude CLI is installed
  const checks: CheckResult[] = [
    gitResult,
    claudeResult,
    ghCliResult,
    ghAuthResult,
  ];

  if (claudeResult.passed) {
    checks.push(checkSymphonyPlugins(pluginCheckResult));
  } else {
    checks.push({
      id: "symphony-plugin",
      label: "Symphony Plugins",
      required: true,
      passed: false,
      error: "Requires Claude CLI",
      remediation: "Install Claude CLI first, then check plugins",
    });
  }

  checks.push(worktreeResult, codexResult, python3Result);

  if (claudeResult.passed && pluginCheckResult.allInstalled) {
    const versionResult = await checkPluginVersions(
      pluginCheckResult.installed
    );
    if (versionResult !== undefined) {
      checks.push(versionResult);
    }
  }

  const allRequiredPassed = checks
    .filter((c) => c.required)
    .every((c) => c.passed);

  return NextResponse.json({ checks, allRequiredPassed });
}
