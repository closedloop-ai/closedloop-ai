"use client";

import {
  GitHubConnectAction,
  resolveGitHubConnectAction,
} from "../lib/github-connect-action";
import type { GitHubConnectTarget } from "../lib/github-connect-target";
import { useGitHubIntegrationStatus } from "./use-github-integration";

/**
 * The connect action a surface should offer, or `null` when it must offer none
 * (ISS-5958 D1/D2).
 *
 * `authenticated` comes from the surface's OWN session — the route context on
 * web, `useDesktopAuth` on desktop — and is never inferred from the presence of
 * a GitHub status, which says nothing about whether a Closedloop session sits
 * behind it. The status read is skipped while signed out: a signed-out cloud
 * request short-circuits to 401 in both shells, and the answer is `SignUp`
 * whatever a status would have said.
 *
 * `enabled: false` skips the read on a surface that cannot render a connect
 * control on this pass. An unread status is UNKNOWN, which resolves to `null` —
 * the same answer as a read still in flight, and the callers below turn it into
 * a first-time connect.
 */
export function useGitHubConnectAction(
  authenticated: boolean,
  { enabled = true }: { enabled?: boolean } = {}
): GitHubConnectAction | null {
  const status = useGitHubIntegrationStatus({
    enabled: authenticated && enabled,
  });
  return resolveGitHubConnectAction({ status: status.data, authenticated });
}

/**
 * The connect target for a surface that OWNS the connect action — the desktop
 * views, whose click runs an IPC handoff rather than a navigation.
 *
 * A gated affordance only renders while the connection is missing, so a `null`
 * action (connected, or not known yet) never reaches a rendered CTA; a
 * first-time connect is the honest wording if one ever does.
 *
 * `action` is for a surface that ALREADY resolved one from a status it holds —
 * the desktop Insights provider reads its status over IPC, and Settings →
 * Account reads it once for the whole panel. Passing it also stops this hook
 * reading a status of its own, which is the point: one surface answers from ONE
 * source, so its gating and its wording cannot contradict each other.
 */
export function useGitHubConnectActionTarget({
  authenticated,
  onConnect,
  action,
}: {
  authenticated: boolean;
  onConnect: () => void | Promise<void>;
  action?: GitHubConnectAction | null;
}): GitHubConnectTarget {
  const ownAction = useGitHubConnectAction(authenticated, {
    enabled: action === undefined,
  });
  const resolved = action === undefined ? ownAction : action;
  return { action: resolved ?? GitHubConnectAction.Connect, onConnect };
}

/**
 * The connect target for a surface that NAVIGATES instead — the web shell, where
 * OAuth keeps native link semantics and must not prefetch.
 *
 * The read is unconditional on purpose. Gating it on whether the CTA renders
 * sounds free, but those are the same instant: the control would paint the
 * first-time verb and swap to `Reconnect` a roundtrip later, which is the D2
 * collapse this work exists to prevent, arriving late (decided 2026-08-21).
 */
export function useGitHubConnectHrefTarget({
  authenticated,
  href,
}: {
  authenticated: boolean;
  href: string;
}): GitHubConnectTarget {
  const action = useGitHubConnectAction(authenticated);
  return { action: action ?? GitHubConnectAction.Connect, href };
}
