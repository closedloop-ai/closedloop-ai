import { execFile } from "node:child_process";
import fs, { constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gatewayLog } from "../../main/gateway-logger.js";
import { Observability } from "../../main/observability.js";
import type {
  PluginUpdateDiagnostics,
  PluginUpdateFailureReason,
  PluginUpdateOutcome,
} from "../../main/telemetry-protocol.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import {
  getShellEnv,
  resolveBinaryFromLoginShell,
  resolveExecutablesOnPath,
} from "../shell-path.js";
import {
  detectMcpAvailability,
  type McpDetectionResult,
} from "./mcp-detection.js";
import {
  type ClaudePluginInventoryEntry,
  getInstalledPluginVersions,
  getPluginInstallStatus,
  parseClaudePluginListJson,
  parseClaudePluginListText,
  toPluginInventoryMap,
} from "./plugin-cache.js";
import { json } from "./response-utils.js";

const execFileAsync = promisify(execFile);
const VERSION_REGEX = /(\d+\.\d+[\w.-]*)/;
const VERSION_PREFIX_REGEX = /^[vV]/;
const CLOSEDLOOP_MARKETPLACE_NAME = "closedloop-ai";
const HEALTH_PROBE_COMMAND_TIMEOUT_MS = 3000;
const PLUGIN_UPDATE_TIMEOUT_MS = 30_000;
// Keep the full auto-remediation route under the app's 45s timeout.
const PLUGIN_REMEDIATION_DEADLINE_MS = 40_000;
const PLUGIN_REMEDIATION_TIMEOUT_MESSAGE =
  "Closedloop plugin remediation deadline exceeded";
const STDERR_TAIL_MAX_CHARS = 512;
const PLUGIN_AUTOUPDATE_DOCS_LINK = {
  label: "Update Closedloop plugins manually",
  url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
} as const;

const CLOSEDLOOP_USER_PLUGINS = [
  {
    folder: "code",
    key: "code@closedloop-ai",
    label: "Symphony Plugin",
    required: true,
  },
  {
    folder: "platform",
    key: "platform@closedloop-ai",
    label: "Platform Plugin",
    required: true,
  },
  {
    folder: "judges",
    key: "judges@closedloop-ai",
    label: "Judges Plugin",
    required: true,
  },
  {
    folder: "code-review",
    key: "code-review@closedloop-ai",
    label: "Code Review Plugin",
    required: true,
  },
  {
    folder: "self-learning",
    key: "self-learning@closedloop-ai",
    label: "Self-Learning Plugin",
    required: true,
  },
] as const;

type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
  enableAttempted?: boolean;
  enableOutcome?: PluginUpdateOutcome;
  enablePluginIds?: string[];
  updateAttempted?: boolean;
  updateOutcome?: PluginUpdateOutcome;
  updatePluginIds?: string[];
  remediationLinks?: Array<{ label: string; url: string }>;
  debug?: {
    errorCode?: string; // "ENOENT" | "EACCES" | "ETIMEDOUT" | "EPERM" | other
    stderr?: string; // trimmed, capped at 512 chars
    resolvedPath?: string; // PATH string from getShellEnv(), truncated to 1 KiB
    shell?: string; // basename of process.env.SHELL ("zsh" / "bash" / "fish")
    platform?: NodeJS.Platform;
    foundAt?: string[]; // executable locations where the binary was found (PATH sweep + known dirs)
    nonExecutableAt?: string[]; // paths that exist but are not executable (drives EACCES diagnostics)
    overrideUsed?: string; // populated when a manual override path was tried (see binary-paths settings)
  };
};

type ReposConfig = {
  repos?: Array<{ path: string; description?: string }>;
  settings?: {
    worktreeParentDir?: string;
    worktreeParentDirConfirmed?: boolean;
  };
};

type CommandError = {
  code: string; // "ENOENT", "EACCES", "ETIMEDOUT", or "EUNKNOWN"
  stderr: string;
  message: string;
};

type PluginManifest = {
  plugin: (typeof CLOSEDLOOP_USER_PLUGINS)[number];
  latestVersion?: string;
  error?: "manifest_unavailable";
};

type ClaudeMarketplaceListEntry = {
  name?: unknown;
  source?: unknown;
  path?: unknown;
  installLocation?: unknown;
};

type PluginUpdateCommandResult = {
  outcome: PluginUpdateOutcome;
  exitCode?: number;
  stdout: string;
  stderrTail?: string;
  elapsedMs: number;
  failureReason?: PluginUpdateFailureReason;
};

type PluginInventoryResult = {
  source: "json" | "text" | "unavailable";
  entries: Map<string, ClaudePluginInventoryEntry>;
  error?: string;
};

type PluginRemediationDeadline = {
  startedAt: number;
  timeoutMs: number;
};

function getPluginUpdateOutputTail(
  output: string | Buffer | undefined
): string {
  return (output ?? "").toString().trim().slice(-STDERR_TAIL_MAX_CHARS);
}

function shouldEnablePluginAutoUpdate(
  requested: boolean,
  checks: Pick<CheckResult, "id" | "passed">[]
): boolean {
  return (
    requested &&
    checks.some((check) => check.id === "claude-cli" && check.passed)
  );
}

function resolvePostUpdateOutcome(
  current: boolean,
  updateResult?: PluginUpdateCommandResult
): PluginUpdateOutcome {
  if (current) {
    return "success";
  }
  if (
    updateResult?.outcome === "timeout" ||
    updateResult?.outcome === "skipped"
  ) {
    return updateResult.outcome;
  }
  return "failed";
}

export function registerHealthCheckRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getSymphonyDir: () => string,
  detectMcpOverride?: (
    provider: "claude" | "codex",
    expectedMcpUrl?: string
  ) => Promise<McpDetectionResult>,
  getBinaryPaths?: () => {
    claude?: string;
    gh?: string;
    codex?: string;
    python3?: string;
    git?: string;
  },
  getAppVersion?: () => string | undefined
): void {
  const detectMcp = detectMcpOverride ?? detectMcpAvailability;
  const configDir = () => path.join(getSymphonyDir(), "config");

  dispatcher.register("GET", "/api/gateway/health-check", async (context) => {
    const expectedMcpUrl =
      context.query.get("expectedMcpUrl")?.trim() || undefined;
    const requestedPluginAutoUpdate =
      context.query.get("pluginAutoUpdate") === "1";
    const paths = getBinaryPaths?.();
    const pluginRemediationDeadline = requestedPluginAutoUpdate
      ? createPluginRemediationDeadline()
      : undefined;
    const [pluginListJson, baseChecks, claudeMcp, codexMcp] = await Promise.all(
      [
        readClaudePluginListJson(paths?.claude, pluginRemediationDeadline),
        Promise.all([
          checkGit(processManager, paths?.git, pluginRemediationDeadline),
          checkClaudeCli(
            processManager,
            paths?.claude,
            pluginRemediationDeadline
          ),
          checkGhCli(processManager, paths?.gh, pluginRemediationDeadline),
          checkGhAuth(processManager, paths?.gh, pluginRemediationDeadline),
          checkWorktreeDir(configDir),
          checkCodex(processManager, paths?.codex, pluginRemediationDeadline),
          checkPython3(
            processManager,
            paths?.python3,
            pluginRemediationDeadline
          ),
        ]),
        detectMcpWithinDeadline(
          detectMcp,
          "claude",
          expectedMcpUrl,
          pluginRemediationDeadline
        ),
        detectMcpWithinDeadline(
          detectMcp,
          "codex",
          expectedMcpUrl,
          pluginRemediationDeadline
        ),
      ]
    );
    const pluginAutoUpdateEnabled = shouldEnablePluginAutoUpdate(
      requestedPluginAutoUpdate,
      baseChecks
    );
    const activePluginRemediationDeadline = pluginAutoUpdateEnabled
      ? pluginRemediationDeadline
      : undefined;
    let pluginChecks = CLOSEDLOOP_USER_PLUGINS.map((plugin) =>
      checkPlugin(plugin, pluginListJson, pluginAutoUpdateEnabled)
    );
    if (pluginAutoUpdateEnabled) {
      pluginChecks = await applyPluginEnableChecks(pluginChecks, {
        claudeOverride: paths?.claude,
        remediationDeadline: activePluginRemediationDeadline,
        readInventory: (timeoutMs) =>
          readClaudePluginInventory(
            paths?.claude,
            activePluginRemediationDeadline,
            timeoutMs
          ),
      });
    }
    let checks: CheckResult[] = [
      ...baseChecks.slice(0, 4),
      ...pluginChecks,
      ...baseChecks.slice(4),
    ];

    // Check plugin versions if all plugins are installed
    const allPluginsInstalled = checks
      .filter((c) => c.id.startsWith("plugin-"))
      .every((c) => c.passed);
    if (allPluginsInstalled) {
      const installed = getInstalledPluginVersions();
      checks = await applyPluginVersionChecks(checks, installed, {
        pluginAutoUpdateEnabled,
        claudeOverride: paths?.claude,
        remediationDeadline: activePluginRemediationDeadline,
        readInstalledVersions: () => getInstalledPluginVersions(),
      });
    }

    for (const check of checks) {
      Observability.healthCheckResult(check);
    }

    const rawLatestVersion =
      context.query.get("latestVersion")?.trim() || undefined;
    const rawCurrentVersion = getAppVersion?.();
    if (rawLatestVersion && rawCurrentVersion) {
      const latestNorm = rawLatestVersion.replace(VERSION_PREFIX_REGEX, "");
      const currentNorm = rawCurrentVersion.replace(VERSION_PREFIX_REGEX, "");
      const appVersionResult = checkAppVersion(currentNorm, latestNorm);
      checks.push(appVersionResult);
      Observability.healthCheckResult(appVersionResult);
    }

    const allRequiredPassed = checks
      .filter((check) => check.required)
      .every((check) => check.passed);
    const mcpServers = {
      claude: claudeMcp,
      codex: codexMcp,
    };
    json(context, 200, { checks, allRequiredPassed, mcpServers });
  });
}

