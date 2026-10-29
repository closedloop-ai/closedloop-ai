/**
 * ISS-4754 — the shared golden-fixture -> `InsightsSectionData` adapter.
 *
 * Extracted from `dashboard-rows.test.tsx`, where it was a zero-arg local that
 * closed over the module-level Layer-4 fixture import. Two problems with leaving
 * it there: a second suite could not reuse it without importing that test file
 * (which would re-register its whole `describe`), and a zero-arg builder can only
 * ever serve ONE fixture.
 *
 * So it takes the fixture as a PARAMETER. Its caller here is the Layer-4
 * desktop aggregate fixture (`golden-render-aggregates.json`), written by
 * `apps/desktop/test/golden/golden-layer4.ts`.
 */

import {
  InsightsSection,
  KpiFormat,
  type KpiStat,
} from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";

const FORMAT_MAP: Record<string, KpiFormat> = {
  number: KpiFormat.Number,
  currency: KpiFormat.Currency,
  percent: KpiFormat.Percent,
  duration: KpiFormat.Duration,
  tokens: KpiFormat.Tokens,
};

/** The frozen JSON shape both producers emit. */
export type GoldenSectionsFixture = {
  sections: {
    delivery: { kpis: { format: string }[]; charts: unknown };
    utilization: { kpis: { format: string }[]; charts: unknown };
    agents: { kpis: { format: string }[]; charts: unknown };
  };
};

// JSON imports infer structurally-narrow literal types (per-point optional value
// keys) that never "sufficiently overlap" with Record<string, number> series
// points, so each charts block crosses one explicit unknown boundary. The
// fixtures ARE the frozen runtime shape of the three section responses — each is
// deep-equalled against live producer output by its own golden suite, which is
// what keeps these casts honest.
type SectionCharts<S extends keyof InsightsSectionData> = NonNullable<
  InsightsSectionData[S]
>["charts"];

function section<S extends keyof InsightsSectionData>(block: {
  kpis: { format: string }[];
  charts: unknown;
}): NonNullable<InsightsSectionData[S]> {
  return {
    kpis: block.kpis.map((kpi) => ({
      ...kpi,
      format: FORMAT_MAP[kpi.format] ?? KpiFormat.Number,
    })) as KpiStat[],
    charts: block.charts as SectionCharts<S>,
  } as NonNullable<InsightsSectionData[S]>;
}

/** Adapt a frozen golden fixture into the prop bag the dashboard renders from. */
export function sectionsFromGoldenFixture(
  fixture: GoldenSectionsFixture
): InsightsSectionData {
  return {
    [InsightsSection.Delivery]: section<typeof InsightsSection.Delivery>(
      fixture.sections.delivery
    ),
    [InsightsSection.Utilization]: section<typeof InsightsSection.Utilization>(
      fixture.sections.utilization
    ),
    [InsightsSection.Agents]: section<typeof InsightsSection.Agents>(
      fixture.sections.agents
    ),
  };
}
