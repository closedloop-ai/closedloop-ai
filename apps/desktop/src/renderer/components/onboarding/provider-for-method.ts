import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods";

/**
 * Map a picked {@link AuthMethod} onto the cross-process provider hint.
 *
 * Its own module, not a helper inside the onboarding flow: EVERY door into the
 * desktop's single loopback sign-in has to answer this the same way, and the
 * settings tab is not going to import a full-screen onboarding component to ask.
 * Two doors disagreeing is the exact defect ISS-5112 exists to close — a button
 * that names a provider and then opens a different one.
 *
 * `email` maps to `undefined`, which is NOT a magic-link flow: desktop has no
 * magic-link path, so an email pick opens the same loopback OAuth as the others
 * and the web side resolves the absent hint to GitHub. The onboarding doors no
 * longer offer email for that reason; Settings → Account still does.
 */
export function providerForMethod(
  method: AuthMethod
): DesktopSignInProvider | undefined {
  if (method === "github") {
    return DesktopSignInProvider.GitHub;
  }
  if (method === "google") {
    return DesktopSignInProvider.Google;
  }
  return undefined;
}
