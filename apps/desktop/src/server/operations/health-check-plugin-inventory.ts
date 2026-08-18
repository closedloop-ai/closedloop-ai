/**
 * Reading the Claude plugin inventory, and turning it into System Check rows.
 *
 * Split out of `health-check.ts` by ISS-5810, which is what grew this concern:
 * the reader now has to keep three distinct outcomes apart (see
 * `readClaudePluginList`) instead of collapsing every failure into one
 * unusable "could not verify enabled state" row.
 *
 * This is a leaf, like `health-check-plugin-enable.ts`: the deadline-bounded
 * command runner and the binary resolver are INJECTED as a
 * `PluginInventoryRuntime` by `health-check.ts`, so this module never imports
 * back into it.
 */

import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import type { BinaryResolveResult } from "../shell-path.js";
import type {
  ClosedloopUserPlugin,
  PluginInventoryResult,
  PluginRemediationDeadline,
} from "./health-check-plugin-enable.js";
import { describeUnverifiedEnabledState } from "./health-check-plugin-read-copy.js";
import type { GatewayCheckResult as CheckResult } from "./health-check-types.js";
import { PLUGIN_DISABLED_ERROR, pluginCheckId } from "./health-check-types.js";
import {
  getPluginInstallStatusFromRead,
  interpretPluginListOutput,
  type PluginListRead,
  toPluginInventoryMap,
} from "./plugin-cache.js";

/**
 * The primitives this module needs from `health-check.ts`, which owns the
 * mutable test seams for both. Same shape as `PluginEnableRuntime`.
 */
export type PluginInventoryRuntime = {
  resolveClaudeBinary: (override?: string) => Promise<BinaryResolveResult>;
  runCommand: (
    cmd: string,
    args: string[],
    options: { deadline?: PluginRemediationDeadline; timeoutMs?: number }
  ) => Promise<{ stdout: string }>;
};

function describeCommandFailure(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: unknown }).message).trim();
    return message.length > 0 ? message.slice(0, 512) : undefined;
  }
  return error instanceof Error ? error.message.slice(0, 512) : undefined;
}

/**
 * Read the Claude plugin inventory, keeping WHY a read failed (ISS-5810).
 *
 * The previous reader returned `string | null`, so an unresolvable binary, a
 * spawn error, a timeout, a non-zero exit and unparseable output all arrived as
 * the same `null`. Every one of them then rendered as "Could not verify enabled
 * state" with `claude plugin enable … --scope user` as the fix — a command that
 * FAILS when the plugin is already enabled, leaving the operator in a loop with
 * no exit. Three outcomes are kept apart here instead:
 *
 *  - `command_failed` — the command could not be RUN. Nothing about the plugin
 *    is known, and the remedy is the Claude CLI, not the plugin.
 *  - `unreadable` — it ran, but its output matched neither the JSON nor the
 *    documented text shape. The Claude CLI ships on its own cadence, so an
 *    unrecognized or future shape degrades to a STATED unknown here.
 *  - `ok` — it ran and parsed. The entries are authoritative.
 *
 * `--json` is preferred; a CLI build that rejects the flag falls back to the
 * human-readable listing, which since ISS-5810 also carries `Scope:`.
 */
export async function readClaudePluginList(
  runtime: PluginInventoryRuntime,
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline,
  timeoutMs?: number
): Promise<PluginListRead> {
  const resolved = await runtime.resolveClaudeBinary(claudeOverride);
  if (resolved.source === "override_invalid") {
    return {
      status: "command_failed",
      detail: "Claude binary override path does not exist or is not executable",
    };
  }

  const jsonRead = await runPluginListInvocation(
    runtime,
    resolved.path,
    ["plugin", "list", "--json"],
    "`claude plugin list --json`",
    { deadline, timeoutMs }
  );
  if (jsonRead.status === "ok") {
    return jsonRead;
  }

  // `--json` yielded no inventory — either it could not be run, or it ran and
  // printed something we cannot interpret, which is what a CLI build that does
  // not support the flag looks like when it writes its usage text to stdout and
  // exits 0. Both are worth retrying against the plain listing; before ISS-5810
  // review only the first was (the unreadable case returned here), so the
  // fallback never ran in the case it exists for.
  const textRead = await runPluginListInvocation(
    runtime,
    resolved.path,
    ["plugin", "list"],
    "`claude plugin list`",
    { deadline, timeoutMs }
  );
  if (textRead.status === "ok") {
    return textRead;
  }

  // Neither invocation produced an inventory. An invocation that RAN outranks
  // one that could not: the command is readable-but-unrecognized, not
  // unrunnable, and those have different remedies. Between two unreadable
  // outcomes prefer the `--json` one, which names the flag; between two
  // unrunnable ones likewise, since the `--json` failure is the specific one.
  if (jsonRead.status === "unreadable") {
    return jsonRead;
  }
  return textRead.status === "unreadable" ? textRead : jsonRead;
}

