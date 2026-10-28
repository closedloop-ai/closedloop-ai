/**
 * ISS-4754 (Golden Layer 5) — ticket-keyed registry of known desktop-vs-cloud
 * divergences, plus the structural exclusions that are deliberately NOT parity
 * axes.
 *
 * Same governance as the Layer 1-4 registries in `apps/desktop/test/golden/`:
 * an entry means "the cloud currently disagrees with the oracle on this key, the
 * oracle was confirmed right, and <ticket> tracks the fix". The runner reports
 * it as an expected-fail so CI stays green — and FAILS LOUDLY when the
 * divergence stops reproducing, forcing a human to delete the entry and promote
 * the key to a hard assertion.
 *
 * Key namespace: `cloud.*` — disjoint from Layer 1's bare `expectations.yaml`
 * paths, Layer 2's `store.*`, Layer 3's `agg.*` and Layer 4's `render.*`.
 *
 * Rules:
 * - Every entry MUST cite a real ticket (FEA-* or ISS-*).
 * - `actual` pins the current (wrong) value: drift to a THIRD value fails hard.
 * - DIVERGENCES are added ONLY for reds observed in an actual run — never
 *   pre-registered from prediction. STRUCTURAL exclusions are different in kind:
 *   they record an axis that has no cloud counterpart at all, so there is no
 *   value to observe.
 * - Agents PROPOSE entries in a PR; the reviewer owns accepting them.
 *
 * THE FLOOR THIS REGISTRY MAY NOT CROSS. A registry that can retire any axis is
 * a way to buy a green run by asserting almost nothing. `HARD_PARITY_FLOOR_KEYS`
 * below may have a VALUE pinned by an entry, but may never be excluded — and
 * `MAX_REGISTERED_DIVERGENCES` caps how much can be registered at all.
 */

export type CloudDivergenceScope = "corpus" | { sessionId: string };

export type CloudDivergence = {
  scope: CloudDivergenceScope;
  /** `cloud.*` key path the cloud diverges on. */
  key: string;
  /** Tracking ticket for the fix. */
  ticket: string;
  /** The cloud's current (wrong) value, pinned so further drift fails hard. */
  actual: unknown;
  note: string;
};

/**
 * An axis with NO cloud counterpart, recorded so the exclusion is visible and
 * self-guarding rather than a silent skip. Distinct from a divergence: there is
 * no value to compare, so there is nothing to pin.
 */
export type StructuralExclusion = {
  key: string;
  ticket: string;
  reason: string;
  /** True when both sides are 0/null for a structural reason, so asserting
   * equality is arithmetically true but semantically empty. */
  vacuousAtZero?: boolean;
};

export const TICKET_ID = /^(FEA|ISS)-\d+$/;

/** Axes that must stay hard assertions for EVERY dossier. An entry may pin a
 * value on one of these; it may never remove the axis. */
export const HARD_PARITY_FLOOR_KEYS = [
  "cloud.session.status",
  "cloud.session.harness",
  "cloud.session.primaryModel",
  "cloud.session.modelsUsed",
  "cloud.session.tokensByModel",
  "cloud.session.turns.user",
  "cloud.session.turns.assistant",
] as const;

/** Corpus-level axes that must stay hard assertions in the aggregation suite. */
export const HARD_CORPUS_FLOOR_KEYS = [
  "cloud.corpus.store_tokens_by_model",
  "cloud.corpus.sessions_imported",
  "cloud.corpus.sessions_by_status_store",
  "cloud.window.usage_totals",
  "cloud.window.cost_usd_store",
  "cloud.window.per_model_spend_usd",
  "cloud.window.tool_events",
  "cloud.tz.heatmap_day_totals",
  "cloud.core.tool_counts",
  "cloud.sessions_page",
] as const;

/**
 * Ceiling on registered divergences. Deliberately tight: the corpus is 34
 * dossiers and the parity axes are few, so a registry that grew past this would
 * mean the suite had stopped asserting parity and started cataloguing it.
 */
export const MAX_REGISTERED_DIVERGENCES = 12;

