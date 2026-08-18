import { describe, expect, it } from "vitest";
import {
  createInitialFlowState,
  type FlowState,
  flowReducer,
  INITIAL_FLOW_STATE,
} from "./flow-reducer";

// Pure transition coverage for the first-run flow machine (PR #4315
// r3706995117): the tour/route coupling, the guest-vs-account tour finale,
// scope gating, and post-signup intent resume.
describe("flowReducer", () => {
  it("clamps parse progress at 100", () => {
    const nearDone: FlowState = { ...INITIAL_FLOW_STATE, progress: 96 };
    expect(flowReducer(nearDone, { type: "tick" }).progress).toBe(100);
  });

  it("opening the tour always lands on the dashboard route", () => {
    const onBranches: FlowState = { ...INITIAL_FLOW_STATE, route: "branches" };
    const next = flowReducer(onBranches, { type: "open-tour" });
    expect(next.route).toBe("dashboard");
    expect(next.tourActive).toBe(true);
  });

  it("a guest finishing the tour gets the account CTA", () => {
    const touring: FlowState = { ...INITIAL_FLOW_STATE, tourActive: true };
    const next = flowReducer(touring, { type: "close-tour", reason: "done" });
    expect(next.tourActive).toBe(false);
    expect(next.overlay).toBe("tour");
  });

  it("a signed-in replay finishing the tour just closes", () => {
    const replaying: FlowState = {
      ...createInitialFlowState(true),
      tourActive: true,
    };
    const next = flowReducer(replaying, { type: "close-tour", reason: "done" });
    expect(next.tourActive).toBe(false);
    expect(next.overlay).toBeNull();
  });

  it("skipping the tour just closes it without an overlay", () => {
    const touring: FlowState = { ...INITIAL_FLOW_STATE, tourActive: true };
    const next = flowReducer(touring, { type: "close-tour", reason: "skip" });
    expect(next.tourActive).toBe(false);
    expect(next.overlay).toBeNull();
  });

  it("a guest selecting org scope is prompted to sign up instead", () => {
    const next = flowReducer(INITIAL_FLOW_STATE, {
      type: "set-scope",
      value: "org",
    });
    expect(next.scope).toBe("me");
    expect(next.overlay).toBe("organization");
  });

  it("a signed-in user selecting org scope switches scope", () => {
    const signedIn = createInitialFlowState(true);
    const next = flowReducer(signedIn, { type: "set-scope", value: "org" });
    expect(next.scope).toBe("org");
    expect(next.overlay).toBeNull();
  });

  it("signing up from the org-scope prompt resumes on org scope", () => {
    const prompted: FlowState = {
      ...INITIAL_FLOW_STATE,
      overlay: "organization",
    };
    const next = flowReducer(prompted, { type: "signed-up" });
    expect(next.signedUp).toBe(true);
    expect(next.scope).toBe("org");
    expect(next.overlay).toBeNull();
  });

  it("signing up clears a tour that armed while the prompt was open", () => {
    // The scan can finish while an org/invite prompt is open and arm the
    // auto-tour; completing sign-up must resume the intent, not reveal the
    // tour (wongk PR #4368 review).
    const raced: FlowState = {
      ...INITIAL_FLOW_STATE,
      overlay: "organization",
      tourActive: true,
    };
    const next = flowReducer(raced, { type: "signed-up" });
    expect(next.tourActive).toBe(false);
    expect(next.scope).toBe("org");
  });

  it("signing up from the invite prompt opens the invite dialog", () => {
    const prompted: FlowState = { ...INITIAL_FLOW_STATE, overlay: "invite" };
    const next = flowReducer(prompted, { type: "signed-up" });
    expect(next.signedUp).toBe(true);
    expect(next.inviteOpen).toBe(true);
  });

  it("signing up from a plain prompt keeps scope and leaves invite closed", () => {
    const prompted: FlowState = { ...INITIAL_FLOW_STATE, overlay: "header" };
    const next = flowReducer(prompted, { type: "signed-up" });
    expect(next.scope).toBe("me");
    expect(next.inviteOpen).toBe(false);
  });
});
