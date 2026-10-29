import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods";
import { useCallback, useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { signInFailureMessage } from "../../shared-agent-sessions/desktop-sign-in-copy";
import type { DesktopAuthFraming } from "./desktop-auth-copy";
import { signInMethodForAuthMethod } from "./sign-in-method-for-auth-method";

/**
 * Maps an {@link AuthMethods} selection onto the real loopback sign-in flow,
 * with the picked method in flight and the last failure, for the desktop
 * surface that renders the chooser: the onboarding Account step (sign-UP
 * framing, ISS-11480).
 */
export function useDesktopSignIn(framing: DesktopAuthFraming): {
  pendingMethod: AuthMethod | null;
  error: string | null;
  /** Drop the last failure, for a host that outlives the chooser it feeds. */
  clearError: () => void;
  onSelect: (method: AuthMethod, email?: string) => Promise<void>;
} {
  const { beginSignIn } = useDesktopAuth();
  const [pendingMethod, setPendingMethod] = useState<AuthMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSelect = async (method: AuthMethod, email?: string) => {
    setPendingMethod(method);
    setError(null);
    try {
      // ISS-5112: the picked method has to REACH the sign-in. Dropping it here
      // sent every method through the absent-hint fallback, so "Continue
      // with Google" opened GitHub's consent screen. ISS-5954 M5: the typed
      // address rides along so the email form opens prefilled, and the host's
      // framing rides with it so that form is the matching Clerk embed.
      const result = await beginSignIn(
        signInMethodForAuthMethod(method),
        email,
        framing
      );
      if (!(result.ok || result.reason === "cancelled")) {
        setError(signInFailureMessage(result.reason));
      }
    } catch {
      setError("Sign-in could not be completed. Try again.");
    } finally {
      setPendingMethod(null);
    }
  };

  const clearError = useCallback(() => setError(null), []);

  return { pendingMethod, error, clearError, onSelect };
}
