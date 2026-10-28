import { DesktopSignInMethod } from "@repo/api/src/types/desktop-authorize-url";
import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods";

/**
 * Map a picked {@link AuthMethod} onto the cross-process sign-in-method hint.
 *
 * Its own module, not a helper inside the onboarding flow: EVERY door into the
 * desktop's single loopback sign-in has to answer this the same way, and the
 * settings tab is not going to import a full-screen onboarding component to
 * ask. Two doors disagreeing is the exact defect ISS-5112 exists to close — a
 * button that names a method and then opens a different one.
 *
 * ISS-5954 M2 widened the hint from *provider* to *method*, which made this an
 * identity mapping (the UI vocabulary and the wire vocabulary name the same
 * three methods) — it replaced `providerForMethod`, whose `email → undefined`
 * arm is how "Create account with email" landed on GitHub's consent screen.
 * Kept as an explicit exhaustive map rather than a cast so the two vocabularies
 * may drift apart again without a silent hole: a UI method with no wire value
 * fails `tsc` here.
 */
export function signInMethodForAuthMethod(
  method: AuthMethod
): DesktopSignInMethod {
  return SIGN_IN_METHOD_FOR_AUTH_METHOD[method];
}

const SIGN_IN_METHOD_FOR_AUTH_METHOD = {
  github: DesktopSignInMethod.GitHub,
  google: DesktopSignInMethod.Google,
  email: DesktopSignInMethod.Email,
} as const satisfies Record<AuthMethod, DesktopSignInMethod>;