type RunCommand = (
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<{ stdout: string }>;

const defaultRunCommand: RunCommand = async (cmd, args, options) => {
  // Health/plugin Claude probes are diagnostic background checks, not
  // user/session Claude Code spawns. Keep them on plain getShellEnv() to avoid
  // telemetry noise and coupling health checks to the local OTel receiver.
  const env = await getShellEnv();
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: options?.timeoutMs ?? HEALTH_PROBE_COMMAND_TIMEOUT_MS,
      env,
    });
    return { stdout: stdout.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
    };
    const code = e.killed ? "ETIMEDOUT" : (e.code ?? "EUNKNOWN");
    const stderr = (e.stderr ?? "").toString().trim().slice(0, 512);
    throw {
      code,
      stderr,
      message: e.message ?? "command failed",
    } satisfies CommandError;
  }
};

let runCommand: RunCommand = defaultRunCommand;

async function readClaudePluginListJson(
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline
): Promise<string | null> {
  const resolved = await resolveBinaryFromLoginShell("claude", claudeOverride);
  if (resolved.source === "override_invalid") {
    return null;
  }

  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["plugin", "list", "--json"],
      { deadline }
    );
    return stdout;
  } catch {
    return null;
  }
}

async function detectMcpWithinDeadline(
  detectMcp: (
    provider: "claude" | "codex",
    expectedMcpUrl?: string
  ) => Promise<McpDetectionResult>,
  provider: "claude" | "codex",
  expectedMcpUrl: string | undefined,
  deadline?: PluginRemediationDeadline
): Promise<McpDetectionResult> {
  if (!deadline) {
    return detectMcp(provider, expectedMcpUrl);
  }

  return runValueWithinDeadline(
    () => detectMcp(provider, expectedMcpUrl),
    deadline,
    () => createMcpDetectionTimeoutResult()
  );
}

type PluginUpdateRunner = (
  pluginRef: string,
  options?: { claudeOverride?: string; timeoutMs?: number }
) => Promise<PluginUpdateCommandResult>;

type PluginMarketplaceUpdateRunner = (options?: {
  claudeOverride?: string;
  timeoutMs?: number;
}) => Promise<PluginUpdateCommandResult>;

async function defaultRunPluginMarketplaceUpdateCommand(
  options: { claudeOverride?: string; timeoutMs?: number } = {}
): Promise<PluginUpdateCommandResult> {
  const startedAt = Date.now();
  const resolved = await resolveBinaryFromLoginShell(
    "claude",
    options.claudeOverride
  );
  if (resolved.source === "override_invalid") {
    return {
      outcome: "failed",
      stdout: "",
      elapsedMs: Date.now() - startedAt,
      failureReason: "cli_unavailable",
      stderrTail:
        "Claude binary override path does not exist or is not executable",
    };
  }

  const env = await getPlainHealthPluginEnv();
  try {
    const { stdout } = await execFileAsync(
      resolved.path,
      ["plugin", "marketplace", "update", CLOSEDLOOP_MARKETPLACE_NAME],
      {
        timeout: options.timeoutMs ?? PLUGIN_UPDATE_TIMEOUT_MS,
        env,
      }
    );
    return {
      outcome: "success",
      stdout: stdout.trim(),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
      killed?: boolean;
      code?: string | number;
    };
    const timeout = error.killed || error.code === "ETIMEDOUT";
    return {
      outcome: timeout ? "timeout" : "failed",
      exitCode: typeof error.code === "number" ? error.code : undefined,
      stdout: (error.stdout ?? "").toString().trim(),
      stderrTail: getPluginUpdateOutputTail(error.stderr),
      elapsedMs: Date.now() - startedAt,
      failureReason: timeout ? "timeout" : "command_failed",
    };
  }
}

async function defaultRunPluginUpdateCommand(
  pluginRef: string,
  options: { claudeOverride?: string; timeoutMs?: number } = {}
): Promise<PluginUpdateCommandResult> {
  const startedAt = Date.now();
  const resolved = await resolveBinaryFromLoginShell(
    "claude",
    options.claudeOverride
  );
  if (resolved.source === "override_invalid") {
    return {
      outcome: "failed",
      stdout: "",
      elapsedMs: Date.now() - startedAt,
      failureReason: "cli_unavailable",
      stderrTail:
        "Claude binary override path does not exist or is not executable",
    };
  }

  const env = await getPlainHealthPluginEnv();
  try {
    const { stdout } = await execFileAsync(
      resolved.path,
      ["plugin", "update", pluginRef, "--scope", "user"],
      {
        timeout: options.timeoutMs ?? PLUGIN_UPDATE_TIMEOUT_MS,
        env,
      }
    );
    return {
      outcome: "success",
      stdout: stdout.trim(),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
      killed?: boolean;
      code?: string | number;
    };
    const timeout = error.killed || error.code === "ETIMEDOUT";
    return {
      outcome: timeout ? "timeout" : "failed",
      exitCode: typeof error.code === "number" ? error.code : undefined,
      stdout: (error.stdout ?? "").toString().trim(),
      stderrTail: getPluginUpdateOutputTail(error.stderr),
      elapsedMs: Date.now() - startedAt,
      failureReason: timeout ? "timeout" : "command_failed",
    };
  }
}

async function defaultRunPluginEnableCommand(
  pluginRef: string,
  options: { claudeOverride?: string; timeoutMs?: number } = {}
): Promise<PluginUpdateCommandResult> {
  const startedAt = Date.now();
  const resolved = await resolveBinaryFromLoginShell(
    "claude",
    options.claudeOverride
  );
  if (resolved.source === "override_invalid") {
    return {
      outcome: "failed",
      stdout: "",
      elapsedMs: Date.now() - startedAt,
      failureReason: "cli_unavailable",
      stderrTail:
        "Claude binary override path does not exist or is not executable",
    };
  }

  const env = await getPlainHealthPluginEnv();
  try {
    const { stdout } = await execFileAsync(
      resolved.path,
      ["plugin", "enable", pluginRef, "--scope", "user"],
      {
        timeout: options.timeoutMs ?? PLUGIN_UPDATE_TIMEOUT_MS,
        env,
      }
    );
    return {
      outcome: "success",
      stdout: stdout.trim(),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
      killed?: boolean;
      code?: string | number;
    };
    const timeout = error.killed || error.code === "ETIMEDOUT";
    return {
      outcome: timeout ? "timeout" : "failed",
      exitCode: typeof error.code === "number" ? error.code : undefined,
      stdout: (error.stdout ?? "").toString().trim(),
      stderrTail: getPluginUpdateOutputTail(error.stderr),
      elapsedMs: Date.now() - startedAt,
      failureReason: timeout ? "timeout" : "command_failed",
    };
  }
}

