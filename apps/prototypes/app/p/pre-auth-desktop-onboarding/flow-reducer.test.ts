import { describe, expect, it } from "vitest";
import { flowReducer, Phase } from "./flow-reducer";

describe("flowReducer", () => {
  it("Get Started moves from Landing to OnboardingApp", () => {
    expect(flowReducer(Phase.Landing, { type: "get-started" })).toBe(
      Phase.OnboardingApp
    );
  });

  it("Sign In from the landing page moves to SignIn", () => {
    expect(flowReducer(Phase.Landing, { type: "sign-in" })).toBe(Phase.SignIn);
  });

  it("Sign Up from the onboarding app routes through SignIn", () => {
    expect(flowReducer(Phase.OnboardingApp, { type: "sign-in" })).toBe(
      Phase.SignIn
    );
  });

  it("auth-complete from SignIn lands on ReturningApp", () => {
    expect(flowReducer(Phase.SignIn, { type: "auth-complete" })).toBe(
      Phase.ReturningApp
    );
  });

  it("back from SignIn returns to Landing", () => {
    expect(flowReducer(Phase.SignIn, { type: "back" })).toBe(Phase.Landing);
  });

  it("unknown action returns the current phase unchanged", () => {
    // @ts-expect-error intentional unknown action for runtime guard coverage
    expect(flowReducer(Phase.Landing, { type: "unknown" })).toBe(Phase.Landing);
  });
});
