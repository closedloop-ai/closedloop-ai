import {
  type GitHubRepository as SharedGitHubRepository,
  GitHubRepositorySource as SharedGitHubRepositorySource,
} from "@closedloop-ai/loops-api/github";
import type { ChecksStatus, ReviewDecision } from "./branch-checks.js";
import type {
  GitHubBundledPullRequestsStopReason,
  GitHubReadModelPageInfo,
} from "./github-read-model.js";
import {
  GitHubPRState as SharedGitHubPRState,
  StatusCheckRollupFailureReason as SharedStatusCheckRollupFailureReason,
  type StatusCheckRollupState as SharedStatusCheckRollupState,
} from "./github-status.js";
import type {
  RepositoryDefaultAuthority,
  RepositoryDefaultUnavailableObservation,
} from "./repository-default-identity.js";

/**
 * GitHub integration types for API contract.
 * Used by both apps/api (backend) and apps/app (frontend).
 */

export type ConnectGitHubAccountInfo = {
  accountId: string;
  accountLogin: string;
};

/**
 * Response from POST /integrations/github/connect.
 *
 * The `requires_confirmation` variant is emitted when an org reconnects to a
 * different GitHub account than was previously linked. The frontend collects
 * explicit admin confirmation before invoking the cleanup endpoint (PLN-634).
 */
export type ConnectGitHubResponse =
  | { connected: true; backfill?: { status: GitHubBackfillStatus } }
  | {
      connected: false;
      status: "requires_confirmation";
      priorAccount: ConnectGitHubAccountInfo;
      newAccount: ConnectGitHubAccountInfo;
      newInstallationId: string;
    };

export const GitHubInstallationStatus = {
  PendingClaim: "PENDING_CLAIM",
  Active: "ACTIVE",
  Suspended: "SUSPENDED",
  Uninstalled: "UNINSTALLED",
} as const;
export type GitHubInstallationStatus =
  (typeof GitHubInstallationStatus)[keyof typeof GitHubInstallationStatus];

export type GitHubInstallationInfo = {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  status: GitHubInstallationStatus;
  repositorySelection: string | null;
  repositoryCount: number;
  claimedAt: string | null;
  createdAt: string;
};

/**
 * Data source that can satisfy GitHub-truth product surfaces. This is separate
 * from the legacy installation status because org data can be backed by a
 * synced user OAuth token even when the GitHub App is not installed.
 */
export const GitHubDataConnectionSource = {
  GitHubApp: "github_app",
  UserOAuth: "user_oauth",
} as const;
export type GitHubDataConnectionSource =
  (typeof GitHubDataConnectionSource)[keyof typeof GitHubDataConnectionSource];

/**
 * Reasons a browser OAuth launch may still be needed before GitHub-truth data
 * can be refreshed. `ReconsentRequired` is emitted with insufficient-scope
 * tokens because the recovery path is another GitHub consent screen.
 */
export const GitHubOAuthRequiredReason = {
  NoAppInstallation: "no_app_installation",
  NoUserGrant: "no_user_grant",
  CredentialExpired: "credential_expired",
  CredentialRevoked: "credential_revoked",
  CredentialInsufficientScope: "credential_insufficient_scope",
  ReconsentRequired: "reconsent_required",
} as const;
export type GitHubOAuthRequiredReason =
  (typeof GitHubOAuthRequiredReason)[keyof typeof GitHubOAuthRequiredReason];

export type GitHubDataConnectionStatus = {
  connected: boolean;
  sources: GitHubDataConnectionSource[];
  oauthRequiredReasons: GitHubOAuthRequiredReason[];
};

type GitHubDataConnectionCarrier = {
  /**
   * Additive data-connection predicate for GitHub-truth UI gating. Older API
   * responses omit it; consumers should fall back to legacy `connected`.
   */
  githubDataConnection?: GitHubDataConnectionStatus;
};

export type GitHubIntegrationStatus =
  | ({
      connected: true;
      installation: GitHubInstallationInfo;
    } & GitHubDataConnectionCarrier)
  | ({
      connected: false;
    } & GitHubDataConnectionCarrier);

export type DisconnectGitHubResponse = {
  disconnected: true;
};

/**
 * Response from POST /integrations/github/connect/confirm-reset.
 * Indicates the admin-confirmed different-account cleanup ran successfully.
 */
