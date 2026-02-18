import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getSymphonyScriptPath, loadReposConfig } from "@/lib/engineer/repos";

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

function checkSymphonyPlugin(): CheckResult {
  const scriptPath = getSymphonyScriptPath();
  if (scriptPath) {
    return {
      id: "symphony-plugin",
      label: "Symphony Plugin",
      required: true,
      passed: true,
    };
  }
  return {
    id: "symphony-plugin",
    label: "Symphony Plugin",
    required: true,
    passed: false,
    error: "Not found",
    remediation: "Install the closedloop/experimental plugin in Claude Code",
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
  const results = await Promise.allSettled([
    checkGit(),
    checkClaudeCli(),
    checkGhCli(),
    checkGhAuth(),
    Promise.resolve(checkSymphonyPlugin()),
    Promise.resolve(checkWorktreeDir()),
    checkCodex(),
    checkPython3(),
  ]);

  const checks = results.map((r) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    // Shouldn't happen since each checker catches its own errors, but just in case
    return {
      id: "unknown",
      label: "Unknown",
      required: false,
      passed: false,
      error: "Check failed unexpectedly",
    };
  });

  const allRequiredPassed = checks
    .filter((c) => c.required)
    .every((c) => c.passed);

  return NextResponse.json({ checks, allRequiredPassed });
}
