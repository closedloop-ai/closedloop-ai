import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods";
import { useOnboardingFunnelAnalytics } from "@repo/app/onboarding/hooks/use-onboarding-analytics";
import { createAccountEstablishedEvent } from "@repo/app/onboarding/lib/guided-onboarding-events";
import type { GuidedOnboardingRun } from "@repo/app/onboarding/lib/guided-onboarding-run";
import { transitionOnboarding } from "@repo/app/onboarding/lib/onboarding-transitions";
import { useCallback, useMemo, useState } from "react";
import {
  dashboardOnboardedStorageKey,
  readRawFlag,
} from "../dashboard/dashboard-storage-keys";
import {
  DashboardTourRecord,
  readDashboardTourRecord,
} from "../dashboard/tour/guest-tour-record";
import {
  type GuestGuidedOnboardingRecord,
  readGuestGuidedOnboardingRecord,
  writeGuestGuidedOnboardingRecord,
} from "./guest-guided-onboarding-record";
import {
  GUEST_ONBOARDING_CONTEXT,
  guestServerOnboardingContext,
} from "./guest-onboarding-context";
import { settleGuestRunToReady } from "./settle-guest-run-to-ready";

/**
 * The guided onboarding run for a SIGNED-OUT desktop guest, driven entirely by
 * local state.
 *
 * ISS-10195 retired the `workspace-experience-v2` gate so that "even guest users
 * on desktop get onboarding experience v2". Removing the gate was necessary and
 * not sufficient: the guided modal is opened by a SERVER-owned run, and
 * `useGuidedOnboardingSnapshot` gates its query on `userId !== null`, so a guest
 * never fires the request and the host's `open` stays false for want of a
 * snapshot. The gate was the first of two blockers; this is the second.
 *
 * ISS-9728 settled the shape for exactly this situation on the Dashboard tour,
 * whose variant was unreachable for the same `withAnyAuth` reason, with the
 * operator ruling that for the unauthenticated mode "its statefulness should
 * govern guest UX; not PH since we don't have it yet in that mode". The tour's
 * answer was `guest-tour-record.ts`, "the only record governing a guest's tour
 * — no server". This is that answer applied to the modal.
 *
 * It is the SAME machine, not a parallel flow: `transitionOnboarding` is pure
 * and already runs client-side on the server path (the mutation dispatches it
 * before it POSTs), so a guest run differs only in where the accepted state is
 * written. Every phase, guard and screen downstream is shared.
 *
 * Returns `undefined` when this reader is not a settled guest, which is what
 * hands the mount back to the server run.
 *
 * THE MOMENT A GUEST SIGNS IN IS NOT THAT HANDBACK, and this hook is only half
 * of it. `active` goes false as soon as the account settles, so returning
 * `undefined` here would drop the position this guest reached — the server has
 * no attempt (a guest never posts one), so it answers a first run at
 * {@link OnboardingPhase.Welcome} and a brand-new account repeats Welcome and
 * Session Discovery. The record survives in storage; what has to survive with
 * it is the mount, until the run has been handed to a server attempt. That is
 * `useGuestGuidedOnboardingHandoff`, and the desktop host composes the two.
 */
