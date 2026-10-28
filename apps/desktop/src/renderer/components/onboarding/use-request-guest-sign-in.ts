import {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { useMutation } from "@tanstack/react-query";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { signInFailureMessage } from "../../shared-agent-sessions/desktop-sign-in-copy";

/** ISS-12475: returning users bypass the guest account-creation run. */
export function useRequestGuestSignIn(): (() => void) | undefined {
  const { state, beginSignIn } = useDesktopAuth();
  const { mutate } = useMutation({
    // This starts local IPC even offline; the auth flow owns network failures.
    networkMode: "always",
    mutationFn: async () => {
      // Email selects the existing Clerk form with all configured providers.
      // Omitting the method would auto-start GitHub instead.
      const result = await beginSignIn(
        DesktopSignInMethod.Email,
        undefined,
        DesktopSignInFraming.SignIn
      );
      if (!(result.ok || result.reason === "cancelled")) {
        throw new Error(signInFailureMessage(result.reason));
      }
    },
  });

  return state.status === DesktopAuthStatus.SignedOut ? mutate : undefined;
}
