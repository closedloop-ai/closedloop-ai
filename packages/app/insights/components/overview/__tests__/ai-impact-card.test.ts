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
            kpi("kloc", 4, KpiFormat.Number),
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
    // Opus leads with $70 of $100 spend share (FEA-2331: modelBreakdown is USD).
    expect(metrics["top-model"].value).toBe("Claude Opus");
    expect(metrics["top-model"].detail).toBe("70% of spend");
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
            kpi("kloc", 0, KpiFormat.Number),
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

  it("suppresses the merged-PR cards when captured-PR KPIs render but nothing merged (FEA-2941)", () => {
    // Desktop me-scoped shape: `merged`/`kloc` carry CAPTURED-PR data (non-zero),
    // but `prByRepo` — genuinely merged PRs only — is empty. The card must not
    // fabricate "Cost per merged PR" / "Tokens per KLOC" numbers alongside "Top
    // repo by output → No merged PRs yet"; all three stay in the empty state.
    const metrics = byKey(
      deriveAiImpact({
        [InsightsSection.Delivery]: delivery(
          [
            kpi("cost", 100, KpiFormat.Currency),
            kpi("merged", 10, KpiFormat.Number),
            kpi("kloc", 1.8, KpiFormat.Number),
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

  it("suppresses cost/tokens claims when the ambiguous `merged` KPI diverges from merged PRs and `mergedCount` is absent (FEA-2941/FEA-2946)", () => {
    // Desktop-shaped skew scenario: the legacy `merged`/`kloc` KPIs carry
    // CAPTURED-PR data (10 captured PRs, 5 KLOC captured) and `prByRepo` sums to 3
    // genuinely merged PRs, but the surface-agnostic `mergedCount` KPI is absent.
    // Without a provable merged-PR denominator the card must NOT divide spend by
    // the ambiguous captured `merged` KPI:
    //  - "Cost per merged PR" divides by `mergedCount` ONLY; absent → empty state.
    //  - "Tokens per KLOC" likewise has no merged-only signal, so it stays empty.
    // (Real desktop always ships `mergedCount` in lockstep, so this absent-count
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
    // Captured KLOC can't be proven merged-only, so suppress rather than lie.
    expect(metrics["tokens-per-kloc"].value).toBe("—");
    // Repo leader is genuine merged output and still renders.
    expect(metrics["top-repo"].value).toBe("repo-a");
    expect(metrics["top-repo"].detail).toBe("2 merged PRs");
  });

  it("renders all four metrics even when no sections have loaded", () => {
    expect(deriveAiImpact({})).toHaveLength(4);
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
});
