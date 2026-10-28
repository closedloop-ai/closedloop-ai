/**
 * ISS-11149 row 5: the `legacy` experience stamp must keep parsing.
 *
 * `workspace-experience.ts` states that an `OnboardingAttempt` created while the
 * `workspace-experience-v2` rollout gate was live still carries
 * {@link WorkspaceExperience.Legacy} in `experienceVariant`, persisted on create
 * and never rewritten. Nothing pinned it: every fixture in the tree uses `V2`,
 * and repo-wide the only mention of `Legacy` outside `dist/` was that sentence.
 * Both boundaries below take the value as an unconstrained string, so a reader
 * narrowing either to the one value anything produces today would take every
 * pre-gate row's snapshot dark, and no test would object.
 */

import { describe, expect, it } from "vitest";
import { OnboardingEvent } from "./onboarding-events";
import {
  type GuidedOnboardingSnapshot,
  guidedOnboardingSnapshotSchema,
  guidedOnboardingTransitionRequestSchema,
} from "./onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "./onboarding-persistence";
import {
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "./onboarding-phase";
import { WorkspaceExperience } from "./workspace-experience";

const COMMAND_ID = "0199e2ee-0000-7000-8000-000000000001";

describe("WorkspaceExperience.Legacy", () => {
  it("survives the snapshot read a pre-gate row is served through", () => {
    const parsed = guidedOnboardingSnapshotSchema.parse(
      snapshotStampedWith(WorkspaceExperience.Legacy)
    );

    expect(parsed.experienceVariant).toBe(WorkspaceExperience.Legacy);
  });

  it("survives the strict transition write", () => {
    // `.strict()` at both levels here, so this boundary is the one a narrowed
    // stamp would refuse outright rather than degrade.
    const parsed = guidedOnboardingTransitionRequestSchema.parse({
      commandId: COMMAND_ID,
      event: { type: OnboardingEvent.Start },
      experienceVariant: WorkspaceExperience.Legacy,
      host: OnboardingHost.Web,
      revision: 0,
      state: serializeOnboardingState(createInitialOnboardingState()),
    });

    expect(parsed.experienceVariant).toBe(WorkspaceExperience.Legacy);
  });

  it("carries the value the live surfaces stamp through the same reads", () => {
    // Paired control: both cases above are satisfied by a boundary that accepts
    // anything, so the value anything actually produces has to arrive too.
    expect(
      guidedOnboardingSnapshotSchema.parse(
        snapshotStampedWith(WorkspaceExperience.V2)
      ).experienceVariant
    ).toBe(WorkspaceExperience.V2);
  });
});

function snapshotStampedWith(
  experienceVariant: WorkspaceExperience
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Unknown,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 1,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      phase: OnboardingPhase.Welcome,
    }),
  };
}
