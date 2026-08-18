// Pure phase machine for the post-auth desktop onboarding flow (ISS-5249),
// extracted from Experience so the transitions are unit-testable without a
// React render.
//
// Acknowledging that the returning user is now authenticated is a silent
// background step with no UI, so the flow opens directly on the blocking sync
// takeover. The GitHub sign-in state is likewise resolved in the background and
// carried alongside these phases as flow state; it is not a phase, and only
// affects how the Sessions page renders once it mounts.

export const Phase = {
  SyncTakeover: "sync-takeover",
  Sessions: "sessions",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export type FlowAction = { type: "finish-sync" } | { type: "restart" };

export function flowReducer(phase: Phase, action: FlowAction): Phase {
  switch (action.type) {
    case "finish-sync":
      // Save confirmed, takeover dismissed → Sessions page. Guarded so it
      // cannot fire from another phase.
      return phase === Phase.SyncTakeover ? Phase.Sessions : phase;
    case "restart":
      return Phase.SyncTakeover;
    default:
      return phase;
  }
}
