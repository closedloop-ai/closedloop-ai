// Pure phase machine for the pre-auth onboarding flow, extracted from
// Experience so the transitions are unit-testable without a React render.

export const Phase = {
  Landing: "landing",
  OnboardingApp: "onboarding-app",
  ReturningApp: "returning-app",
  SignIn: "sign-in",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export type FlowAction =
  | { type: "get-started" }
  | { type: "sign-in" }
  | { type: "auth-complete" }
  | { type: "back" };

export function flowReducer(phase: Phase, action: FlowAction): Phase {
  switch (action.type) {
    case "get-started":
      return Phase.OnboardingApp;
    case "sign-in":
      // Used by both the landing "Sign in" link and the in-app sign-up CTA —
      // both route to the same AuthPanel.
      return Phase.SignIn;
    case "auth-complete":
      return Phase.ReturningApp;
    case "back":
      return Phase.Landing;
    default:
      return phase;
  }
}