export type ConfirmDifferentAccountResetResponse = {
  confirmed: true;
};

export const GitHubBackfillStatus = {
  Completed: "completed",
  DryRunCompleted: "dry_run_completed",
  NotStarted: "not_started",
  OwnerApprovalRequired: "owner_approval_required",
  /**
   * ISS-7408: Apply-mode backfill was accepted and is running off the request
   * path. It is a claim about the RUN, not about the data — no counts exist
   * yet, which is why the 202 carries this status instead of a zeroed summary.
   * Resolves to a terminal status on the next `GET /integrations/github/backfill`.
   */
  Running: "running",
  Degraded: "degraded",
} as const;
export type GitHubBackfillStatus =
  (typeof GitHubBackfillStatus)[keyof typeof GitHubBackfillStatus];

export const GitHubBackfillMode = {
  DryRun: "dry_run",
  Apply: "apply",
} as const;
export type GitHubBackfillMode =
  (typeof GitHubBackfillMode)[keyof typeof GitHubBackfillMode];

export type GitHubBackfillSummary = {
  status: GitHubBackfillStatus;
  repositoryCount: number;
  branchCount: number;
  pullRequestCount: number;
  branchProjectionChangeCount: number;
  pullRequestProjectionChangeCount: number;
  /** Additive dry-run/apply count for immutable PR lifecycle atom rows. */
  lifecycleAtomProjectionChangeCount?: number;
  /** Additive dry-run/apply count for monotonic Branch Last-active writes. */
  branchLastActivityProjectionChangeCount?: number;
  reviewDecisionProjectionChangeCount: number;
  checkProjectionChangeCount: number;
  issueCommentProjectionChangeCount: number;
  reviewCommentProjectionChangeCount: number;
  reviewThreadProjectionChangeCount: number;
  reviewProjectionChangeCount: number;
  statusCheckProjectionChangeCount: number;
  skippedBranchCount: number;
  dryRun: boolean;
  ownerApprovalRequired: boolean;
  failures: string[];
};

export type GitHubBackfillResponse = {
  summary: GitHubBackfillSummary;
};

export type GitHubRepository = SharedGitHubRepository & {
  /** Additive provider authority; omitted for legacy or incomplete rows. */
  repositoryDefaultAuthority?: RepositoryDefaultAuthority;
};

export type GetRepositoriesResponse = GitHubRepository[];

export type GitHubBranch = {
  name: string;
  committedDate: string;
  isDefault: boolean;
};

export type GetBranchesResponse = {
  branches: GitHubBranch[];
  /** True when the provider reported more branch pages after this bounded read. */
  hasMore?: boolean;
  /**
   * True when the read stopped on its own page ceiling before satisfying the
   * requested limit. Only producers that can observe the provider's more-pages
   * signal set it, so absence means "no truncation reported" rather than proof
   * that the list is exhaustive.
   */
  truncated?: boolean;
};

export const GitHubPRState = SharedGitHubPRState;
export type GitHubPRState = (typeof GitHubPRState)[keyof typeof GitHubPRState];

/** User-facing labels for GitHub pull request lifecycle states. */
export const GITHUB_PR_STATE_LABELS: Record<GitHubPRState, string> = {
  [GitHubPRState.Open]: "Open",
  [GitHubPRState.Merged]: "Merged",
  [GitHubPRState.Closed]: "Closed",
};

export type GitHubPullRequestSummary = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  /**
   * The PR's own base ref; `""` means no producer measured one (ISS-8155). Not
   * widened to `| null`: installed Desktop builds validate it with `z.string()`
   * and fail Branch hydration closed on a null.
   */
  baseBranch: string;
  headSha: string | null;
  state: GitHubPRState;
  isDraft: boolean;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  updatedAt: string;
  /**
   * The PR author's login; `""` means unattributed (ISS-8155). It replaced a
   * literal `"unknown"`, which a real GitHub account can hold, so an absence
   * read as a measurement. Same `z.string()` skew constraint as `baseBranch`.
   */
  author: string;
  /**
   * CI rollup for this PR's head. Absent means unmeasured — the PR is superseded
   * on its branch, or no producer has reached it. Never default it to a passing,
   * failing, or "no checks" state (ISS-8155 absent-value contract).
   */
  checksStatus?: ChecksStatus | null;
  reviewDecision?: ReviewDecision | null;
  /** Additive fork-head authority, independent from the selected/base repository. */
  headRepository?: RepositoryDefaultAuthority;
  /** Typed fork-head absence when the provider cannot expose its identity. */
  headRepositoryUnavailable?: RepositoryDefaultUnavailableObservation;
  /**
   * ISS-12344: the head GitHub itself reported, set only when it lives in this
   * PR's repository (`gitHubConfirmedHeadBranch`). `headBranch` can instead be
   * the filing Branch's name. Omitted when unconfirmed, never null; installed
   * Desktop builds pass unknown keys through and ignore it.
   */
  gitHubHeadBranch?: string;
};