/**
 * The post-enable inventory the enable runner re-reads. Built on the single
 * `readClaudePluginList` reader so the detection and remediation paths cannot
 * drift apart — before ISS-5810 only this one had the text fallback, while the
 * path that produces the user-visible plugin rows did not.
 */
export async function readClaudePluginInventory(
  runtime: PluginInventoryRuntime,
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline,
  timeoutMs?: number
): Promise<PluginInventoryResult> {
  const read = await readClaudePluginList(
    runtime,
    claudeOverride,
    deadline,
    timeoutMs
  );
  if (read.status === "ok") {
    return {
      source: read.source,
      entries: toPluginInventoryMap(read.entries),
    };
  }
  // WHICH failure it was travels with the result (ISS-5810 review). Folding
  // `command_failed` and `unreadable` into one bare "unavailable" is what let a
  // successful enable followed by a failed VERIFICATION read be reported as
  // "Automatic enable failed" with an install-plus-enable remediation — the
  // same closed loop, one step later.
  return {
    source: "unavailable",
    unavailableReason: read.status,
    entries: new Map(),
    ...(read.detail ? { error: read.detail } : {}),
  };
}

export function checkPlugin(
  plugin: ClosedloopUserPlugin,
  pluginListRead: PluginListRead,
  pluginAutoUpdateEnabled: boolean
): CheckResult {
  const status = getPluginInstallStatusFromRead(plugin.folder, pluginListRead);
  const base = {
    id: pluginCheckId(plugin.folder),
    label: plugin.label,
    required: plugin.required,
    ...(status.selectedUserVersion
      ? { version: status.selectedUserVersion }
      : {}),
  };

  if (status.hasValidUserScopedEntry) {
    return { ...base, passed: true };
  }

  // `disabled` and `enabledStateUnverified` are mutually exclusive since
  // ISS-5810 — `classifyEnabledState` never sets both — so this ordering is for
  // readability, not disambiguation. The rule it encodes still holds where it
  // matters, inside that classifier: when the CLI read fails, the local
  // registry can still PROVE the plugin is switched off, and proven disabled is
  // evidence that outranks not-determinable (ISS-5389). Reporting "could not
  // verify" there would downgrade a real, directly actionable finding into an
  // unknown.
  if (status.disabled) {
    return {
      ...base,
      passed: false,
      error: PLUGIN_DISABLED_ERROR,
      remediation: `Run: claude plugin enable ${status.pluginRef} --scope user`,
      enableAttempted: false,
      enablePluginIds: [status.pluginRef],
      ...(pluginAutoUpdateEnabled ? {} : { enableOutcome: "skipped" as const }),
    };
  }

  if (status.enabledStateUnverified) {
    // The plugin is installed but its enabled state could not be read, and the
    // registry does not prove it disabled either. That is not-determinable, not
    // a proven failure — see health-check-blocked.ts, which upgrades this to
    // `blocked` and rewrites the remediation when the Claude CLI itself is the
    // reason.
    //
    // NONE of these branches prescribes `claude plugin enable` (ISS-5810). For
    // an already-enabled plugin that command fails by design — "already enabled
    // at user scope" — so offering it here told the operator to run something
    // guaranteed to error, with no way to clear the row. Each branch instead
    // names what could not be read and asks for a step that can actually
    // change the answer.
    const unverified = describeUnverifiedEnabledState(status);
    return {
      ...base,
      passed: false,
      severity: CheckSeverity.Unknown,
      error: unverified.error,
      remediation: unverified.remediation,
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

/**
 * `interpretPluginListOutput`, plus which invocation produced the output so an
 * unreadable result can say what it could not read.
 */
function describeInterpretedOutput(
  stdout: string,
  commandLabel: string
): PluginListRead {
  const read = interpretPluginListOutput(stdout);
  if (read.status === "unreadable") {
    return {
      status: "unreadable",
      detail: `${commandLabel} produced output in an unrecognized format`,
    };
  }
  return read;
}

/**
 * One `claude plugin list` invocation, as a `PluginListRead`. A throw is
 * `command_failed`; anything it printed goes through the single interpreter.
 */
async function runPluginListInvocation(
  runtime: PluginInventoryRuntime,
  claudePath: string,
  args: string[],
  commandLabel: string,
  options: { deadline?: PluginRemediationDeadline; timeoutMs?: number }
): Promise<PluginListRead> {
  try {
    const { stdout } = await runtime.runCommand(claudePath, args, options);
    return describeInterpretedOutput(stdout, commandLabel);
  } catch (error) {
    const detail = describeCommandFailure(error);
    return {
      status: "command_failed",
      ...(detail ? { detail } : {}),
    };
  }
}