let runPluginUpdateCommand: PluginUpdateRunner = defaultRunPluginUpdateCommand;
let runPluginEnableCommand: PluginUpdateRunner = defaultRunPluginEnableCommand;
let runPluginMarketplaceUpdateCommand: PluginMarketplaceUpdateRunner =
  defaultRunPluginMarketplaceUpdateCommand;
const failedPluginUpdateAttempts = new Map<string, PluginUpdateOutcome>();
let pluginRemediationDeadlineMs = PLUGIN_REMEDIATION_DEADLINE_MS;

/**
 * @internal Test-only. Replace the binary command runner with a stub to
 * simulate ENOENT / EACCES / ETIMEDOUT without spawning real processes.
 * Call with no argument to restore the real implementation.
 */
export function _setRunCommandForTesting(fn?: RunCommand): void {
  runCommand = fn ?? defaultRunCommand;
}

/** @internal Test-only. Runs the default health probe command runner. */
export async function _runDefaultCommandForTesting(
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number }
): Promise<{ stdout: string }> {
  return defaultRunCommand(cmd, args, options);
}

/**
 * @internal Test-only. Replace the plugin update runner and reset session
 * suppression state.
 */
export function _setPluginUpdateCommandForTesting(
  fn?: PluginUpdateRunner
): void {
  runPluginUpdateCommand = fn ?? defaultRunPluginUpdateCommand;
  failedPluginUpdateAttempts.clear();
}

/** @internal Test-only. Runs the default Claude plugin update runner. */
export async function _runDefaultPluginUpdateCommandForTesting(
  pluginRef: string,
  options?: { claudeOverride?: string; timeoutMs?: number }
): Promise<PluginUpdateCommandResult> {
  return defaultRunPluginUpdateCommand(pluginRef, options);
}

/** @internal Test-only. Replace the plugin marketplace refresh runner. */
export function _setPluginMarketplaceUpdateCommandForTesting(
  fn?: PluginMarketplaceUpdateRunner
): void {
  runPluginMarketplaceUpdateCommand =
    fn ?? defaultRunPluginMarketplaceUpdateCommand;
}

/** @internal Test-only. Replace the plugin enable runner. */
export function _setPluginEnableCommandForTesting(
  fn?: PluginUpdateRunner
): void {
  runPluginEnableCommand = fn ?? defaultRunPluginEnableCommand;
}

/** @internal Test-only. Override the total plugin remediation deadline. */
export function _setPluginRemediationDeadlineMsForTesting(
  timeoutMs?: number
): void {
  pluginRemediationDeadlineMs = timeoutMs ?? PLUGIN_REMEDIATION_DEADLINE_MS;
}

/** @internal Test-only. Returns the bounded plugin-update stderr suffix. */
export function _getPluginUpdateStderrTailForTesting(
  stderr: string | Buffer | undefined
): string {
  return getPluginUpdateOutputTail(stderr);
}

/** @internal Test-only. Mirrors the route-level auto-update safety gate. */
export function _shouldEnablePluginAutoUpdateForTesting(
  requested: boolean,
  checks: Pick<CheckResult, "id" | "passed">[]
): boolean {
  return shouldEnablePluginAutoUpdate(requested, checks);
}

/**
 * @internal Test-only. Exposes plugin-version enrichment without relying
 * on a developer machine's real Claude plugin registry.
 */
export async function _applyPluginVersionChecksForTesting(
  checks: CheckResult[],
  installed: Record<string, string>,
  options: {
    pluginAutoUpdateEnabled?: boolean;
    readInstalledVersions?: () => Record<string, string>;
    preferConfiguredMarketplace?: boolean;
  } = {}
): Promise<CheckResult[]> {
  return applyPluginVersionChecks(checks, installed, {
    pluginAutoUpdateEnabled: options.pluginAutoUpdateEnabled ?? false,
    readInstalledVersions: options.readInstalledVersions ?? (() => installed),
    preferConfiguredMarketplace: options.preferConfiguredMarketplace ?? false,
  });
}

/**
 * Per-binary override of the hardcoded KNOWN_*_LOCATIONS arrays consulted
 * by collectBinaryDebug. Used to make tests host-independent: a test that
 * asserts on "Not found" can pass `{ claude: [] }` so the host's actual
 * Homebrew/local install does not leak into `foundAt[]`. Production never
 * sets this.
 */
let knownLocationsForTest: Record<string, string[]> | null = null;

/**
 * @internal Test-only. Override the KNOWN_*_LOCATIONS arrays per-binary so
 * a test can assert on a clean "no-installed-binary-anywhere" state without
 * being defeated by the host machine's Homebrew/native installs. Pass
 * `null` to restore defaults.
 */
export function _setKnownBinaryLocationsForTesting(
  override: Record<string, string[]> | null
): void {
  knownLocationsForTest = override;
}

function effectiveKnownLocations(
  binaryName: string,
  defaults: string[]
): string[] {
  return knownLocationsForTest?.[binaryName] ?? defaults;
}

function parseVersion(output: string): string | undefined {
  const match = VERSION_REGEX.exec(output);
  return match?.[1];
}

const KNOWN_CLAUDE_LOCATIONS: string[] = [
  "~/.claude/local/claude", // Anthropic native installer default
  "/opt/homebrew/bin/claude", // Apple Silicon Homebrew
  "/usr/local/bin/claude", // Intel Homebrew / pre-Apple-Silicon
  "~/.bun/bin/claude",
  "~/.volta/bin/claude",
  "~/.local/bin/claude",
  "/snap/bin/claude", // Linux snap
];

const KNOWN_GIT_LOCATIONS: string[] = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
];

const KNOWN_GH_LOCATIONS: string[] = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "~/.local/bin/gh",
];

const KNOWN_CODEX_LOCATIONS: string[] = [
  "~/.volta/bin/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "~/.bun/bin/codex",
  "~/.local/bin/codex",
];

const KNOWN_PYTHON3_LOCATIONS: string[] = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "~/.local/bin/python3",
];

function getInstallRemediation(
  binaryName: string,
  platform: NodeJS.Platform
): string {
  const isMac = platform === "darwin";
  const isLinux = platform === "linux";
  switch (binaryName) {
    case "claude":
      return "Install: npm install -g @anthropic-ai/claude-code";
    case "codex":
      return "Install: npm install -g @openai/codex";
    case "git":
      if (isMac) {
        return "Install: xcode-select --install";
      }
      if (isLinux) {
        return "Install via your package manager (e.g. apt install git, dnf install git)";
      }
      return "Install Git: see https://git-scm.com";
    case "gh":
      if (isMac) {
        return "Install: brew install gh (or see https://cli.github.com)";
      }
      if (isLinux) {
        return "Install the GitHub CLI: see https://github.com/cli/cli/blob/trunk/docs/install_linux.md";
      }
      return "Install the GitHub CLI: see https://cli.github.com";
    case "python3":
      if (isMac) {
        return "Install Python 3.10 or later: brew install python@3.13 (or see https://python.org)";
      }
      if (isLinux) {
        return "Install Python 3.10 or later via your package manager (e.g. apt install python3)";
      }
      return "Install Python 3.10 or later: see https://python.org";
    default:
      return `Install ${binaryName}`;
  }
}

function expandTilde(loc: string): string {
  if (loc.startsWith("~/")) {
    return os.homedir() + loc.slice(1);
  }
  if (loc === "~") {
    return os.homedir();
  }
  return loc;
}

async function collectBinaryDebug(
  binaryName: string,
  spawnError: CommandError,
  knownLocations: string[]
): Promise<NonNullable<CheckResult["debug"]>> {
  const env = await getShellEnv();
  const shellPath = env.PATH ?? "";

  const pathHits = await resolveExecutablesOnPath(binaryName, shellPath);
  const seen = new Set<string>(pathHits);

  // Sweep PATH directories and known install locations, distinguishing
  // executable hits from files that exist but are not executable. The
  // latter drive EACCES diagnostics so remediation points at the actual
  // broken file rather than some other executable location.
  const pathSegmentCandidates = shellPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => path.join(segment, binaryName));
  const candidates = [
    ...pathSegmentCandidates,
    ...effectiveKnownLocations(binaryName, knownLocations).map((loc) =>
      expandTilde(loc)
    ),
  ];

  const knownHits: string[] = [];
  const nonExecutableHits: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      await fs.access(candidate, constants.F_OK);
    } catch {
      continue; // does not exist
    }
    try {
      await fs.access(candidate, constants.X_OK);
      knownHits.push(candidate);
    } catch {
      nonExecutableHits.push(candidate);
    }
  }

  return {
    errorCode: spawnError.code,
    stderr: spawnError.stderr,
    resolvedPath: shellPath.slice(0, 1024),
    shell: path.basename(process.env.SHELL ?? ""),
    platform: process.platform,
    foundAt: [...pathHits, ...knownHits],
    ...(nonExecutableHits.length > 0
      ? { nonExecutableAt: nonExecutableHits }
      : {}),
  };
}

