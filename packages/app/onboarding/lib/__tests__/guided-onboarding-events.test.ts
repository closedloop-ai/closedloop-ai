import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { AccountProvider } from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import {
  createAccountEstablishedEvent,
  createOrganizationReadyEvent,
} from "../guided-onboarding-events";

describe("guided onboarding events", () => {
  it("maps each account action to the typed account-established event", () => {
    expect(createAccountEstablishedEvent("github")).toEqual({
      provider: AccountProvider.GitHub,
      type: OnboardingEvent.AccountEstablished,
    });
    expect(createAccountEstablishedEvent("google")).toEqual({
      provider: AccountProvider.Google,
      type: OnboardingEvent.AccountEstablished,
    });
    expect(createAccountEstablishedEvent("email")).toEqual({
      provider: AccountProvider.Email,
      type: OnboardingEvent.AccountEstablished,
    });
  });

  it("emits a bare organization-ready event for create and join hosts", () => {
    expect(createOrganizationReadyEvent()).toEqual({
      type: OnboardingEvent.OrganizationReady,
    });
  });
});