export function useGuestGuidedOnboardingRun({
  accountMethod,
  active,
  analysisStarted,
  onDashboardAvailable,
  syncConsentRecorded,
  organizationAwaiting,
  pendingUserId,
}: {
  /** The account method whose browser signup reached organization bootstrap. */
  accountMethod?: AuthMethod | null;
  /**
   * Whether this reader is a settled signed-out guest. The caller supplies it
   * from `canOfferAccount`, the canonical predicate — a sign-in already in
   * flight and a lapsed session are NOT guests, and each would be wrong to hand
   * a fresh first-run to.
   */
  active: boolean;
  /** Desktop-local analyzer state; gates Continue out of Session Discovery. */
  analysisStarted: boolean;
  onDashboardAvailable: () => void;
  /** Desktop-local consent record. Unknown never completes setup. */
  syncConsentRecorded: KnownFlag;
  /** Keeps this local run authoritative until an org-bound session exists. */
  organizationAwaiting?: boolean;
  /** Provider identity proving the bootstrap account exists before org creation. */
  pendingUserId?: string;
}): GuidedOnboardingRun | undefined {
  const [stored, setStored] = useState<GuestGuidedOnboardingRecord | null>(
    readGuestGuidedOnboardingRecord
  );
  // ISS-10195: the Welcome takeover is for a NEW reader, and this install's
  // first-launch latch is what says whether it is one. Without this the
  // takeover armed for every signed-out reader on every launch — including a
  // returning install that had already answered first run — which put a
  // blocking modal over the shell for readers the run was never meant to reach.
  // A returning guest with no record is handed the non-blocking Dashboard
  // instead, so the run still exists to resume a pending step from (ISS-11480).
  //
  // The same latch the first-launch dashboard reads, deliberately: "what has
  // this install already been shown" is one question, and a second definition
  // of first run is how the two drift apart.
  //
  // `readRawFlag`, not `readFlag`, because the two answers `readFlag` collapses
  // are opposite verdicts here. `null` is the key ABSENT from a usable store —
  // a real first run. `undefined` is a store that could not answer at all, and
  // a takeover mounted on a measurement nobody took is exactly the lie this
  // repo forbids: fail closed and leave the shell alone — no run at all, first
  // or returning, since nothing the run accepts could be written back either.
  const [latch] = useState(() => readRawFlag(dashboardOnboardedStorageKey));
  const firstRun = latch === null;
  // Read per render and again at each transition, not once per mount: a
  // returning guest's run sits on the non-blocking Dashboard, where the tour can
  // run and write its record mid-run.
  const tourCompleted = readGuestTourCompleted();
  // Synthesized, never persisted: only an accepted transition writes the record.
  const record =
    stored ?? (firstRun ? FIRST_RUN_RECORD : RETURNING_GUEST_RECORD);

  const snapshot = useMemo<GuidedOnboardingSnapshot>(
    () => ({
      // No server row exists for a guest, and saying so is the honest answer
      // rather than minting an id the API would not recognise.
      attemptId: null,
      context: serverContextForGuestRun(
        tourCompleted,
        accountMethod,
        organizationAwaiting === true,
        pendingUserId
      ),
      experienceVariant: WorkspaceExperience.V2,
      restoreOutcome: stored
        ? OnboardingRestoreOutcome.Restored
        : OnboardingRestoreOutcome.Absent,
      revision: record.revision,
      state: record.state,
    }),
    [
      accountMethod,
      organizationAwaiting,
      pendingUserId,
      record,
      stored,
      tourCompleted,
    ]
  );

  // ISS-10502 (PRD-736 D4): a guest transition never reaches the server
  // poster's capture site, so this run captures at its own acceptance — the
  // same one-emit-site contract, applied to the local machine dispatch.
  const { captureTransition } = useOnboardingFunnelAnalytics(
    OnboardingHost.Desktop
  );

  const postTransition = useCallback<GuidedOnboardingRun["postTransition"]>(
    (current, event, callbacks) => {
      const context = {
        ...current.context,
        analysisStarted,
        host: OnboardingHost.Desktop,
        organizationActive:
          organizationAwaiting === true
            ? KnownFlag.No
            : GUEST_ONBOARDING_CONTEXT.organizationActive,
        syncConsentRecorded,
        tourCompleted: readGuestTourCompleted(),
      };
      const applied = applyGuestEvent(
        restoreOnboardingState(current.state, OnboardingHost.Desktop).state,
        event,
        context
      );
      if (applied === null) {
        // A rejected event leaves the run untouched, the same contract the
        // server path keeps by never posting one.
        callbacks?.onSettled?.();
        return;
      }
      if (!isAmbientDashboardEntry(current, event)) {
        captureTransition({
          context,
          event,
          nextState: applied.state,
          outcome: callbacks?.analytics,
          priorState: applied.priorState,
        });
      }
      const next: GuestGuidedOnboardingRecord = {
        revision: current.revision + 1,
        state: serializeOnboardingState(applied.state),
      };
      writeGuestGuidedOnboardingRecord(next);
      setStored(next);
      callbacks?.onSettled?.();
      if (applied.state.phase === OnboardingPhase.DashboardAvailable) {
        onDashboardAvailable();
      }
    },
    [
      analysisStarted,
      captureTransition,
      onDashboardAvailable,
      organizationAwaiting,
      syncConsentRecorded,
    ]
  );

  if (!active || latch === undefined) {
    return;
  }
  // Synchronous: the record is read from local storage, so there is no loading
  // frame to report and inventing one would flicker the dialog on every mount.
  return {
    isLoading: false,
    postTransition,
    snapshot,
    ...(organizationAwaiting && pendingUserId
      ? { awaitingOrganization: true }
      : {}),
  };
}

