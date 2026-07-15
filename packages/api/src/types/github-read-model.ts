import type { ChecksStatus, ReviewDecision } from "./branch-checks";
import type { GitHubPRState } from "./github";

export const GitHubDataChannel = {
  LocalGit: "local_git",
  DesktopGh: "desktop_gh",
  GitHubApp: "github_app",
  PersistedProjection: "persisted_projection",
} as const;
export type GitHubDataChannel =
  (typeof GitHubDataChannel)[keyof typeof GitHubDataChannel];

export const GitHubReadModelSource = {
  Local: "local",
  Provider: "provider",
  Cloud: "cloud",
} as const;
export type GitHubReadModelSource =
  (typeof GitHubReadModelSource)[keyof typeof GitHubReadModelSource];

export const GitHubProviderBudgetState = {
  Available: "available",
  Low: "low",
  Unknown: "unknown",
} as const;
export type GitHubProviderBudgetState =
  (typeof GitHubProviderBudgetState)[keyof typeof GitHubProviderBudgetState];

/**
 * Credential class used to fetch a GitHub read-model projection. Values are
 * intentionally high level and must never contain token material.
 */
export const GitHubFetchCredentialType = {
  GitHubApp: "github_app",
  UserOAuth: "user_oauth",
  // FEA-2732: the desktop's local `gh`/git credentials, used to sync PR (and
  // branch) facts for repos with no GitHub App. Distinct from the App
  // credential so webhook-wins provenance can tell the two producers apart.
  DesktopSync: "desktop_sync",
  Unknown: "unknown",
} as const;
export type GitHubFetchCredentialType =
  (typeof GitHubFetchCredentialType)[keyof typeof GitHubFetchCredentialType];

/**
 * Provider boundary that produced a GitHub projection row.
 */
export const GitHubFetchMechanism = {
  Graphql: "graphql",
  Rest: "rest",
  Webhook: "webhook",
  Backfill: "backfill",
  // FEA-2732: the desktop sync lane (local `gh` enrichment / gh_pr_create
  // parses). Not a GitHub-App mechanism, so webhook-wins conflict resolution
  // treats it as gap-fill-only against any App-sourced row.
  DesktopSync: "desktop_sync",
  Unknown: "unknown",
} as const;
export type GitHubFetchMechanism =
  (typeof GitHubFetchMechanism)[keyof typeof GitHubFetchMechanism];

/**
 * Event or workflow that requested a GitHub projection refresh.
 */
export const GitHubFetchTrigger = {
  Webhook: "webhook",
  Backfill: "backfill",
  UserAction: "user_action",
  SurfaceOpen: "surface_open",
  // FEA-2732: a desktop → cloud sync tick produced this projection row.
  DesktopSync: "desktop_sync",
  Unknown: "unknown",
} as const;
export type GitHubFetchTrigger =
  (typeof GitHubFetchTrigger)[keyof typeof GitHubFetchTrigger];

/**
 * Normalized reason for the latest GitHub projection sync result.
 */
export const GitHubSyncResultReason = {
  Success: "success",
  NoActiveRepository: "no_active_repository",
  NoCredential: "no_credential",
  CredentialRevoked: "credential_revoked",
  CredentialExpired: "credential_expired",
  CredentialDecryptionFailed: "credential_decryption_failed",
  CredentialInsufficientScope: "credential_insufficient_scope",
  CrossUserDenied: "cross_user_denied",
  NoEligibleSessionReference: "no_eligible_session_reference",
  ProviderUnavailable: "provider_unavailable",
  Unsupported: "unsupported",
  Unknown: "unknown",
} as const;
export type GitHubSyncResultReason =
  (typeof GitHubSyncResultReason)[keyof typeof GitHubSyncResultReason];

export type GitHubRateLimitBudget = {
  cost: number | null;
  remaining: number | null;
  resetAt: string | null;
  state: GitHubProviderBudgetState;
};

export const GitHubBundledPullRequestsStopReason = {
  Complete: "complete",
  TargetFound: "target_found",
  PageLimit: "page_limit",
  ItemLimit: "item_limit",
  BudgetLow: "budget_low",
  ProviderRateLimit: "provider_rate_limit",
} as const;
export type GitHubBundledPullRequestsStopReason =
  (typeof GitHubBundledPullRequestsStopReason)[keyof typeof GitHubBundledPullRequestsStopReason];

export type GitHubReadModelPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type GitHubBundledPullRequestsPageOptions = {
  pageSize?: number;
  after?: string | null;
  maxPages?: number;
  maxItems?: number;
  targetNumbers?: readonly number[];
};

export type GitHubReadModelPullRequest = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  state: GitHubPRState;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  reviewDecision: ReviewDecision | null;
  checksStatus: ChecksStatus | null;
  statusCheckRollup: string | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  updatedAt: string | null;
  author: string | null;
  source: GitHubReadModelSource;
};

export type GitHubBundledPullRequestsResult = {
  pullRequests: GitHubReadModelPullRequest[];
  rateLimit: GitHubRateLimitBudget;
  pageInfo?: GitHubReadModelPageInfo;
  hasMore?: boolean;
  truncated?: boolean;
  nextCursor?: string | null;
  fetchedPages?: number;
  stopReason?: GitHubBundledPullRequestsStopReason;
  targetNumbers?: number[];
  missingTargetNumbers?: number[];
};

export type GitHubMergedPredicateInput = {
  connected: boolean;
  githubState?: GitHubPRState | null;
  localState?: GitHubPRState | null;
};