export type TrackedGitHubBranch = {
  branchName: string;
  branchKey: string;
  htmlUrl: string;
  pullRequestUrl: string | null;
};

/** Optional targeting breadth for repository pull-request reads. */
export const GitHubPullRequestTrackingScope = {
  Organization: "organization",
  Project: "project",
} as const;
export type GitHubPullRequestTrackingScope =
  (typeof GitHubPullRequestTrackingScope)[keyof typeof GitHubPullRequestTrackingScope];

export type GetPullRequestsResponse = {
  pullRequests: GitHubPullRequestSummary[];
  /** True when the provider has additional PR pages after this bounded read. */
  hasMore?: boolean;
  /** True when the response should not be treated as repository-exhaustive. */
  truncated?: boolean;
  /** Cursor metadata for the bounded provider read. */
  pageInfo?: GitHubReadModelPageInfo;
  /** Why the bounded provider read stopped. */
  stopReason?: GitHubBundledPullRequestsStopReason;
  /** Target PR numbers that were not found before paging stopped. */
  missingTargetNumbers?: number[];
  /** True when tracked-target discovery itself exceeded its bounded window. */
  targetDiscoveryTruncated?: boolean;
  /** PR htmlUrl values already tracked by branch current PR detail. */
  trackedPrUrls: string[];
  /** Branch artifacts already tracked for this repository/project. */
  trackedBranches?: TrackedGitHubBranch[];
  /** Stable repository-scoped keys for tracked branches. */
  trackedBranchKeys?: string[];
};

export const GitHubRepositorySource = SharedGitHubRepositorySource;
export type GitHubRepositorySource =
  (typeof GitHubRepositorySource)[keyof typeof GitHubRepositorySource];

/** Exact reason taxonomy for unavailable GitHub status-check rollup reads. */
export const StatusCheckRollupFailureReason =
  SharedStatusCheckRollupFailureReason;
export type StatusCheckRollupFailureReason =
  (typeof StatusCheckRollupFailureReason)[keyof typeof StatusCheckRollupFailureReason];

/** GitHub aggregate statusCheckRollup states preserved at the provider edge. */
export type StatusCheckRollupState = SharedStatusCheckRollupState;

/**
 * PostHog rollout key gating the public GitHub repositories feature. Shared by
 * the Settings UI (which hides the management section) and the API routes (which
 * fail closed on add/remove/merge) so the dark-launched feature stays unreachable
 * outside the flag on every surface.
 */
export const PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY =
  "public-github-repos" as const;

export type PublicRepository = {
  id: string;
  url: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  lastPushedAt: string | null;
};

export type CreatePublicRepositoryInput = {
  url: string;
};

export type PublicRepositoryResponse = PublicRepository;

export type DeletePublicRepositoryResponse = {
  deleted: true;
};

/**
 * Which credential a resolved GitHub client is authenticated with (PLN-1525).
 * Exposed on the client deliberately: a fallback from the OAuth App token to
 * the GitHub App user token can return less data for the same request, and
 * callers/logs need to be able to say so.
 *
 * `OauthUser` (the Clerk-sourced OAuth App token) is the planned primary for
 * user-attributed reads and becomes resolvable once the Clerk GitHub
 * connection carries `repo` (gated on the PRD-562 rule-5 amendment);
 * until then resolution lands on `GithubAppUser` or `Installation`.
 */
export const GitHubCredentialKind = {
  OauthUser: "oauth_user",
  GithubAppUser: "github_app_user",
  Installation: "installation",
  None: "none",
} as const;
export type GitHubCredentialKind =
  (typeof GitHubCredentialKind)[keyof typeof GitHubCredentialKind];