function classifyBinaryError(
  binaryName: string,
  spawnError: CommandError,
  debug: NonNullable<CheckResult["debug"]>
): string {
  const { errorCode } = debug;
  const foundAt = debug.foundAt ?? [];
  const nonExecutableAt = debug.nonExecutableAt ?? [];

  if (errorCode === "ENOENT") {
    if (foundAt.length > 0) {
      return `Found at ${foundAt[0]} but not on PATH`;
    }
    return "Not found";
  }

  if (errorCode === "EACCES" || errorCode === "EPERM") {
    // Prefer a path that actually has the permission problem over any
    // unrelated executable hit, so the error points at the real offender.
    const brokenPath = nonExecutableAt[0] ?? foundAt[0];
    if (brokenPath) {
      return `Found at ${brokenPath} but not executable`;
    }
    return "Permission denied";
  }

  if (errorCode === "ETIMEDOUT") {
    if (foundAt.length > 0) {
      return `Timed out running ${foundAt[0]} --version`;
    }
    return `Timed out running ${binaryName} --version`;
  }

  const raw = `${spawnError.code}: ${spawnError.stderr || spawnError.message}`;
  return raw.slice(0, 80);
}

function classifyBinaryRemediation(
  binaryName: string,
  _spawnError: CommandError,
  debug: NonNullable<CheckResult["debug"]>
): string {
  const { errorCode } = debug;
  const foundAt = debug.foundAt ?? [];
  const nonExecutableAt = debug.nonExecutableAt ?? [];
  const shell = debug.shell || "shell";
  const platform = debug.platform ?? process.platform;

  if (errorCode === "ENOENT") {
    if (foundAt.length > 0) {
      return `Add ${path.dirname(foundAt[0])} to PATH in your ${shell} rc, then restart the app`;
    }
    return getInstallRemediation(binaryName, platform);
  }

  if (errorCode === "EACCES" || errorCode === "EPERM") {
    const brokenPath = nonExecutableAt[0] ?? foundAt[0];
    if (brokenPath) {
      return `chmod +x ${brokenPath}`;
    }
    return `Check executable permissions on your ${binaryName} install`;
  }

  if (errorCode === "ETIMEDOUT") {
    return `Try \`${binaryName} --version\` in a terminal -- it may be hanging on startup`;
  }

  return "See diagnostics tab for details";
}

async function checkGit(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const resolved = await resolveBinaryFromLoginShell("git", override);
  if (resolved.source === "override_invalid") {
    return {
      id: "git",
      label: "Git",
      required: true,
      passed: false,
      error: "Override path does not exist or is not executable",
      remediation: "Update git binary path in Settings, or clear the override",
      debug: { overrideUsed: override },
    };
  }
  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["--version"],
      { deadline }
    );
    return {
      id: "git",
      label: "Git",
      required: true,
      passed: true,
      version: parseVersion(stdout),
    };
  } catch (err) {
    const spawnError = err as CommandError;
    const debug = await collectBinaryDebug(
      "git",
      spawnError,
      KNOWN_GIT_LOCATIONS
    );
    if (resolved.source === "override") {
      debug.overrideUsed = override;
    }
    return {
      id: "git",
      label: "Git",
      required: true,
      passed: false,
      error: classifyBinaryError("git", spawnError, debug),
      remediation: classifyBinaryRemediation("git", spawnError, debug),
      debug,
    };
  }
}

async function checkClaudeCli(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const resolved = await resolveBinaryFromLoginShell("claude", override);
  if (resolved.source === "override_invalid") {
    return {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: false,
      error: "Override path does not exist or is not executable",
      remediation: "Update binary path in Settings, or clear the override",
      debug: { overrideUsed: override },
    };
  }
  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["--version"],
      { deadline }
    );
    return {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: true,
      version: parseVersion(stdout),
    };
  } catch (err) {
    const spawnError = err as CommandError;
    const debug = await collectBinaryDebug(
      "claude",
      spawnError,
      KNOWN_CLAUDE_LOCATIONS
    );
    if (resolved.source === "override") {
      debug.overrideUsed = override;
    }
    return {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: false,
      error: classifyBinaryError("claude", spawnError, debug),
      remediation: classifyBinaryRemediation("claude", spawnError, debug),
      debug,
    };
  }
}

async function checkGhCli(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const resolved = await resolveBinaryFromLoginShell("gh", override);
  if (resolved.source === "override_invalid") {
    return {
      id: "gh-cli",
      label: "GitHub CLI",
      required: true,
      passed: false,
      error: "Override path does not exist or is not executable",
      remediation: "Update gh binary path in Settings, or clear the override",
      debug: { overrideUsed: override },
    };
  }
  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["--version"],
      { deadline }
    );
    return {
      id: "gh-cli",
      label: "GitHub CLI",
      required: true,
      passed: true,
      version: parseVersion(stdout),
    };
  } catch (err) {
    const spawnError = err as CommandError;
    const debug = await collectBinaryDebug(
      "gh",
      spawnError,
      KNOWN_GH_LOCATIONS
    );
    if (resolved.source === "override") {
      debug.overrideUsed = override;
    }
    return {
      id: "gh-cli",
      label: "GitHub CLI",
      required: true,
      passed: false,
      error: classifyBinaryError("gh", spawnError, debug),
      remediation: classifyBinaryRemediation("gh", spawnError, debug),
      debug,
    };
  }
}

async function checkGhAuth(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const resolved = await resolveBinaryFromLoginShell("gh", override);
  if (resolved.source === "override_invalid") {
    return {
      id: "gh-auth",
      label: "GitHub Auth",
      required: true,
      passed: false,
      error: "Override path does not exist or is not executable",
      remediation: "Update gh binary path in Settings, or clear the override",
    };
  }
  try {
    await runCommandWithOptionalDeadline(resolved.path, ["auth", "status"], {
      deadline,
    });
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

async function readClaudePluginInventory(
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline,
  timeoutMs?: number
): Promise<PluginInventoryResult> {
  const resolved = await resolveBinaryFromLoginShell("claude", claudeOverride);
  if (resolved.source === "override_invalid") {
    return {
      source: "unavailable",
      entries: new Map(),
      error: "Claude binary override path does not exist or is not executable",
    };
  }

  let jsonFailure: string | undefined;
  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["plugin", "list", "--json"],
      { deadline, timeoutMs }
    );
    return {
      source: "json",
      entries: toPluginInventoryMap(parseClaudePluginListJson(stdout)),
    };
  } catch (error) {
    jsonFailure =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message)
          : "Unable to parse plugin JSON inventory";
  }

  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["plugin", "list"],
      { deadline, timeoutMs }
    );
    const entries = parseClaudePluginListText(stdout);
    if (entries.length > 0) {
      return {
        source: "text",
        entries: toPluginInventoryMap(entries),
      };
    }
  } catch {
    // Fall through to the deterministic unavailable result below.
  }

  return {
    source: "unavailable",
    entries: new Map(),
    error: jsonFailure,
  };
}

function getClosedloopPluginByCheckId(
  checkId: string
): (typeof CLOSEDLOOP_USER_PLUGINS)[number] | undefined {
  return CLOSEDLOOP_USER_PLUGINS.find(
    (plugin) => checkId === `plugin-${plugin.folder}`
  );
}

