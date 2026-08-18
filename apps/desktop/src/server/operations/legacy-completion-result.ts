/**
 * `result` payload for the LEGACY loop completion path — the route-level
 * behaviour used when no JobStore is present. JobStore-backed loops build their
 * completion payload in `loop-finalizer.ts` instead.
 *
 * Extracted from `symphony-loop.ts` (ISS-5872) so the completion branch there
 * reads as one decision — error or completion — rather than forty lines of
 * payload assembly with that decision buried at the end.
 */

import { missingRequiredArtifactsMessage } from "@closedloop-ai/loops-api/bundles";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { LoopEventType } from "@closedloop-ai/loops-api/events";
import {
  getPrimaryRepoResult,
  parseExecutionResultFile,
} from "@closedloop-ai/loops-api/execution-result";
import type { ExecuteFinalizationResult } from "./symphony-loop.js";

/** Token totals the legacy terminal event reports, as parseTokenUsage yields them. */
export type LegacyTokensUsed = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  turns: number;
  models: string[];
};

function applyExecutionResultFields(
  result: Record<string, unknown>,
  executionResult: unknown
): void {
  const parsed = parseExecutionResultFile(executionResult, "");
  const lookupName = parsed.ok ? (parsed.results[0]?.fullName ?? "") : "";
  const primary = parsed.ok
    ? getPrimaryRepoResult(parsed.results, lookupName)
    : null;
  if (primary?.status === "success") {
    result.prUrl = primary.prUrl;
    result.prNumber = primary.prNumber;
    result.branchName = primary.branchName;
    result.has_changes = primary.hasChanges;
    return;
  }
  if (primary?.status === "skipped") {
    // A skipped repo had no changes to push; surface the standard no-changes
    // shape so consumers handle it uniformly.
    result.prUrl = null;
    result.prNumber = null;
    result.has_changes = false;
  }
}

export function buildLegacyCompletionResult(args: {
  command: string;
  exitCode: number | null;
  artifacts: Record<string, unknown>;
  executeFinalization: ExecuteFinalizationResult | null;
  worktreeDir: string | null;
  getCurrentBranch: (worktreeDir: string) => string | null;
  sessionId?: string;
}): Record<string, unknown> {
  const {
    command,
    exitCode,
    artifacts,
    executeFinalization,
    worktreeDir,
    getCurrentBranch,
    sessionId,
  } = args;
  const result: Record<string, unknown> = {
    exitCode,
    subtype: command.toLowerCase(),
  };
  if (command === LoopCommand.Execute && artifacts.executionResult) {
    applyExecutionResultFields(result, artifacts.executionResult);
  }
  if (command === LoopCommand.Execute && executeFinalization) {
    result.finalizationSource = "live-exit";
    result.executeFinalizationStatus = executeFinalization.status;
    result.executeFinalizationPath = executeFinalization.path;
    if (executeFinalization.reason) {
      result.executeFinalizationReason = executeFinalization.reason;
    }
  }
  if (worktreeDir && !result.branchName) {
    const branch = getCurrentBranch(worktreeDir);
    if (branch) {
      result.branchName = branch;
    }
  }
  if (sessionId) {
    result.sessionId = sessionId;
  }
  return result;
}

/**
 * Terminal LoopEvent for the legacy completion path.
 *
 * ISS-5872 — a bundle the command owed and did not produce terminalizes as an
 * error naming the missing files, never as a clean completion. On THIS path the
 * artifact upload has already run (it sits inside the same `!jobStore` guard),
 * so the operator keeps whatever the run did manage to write; the JobStore path
 * uploads its partials inside `finalizeLoopFromRuntime`.
 */
export function buildLegacyTerminalEvent(args: {
  command: string;
  loopId: string;
  result: Record<string, unknown>;
  missingRequired: readonly string[];
  tokensUsed: LegacyTokensUsed;
  tokensByModel?: unknown;
  elapsedMs?: number;
  sessionId?: string;
  warnings: readonly string[];
}): Record<string, unknown> {
  const {
    command,
    loopId,
    result,
    missingRequired,
    tokensUsed,
    tokensByModel,
    elapsedMs,
    sessionId,
    warnings,
  } = args;
  const warningsField = warnings.length > 0 ? { warnings: [...warnings] } : {};
  if (missingRequired.length > 0) {
    return {
      type: LoopEventType.Error,
      code: LoopErrorCode.MissingRequiredArtifacts,
      message: missingRequiredArtifactsMessage(command, missingRequired),
      loopId,
      elapsedMs,
      // The run burned real tokens before it stopped short. Omitting them here
      // would report a $0 run that never happened — the cloud's error path
      // carries usage for exactly this reason.
      tokenUsage: {
        inputTokens: tokensUsed.inputTokens,
        outputTokens: tokensUsed.outputTokens,
        cacheCreationInputTokens: tokensUsed.cacheCreationInputTokens,
        cacheReadInputTokens: tokensUsed.cacheReadInputTokens,
      },
      // Per-model attribution rides along for the same reason the totals do:
      // without it the cloud prices the whole run against a synthetic default
      // model, so an Opus or mixed-model run keeps the right counts and gets
      // the wrong cost. `LoopEventErrorSchema.tokensByModel` already accepts
      // it, and it stays OMITTED (never null) when there is nothing to report,
      // so an older cloud build sees exactly the payload it sees today.
      ...(hasTokensByModel(tokensByModel) ? { tokensByModel } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...warningsField,
    };
  }
  return {
    type: LoopEventType.Completed,
    result,
    tokensUsed: {
      input: tokensUsed.inputTokens,
      output: tokensUsed.outputTokens,
      cacheCreationInputTokens: tokensUsed.cacheCreationInputTokens,
      cacheReadInputTokens: tokensUsed.cacheReadInputTokens,
      turns: tokensUsed.turns,
      models: tokensUsed.models,
    },
    tokensByModel,
    loopId,
    ...warningsField,
  };
}

/**
 * Whether per-model token attribution is worth putting on the wire.
 *
 * An absent or empty map carries no information, and the optional cross-repo
 * field must stay omitted rather than serialized as an empty object, so older
 * cloud builds keep seeing the shape they see today.
 */
function hasTokensByModel(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}
