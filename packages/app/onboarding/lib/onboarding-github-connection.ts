/**
 * @file onboarding-github-connection.ts
 * @description ISS-8352: what onboarding knows about the visitor's GitHub
 * connection, and the typed completion signal the ISS-8349 transition engine
 * consumes.
 *
 * Connection truth comes from the server's guided snapshot or the canonical
 * integration-status gate in `../../github/lib/github-connect-action`. This
 * module reconciles those answers with account-provider provenance; it does
 * not infer a usable repo grant from a provider label alone.
 *
 * Order of authority, because the two inputs can disagree:
 *
 * 1. A modern Web snapshot that measured installation-or-registry status wins,
 *    including false while the separate status query is unread. A cached
 *    positive status may describe another org or predate revocation, so it
 *    cannot override that false.
 * 2. For an older snapshot without the measurement signal, the integration
 *    status takes precedence. Its legacy `connected: false` covers only the
 *    org's App installation, not a personal grant.
 * 3. Where that legacy gate did not settle the personal-grant question, a
 *    settled GitHub provider fills the gap. Mid-auth handoff it proves nothing.
 *    Anything still unresolved remains `unknown` rather than a fabricated
 *    connection or a prompt.
 */

import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type { ServerOnboardingContext } from "@repo/api/src/types/onboarding-guided";
import {
  AccountProvider,
  AccountStatus,
  type OnboardingContext,
  OnboardingHost,
} from "@repo/api/src/types/onboarding-phase";
import {
  isLegacyGitHubInstallationStatus,
  resolveGitHubConnectAction,
  resolveGitHubConnectPromptAction,
  resolveGitHubGateConnected,
} from "../../github/lib/github-connect-action";
import {
  type OnboardingGitHubConnection,
  OnboardingGitHubConnectionSource,
  UNKNOWN_GITHUB_CONNECTION,
} from "../components/guided-onboarding-data";

/** Everything the derivation reads. Hosts translate their platform into this. */
export type OnboardingGitHubConnectionInput = {
  /**
   * The provider identifier carried by the account payload, verbatim. Typed
   * `string` rather than {@link AccountProvider} on purpose: this is a boundary
   * value from an API response or a persisted record, so the types do not
   * constrain it at runtime and an unrecognised spelling has to be reachable.
   */
  accountProvider: string | null | undefined;
  /** The org's GitHub integration status, or `null`/`undefined` while unread. */
  status: GitHubIntegrationStatus | null | undefined;
  authenticated: boolean;
  /** Has the session reached a terminal state? `false` forces UNKNOWN. */
  authSettled?: boolean;
};

/**
 * The known providers, keyed by their own wire spelling. An exhaustive `Record`
 * over {@link AccountProvider} rather than an `includes` over an array, so
 * adding a member fails `tsc` here instead of silently parsing to `null` — the
 * side-inventory hole the repo's review lessons name.
 */
const KNOWN_ACCOUNT_PROVIDERS: Record<AccountProvider, AccountProvider> = {
  [AccountProvider.Email]: AccountProvider.Email,
  [AccountProvider.GitHub]: AccountProvider.GitHub,
  [AccountProvider.Google]: AccountProvider.Google,
};

/**
 * The provider that established the account, or `null` when the payload names
 * one this build does not know.
 *
 * `null` is deliberately the same answer for "no provider" and "a provider
 * from a newer or older peer". Neither entitles onboarding to treat the GitHub
 * step as satisfied, and a cross-repo payload is exactly where an unknown value
 * arrives (ISS-8352 acceptance: "Old/unknown provider payloads fall back to
 * incomplete, not complete").
 */
export function parseAccountProvider(
  raw: string | null | undefined
): AccountProvider | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  // An own-key check, not a bare index. `KNOWN_ACCOUNT_PROVIDERS["__proto__"]`
  // on an object literal resolves to `Object.prototype`, which is neither
  // `undefined` nor a provider, so `?? null` would not fire and a hostile wire
  // value would leave here as an object typed `AccountProvider`.
  return Object.hasOwn(KNOWN_ACCOUNT_PROVIDERS, raw)
    ? KNOWN_ACCOUNT_PROVIDERS[raw as AccountProvider]
    : null;
}

/**
 * What the GitHub step should render: connected, a specific connect action, or
 * an honest "not known yet". `unknown` is kept distinct from `disconnected`
 * because they are different claims and only one of them may show a prompt.
 */
