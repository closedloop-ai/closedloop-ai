import { constants } from "node:fs";
import { access } from "node:fs/promises";
import {
  type CheckResultRepair,
  CheckSeverity,
  HealthCheckRepairAction,
} from "@closedloop-ai/loops-api/compute-target";
import { CLAUDE_CLI_CHECK_ID } from "./health-check-blocked.js";
import {
  type GatewayCheckResult as CheckResult,
  CODEX_CLI_CHECK_ID,
  PLUGIN_CHECK_ID_PREFIX,
  PLUGIN_DISABLED_ERROR,
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
} from "./health-check-types.js";

/**
 * Per-row repairability for System Check (ISS-5389).
 *
 * The panel must never offer a Repair control that silently does nothing for
 * the failure the user is staring at, so every FAILING row is annotated here
 * with either a concrete action the gateway can run on its own machine, or a
 * plain-language reason it cannot. Passing rows carry no annotation.
 */

export type BinaryPathsSnapshot = {
  claude?: string;
  gh?: string;
  codex?: string;
  python3?: string;
  git?: string;
};

export type BinaryPathKey = keyof BinaryPathsSnapshot;

/**
 * Check id → the binary-path override that check honours. `gh-auth` is absent
 * deliberately: it fails on credentials, not on a path, so clearing an override
 * would not fix it.
 */
const BINARY_CHECK_OVERRIDES: ReadonlyArray<{
  checkId: string;
  key: BinaryPathKey;
  label: string;
}> = [
  { checkId: "git", key: "git", label: "Git" },
  { checkId: CLAUDE_CLI_CHECK_ID, key: "claude", label: "Claude CLI" },
  { checkId: "gh-cli", key: "gh", label: "GitHub CLI" },
  { checkId: CODEX_CLI_CHECK_ID, key: "codex", label: "Codex CLI" },
  { checkId: "python3", key: "python3", label: "Python 3" },
];

/** The credentials row `gh-cli` guards. Fails on auth, never on a path. */
const GH_AUTH_CHECK_ID = "gh-auth";

// The Gateway Version row is deliberately absent: ISS-5369 made every version
// finding non-blocking (`passed: true` on every branch) and gave it its own
// remediation, so it never reaches this annotator and needs no reason here.
const NOT_REPAIRABLE_REASONS = {
  pluginNotInstalled:
    "Repair can re-enable an installed plugin, but it cannot install a missing one. Run the installer on that machine.",
  pluginStateUnverified:
    "The plugin is installed, but its enabled state could not be read. Repair has no safe action until that resolves.",
  pluginBlockedByClaudeCli:
    "This needs the Claude CLI, which is not working and cannot be repaired from here. Fix the Claude CLI row first, then run the check again.",
  binaryMissing:
    "The tool is not installed (or not on PATH) on that machine. Repair cannot install it for you.",
  // Layout-neutral on purpose: this reason renders on the check row itself, and
  // that row appears on the settings card as well as in the pre-loop dialog. The
  // dialog has a worktree picker; the settings card does not, so copy pointing
  // "below" was wrong on one of the two surfaces (ISS-5389 review).
  worktreeDir:
    "Repair cannot choose a worktree directory for you. Set one for this compute target, then run the check again.",
  // `gh auth login` is a device-code flow: it prints a one-time code and waits
  // for the user to paste it into a browser. There is no non-interactive form
  // Repair could run on the user's behalf, so this row states the command
  // instead of leaving the generic "some manual step" (ISS-5435).
  ghAuth:
    "Signing in to GitHub needs a one-time code entered in a browser, which Repair cannot do for you. Run `gh auth login` on that machine, then run the check again.",
  generic:
    "This one needs a manual step on the gateway machine; Repair has no action for it.",
} as const;

/**
 * Every `error` string meaning "installed, but the enabled state could not be
 * read" (ISS-5810). Membership is the contract Repair classifies on — add any
 * new unreadable-state string here, never a fourth bare comparison.
 */
const PLUGIN_STATE_UNREADABLE_ERRORS: ReadonlySet<string> = new Set([
  PLUGIN_STATE_UNVERIFIED_ERROR,
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
]);

/**
 * Whether `override` is PROVABLY stale — set, and pointing at something that
 * does not exist or is not executable. Anything short of provable (no override,
 * or an override that still resolves) is not repaired: clearing a working
 * override would be a silent settings change the user did not ask for.
 */
export async function isStaleBinaryOverride(
  override: string | undefined
): Promise<boolean> {
  if (!override) {
    return false;
  }
  try {
    await access(override, constants.X_OK);
    return false;
  } catch {
    return true;
  }
}

/** The binary-path overrides that are provably stale right now. */
export async function findStaleBinaryOverrides(
  paths: BinaryPathsSnapshot | undefined
): Promise<
  Array<{ checkId: string; key: BinaryPathKey; label: string; path: string }>
> {
  if (!paths) {
    return [];
  }
  const stale: Array<{
    checkId: string;
    key: BinaryPathKey;
    label: string;
    path: string;
  }> = [];
  for (const entry of BINARY_CHECK_OVERRIDES) {
    const override = paths[entry.key];
    if (override && (await isStaleBinaryOverride(override))) {
      stale.push({
        checkId: entry.checkId,
        key: entry.key,
        label: entry.label,
        path: override,
      });
    }
  }
  return stale;
}

/**
 * Annotates every failing check with its repairability. `checks` is returned
 * unchanged apart from the added `repair` field, and passing rows are left
 * alone — a green row has nothing to repair.
 */
