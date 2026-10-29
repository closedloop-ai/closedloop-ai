/**
 * The ISS-11249 resumed sync step, split out of `onboarding-transitions.test.ts`
 * when that file reached the 1,000-line ceiling.
 *
 * A seam by responsibility rather than by line count: these four cases are the
 * whole contract for RESUMING the sync election from the Ready checklist — that
 * it enters the phase that renders it, that it carries the organization flag
 * rather than gating on it, and that its exit re-roots the chain so a Desktop
 * build predating this change can still read the settled run.
 */

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  AccountStatus,
  KnownFlag,
  OnboardingPhase,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { transitionOnboarding } from "../onboarding-transitions";
import { context, move, stateAt } from "./onboarding-transitions-test-helpers";

describe("resuming the sync election from Ready", () => {
  /**
   * BEHAVIOR CHANGE, ISS-11249. This case previously asserted the resume was
   * REJECTED, because the sync choice was the one step routed out to the
   * Connected Devices settings panel instead of a phase — which is exactly the
   * defect the operator reported: the run never presented the one election it
   * owns. The expectation moved with the contract, not to make a red go green.
   */
  it("resumes the sync choice into the phase that renders it", () => {
    const result = transitionOnboarding(
      // `organizationEstablished: true` is CARRIED THROUGH the resume, not a
      // gate on it: `transitionFromReady` propagates the flag and never reads
      // it, so this case pins the propagation and says nothing about ordering.
      // The ISS-10890 ordering itself lives in `PENDING_STEP_PRIORITY`, and the
      // sibling case below pins the `false` half so the propagation can fail.
      stateAt(OnboardingPhase.Ready, { organizationEstablished: true }),
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.ChooseSessionSync,
      },
      context({
        accountStatus: AccountStatus.Established,
        githubConnected: true,
        syncConsentRecorded: KnownFlag.No,
        teamInvited: true,
      })
    );

    expect(result).toEqual({
      status: "moved",
      state: {
        accountProvider: null,
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: true,
        phase: OnboardingPhase.SyncPolicy,
        resuming: true,
      },
    });
  });

  /**
   * The other half of that propagation, so it is falsifiable in both directions.
   *
   * With only the `true` case above, a `transitionFromReady` that hardcoded
   * `organizationEstablished: true` on the resumed state would stay green while
   * silently telling every later guard that an organization exists.
   */
  it("carries an unestablished organization through the sync resume", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Ready, { organizationEstablished: false }),
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.ChooseSessionSync,
      },
      context({
        accountStatus: AccountStatus.Established,
        githubConnected: true,
        syncConsentRecorded: KnownFlag.No,
        teamInvited: true,
      })
    );

    expect(result).toEqual({
      status: "moved",
      state: {
        accountProvider: null,
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: false,
        phase: OnboardingPhase.SyncPolicy,
        resuming: true,
      },
    });
  });

  /**
   * The DURABLE half of the cross-repo contract (ISS-11249 review).
   *
   * A Desktop build older than this change knows neither `DashboardAvailable ->
   * SyncPolicy` nor `SyncPolicy -> DashboardAvailable`, so any SETTLED run whose
   * persisted chain contains either hop is rejected by its
   * `isReachableOnboardingState` and recovered to the blocking `Welcome`
   * takeover, on every launch. The resumed exit therefore re-roots the chain
   * instead of appending to it. Asserted on the exact field an older build
   * reads — `history` — rather than on the phase alone, which would pass with
   * the appended entry still there.
   */
  it("leaves a settled resumed sync run with no SyncPolicy hop in its history", () => {
    const exited = move(
      {
        accountProvider: null,
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: true,
        phase: OnboardingPhase.SyncPolicy,
        resuming: true,
      },
      { type: OnboardingEvent.ContinueFromSyncPolicy },
      context({
        accountStatus: AccountStatus.Established,
        githubConnected: true,
        syncConsentRecorded: KnownFlag.Yes,
        teamInvited: true,
      })
    );

    expect(exited.history).not.toContain(OnboardingPhase.SyncPolicy);
    expect(exited.history).toEqual([]);
    expect(exited.phase).toBe(OnboardingPhase.DashboardAvailable);
  });

  /** The resumed sync step returns to the app, never onward into the tail. */
  it("exits a resumed sync choice to the Dashboard and clears resuming", () => {
    const result = transitionOnboarding(
      {
        accountProvider: null,
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: true,
        phase: OnboardingPhase.SyncPolicy,
        resuming: true,
      },
      { type: OnboardingEvent.ContinueFromSyncPolicy },
      context({
        accountStatus: AccountStatus.Established,
        githubConnected: true,
        syncConsentRecorded: KnownFlag.Yes,
        teamInvited: true,
      })
    );

    expect(result).toEqual({
      status: "moved",
      state: {
        accountProvider: null,
        history: [],
        organizationEstablished: true,
        phase: OnboardingPhase.DashboardAvailable,
        resuming: false,
      },
    });
  });
});
