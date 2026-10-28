import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { CLERK_OAUTH_STRATEGY } from "./clerk-oauth-strategy";

/**
 * @file sign-in-methods.ts
 * @description Derives a user's SIGN-IN METHODS from their OAuth identities
 * (ISS-8364). Pure and SDK-free — plain records in, plain records out — so the
 * Settings Profile panel in `apps/app` and onboarding in `packages/app` share
 * one derivation instead of each keying on Clerk resources itself. That sharing
 * is the ticket's "provider state adapters shared with onboarding through
 * canonical APIs, not UI imports".
 *
 * WHAT THIS IS NOT. It does not answer "is GitHub connected" in the
 * data-flow sense. That fact has one owner, `resolveGitHubGateConnected`
 * (`packages/app/github/lib/github-connect-action.ts`), which reads the ORG
 * GitHub App integration and the user's OAuth grant together. "GitHub is one of
 * my sign-in methods" and "GitHub data flows into this workspace" are different
 * facts with different remedies, and folding them would give Settings a second
 * copy of onboarding's state machine — the thing AC1 forbids.
 */

/**
 * The three states a sign-in method can be in. `Unverified` is deliberately not
 * folded into either neighbour: an OAuth identity that exists but never
 * completed consent is a stale earlier attempt, whose remedy is "try again",
 * not "connect" and certainly not "you are connected".
 */
export const SignInMethodStatus = {
  Connected: "connected",
  Unverified: "unverified",
  Disconnected: "disconnected",
} as const;

export type SignInMethodStatus =
  (typeof SignInMethodStatus)[keyof typeof SignInMethodStatus];

/**
 * The provider-shaped subset of an OAuth identity this derivation needs. Named
 * structurally rather than as a Clerk type so `packages/app`, which is banned
 * from importing `@clerk/**`, can own the rule.
 */
export type SignInExternalAccount = {
  provider: string;
  /** Clerk types this non-optional and it can be `""` — never a detail. */
  emailAddress?: string;
  username?: string;
  /**
   * Clerk's `verification.status`. Nullable as well as optional: Clerk types
   * `verification` itself as nullable, so an account with no verification
   * record yields `null` here and must read as unverified, not as absent input.
   */
  verificationStatus?: string | null;
};

export type SignInMethodConnection = {
  provider: string;
  status: SignInMethodStatus;
  /** Username or email identifying the account, or null when neither is usable. */
  detail: string | null;
  /**
   * True only when this provider is CONNECTED and was the last authentication
   * strategy. Both halves are required: the strategy marker outlives the
   * account it names, so it alone would badge a disconnected row.
   */
  isCurrentSignIn: boolean;
  /** False for a provider outside the known set, which still renders. */
  isKnownProvider: boolean;
};

export type DeriveSignInMethodsInput = {
  accounts: readonly SignInExternalAccount[];
  /**
   * Clerk's `client.lastAuthenticationStrategy`. `null` when the client has no
   * record of one — which badges NOTHING, rather than guessing at the single
   * connected account.
   */
  lastAuthenticationStrategy: string | null;
};

const VERIFIED_STATUS = "verified";

const KNOWN_SIGN_IN_PROVIDERS: readonly string[] = Object.values(
  DesktopSignInProvider
);

/**
 * The Clerk `oauth_*` strategy for a provider. Reads the canonical map for the
 * providers this repo owns so the two spellings cannot drift, and falls back to
 * Clerk's own `oauth_<provider>` construction for a provider outside that set —
 * which is the only way an unknown provider can ever be badged as the current
 * sign-in.
 */
function oauthStrategyFor(provider: string): string {
  return Object.hasOwn(CLERK_OAUTH_STRATEGY, provider)
    ? CLERK_OAUTH_STRATEGY[provider as DesktopSignInProvider]
    : `oauth_${provider}`;
}

function detailFor(account: SignInExternalAccount): string | null {
  return account.username || account.emailAddress || null;
}

