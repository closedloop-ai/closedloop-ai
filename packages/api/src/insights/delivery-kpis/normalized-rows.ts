// FEA-2952 / PLN-1323 — delivery-KPI single-source-of-truth: the dialect-agnostic
// INPUT contract for the pure KPI computation.
//
// This is the seam every surface adapts TO. The cloud path (`apps/api`, Postgres),
// the desktop path (`apps/desktop/src/main`, SQLite), and any render/label layer
// (`packages/app`) each own a thin adapter that projects their storage rows into
// these plain shapes; from here on the math is identical and lives in one place
// (`compute.ts` + `registry.ts`). Nothing in this module may import a DB client,
// a SQL dialect, or `@repo/database` — it is PURE TypeScript by design so it can
// be imported by both the cloud server, the desktop main process, and client
// bundles alike.
//
// All timestamps are epoch milliseconds (number), NOT Date, so the contract is
// serialization-safe and identical across the Postgres/SQLite/JSON boundaries.

/**
 * Lifecycle state of a normalized pull request. Lowercase, dialect-agnostic —
 * adapters map their own `GitHubPRState` / SQLite string into these. Const-object
 * enum per repo convention (Biome forbids TS `enum`).
 */
export const NormalizedPrState = {
  Open: "open",
  Merged: "merged",
  Closed: "closed",
  Draft: "draft",
} as const;
export type NormalizedPrState =
  (typeof NormalizedPrState)[keyof typeof NormalizedPrState];

/**
 * Lifecycle status of a normalized branch. Kept minimal — only the states the
 * branch-based KPIs need to distinguish. Adapters map their richer branch status
 * vocabulary down to these buckets.
 */
export const NormalizedBranchStatus = {
  Active: "active",
  Merged: "merged",
  Abandoned: "abandoned",
} as const;
export type NormalizedBranchStatus =
  (typeof NormalizedBranchStatus)[keyof typeof NormalizedBranchStatus];

/**
 * A pull request projected into the dialect-agnostic contract.
 *
 * `enriched` marks whether the expensive per-PR line-diff enrichment has run for
 * this row; KPIs that require accurate additions/deletions (e.g. median PR size)
 * set `onlyEnriched: true` so un-enriched rows can't skew a size distribution
 * with placeholder zeros. `observedAt` is when the adapter last read this row and
 * lets a future adapter reason about staleness without changing the math.
 */
export type NormalizedPr = {
  state: NormalizedPrState;
  createdAt: number;
  mergedAt: number | null;
  closedAt: number | null;
  additions: number | null;
  deletions: number | null;
  enriched: boolean;
  observedAt: number;
  repo?: string;
  author?: string;
  /**
   * True when this PR is the single/only PR produced by its originating branch.
   * Lets branch↔PR line attribution stay unambiguous for KLOC variants that
   * count "lines generated in a branch" rather than "lines in a PR".
   */
  isSinglePr?: boolean;
};

/**
 * An agent session projected into the contract. `costUsd` and `tokens` are
 * nullable because a session may not have cost/usage telemetry yet.
 *
 * NOTE (dedup): cost is a per-session figure. When a session is fanned out across
 * multiple rows by an adapter (e.g. per-command), the ADAPTER must dedup to one
 * row per session before handing rows here — the `cost` measure sums naively and
 * does not de-duplicate. This is a row-prep concern, kept out of the pure math.
 *
 * NOTE (billing mode, FEA-2957): `costUsd` must carry only HEADLINE-eligible real
 * spend — metered per-token API cost plus unknown-ledger (legacy/opencode) rows.
 * Subscription-covered "would-have-cost" (Pro/Max/seat sessions) must be EXCLUDED
 * FROM `costUsd` by the adapter — exactly as the desktop headline does
 * (`headlineCost = metered + unknown`, never subscription; see
 * `apps/desktop/src/shared/billing-mode.ts`). Like dedup, this
 * metered-vs-subscription split is a row-prep concern kept out of the pure math:
 * the `cost` measure and `Cost` KPI sum `costUsd` naively, so an adapter that
 * projected the full priced cost would overstate real spend and diverge from the
 * desktop number. (There is deliberately no `billingMode` field: the pure contract
 * stays dialect- and billing-engine-agnostic.)
 *
 * IMPORTANT — the split is a `costUsd` adjustment, NOT a row filter. A
 * subscription-covered session must still be RETAINED as its own row in
 * `sessions[]`, with `costUsd` set to 0 (its metered charge). Do NOT omit/drop the
 * session: `SessionsCount` counts every row in `sessions[]` and the per-session
 * ratios (e.g. cost-per-session) divide by that count, so dropping a session would
 * undercount sessions and distort those ratios — while `Cost` already reflects the
 * subscription correctly because a 0 (or null) `costUsd` adds nothing to the sum.
 * In short: zero the cost, keep the row.
 */
export type NormalizedSession = {
  startedAt: number;
  /**
   * Session spend in USD, or null when the session has no cost telemetry yet.
   * See the billing-mode note above: this is HEADLINE-eligible spend only
   * (metered + unknown), with subscription-covered "would-have-cost" already
   * zeroed out by the adapter. For the `Cost` SUM, 0 and null are equivalent
   * (nulls are dropped before summing); the distinction is only "known-zero cost"
   * (e.g. a subscription session) vs "cost not yet observed". Either way the
   * session row itself MUST be present — never encode a subscription session by
   * omitting its row.
   */
  costUsd: number | null;
  tokens: number | null;
};

/**
 * A branch projected into the contract. Carries its own line totals so branch-
 * scoped KLOC / size variants can be computed without re-deriving them from PRs.
 * `startedAt` is the branch creation time; `settledAt` is when it reached a
 * terminal status (merged/abandoned), or null while still active.
 */
export type NormalizedBranch = {
  status: NormalizedBranchStatus;
  additions: number | null;
  deletions: number | null;
  startedAt: number;
  settledAt: number | null;
  hasPr?: boolean;
  repo?: string;
};

/**
 * The complete dialect-agnostic input to `computeDeliveryKpis`. `window` is the
 * closed time range [start, end] (epoch ms) that every population selector
 * honors, so windowing is applied uniformly in the pure layer rather than being
 * pre-baked differently by each surface's query.
 */
export type NormalizedDeliveryRows = {
  prs: NormalizedPr[];
  sessions: NormalizedSession[];
  branches: NormalizedBranch[];
  window: DeliveryWindow;
};

export type DeliveryWindow = {
  start: number;
  end: number;
};
