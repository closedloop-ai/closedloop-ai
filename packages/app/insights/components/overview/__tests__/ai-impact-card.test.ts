import type {
  AgentsInsightsResponse,
  CategoryBucket,
  DeliveryInsightsResponse,
  KpiStat,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { deriveAiImpact } from "../ai-impact-card";

const EMPTY_SERIES = { series: [], points: [] };

function kpi(key: string, value: number, format: KpiFormat): KpiStat {
  return { key, label: key, value, format, sub: "", deltaPct: null };
}

function delivery(
  kpis: KpiStat[],
  prByRepo: CategoryBucket[]
): DeliveryInsightsResponse {
  return {
    kpis,
    charts: {
      prTrend: EMPTY_SERIES,
      prByRepo,
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}

function agents(
  kpis: KpiStat[],
  modelBreakdown: CategoryBucket[]
): AgentsInsightsResponse {
  return {
    kpis,
    charts: { modelUsageOverTime: EMPTY_SERIES, modelBreakdown },
  };
}

function byKey(metrics: ReturnType<typeof deriveAiImpact>) {
  return Object.fromEntries(metrics.map((metric) => [metric.key, metric]));
}

describe("deriveAiImpact", () => {
  it("correlates the dashboard's separate KPIs and charts into a value story", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 400, KpiFormat.Currency),
            kpi("mergedCount", 8, KpiFormat.Number),
            kpi("mergedKloc", 4, KpiFormat.Number),
          ],
          [
            { key: "repo-a", label: "repo-a", value: 6 },
            { key: "repo-b", label: "repo-b", value: 2 },
          ]
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 2000, KpiFormat.Tokens)],
          [
            { key: "sonnet", label: "Claude Sonnet", value: 30 },
            { key: "opus", label: "Claude Opus", value: 70 },
          ]
        ),
      })
    );

    // $400 over 8 merged PRs → $50 each.
    expect(metrics["cost-per-pr"].value).toBe("$50");
    // 2000 tokens over 4 KLOC → 500.
    expect(metrics["tokens-per-kloc"].value).toBe("500");
    // Opus leads with $70 of $100 cost share (FEA-2331: modelBreakdown is USD).
    expect(metrics["top-model"].value).toBe("Claude Opus");
    expect(metrics["top-model"].detail).toBe("70% of cost");
    // repo-a shipped the most merged PRs.
    expect(metrics["top-repo"].value).toBe("repo-a");
    expect(metrics["top-repo"].detail).toBe("6 merged PRs");
  });

  it("falls back to an em dash instead of dividing by zero or inventing a leader", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 100, KpiFormat.Currency),
            kpi("mergedCount", 0, KpiFormat.Number),
            kpi("mergedKloc", 0, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 100, KpiFormat.Tokens)],
          []
        ),
      })
    );

    expect(metrics["cost-per-pr"].value).toBe("—");
    expect(metrics["tokens-per-kloc"].value).toBe("—");
    expect(metrics["top-model"].value).toBe("—");
    expect(metrics["top-repo"].value).toBe("—");
  });

  it("suppresses the merged-PR cards when captured-PR KPIs render but nothing merged (FEA-2941/FEA-2947)", () => {
    // Desktop me-scoped shape: the visible `merged`/`kloc` tiles carry CAPTURED-PR
    // data (non-zero), but nothing has merged — so the surface-agnostic
    // `mergedCount`/`mergedKloc` KPIs and `prByRepo` (genuinely merged PRs only) are
    // all 0/empty. The card must divide by the MERGED denominators, not the captured
    // `merged`/`kloc` tiles: "Cost per merged PR", "Tokens per KLOC", and "Top repo
    // by output → No merged PRs yet" all stay in the empty state.
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 100, KpiFormat.Currency),
            kpi("merged", 10, KpiFormat.Number),
            kpi("kloc", 1.8, KpiFormat.Number),
            kpi("mergedCount", 0, KpiFormat.Number),
            kpi("mergedKloc", 0, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 6_000_000, KpiFormat.Tokens)],
          [{ key: "opus", label: "Claude Opus", value: 100 }]
        ),
      })
    );

    expect(metrics["cost-per-pr"].value).toBe("—");
    expect(metrics["tokens-per-kloc"].value).toBe("—");
    expect(metrics["top-repo"].value).toBe("—");
    expect(metrics["top-repo"].detail).toBe("No merged PRs yet");
    // The spend leader is unaffected — it is not a merged-PR metric.
    expect(metrics["top-model"].value).toBe("Claude Opus");
  });

  it("suppresses cost/tokens claims when the ambiguous `merged`/`kloc` KPIs are present but `mergedCount`/`mergedKloc` are absent (FEA-2941/FEA-2946/FEA-2947)", () => {
    // Desktop-shaped skew scenario: the legacy `merged`/`kloc` KPIs carry
    // CAPTURED-PR data (10 captured PRs, 5 KLOC captured) and `prByRepo` sums to 3
    // genuinely merged PRs, but the surface-agnostic `mergedCount`/`mergedKloc` KPIs
    // are absent. Without a provable merged denominator the card must NOT divide by
    // the ambiguous captured `merged`/`kloc` KPIs:
    //  - "Cost per merged PR" divides by `mergedCount` ONLY; absent → empty state.
    //  - "Tokens per KLOC" divides by `mergedKloc` ONLY; absent → empty state.
    // (Real desktop always ships both dedicated KPIs in lockstep, so this absent
    // shape is synthetic; the honest empty state is the correct fallback.)
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 600, KpiFormat.Currency),
            kpi("merged", 10, KpiFormat.Number),
            kpi("kloc", 5, KpiFormat.Number),
          ],
          [
            { key: "repo-a", label: "repo-a", value: 2 },
            { key: "repo-b", label: "repo-b", value: 1 },
          ]
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 3000, KpiFormat.Tokens)],
          [{ key: "opus", label: "Claude Opus", value: 100 }]
        ),
      })
    );

    // No `mergedCount`, so spend is not divided by the ambiguous captured `merged`.
    expect(metrics["cost-per-pr"].value).toBe("—");
    // No `mergedKloc`, so tokens are not divided by the ambiguous captured `kloc`.
    expect(metrics["tokens-per-kloc"].value).toBe("—");
    // Repo leader is genuine merged output and still renders.
    expect(metrics["top-repo"].value).toBe("repo-a");
    expect(metrics["top-repo"].detail).toBe("2 merged PRs");
  });

  it("renders all four metrics even when no sections have loaded", () => {
    expect(deriveAiImpact({})).toHaveLength(4);
  });

  // FEA-3431: "Cost per merged PR" is an aggregate cost KPI and must render as
  // whole dollars (no cents), matching the Branches/Sessions "AI spend" cards
  // and the whole-dollar overview headline — never a compact "$9.1k".
  it("rounds cost-per-merged-PR to a whole dollar (no cents, no compact k)", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            // $9,060.84 across 1 merged PR → rounds to $9,061 (whole dollars),
            // not the compact "$9.1k" the old formatKpiValue produced.
            kpi("cost", 9060.84, KpiFormat.Currency),
            kpi("mergedCount", 1, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents([], []),
      })
    );

    expect(metrics["cost-per-pr"].value).toBe("$9,061");
  });

  // FEA-2946: the "Cost per merged PR" denominator is the dedicated `mergedCount`
  // KPI, NOT the surface-ambiguous `merged` KPI (which is captured-count on
  // desktop and merged-count on cloud). A window with many captured but few merged
  // PRs must divide by merged, matching the "PRs shipped" label.
  it("divides cost by the merged-PR count, ignoring a larger captured `merged` KPI", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 100, KpiFormat.Currency),
            // desktop `merged` = ALL captured PRs (10) — must NOT be the divisor.
            kpi("merged", 10, KpiFormat.Number),
            // dedicated merged-PR count (1) — the intended denominator.
            kpi("mergedCount", 1, KpiFormat.Number),
            kpi("kloc", 0, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents([], []),
      })
    );

    // $100 ÷ 1 merged PR = $100 — NOT $10 (which the old captured-count divisor
    // of 10 would have produced).
    expect(metrics["cost-per-pr"].value).toBe("$100");
  });

  // FEA-2946: the desktop and API Delivery `mergedCount` KPI must feed the card
  // the SAME (merged) population, so the identical shared tile reports the same
  // cost-per-merged-PR number on both surfaces.
  it("reports the same cost-per-merged-PR across the desktop and cloud surfaces", () => {
    // Desktop shape: `merged` carries captured (10), `mergedCount` carries merged (2).
    const desktop = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 200, KpiFormat.Currency),
            kpi("merged", 10, KpiFormat.Number),
            kpi("mergedCount", 2, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents([], []),
      })
    );
    // Cloud shape: `merged` and `mergedCount` both carry the merged count (2).
    const cloud = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 200, KpiFormat.Currency),
            kpi("merged", 2, KpiFormat.Number),
            kpi("mergedCount", 2, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents([], []),
      })
    );

    expect(desktop["cost-per-pr"].value).toBe("$100");
    expect(cloud["cost-per-pr"].value).toBe(desktop["cost-per-pr"].value);
  });

  // FEA-2946 (regression fix): version skew renders the HONEST empty state, not a
  // fabricated value. When the shared UI ships before the cloud
  // `/insights/delivery` source starts returning `mergedCount`, the card must NOT
  // fall back to the surface-ambiguous legacy `merged` KPI (desktop sets it to ALL
  // captured PRs) — that reintroduces the exact bug FEA-2946 set out to fix. With
  // no provable merged-PR denominator it renders "—".
  it("renders the honest empty state when `mergedCount` is absent (no ambiguous `merged` fallback)", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 300, KpiFormat.Currency),
            // Only the ambiguous legacy `merged` KPI is present; `mergedCount`
            // has not been added to the response yet (version skew).
            kpi("merged", 3, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents([], []),
      })
    );

    // No `mergedCount` → honest empty state, not $100 off the ambiguous `merged`.
    expect(metrics["cost-per-pr"].value).toBe("—");
  });

  // FEA-2947: "Tokens per KLOC" divides by the dedicated `mergedKloc` KPI, NOT the
  // surface-ambiguous `kloc` KPI (which is captured-lines KLOC on desktop and
  // merged-lines KLOC on cloud). A desktop window with far more captured lines than
  // merged lines must divide by the merged denominator, matching the "lines merged"
  // label.
  it("divides tokens by the merged-lines KLOC, ignoring a larger captured `kloc` KPI", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            // desktop `kloc` = CAPTURED-PR KLOC (10) — must NOT be the divisor.
            kpi("kloc", 10, KpiFormat.Number),
            // dedicated merged-lines KLOC (2) — the intended denominator.
            kpi("mergedKloc", 2, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 1000, KpiFormat.Tokens)],
          []
        ),
      })
    );

    // 1000 tokens ÷ 2 merged KLOC = 500 — NOT 100 (which the captured `kloc` of 10
    // would have produced).
    expect(metrics["tokens-per-kloc"].value).toBe("500");
  });

  // FEA-2947: the desktop and API Delivery `mergedKloc` KPI must feed the card the
  // SAME (merged-lines) population, so the identical shared tile reports the same
  // tokens-per-KLOC number on both surfaces.
  it("reports the same tokens-per-KLOC across the desktop and cloud surfaces", () => {
    // Desktop shape: `kloc` carries captured lines (10), `mergedKloc` merged (2).
    const desktop = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("kloc", 10, KpiFormat.Number),
            kpi("mergedKloc", 2, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 4000, KpiFormat.Tokens)],
          []
        ),
      })
    );
    // Cloud shape: `kloc` and `mergedKloc` both carry merged lines (2).
    const cloud = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("kloc", 2, KpiFormat.Number),
            kpi("mergedKloc", 2, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 4000, KpiFormat.Tokens)],
          []
        ),
      })
    );

    expect(desktop["tokens-per-kloc"].value).toBe("2k");
    expect(cloud["tokens-per-kloc"].value).toBe(
      desktop["tokens-per-kloc"].value
    );
  });

  // FEA-2947 (regression fix): version skew renders the HONEST empty state, not a
  // fabricated value. When the shared UI ships before a source starts returning
  // `mergedKloc`, the card must NOT fall back to the surface-ambiguous legacy `kloc`
  // KPI (desktop sets it to CAPTURED-PR KLOC) — that reintroduces the exact bug
  // FEA-2947 set out to fix. With no provable merged-lines denominator it renders "—".
  it("renders the honest empty state when `mergedKloc` is absent (no ambiguous `kloc` fallback)", () => {
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            // Only the ambiguous legacy `kloc` KPI is present; `mergedKloc` has not
            // been added to the response yet (version skew).
            kpi("kloc", 5, KpiFormat.Number),
          ],
          []
        ),
        [InsightsSection.Agents]: agents(
          [kpi("tokens", 2500, KpiFormat.Tokens)],
          []
        ),
      })
    );

    // No `mergedKloc` → honest empty state, not 500 off the ambiguous captured `kloc`.
    expect(metrics["tokens-per-kloc"].value).toBe("—");
  });

  // FEA-4000: graduating the card off its Labs/PostHog flag makes it render on the
  // desktop first-launch dashboard against whatever section shape has resolved so
  // far. A resolved-but-partial section (version-skewed payload, or a section still
  // filling in) can arrive as an object with no `kpis` array. `kpiValue` must guard
  // `.kpis`, not just the section, or `.find` throws and crashes the whole
  // dashboard. All four metrics fall through to the honest empty state instead.
  it("degrades to the empty state when a resolved section has neither `kpis` nor `charts`", () => {
    // A section object present but missing both `kpis` and `charts` — the partial
    // shape the desktop first-launch dashboard exposed once the flag gate was
    // removed (a section resolves before its body is fully populated). `kpiValue`
    // and the chart reads must both guard past the section, not just the section
    // itself, or `.find`/`.prByRepo` throw and crash the dashboard.
    const partialDelivery = {} as unknown as DeliveryInsightsResponse;
    const partialAgents = {} as unknown as AgentsInsightsResponse;

    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: partialDelivery,
        [InsightsSection.Agents]: partialAgents,
      })
    );

    expect(metrics["cost-per-pr"].value).toBe("—");
    expect(metrics["tokens-per-kloc"].value).toBe("—");
    expect(metrics["top-model"].value).toBe("—");
    expect(metrics["top-repo"].value).toBe("—");
  });
});
