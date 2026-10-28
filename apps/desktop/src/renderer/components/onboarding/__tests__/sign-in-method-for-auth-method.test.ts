/**
 * ISS-5112 / ISS-5954 — the one place every desktop sign-in door agrees on what
 * the picked method means. Tested directly because the onboarding flow reaches
 * its arms through `useDesktopSignIn`, and the email arm is the one whose old `undefined` mapping sent "Create account with
 * email" to GitHub's consent screen.
 */

import { DesktopSignInMethod } from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import { signInMethodForAuthMethod } from "../sign-in-method-for-auth-method";

describe("signInMethodForAuthMethod", () => {
  it("maps each social method to its own wire value", () => {
    // Both, not just one: a hardcoded return passes a single-method test and
    // is exactly the defect this helper exists to prevent.
    expect(signInMethodForAuthMethod("github")).toBe(
      DesktopSignInMethod.GitHub
    );
    expect(signInMethodForAuthMethod("google")).toBe(
      DesktopSignInMethod.Google
    );
  });

  it("sends the explicit email value — never the absent hint, which means GitHub", () => {
    // ISS-5954: email CANNOT ride as "absent". The web side deliberately
    // resolves absent AND unrecognized to GitHub for version skew, so only an
    // explicit `email` reaches the email landing branch.
    expect(signInMethodForAuthMethod("email")).toBe(DesktopSignInMethod.Email);
  });
});
