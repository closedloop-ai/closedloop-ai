import { execFile } from "node:child_process";
import fs, { constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CheckSeverity,
  isFailingRequiredCheck,
} from "@closedloop-ai/loops-api/compute-target";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import { Observability } from "../../main/telemetry/observability.js";
import type {
  PluginUpdateDiagnostics,
  PluginUpdateOutcome,
} from "../../main/telemetry/telemetry-protocol.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import {
  getShellEnv,
  KNOWN_BINARY_LOCATIONS,
  resolveBinaryFromLoginShell,
  resolveExecutablesOnPath,
} from "../shell-path.js";
import {
  checkAppVersion,
  classifyGatewayBuild,
  compareStrictSemver,
} from "./health-check-app-version.js";
import {
  applyClaudeCliBlockedChecks,
  CLAUDE_CLI_CHECK_ID,
} from "./health-check-blocked.js";
import {
  type McpCheckResult,
  type McpRepairRequest,
  resolveMcpServers,
} from "./health-check-mcp-repair.js";
import {
  applyPluginEnableChecks,
  CLOSEDLOOP_USER_PLUGINS,
  type CommandError,
  type PluginEnableRuntime,
  type PluginInventoryResult,
  type PluginRemediationDeadline,
  type PluginUpdateCommandResult,
  resolvePostUpdateOutcome,
} from "./health-check-plugin-enable.js";
import {
  checkPlugin,
  type PluginInventoryRuntime,
  readClaudePluginInventory,
  readClaudePluginList,
} from "./health-check-plugin-inventory.js";
import {
  fetchPluginManifests,
  type PluginManifestRuntime,
} from "./health-check-plugin-manifests.js";
import {
  annotateRepairability,
  type BinaryPathsSnapshot,
} from "./health-check-repairability.js";
import {
  type GatewayCheckResult as CheckResult,
  CLOSEDLOOP_MARKETPLACE_NAME,
  CODEX_CLI_CHECK_ID,
  PLUGIN_CHECK_ID_PREFIX,
  pluginCheckId,
} from "./health-check-types.js";
import { checkWorktreeDir } from "./health-check-worktree-dir.js";
import {
  detectMcpAvailability,
  type McpDetectionResult,
} from "./mcp-detection.js";
import { getInstalledPluginVersions } from "./plugin-cache.js";
import { json } from "./response-utils.js";

const execFileAsync = promisify(execFile);
const VERSION_REGEX = /(\d+\.\d+[\w.-]*)/;
const VERSION_PREFIX_REGEX = /^[vV]/;
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
    checks.some((check) => check.id === CLAUDE_CLI_CHECK_ID && check.passed)
  );
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
  getAppVersion?: () => string | undefined,
  /**
   * `app.isPackaged`. Absent when the host cannot report it, in which case the
   * build stays unclassified and the version row asserts nothing (ISS-5369).
   */
  isPackagedBuild?: () => boolean
): void {
  const detectMcp = detectMcpOverride ?? detectMcpAvailability;
  const configDir = () => path.join(getSymphonyDir(), "config");

  dispatcher.register("GET", "/api/gateway/health-check", async (context) => {
    const response = await runHealthCheck({
      processManager,
      configDir,
      detectMcp,
      paths: getBinaryPaths?.(),
      expectedMcpUrl: context.query.get("expectedMcpUrl")?.trim() || undefined,
      requestedPluginAutoUpdate: context.query.get("pluginAutoUpdate") === "1",
      latestVersion: context.query.get("latestVersion")?.trim() || undefined,
      currentVersion: getAppVersion?.(),
      isPackagedBuild,
    });
    json(context, 200, response);
  });
}

export type HealthCheckRunOptions = {
  processManager: ProcessManager;
  configDir: () => string;
  detectMcp: (
    provider: "claude" | "codex",
    expectedMcpUrl?: string
  ) => Promise<McpDetectionResult>;
  paths?: BinaryPathsSnapshot;
  expectedMcpUrl?: string;
  requestedPluginAutoUpdate: boolean;
  latestVersion?: string;
  currentVersion?: string;
  /**
   * `app.isPackaged`. Absent when the host cannot report it, in which case the
   * build stays unclassified and the version row asserts nothing (ISS-5369).
   */
  isPackagedBuild?: () => boolean;
  /**
   * Set ONLY by the Repair operation (ISS-5435). Its presence opts this sweep
   * into registering a missing Closedloop MCP server, and each step it takes is
   * handed to `recordStep`. The plain health-check route never passes it, so a
   * read-only check can never write MCP config as a side effect — unlike
   * `requestedPluginAutoUpdate`, which is also a user setting.
   */
  mcpRepair?: McpRepairRequest;
};

