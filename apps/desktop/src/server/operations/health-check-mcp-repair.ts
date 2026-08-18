import {
  type CheckResultRepair,
  HealthCheckRepairAction,
  type HealthCheckRepairStep,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import { CLAUDE_CLI_CHECK_ID } from "./health-check-blocked.js";
import {
  type GatewayCheckResult as CheckResult,
  CODEX_CLI_CHECK_ID,
  mcpCheckId,
} from "./health-check-types.js";
import {
  type McpDetectionResult,
  type McpProvider,
  redetectMcpAvailability,
  runMcpAddCommand,
} from "./mcp-detection.js";

/**
 * MCP repairability and remediation, for BOTH providers (ISS-5435).
 *
 * ISS-5389 shipped Repair for binary-path overrides and Claude Code plugins.
 * The two MCP rows were left out, and not because they are hard: they are the
 * only rows the gateway never annotates at all. `claude-mcp` / `codex-mcp` are
 * synthesized CLIENT-side by `getRenderableHealthChecks` out of the
 * `mcpServers` map, so they never pass through `annotateRepairability` and
 * arrive at the panel with no `repair` field — which the panel correctly reads
 * as "this gateway cannot repair it". Both providers therefore showed a red row
 * whose only way out was copy-pasting an `mcp add` into a terminal.
 *
 * Both CLIs can add a streamable-HTTP MCP server non-interactively, so the
 * gateway can do exactly what that copy-paste would have done:
 *
 *   claude mcp add --transport http --scope user <name> <url>
 *   codex  mcp add <name> --url <url>
 *
 * The annotation this module attaches rides on the `mcpServers` entry rather
 * than on a check row, because that is the only place the gateway owns; the web
 * copies it onto the row it synthesizes.
 */

/** Name the gateway registers the Closedloop MCP server under. */
export const CLOSEDLOOP_MCP_SERVER_NAME = "closedloop";

/** Wall-clock ceiling for one `mcp add`. */
export const MCP_ADD_TIMEOUT_MS = 20_000;

/**
 * Wall-clock ceiling for the WHOLE MCP remediation stage, both providers
 * included.
 *
 * The budget it has to fit inside: the browser's relay client abandons a command
 * after 120s without an event (`RESULT_STREAM_TIMEOUT_MS` in
 * `apps/app/lib/engineer/relay-client.ts`), and the gateway emits nothing while
 * a repair runs. The plugin remediation earlier in this same sweep may already
 * have spent its own 40s deadline. That leaves ~80s, and this takes 70 of it —
 * above the ~55s worst case of the slower provider run in parallel (a 20s add
 * plus a re-probe that can reach 35s), so a legitimately slow repair still
 * completes, while a pathological one is cut off with something to say instead
 * of being abandoned mid-flight by a client that has stopped listening.
 */
export const MCP_REPAIR_DEADLINE_MS = 70_000;

/** The stage's wall-clock budget, as an absolute expiry. */
export type McpRepairDeadline = { expiresAt: number };

function createMcpRepairDeadline(): McpRepairDeadline {
  return { expiresAt: Date.now() + mcpRepairDeadlineMs };
}

let mcpRepairDeadlineMs = MCP_REPAIR_DEADLINE_MS;

/**
 * @internal Test-only. Shrinks the stage deadline so a suite can prove the
 * bound without waiting 70 real seconds. Call with no argument to restore.
 */
export function _setMcpRepairDeadlineMsForTesting(timeoutMs?: number): void {
  mcpRepairDeadlineMs = timeoutMs ?? MCP_REPAIR_DEADLINE_MS;
}

/**
 * `error` set by `mcp-detection.ts` when the server IS configured but only in
 * project-local scope. Matched on the symbol rather than a second copy of the
 * literal.
 */
export const MCP_PROJECT_LOCAL_ERROR = "Project-local config unsupported";

const NOT_REPAIRABLE_MCP_REASONS = {
  noExpectedUrl:
    "Repair does not know which MCP URL this target should point at, so it has nothing to configure. Run the check again from a workspace that supplies one.",
  disconnected:
    "The MCP server is already configured, so there is nothing for Repair to add. It is not connecting, which usually needs a sign-in on that machine.",
  projectLocal:
    "This MCP server is configured for a single project, which shadows the user-wide one Repair would add. Remove the project-local entry on that machine, then run the check again.",
  probeFailed:
    "The MCP probe itself did not complete, so Repair cannot tell what is configured. Run the check again.",
  unusableUrl:
    "The MCP URL this target was given is not a usable http(s) address, so Repair will not register it. Check the MCP server URL configuration.",
  rootStillFailing:
    "Repair tried to fix the tool this needs and it is still not working, so registering the MCP server would not have helped. Fix that row, then run the check again.",
  blockedByClaudeCli:
    "This needs the Claude CLI, which is not working and cannot be repaired from here. Fix the Claude CLI row first, then run the check again.",
  blockedByCodexCli:
    "This needs the Codex CLI, which is not working and cannot be repaired from here. Fix the Codex CLI row first, then run the check again.",
} as const;

/** An `McpDetectionResult` carrying the gateway's repairability verdict. */
export type McpCheckResult = McpDetectionResult & {
  repair?: CheckResultRepair;
};

export type McpRepairContext = {
  expectedMcpUrl?: string;
  /** The freshly-probed base checks, used to gate on the provider's own CLI row. */
  checks: Pick<CheckResult, "id" | "passed" | "repair">[];
};

/** The command runner + re-probe an MCP remediation needs. Injected for tests. */
export type McpConfigureRuntime = {
  addServer: (
    provider: McpProvider,
    serverName: string,
    url: string
  ) => Promise<McpAddCommandResult>;
  redetect: (
    provider: McpProvider,
    expectedMcpUrl: string
  ) => Promise<McpDetectionResult>;
};

export type McpAddCommandResult = {
  ok: boolean;
  /** Why it failed. Always present when `ok` is false. */
  detail?: string;
};

export type McpConfigureOutcome = {
  mcpServers: { claude: McpCheckResult; codex: McpCheckResult };
  steps: HealthCheckRepairStep[];
};

/**
 * Set ONLY by the Repair operation. Its presence opts a sweep into registering
 * a missing Closedloop MCP server; each step taken is handed to `recordStep`.
 */
export type McpRepairRequest = {
  recordStep: (step: HealthCheckRepairStep) => void;
  runtime?: McpConfigureRuntime;
};

/**
 * Annotates both MCP rows with their repairability and, when this sweep is a
 * Repair, registers the ones that are missing (ISS-5435).
 *
 * Called from inside the single health-check sweep, after the base checks have
 * been re-derived, so the gate on each provider's CLI row reads the row as it
 * stands after a stale binary override was cleared — the structural
 * root-before-cascade rule ISS-5389 established, not a second copy of it.
 */
export async function resolveMcpServers(
  detected: { claude: McpDetectionResult; codex: McpDetectionResult },
  context: McpRepairContext,
  mcpRepair: McpRepairRequest | undefined
): Promise<{ claude: McpCheckResult; codex: McpCheckResult }> {
  if (!mcpRepair) {
    return annotateMcpRepairability(detected, context);
  }

  const outcome = await applyMcpConfigureRemediation(
    detected,
    context,
    mcpRepair.runtime ?? createMcpConfigureRuntime()
  );
  for (const step of outcome.steps) {
    mcpRepair.recordStep(step);
  }
  return outcome.mcpServers;
}

/**
 * The real `mcp add` + re-probe pair, so the Repair operation drives the same
 * commands detection reads back.
 */
export function createMcpConfigureRuntime(): McpConfigureRuntime {
  return {
    addServer: (provider, serverName, url) =>
      runMcpAddCommand(provider, serverName, url, MCP_ADD_TIMEOUT_MS),
    redetect: (provider, expectedMcpUrl) =>
      redetectMcpAvailability(provider, expectedMcpUrl),
  };
}

/**
 * Whether the web panel renders a row for this provider at all. Mirrors
 * `getMcpCheckResult` in `apps/app/lib/engineer/queries/health-check.ts`: a
 * provider with no detection context whatsoever is omitted, and annotating a
 * row nobody renders would be a repair verdict for a failure the user is not
 * looking at.
 */
export function isMcpRowRendered(
  detection: McpDetectionResult,
  expectedMcpUrl: string | undefined
): boolean {
  return Boolean(
    expectedMcpUrl ||
      detection.available ||
      detection.serverName ||
      detection.matchedUrl ||
      detection.closedloopAvailable
  );
}

/**
 * The provider CLI row this MCP row cascades from. `claude mcp add` cannot run
 * without a working `claude`, and the same holds for Codex — the exact shape
 * ISS-5389 established for a plugin row blocked by the Claude CLI.
 */
export function getMcpRootCheckId(provider: McpProvider): string {
  return provider === "claude" ? CLAUDE_CLI_CHECK_ID : CODEX_CLI_CHECK_ID;
}

/**
 * Repairability for one provider's MCP row, or `undefined` when the row is not
 * rendered or is passing — a green row has nothing to repair, exactly as
 * `annotateRepairability` leaves passing check rows alone.
 */
export function resolveMcpRepair(
  provider: McpProvider,
  detection: McpDetectionResult,
  context: McpRepairContext
): CheckResultRepair | undefined {
  if (!isMcpRowRendered(detection, context.expectedMcpUrl)) {
    return;
  }
  if (detection.available || detection.closedloopAvailable) {
    return;
  }

  if (detection.error) {
    return {
      repairable: false,
      reason:
        detection.error === MCP_PROJECT_LOCAL_ERROR
          ? NOT_REPAIRABLE_MCP_REASONS.projectLocal
          : NOT_REPAIRABLE_MCP_REASONS.probeFailed,
    };
  }

  // Configured under a name but not connected. Repair would only re-add what is
  // already there; connecting it is an interactive sign-in on that machine.
  if (detection.serverName) {
    return {
      repairable: false,
      reason: NOT_REPAIRABLE_MCP_REASONS.disconnected,
    };
  }

  if (!context.expectedMcpUrl) {
    return {
      repairable: false,
      reason: NOT_REPAIRABLE_MCP_REASONS.noExpectedUrl,
    };
  }

  // The URL becomes an argv entry of a command run on the user's machine and,
  // more importantly, the endpoint their MCP client will then talk to. It
  // arrives as a query parameter, so validate it here rather than trusting the
  // caller: anything that is not a parseable http(s) URL is not repairable.
  // This also guarantees the value cannot begin with `-` and be mistaken for a
  // flag by the provider CLI's own argument parser.
  if (!isConfigurableMcpUrl(context.expectedMcpUrl)) {
    return {
      repairable: false,
      reason: NOT_REPAIRABLE_MCP_REASONS.unusableUrl,
    };
  }

  return resolveMcpRepairAgainstRoot(provider, context);
}

/**
 * Whether `url` is something this gateway is willing to register with a
 * provider CLI: a well-formed absolute URL over http(s). Everything else — a
 * relative path, a `file:`/`data:` scheme, a value starting with `-` — is
 * refused rather than handed to `mcp add`.
 */
export function isConfigurableMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Annotates both providers in one pass. The map is returned with `repair` added
 * and nothing else changed.
 */
export function annotateMcpRepairability(
  mcpServers: { claude: McpDetectionResult; codex: McpDetectionResult },
  context: McpRepairContext
): { claude: McpCheckResult; codex: McpCheckResult } {
  return {
    claude: withMcpRepair("claude", mcpServers.claude, context),
    codex: withMcpRepair("codex", mcpServers.codex, context),
  };
}

/**
 * Configures the MCP server for every provider whose row is repairable right
 * now, then re-probes that provider so the response carries the state the add
 * actually produced rather than the pre-repair one.
 *
 * Called from inside the single health-check sweep, after the base checks have
 * been re-derived, so the root-before-cascade gate reads the CLI row as it
 * stands AFTER a stale binary override was cleared — the same structural rule
 * `shouldEnablePluginAutoUpdate` enforces for plugins, not a second copy of it.
 */
export async function applyMcpConfigureRemediation(
  mcpServers: { claude: McpDetectionResult; codex: McpDetectionResult },
  context: McpRepairContext,
  runtime: McpConfigureRuntime
): Promise<McpConfigureOutcome> {
  const annotated = annotateMcpRepairability(mcpServers, context);
  const expectedMcpUrl = context.expectedMcpUrl;
  if (!expectedMcpUrl) {
    return { mcpServers: annotated, steps: [] };
  }

  const resolved: { claude: McpCheckResult; codex: McpCheckResult } = {
    ...annotated,
  };
  const stepsByProvider = new Map<McpProvider, HealthCheckRepairStep>();
  const toConfigure: McpProvider[] = [];

  for (const provider of MCP_PROVIDERS) {
    const repair = annotated[provider].repair;
    if (repair?.action !== HealthCheckRepairAction.ConfigureMcp) {
      const skipped = deriveSkippedConfigureStep(provider, repair);
      if (skipped) {
        stepsByProvider.set(provider, skipped);
      }
      continue;
    }

    // EXECUTION-TIME gate, distinct from the annotation above. Annotation is a
    // forward-looking claim ("Repair could fix this, because the root fault is
    // itself repairable"); by the time we get here the sweep has finished and
    // the root row's `passed` is the settled truth. They disagree when the
    // root's own remediation did not land — a stale override the gateway could
    // not clear is still reported `repairable`, so trusting that label would
    // fire `mcp add` against a tool that still does not work. Gate on `passed`,
    // exactly as `shouldEnablePluginAutoUpdate` does for the plugin cascade.
    const blockedStep = deriveRootStillFailingStep(provider, context);
    if (blockedStep) {
      stepsByProvider.set(provider, blockedStep);
      resolved[provider] = {
        ...annotated[provider],
        repair: {
          repairable: false,
          reason: NOT_REPAIRABLE_MCP_REASONS.rootStillFailing,
          blockedByCheckId: getMcpRootCheckId(provider),
        },
      };
      continue;
    }

    toConfigure.push(provider);
  }

  // CONCURRENT, and bounded. `claude mcp add` and `codex mcp add` touch
  // different CLIs and different config files, so nothing orders them — but run
  // one after the other they cost their two worst cases ADDED UP (add + re-probe
  // each), on top of the ~40s the plugin remediation may already have spent in
  // this same sweep, which together can overrun the 120s the browser's relay
  // client waits before abandoning the command and skipping snapshot
  // persistence, even though the Desktop mutation keeps going. Run in parallel
  // the stage costs the worse of the two rather than their sum, and the deadline
  // makes that a guarantee rather than an estimate (ISS-5435 review).
  const deadline = createMcpRepairDeadline();
  const configured = await Promise.all(
    toConfigure.map((provider) =>
      configureOneProviderWithinDeadline(
        provider,
        expectedMcpUrl,
        context,
        runtime,
        resolved,
        deadline
      )
    )
  );
  for (const [index, provider] of toConfigure.entries()) {
    const step = configured[index];
    if (step) {
      stepsByProvider.set(provider, step);
    }
  }

  // Rebuilt in provider order, so running the two concurrently does not make the
  // narration's order depend on which CLI happened to answer first.
  const steps = MCP_PROVIDERS.map((provider) =>
    stepsByProvider.get(provider)
  ).filter((step): step is HealthCheckRepairStep => step !== undefined);

  return { mcpServers: resolved, steps };
}

const MCP_PROVIDERS: readonly McpProvider[] = ["claude", "codex"];

function getMcpLabel(provider: McpProvider): string {
  return provider === "claude" ? "Claude MCP" : "Codex MCP";
}

function withMcpRepair(
  provider: McpProvider,
  detection: McpDetectionResult,
  context: McpRepairContext
): McpCheckResult {
  const repair = resolveMcpRepair(provider, detection, context);
  return repair ? { ...detection, repair } : detection;
}

/**
 * The MCP row is actionable only once its provider CLI is, or provably will be
 * by the time this step runs. A CLI row that is itself repairable is cleared
 * FIRST in the same sweep, so offering the MCP add alongside it is honest; a
 * CLI row nothing here can fix would only ever produce a skipped step.
 */
function resolveMcpRepairAgainstRoot(
  provider: McpProvider,
  context: McpRepairContext
): CheckResultRepair {
  const rootCheckId = getMcpRootCheckId(provider);
  const rootCheck = context.checks.find((check) => check.id === rootCheckId);
  if (rootCheck && !rootCheck.passed) {
    if (rootCheck.repair?.repairable === true) {
      return {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
        blockedByCheckId: rootCheckId,
      };
    }
    return {
      repairable: false,
      reason:
        provider === "claude"
          ? NOT_REPAIRABLE_MCP_REASONS.blockedByClaudeCli
          : NOT_REPAIRABLE_MCP_REASONS.blockedByCodexCli,
      blockedByCheckId: rootCheckId,
    };
  }

  return { repairable: true, action: HealthCheckRepairAction.ConfigureMcp };
}

/**
 * The narration for a provider Repair deliberately did NOT configure. Only a
 * row blocked by its own CLI earns a step — everything else either is not
 * failing or carries its reason on the row itself, and inventing a step for it
 * would put a verdict on screen for a row the user can already read.
 */
/**
 * The narration for a provider whose root CLI row is STILL failing at the
 * moment the remediation would run, or `null` when the root is fine. Separate
 * from `deriveSkippedConfigureStep`, which describes a row that was never
 * offered in the first place.
 */
function deriveRootStillFailingStep(
  provider: McpProvider,
  context: McpRepairContext
): HealthCheckRepairStep | null {
  const rootCheckId = getMcpRootCheckId(provider);
  const rootCheck = context.checks.find((check) => check.id === rootCheckId);
  if (!rootCheck || rootCheck.passed) {
    return null;
  }
  return {
    action: HealthCheckRepairAction.ConfigureMcp,
    label: `Configure ${getMcpLabel(provider)}`,
    status: HealthCheckRepairStepStatus.Skipped,
    checkIds: [mcpCheckId(provider)],
    detail: `Not run: the ${provider === "claude" ? "Claude" : "Codex"} CLI still does not resolve after this repair, so \`${provider} mcp add\` could not have succeeded.`,
  };
}

function deriveSkippedConfigureStep(
  provider: McpProvider,
  repair: CheckResultRepair | undefined
): HealthCheckRepairStep | null {
  if (!repair || repair.repairable || !repair.blockedByCheckId) {
    return null;
  }
  return {
    action: HealthCheckRepairAction.ConfigureMcp,
    label: `Configure ${getMcpLabel(provider)}`,
    status: HealthCheckRepairStepStatus.Skipped,
    checkIds: [mcpCheckId(provider)],
    detail: `Not run: the ${provider === "claude" ? "Claude" : "Codex"} CLI still does not resolve, so \`${provider} mcp add\` could not have succeeded. Fix that row first, then repair again.`,
  };
}

/**
 * One provider's configure, abandoned if the stage deadline passes first.
 *
 * Abandoning is the caller's wait, not the child process: `runMcpAddCommand`
 * carries its own timeout and will terminate on its own. What this guarantees is
 * that the HTTP response comes back inside the window the browser is still
 * listening in — a repair that reports "this took too long" is recoverable,
 * where one the client gave up on is silently lost along with the snapshot it
 * would have persisted.
 */
async function configureOneProviderWithinDeadline(
  provider: McpProvider,
  expectedMcpUrl: string,
  context: McpRepairContext,
  runtime: McpConfigureRuntime,
  resolved: { claude: McpCheckResult; codex: McpCheckResult },
  deadline: McpRepairDeadline
): Promise<HealthCheckRepairStep> {
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) {
    return deriveDeadlineExceededStep(provider);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<HealthCheckRepairStep>((resolve) => {
    timer = setTimeout(
      () => resolve(deriveDeadlineExceededStep(provider)),
      remainingMs
    );
  });

  try {
    return await Promise.race([
      configureOneProvider(
        provider,
        expectedMcpUrl,
        context,
        runtime,
        resolved
      ),
      expiry,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function deriveDeadlineExceededStep(
  provider: McpProvider
): HealthCheckRepairStep {
  return {
    action: HealthCheckRepairAction.ConfigureMcp,
    label: `Configure ${getMcpLabel(provider)}`,
    status: HealthCheckRepairStepStatus.Failed,
    checkIds: [mcpCheckId(provider)],
    detail: `Repair ran out of time before \`${provider} mcp add\` finished. It may still have completed on that machine — run the check again to see.`,
  };
}

async function configureOneProvider(
  provider: McpProvider,
  expectedMcpUrl: string,
  context: McpRepairContext,
  runtime: McpConfigureRuntime,
  resolved: { claude: McpCheckResult; codex: McpCheckResult }
): Promise<HealthCheckRepairStep> {
  const label = `Configure ${getMcpLabel(provider)}`;
  const checkIds = [mcpCheckId(provider)];

  const added = await runtime.addServer(
    provider,
    CLOSEDLOOP_MCP_SERVER_NAME,
    expectedMcpUrl
  );
  if (!added.ok) {
    gatewayLog.warn(
      "health-check",
      `${provider} mcp add failed: ${added.detail ?? "unknown error"}`
    );
    return {
      action: HealthCheckRepairAction.ConfigureMcp,
      label,
      status: HealthCheckRepairStepStatus.Failed,
      checkIds,
      detail: added.detail ?? "The MCP server could not be added.",
    };
  }

  // Re-probe so the response reports what the add actually produced. Adding a
  // server does not guarantee it connects — an unauthenticated one comes back
  // configured-but-disconnected, and saying so is the point.
  const redetected = await runtime.redetect(provider, expectedMcpUrl);
  resolved[provider] = withMcpRepair(provider, redetected, context);

  if (redetected.available) {
    return {
      action: HealthCheckRepairAction.ConfigureMcp,
      label,
      status: HealthCheckRepairStepStatus.Succeeded,
      checkIds,
      detail: `Added ${CLOSEDLOOP_MCP_SERVER_NAME} pointing at ${expectedMcpUrl}`,
    };
  }

  return {
    action: HealthCheckRepairAction.ConfigureMcp,
    label,
    status: HealthCheckRepairStepStatus.Failed,
    checkIds,
    detail: `Added ${CLOSEDLOOP_MCP_SERVER_NAME} pointing at ${expectedMcpUrl}, but it is still not connected${
      redetected.error ? `: ${redetected.error}` : "."
    }`,
  };
}