async function applyPluginEnableChecks(
  checks: CheckResult[],
  options: {
    claudeOverride?: string;
    remediationDeadline?: PluginRemediationDeadline;
    readInventory: (timeoutMs?: number) => Promise<PluginInventoryResult>;
  }
): Promise<CheckResult[]> {
  const disabledPlugins = checks.flatMap((check) => {
    if (!(check.id.startsWith("plugin-") && check.error === "Disabled")) {
      return [];
    }
    const plugin = getClosedloopPluginByCheckId(check.id);
    return plugin ? [plugin] : [];
  });

  if (disabledPlugins.length === 0) {
    return checks;
  }

  const pluginIds = disabledPlugins.map((plugin) => plugin.key);
  const startedAt = Date.now();
  gatewayLog.info(
    "health-check",
    `Starting Closedloop plugin enable attempt ${JSON.stringify({ pluginIds })}`
  );

  const enableResults = new Map<string, PluginUpdateCommandResult>();
  const remediationDeadline =
    options.remediationDeadline ?? createPluginRemediationDeadline();
  for (const plugin of disabledPlugins) {
    if (hasPluginRemediationDeadlineExpired(remediationDeadline)) {
      enableResults.set(plugin.key, createPluginRemediationTimeoutResult());
      continue;
    }
    const result = await runPluginCommandWithinDeadline(
      (timeoutMs) =>
        runPluginEnableCommand(plugin.key, {
          claudeOverride: options.claudeOverride,
          timeoutMs,
        }),
      remediationDeadline
    );
    enableResults.set(plugin.key, result);
  }

  const postInventory = await readPluginInventoryWithinDeadline(
    options.readInventory,
    remediationDeadline
  );
  const inventoryTimedOut =
    postInventory.error === PLUGIN_REMEDIATION_TIMEOUT_MESSAGE;
  const outcomes = Object.fromEntries(
    disabledPlugins.map((plugin) => {
      const postEntry = postInventory.entries.get(plugin.key);
      const enabled = postEntry?.enabled === true;
      return [
        plugin.key,
        inventoryTimedOut
          ? "timeout"
          : resolvePostUpdateOutcome(enabled, enableResults.get(plugin.key)),
      ];
    })
  ) as Record<string, PluginUpdateOutcome>;
  const failedResult = [...enableResults.values()].find(
    (result) => result.outcome === "failed" || result.outcome === "timeout"
  );

  gatewayLog.info(
    "health-check",
    `Completed Closedloop plugin enable attempt ${JSON.stringify({
      pluginIds,
      outcomes,
      durationMs: Date.now() - startedAt,
      exitCode: failedResult?.exitCode,
      stderrTail:
        failedResult?.stderrTail ||
        getPluginUpdateOutputTail(failedResult?.stdout),
    })}`
  );

  return checks.map((check) => {
    const plugin = getClosedloopPluginByCheckId(check.id);
    if (!(plugin && pluginIds.includes(plugin.key))) {
      return check;
    }

    const postEntry = postInventory.entries.get(plugin.key);
    const enabled = postEntry?.enabled === true;
    const outcome = outcomes[plugin.key] ?? "failed";
    if (enabled) {
      const { error: _error, remediation: _remediation, ...rest } = check;
      return {
        ...rest,
        passed: true,
        version: postEntry.version ?? check.version,
        enableAttempted: true,
        enableOutcome: "success",
        enablePluginIds: pluginIds,
      };
    }

    return {
      ...check,
      passed: false,
      error:
        outcome === "timeout" ? "Enable timed out" : "Automatic enable failed",
      remediation: buildPluginInstallRemediation(plugin.key),
      enableAttempted: true,
      enableOutcome: outcome,
      enablePluginIds: pluginIds,
    };
  });
}

function buildPluginInstallRemediation(pluginRef: string): string {
  return `Run: claude plugin install ${pluginRef} --scope user, then claude plugin enable ${pluginRef} --scope user`;
}

function checkPlugin(
  plugin: (typeof CLOSEDLOOP_USER_PLUGINS)[number],
  pluginListJson: string | null,
  pluginAutoUpdateEnabled: boolean
): CheckResult {
  const status = getPluginInstallStatus(
    plugin.folder,
    undefined,
    pluginListJson
  );
  const base = {
    id: `plugin-${plugin.folder}`,
    label: plugin.label,
    required: plugin.required,
    ...(status.selectedUserVersion
      ? { version: status.selectedUserVersion }
      : {}),
  };

  if (status.hasValidUserScopedEntry) {
    return { ...base, passed: true };
  }

  if (status.enabledStateUnverified) {
    return {
      ...base,
      passed: false,
      error: "Could not verify enabled state",
      remediation: `Run: claude plugin enable ${status.pluginRef} --scope user, then rerun System Check`,
      enableAttempted: false,
      enablePluginIds: [status.pluginRef],
      ...(pluginAutoUpdateEnabled ? {} : { enableOutcome: "skipped" as const }),
    };
  }

  if (status.disabled) {
    return {
      ...base,
      passed: false,
      error: "Disabled",
      remediation: `Run: claude plugin enable ${status.pluginRef} --scope user`,
      enableAttempted: false,
      enablePluginIds: [status.pluginRef],
      ...(pluginAutoUpdateEnabled ? {} : { enableOutcome: "skipped" as const }),
    };
  }

  if (!status.hasExistingUserInstallPath && status.hasProjectScopedEntry) {
    return {
      ...base,
      passed: false,
      error: "Installed at project scope",
      remediation: `Run: claude plugin uninstall ${status.pluginRef} --scope project, then claude plugin install ${status.pluginRef} --scope user`,
    };
  }

  if (status.hasUserScopedEntry && !status.hasExistingUserInstallPath) {
    return {
      ...base,
      passed: false,
      error: "Install path missing",
      remediation: `Run: claude plugin install ${status.pluginRef} --scope user`,
    };
  }

  return {
    ...base,
    passed: false,
    error: "Not found",
    remediation: `Run: claude plugin install ${status.pluginRef} --scope user`,
  };
}

async function checkWorktreeDir(
  getConfigDir: () => string
): Promise<CheckResult> {
  let configDir: string;
  try {
    configDir = getConfigDir();
  } catch {
    return {
      id: "worktree-dir",
      label: "Worktree Directory",
      required: true,
      passed: false,
      error: "Not configured",
      remediation:
        "Set the parent directory where git worktrees will be created",
    };
  }
  const config = await loadReposConfig(configDir);
  const configuredDir = config.settings?.worktreeParentDir;
  const confirmed = config.settings?.worktreeParentDirConfirmed;
  if (configuredDir && confirmed) {
    return {
      id: "worktree-dir",
      label: "Worktree Directory",
      required: true,
      passed: true,
      version: configuredDir,
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

async function checkCodex(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const resolved = await resolveBinaryFromLoginShell("codex", override);
  if (resolved.source === "override_invalid") {
    return {
      id: "codex",
      label: "Codex CLI",
      required: false,
      passed: false,
      error: "Override path does not exist or is not executable",
      remediation:
        "Update codex binary path in Settings, or clear the override",
      debug: { overrideUsed: override },
    };
  }
  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["--version"],
      { deadline }
    );
    return {
      id: "codex",
      label: "Codex CLI",
      required: false,
      passed: true,
      version: parseVersion(stdout),
    };
  } catch (err) {
    const spawnError = err as CommandError;
    const debug = await collectBinaryDebug(
      "codex",
      spawnError,
      KNOWN_CODEX_LOCATIONS
    );
    if (resolved.source === "override") {
      debug.overrideUsed = override;
    }
    return {
      id: "codex",
      label: "Codex CLI",
      required: false,
      passed: false,
      error: classifyBinaryError("codex", spawnError, debug),
      remediation: classifyBinaryRemediation("codex", spawnError, debug),
      debug,
    };
  }
}

async function checkPython3(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const REMEDIATION =
    process.platform === "darwin"
      ? "Install Python 3.10 or later: brew install python@3.13"
      : "Install Python 3.10 or later: sudo apt-get install python3 (or your distro's package manager)";
  const resolved = await resolveBinaryFromLoginShell("python3", override);
  if (resolved.source === "override_invalid") {
    return {
      id: "python3",
      label: "python3",
      required: true,
      passed: false,
      error: "Override path does not exist or is not executable",
      remediation:
        "Update python3 binary path in Settings, or clear the override",
      debug: { overrideUsed: override },
    };
  }
  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["--version"],
      { deadline }
    );
    const version = parseVersion(stdout);
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
  } catch (err) {
    const spawnError = err as CommandError;
    const debug = await collectBinaryDebug(
      "python3",
      spawnError,
      KNOWN_PYTHON3_LOCATIONS
    );
    if (resolved.source === "override") {
      debug.overrideUsed = override;
    }
    return {
      id: "python3",
      label: "python3",
      required: true,
      passed: false,
      error: classifyBinaryError("python3", spawnError, debug),
      remediation: classifyBinaryRemediation("python3", spawnError, debug),
      debug,
    };
  }
}

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

