import {
  CheckSeverity,
  type PluginUpdateOutcome,
} from "@closedloop-ai/loops-api/compute-target";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import type { PluginUpdateFailureReason } from "../../main/telemetry/telemetry-protocol.js";
import { describeUnverifiedReason } from "./health-check-plugin-read-copy.js";
import {
  type GatewayCheckResult as CheckResult,
  PLUGIN_CHECK_ID_PREFIX,
  PLUGIN_DISABLED_ERROR,
  pluginCheckId,
} from "./health-check-types.js";
import {
  type ClaudePluginInventoryEntry,
  isUserScopeEnabled,
  type PluginListReadFailureStatus,
} from "./plugin-cache.js";

/**
 * Closedloop plugin "enable" remediation, split out of `health-check.ts` so the
 * runner has one owner and two callers: the auto-remediating health-check route
 * and the explicit Repair operation (ISS-5389). The deadline/command primitives
 * stay in `health-check.ts` and are handed in as a runtime so this module never
 * imports back into its caller.
 */

export const CLOSEDLOOP_USER_PLUGINS = [
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

export type ClosedloopUserPlugin = (typeof CLOSEDLOOP_USER_PLUGINS)[number];

export type CommandError = {
  code: string; // "ENOENT", "EACCES", "ETIMEDOUT", or "EUNKNOWN"
  stderr: string;
  message: string;
};

export type PluginUpdateCommandResult = {
  outcome: PluginUpdateOutcome;
  exitCode?: number;
  stdout: string;
  stderrTail?: string;
  elapsedMs: number;
  failureReason?: PluginUpdateFailureReason;
};

export type PluginInventoryResult = {
  source: "json" | "text" | "unavailable";
  entries: Map<string, ClaudePluginInventoryEntry>;
  error?: string;
  /**
   * When `source` is `unavailable`, WHY the read produced no inventory
   * (ISS-5810 review) — `command_failed` (it could not be run) or `unreadable`
   * (it ran and printed something we cannot interpret). Absent on a successful
   * read, and absent on a timed-out one, which carries `error` instead and is
   * already reported as its own outcome.
   *
   * Carrying it is what keeps a failed VERIFICATION read an unknown: without
   * it, "the enable worked but we could not confirm it" is indistinguishable
   * from "the enable failed", and the row prescribed install-plus-enable for a
   * plugin that may well already be enabled.
   */
  unavailableReason?: PluginListReadFailureStatus;
};

export type PluginRemediationDeadline = {
  startedAt: number;
  timeoutMs: number;
};

/**
 * The deadline-bounded primitives `applyPluginEnableChecks` needs. Owned by
 * `health-check.ts` (which owns the mutable test seams for them) and injected
 * here so this module stays a leaf.
 */
export type PluginEnableRuntime = {
  createDeadline: () => PluginRemediationDeadline;
  hasDeadlineExpired: (deadline: PluginRemediationDeadline) => boolean;
  createTimeoutResult: () => PluginUpdateCommandResult;
  runEnableWithinDeadline: (
    pluginKey: string,
    options: { claudeOverride?: string },
    deadline: PluginRemediationDeadline
  ) => Promise<PluginUpdateCommandResult>;
  readInventoryWithinDeadline: (
    readInventory: (timeoutMs?: number) => Promise<PluginInventoryResult>,
    deadline: PluginRemediationDeadline
  ) => Promise<PluginInventoryResult>;
  /** The exact `error` string a timed-out inventory read carries. */
  timeoutMessage: string;
  /** Bounded tail used for the completion log's stderr field. */
  getOutputTail: (output: string | Buffer | undefined) => string;
};

export type ApplyPluginEnableOptions = {
  claudeOverride?: string;
  remediationDeadline?: PluginRemediationDeadline;
  readInventory: (timeoutMs?: number) => Promise<PluginInventoryResult>;
  runtime: PluginEnableRuntime;
};

export function getClosedloopPluginByCheckId(
  checkId: string
): ClosedloopUserPlugin | undefined {
  return CLOSEDLOOP_USER_PLUGINS.find(
    (plugin) => checkId === pluginCheckId(plugin.folder)
  );
}

/** The plugin rows the checker reports as installed-but-disabled. */
export function getDisabledClosedloopPlugins(
  checks: CheckResult[]
): ClosedloopUserPlugin[] {
  return checks.flatMap((check) => {
    if (
      !(
        check.id.startsWith(PLUGIN_CHECK_ID_PREFIX) &&
        check.error === PLUGIN_DISABLED_ERROR
      )
    ) {
      return [];
    }
    const plugin = getClosedloopPluginByCheckId(check.id);
    return plugin ? [plugin] : [];
  });
}

export function buildPluginInstallRemediation(pluginRef: string): string {
  return `Run: claude plugin install ${pluginRef} --scope user, then claude plugin enable ${pluginRef} --scope user`;
}

export function resolvePostUpdateOutcome(
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

/**
 * Runs `claude plugin enable` for every disabled Closedloop plugin, re-reads the
 * inventory, and folds the post-update outcome back into the check rows. Returns
 * `checks` untouched when nothing is disabled.
 */
export async function applyPluginEnableChecks(
  checks: CheckResult[],
  options: ApplyPluginEnableOptions
): Promise<CheckResult[]> {
  const disabledPlugins = getDisabledClosedloopPlugins(checks);
  if (disabledPlugins.length === 0) {
    return checks;
  }

  const { runtime } = options;
  const pluginIds = disabledPlugins.map((plugin) => plugin.key);
  const startedAt = Date.now();
  gatewayLog.info(
    "health-check",
    `Starting Closedloop plugin enable attempt ${JSON.stringify({ pluginIds })}`
  );

  const enableResults = new Map<string, PluginUpdateCommandResult>();
  const remediationDeadline =
    options.remediationDeadline ?? runtime.createDeadline();
  for (const plugin of disabledPlugins) {
    if (runtime.hasDeadlineExpired(remediationDeadline)) {
      enableResults.set(plugin.key, runtime.createTimeoutResult());
      continue;
    }
    const result = await runtime.runEnableWithinDeadline(
      plugin.key,
      { claudeOverride: options.claudeOverride },
      remediationDeadline
    );
    enableResults.set(plugin.key, result);
  }

  const postInventory = await runtime.readInventoryWithinDeadline(
    options.readInventory,
    remediationDeadline
  );
  const inventoryTimedOut = postInventory.error === runtime.timeoutMessage;
  const outcomes = Object.fromEntries(
    disabledPlugins.map((plugin) => {
      const enabled = isUserScopeEnabled(postInventory.entries.get(plugin.key));
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
        failedResult?.stderrTail || runtime.getOutputTail(failedResult?.stdout),
    })}`
  );

  return checks.map((check) => {
    const plugin = getClosedloopPluginByCheckId(check.id);
    if (!(plugin && pluginIds.includes(plugin.key))) {
      return check;
    }

    const postEntry = postInventory.entries.get(plugin.key);
    if (isUserScopeEnabled(postEntry)) {
      const { error: _error, remediation: _remediation, ...rest } = check;
      return {
        ...rest,
        passed: true,
        version: postEntry?.version ?? check.version,
        enableAttempted: true,
        enableOutcome: "success",
        enablePluginIds: pluginIds,
      };
    }

    return buildFailedEnableCheck(check, {
      pluginKey: plugin.key,
      pluginIds,
      outcome: outcomes[plugin.key] ?? "failed",
      unverifiedReason: inventoryTimedOut
        ? undefined
        : postInventory.unavailableReason,
    });
  });
}

/**
 * The row for a plugin the post-enable inventory did not confirm enabled.
 *
 * When the verification READ itself failed, the enable's own outcome is not
 * known — the command may well have succeeded — so the row states the unknown
 * instead of asserting "Automatic enable failed" and prescribing
 * install-plus-enable (ISS-5810 review). That remediation is the closed loop
 * this work exists to break: `claude plugin enable` fails by design on a plugin
 * that is already enabled, so a row that could not READ the state must never
 * hand it back as the fix. `enableOutcome` is omitted there rather than guessed
 * — every value it could carry renders a badge that would be a claim about a
 * result nothing measured.
 */
function buildFailedEnableCheck(
  check: CheckResult,
  context: {
    pluginKey: string;
    pluginIds: string[];
    outcome: PluginUpdateOutcome;
    unverifiedReason?: PluginListReadFailureStatus;
  }
): CheckResult {
  const base = {
    ...check,
    passed: false,
    enableAttempted: true,
    enablePluginIds: context.pluginIds,
  };

  if (context.unverifiedReason) {
    const unverified = describeUnverifiedReason(
      context.unverifiedReason,
      context.pluginKey
    );
    const { enableOutcome: _enableOutcome, ...rest } = base;
    return {
      ...rest,
      severity: CheckSeverity.Unknown,
      error: unverified.error,
      remediation: unverified.remediation,
    };
  }

  return {
    ...base,
    error:
      context.outcome === "timeout"
        ? "Enable timed out"
        : "Automatic enable failed",
    remediation: buildPluginInstallRemediation(context.pluginKey),
    enableOutcome: context.outcome,
  };
}