/**
 * Typed denial taxonomy for GitHub credential resolution (PLN-1525).
 *
 * The reason code carries the CAUSE. For every reason but one it also implies a
 * single remediation, and the surface can render it straight from this map:
 *
 * - `not_connected` — no GitHub connection: "Connect GitHub".
 * - `insufficient_scope` — scopes lack `repo`: "Reconnect to grant
 *   repository access".
 * - `revoked` — 401 observed (or token expired): "Reconnect GitHub".
 * - `org_restricted` — member of the org, but an OAuth App access restriction
 *   blocks us: "Ask an owner to approve ClosedLoop". Only reachable on the
 *   OAuth App token path (GitHub App user tokens are immune), so it is a
 *   forward contract until the Clerk-primary credential source lands.
 * - `rate_limited` — 429/403 with retry-after: back off, surface the ETA.
 * - `budget_deferred` — `sync-read` only: every qualifying pool token is
 *   below its reserve floor or in backoff. Surfaces as the `deferred: budget`
 *   coverage marker (PLN-1535), never a user-facing error.
 * - `unavailable` — GitHub 5xx: retry.
 *
 * `no_installation` is the exception, and callers must treat it as such:
 *
 * - `no_installation` — **this credential cannot reach this target.** The
 *   remediation is NOT determined by the reason alone, because GitHub cloaks a
 *   repository the caller cannot read as a 404, making "the App is not
 *   installed here" and "your account cannot see this" indistinguishable from
 *   the response. Which one it is depends on the lane that produced it:
 *     - Resolver `manage` lane: we checked our OWN installation records, so it
 *       genuinely means no active installation → "Install ClosedLoop".
 *     - Any read lane mapping a provider 403/404 (`mapGitHubReadFailureToDenial`):
 *       the installation is usually present already — a Branch View diff, for
 *       instance, only exists because an installation synced it — so the live
 *       cause is the reader's own repository access → "ask an admin for access".
 *       Offering an install there is a dead end most members cannot complete.
 *
 *   Renderers therefore pick `no_installation` copy from the surface, not from
 *   this map. Splitting it into two reasons was considered and rejected: the
 *   value is persisted in `GitHubAccessCapability.denialReason`, so a split
 *   costs a migration and a backfill while the underlying ambiguity — which is
 *   GitHub's, not ours — would remain in the read lanes regardless.
 */
export const GitHubAccessDenialReason = {
  NotConnected: "not_connected",
  InsufficientScope: "insufficient_scope",
  Revoked: "revoked",
  OrgRestricted: "org_restricted",
  NoInstallation: "no_installation",
  RateLimited: "rate_limited",
  BudgetDeferred: "budget_deferred",
  Unavailable: "unavailable",
  /**
   * A concurrent draw won the claim on every candidate (ISS-8270). The org's
   * credential is provably usable — someone else is holding it right now — so
   * this is the one denial that is a statement about TIMING, not about the
   * link, the grant, or the provider. Consumers must retry or defer, and must
   * never re-tier, prompt a reconnect, or count a failure against the repo.
   */
  Contention: "contention",
} as const;
export type GitHubAccessDenialReason =
  (typeof GitHubAccessDenialReason)[keyof typeof GitHubAccessDenialReason];

/**
 * Response from POST /integrations/github/clerk-link (PLN-1742 M3). The web
 * linking page calls it after Clerk verifies a GitHub external account, so
 * the token-less registry row exists before the user lands back on a
 * connection-gated surface. `linked` is the same verdict the credential
 * reads make; `reason` explains a false verdict.
 */
export type GitHubClerkLinkSyncResponse = {
  linked: boolean;
  reason?: GitHubAccessDenialReason;
};

/**
 * Response from `POST /integrations/github/backfill` in Apply mode (ISS-7408).
 *
 * Apply mode used to run the whole sweep before responding, which put 90s-180s
 * on a route a customer hits while onboarding. It now claims the run, hands it
 * to `waitUntil`, and returns 202 immediately; `GET /integrations/github/backfill`
 * is the status surface that reports the terminal summary.
 *
 * Deliberately NOT a `GitHubBackfillSummary` with zeroed counts: at 202 time no
 * repository has been read, and a `branchCount: 0` would be a fabricated value
 * for data that has not been looked at yet.
 */
export type GitHubBackfillAcceptedResponse = {
  accepted: true;
  status: GitHubBackfillStatus;
};

