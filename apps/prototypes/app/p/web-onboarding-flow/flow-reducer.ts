// Pure phase machine for the pre-auth web onboarding flow, extracted from
// Experience so the transitions are unit-testable without a React render.
//
// Landing -> Auth -> SocialRedirect -> CreateTeam -> CreateProject -> App
// (the authenticated app, landing on My Tasks).

export const Phase = {
  Landing: "landing",
  Auth: "auth",
  SocialRedirect: "social-redirect",
  CreateTeam: "create-team",
  CreateProject: "create-project",
  App: "app",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export type FlowAction =
  | { type: "get-started" }
  | { type: "authenticate" }
  | { type: "auth-complete" }
  | { type: "team-created" }
  | { type: "project-created" }
  | { type: "back" };

export function flowReducer(phase: Phase, action: FlowAction): Phase {
  switch (action.type) {
    case "get-started":
      // Both the landing "Get Started" CTA and the "Sign in" link route here.
      return Phase.Auth;
    case "authenticate":
      // Any auth choice (GitHub, Google, email) hands off to the social login.
      return Phase.SocialRedirect;
    case "auth-complete":
      return Phase.CreateTeam;
    case "team-created":
      return Phase.CreateProject;
    case "project-created":
      return Phase.App;
    case "back":
      return backTarget(phase);
    default:
      return phase;
  }
}

function backTarget(phase: Phase): Phase {
  if (phase === Phase.Auth) {
    return Phase.Landing;
  }
  if (phase === Phase.CreateProject) {
    return Phase.CreateTeam;
  }
  return phase;
}