function isVerified(account: SignInExternalAccount): boolean {
  return account.verificationStatus === VERIFIED_STATUS;
}

function statusFor(account: SignInExternalAccount | undefined) {
  if (account === undefined) {
    return SignInMethodStatus.Disconnected;
  }
  return isVerified(account)
    ? SignInMethodStatus.Connected
    : SignInMethodStatus.Unverified;
}

/**
 * True only when `strategy` is the OAuth strategy for exactly this provider.
 * A `null` strategy, or a non-OAuth one (password, email code, passkey), names
 * no provider and must not badge one — badging the only connected account for a
 * password sign-in would be wrong, not merely imprecise.
 */
function isCurrentSignInProvider(
  provider: string,
  strategy: string | null
): boolean {
  return strategy === oauthStrategyFor(provider);
}

/**
 * Which of a provider's accounts a row DISPLAYS.
 *
 * Clerk can hold more than one identity per provider. A VERIFIED one wins over
 * an unverified one regardless of arrival order: first-wins lets a stale
 * abandoned attempt report the provider the user is actually signed in with as
 * "Not finished".
 *
 * Display-only, and deliberately not exported. The MUTATION side picks no
 * single account at all — a row is about a PROVIDER, so Disconnect and Finish
 * connecting act on every identity for it. Sharing this rule with them is what
 * leaves the unchosen duplicates connected after a removal the dialog already
 * reported as done.
 */
function selectSignInAccount(
  accounts: readonly SignInExternalAccount[],
  provider: string
): SignInExternalAccount | undefined {
  let chosen: SignInExternalAccount | undefined;
  for (const account of accounts) {
    if (account.provider !== provider) {
      continue;
    }
    if (chosen === undefined || (!isVerified(chosen) && isVerified(account))) {
      chosen = account;
    }
  }
  return chosen;
}

function connectionFor(
  provider: string,
  account: SignInExternalAccount | undefined,
  input: DeriveSignInMethodsInput
): SignInMethodConnection {
  const status = statusFor(account);
  return {
    provider,
    status,
    detail: account ? detailFor(account) : null,
    // Gated on Connected. `client.lastAuthenticationStrategy` is a HISTORICAL
    // marker that removing an account does not clear, so an ungated read badges
    // "Current sign-in" on a row already reading "Available" — reachable the
    // moment this panel disconnects the provider the session was started with.
    isCurrentSignIn:
      status === SignInMethodStatus.Connected &&
      isCurrentSignInProvider(provider, input.lastAuthenticationStrategy),
    isKnownProvider: KNOWN_SIGN_IN_PROVIDERS.includes(provider),
  };
}

/**
 * Every known provider in contract order, followed by any OAuth identity the
 * user actually holds outside that set.
 *
 * The trailing half is load-bearing: keying strictly on the known set would
 * silently drop a real, verified identity from a section titled "Sign-in
 * methods", which is a UI lying by omission about how the reader can get into
 * their own account. An unknown provider renders generically instead.
 */
export function deriveSignInMethods(
  input: DeriveSignInMethodsInput
): SignInMethodConnection[] {
  const known = KNOWN_SIGN_IN_PROVIDERS.map((provider) =>
    connectionFor(
      provider,
      selectSignInAccount(input.accounts, provider),
      input
    )
  );

  const unknown = unknownProvidersIn(input.accounts).map((provider) =>
    connectionFor(
      provider,
      selectSignInAccount(input.accounts, provider),
      input
    )
  );

  return [...known, ...unknown];
}

/** Providers the user holds an identity for that the contract does not name. */
function unknownProvidersIn(
  accounts: readonly SignInExternalAccount[]
): string[] {
  const seen: string[] = [];
  for (const account of accounts) {
    if (
      !(
        KNOWN_SIGN_IN_PROVIDERS.includes(account.provider) ||
        seen.includes(account.provider)
      )
    ) {
      seen.push(account.provider);
    }
  }
  return seen;
}
