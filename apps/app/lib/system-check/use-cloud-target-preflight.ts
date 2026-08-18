"use client";

import type { ComputePreference } from "@repo/api/src/types/compute-target";
import {
  CLAUDE_API_KEY_INFO_PATH,
  claudeApiKeys,
} from "@repo/app/api-keys/hooks/use-claude-api-keys";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  ANTHROPIC_API_KEY_CARD_ANCHOR,
  SettingsTab,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import { useApiClient } from "@/hooks/use-api-client";
import { useOrgSlug } from "@/hooks/use-org-slug";
import {
  CLOUD_READINESS_UNKNOWN_REASON,
  CLOUD_TARGET_UNAVAILABLE_ACTION_LABEL,
  CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS,
  CloudTargetReadiness,
  CloudTargetUnavailableMessage,
  type CloudTargetUnavailableReason,
  evaluateCloudTargetReadiness,
  getCloudTargetBlockingReason,
  isCloudComputeSelection,
} from "./cloud-target-readiness";
import type {
  AttemptBranchCallbacks,
  CapturePreLoopEvent,
  ExecuteCallback,
} from "./pre-loop-attempt";
import {
  PreLoopAnalyticsEvent,
  type PreLoopExecutionContext,
  type PreLoopHealthCheckOutcome,
  type PreLoopMetadata,
} from "./pre-loop-health-check";

/**
 * The Cloud half of the pre-loop gate (ISS-5172), extracted from the provider
 * so the Cloud precondition owns its own module rather than adding a third
 * responsibility to an already over-size component.
 *
 * The Local branch health-checks a compute target; the Cloud branch has no
 * target to check, so it verifies the one precondition the server itself
 * enforces — that an Anthropic API key is resolvable for this user or org.
 */
