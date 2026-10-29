/**
 * The two directions of the guided-onboarding wire contract, and the fact that
 * they disagree on purpose.
 *
 * A browser holding yesterday's bundle reads a server that may already be a
 * deploy ahead, so the snapshot READER tolerates a field it does not know — at
 * the top level and, the half that is easy to lose, inside `state`, which
 * reuses a shape whose write-side parser is `.strict()`. The transition COMMAND
 * keeps refusing the same key, because there the unknown one is a client this
 * build cannot answer for.
 */

import { describe, expect, it } from "vitest";
import { OnboardingEvent } from "./onboarding-events.ts";
import {
  type GuidedOnboardingSnapshot,
  guidedOnboardingSnapshotSchema,
  guidedOnboardingTransitionRequestSchema,
} from "./onboarding-guided.ts";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
  serializeOnboardingState,
} from "./onboarding-persistence.ts";
import {
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "./onboarding-phase.ts";
import { WorkspaceExperience } from "./workspace-experience.ts";

/** A run parked on the tour, reached the one way the machine allows. */
const TOUR_STATE = serializeOnboardingState({
  accountProvider: null,
  history: [OnboardingPhase.DashboardAvailable],
  organizationEstablished: true,
  phase: OnboardingPhase.DashboardTour,
  resuming: false,
});

/** The key a server one deploy ahead adds; this build has never heard of it. */
const UNKNOWN_FIELD = "fieldThisBuildDoesNotRead";

function snapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 7,
    state: TOUR_STATE,
  };
}

/** Read the body, or fail the case with the parser's own reason. */
function read(body: unknown): GuidedOnboardingSnapshot {
  const parsed = guidedOnboardingSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Expected the snapshot to read: ${parsed.error.message}`);
  }
  return parsed.data;
}

describe("guidedOnboardingSnapshotSchema", () => {
  it("preserves the measured GitHub data status signal when present", () => {
    const parsed = read({
      ...snapshot(),
      context: {
        ...snapshot().context,
        githubDataConnectionStatusMeasured: true,
      },
    });

    expect(parsed.context.githubDataConnectionStatusMeasured).toBe(true);
  });

  it("preserves omission from an older API snapshot", () => {
    const parsed = read(snapshot());

    expect(parsed.context).not.toHaveProperty(
      "githubDataConnectionStatusMeasured"
    );
  });

  it("ignores unknown context fields from a newer API snapshot", () => {
    const parsed = read({
      ...snapshot(),
      context: { ...snapshot().context, [UNKNOWN_FIELD]: true },
    });

    expect(parsed.context.githubConnected).toBe(false);
    expect(parsed.context).not.toHaveProperty(UNKNOWN_FIELD);
  });

  it.each([false, null, "future-status"])(
    "treats an unrecognized measurement value %s as legacy omission",
    (value) => {
      const parsed = read({
        ...snapshot(),
        context: {
          ...snapshot().context,
          githubDataConnectionStatusMeasured: value,
        },
      });

      expect(parsed.context.githubDataConnectionStatusMeasured).toBeUndefined();
    }
  );

  it("reads a run a deploy-ahead server grew, at the top level and inside state", () => {
    const state = read({
      ...snapshot(),
      [UNKNOWN_FIELD]: "top-level",
      state: { ...TOUR_STATE, [UNKNOWN_FIELD]: "nested" },
    }).state;

    // The run itself survives: the field is dropped, not the payload carrying
    // it. A nested `.strict()` here failed the whole snapshot instead, which is
    // a tour that never arms with nothing on either side saying why.
    expect(state.phase).toBe(OnboardingPhase.DashboardTour);
    expect(state.history).toEqual([OnboardingPhase.DashboardAvailable]);
  });

  it("strips the unknown state key rather than passing it on to the restore", () => {
    const state = read({
      ...snapshot(),
      state: { ...TOUR_STATE, [UNKNOWN_FIELD]: "nested" },
    }).state;

    // Stripping is what makes tolerance safe. `restoreOnboardingState` parses
    // this value STRICTLY again, so a passthrough would trade the failed read
    // for an `Unreadable` recovery — the reader's run reset to Welcome instead
    // of a field being ignored.
    expect(state).not.toHaveProperty(UNKNOWN_FIELD);
    expect(restoreOnboardingState(state, OnboardingHost.Web).outcome).toBe(
      OnboardingRestoreOutcome.Restored
    );
  });
});

describe("guidedOnboardingTransitionRequestSchema", () => {
  it("refuses inside state the key the snapshot read tolerates", () => {
    const command = {
      commandId: "3f1d6a6e-9f5a-4a5f-9a6a-2b0d0c4f4a11",
      event: { type: OnboardingEvent.FinishTour },
      experienceVariant: WorkspaceExperience.V2,
      host: OnboardingHost.Web,
      revision: 7,
      state: { ...TOUR_STATE, [UNKNOWN_FIELD]: "nested" },
    };

    expect(
      guidedOnboardingTransitionRequestSchema.safeParse(command).success
    ).toBe(false);
    // ...and the same command without it is otherwise accepted, so the refusal
    // above is the unknown key and not a malformed fixture.
    expect(
      guidedOnboardingTransitionRequestSchema.safeParse({
        ...command,
        state: TOUR_STATE,
      }).success
    ).toBe(true);
  });
});
