import { useBranchesQueryContext } from "@repo/app/branches/data-source/provider";
import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import {
  useGitHubConnectAction,
  useGitHubConnectActionTarget,
} from "@repo/app/github/hooks/use-github-connect-action";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import type { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import type {
  DesktopBrowserSignInResult,
  GitHubConnectOpenRequest,
} from "../../types/desktop-api";

/**
 * Connect-GitHub flow state shared by the desktop branch views. Mirrors the
 * outcomes of {@link useDesktopGitHubConnect}: idle before any attempt or after
 * the user declines the browser's account (ISS-11345), pending
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
   * The connect action, when the surface already resolved one from a status it
   * holds (ISS-5958). Passing it stops this hook reading a status of its own, so
   * that surface gates and words its CTA from a single source.
   */
  connectAction?: GitHubConnectAction | null;
  /**
   * Ask the main process to bring Desktop back to the front once the connect
   * lands in the browser. First-time onboarding sets it: that run continues in
   * Desktop, not on the web page the connect ends on.
   */
  returnToDesktop?: boolean;
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
 * invalidated so the open view re-hydrates once the connection is available.
 * Each leg reports its OWN outcome (ISS-10411): a sign-in that fails or
 * rejects settles as `SignInRequired`, and only the connect handoff settles as
 * `Failed` — rather than leaking an unhandled rejection, pinning the status at
 * `Pending` forever, or — the Dashboard's old inline-copy bug — silently
 * returning so the click does nothing visible.
 *
 * Accepts either a plain `returnTo` string (branch views) or the full options
 * object (Dashboard/Insights, which add extra cache invalidations). Every open
 * is a personal authorize — there is no install-mode pre-flight to opt into
 * (ISS-5958 D3 follow-on).
 */
export function useDesktopGitHubConnect(
  options: string | UseDesktopGitHubConnectOptions
): {
  connectState: DesktopGitHubConnectState;
  connectGitHub: () => Promise<void>;
  connectTarget: GitHubConnectTarget;
  /**
   * ISS-10645: the RAW resolved action — `null` when the reader is connected or
   * the status has not landed. `connectTarget.action` cannot answer that: it
   * floors a `null` to a first-time connect so a rendered CTA always has a verb,
   * which is right for wording and wrong for gating.
   */
  connectAction: GitHubConnectAction | null;
} {
  const { returnTo, invalidateQueryKeys, connectAction, returnToDesktop } =
    typeof options === "string" ? { returnTo: options } : options;
  const auth = useDesktopAuth();
  const queryClient = useQueryClient();
  const { queryClient: branchesQueryClient } = useBranchesQueryContext();
  const [connectState, setConnectState] = useState<DesktopGitHubConnectState>(
    DesktopGitHubConnectState.Idle
  );
  // ISS-10990 review (whitlockk): this outcome is per-hook-instance state, and not
  // every host that reads it is keyed by account —
  // `DesktopGuidedOnboardingDialogHost` deliberately survives a sign-out and an
  // organization switch. Without this, a handoff account A's reader was refused
  // greets account B before it has tried anything. Settled here rather than at
  // one host: the state is this hook's, so every surface that renders it gets
  // the same answer.
  //
  // Keyed on the TRANSITION INTO signed-out rather than on the identity itself,
  // because the sign-in leg changes the identity mid-attempt: a reader who
  // clicks Connect while signed out signs in and only then runs the handoff, and
  // that handoff's refusal is that reader's own. Reaching another account always
  // passes through signed-out; the sign-in leg only ever leaves it.
  const [signedOut, setSignedOut] = useState(
    auth.state.status !== "authenticated"
  );
  const nowSignedOut = auth.state.status !== "authenticated";
  if (signedOut !== nowSignedOut) {
    setSignedOut(nowSignedOut);
    if (nowSignedOut) {
      setConnectState(DesktopGitHubConnectState.Idle);
    }
  }

  const connectGitHub = useCallback(async () => {
    setConnectState(DesktopGitHubConnectState.Pending);
    // ISS-10411: the two legs settle SEPARATELY. One click runs a device
    // authorization and then a GitHub connect, and they can end differently —
    // so a rejection is attributed to the leg that actually threw. A single
    // try around both used to report a failed sign-in as "GitHub connect could
    // not be opened", which is the collapse PRD-742 item 3 names: the step that
    // broke and the step named on screen were not the same step.
    if (auth.state.status !== "authenticated") {
      let signIn: DesktopBrowserSignInResult | null = null;
      try {
        // ISS-11345: the browser decides which account comes back, and on a
        // shared browser that can be someone else's — so the user confirms it
        // before Desktop adopts it.
        signIn = await auth.beginSignIn(undefined, undefined, undefined, {
          confirmAccount: true,
        });
      } catch {
        signIn = null;
      }
      if (!signIn?.ok) {
        // ISS-11345, Perrin Upcott's ruling (2026-10-02): a Cancel in the
        // account confirmation returns quietly, with no failure banner.
        setConnectState(
          signIn?.reason === "declined"
            ? DesktopGitHubConnectState.Idle
            : DesktopGitHubConnectState.SignInRequired
        );
        return;
      }
    }
    try {
      // ISS-5958 D3 follow-on: a connect CTA is always a personal authorize, so
      // no `install` flag is sent. The main process still ACCEPTS the field for
      // older renderers; only this sender is gone.
      const result = await window.desktopApi.openGitHubConnect(
        githubConnectOpenRequest(returnTo, returnToDesktop)
      );
      if (!result.ok) {
        setConnectState(DesktopGitHubConnectState.Failed);
        return;
      }
    } catch {
      // A rejected IPC call must surface the "could not be opened" fallback
      // rather than leaking an unhandled rejection and pinning the status at
      // Pending forever.
      setConnectState(DesktopGitHubConnectState.Failed);
      return;
    }
    // The connect CTA reports Opened as soon as the browser hand-off succeeds,
    // so these refreshes are deliberately not awaited; a refetch that fails
    // surfaces through its own query's error state.
    queryClient
      .invalidateQueries({ queryKey: githubKeys.all })
      .catch(() => undefined);
    branchesQueryClient
      .invalidateQueries({ queryKey: branchesKeys.all })
      .catch(() => undefined);
    for (const queryKey of invalidateQueryKeys ?? []) {
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    }
    setConnectState(DesktopGitHubConnectState.Opened);
  }, [
    auth,
    branchesQueryClient,
    invalidateQueryKeys,
    queryClient,
    returnTo,
    returnToDesktop,
  ]);

  // ISS-5958 D1/D2: what this control SAYS is decided here, beside what it
  // does, because this hook is the only thing that already knows both halves —
  // the session it signs in when absent, and the grant state behind the status.
  // A view resolving that for itself would have to reach for the desktop auth
  // context a second time, on surfaces that only ever needed the connect flow.
  const authenticated = auth.state.status === "authenticated";
  // Resolved HERE rather than inside the target hook so the gate and the wording
  // read one answer. Handing the result straight back in turns that hook's own
  // read off, so this is still exactly one status read (ISS-10645).
  const ownAction = useGitHubConnectAction(authenticated, {
    enabled: connectAction === undefined,
  });
  const resolvedAction =
    connectAction === undefined ? ownAction : connectAction;
  const connectTarget = useGitHubConnectActionTarget({
    action: resolvedAction,
    authenticated,
    onConnect: connectGitHub,
  });

  return {
    connectState,
    connectGitHub,
    connectTarget,
    connectAction: resolvedAction,
  };
}

/**
 * The opener request. `returnToDesktop` is sent only when asked for, so every
 * other surface keeps sending the shape it always has.
 */
function githubConnectOpenRequest(
  returnTo: string,
  returnToDesktop: boolean | undefined
): GitHubConnectOpenRequest {
  return returnToDesktop === true
    ? { returnTo, returnToDesktop }
    : { returnTo };
}