/** Builds the gateway-version health-check row from normalized semver strings. */
function checkAppVersion(
  currentVersion: string,
  latestVersion: string
): CheckResult {
  const isUpToDate = compareStrictSemver(currentVersion, latestVersion);
  if (isUpToDate === undefined) {
    return {
      id: "app-version",
      label: "Gateway Version",
      required: true,
      passed: true,
      version: currentVersion,
      error: `Version format unrecognized (installed: ${currentVersion}, latest: ${latestVersion})`,
    };
  }

  if (isUpToDate) {
    return {
      id: "app-version",
      label: "Gateway Version",
      required: true,
      passed: true,
      version: currentVersion,
    };
  }

  return {
    id: "app-version",
    label: "Gateway Version",
    required: true,
    passed: false,
    version: currentVersion,
    error: `Update available: ${latestVersion}`,
    remediation: "Open the Closedloop Gateway app to update",
  };
}

async function applyPluginVersionChecks(
  checks: CheckResult[],
  installed: Record<string, string>,
  options: {
    pluginAutoUpdateEnabled: boolean;
    claudeOverride?: string;
    remediationDeadline?: PluginRemediationDeadline;
    readInstalledVersions: () => Record<string, string>;
    preferConfiguredMarketplace?: boolean;
  }
): Promise<CheckResult[]> {
  const manifests = await fetchPluginManifests({
    claudeOverride: options.claudeOverride,
    remediationDeadline: options.remediationDeadline,
    preferConfiguredMarketplace: options.preferConfiguredMarketplace ?? true,
  });
  const versionChecks = new Map<string, Partial<CheckResult>>();
  const outdatedPlugins: Array<{
    plugin: (typeof CLOSEDLOOP_USER_PLUGINS)[number];
    installedVersion: string;
    latestVersion: string;
  }> = [];

  for (const manifest of manifests) {
    const { plugin } = manifest;
    const checkId = `plugin-${plugin.folder}`;
    const installedVer = installed[plugin.key] ?? "";

    if (manifest.error || !manifest.latestVersion) {
      versionChecks.set(checkId, manifestUnavailableResult());
      continue;
    }

    const cmp = compareStrictSemver(installedVer, manifest.latestVersion);

    if (cmp === undefined) {
      versionChecks.set(checkId, {
        passed: false,
        error: "Could not verify installed version",
        remediation: `Reinstall the plugin: claude plugin install ${plugin.key} --scope user`,
      });
    } else if (cmp === false) {
      outdatedPlugins.push({
        plugin,
        installedVersion: installedVer,
        latestVersion: manifest.latestVersion,
      });
      versionChecks.set(checkId, {
        passed: false,
        version: installedVer,
        error: `Update available: ${manifest.latestVersion}`,
        remediation: `claude plugin update ${plugin.key} --scope user`,
      });
    } else {
      versionChecks.set(checkId, {
        passed: true,
        version: installedVer,
      });
    }
  }

  if (options.pluginAutoUpdateEnabled && outdatedPlugins.length > 0) {
    const updateResults = await runPluginUpdates(outdatedPlugins, {
      ...options,
      remediationDeadline:
        options.remediationDeadline ?? createPluginRemediationDeadline(),
    });
    const finalInstalled = options.readInstalledVersions();
    const affectedCheckIds = outdatedPlugins.map(
      ({ plugin }) => `plugin-${plugin.folder}`
    );

    for (const outdated of outdatedPlugins) {
      const { plugin, latestVersion } = outdated;
      const checkId = `plugin-${plugin.folder}`;
      const finalVersion =
        finalInstalled[plugin.key] ?? installed[plugin.key] ?? "";
      const current = compareStrictSemver(finalVersion, latestVersion) === true;
      if (current) {
        versionChecks.set(checkId, {
          passed: true,
          version: finalVersion,
          updateAttempted: true,
          updateOutcome: "success",
          updatePluginIds: affectedCheckIds,
        });
        continue;
      }

      const updateResult = updateResults.get(plugin.key);
      const updateOutcome = resolvePostUpdateOutcome(false, updateResult);
      versionChecks.set(checkId, {
        passed: false,
        version: finalVersion,
        error: `Automatic update was attempted but did not succeed. Latest version: ${latestVersion}`,
        remediation: buildPluginUpdateRemediation(plugin.key),
        remediationLinks: [PLUGIN_AUTOUPDATE_DOCS_LINK],
        updateAttempted: true,
        updateOutcome,
        updatePluginIds: affectedCheckIds,
      });
    }
  }

  return checks.map((check) => {
    const versionCheck = versionChecks.get(check.id);
    return versionCheck === undefined ? check : { ...check, ...versionCheck };
  });
}

async function fetchPluginManifests(options: {
  claudeOverride?: string;
  remediationDeadline?: PluginRemediationDeadline;
  preferConfiguredMarketplace: boolean;
}): Promise<PluginManifest[]> {
  if (
    options.remediationDeadline &&
    hasPluginRemediationDeadlineExpired(options.remediationDeadline)
  ) {
    return createUnavailablePluginManifests();
  }
  if (options.preferConfiguredMarketplace) {
    const configuredMarketplaceManifests = options.remediationDeadline
      ? await runValueWithinDeadline(
          () =>
            readConfiguredMarketplaceManifests(
              options.claudeOverride,
              options.remediationDeadline
            ),
          options.remediationDeadline,
          createUnavailablePluginManifests,
          options.remediationDeadline.timeoutMs
        )
      : await readConfiguredMarketplaceManifests(
          options.claudeOverride,
          options.remediationDeadline
        );
    if (configuredMarketplaceManifests) {
      return configuredMarketplaceManifests;
    }
  }

  const timeoutMs = getPluginRemediationBoundedTimeoutMs(
    options.remediationDeadline,
    3000
  );
  if (timeoutMs <= 0) {
    return createUnavailablePluginManifests();
  }

  const results = await Promise.allSettled(
    CLOSEDLOOP_USER_PLUGINS.map((plugin) =>
      fetch(
        `https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/plugins/${plugin.folder}/.claude-plugin/plugin.json`,
        { signal: AbortSignal.timeout(timeoutMs) }
      )
    )
  );

  return Promise.all(
    CLOSEDLOOP_USER_PLUGINS.map(
      async (plugin, index): Promise<PluginManifest> => {
        const result = results[index];
        if (result.status === "rejected" || !result.value.ok) {
          return { plugin, error: "manifest_unavailable" };
        }
        try {
          const body = (await result.value.json()) as { version?: unknown };
          return typeof body.version === "string"
            ? { plugin, latestVersion: body.version }
            : { plugin, error: "manifest_unavailable" };
        } catch {
          return { plugin, error: "manifest_unavailable" };
        }
      }
    )
  );
}

async function readConfiguredMarketplaceManifests(
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline
): Promise<PluginManifest[] | null> {
  const root = await resolveConfiguredMarketplaceRoot(claudeOverride, deadline);
  if (!root) {
    return null;
  }

  let marketplacePlugins: Record<string, unknown>[];
  try {
    const marketplaceJson = JSON.parse(
      await fs.readFile(
        path.join(root, ".claude-plugin", "marketplace.json"),
        "utf-8"
      )
    ) as { plugins?: unknown };
    marketplacePlugins = Array.isArray(marketplaceJson.plugins)
      ? marketplaceJson.plugins.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null
        )
      : [];
  } catch {
    return CLOSEDLOOP_USER_PLUGINS.map((plugin) => ({
      plugin,
      error: "manifest_unavailable",
    }));
  }

  return Promise.all(
    CLOSEDLOOP_USER_PLUGINS.map(async (plugin): Promise<PluginManifest> => {
      const marketplaceEntry = marketplacePlugins.find(
        (entry) => entry.name === plugin.folder
      );
      const source =
        typeof marketplaceEntry?.source === "string"
          ? marketplaceEntry.source
          : undefined;
      if (!source) {
        return { plugin, error: "manifest_unavailable" };
      }

      try {
        const pluginJsonPath = path.resolve(
          root,
          source,
          ".claude-plugin",
          "plugin.json"
        );
        const body = JSON.parse(await fs.readFile(pluginJsonPath, "utf-8")) as {
          version?: unknown;
        };
        return typeof body.version === "string"
          ? { plugin, latestVersion: body.version }
          : { plugin, error: "manifest_unavailable" };
      } catch {
        return { plugin, error: "manifest_unavailable" };
      }
    })
  );
}

