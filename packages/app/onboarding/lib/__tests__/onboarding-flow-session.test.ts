/**
 * The sessionStorage boundary is a trust boundary: a stored record is replayed
 * into analytics properties, so it is valid-or-absent — a record carrying
 * values outside the closed vocabularies is dropped whole, never sanitized
 * into a partially-corrupt session.
 */

import { FirstOrgUserValue } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readOnboardingFlowSession,
  recordOnboardingFirstOrgUser,
  recordOnboardingStepSkipped,
  resetOnboardingFlowSessionForTests,
  startOnboardingFlowSession,
} from "../onboarding-flow-session";

const STORAGE_KEY = "closedloop.onboarding.flow-session";

beforeEach(() => {
  resetOnboardingFlowSessionForTests();
});

describe("onboarding flow session storage boundary", () => {
  it("round-trips a valid session through storage", () => {
    startOnboardingFlowSession(1_700_000_000_000);
    recordOnboardingStepSkipped(OnboardingPhase.InviteTeam);
    recordOnboardingFirstOrgUser(FirstOrgUserValue.True);

    const stored = readOnboardingFlowSession();
    expect(stored).toMatchObject({
      firstOrgUser: FirstOrgUserValue.True,
      skippedSteps: [OnboardingPhase.InviteTeam],
      startedAtMs: 1_700_000_000_000,
    });
  });

  it("drops a stored record whose values fall outside the closed vocabularies", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        firstOrgUser: "maybe",
        flowId: "flow-1",
        skippedSteps: [],
        startedAtMs: 1,
      })
    );
    expect(readOnboardingFlowSession()).toBeNull();

    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        flowId: "flow-1",
        skippedSteps: ["not_a_phase"],
        startedAtMs: 1,
      })
    );
    expect(readOnboardingFlowSession()).toBeNull();
  });
});
