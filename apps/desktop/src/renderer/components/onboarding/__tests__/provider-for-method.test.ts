/**
 * ISS-5112 — the one place every desktop sign-in door agrees on what the picked
 * method means. Tested directly because its three arms are reached from three
 * different surfaces (the onboarding flow, the account dialog, Settings →
 * Account), and no single surface exercises all of them: the onboarding doors no
 * longer offer email at all.
 */

import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import { providerForMethod } from "../provider-for-method";

describe("providerForMethod", () => {
  it("maps each social method to its own provider", () => {
    // Both, not just one: a hardcoded return passes a single-provider test and
    // is exactly the defect this helper exists to prevent.
    expect(providerForMethod("github")).toBe(DesktopSignInProvider.GitHub);
    expect(providerForMethod("google")).toBe(DesktopSignInProvider.Google);
  });

  it("sends no hint for email, which has no provider behind it", () => {
    // Not a magic-link flow: desktop has none, so this pick opens the same
    // loopback OAuth and the web side resolves the absent hint to GitHub.
    expect(providerForMethod("email")).toBeUndefined();
  });
});
