import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDesktopSetupCompleteFromState } from "../src/main/setup-readiness.js";

describe("Desktop setup readiness", () => {
  test("honors the persisted onboarding completion flag", () => {
    assert.equal(
      isDesktopSetupCompleteFromState({
        onboardingCompleted: true,
        sandboxBaseDirectory: "",
        hasApiKey: false,
      }),
      true
    );
  });

  test("treats existing configured profiles as setup-complete", () => {
    assert.equal(
      isDesktopSetupCompleteFromState({
        onboardingCompleted: false,
        sandboxBaseDirectory: "~/Source",
        hasApiKey: true,
      }),
      true
    );
  });

  test("does not report readiness without both legacy setup inputs", () => {
    assert.equal(
      isDesktopSetupCompleteFromState({
        onboardingCompleted: false,
        sandboxBaseDirectory: "~/Source",
        hasApiKey: false,
      }),
      false
    );
    assert.equal(
      isDesktopSetupCompleteFromState({
        onboardingCompleted: false,
        sandboxBaseDirectory: "   ",
        hasApiKey: true,
      }),
      false
    );
  });
});
