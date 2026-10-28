import { GitHubConnectAction } from "../../github/lib/github-connect-action";

/**
 * ISS-10645 — which way out a STALLED Branches load offers, resolved from what
 * the reader's state actually is rather than from which shell is asking.
 *
 * The operator's ruling (2026-09-17): a stalled Branches read may simply have
 * nothing to show yet, and the honest next step depends on which of two readers
 * is looking. A guest has no account, so "create an account" is right. Someone
 * signed in without a GitHub connection ALREADY has an account, and telling them
 * to create one is wrong — their next step is connecting GitHub. Someone signed
 * in with GitHub connected has done everything asked, so the only honest
 * treatment is the plain ladder's Retry.
 *
 * Resolving on the STATE, not on the host, is what keeps ISS-10645's parity
 * claim true. A shell where one arm is unreachable — the web listing lives
 * inside the Clerk authenticated route group, so it never has a guest — simply
 * never resolves to it; that is a property of its reachable states, not a second
 * implementation to keep in step.
 */
export const BranchesStallCtaKind = {
  /** No account at all: offer sign-up. */
  CreateAccount: "create-account",
  /** An account, but no GitHub connection: offer the connect flow. */
  ConnectGitHub: "connect-github",
  /** Nothing to ask for; the shared ladder's Retry is the whole treatment. */
  None: "none",
} as const;
export type BranchesStallCtaKind =
  (typeof BranchesStallCtaKind)[keyof typeof BranchesStallCtaKind];

/** What the host observed about the reader, never a pre-chewed "show the CTA". */
export type BranchesStallCtaSignals = {
  /**
   * Does this reader have an account? Only a shell with a guest mode can
   * observe `false`; the rest never can, which is why the default is `true`.
   */
  hasAccount: boolean;
  /** Is GitHub connected for this reader? */
  isGitHubConnected: boolean;
};

/**
 * The default a host that says nothing gets: an account and a connection, so the
 * ladder offers Retry alone. Absent knowledge must not invent an ask — telling a
 * reader to sign up because the host forgot to report is the wrong-reader error
 * this resolver exists to avoid.
 */
export const DEFAULT_BRANCHES_STALL_CTA_SIGNALS: BranchesStallCtaSignals = {
  hasAccount: true,
  isGitHubConnected: true,
};

export function resolveBranchesStallCta({
  hasAccount,
  isGitHubConnected,
}: BranchesStallCtaSignals): BranchesStallCtaKind {
  if (!hasAccount) {
    return BranchesStallCtaKind.CreateAccount;
  }
  if (!isGitHubConnected) {
    return BranchesStallCtaKind.ConnectGitHub;
  }
  return BranchesStallCtaKind.None;
}

/**
 * The two signals, derived on both shells from the ONE question each shell's
 * GitHub status already answers ({@link resolveGitHubConnectAction}).
 *
 * Deliberately not a second read of the desktop auth context. `BranchesView`
 * reaching for `useDesktopAuth` directly is the ISS-5958 break — it takes down
 * every test site that mounts the view without that provider — and the connect
 * action already carries the session fact this needs: `SignUp` is the answer
 * only when there is no session behind the surface.
 *
 * `SignUp` is therefore "no account" HERE, which is wider than "a settled
 * guest": a sign-in in flight and a lapsed session are also sessionless. That is
 * safe because the account arm renders the HOST's own control, and the desktop
 * one gates itself on `canOfferAccount` — so a returning user whose session
 * lapsed is told to sign back in by the banner that owns that job, and this slot
 * shows them nothing rather than the wrong ask.
 */
export function resolveBranchesStallCtaSignals(
  githubConnectAction: GitHubConnectAction | null
): BranchesStallCtaSignals {
  return {
    hasAccount: githubConnectAction !== GitHubConnectAction.SignUp,
    // `null` is connected OR not yet known, and an unknown must not prompt
    // (ISS-5958). `SignUp` is sessionless, which the account arm above owns.
    isGitHubConnected:
      githubConnectAction === null ||
      githubConnectAction === GitHubConnectAction.SignUp,
  };
}