function serverContextForGuestRun(
  tourCompleted: boolean,
  accountMethod: AuthMethod | null | undefined,
  organizationAwaiting: boolean,
  pendingUserId: string | undefined
) {
  const guestContext = guestServerOnboardingContext(tourCompleted);
  if (!(organizationAwaiting && pendingUserId)) {
    return guestContext;
  }
  return {
    ...guestContext,
    accountProvider: accountMethod
      ? createAccountEstablishedEvent(accountMethod).provider
      : null,
    accountStatus: AccountStatus.Established,
  };
}

/** The run a guest who has never started one is handed. */
const FIRST_RUN_RECORD: GuestGuidedOnboardingRecord = {
  revision: 0,
  state: serializeOnboardingState(createInitialOnboardingState()),
};

/**
 * The run a returning guest with no record is handed (ISS-11480): the
 * non-blocking Dashboard, a reachable root (`ONBOARDING_HISTORY_ROOTS`), so the
 * modal stays closed and a pending step can still be resumed from it.
 */
const RETURNING_GUEST_RECORD: GuestGuidedOnboardingRecord = {
  revision: 0,
  state: serializeOnboardingState({
    ...createInitialOnboardingState(),
    phase: OnboardingPhase.DashboardAvailable,
  }),
};

/**
 * `event` applied to the guest run, or `null` when the run cannot take it.
 * `priorState` is the state the event was applied to: only
 * `resume_pending_step` is settled to Ready first (`settleGuestRunToReady`);
 * every other event applies to the run as it stands.
 */
function applyGuestEvent(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): {
  priorState: OnboardingMachineState;
  state: OnboardingMachineState;
} | null {
  const settled =
    event.type === OnboardingEvent.ResumePendingStep
      ? settleGuestRunToReady(state, context)
      : { state, status: "moved" as const };
  if (settled.status !== "moved") {
    return null;
  }
  const result = transitionOnboarding(settled.state, event, context);
  return result.status === "moved"
    ? { priorState: settled.state, state: result.state }
    : null;
}

function readGuestTourCompleted(): boolean {
  return readDashboardTourRecord() === DashboardTourRecord.Dismissed;
}

/**
 * The host posts `dashboard_entered` by itself whenever the Dashboard route is
 * open. Against the synthesized returning-guest record (`Absent`, parked on the
 * Dashboard) that edge moves the run but is not a step this reader took: they
 * finished onboarding before the run existed, so it is not a funnel event
 * (PR #8157 review). A first-run `Absent` record sits on Welcome, where the
 * machine refuses the edge outright.
 */
function isAmbientDashboardEntry(
  snapshot: GuidedOnboardingSnapshot,
  event: OnboardingEventInput
): boolean {
  return (
    event.type === OnboardingEvent.DashboardEntered &&
    snapshot.restoreOutcome === OnboardingRestoreOutcome.Absent
  );
}