/**
 * Observed divergences — every entry here was produced by an actual corpus run,
 * never pre-registered from prediction.
 *
 * ISS-4754's measurement gate found two classes across the then-27 dossiers, and
 * both were fixed rather than tolerated — models_used by ISS-7895, the legacy
 * $.messages agent fallback by ISS-8259 — leaving this registry EMPTY, which is
 * the goal state rather than a missing one. Re-registering an axis means the
 * cloud and the oracle disagree again, so a new entry owes a ticket and a real
 * run.
 *
 * ISS-7258 re-populated it with three entries on `aff9f567` (a `/fork` child
 * replaying 154 of its records verbatim from parent 0e0036cc, which the
 * collector did not yet exclude — so the desktop sent inflated figures and the
 * cloud reported them faithfully). ISS-8659 fixed the collector, the three
 * stopped reproducing, and the runner failed loudly as designed; they are
 * DELETED here rather than updated, and all three keys are hard assertions
 * again. The parent 0e0036cc is now in the corpus too, as the control arm.
 *
 * Empty is the goal state, not a missing one.
 */
export const CLOUD_KNOWN_DIVERGENCES: CloudDivergence[] = [];

/**
 * Axes deliberately excluded from parity (ISS-4754 rulings 2, 3 and deviation D4).
 * These are NOT failures — each records why the comparison is not meaningful.
 */
export const CLOUD_STRUCTURAL_EXCLUSIONS: StructuralExclusion[] = [
  {
    key: "cloud.workflow.*",
    ticket: "ISS-4754",
    reason:
      "no cloud counterpart — fetchAgentPipelineGraph returns a graph, not the flat scalars the oracle pins",
  },
  {
    key: "cloud.kpi.merged",
    ticket: "ISS-4754",
    reason:
      "different semantics by design — the cloud counts mergedAt-windowed PRs while the oracle's pr_captured counts PR ARTIFACTS; they are not the same quantity",
  },
  {
    key: "cloud.kpi.ttm",
    ticket: "ISS-4754",
    reason: "different semantics by design (cloud service.ts:195)",
  },
  {
    key: "cloud.chart.branchesWithoutPr",
    ticket: "ISS-5828",
    reason:
      "the cloud hardcodes availability; the desktop side lacks account-scoped repository-default authority",
  },
  {
    key: "cloud.tile.orgOnly",
    ticket: "ISS-4754",
    reason:
      "kpi:backlog, reviewQueue, reviewerLoad and checkStatus are cloud-only org tiles — frozen in the cloud fixture, never compared to a desktop value that does not exist",
  },
  {
    key: "cloud.tz.autonomy_by_day",
    ticket: "ISS-4754",
    reason:
      "ruling 4 asks for this axis, but the cloud emits NO autonomyTrend producer at all (zero references in apps/api; packages/loops-api/src/insights.ts documents it as desktop-only), so there is no value to compare. Tracked for its own ticket per ruling 7.",
  },
  {
    key: "cloud.kpi.klocFamily",
    ticket: "ISS-4754",
    reason:
      "enrichment never runs for the hermetic corpus, so KLOC/PR-size sign as 0/null on BOTH sides",
    vacuousAtZero: true,
  },
  {
    key: "cloud.sessions_page.running_filter_matches",
    ticket: "ISS-4754",
    reason:
      "the whole corpus is terminal, so both sides are 0 — equality here proves both are empty, not that the filter agrees",
    vacuousAtZero: true,
  },
];

export function cloudScopeId(scope: CloudDivergenceScope): string | null {
  return scope === "corpus" ? null : scope.sessionId;
}

export function cloudKey(scope: CloudDivergenceScope, key: string): string {
  return `${cloudScopeId(scope) ?? "corpus"} ${key}`;
}

export function findCloudDivergence(
  scope: CloudDivergenceScope,
  key: string
): CloudDivergence | undefined {
  const id = cloudScopeId(scope);
  return CLOUD_KNOWN_DIVERGENCES.find(
    (entry) => cloudScopeId(entry.scope) === id && entry.key === key
  );
}