export function deriveOnboardingGitHubConnection(
  input: OnboardingGitHubConnectionInput
): OnboardingGitHubConnection {
  const gateConnected = resolveGitHubGateConnected({
    authSettled: input.authSettled,
    authenticated: input.authenticated,
    status: input.status,
  });
  if (gateConnected === true) {
    return {
      source: OnboardingGitHubConnectionSource.Grant,
      status: "connected",
    };
  }
  if (isGitHubSignInSufficient(input, gateConnected)) {
    return {
      source: OnboardingGitHubConnectionSource.AccountProvider,
      status: "connected",
    };
  }
  if (gateConnected === undefined) {
    return UNKNOWN_GITHUB_CONNECTION;
  }
  return disconnectedConnection(input.authenticated, input.status);
}

/**
 * The slice of the engine's {@link OnboardingContext} this ticket produces.
 *
 * Returned as a `Pick` of the engine's own type rather than a new shape, so the
 * two cannot drift: `requiresGitHubStep` and the completion card's
 * `isStepOutstanding` both read these exact fields, and ISS-8349 is the owner
 * of what they mean.
 */
export function resolveOnboardingGitHubContext(
  input: OnboardingGitHubConnectionInput
): Pick<OnboardingContext, "accountProvider" | "githubConnected"> {
  return {
    accountProvider: parseAccountProvider(input.accountProvider),
    githubConnected:
      deriveOnboardingGitHubConnection(input).status === "connected",
  };
}

/**
 * Whether the sign-in provider alone settles the step, given what the gate was
 * able to measure. It does in exactly two states, and in neither of them has
 * anything looked at the user's own OAuth grant and found it missing:
 *
 * - The gate is UNKNOWN and the session has SETTLED. Mid handoff the provider
 *   string still names the account being left behind, so it establishes nothing
 *   (whitlockk, ISS-8352 review).
 * - The gate said `false` from a LEGACY payload. That field only ever reported
 *   the org's App installation, so its `false` means "not installed" and cannot
 *   contradict a GitHub sign-in — reading it as one prompts a version-skewed
 *   client's GitHub-auth user to authorize GitHub again (davetho, ISS-8352
 *   review). A signed-out visitor is excluded: there is no sign-in to trust.
 *
 * A modern `githubDataConnection.connected === false` wins here because the
 * registry and installation checks found no usable source. It does not prove
 * Clerk has no live token that a later link sync could materialize.
 */
function isGitHubSignInSufficient(
  input: OnboardingGitHubConnectionInput,
  gateConnected: boolean | undefined
): boolean {
  if (
    input.authSettled === false ||
    parseAccountProvider(input.accountProvider) !== AccountProvider.GitHub
  ) {
    return false;
  }
  if (gateConnected === undefined) {
    return true;
  }
  return input.authenticated && isLegacyGitHubInstallationStatus(input.status);
}

/**
 * Reconcile the guided snapshot with the separate integration-status read.
 * The modern snapshot measured installation-or-registry status, so its false
 * remains actionable while the second read is pending or failed. The second
 * read can be cached for another org or predate revocation, so it cannot
 * override that measured false. The link route returns through a full document
 * navigation, so the next guided mount fetches the server's current answer.
 * Older snapshots omit the measurement signal and retain the provider fallback.
 */
export function deriveGuidedOnboardingGitHubConnection({
  context,
  host,
  status,
}: {
  context: ServerOnboardingContext | null | undefined;
  host: OnboardingHost;
  status: GitHubIntegrationStatus | null | undefined;
}): OnboardingGitHubConnection {
  const authenticated = context?.accountStatus === AccountStatus.Established;
  if (context?.githubConnected === true) {
    return {
      source: OnboardingGitHubConnectionSource.Grant,
      status: "connected",
    };
  }
  if (
    host === OnboardingHost.Web &&
    context?.githubDataConnectionStatusMeasured === true &&
    context.githubConnected === false
  ) {
    return disconnectedConnection(authenticated, status);
  }
  return deriveOnboardingGitHubConnection({
    accountProvider: context?.accountProvider,
    authenticated,
    status,
  });
}

function disconnectedConnection(
  authenticated: boolean,
  status: GitHubIntegrationStatus | null | undefined
): OnboardingGitHubConnection {
  return {
    action: resolveGitHubConnectPromptAction(
      resolveGitHubConnectAction({ authenticated, status })
    ),
    status: "disconnected",
  };
}
