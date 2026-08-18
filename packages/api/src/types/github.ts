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
  FirstSliceStarted: "first_slice_started",
  NotStarted: "not_started",
  OwnerApprovalRequired: "owner_approval_required",
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
  author: string;
  checksStatus?: ChecksStatus | null;
  reviewDecision?: ReviewDecision | null;
  /** Additive fork-head authority, independent from the selected/base repository. */
  headRepository?: RepositoryDefaultAuthority;
  /** Typed fork-head absence when the provider cannot expose its identity. */
  headRepositoryUnavailable?: RepositoryDefaultUnavailableObservation;
};

export type TrackedGitHubBranch = {
  branchName: string;
  branchKey: string;
  htmlUrl: string;
  pullRequestUrl: string | null;
};

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
  /** PR htmlUrl values already tracked by branch current PR detail. */
  trackedPrUrls: string[];
  /** Branch artifacts already tracked for this repository/project. */
  trackedBranches?: TrackedGitHubBranch[];
  /** Stable repository-scoped keys for tracked branches. */
  trackedBranchKeys?: string[];
};

export type GitHubContributor = {
  login: string;
  avatarUrl: string;
  contributions: number;
  htmlUrl: string;
};

export type GetContributorsResponse = {
  contributors: GitHubContributor[];
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

/**
 * PLN-1535 M3.1 PostHog rollout key. When enabled, the repository branch and
 * pull-request read routes serve from the cloud projection (Postgres) instead of
 * a live GitHub GraphQL call, eliminating that read cost. Default off: the live
 * path stays authoritative until a repo's projection is proven complete (post-M4
 * bootstrap), so the closed-by-default data-source cutover can roll out per org.
 */
export const GITHUB_PROJECTION_READS_FEATURE_FLAG_KEY =
  "github-projection-reads" as const;

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
 * connection carries `repo read:org` (gated on the PRD-562 rule-5 amendment);
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
 * - `insufficient_scope` — scopes lack `repo`/`read:org`: "Reconnect to grant
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
} as const;
export type GitHubAccessDenialReason =
  (typeof GitHubAccessDenialReason)[keyof typeof GitHubAccessDenialReason];
