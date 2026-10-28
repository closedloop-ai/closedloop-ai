import {
  OnboardingEvent,
  OnboardingRejection,
} from "@repo/api/src/types/onboarding-events";
import {
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { OnboardingDesktopSkipEligibility } from "../../components/guided-onboarding-data";
import { buildOnboardingContext } from "../guided-onboarding-fixtures";
import { deriveOnboardingDesktopSkipEligibility } from "../onboarding-desktop-skip";
import { transitionOnboarding } from "../onboarding-transitions";

const DOWNLOAD_STATE: OnboardingMachineState = {
  phase: OnboardingPhase.DownloadDesktop,
  history: [],
  accountProvider: null,
  resuming: false,
  organizationEstablished: true,
};

describe("deriveOnboardingDesktopSkipEligibility", () => {
  it("permits the skip for a member who joined an existing organization", () => {
    expect(
      deriveOnboardingDesktopSkipEligibility(
        OrganizationMembership.ExistingMember
      )
    ).toBe(OnboardingDesktopSkipEligibility.Eligible);
  });

  it("withholds the skip from the organization's first user", () => {
    expect(
      deriveOnboardingDesktopSkipEligibility(OrganizationMembership.FirstUser)
    ).toBe(OnboardingDesktopSkipEligibility.Required);
  });

  it.each([
    ["an absent field", undefined],
    ["an explicit null", null],
    ["a spelling from another build", "maybe"],
    ["a prototype key", "__proto__"],
    ["a number", 1],
    ["an object", {}],
  ])("reports %s as unmeasured, never as eligible", (_label, raw) => {
    // Every one of these is reachable: the snapshot response has no schema, so
    // this value arrives as unvalidated JSON whatever the types say.
    expect(deriveOnboardingDesktopSkipEligibility(raw)).toBe(
      OnboardingDesktopSkipEligibility.Unknown
    );
  });
});

describe("skip eligibility agrees with the transition engine", () => {
  // Two paths now answer "may this user skip?": this derivation decides whether
  // the control renders, and the machine decides whether the event is accepted.
  // If they ever disagree, the UI offers a button the engine refuses, or hides
  // one it would have allowed. This pins them together over every membership.
  it.each(Object.values(OrganizationMembership))(
    "offers the skip for %s exactly when the machine accepts SkipDownload",
    (membership) => {
      const uiOffersSkip =
        deriveOnboardingDesktopSkipEligibility(membership) ===
        OnboardingDesktopSkipEligibility.Eligible;

      const result = transitionOnboarding(
        DOWNLOAD_STATE,
        { type: OnboardingEvent.SkipDownload },
        buildOnboardingContext({
          host: OnboardingHost.Web,
          membership,
        })
      );
      const engineAcceptsSkip = result.status === "moved";

      expect(uiOffersSkip).toBe(engineAcceptsSkip);
      if (result.status !== "moved") {
        expect(result.reason).toBe(OnboardingRejection.GuardBlocked);
      }
    }
  );
});
