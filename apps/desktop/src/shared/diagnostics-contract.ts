export type EnrichmentQueueRow = {
  kind: string;
  state: string;
  count: number;
};

export type StalledArtifactRow = {
  id: string;
  identityKey: string;
  kind: string;
  repoFullName: string | null;
  enrichmentState: string | null;
  enrichmentAttempts: number;
  enrichedAt: string | null;
  lastSeenAt: string;
};

export type DiagnosticsRepoRow = {
  id: string;
  gitDir: string;
  remoteUrl: string | null;
  repoFullName: string | null;
  defaultBranch: string | null;
  lastSeenAt: string;
  worktreeCount: number;
};

export type BackfillStats = {
  artifactLinks: { totalScanned: number; lastScannedAt: string | null };
  prBackfill: { totalScanned: number; lastScannedAt: string | null };
};

export type LinkStatsRow = {
  relation: string;
  method: string;
  count: number;
};

export type LinkTotals = {
  totalLinks: number;
  linkedSessions: number;
  linkedArtifacts: number;
};

export type PendingArtifactRow = {
  id: string;
  identityKey: string;
  kind: string;
  repoFullName: string | null;
  gitDir: string | null;
  sha: string | null;
  branchName: string | null;
  prNumber: number | null;
  enrichmentState: string | null;
  enrichmentAttempts: number;
  leasedAt: string | null;
  lastSeenAt: string;
};

export type DiagnosticsData = {
  enrichmentQueue: EnrichmentQueueRow[];
  pendingArtifacts: PendingArtifactRow[];
  stalledArtifacts: StalledArtifactRow[];
  repos: DiagnosticsRepoRow[];
  backfill: BackfillStats;
  linkStats: LinkStatsRow[];
  linkTotals: LinkTotals;
};
