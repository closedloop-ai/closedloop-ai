import type {
  CheckResult as SharedCheckResult,
  CheckResultDebug as SharedCheckResultDebug,
} from "@closedloop-ai/loops-api/compute-target";
import { CODEX_CLI_CHECK_ID as SHARED_CODEX_CLI_CHECK_ID } from "@closedloop-ai/loops-api/compute-target";

/**
 * The published `CheckResult` contract as the gateway emits it: identical to
 * the wire type except that `debug` carries the desktop-only `nonExecutableAt`
 * diagnostic and narrows `platform` to `NodeJS.Platform` for telemetry.
 *
 * Everything else — including the ISS-5369 `severity` / `blockedBy` fields —
 * comes from the shared contract, so the gateway and its consumers cannot
 * drift apart.
 */
export type GatewayCheckResult = Omit<SharedCheckResult, "debug"> & {
  debug?: Omit<SharedCheckResultDebug, "platform"> & {
    platform?: NodeJS.Platform;
    /** Paths that exist but are not executable (drives EACCES diagnostics). */
    nonExecutableAt?: string[];
  };
};

/**
 * Wire identity and display strings for the Closedloop plugin rows.
 *
 * These are a contract between the module that PRODUCES a plugin row
 * (`health-check.ts`) and the modules that CLASSIFY one by reading it back
 * (`health-check-plugin-enable.ts`, `health-check-repairability.ts`). They live
 * here — the one module in this group that imports no sibling — so producer and
 * consumer resolve the same symbol and cannot drift apart by string value
 * (ISS-5389 review). `CLAUDE_CLI_CHECK_ID` is the same kind of contract and is
 * owned by `health-check-blocked.ts`; import it from there.
 */
export const PLUGIN_CHECK_ID_PREFIX = "plugin-";

/** The check id `health-check.ts` mints for one Closedloop plugin folder. */
export function pluginCheckId(folder: string): string {
  return `${PLUGIN_CHECK_ID_PREFIX}${folder}`;
}

/** `error` on a plugin row that is installed at user scope but switched off. */
export const PLUGIN_DISABLED_ERROR = "Disabled";

/**
 * `error` on a plugin row whose enabled state could not be read at all, because
 * `claude plugin list` RAN and parsed but reported no user-scoped enabled state
 * for it.
 *
 * Since ISS-5810 this string means only that. The two ways the read itself can
 * fail carry their own strings below, because they have different remedies and
 * collapsing them into this one produced a remediation
 * (`claude plugin enable …`) that FAILS whenever the plugin is already enabled.
 */
export const PLUGIN_STATE_UNVERIFIED_ERROR = "Could not verify enabled state";

/** `error` when `claude plugin list` could not be RUN at all (ISS-5810). */
export const PLUGIN_LIST_COMMAND_FAILED_ERROR =
  "Could not run `claude plugin list`";

/**
 * `error` when `claude plugin list` ran but its output could not be
 * interpreted — an unknown or future CLI output shape (ISS-5810). The Claude
 * CLI ships on its own cadence, so this must degrade to a STATED unknown rather
 * than crash or silently pass a plugin that may actually be disabled.
 */
export const PLUGIN_LIST_UNREADABLE_ERROR =
  "Could not interpret `claude plugin list` output";

/**
 * The Codex CLI row's check id — the Codex peer of `CLAUDE_CLI_CHECK_ID`, and
 * the root the Codex MCP row cascades from (ISS-5435). Same kind of contract as
 * the plugin strings above: producer (`health-check.ts`) and the modules that
 * classify a row by reading it back must resolve one symbol, not two copies of
 * a literal. Since ISS-5687 that symbol lives in the shared `@closedloop-ai/loops-api`
 * contract, because cloud code derives harness availability from this row and
 * cannot import a desktop module; this stays as the desktop import path.
 */
export const CODEX_CLI_CHECK_ID = SHARED_CODEX_CLI_CHECK_ID;

/** The MCP check id the web panel synthesizes for `provider`. */
export function mcpCheckId(provider: "claude" | "codex"): string {
  return `${provider}-mcp`;
}

/**
 * The Closedloop plugin marketplace name, as `claude plugin marketplace` knows
 * it. A contract between the sweep and the manifest reader, so it lives with
 * the other wire identities rather than being copied into both.
 */
export const CLOSEDLOOP_MARKETPLACE_NAME = "closedloop-ai";
