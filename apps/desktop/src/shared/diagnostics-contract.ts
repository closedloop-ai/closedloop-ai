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

/**
 * ISS-5266: one OpenCode subagent subtree the collector WITHHELD because its
 * root row could not be parsed, and therefore one measured hole in the corpus.
 *
 * `withheldCount` is EXACT, not estimated: the withheld children parsed
 * successfully and only their root did not, so the size of the under-count is
 * known. The instant fields are nullable because a child can carry no timestamp
 * — `null` there means the affected window is UNKNOWN, and a consumer must not
 * render it as a zero-length window.
 *
 * The presence of a row is the whole point: an empty `opencodeWithheld` says
 * "nothing is currently withheld", which is a different claim from "no session
 * had subagents" and from "nothing has been imported yet".
 */
export type DiagnosticsWithheldRow = {
  /** Unique only together with `sourcePath` — see the store's composite key. */
  rootRawId: string;
  sourcePath: string;
  withheldCount: number;
  reason: string;
  /**
   * BILLABLE tokens (input + output), the same basis as the dashboard headline
   * total this shortfall is quoted against. `null` means UNAVAILABLE (the
   * aggregate left the JS-safe integer range) and must never render as zero.
   */
  withheldTokens: number | null;
  /** Cache tokens (read + write), on their own basis. `null` is UNAVAILABLE. */
  withheldCacheTokens: number | null;
  earliestChildStartedAt: string | null;
  latestChildEndedAt: string | null;
  /**
   * True when a withheld child carried no instants, so the window bounds are a
   * LOWER BOUND on what is affected rather than its exact extent.
   */
  windowPartial: boolean;
  observedAt: string;
};

/**
 * ISS-5266: proof that one OpenCode store completed a full scan.
 *
 * An empty `opencodeWithheld` on its own is ambiguous three ways: nothing was
 * withheld, nothing has been imported, or a reconcile failed. Only the first is
 * "complete". A scan entry is written in the same transaction as the reconcile,
 * so its presence is what licenses the completeness reading, and `observedAt`
 * is what makes a store that has stopped reporting visible as a stale claim
 * rather than a silent contributor to a total presented as current.
 */
export type DiagnosticsWithheldScan = {
  sourcePath: string;
  observedAt: string;
};

export type DiagnosticsData = {
  repos: DiagnosticsRepoRow[];
  backfill: BackfillStats;
  linkStats: LinkStatsRow[];
  linkTotals: LinkTotals;
  /**
   * ISS-5266. OPTIONAL on purpose. The current producer always sets it (empty
   * when nothing is withheld), but the renderer receives this payload over IPC
   * and a payload without the key is a real, distinct answer: "this producer
   * cannot tell you". Making it required would force every such payload to be
   * read as an empty array — i.e. as "nothing is withheld" — which is precisely
   * the unknown-rendered-as-a-real-zero conflation this ticket removes.
   */
  opencodeWithheld?: DiagnosticsWithheldRow[];
  /**
   * ISS-5266. OPTIONAL for the same version-skew reason as `opencodeWithheld`:
   * a producer that cannot report scans must not be read as having reported
   * none. An empty array is the real answer "no store has completed a scan
   * yet", which the consumer must render as UNKNOWN, never as complete.
   */
  opencodeWithheldScans?: DiagnosticsWithheldScan[];
};