/**
 * Marketplace source types that expose a local on-disk checkout we can read
 * plugin manifests from. `directory` marketplaces point straight at a folder;
 * `github`/`git` marketplaces are cloned locally to `installLocation`. For all
 * three, that local checkout is the exact source `claude plugin update` installs
 * from, so comparing against it keeps the staleness verdict actionable. (FEA-2751)
 */
const MARKETPLACE_SOURCES_WITH_LOCAL_CHECKOUT = new Set([
  "directory",
  "github",
  "git",
]);

/**
 * Resolve the local checkout path for the Closedloop marketplace, if one exists.
 * `directory` marketplaces expose it via `path`; cloned `github`/`git`
 * marketplaces expose it via `installLocation`.
 */
function resolveMarketplaceCheckoutPath(
  marketplace: ClaudeMarketplaceListEntry
): string | undefined {
  if (
    typeof marketplace.source !== "string" ||
    !MARKETPLACE_SOURCES_WITH_LOCAL_CHECKOUT.has(marketplace.source)
  ) {
    return undefined;
  }
  if (typeof marketplace.path === "string" && marketplace.path.length > 0) {
    return marketplace.path;
  }
  if (
    typeof marketplace.installLocation === "string" &&
    marketplace.installLocation.length > 0
  ) {
    return marketplace.installLocation;
  }
  return undefined;
}

async function resolveConfiguredMarketplaceRoot(
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline
): Promise<string | null> {
  const resolved = await resolveBinaryFromLoginShell("claude", claudeOverride);
  if (resolved.source === "override_invalid") {
    return null;
  }

  try {
    const { stdout } = await runCommandWithOptionalDeadline(
      resolved.path,
      ["plugin", "marketplace", "list", "--json"],
      { deadline }
    );
    const entries = JSON.parse(stdout) as unknown;
    if (!Array.isArray(entries)) {
      return null;
    }

    const marketplace = entries.find(
      (entry): entry is ClaudeMarketplaceListEntry => {
        if (typeof entry !== "object" || entry === null) {
          return false;
        }
        const record = entry as ClaudeMarketplaceListEntry;
        return record.name === CLOSEDLOOP_MARKETPLACE_NAME;
      }
    );
    if (!marketplace) {
      return null;
    }

    const checkoutRoot = resolveMarketplaceCheckoutPath(marketplace);
    if (!(checkoutRoot && path.isAbsolute(checkoutRoot))) {
      return null;
    }

    // Only treat the local checkout as authoritative when it actually exists.
    // Otherwise return null so the caller falls back to the GitHub manifest
    // fetch, rather than reporting an unverifiable version. (FEA-2751)
    try {
      await fs.access(
        path.join(checkoutRoot, ".claude-plugin", "marketplace.json"),
        constants.F_OK
      );
    } catch {
      return null;
    }

    return checkoutRoot;
  } catch {
    return null;
  }
}

function manifestUnavailableResult(): Partial<CheckResult> {
  return {
    passed: false,
    error: "Could not verify latest version",
    remediation: "Check your network connection and re-run System Check",
  };
}

async function runPluginUpdates(
  outdatedPlugins: Array<{
    plugin: (typeof CLOSEDLOOP_USER_PLUGINS)[number];
    installedVersion: string;
    latestVersion: string;
  }>,
  options: {
    claudeOverride?: string;
    remediationDeadline: PluginRemediationDeadline;
    readInstalledVersions: () => Record<string, string>;
  }
): Promise<Map<string, PluginUpdateCommandResult>> {
  const updateResults = new Map<string, PluginUpdateCommandResult>();
  const startedAt = Date.now();
  const pluginIds = outdatedPlugins.map(({ plugin }) => plugin.key);
  const versionsBefore = Object.fromEntries(
    outdatedPlugins.map(({ plugin, installedVersion }) => [
      plugin.key,
      installedVersion,
    ])
  );

  gatewayLog.info(
    "health-check",
    `Starting Closedloop plugin update attempt ${JSON.stringify({
      pluginIds,
      versionsBefore,
    })}`
  );

  const marketplaceRefresh = hasPluginRemediationDeadlineExpired(
    options.remediationDeadline
  )
    ? createPluginRemediationTimeoutResult()
    : await runPluginCommandWithinDeadline(
        (timeoutMs) =>
          runPluginMarketplaceUpdateCommand({
            claudeOverride: options.claudeOverride,
            timeoutMs,
          }),
        options.remediationDeadline
      );
  const marketplaceRefreshSucceeded = marketplaceRefresh.outcome === "success";
  if (!marketplaceRefreshSucceeded) {
    gatewayLog.warn(
      "health-check",
      `Closedloop plugin marketplace refresh failed ${JSON.stringify({
        marketplace: CLOSEDLOOP_MARKETPLACE_NAME,
        outcome: marketplaceRefresh.outcome,
        exitCode: marketplaceRefresh.exitCode,
        failureReason: marketplaceRefresh.failureReason,
        stderrTail:
          marketplaceRefresh.stderrTail ||
          getPluginUpdateOutputTail(marketplaceRefresh.stdout),
      })}`
    );
  }

  Observability.pluginUpdateAttempted({
    pluginIds,
    versionsBefore,
    versionsAfter: versionsBefore,
    outcomes: Object.fromEntries(
      pluginIds.map((pluginId) => [pluginId, "skipped"])
    ) as Record<string, PluginUpdateOutcome>,
    durationMs: 0,
    command: "claude plugin update",
    scope: "user",
  });

  if (marketplaceRefreshSucceeded) {
    for (const { plugin, installedVersion, latestVersion } of outdatedPlugins) {
      if (hasPluginRemediationDeadlineExpired(options.remediationDeadline)) {
        updateResults.set(plugin.key, createPluginRemediationTimeoutResult());
        continue;
      }
      const suppressionKey = getFailedPluginUpdateAttemptKey(
        plugin.key,
        installedVersion,
        latestVersion
      );
      const suppressedOutcome = failedPluginUpdateAttempts.get(suppressionKey);
      if (suppressedOutcome) {
        updateResults.set(plugin.key, {
          outcome: "skipped",
          stdout: "",
          elapsedMs: 0,
          failureReason:
            suppressedOutcome === "timeout" ? "timeout" : "still_outdated",
        });
        continue;
      }

      const result = await runPluginCommandWithinDeadline(
        (timeoutMs) =>
          runPluginUpdateCommand(plugin.key, {
            claudeOverride: options.claudeOverride,
            timeoutMs,
          }),
        options.remediationDeadline
      );
      updateResults.set(plugin.key, result);
      if (result.outcome === "failed" || result.outcome === "timeout") {
        failedPluginUpdateAttempts.set(suppressionKey, result.outcome);
      }
    }
  } else {
    for (const { plugin } of outdatedPlugins) {
      updateResults.set(plugin.key, {
        ...marketplaceRefresh,
        stdout: marketplaceRefresh.stdout,
      });
    }
  }

  const versionsAfterRecord = options.readInstalledVersions();
  const versionsAfter = Object.fromEntries(
    pluginIds.map((pluginId) => [pluginId, versionsAfterRecord[pluginId] ?? ""])
  );
  const outcomes = Object.fromEntries(
    outdatedPlugins.map(({ plugin, latestVersion }) => {
      const finalVersion = versionsAfterRecord[plugin.key] ?? "";
      const current = compareStrictSemver(finalVersion, latestVersion) === true;
      return [
        plugin.key,
        resolvePostUpdateOutcome(current, updateResults.get(plugin.key)),
      ];
    })
  ) as Record<string, PluginUpdateOutcome>;
  const failedResult = [...updateResults.values()].find(
    (result) => result.outcome === "failed" || result.outcome === "timeout"
  );
  const failedOutputTail =
    failedResult?.stderrTail || getPluginUpdateOutputTail(failedResult?.stdout);
  const anyStillOutdated = outdatedPlugins.some(
    ({ plugin, latestVersion }) =>
      compareStrictSemver(
        versionsAfterRecord[plugin.key] ?? "",
        latestVersion
      ) !== true
  );
  if (marketplaceRefreshSucceeded) {
    for (const { plugin, installedVersion, latestVersion } of outdatedPlugins) {
      if (
        compareStrictSemver(
          versionsAfterRecord[plugin.key] ?? "",
          latestVersion
        ) === true
      ) {
        continue;
      }
      failedPluginUpdateAttempts.set(
        getFailedPluginUpdateAttemptKey(
          plugin.key,
          installedVersion,
          latestVersion
        ),
        outcomes[plugin.key] === "timeout" ? "timeout" : "failed"
      );
    }
  }
  const diagnostics: PluginUpdateDiagnostics = {
    pluginIds,
    versionsBefore,
    versionsAfter,
    outcomes,
    durationMs: Date.now() - startedAt,
    command: "claude plugin update",
    scope: "user",
    ...(failedResult?.exitCode !== undefined && {
      exitCode: failedResult.exitCode,
    }),
    ...(failedResult?.failureReason === undefined
      ? anyStillOutdated
        ? { failureReason: "still_outdated" as const }
        : {}
      : { failureReason: failedResult.failureReason }),
    ...(failedOutputTail ? { stderrTail: failedOutputTail } : {}),
  };

  gatewayLog.info(
    "health-check",
    `Completed Closedloop plugin update attempt ${JSON.stringify({
      pluginIds,
      versionsBefore,
      versionsAfter,
      outcomes,
      durationMs: diagnostics.durationMs,
      exitCode: diagnostics.exitCode,
      failureReason: diagnostics.failureReason,
      stderrTail: diagnostics.stderrTail,
    })}`
  );

  if (anyStillOutdated) {
    Observability.pluginUpdateFailed(diagnostics);
  } else {
    Observability.pluginUpdateSucceeded(diagnostics);
  }

  return updateResults;
}

