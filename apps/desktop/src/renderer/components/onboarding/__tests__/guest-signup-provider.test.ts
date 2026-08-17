/**
 * ISS-5112 (PLN-1600 Step D): the guest sign-up intent machine.
 *
 * The reducer is the whole point of the feature — it is what lets an ask made
 * from one surface be FINISHED on that surface after a browser round-trip. A
 * boolean "signed up" would pass every other test in this suite and still drop
 * the person back where they started with no idea why they signed up.
 */
import { describe, expect, it } from "vitest";
import {
  type GuestSignupAction,
  GuestSignupIntent,
  guestSignupReducer,
  INITIAL_GUEST_SIGNUP_STATE,
} from "../guest-signup-provider";

function run(...actions: GuestSignupAction[]) {
  return actions.reduce(guestSignupReducer, INITIAL_GUEST_SIGNUP_STATE);
}

describe("guestSignupReducer", () => {
  it("asks nothing until a surface requests it", () => {
    expect(INITIAL_GUEST_SIGNUP_STATE).toEqual({
      pending: null,
      resuming: null,
    });
  });

  it("remembers WHICH surface asked, not merely that one did", () => {
    expect(
      run({ type: "request", intent: GuestSignupIntent.Organization }).pending
    ).toBe(GuestSignupIntent.Organization);
  });

  it("hands the asking surface its own intent back to resume", () => {
    const state = run(
      { type: "request", intent: GuestSignupIntent.Invite },
      { type: "signed-up" }
    );

    // The ask is over, but the job is not: the invite item still has to reopen.
    expect(state.pending).toBeNull();
    expect(state.resuming).toBe(GuestSignupIntent.Invite);
  });

  it("resumes nothing when the person backed out instead of signing up", () => {
    const state = run(
      { type: "request", intent: GuestSignupIntent.Invite },
      { type: "dismiss" }
    );

    expect(state.pending).toBeNull();
    expect(state.resuming).toBeNull();
  });

  it("keeps the resume marker across the close that follows a sign-up", () => {
    // AccountDialog fires onSignedUp and THEN closes, so the dismiss arrives
    // immediately after. It must not wipe the intent the close is a symptom of.
    const state = run(
      { type: "request", intent: GuestSignupIntent.Organization },
      { type: "signed-up" },
      { type: "dismiss" }
    );

    expect(state.resuming).toBe(GuestSignupIntent.Organization);
  });

  it("clears the marker once the owning surface has acted on it", () => {
    const state = run(
      { type: "request", intent: GuestSignupIntent.Tour },
      { type: "signed-up" },
      { type: "resumed" }
    );

    expect(state.resuming).toBeNull();
  });
});