/**
 * Machine-readable reasons `POST /integrations/github/backfill` refused to
 * start a run.
 *
 * Shared rather than route-local because the web client branches on it: a
 * `Deferred` 429 means a run IS already in flight and the caller should follow
 * it, while any OTHER 429 (a platform throttle, an edge rate limiter) means no
 * run was started and must not be mistaken for one.
 */
export const GitHubBackfillRetryErrorCode = {
  Deferred: "GITHUB_BACKFILL_RETRY_DEFERRED",
} as const;
export type GitHubBackfillRetryErrorCode =
  (typeof GitHubBackfillRetryErrorCode)[keyof typeof GitHubBackfillRetryErrorCode];

/**
 * Response from `POST /integrations/github/clerk-link/client-failure`
 * (ISS-11244). The browser reports a link failure this API could not otherwise
 * observe; the ack exists so the caller can tell a recorded report from a
 * rejected one, and carries nothing the reporting page acts on — it is already
 * on its terminal failure panel.
 */
export type GitHubClerkLinkClientFailureResponse = {
  recorded: boolean;
};

/**
 * Which client-observed path produced the report (ISS-11244). Every one of these
 * is terminal for the user and invisible to the server: three resolved without
 * refusing and without the value the next step needs, and the fourth threw
 * somewhere the API never saw. Without this the four arrive at the monitor
 * indistinguishable — several carry no error code at all — so the record would
 * say a browser failed and nothing about where.
 */
export const GitHubClerkLinkClientFailureStage = {
  /** `createExternalAccount` resolved with no consent redirect URL. */
  HandoffNoRedirect: "handoff_no_redirect",
  /**
   * `reauthorize()` resolved with no consent URL on the narrow-scope re-link,
   * so the page falls back to the `insufficient_scope` denial it already had —
   * which the API deliberately does NOT record before consent, because before
   * consent it is a step inside a link that normally then succeeds.
   */
  ReauthorizeNoConsentUrl: "reauthorize_no_consent_url",
  /** The link POST answered `linked: false` carrying no reason. */
  SyncNoReason: "sync_no_reason",
  /**
   * ISS-11315: the SIGN-UP hand-off leg — `/connect/github`'s `signIn.sso`
   * answered `{ error }` or rejected, so the provider's authorize screen never
   * opened. Its own stage rather than {@link Threw} because it is a different
   * ROUTE on a different half of the journey: this one runs before any account
   * exists, and a refusal here drops the person into a generic sign-in that
   * finishes the account without GitHub as its provider — which is what then
   * makes `requiresGitHubStep` owe a step the GitHub door was meant to satisfy.
   * Reported into the SAME `github_clerk_link_failed` monitor because the
   * question an operator asks is "could this person connect GitHub", and
   * splitting the answer across two monitors by route would hide half of it.
   */
  SignUpHandoffRefused: "signup_handoff_refused",
  /**
   * ISS-11315: the user dismissed Clerk's re-verification prompt, so the SSO
   * call it was gating never ran again. A deliberate cancellation and not a
   * refusal — kept apart from {@link Threw} so the monitor does not read a
   * person changing their mind as a platform failure, and so the rate of it
   * is visible at all.
   */
  ReverificationCancelled: "reverification_cancelled",
  /** Something in the link routine threw. */
  Threw: "threw",
} as const;
export type GitHubClerkLinkClientFailureStage =
  (typeof GitHubClerkLinkClientFailureStage)[keyof typeof GitHubClerkLinkClientFailureStage];

/**
 * Request body for `POST /integrations/github/clerk-link/client-failure`
 * (ISS-11244).
 *
 * Every field but `stage` is optional and OMITTED when absent rather than sent
 * as `null`: a report carries whatever the browser actually observed, and an
 * older client that sends fewer keys still records. `apiErrorCode` /
 * `apiErrorStatus` come from `ApiError` on the sync leg, which carries no
 * `errors[]` array at all — without them every sync-leg throw reached the
 * monitor as one codeless record with a timeout, an expired session and a
 * refused POST indistinguishable.
 */
export type GitHubClerkLinkClientFailureReport = {
  stage: GitHubClerkLinkClientFailureStage;
  clerkErrorCode?: string;
  apiErrorCode?: string;
  apiErrorStatus?: number;
};
