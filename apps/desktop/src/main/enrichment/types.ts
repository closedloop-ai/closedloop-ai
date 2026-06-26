export const EnrichmentState = {
  Provisional: "provisional",
  Final: "final",
  NotApplicable: "not_applicable",
} as const;
export type EnrichmentState =
  (typeof EnrichmentState)[keyof typeof EnrichmentState];

export const EnrichmentSource = {
  GitShow: "git_show",
  GitDiff: "git_diff",
  GhPrView: "gh_pr_view",
  GhPrList: "gh_pr_list",
  GhApi: "gh_api",
  TranscriptParse: "transcript_parse",
} as const;
export type EnrichmentSource =
  (typeof EnrichmentSource)[keyof typeof EnrichmentSource];

export type LocStats = {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
};

export type EnrichmentResult = {
  stats: LocStats | null;
  state: EnrichmentState;
  source: EnrichmentSource;
};

export const PrState = {
  Open: "open",
  Merged: "merged",
  Closed: "closed",
} as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export type PrMetadata = {
  prState: PrState;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeCommitSha: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  /** GitHub PR createdAt (PRD-486) — the PR-opened lifecycle timestamp. */
  openedAt: string | null;
  /**
   * GitHub PR mergedAt — the AUTHORITATIVE merge instant. Null unless GitHub
   * actually reported it (i.e. the PR is merged). Never synthesized: a branch's
   * "last active" reads this, so a fabricated time would back-date the branch to
   * whenever enrichment ran rather than the real merge.
   */
  mergedAt: string | null;
  /** GitHub PR closedAt — set for merged AND closed PRs; null otherwise. */
  closedAt: string | null;
};

export const MAX_ENRICHMENT_ATTEMPTS = 5;

export const LEASE_STALE_MS = 5 * 60 * 1000;

export const GH_RATE_LIMIT_INTERVAL_MS = 6000;

export const ENRICHMENT_SWEEP_DEBOUNCE_MS = 5 * 60 * 1000;
