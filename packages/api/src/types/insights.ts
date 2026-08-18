import type {
  ActivityHeatmap as LoopsActivityHeatmap,
  AgentPipelineEdge as LoopsAgentPipelineEdge,
  AgentPipelineGraphData as LoopsAgentPipelineGraphData,
  AgentPipelineNode as LoopsAgentPipelineNode,
  AgentsInsightsResponse as LoopsAgentsInsightsResponse,
  CategoryBucket as LoopsCategoryBucket,
  DeliveryInsightsResponse as LoopsDeliveryInsightsResponse,
  DonutSlice as LoopsDonutSlice,
  InsightsGitHubProvenance as LoopsInsightsGitHubProvenance,
  InsightsGitHubProvenanceState as LoopsInsightsGitHubProvenanceState,
  InsightsPeriod as LoopsInsightsPeriod,
  InsightsScope as LoopsInsightsScope,
  InsightsSection as LoopsInsightsSection,
  InsightsTileAvailabilityMap as LoopsInsightsTileAvailabilityMap,
  InsightsTileAvailabilityState as LoopsInsightsTileAvailabilityState,
  KpiDeltaBasis as LoopsKpiDeltaBasis,
  KpiFormat as LoopsKpiFormat,
  KpiStat as LoopsKpiStat,
  ReviewerRow as LoopsReviewerRow,
  TimeSeries as LoopsTimeSeries,
  TimeSeriesPoint as LoopsTimeSeriesPoint,
  TimeSeriesSeries as LoopsTimeSeriesSeries,
  UtilizationInsightsResponse as LoopsUtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  INSIGHTS_FEATURE_FLAG_KEY as loopsInsightsFeatureFlagKey,
  InsightsGitHubProvenanceState as loopsInsightsGitHubProvenanceState,
  InsightsPeriod as loopsInsightsPeriod,
  INSIGHTS_PERIOD_OPTIONS as loopsInsightsPeriodOptions,
  InsightsScope as loopsInsightsScope,
  INSIGHTS_SCOPE_OPTIONS as loopsInsightsScopeOptions,
  InsightsSection as loopsInsightsSection,
  INSIGHTS_SECTION_OPTIONS as loopsInsightsSectionOptions,
  InsightsTileAvailabilityState as loopsInsightsTileAvailabilityState,
  KpiDeltaBasis as loopsKpiDeltaBasis,
  KpiFormat as loopsKpiFormat,
} from "@closedloop-ai/loops-api/insights";

export const INSIGHTS_FEATURE_FLAG_KEY = loopsInsightsFeatureFlagKey;
export const InsightsGitHubProvenanceState = loopsInsightsGitHubProvenanceState;
export const InsightsPeriod = loopsInsightsPeriod;
export const INSIGHTS_PERIOD_OPTIONS = loopsInsightsPeriodOptions;
export const InsightsSection = loopsInsightsSection;
export const INSIGHTS_SECTION_OPTIONS = loopsInsightsSectionOptions;
export const InsightsScope = loopsInsightsScope;
export const INSIGHTS_SCOPE_OPTIONS = loopsInsightsScopeOptions;
export const KpiFormat = loopsKpiFormat;
export const KpiDeltaBasis = loopsKpiDeltaBasis;
export const InsightsTileAvailabilityState = loopsInsightsTileAvailabilityState;

export type InsightsPeriod = LoopsInsightsPeriod;
export type InsightsGitHubProvenanceState = LoopsInsightsGitHubProvenanceState;
export type InsightsGitHubProvenance = LoopsInsightsGitHubProvenance;
export type InsightsSection = LoopsInsightsSection;
export type InsightsScope = LoopsInsightsScope;
export type KpiFormat = LoopsKpiFormat;
export type KpiDeltaBasis = LoopsKpiDeltaBasis;
export type InsightsTileAvailabilityState = LoopsInsightsTileAvailabilityState;
export type InsightsTileAvailabilityMap = LoopsInsightsTileAvailabilityMap;
export type KpiStat = LoopsKpiStat;
export type CategoryBucket = LoopsCategoryBucket;
export type DonutSlice = LoopsDonutSlice;
export type TimeSeriesSeries = LoopsTimeSeriesSeries;
export type TimeSeriesPoint = LoopsTimeSeriesPoint;
export type TimeSeries = LoopsTimeSeries;
export type ActivityHeatmap = LoopsActivityHeatmap;
export type ReviewerRow = LoopsReviewerRow;
export type DeliveryInsightsResponse = LoopsDeliveryInsightsResponse & {
  tileAvailability?: InsightsTileAvailabilityMap;
  githubProvenance?: InsightsGitHubProvenance;
};
export type UtilizationInsightsResponse = LoopsUtilizationInsightsResponse & {
  tileAvailability?: InsightsTileAvailabilityMap;
  githubProvenance?: InsightsGitHubProvenance;
};
export type AgentsInsightsResponse = LoopsAgentsInsightsResponse & {
  tileAvailability?: InsightsTileAvailabilityMap;
};
export type AgentPipelineNode = LoopsAgentPipelineNode;
export type AgentPipelineEdge = LoopsAgentPipelineEdge;
export type AgentPipelineGraphData = LoopsAgentPipelineGraphData;