export async function annotateRepairability(
  checks: CheckResult[],
  paths: BinaryPathsSnapshot | undefined
): Promise<CheckResult[]> {
  const stale = await findStaleBinaryOverrides(paths);
  const staleCheckIds = new Set(stale.map((entry) => entry.checkId));
  const claudeCliFailed = checks.some(
    (check) => check.id === CLAUDE_CLI_CHECK_ID && !check.passed
  );
  // A stale override is the ONLY Claude CLI fault this gateway can clear, so it
  // is also the only one that makes a blocked plugin row worth offering.
  const claudeCliRepairable = staleCheckIds.has(CLAUDE_CLI_CHECK_ID);

  return checks.map((check) => {
    if (check.passed) {
      return check;
    }
    return {
      ...check,
      repair: resolveCheckRepair(check, {
        staleCheckIds,
        claudeCliFailed,
        claudeCliRepairable,
      }),
    };
  });
}

function resolveCheckRepair(
  check: CheckResult,
  context: PluginRepairContext & { staleCheckIds: Set<string> }
): CheckResultRepair {
  if (context.staleCheckIds.has(check.id)) {
    return {
      repairable: true,
      action: HealthCheckRepairAction.ClearBinaryOverride,
    };
  }

  if (check.id.startsWith(PLUGIN_CHECK_ID_PREFIX)) {
    return resolvePluginRepair(check, context);
  }

  if (check.id === "worktree-dir") {
    return { repairable: false, reason: NOT_REPAIRABLE_REASONS.worktreeDir };
  }

  if (check.id === GH_AUTH_CHECK_ID) {
    return { repairable: false, reason: NOT_REPAIRABLE_REASONS.ghAuth };
  }

  const isBinaryCheck = BINARY_CHECK_OVERRIDES.some(
    (entry) => entry.checkId === check.id
  );
  return {
    repairable: false,
    reason: isBinaryCheck
      ? NOT_REPAIRABLE_REASONS.binaryMissing
      : NOT_REPAIRABLE_REASONS.generic,
  };
}

function resolvePluginRepair(
  check: CheckResult,
  context: PluginRepairContext
): CheckResultRepair {
  const notInstalledReason = getPluginNotEnableableReason(check);
  if (notInstalledReason) {
    return { repairable: false, reason: notInstalledReason };
  }

  // `claude plugin enable` cannot succeed while the Claude CLI itself is
  // unresolvable. Whether that is worth offering depends entirely on whether
  // the root row is itself repairable (ISS-5389 review).
  if (context.claudeCliFailed) {
    // Repair clears the stale override FIRST, inside the same sweep that
    // re-derives this row, so the enable really can land in one press.
    if (context.claudeCliRepairable) {
      return {
        repairable: true,
        action: HealthCheckRepairAction.EnablePlugins,
        blockedByCheckId: CLAUDE_CLI_CHECK_ID,
      };
    }
    // Nothing here can fix the Claude CLI, so offering Repair would only ever
    // produce a skipped step. Say what has to happen instead.
    return {
      repairable: false,
      reason: NOT_REPAIRABLE_REASONS.pluginBlockedByClaudeCli,
      blockedByCheckId: CLAUDE_CLI_CHECK_ID,
    };
  }

  return {
    repairable: true,
    action: HealthCheckRepairAction.EnablePlugins,
  };
}

/**
 * The reason this plugin row is beyond `claude plugin enable`, or `undefined`
 * when the enable runner would genuinely act on it.
 *
 * `check.error` is a DISPLAY string, and a failed enable attempt overwrites it
 * with "Automatic enable failed" / "Enable timed out" before this module ever
 * sees the row — `applyPluginEnableChecks` runs before `annotateRepairability`
 * within a single auto-remediating sweep. Classifying off that string called a
 * still-installed plugin "not installed" and took away the retry control
 * (ISS-5389 review). `enableAttempted` is only ever set on rows the runner
 * selected as installed-but-disabled, so it survives the rewrite and is the
 * stable proof that the plugin IS installed.
 */
function getPluginNotEnableableReason(check: CheckResult): string | undefined {
  // Installed, but its enabled state could not be read. This is checked BEFORE
  // `enableAttempted`, because since the ISS-5810 review a row can carry both:
  // the enable ran, and then the verification read failed. Offering Repair
  // there would re-run `claude plugin enable` against a plugin that may already
  // be enabled — the exact command that fails by design, and the loop this work
  // exists to break.
  //
  // ISS-5810 split that one string into three, by WHY the read failed. All
  // three describe the SAME repair posture, so all three must land here: if a
  // new one fell through it would be classified "not installed" and Repair
  // would tell the user to install a plugin that is already there — exactly the
  // ISS-5389 regression this branch exists to prevent.
  if (PLUGIN_STATE_UNREADABLE_ERRORS.has(check.error ?? "")) {
    return NOT_REPAIRABLE_REASONS.pluginStateUnverified;
  }
  if (check.enableAttempted === true) {
    return;
  }
  // A row the Claude CLI blocked had its `error` REWRITTEN to the blocked
  // message by `applyClaudeCliBlockedChecks`, which runs before this module in
  // the same sweep. Classifying such a row off that string fell through to
  // "not installed" and told the user to install a plugin that is very likely
  // already there — and made `resolvePluginRepair`'s blocked branch, the one
  // that actually describes this situation, unreachable (ISS-5389 review).
  // `blockedBy` / `severity` are the structured facts the rewrite SETS rather
  // than clobbers, so classify off those instead.
  if (
    check.severity === CheckSeverity.Blocked ||
    check.blockedBy === CLAUDE_CLI_CHECK_ID
  ) {
    return;
  }
  if (check.error === PLUGIN_DISABLED_ERROR) {
    return;
  }
  return NOT_REPAIRABLE_REASONS.pluginNotInstalled;
}

type PluginRepairContext = {
  claudeCliFailed: boolean;
  claudeCliRepairable: boolean;
};
