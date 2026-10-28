import {
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { resolveGitHubDataConnected } from "@repo/api/src/types/github-data-connected";

/**
 * What a GitHub connect control actually DOES, so its label can state it
 * (ISS-5958 D1/D2). Installing the GitHub App across an org is deliberately not
 * a member: that stays an admin action reached from Settings and is never what a
 * connect CTA opens (ISS-5958 D3 follow-on).
 */
export const GitHubConnectAction = {
  /** No Closedloop session yet — the control starts GitHub account creation. */
  SignUp: "sign_up",
  /** Signed in with no GitHub data source at all — a personal authorization. */
  Connect: "connect",
  /** Signed in, but the user's own grant expired, was revoked, or needs re-consent. */
  Reconnect: "reconnect",
} as const;
export type GitHubConnectAction =
  (typeof GitHubConnectAction)[keyof typeof GitHubConnectAction];

/**
 * The actions a signed-in connect PROMPT can perform. `SignUp` is not one of
 * them: the prompt renders only once a session exists, and a signed-out surface
 * shows the account chooser instead.
 */
export type GitHubConnectPromptAction = Exclude<
  GitHubConnectAction,
  typeof GitHubConnectAction.SignUp
>;

/**
 * The connection answer a surface should GATE on, given its own auth state.
 *
 * Signed out is a definite `false`, not an unknown: with no session there is no
 * user grant and no org installation to read, and the status fetch that would
 * say so returns null and never resolves. Leaving that as `undefined` is what
 * let two surfaces answer one question differently (ISS-7866) — the dashboard
 * gated on the unread state and prompted, the Sessions strip refused to prompt
 * on anything but a definite absence and showed a bare dash. Signed IN, the
 * status is the only evidence there is, so `undefined` still means UNKNOWN and
 * still must not prompt (ISS-5958).
 */
export function resolveGitHubGateConnected({
  status,
  authenticated,
  authSettled = true,
}: {
  status: GitHubIntegrationStatus | null | undefined;
  authenticated: boolean;
  /**
   * Has the session reached a terminal state? Defaults to `true` for surfaces
   * with no in-flight phase to speak of (web mounts behind a resolved session).
   *
   * `false` means UNKNOWN regardless of everything else: mid sign-in handoff,
   * any GitHub status in hand predates the account we are about to have, and an
   * ask rendered on top of a running connect is a second live control for a
   * flow already in progress (whitlockk, ISS-7866 review).
   */
  authSettled?: boolean;
}): boolean | undefined {
  if (!authSettled) {
    return;
  }
  if (!authenticated) {
    return false;
  }
  return resolveGitHubDataConnected(status);
}

/**
 * The action a connect control should perform, or `null` when it must render
 * nothing — the user is connected through either source, or the connection is
 * not known yet. Returning `null` for an unknown state is what stops a surface
 * nagging a user whose org already has the App installed (ISS-5958).
 */
export function resolveGitHubConnectAction({
  status,
  authenticated,
}: {
  status: GitHubIntegrationStatus | null | undefined;
  authenticated: boolean;
}): GitHubConnectAction | null {
  if (!authenticated) {
    return GitHubConnectAction.SignUp;
  }
  if (resolveGitHubDataConnected(status) !== false) {
    return null;
  }
  const reasons = status?.githubDataConnection?.oauthRequiredReasons;
  if (reasons && hasGitHubUserGrantRecoveryReason(reasons)) {
    return GitHubConnectAction.Reconnect;
  }
  return GitHubConnectAction.Connect;
}

/**
 * Narrows a resolved action onto the two a signed-in prompt can render. A
 * `null` action (connected, or not known yet) and `SignUp` both fall to a
 * first-time connect: the prompt only renders behind a session, and it is
 * better to offer a connect the user does not need than to render a repair
 * prompt at someone whose grant is fine.
 */
export function resolveGitHubConnectPromptAction(
  action: GitHubConnectAction | null
): GitHubConnectPromptAction {
  return action === GitHubConnectAction.Reconnect
    ? GitHubConnectAction.Reconnect
    : GitHubConnectAction.Connect;
}

/**
 * Whether the user's OWN grant is the thing that broke — the repair states that
 * make this a reconnect rather than a first-time connect.
 */
export function hasGitHubUserGrantRecoveryReason(
  reasons: readonly GitHubOAuthRequiredReason[]
): boolean {
  return reasons.some(
    (reason) =>
      reason === GitHubOAuthRequiredReason.CredentialExpired ||
      reason === GitHubOAuthRequiredReason.CredentialRevoked ||
      reason === GitHubOAuthRequiredReason.CredentialInsufficientScope ||
      reason === GitHubOAuthRequiredReason.ReconsentRequired
  );
}

/**
 * Whether a status answers the connection question from the LEGACY field only.
 *
 * `connected` predates {@link GitHubDataConnectionStatus} and reports one thing:
 * whether the org has the GitHub App installed. It cannot see a user's own OAuth
 * grant, so its `false` is "no installation", never "this user has not
 * authorized GitHub". A surface that combines the gate with other evidence about
 * the user needs to know it is holding that narrower answer; a surface that only
 * gates on the predicate does not, which is why {@link resolveGitHubDataConnected}
 * still folds the two.
 */
export function isLegacyGitHubInstallationStatus(
  status: GitHubIntegrationStatus | null | undefined
): boolean {
  return (
    status?.connected !== undefined &&
    status.githubDataConnection?.connected === undefined
  );
}
