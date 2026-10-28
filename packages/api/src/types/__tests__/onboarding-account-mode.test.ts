import { describe, expect, it } from "vitest";
import {
  OnboardingAccountMode,
  OnboardingAccountOutcome,
  onboardingAccountModesForOutcome,
} from "../onboarding-analytics";

/**
 * ISS-10913. The fold from one evaluated desktop auth outcome to the
 * `account_mode` set PRD-736's catalog defines.
 */
describe("onboardingAccountModesForOutcome", () => {
  it("reports a created account that returned authenticated as both facts", () => {
    expect(
      onboardingAccountModesForOutcome(OnboardingAccountOutcome.CreatedSignedIn)
    ).toEqual([OnboardingAccountMode.Created, OnboardingAccountMode.SignedIn]);
  });

  it("reports a created account with no surviving session as created + logged_out", () => {
    expect(
      onboardingAccountModesForOutcome(
        OnboardingAccountOutcome.CreatedLoggedOut
      )
    ).toEqual([OnboardingAccountMode.Created, OnboardingAccountMode.LoggedOut]);
  });

  it("reports an authenticated return with no creation observed as signed_in alone", () => {
    expect(
      onboardingAccountModesForOutcome(OnboardingAccountOutcome.SignedIn)
    ).toEqual([OnboardingAccountMode.SignedIn]);
  });

  it("reports a confirmed unauthenticated state as logged_out alone", () => {
    expect(
      onboardingAccountModesForOutcome(OnboardingAccountOutcome.LoggedOut)
    ).toEqual([OnboardingAccountMode.LoggedOut]);
  });

  it("folds an ABSENT outcome — the additive field an older gateway never sends — to unknown", () => {
    // The version-skew case the property exists for: the renderer must report
    // an explicit unknown rather than omitting `account_mode` entirely.
    expect(onboardingAccountModesForOutcome(undefined)).toEqual([
      OnboardingAccountMode.Unknown,
    ]);
    expect(onboardingAccountModesForOutcome(null)).toEqual([
      OnboardingAccountMode.Unknown,
    ]);
  });

  it("folds an UNRECOGNIZED runtime outcome to unknown, not to an omission", () => {
    // The value crosses the desktop gateway -> renderer boundary with no
    // runtime parse, so the type does not constrain it there: a newer or
    // malformed producer can send an outcome string this build never heard of.
    // Indexing the record would yield `undefined` and the emitter would then
    // OMIT `account_mode` — the exact ambiguity the property exists to remove
    // (whitlockk on #7793).
    const fromNewerProducer = "created_pending_verification" as never;

    expect(onboardingAccountModesForOutcome(fromNewerProducer)).toEqual([
      OnboardingAccountMode.Unknown,
    ]);
    expect(onboardingAccountModesForOutcome("" as never)).toEqual([
      OnboardingAccountMode.Unknown,
    ]);
  });

  it("never combines unknown with a known value", () => {
    expect(
      onboardingAccountModesForOutcome(OnboardingAccountOutcome.Unknown)
    ).toEqual([OnboardingAccountMode.Unknown]);
  });

  it("emits a non-empty, deduplicated set for every outcome, signed_in and logged_out never together", () => {
    for (const outcome of Object.values(OnboardingAccountOutcome)) {
      const modes = onboardingAccountModesForOutcome(outcome);
      expect(modes.length).toBeGreaterThan(0);
      expect(new Set(modes).size).toBe(modes.length);
      expect(
        modes.includes(OnboardingAccountMode.SignedIn) &&
          modes.includes(OnboardingAccountMode.LoggedOut)
      ).toBe(false);
      if (modes.includes(OnboardingAccountMode.Unknown)) {
        expect(modes).toEqual([OnboardingAccountMode.Unknown]);
      }
    }
  });

  it("orders created before the session fact", () => {
    for (const outcome of Object.values(OnboardingAccountOutcome)) {
      const modes = onboardingAccountModesForOutcome(outcome);
      const createdAt = modes.indexOf(OnboardingAccountMode.Created);
      if (createdAt !== -1) {
        expect(createdAt).toBe(0);
        expect(modes.length).toBe(2);
      }
    }
  });
});
