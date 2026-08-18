import path from "node:path";
import {
  HealthCheckRepairAction,
  type HealthCheckRepairStep,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { HEALTH_CHECK_REPAIR_PATH } from "@repo/api/src/types/compute-target";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import {
  type GatewayHealthCheckResponse,
  runHealthCheck,
} from "./health-check.js";
import { CLAUDE_CLI_CHECK_ID } from "./health-check-blocked.js";
import type { McpConfigureRuntime } from "./health-check-mcp-repair.js";
import {
  type BinaryPathKey,
  type BinaryPathsSnapshot,
  findStaleBinaryOverrides,
} from "./health-check-repairability.js";
import {
  type GatewayCheckResult as CheckResult,
  PLUGIN_CHECK_ID_PREFIX,
} from "./health-check-types.js";
import {
  detectMcpAvailability,
  type McpDetectionResult,
} from "./mcp-detection.js";
import { json } from "./response-utils.js";

/**
 * `POST /api/gateway/health-check/repair` — the self-heal half of System Check
 * (ISS-5389).
 *
 * The remediations themselves already existed in `health-check.ts`; what was
 * missing was a way for the web to trigger them. This module is that bridge, and
 * it holds two rules the panel depends on:
 *
 *  1. **Root before cascade.** A provably-stale binary-path override is cleared
 *     FIRST, and the plugin-enable remediation runs inside the same sweep that
 *     re-derives the Claude CLI row — so it only fires once `claude` actually
 *     resolves. Firing five `claude plugin enable` commands against a broken
 *     path cannot succeed, and can even succeed in the user's own terminal while
 *     System Check keeps failing, which is exactly the loop this ends.
 *  2. **Re-check in the same round trip.** The response carries the freshly
 *     re-run health check, so the panel updates in place with no manual
 *     re-check and no copy-paste.
 */

export type ApplyBinaryPathPatch = (
  patch: Partial<Record<BinaryPathKey, string | null>>
) => unknown;

export type HealthCheckRepairDeps = {
  processManager: ProcessManager;
  getSymphonyDir: () => string;
  /** Defaults to the real MCP probe; overridden in tests. */
  detectMcp?: (
    provider: "claude" | "codex",
    expectedMcpUrl?: string
  ) => Promise<McpDetectionResult>;
  getBinaryPaths?: () => BinaryPathsSnapshot;
  applyBinaryPathPatch?: ApplyBinaryPathPatch;
  getAppVersion?: () => string | undefined;
  /**
   * `app.isPackaged`, threaded through so the re-check a Repair runs classifies
   * the Gateway Version row exactly as the plain health-check route does.
   * Without it the same build reads as `Source` on one path and `Unknown` on
   * the other (ISS-5369 + ISS-5389).
   */
  isPackagedBuild?: () => boolean;
  /**
   * Defaults to the real `mcp add` + re-probe pair; overridden in tests
   * (ISS-5435).
   */
  mcpConfigureRuntime?: McpConfigureRuntime;
};

export type HealthCheckRepairRequest = {
  expectedMcpUrl?: string;
  latestVersion?: string;
};

export type HealthCheckRepairResult = {
  steps: HealthCheckRepairStep[];
  result: GatewayHealthCheckResponse;
  joinedInFlight?: boolean;
};

/**
 * The single in-flight repair, tagged with the request inputs it ran under.
 *
 * A second press with the SAME inputs joins the promise, so double-clicking
 * cannot double-run the enable commands. A caller with DIFFERENT inputs must
 * NOT join: `expectedMcpUrl` and `latestVersion` are inputs to the re-check
 * this response carries, so handing over the first caller's verdict would cache
 * one caller's answer under another caller's query key (ISS-5389 review). Such a
 * caller queues behind the running repair instead, which preserves the property
 * the single-flight guard existed for — the mutations still never overlap.
 */
let inFlightRepair: {
  key: string;
  promise: Promise<HealthCheckRepairResult>;
} | null = null;

export function registerHealthCheckRepairRoutes(
  dispatcher: OperationDispatcher,
  deps: HealthCheckRepairDeps
): void {
  dispatcher.register("POST", HEALTH_CHECK_REPAIR_PATH, async (context) => {
    const response = await repairHealthCheck(deps, {
      expectedMcpUrl: context.query.get("expectedMcpUrl")?.trim() || undefined,
      latestVersion: context.query.get("latestVersion")?.trim() || undefined,
    });
    json(context, 200, response);
  });
}

/**
 * Runs the repair, or joins the one already running under the same inputs. The
 * joined caller gets the same steps and the same re-check, flagged with
 * `joinedInFlight` so the panel can say so rather than implying a second repair
 * happened.
 */
export function repairHealthCheck(
  deps: HealthCheckRepairDeps,
  request: HealthCheckRepairRequest = {}
): Promise<HealthCheckRepairResult> {
  const key = getRepairRequestKey(request);
  const current = inFlightRepair;
  if (current?.key === key) {
    return current.promise.then((result) => ({
      ...result,
      joinedInFlight: true,
    }));
  }

  // Different inputs: wait for the running repair to settle (its failure is not
  // ours to inherit, hence the swallow), then run our own.
  const previous = current
    ? current.promise.then(
        () => undefined,
        () => undefined
      )
    : Promise.resolve();
  const run: Promise<HealthCheckRepairResult> = previous
    .then(() => executeRepair(deps, request))
    .finally(() => {
      if (inFlightRepair?.promise === run) {
        inFlightRepair = null;
      }
    });
  inFlightRepair = { key, promise: run };
  return run;
}

/**
 * Identity of a repair request: everything that feeds the re-check it returns.
 * Two requests share a run only when both inputs match exactly.
 */
function getRepairRequestKey(request: HealthCheckRepairRequest): string {
  return JSON.stringify([
    request.expectedMcpUrl ?? null,
    request.latestVersion ?? null,
  ]);
}

/** @internal Test-only. Drops any in-flight repair so suites cannot leak state. */
export function _resetHealthCheckRepairStateForTesting(): void {
  inFlightRepair = null;
}

async function executeRepair(
  deps: HealthCheckRepairDeps,
  request: HealthCheckRepairRequest
): Promise<HealthCheckRepairResult> {
  const startedAt = Date.now();
  const steps: HealthCheckRepairStep[] = [];
  const clearedOverrideCheckIds = await clearStaleBinaryOverrides(deps, steps);

  gatewayLog.info(
    "health-check",
    `Starting System Check repair ${JSON.stringify({
      clearedOverrideCheckIds,
    })}`
  );

  // One sweep with plugin auto-remediation requested. `runHealthCheck` only lets
  // the plugin-enable runner fire when the freshly-probed `claude-cli` row
  // passes, so the root fix above is what unlocks the cascade — not a second
  // hand-rolled ordering rule that could drift from it.
  const result = await runHealthCheck({
    processManager: deps.processManager,
    configDir: () => path.join(deps.getSymphonyDir(), "config"),
    detectMcp: deps.detectMcp ?? detectMcpAvailability,
    paths: deps.getBinaryPaths?.(),
    expectedMcpUrl: request.expectedMcpUrl,
    requestedPluginAutoUpdate: true,
    latestVersion: request.latestVersion,
    currentVersion: deps.getAppVersion?.(),
    isPackagedBuild: deps.isPackagedBuild,
    // Opts this sweep into MCP remediation for BOTH providers (ISS-5435). The
    // steps land in the same ordered list as the override clear above, after it,
    // because the sweep's own freshly-probed CLI rows are what gate them.
    mcpRepair: {
      recordStep: (step) => steps.push(step),
      runtime: deps.mcpConfigureRuntime,
    },
  });

  const enableStep = derivePluginEnableStep(result.checks);
  if (enableStep) {
    steps.push(enableStep);
  }

  gatewayLog.info(
    "health-check",
    `Completed System Check repair ${JSON.stringify({
      durationMs: Date.now() - startedAt,
      steps: steps.map((step) => ({
        action: step.action,
        status: step.status,
      })),
      allRequiredPassed: result.allRequiredPassed,
    })}`
  );

  return { steps, result };
}

/**
 * Clears every provably-stale binary-path override in one patch. "Provably
 * stale" means the configured path does not exist or is not executable right
 * now — a working override is never touched, because silently rewriting a
 * setting the user deliberately set would be its own bug.
 */
async function clearStaleBinaryOverrides(
  deps: HealthCheckRepairDeps,
  steps: HealthCheckRepairStep[]
): Promise<string[]> {
  const stale = await findStaleBinaryOverrides(deps.getBinaryPaths?.());
  if (stale.length === 0) {
    return [];
  }

  const checkIds = stale.map((entry) => entry.checkId);
  const label = `Clear stale binary path override${stale.length === 1 ? "" : "s"}: ${stale
    .map((entry) => entry.label)
    .join(", ")}`;

  if (!deps.applyBinaryPathPatch) {
    steps.push({
      action: HealthCheckRepairAction.ClearBinaryOverride,
      label,
      status: HealthCheckRepairStepStatus.Failed,
      checkIds,
      detail:
        "This gateway build cannot change binary paths remotely. Clear the override in Desktop Settings.",
    });
    return [];
  }

  const patch: Partial<Record<BinaryPathKey, string | null>> = {};
  for (const entry of stale) {
    patch[entry.key] = null;
  }

  try {
    deps.applyBinaryPathPatch(patch);
  } catch (error) {
    steps.push({
      action: HealthCheckRepairAction.ClearBinaryOverride,
      label,
      status: HealthCheckRepairStepStatus.Failed,
      checkIds,
      detail: `Could not clear the override: ${getErrorMessage(error)}`,
    });
    return [];
  }

  steps.push({
    action: HealthCheckRepairAction.ClearBinaryOverride,
    label,
    status: HealthCheckRepairStepStatus.Succeeded,
    checkIds,
    detail: `Removed ${stale
      .map((entry) => `${entry.label} (${entry.path})`)
      .join(", ")}`,
  });
  return checkIds;
}

/**
 * Describes what happened to the plugin rows in the sweep. Returns `null` when
 * there was nothing to say — no enable was attempted and no plugin row is
 * failing — so the panel never shows an empty "we did something" line.
 */
function derivePluginEnableStep(
  checks: CheckResult[]
): HealthCheckRepairStep | null {
  const pluginChecks = checks.filter((check) =>
    check.id.startsWith(PLUGIN_CHECK_ID_PREFIX)
  );
  const attempted = pluginChecks.filter((check) => check.enableAttempted);
  const failingPlugins = pluginChecks.filter((check) => !check.passed);

  if (attempted.length > 0) {
    const stillFailing = attempted.filter((check) => !check.passed);
    if (stillFailing.length === 0) {
      return {
        action: HealthCheckRepairAction.EnablePlugins,
        label: "Enable Closedloop Claude Code plugins",
        status: HealthCheckRepairStepStatus.Succeeded,
        checkIds: attempted.map((check) => check.id),
      };
    }
    return {
      action: HealthCheckRepairAction.EnablePlugins,
      label: "Enable Closedloop Claude Code plugins",
      status: HealthCheckRepairStepStatus.Failed,
      checkIds: stillFailing.map((check) => check.id),
      detail: stillFailing
        .map((check) => `${check.label}: ${check.error ?? "enable failed"}`)
        .join("; "),
    };
  }

  if (failingPlugins.length === 0) {
    return null;
  }

  const claudeCliFailed = checks.some(
    (check) => check.id === CLAUDE_CLI_CHECK_ID && !check.passed
  );
  if (claudeCliFailed) {
    return {
      action: HealthCheckRepairAction.EnablePlugins,
      label: "Enable Closedloop Claude Code plugins",
      status: HealthCheckRepairStepStatus.Skipped,
      checkIds: failingPlugins.map((check) => check.id),
      detail:
        "Not run: the Claude CLI still does not resolve, so `claude plugin enable` could not have succeeded. Fix the Claude CLI row first, then repair again.",
    };
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "unknown error";
}
