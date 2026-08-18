"use client";

import type {
  CheckResult,
  HealthCheckRepairResponse,
  HealthCheckRepairStep,
  HealthCheckResponse,
} from "@repo/api/src/types/compute-target";
import { SYSTEM_CHECK_REPAIR_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { getRenderableHealthChecks } from "@/lib/engineer/queries/health-check";
import {
  getRepairableChecks,
  isRepairSupported,
  repairHealthCheck,
} from "@/lib/engineer/queries/health-check-repair";

/**
 * Wires the System Check Repair control to the gateway (ISS-5389).
 *
 * Owns three things the surfaces should not each re-derive: whether Repair is
 * offered at all (flag on, gateway new enough, at least one repairable row),
 * the single-flight guard that keeps a double press from double-running, and
 * handing the automatic re-check result back to the caller so the panel updates
 * in place instead of asking the user to press Re-check.
 */

export type UseSystemCheckRepairInput = {
  /**
   * The RENDERABLE checks — what `SystemCheckResults` paints, i.e. the gateway
   * rows PLUS the two `<provider>-mcp` rows the web synthesizes. Handing the raw
   * `response.checks` instead hides every MCP row from `getRepairableChecks`, so
   * a target whose only fault is a missing MCP server offers no control at all
   * (ISS-5435).
   */
  checks: CheckResult[] | undefined;
  expectedMcpUrl: string | null;
  relayTargetId?: string | null;
  latestVersion?: string | null;
  /**
   * False for a target somebody else owns, or any other surface-level reason
   * Repair must not be offered. The relay rejects a shared target too — this is
   * the UX half, not the boundary.
   */
  isEligible?: boolean;
  /** Receives the health check the gateway re-ran immediately after repairing. */
  onRepaired?: (result: HealthCheckResponse) => void;
};

export type UseSystemCheckRepairResult = {
  /** Whether to render the control at all. */
  isOffered: boolean;
  isSupported: boolean;
  repairableCount: number;
  /**
   * How many of those repairable rows are REQUIRED. Separate from
   * `repairableCount` because "Repair can do something" and "Repair can unblock
   * the user" are different questions: an optional row (a `<provider>-mcp` row,
   * say) makes the control worth offering, but it must not let a surface treat
   * the user's blocking failure as handled — the pre-loop dialog hides its Run
   * on Cloud escape route on exactly that distinction (ISS-5435 review).
   */
  repairableRequiredCount: number;
  steps: HealthCheckRepairStep[] | undefined;
  isRepairing: boolean;
  errorMessage: string | null;
  joinedInFlight: boolean;
  repair: () => void;
};

export function useSystemCheckRepair({
  checks,
  expectedMcpUrl,
  relayTargetId = null,
  latestVersion = null,
  isEligible = true,
  onRepaired,
}: UseSystemCheckRepairInput): UseSystemCheckRepairResult {
  const flagEnabled = useFeatureFlagEnabled(
    SYSTEM_CHECK_REPAIR_FEATURE_FLAG_KEY
  );
  const [feedback, setFeedback] = useState<RepairFeedback | null>(null);

  const mutation = useMutation<HealthCheckRepairResponse>({
    mutationFn: () =>
      repairHealthCheck({ expectedMcpUrl, relayTargetId, latestVersion }),
    // Repair surfaces its own failure inline, naming the step and the reason.
    // A duplicate global toast would say less, louder.
    meta: { suppressDefaultErrorToast: true },
    onSuccess: (data) => {
      // Pin the feedback to BOTH the checks it started from and the re-checked
      // ones the surface is about to adopt, so it survives that handover.
      setFeedback({
        describesBefore: getChecksIdentity(checks),
        // The RENDERABLE form of the re-check, so this identity is computed in
        // the same row space as `checks` above. Using `data.result.checks` here
        // compares gateway rows against renderable ones, which can never match
        // once an MCP row is on screen — and a narration that never matches is
        // silently dropped, the ISS-5389 failure in a new disguise.
        describesAfter: getChecksIdentity(
          getRenderableHealthChecks(data.result, expectedMcpUrl)
        ),
        steps: data.steps,
        joinedInFlight: data.joinedInFlight === true,
        errorMessage: null,
      });
      onRepaired?.(data.result);
    },
    onError: (error: unknown) => {
      const identity = getChecksIdentity(checks);
      setFeedback({
        describesBefore: identity,
        describesAfter: identity,
        steps: undefined,
        joinedInFlight: false,
        errorMessage: error instanceof Error ? error.message : "Repair failed.",
      });
    },
  });

  // A plain Re-check replaces the rows below the panel. Dropping the feedback
  // when it no longer describes the checks on screen is derived rather than
  // imperative: nothing has to remember to call a dismiss, and the panel can
  // never narrate a state that has already been replaced.
  const checksIdentity = getChecksIdentity(checks);
  const activeFeedback =
    feedback &&
    (feedback.describesBefore === checksIdentity ||
      feedback.describesAfter === checksIdentity)
      ? feedback
      : null;

  const isSupported = isRepairSupported(checks);
  const repairableChecks = getRepairableChecks(checks);
  const repairableCount = repairableChecks.length;
  const repairableRequiredCount = repairableChecks.filter(
    (check) => check.required
  ).length;
  const isRepairing = mutation.isPending;

  const repair = useCallback(() => {
    // Second press while one is in flight is a no-op here; the gateway ALSO
    // joins its own in-flight run, so a stale client cannot double-run either.
    if (mutation.isPending) {
      return;
    }
    mutation.mutate();
  }, [mutation]);

  return {
    isOffered: Boolean(flagEnabled && isEligible),
    isSupported,
    repairableCount,
    repairableRequiredCount,
    steps: activeFeedback?.steps,
    isRepairing,
    errorMessage: activeFeedback?.errorMessage ?? null,
    joinedInFlight: activeFeedback?.joinedInFlight ?? false,
    repair,
  };
}

/**
 * A stable identity for the check rows currently on screen.
 *
 * Deliberately CONTENT, not reference. Both surfaces hand the repair's own
 * re-check to React Query via `setQueryData`, and React Query applies
 * structural sharing on write (`replaceEqualDeep` returns the previous
 * reference or a fresh copy — never the array it was handed). So the array read
 * back through `useQuery` is never reference-equal to the one the mutation
 * returned, and an `===` comparison here silently retired the narration of
 * every successful repair on both surfaces (ISS-5389 review). What the panel
 * describes is the content of those rows, so content is what identifies them.
 */
function getChecksIdentity(checks: CheckResult[] | undefined): string | null {
  if (!checks) {
    return null;
  }
  // JSON rather than a delimiter join: an id or error containing the
  // separator could otherwise let two different row sets share one identity.
  return JSON.stringify(
    checks.map((check) => [check.id, check.passed, check.error ?? null])
  );
}

/**
 * The last repair's narration, tagged with the identity of the `checks` it can
 * legitimately describe. Anything else on screen retires it.
 */
type RepairFeedback = {
  /** Identity of the checks on screen when the repair ran. */
  describesBefore: string | null;
  /** Identity of the re-checked rows the repair produced, which the surface adopts. */
  describesAfter: string | null;
  steps: HealthCheckRepairStep[] | undefined;
  joinedInFlight: boolean;
  errorMessage: string | null;
};
