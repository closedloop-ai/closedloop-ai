import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";

/**
 * Connect-GitHub flow state shared by the desktop branch views. Mirrors the
 * outcomes of {@link useDesktopGitHubConnect}: idle before any attempt, pending
 * while sign-in / the connect handoff is in flight, then one terminal outcome
 * (opened / sign-in-required / failed).
 */
export const DesktopGitHubConnectState = {
  Idle: "idle",
  Pending: "pending",
  Opened: "opened",
  SignInRequired: "sign_in_required",
  Failed: "failed",
} as const;
export type DesktopGitHubConnectState =
  (typeof DesktopGitHubConnectState)[keyof typeof DesktopGitHubConnectState];

/**
 * Shared connect-GitHub handler for the desktop branch views (branch list +
 * branch detail). Encapsulates the sign-in-if-unauthenticated → `openGitHubConnect`
 * → query-invalidation flow — including the rejection-handling fallback — so
 * future fixes to this flow land once instead of being copy-pasted per view
 * (FEA-2782).
 *
 * `returnTo` is the post-connect deep link the main process routes back to
 * (e.g. `/branches` for the list, `/branches/:id` for detail). On success the
 * GitHub + branches query caches are invalidated so the open view re-hydrates
 * once the connection is available. A rejected sign-in / IPC call surfaces the
 * same `Failed` fallback rather than leaking an unhandled rejection and pinning
 * the status at `Pending` forever.
 */
export function useDesktopGitHubConnect(returnTo: string): {
  connectState: DesktopGitHubConnectState;
  connectGitHub: () => Promise<void>;
} {
  const auth = useDesktopAuth();
  const queryClient = useQueryClient();
  const [connectState, setConnectState] = useState<DesktopGitHubConnectState>(
    DesktopGitHubConnectState.Idle
  );

  const connectGitHub = useCallback(async () => {
    setConnectState(DesktopGitHubConnectState.Pending);
    try {
      if (auth.state.status !== "authenticated") {
        const signIn = await auth.beginSignIn();
        if (!signIn.ok) {
          setConnectState(DesktopGitHubConnectState.SignInRequired);
          return;
        }
      }
      const result = await window.desktopApi.openGitHubConnect({ returnTo });
      if (!result.ok) {
        setConnectState(DesktopGitHubConnectState.Failed);
        return;
      }
    } catch {
      // A rejected sign-in / IPC call must surface the same "could not be
      // opened" fallback rather than leaking an unhandled rejection and
      // pinning the status at Pending forever.
      setConnectState(DesktopGitHubConnectState.Failed);
      return;
    }
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
    setConnectState(DesktopGitHubConnectState.Opened);
  }, [auth, queryClient, returnTo]);

  return { connectState, connectGitHub };
}
