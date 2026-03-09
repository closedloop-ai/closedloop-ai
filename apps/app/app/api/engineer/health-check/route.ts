import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  checkRequiredPlugins,
  getSymphonyScriptPath,
  loadReposConfig,
} from "@/lib/engineer/repos";

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

/** Run a command with a 3-second timeout, returning stdout or throwing */
async function runCommand(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 3000 });
  return stdout.trim();
}

/** Parse a version string from command output (first line matching semver-like pattern) */
function parseVersion(output: string): string | undefined {
  const match = VERSION_REGEX.exec(output);
  return match?.[1];
}

async function checkGit(): Promise<CheckResult> {
  try {
    const output = await runCommand("git", ["--version"]);
    return {
      id: "git",
      label: "Git",
      required: true,
      passed: true,
      version: parseVersion(output),
    };
  } catch {
    return {
      id: "git",
      label: "Git",
      required: true,
      passed: false,
      error: "Not found",
      remediation: "Install via Xcode CLT: xcode-select --install",
    };
  }
}

async function checkClaudeCli(): Promise<CheckResult> {
  try {
    const output = await runCommand("claude", ["--version"]);
    return {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: true,
      version: parseVersion(output),
    };
  } catch {
    return {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: false,
      error: "Not found",
      remediation: "Install: npm install -g @anthropic-ai/claude-code",
    };
  }
}

async function checkGhCli(): Promise<CheckResult> {
  try {
    const output = await runCommand("gh", ["--version"]);
    return {
      id: "gh-cli",
      label: "GitHub CLI",
      required: true,
      passed: true,
      version: parseVersion(output),
    };
  } catch {
    return {
      id: "gh-cli",
      label: "GitHub CLI",
      required: true,
      passed: false,
      error: "Not found",
      remediation: "Install: brew install gh",
    };
  }
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

function checkSymphonyPlugins(): CheckResult {
  const result = checkRequiredPlugins();

  if (!result.allInstalled) {
    let remediation: string;

    if (result.reason === "manifest_missing") {
      remediation =
        "Run: claude plugin marketplace add closedloop-ai/claude-plugins && claude plugin install " +
        result.missing.join(" ");
    } else if (result.reason === "manifest_malformed") {
      remediation =
        "~/.claude/plugins/installed_plugins.json is corrupted. Try reinstalling plugins.";
    } else {
      // plugins_missing — split by publisher for remediation
      const closedloopMissing = result.missing.filter((p) =>
        p.endsWith("@closedloop-ai")
      );
      const officialMissing = result.missing.filter((p) =>
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
      error: `Missing: ${result.missing.join(", ")}`,
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

  const codeVersion = result.installed["code@closedloop-ai"];
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

async function checkCodex(): Promise<CheckResult> {
  try {
    const output = await runCommand("codex", ["--version"]);
    return {
      id: "codex",
      label: "Codex CLI",
      required: false,
      passed: true,
      version: parseVersion(output),
    };
  } catch {
    return {
      id: "codex",
      label: "Codex CLI",
      required: false,
      passed: false,
      error: "Not found",
      remediation: "Optional — enables debate/review features",
    };
  }
}

async function checkPython3(): Promise<CheckResult> {
  try {
    const output = await runCommand("python3", ["--version"]);
    return {
      id: "python3",
      label: "python3",
      required: false,
      passed: true,
      version: parseVersion(output),
    };
  } catch {
    return {
      id: "python3",
      label: "python3",
      required: false,
      passed: false,
      error: "Not found",
      remediation: "Optional — enables learnings processing",
    };
  }
}

export async function GET(): Promise<NextResponse<HealthCheckResponse>> {
  // Run Claude CLI check first — plugin check depends on CLI being available
  const claudeResult = await checkClaudeCli();

  // Run remaining parallel checks (excluding plugin which depends on Claude CLI)
  const parallelResults = await Promise.allSettled([
    checkGit(),
    checkGhCli(),
    checkGhAuth(),
    Promise.resolve(checkWorktreeDir()),
    checkCodex(),
    checkPython3(),
  ]);

  const parallelChecks = parallelResults.map((r) => {
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
    parallelChecks[0], // git
    claudeResult,
    parallelChecks[1], // gh-cli
    parallelChecks[2], // gh-auth
  ];

  if (claudeResult.passed) {
    checks.push(checkSymphonyPlugins());
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

  checks.push(
    parallelChecks[3], // worktree-dir
    parallelChecks[4], // codex
    parallelChecks[5] // python3
  );

  const allRequiredPassed = checks
    .filter((c) => c.required)
    .every((c) => c.passed);

  return NextResponse.json({ checks, allRequiredPassed });
}