function getFailedPluginUpdateAttemptKey(
  pluginRef: string,
  installedVersion: string,
  latestVersion: string
): string {
  return `${pluginRef}\u0000${installedVersion}\u0000${latestVersion}`;
}

function buildPluginUpdateRemediation(pluginRef: string): string {
  return [
    "1. Open Claude Code.",
    "2. Open the plugin marketplace and update the closedloop-ai marketplace, then update Closedloop plugins manually, or run:",
    `claude plugin marketplace update ${CLOSEDLOOP_MARKETPLACE_NAME}`,
    `claude plugin update ${pluginRef} --scope user`,
    "3. Restart Claude Code if needed.",
    "4. Re-run System Check.",
  ].join("\n");
}

function createPluginRemediationDeadline(): PluginRemediationDeadline {
  return {
    startedAt: Date.now(),
    timeoutMs: pluginRemediationDeadlineMs,
  };
}

function getPluginRemediationRemainingMs(
  deadline: PluginRemediationDeadline
): number {
  return Math.max(0, deadline.timeoutMs - (Date.now() - deadline.startedAt));
}

function hasPluginRemediationDeadlineExpired(
  deadline: PluginRemediationDeadline
): boolean {
  return getPluginRemediationRemainingMs(deadline) <= 0;
}

function getPluginRemediationBoundedTimeoutMs(
  deadline: PluginRemediationDeadline | undefined,
  maxTimeoutMs: number
): number {
  if (!deadline) {
    return maxTimeoutMs;
  }
  const remainingMs = getPluginRemediationRemainingMs(deadline);
  return remainingMs <= 0
    ? 0
    : Math.max(1, Math.min(maxTimeoutMs, remainingMs));
}

async function runValueWithinDeadline<T>(
  run: (timeoutMs: number) => Promise<T>,
  deadline: PluginRemediationDeadline,
  createTimeoutValue: (startedAt: number) => T,
  maxTimeoutMs = PLUGIN_UPDATE_TIMEOUT_MS
): Promise<T> {
  const timeoutMs = getPluginRemediationBoundedTimeoutMs(
    deadline,
    maxTimeoutMs
  );
  if (timeoutMs <= 0) {
    return createTimeoutValue(Date.now());
  }

  const startedAt = Date.now();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutResult = new Promise<T>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve(createTimeoutValue(startedAt));
    }, timeoutMs);
  });
  const operationResult = Promise.resolve().then(() => run(timeoutMs));

  try {
    return await Promise.race([operationResult, timeoutResult]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runCommandWithOptionalDeadline(
  cmd: string,
  args: string[],
  options: {
    deadline?: PluginRemediationDeadline;
    timeoutMs?: number;
  } = {}
): Promise<{ stdout: string }> {
  if (!options.deadline) {
    return runCommand(
      cmd,
      args,
      options.timeoutMs === undefined
        ? undefined
        : { timeoutMs: options.timeoutMs }
    );
  }

  const commandTimeoutMs = options.timeoutMs ?? HEALTH_PROBE_COMMAND_TIMEOUT_MS;
  return runCommandWithinDeadline(
    cmd,
    args,
    options.deadline,
    commandTimeoutMs
  );
}

async function runCommandWithinDeadline(
  cmd: string,
  args: string[],
  deadline: PluginRemediationDeadline,
  maxTimeoutMs: number
): Promise<{ stdout: string }> {
  const timeoutMs = getPluginRemediationBoundedTimeoutMs(
    deadline,
    maxTimeoutMs
  );
  if (timeoutMs <= 0) {
    throw createPluginRemediationCommandTimeoutError();
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutError = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(createPluginRemediationCommandTimeoutError());
    }, timeoutMs);
  });
  const commandResult = Promise.resolve().then(() =>
    runCommand(cmd, args, { timeoutMs })
  );

  try {
    return await Promise.race([commandResult, timeoutError]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runPluginCommandWithinDeadline(
  runCommandWithinTimeout: (
    timeoutMs: number
  ) => Promise<PluginUpdateCommandResult>,
  deadline: PluginRemediationDeadline
): Promise<PluginUpdateCommandResult> {
  const remainingMs = getPluginRemediationRemainingMs(deadline);
  if (remainingMs <= 0) {
    return createPluginRemediationTimeoutResult();
  }

  const startedAt = Date.now();
  const timeoutMs = Math.max(
    1,
    Math.min(PLUGIN_UPDATE_TIMEOUT_MS, remainingMs)
  );
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutResult = new Promise<PluginUpdateCommandResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve(createPluginRemediationTimeoutResult(startedAt));
    }, timeoutMs);
  });

  const commandResult = Promise.resolve()
    .then(() => runCommandWithinTimeout(timeoutMs))
    .catch(
      (error): PluginUpdateCommandResult => ({
        outcome: "failed",
        stdout: "",
        stderrTail: getPluginCommandErrorMessage(error),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        failureReason: "command_failed",
      })
    );

  try {
    return await Promise.race([commandResult, timeoutResult]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createPluginRemediationTimeoutResult(
  startedAt = Date.now()
): PluginUpdateCommandResult {
  return {
    outcome: "timeout",
    stdout: "",
    stderrTail: PLUGIN_REMEDIATION_TIMEOUT_MESSAGE,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    failureReason: "timeout",
  };
}

function createPluginRemediationCommandTimeoutError(): CommandError {
  return {
    code: "ETIMEDOUT",
    stderr: PLUGIN_REMEDIATION_TIMEOUT_MESSAGE,
    message: PLUGIN_REMEDIATION_TIMEOUT_MESSAGE,
  };
}

function createPluginInventoryTimeoutResult(): PluginInventoryResult {
  return {
    source: "unavailable",
    entries: new Map(),
    error: PLUGIN_REMEDIATION_TIMEOUT_MESSAGE,
  };
}

async function readPluginInventoryWithinDeadline(
  readInventory: (timeoutMs?: number) => Promise<PluginInventoryResult>,
  deadline: PluginRemediationDeadline
): Promise<PluginInventoryResult> {
  return runValueWithinDeadline(
    readInventory,
    deadline,
    createPluginInventoryTimeoutResult
  );
}

function createMcpDetectionTimeoutResult(): McpDetectionResult {
  return {
    available: false,
    serverName: null,
    matchedUrl: null,
    checkedAt: new Date().toISOString(),
    error: "Discovery timed out",
    closedloopAvailable: false,
  };
}

function createUnavailablePluginManifests(): PluginManifest[] {
  return CLOSEDLOOP_USER_PLUGINS.map((plugin) => ({
    plugin,
    error: "manifest_unavailable",
  }));
}

function getPluginCommandErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(-STDERR_TAIL_MAX_CHARS)
    : "Plugin remediation command failed";
}

async function getPlainHealthPluginEnv(): Promise<Record<string, string>> {
  // Plugin remediation runs in the health-check background path, not a
  // user/session Claude Code spawn. Keep it independent from OTel receiver
  // readiness so diagnostics still work when telemetry collection is down.
  return getShellEnv();
}

async function loadReposConfig(configDir: string): Promise<ReposConfig> {
  try {
    const configPath = path.join(configDir, "repos.json");
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content) as ReposConfig;
  } catch {
    return {};
  }
}