export function useCloudTargetPreflight({
  capture,
  clearCheckingForAttempt,
  preferredComputeMode,
  validateCloudTarget,
}: {
  capture: CapturePreLoopEvent;
  clearCheckingForAttempt: (attemptId: string) => void;
  preferredComputeMode: ComputePreference | undefined;
  validateCloudTarget: boolean;
}): {
  finishSkippedNoLocalTarget: (
    args: AttemptBranchCallbacks & {
      attemptId: string;
      metadata: PreLoopMetadata;
      execute: ExecuteCallback;
      executionContext: PreLoopExecutionContext;
    }
  ) => Promise<PreLoopHealthCheckOutcome>;
} {
  const apiClient = useApiClient();
  const orgSlug = useOrgSlug();
  const navigation = useNavigation();

  // Fetched on demand from the Cloud branch of the gate only, so a Local-only
  // user never pays a key-presence lookup. Shares `claudeApiKeys.info()` with
  // the settings surface so setting a key there invalidates this too.
  const claudeApiKeyQuery = useQuery({
    queryKey: claudeApiKeys.info(),
    queryFn: () => apiClient.get<unknown>(CLAUDE_API_KEY_INFO_PATH),
    enabled: false,
  });
  const refetchClaudeApiKey = claudeApiKeyQuery.refetch;

  /**
   * Always refetches rather than trusting the cache. The provider is mounted
   * app-wide and this query is permanently `enabled: false`, so its entry is
   * never garbage-collected and never automatically revalidated — a cached
   * "no key" would otherwise freeze for the life of the session and keep
   * blocking after the user added a key in another tab.
   */
  const resolveCloudTargetReadiness =
    useCallback(async (): Promise<CloudTargetReadiness> => {
      const result = await refetchClaudeApiKey();
      if (result.error || result.data === undefined) {
        // A failed lookup is not evidence the launch would fail; proceed.
        return CloudTargetReadiness.Unknown;
      }
      return evaluateCloudTargetReadiness(result.data);
    }, [refetchClaudeApiKey]);

  /**
   * Resolves how the Cloud pre-flight should treat this attempt: the reason to
   * block on, or `null` to dispatch. Runs only for an attempt that genuinely
   * selected Cloud — the no-local-target branch is also reached by a Local user
   * whose desktop app is offline, and blaming an Anthropic key there would be
   * the same wrong-blame bug this gate exists to remove.
   */
  const resolveCloudBlockingReason = useCallback(
    async ({
      attemptId,
      metadata,
    }: {
      attemptId: string;
      metadata: PreLoopMetadata;
    }): Promise<CloudTargetUnavailableReason | null> => {
      const isCloud = isCloudComputeSelection({
        requestedComputeTargetId: metadata.computeTargetId,
        preferredComputeMode,
      });
      if (!(validateCloudTarget && isCloud)) {
        return null;
      }

      const readiness = await resolveCloudTargetReadiness();
      if (readiness === CloudTargetReadiness.Unknown) {
        // Proceed, but make the degrade observable — otherwise a systemic
        // readiness failure silently disables the gate for everyone.
        capture(PreLoopAnalyticsEvent.SystemCheckUnavailable, {
          attemptId,
          metadata,
          reason: CLOUD_READINESS_UNKNOWN_REASON,
        });
        return null;
      }
      return getCloudTargetBlockingReason(readiness);
    },
    [
      capture,
      preferredComputeMode,
      resolveCloudTargetReadiness,
      validateCloudTarget,
    ]
  );

  /**
   * Renders the Cloud block as an **error**, not a warning, and the split is
   * the point: in this gate `toast.warning` means "we could not verify"
   * (`System check unavailable`, the `Unknown` degrade that still dispatches),
   * while `toast.error` means "we verified, and it is wrong". A missing
   * Anthropic key is the second kind — the command is already stopped — so it
   * lines up with the gate's other definite block,
   * `ComputePreferenceRequiredMessage` in `pre-loop-attempt.ts`, which is also
   * `toast.error`. Short title plus description, as every blocked-gate toast
   * here is.
   *
   * Carries an action that deep-links straight to the `Anthropic API Key` card,
   * the same treatment `use-document-run-loop` gives its "View run" toast: the
   * fix is one click rather than a hunt through Settings tabs.
   *
   * The link names the card, not just the tab. Integrations stacks six cards,
   * so selecting the tab alone would land the user at the top of a list and
   * make the button promise more than it delivered; the fragment scrolls the
   * `Anthropic API Key` card into view and moves focus to it.
   *
   * Sets an explicit `duration` rather than riding sonner's 4s default, which
   * is sized for an acknowledgement and not for two sentences plus a decision.
   */
  const warnCloudTargetUnavailable = useCallback(
    (reason: CloudTargetUnavailableReason): void => {
      const copy = CloudTargetUnavailableMessage[reason];
      toast.error(copy.title, {
        description: copy.description,
        duration: CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS,
        action: {
          label: CLOUD_TARGET_UNAVAILABLE_ACTION_LABEL,
          onClick: () => {
            navigation.navigate(
              `/${orgSlug}/settings?tab=${SettingsTab.Integrations}#${ANTHROPIC_API_KEY_CARD_ANCHOR}`
            );
          },
        },
      });
    },
    [navigation, orgSlug]
  );

  /**
   * Finishes the no-local-target branch. When the attempt actually selected
   * Cloud it first validates that the Cloud target is usable, so choosing Cloud
   * is a checked path rather than an unchecked bypass of the local gate. Gated
   * by {@link CLOUD_TARGET_VALIDATION_FEATURE_FLAG_KEY}; with the flag off it
   * dispatches exactly as it always has.
   */
  const finishSkippedNoLocalTarget = useCallback(
    async ({
      attemptId,
      metadata,
      execute,
      executionContext,
      wasCancelled,
      clearActiveAttempt,
    }: AttemptBranchCallbacks & {
      attemptId: string;
      metadata: PreLoopMetadata;
      execute: ExecuteCallback;
      executionContext: PreLoopExecutionContext;
    }): Promise<PreLoopHealthCheckOutcome> => {
      const cloudBlockingReason = await resolveCloudBlockingReason({
        attemptId,
        metadata,
      });

      clearCheckingForAttempt(attemptId);
      if (wasCancelled()) {
        clearActiveAttempt();
        return { status: "cancelled", attemptId };
      }
      clearActiveAttempt();

      if (cloudBlockingReason) {
        capture(PreLoopAnalyticsEvent.SystemCheckUnavailable, {
          attemptId,
          metadata,
          reason: cloudBlockingReason,
        });
        warnCloudTargetUnavailable(cloudBlockingReason);
        return { status: "blocked_unavailable", attemptId };
      }

      execute(executionContext);
      return { status: "skipped_no_local_target", attemptId };
    },
    [
      capture,
      clearCheckingForAttempt,
      resolveCloudBlockingReason,
      warnCloudTargetUnavailable,
    ]
  );

  return { finishSkippedNoLocalTarget };
}
