"use client";

import { OnboardingCtaId } from "@repo/api/src/types/onboarding-analytics";
import {
  listApplicableOnboardingSteps,
  listPendingOnboardingSteps,
} from "@repo/api/src/types/onboarding-completion";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  KnownFlag,
  type OnboardingContext,
  type OnboardingHost,
  OnboardingPhase,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { useMemo, useState } from "react";
import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import {
  useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition,
} from "../hooks/use-guided-onboarding";
import { useOnboardingCtaAnalytics } from "../hooks/use-onboarding-analytics";
import type { GuidedOnboardingRun } from "../lib/guided-onboarding-run";
import { organizationActiveFlag } from "../lib/onboarding-transitions";
import {
  GETTING_STARTED_CARD_CLASS_NAME,
  GETTING_STARTED_CARD_LABEL,
  GettingStartedCardShell,
  GettingStartedStepAction,
  listActionableOnboardingSteps,
} from "./getting-started-card-shell";

export type GuidedGettingStartedCardProps = {
  host: OnboardingHost;
  analysisStarted: boolean;
  className?: string;
  /**
   * Where this card's run comes from. Omitted, it is the server's — the path
   * every web reader and every ordinary signed-in desktop reader takes.
   *
   * Supplied, it REPLACES the server read and the server poster here exactly as
   * it does in {@link GuidedOnboardingDialogHost}, and it must be the SAME run
   * that host was given (ISS-11251). The two mounts sit in different trees, and
   * a card drawing the server run beside a modal drawing an override counted a
   * run the reader was not in and posted a transition that modal never watched —
   * so the press did nothing, silently, because a failed guided transition is
   * deliberately not toasted.
   */
  run?: GuidedOnboardingRun;
  syncConsentReadSettled?: boolean;
  syncConsentRecorded?: KnownFlag;
};

/** The shared v2 sidebar completion surface for Web and Desktop. */
export function GuidedGettingStartedCard({
  host,
  analysisStarted,
  className,
  run,
  syncConsentReadSettled = true,
  syncConsentRecorded = KnownFlag.Unknown,
}: GuidedGettingStartedCardProps) {
  // Narrowed for the same reason the host narrows it: a supplied run owns this
  // mount, so the server read is not merely unanswerable, it is not wanted.
  const snapshotQuery = useGuidedOnboardingSnapshot(host, {
    enabled: run === undefined,
  });
  const organizationActive = organizationActiveFlag(useOptionalAuthSnapshot());
  const { captureCtaClick } = useOnboardingCtaAnalytics();
  const transition = useGuidedOnboardingTransition({
    analysisStarted,
    experienceVariant: WorkspaceExperience.V2,
    host,
    syncConsentRecorded,
  });

  /**
   * In-flight latch for the RUN path, where `transition` is never called.
   *
   * `transition.isPending` only ever closes the gate on the server path, so with
   * a run supplied the control stayed enabled through its own post: a second
   * press posted `ResumePendingStep` again against the same revision, the server
   * answered 409, and the handoff run treats a determinate answer as the server
   * ruling on the position and releases its hold. Keyed to the snapshot it was
   * posted against rather than a bare boolean, so a source whose poster never
   * settles releases the gate the moment the run actually moves instead of
   * disabling the control for good.
   */
  const [postedAgainst, setPostedAgainst] =
    useState<GuidedOnboardingSnapshot | null>(null);
  const snapshot = run ? run.snapshot : (snapshotQuery.data ?? null);
  const projection = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    const state = restoreOnboardingState(snapshot.state, host).state;
    if (state.phase !== OnboardingPhase.Ready) {
      return null;
    }
    const context: OnboardingContext = {
      ...snapshot.context,
      analysisStarted,
      host,
      organizationActive,
      syncConsentRecorded,
    };
    const pendingSteps = listActionableOnboardingSteps(
      listPendingOnboardingSteps(context),
      syncConsentReadSettled
    );
    const applicableSteps = listActionableOnboardingSteps(
      listApplicableOnboardingSteps(context),
      syncConsentReadSettled
    );
    const step = pendingSteps[0] ?? null;
    if (step === null || applicableSteps.length === 0) {
      return null;
    }
    return {
      completed: applicableSteps.length - pendingSteps.length,
      snapshot,
      step,
      total: applicableSteps.length,
    };
  }, [
    analysisStarted,
    host,
    organizationActive,
    snapshot,
    syncConsentReadSettled,
    syncConsentRecorded,
  ]);

  if (run ? run.isLoading : snapshotQuery.isLoading) {
    return (
      <section
        aria-label={GETTING_STARTED_CARD_LABEL}
        className={cn(GETTING_STARTED_CARD_CLASS_NAME, className)}
      >
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-full" />
      </section>
    );
  }
  if (projection === null) {
    return null;
  }

  return (
    <GettingStartedCardShell
      action={
        <GettingStartedStepAction
          disabled={
            run ? postedAgainst === projection.snapshot : transition.isPending
          }
          onClick={() => {
            // PRD-736 decision #14: the getting-started widget's invite CTA is
            // click-instrumented; the OUTCOME stays on the checklist events.
            if (projection.step === PendingOnboardingStep.InviteTeam) {
              captureCtaClick({
                ctaId: OnboardingCtaId.GettingStartedInvite,
                step: OnboardingPhase.Ready,
              });
            }
            const event = {
              step: projection.step,
              type: OnboardingEvent.ResumePendingStep,
            } as const;
            if (run) {
              setPostedAgainst(projection.snapshot);
              run.postTransition(projection.snapshot, event, {
                onSettled: () => setPostedAgainst(null),
              });
              return;
            }
            transition.mutate({ event, snapshot: projection.snapshot });
          }}
          step={projection.step}
        />
      }
      className={className}
      completed={projection.completed}
      total={projection.total}
    />
  );
}
