/**
 * @file agent-dashboard-runtime-degradations.ts
 * @description ISS-8143: the composition-root degradations that answer for an
 * absent Agent Dashboard runtime or an absent transcript-sync lane.
 *
 * WHY THESE ARE FUNCTIONS AND NOT OBJECT LITERALS AT THE CALL SITE. Each of
 * these bindings carried a comment asserting its degradation — "empty when the
 * runtime isn't up yet", "a null service (lane disabled) yields an
 * `unavailable` result rather than a hard failure" — and not one was executable
 * by a node test: they were inline closures inside a function that needs the
 * whole Electron boot graph. A comment is not a test, and every one of these
 * fires on a REAL machine state (the runtime is genuinely null until the
 * collectors exist; the transcript lane is genuinely null on every
 * metadata-tier install), so the degraded answer is the common path, not an
 * edge.
 *
 * This is the ISS-6206 treatment, applied to the four the transcript-lane
 * status (ISS-7516) left behind: move the BINDING somewhere a node test can
 * execute it, and leave `(deps)` at the call site.
 *
 * THE MUTATION THAT MATTERS IS NOT "returns null". It is a builder that reads
 * its source ONCE, at boot, and returns the captured value from a thunk
 * thereafter — which type-checks, satisfies any test that only ever supplies an
 * absent runtime, and ships an install whose Settings panel reports "no
 * collectors" forever because the runtime happened to be null at construction.
 * `agent-dashboard-runtime-degradations.test.ts` flips the source between calls
 * on ONE built object to hold that shut.
 */

import type { TranscriptForceArchiveResult } from "../../shared/transcript-read-contract.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import {
  type OnboardingParseProgressReading,
  PARSE_PROGRESS_UNMEASURED,
} from "../onboarding/onboarding-parse-progress.js";
import type { TranscriptSyncService } from "../transcript-sync/transcript-sync-service.js";

/** The three runtime-info getters that degrade when the runtime is absent. */
export type AgentDashboardRuntimeProgressGetters = {
  getIngestProgress: () => ReturnType<
    AgentDashboardDesignSystemRuntime["getIngestProgress"]
  > | null;
  getFileAccessBlocks: () => ReturnType<
    AgentDashboardDesignSystemRuntime["getFileAccessBlocks"]
  >;
  getMaintenanceProgress: () => ReturnType<
    AgentDashboardDesignSystemRuntime["getMaintenanceProgress"]
  > | null;
};

/**
 * Bind the three progress getters to a runtime that may not exist yet.
 *
 * `getRuntime` is re-read on EVERY call, never captured: the Agent Dashboard
 * runtime is constructed after IPC registration and can be rebuilt afterwards,
 * so a getter bound to the boot-time value would report the startup state for
 * the life of the process.
 *
 * The degraded answers are deliberately asymmetric and each is the honest one
 * for its field: `null` for the two PROGRESS reports, because "no progress to
 * report" is genuinely unknown rather than zero, and `[]` for the file-access
 * blocks, because no collectors means no blocks were hit — a true empty
 * (FEA-3639).
 */
export function buildAgentDashboardRuntimeProgressGetters(
  getRuntime: () => AgentDashboardDesignSystemRuntime | null
): AgentDashboardRuntimeProgressGetters {
  return {
    getIngestProgress: () => getRuntime()?.getIngestProgress() ?? null,
    getFileAccessBlocks: () => getRuntime()?.getFileAccessBlocks() ?? [],
    getMaintenanceProgress: () =>
      getRuntime()?.getMaintenanceProgress() ?? null,
  };
}

/**
 * Bind the force-archive action to a transcript-sync lane that may not exist.
 *
 * Also re-read per call rather than captured, because a FEA-3907 privacy-tier
 * rebuild replaces the service: a captured reference would keep driving the
 * retired lane after a tier change.
 *
 * A null lane answers `{ kind: "unavailable" }` — a typed refusal the renderer
 * can render — rather than throwing, so the absence of an optional lane is
 * never a rejected invoke.
 */
export function buildTranscriptForceSyncOversized(
  getTranscriptSync: () => TranscriptSyncService | null
): (
  externalSessionId: string,
  fileKey: string
) => Promise<TranscriptForceArchiveResult> {
  return (externalSessionId, fileKey) =>
    getTranscriptSync()?.forceSyncOversized(externalSessionId, fileKey) ??
    Promise.resolve({ kind: "unavailable" as const });
}

/**
 * Bind the onboarding estimate's byte-movement producer to a runtime that may
 * not exist yet (ISS-8346).
 *
 * The same per-call re-read as the getters above, and here the captured-at-boot
 * mutation is worse than a stale number: the onboarding source is constructed
 * during registration, BEFORE the runtime exists, so a builder that read its
 * source once would hand the estimate a permanent refusal and the screen would
 * never state a minute count on any machine.
 *
 * The degraded answer is `PARSE_PROGRESS_UNMEASURED` — no remainder, which the
 * estimate withdraws on — rather than a zero, which it would read as a fully
 * parsed corpus and then hold behind its high-water mark.
 */
export function buildOnboardingParseProgressReader(
  getRuntime: () => AgentDashboardDesignSystemRuntime | null
): (harnesses: readonly string[]) => OnboardingParseProgressReading {
  return (harnesses) =>
    getRuntime()?.readParseProgress(harnesses) ?? PARSE_PROGRESS_UNMEASURED;
}
