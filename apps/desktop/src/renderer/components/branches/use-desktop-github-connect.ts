import { useBranchesQueryContext } from "@repo/app/branches/data-source/provider";
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
 * Options for {@link useDesktopGitHubConnect}. `returnTo` is required; the rest
 * let non-branch surfaces (e.g. the Dashboard/Insights) reuse the same flow
 * without forking it.
 */
export type UseDesktopGitHubConnectOptions = {
  /**
   * The post-connect deep link the main process routes back to (e.g.
   * `/branches` for the list, `/branches/:id` for detail, `/insights` for the
   * Dashboard).
   */
  returnTo: string;
  /**
   * Optional query-cache keys to invalidate on a successful open, in addition
   * to the always-invalidated GitHub + branches caches. The Insights surface
   * passes its own `insightsKeys.all` so gated tiles re-hydrate once the
   * connection is available.
   */
  invalidateQueryKeys?: readonly (readonly unknown[])[];
  /**
   * Optional pre-flight that decides whether the GitHub-App *install* flow is
   * needed (a fresh org with no App installation) vs. the standard authorize
   * flow. Best-effort by contract: if it throws or cannot decide it MUST NOT
   * abort the connect — the flow falls back to a plain authorize open. This is
   * what keeps the Dashboard's install-mode pre-flight from ever producing a
   * silent dead click (FEA-3280): a broken/unavailable status read degrades to
   * a normal connect instead of returning with nothing opened.
   */
  resolveInstall?: () => Promise<boolean> | boolean;
};

/**
 * Shared connect-GitHub handler for the desktop surfaces that gate metrics on a
 * GitHub connection — the branch views (list + detail) and the Dashboard /
 * Insights KPI cards. Encapsulates the sign-in-if-unauthenticated →
 * `openGitHubConnect` → query-invalidation flow — including the
 * rejection-handling fallback — so future fixes to this flow land once instead
 * of being copy-pasted per surface (FEA-2782 / FEA-3280).
 *
 * On success the GitHub + branches (+ any caller-supplied) query caches are
 * invalidated so the open view re-hydrates once the connection is available. A
 * rejected sign-in / IPC call surfaces the `Failed` (or `SignInRequired`)
 * terminal state rather than leaking an unhandled rejection, pinning the status
 * at `Pending` forever, or — the Dashboard's old inline-copy bug — silently
 * returning so the click does nothing visible.
 *
 * Accepts either a plain `returnTo` string (branch views) or the full options
 * object (Dashboard/Insights, which add an `install`-mode pre-flight and extra
 * cache invalidations).
 */
export function useDesktopGitHubConnect(
  options: string | UseDesktopGitHubConnectOptions
): {
  connectState: DesktopGitHubConnectState;
  connectGitHub: () => Promise<void>;
} {
  const { returnTo, invalidateQueryKeys, resolveInstall } =
    typeof options === "string" ? { returnTo: options } : options;
  const auth = useDesktopAuth();
  const queryClient = useQueryClient();
  const { queryClient: branchesQueryClient } = useBranchesQueryContext();
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
      // Install-mode is best-effort: a throwing / unavailable pre-flight must
      // never abort the connect (that was the Dashboard dead-click, FEA-3280),
      // so it degrades to a plain authorize open.
      const install = await resolveInstallMode(resolveInstall);
      const result = await window.desktopApi.openGitHubConnect({
        ...(install ? { install: true } : {}),
        returnTo,
      });
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
    branchesQueryClient.invalidateQueries({ queryKey: branchesKeys.all });
    for (const queryKey of invalidateQueryKeys ?? []) {
      queryClient.invalidateQueries({ queryKey });
    }
    setConnectState(DesktopGitHubConnectState.Opened);
  }, [
    auth,
    branchesQueryClient,
    invalidateQueryKeys,
    queryClient,
    resolveInstall,
    returnTo,
  ]);

  return { connectState, connectGitHub };
}

/**
 * Resolves the install-mode pre-flight defensively: any rejection / thrown
 * error resolves to `false` (plain authorize) so a broken status read can never
 * turn the connect into a silent no-op.
 */
async function resolveInstallMode(
  resolveInstall: UseDesktopGitHubConnectOptions["resolveInstall"]
): Promise<boolean> {
  if (!resolveInstall) {
    return false;
  }
  try {
    return (await resolveInstall()) === true;
  } catch {
    return false;
  }
}
