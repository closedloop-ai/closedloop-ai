// Pure state machine for the in-app first-run flow, extracted from the
// AppExperience component so the timed and gated transitions are unit-testable
// in the sandbox's node-environment suite (PR #4315 r3706995117).

import type { AppRoute, SignUpContext } from "./app-mock";

export const PROGRESS_STEP = 12;

export type FlowState = {
  route: AppRoute;
  progress: number;
  tourActive: boolean;
  signedUp: boolean;
  scope: string;
  overlay: SignUpContext | null;
  inviteOpen: boolean;
};

export type FlowAction =
  | { type: "tick" }
  | { type: "navigate"; route: AppRoute }
  | { type: "open-tour" }
  | { type: "close-tour"; reason: "done" | "skip" }
  | { type: "set-scope"; value: string }
  | { type: "open-signup"; context: SignUpContext }
  | { type: "close-signup" }
  | { type: "open-invite" }
  | { type: "close-invite" }
  | { type: "signed-up" };

export const INITIAL_FLOW_STATE: FlowState = {
  route: "dashboard",
  progress: 0,
  tourActive: false,
  signedUp: false,
  scope: "me",
  overlay: null,
  inviteOpen: false,
};

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "tick":
      return {
        ...state,
        progress: Math.min(100, state.progress + PROGRESS_STEP),
      };
    case "navigate":
      return { ...state, route: action.route };
    case "open-tour":
      // Every non-intro tour target lives on the Dashboard, so opening the
      // tour always lands there first (r3706995090).
      return { ...state, route: "dashboard", tourActive: true };
    case "close-tour":
      return {
        ...state,
        tourActive: false,
        // Only a guest's completed tour converts into the account CTA; a
        // signed-in replay just closes (r3706995098).
        overlay:
          action.reason === "done" && !state.signedUp ? "tour" : state.overlay,
      };
    case "set-scope":
      // Guests can't switch to org scope; that click prompts sign-up instead.
      if (action.value === "org" && !state.signedUp) {
        return { ...state, overlay: "organization" };
      }
      return { ...state, scope: action.value };
    case "open-signup":
      return { ...state, overlay: action.context };
    case "close-signup":
      return { ...state, overlay: null };
    case "open-invite":
      return { ...state, inviteOpen: true };
    case "close-invite":
      return { ...state, inviteOpen: false };
    case "signed-up":
      // Resume the intent that prompted sign-up (r3706995109): an
      // Organization-scope ask lands on org scope, an Invite ask opens the
      // invite dialog. Clear any tour that armed while the prompt was open so
      // a scan finishing mid-prompt can't reveal the tour instead of resuming
      // on the requested intent (wongk PR #4368 review).
      return {
        ...state,
        signedUp: true,
        overlay: null,
        tourActive: false,
        scope: state.overlay === "organization" ? "org" : state.scope,
        inviteOpen: state.overlay === "invite" ? true : state.inviteOpen,
      };
    default:
      return state;
  }
}

export const createInitialFlowState = (signedUp: boolean): FlowState => ({
  ...INITIAL_FLOW_STATE,
  signedUp,
});