export type GatewayHealthCheckResponse = {
  checks: CheckResult[];
  allRequiredPassed: boolean;
  mcpServers: {
    claude: McpCheckResult;
    codex: McpCheckResult;
  };
};

/**
 * Runs the full System Check sweep and returns the response body the
 * `GET /api/gateway/health-check` route serves. Exported so the Repair
 * operation can re-check in-process immediately after remediating, instead of
 * making the browser fire a second round trip it might not survive (ISS-5389).
 */
export async function runHealthCheck(
  options: HealthCheckRunOptions
): Promise<GatewayHealthCheckResponse> {
  const {
    processManager,
    configDir,
    detectMcp,
    paths,
    expectedMcpUrl,
    requestedPluginAutoUpdate,
  } = options;
  const pluginRemediationDeadline = requestedPluginAutoUpdate
    ? createPluginRemediationDeadline()
    : undefined;
  const [pluginListRead, baseChecks, claudeMcp, codexMcp] = await Promise.all([
    readClaudePluginList(
      createPluginInventoryRuntime(),
      paths?.claude,
      pluginRemediationDeadline
    ),
    Promise.all([
      checkGit(processManager, paths?.git, pluginRemediationDeadline),
      checkClaudeCli(processManager, paths?.claude, pluginRemediationDeadline),
      checkGhCli(processManager, paths?.gh, pluginRemediationDeadline),
      checkGhAuth(processManager, paths?.gh, pluginRemediationDeadline),
      checkWorktreeDir(configDir),
      checkCodex(processManager, paths?.codex, pluginRemediationDeadline),
      checkPython3(processManager, paths?.python3, pluginRemediationDeadline),
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
  ]);
  const pluginAutoUpdateEnabled = shouldEnablePluginAutoUpdate(
    requestedPluginAutoUpdate,
    baseChecks
  );
  const activePluginRemediationDeadline = pluginAutoUpdateEnabled
    ? pluginRemediationDeadline
    : undefined;
  const claudeCliCheck = baseChecks.find(
    (check) => check.id === CLAUDE_CLI_CHECK_ID
  );
  let pluginChecks = applyClaudeCliBlockedChecks(
    CLOSEDLOOP_USER_PLUGINS.map((plugin) =>
      checkPlugin(plugin, pluginListRead, pluginAutoUpdateEnabled)
    ),
    claudeCliCheck
  );
  if (pluginAutoUpdateEnabled) {
    pluginChecks = await applyPluginEnableChecks(pluginChecks, {
      claudeOverride: paths?.claude,
      remediationDeadline: activePluginRemediationDeadline,
      readInventory: (timeoutMs) =>
        readClaudePluginInventory(
          createPluginInventoryRuntime(),
          paths?.claude,
          activePluginRemediationDeadline,
          timeoutMs
        ),
      runtime: createPluginEnableRuntime(),
    });
  }
  let checks: CheckResult[] = [
    ...baseChecks.slice(0, 4),
    ...pluginChecks,
    ...baseChecks.slice(4),
  ];

  // Check plugin versions if all plugins are installed
  const allPluginsInstalled = checks
    .filter((c) => c.id.startsWith(PLUGIN_CHECK_ID_PREFIX))
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

  // The row is gated on knowing our OWN version, not on the release manifest.
  // A source build never needs a manifest, and a packaged build without one
  // should say "not verified" rather than have the Gateway Version row vanish
  // from the panel entirely (ISS-5369).
  if (options.currentVersion) {
    const latestNorm = options.latestVersion?.replace(VERSION_PREFIX_REGEX, "");
    const currentNorm = options.currentVersion.replace(
      VERSION_PREFIX_REGEX,
      ""
    );
    const appVersionResult = checkAppVersion(
      currentNorm,
      latestNorm,
      classifyGatewayBuild(options.isPackagedBuild?.())
    );
    checks.push(appVersionResult);
    Observability.healthCheckResult(appVersionResult);
  }

  // Through the SHARED predicate, never a local copy of `required && !passed`.
  // The cloud gate read `passed` alone and so counted a row the gateway could
  // not determine (`severity: "unknown" | "blocked"`) as a proven failure; that
  // is what made every web→desktop command unlaunchable (ISS-5811). This
  // gateway-side flag had the identical blindness, so it is derived from the
  // same function rather than a second predicate that can drift (ISS-5868).
  const allRequiredPassed = !checks.some(isFailingRequiredCheck);

  const annotatedChecks = await annotateRepairability(checks, paths);
  const mcpServers = await resolveMcpServers(
    { claude: claudeMcp, codex: codexMcp },
    { checks: annotatedChecks, expectedMcpUrl },
    options.mcpRepair
  );

  return {
    checks: annotatedChecks,
    allRequiredPassed,
    mcpServers,
  };
}

/**
 * The deadline-bounded primitives the plugin-enable runner needs, bound to this
 * module's (test-overridable) command runners. Exported so the Repair operation
 * drives the exact same runner the auto-remediating health check does, rather
 * than a second copy that can drift.
 */
export function createPluginEnableRuntime(): PluginEnableRuntime {
  return {
    createDeadline: createPluginRemediationDeadline,
    hasDeadlineExpired: hasPluginRemediationDeadlineExpired,
    createTimeoutResult: () => createPluginRemediationTimeoutResult(),
    runEnableWithinDeadline: (pluginKey, enableOptions, deadline) =>
      runPluginCommandWithinDeadline(
        (timeoutMs) =>
          runPluginEnableCommand(pluginKey, {
            claudeOverride: enableOptions.claudeOverride,
            timeoutMs,
          }),
        deadline
      ),
    readInventoryWithinDeadline: readPluginInventoryWithinDeadline,
    timeoutMessage: PLUGIN_REMEDIATION_TIMEOUT_MESSAGE,
    getOutputTail: getPluginUpdateOutputTail,
  };
}

/**
 * The deadline-bounded primitives the manifest reader needs, bound to this
 * module's (test-overridable) command runners — the same shape
 * `createPluginEnableRuntime` uses, so neither extracted module imports back
 * into this one.
 */
/**
 * The primitives `health-check-plugin-inventory.ts` needs, bound to this
 * module's (test-overridable) command runners — the same shape
 * `createPluginEnableRuntime` uses, so the extracted module stays a leaf.
 */
export function createPluginInventoryRuntime(): PluginInventoryRuntime {
  return {
    resolveClaudeBinary: (override) =>
      resolveBinaryFromLoginShell("claude", override),
    runCommand: runCommandWithOptionalDeadline,
  };
}

export function createPluginManifestRuntime(): PluginManifestRuntime {
  return {
    hasDeadlineExpired: hasPluginRemediationDeadlineExpired,
    runCommandWithinDeadline: runCommandWithOptionalDeadline,
    boundedTimeoutMs: getPluginRemediationBoundedTimeoutMs,
    runValueWithinDeadline,
  };
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

// Canonical known-install-location lists live in shell-path.ts, where they
// also drive the resolver's known-location tier (FEA-3742). Re-derive the
// per-binary diagnostics arrays from that single source so the resolver and
// the "found at X but not on PATH" diagnostics never drift.
const KNOWN_CLAUDE_LOCATIONS: string[] = KNOWN_BINARY_LOCATIONS.claude ?? [];
const KNOWN_GIT_LOCATIONS: string[] = KNOWN_BINARY_LOCATIONS.git ?? [];
const KNOWN_GH_LOCATIONS: string[] = KNOWN_BINARY_LOCATIONS.gh ?? [];
const KNOWN_CODEX_LOCATIONS: string[] = KNOWN_BINARY_LOCATIONS.codex ?? [];
const KNOWN_PYTHON3_LOCATIONS: string[] = KNOWN_BINARY_LOCATIONS.python3 ?? [];

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
      id: CLAUDE_CLI_CHECK_ID,
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
      id: CLAUDE_CLI_CHECK_ID,
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
      id: CLAUDE_CLI_CHECK_ID,
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

async function checkCodex(
  _processManager: ProcessManager,
  override?: string,
  deadline?: PluginRemediationDeadline
): Promise<CheckResult> {
  const resolved = await resolveBinaryFromLoginShell("codex", override);
  if (resolved.source === "override_invalid") {
    return {
      id: CODEX_CLI_CHECK_ID,
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
      id: CODEX_CLI_CHECK_ID,
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
      id: CODEX_CLI_CHECK_ID,
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
    runtime: createPluginManifestRuntime(),
  });
  const versionChecks = new Map<string, Partial<CheckResult>>();
  const outdatedPlugins: Array<{
    plugin: (typeof CLOSEDLOOP_USER_PLUGINS)[number];
    installedVersion: string;
    latestVersion: string;
  }> = [];

  for (const manifest of manifests) {
    const { plugin } = manifest;
    const checkId = pluginCheckId(plugin.folder);
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
    const affectedCheckIds = outdatedPlugins.map(({ plugin }) =>
      pluginCheckId(plugin.folder)
    );

    for (const outdated of outdatedPlugins) {
      const { plugin, latestVersion } = outdated;
      const checkId = pluginCheckId(plugin.folder);
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

/**
 * The plugin is installed and enabled — only "is a newer version published?"
 * could not be answered. Unknown is not out-of-date, so this stays passing and
 * non-blocking (ISS-5369); the `unknown` severity carries the real state.
 */
function manifestUnavailableResult(): Partial<CheckResult> {
  return {
    passed: true,
    severity: CheckSeverity.Unknown,
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
