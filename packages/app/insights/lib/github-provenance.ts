import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsGitHubProvenance,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";

type InsightsResponse =
  | AgentsInsightsResponse
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse;

/**
 * Only Delivery and Utilization responses carry GitHub provenance; Agents does
 * not, which is why an `org` tile's availability resolves the way it does.
 */
export function getSectionGitHubProvenance(
  section: InsightsResponse | undefined
): InsightsGitHubProvenance | undefined {
  if (!(section && "githubProvenance" in section)) {
    return undefined;
  }

  return section.githubProvenance;
}
