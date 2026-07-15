import {
  InsightsGitHubProvenanceState,
  InsightsScope,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import {
  type AgentsInsightsResponse,
  type DeliveryInsightsResponse,
  type InsightsPeriod,
  type InsightsSection,
  InsightsSection as InsightsSectionValues,
  type UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import { z } from "zod";

const insightsTileAvailabilitySchema = z.record(
  z.string(),
  z.enum([
    InsightsTileAvailabilityState.Available,
    InsightsTileAvailabilityState.Gated,
    InsightsTileAvailabilityState.Unavailable,
  ])
);
const cloudInsightsBaseSchema = z.object({
  kpis: z.array(z.unknown()),
  charts: z.record(z.string(), z.unknown()),
});
const githubProvenanceSchema = z.object({
  checkedAt: z.string(),
  state: z.enum([
    InsightsGitHubProvenanceState.Active,
    InsightsGitHubProvenanceState.Disconnected,
  ]),
});
const cloudInsightsApiEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
});
const cloudInsightsWithAvailabilitySchema = cloudInsightsBaseSchema
  .extend({
    githubProvenance: githubProvenanceSchema.optional(),
    tileAvailability: insightsTileAvailabilitySchema.optional(),
  })
  .passthrough();
const cloudInsightsAgentsSchema = cloudInsightsBaseSchema
  .extend({
    tileAvailability: insightsTileAvailabilitySchema.optional(),
  })
  .passthrough();
const EMPTY_TIME_SERIES = { series: [], points: [] };

export type DesktopCloudInsightsFetchOptions = {
  getApiKey?: () => string | null;
  getApiOrigin?: () => string | undefined;
};

/**
 * Validates cloud Insights responses crossing from the API into Desktop main.
 * Delivery and utilization payloads keep optional availability/provenance fields
 * compatible with older API versions; the renderer fails closed when those
 * fields are absent or disconnected.
 */
export function isCloudInsightsResponse(
  section: InsightsSection,
  value: unknown
): value is
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse {
  return insightsResponseSchema(section).safeParse(value).success;
}

/**
 * Fetches org-scoped cloud Insights for Desktop. Any transport, status, JSON,
 * or schema failure returns null so callers can fail closed without leaking
 * local personal data into org scope.
 */
export async function fetchCloudInsights(
  section: InsightsSection,
  period: InsightsPeriod,
  options: DesktopCloudInsightsFetchOptions
): Promise<
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse
  | null
> {
  const apiKey = options.getApiKey?.();
  const apiOrigin = options.getApiOrigin?.();
  if (!(apiKey && apiOrigin)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(`/insights/${section}`, apiOrigin);
  } catch {
    return null;
  }
  url.searchParams.set("period", period);
  url.searchParams.set("scope", InsightsScope.Org);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const envelope = cloudInsightsApiEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    return null;
  }
  const data = envelope.data.data;
  return isCloudInsightsResponse(section, data) ? data : null;
}

/**
 * Build an org-scoped empty response for Desktop when cloud data cannot be
 * trusted. This preserves the org scope contract and lets the renderer show
 * gated/unavailable GitHub tiles instead of falling through to personal local
 * metrics.
 */
export function buildUnavailableCloudInsightsResponse(
  section: InsightsSection
):
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse {
  if (section === InsightsSectionValues.Utilization) {
    return {
      kpis: [],
      githubProvenance: disconnectedGitHubProvenance(),
      tileAvailability: {
        "kpi:backlog": InsightsTileAvailabilityState.Gated,
        "chart:reviewQueue": InsightsTileAvailabilityState.Gated,
        "chart:reviewQueue:donut": InsightsTileAvailabilityState.Gated,
        "chart:reviewerLoad": InsightsTileAvailabilityState.Gated,
      },
      charts: {
        eventActivity: EMPTY_TIME_SERIES,
        reviewQueue: [],
      },
    };
  }
  if (section === InsightsSectionValues.Agents) {
    return {
      kpis: [],
      charts: {
        modelUsageOverTime: EMPTY_TIME_SERIES,
        modelBreakdown: [],
      },
    };
  }
  return {
    kpis: [],
    githubProvenance: disconnectedGitHubProvenance(),
    tileAvailability: {
      "kpi:merged": InsightsTileAvailabilityState.Gated,
      "kpi:ttm": InsightsTileAvailabilityState.Gated,
      "kpi:merge-rate": InsightsTileAvailabilityState.Gated,
      "chart:branchesWithoutPr": InsightsTileAvailabilityState.Gated,
      "chart:branchesWithoutPr:donut": InsightsTileAvailabilityState.Gated,
      "chart:checkStatus": InsightsTileAvailabilityState.Gated,
      "chart:checkStatus:bar": InsightsTileAvailabilityState.Gated,
    },
    charts: {
      prTrend: EMPTY_TIME_SERIES,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}

function insightsResponseSchema(section: InsightsSection) {
  if (section === InsightsSectionValues.Agents) {
    return cloudInsightsAgentsSchema;
  }
  return cloudInsightsWithAvailabilitySchema;
}

function disconnectedGitHubProvenance() {
  return {
    checkedAt: new Date().toISOString(),
    state: InsightsGitHubProvenanceState.Disconnected,
  };
}
