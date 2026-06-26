import type {
  ActivityHeatmap as LoopsActivityHeatmap,
  AgentsInsightsResponse as LoopsAgentsInsightsResponse,
  CategoryBucket as LoopsCategoryBucket,
  DeliveryInsightsResponse as LoopsDeliveryInsightsResponse,
  DonutSlice as LoopsDonutSlice,
  InsightsPeriod as LoopsInsightsPeriod,
  InsightsScope as LoopsInsightsScope,
  InsightsSection as LoopsInsightsSection,
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
  InsightsPeriod as loopsInsightsPeriod,
  INSIGHTS_PERIOD_OPTIONS as loopsInsightsPeriodOptions,
  InsightsScope as loopsInsightsScope,
  INSIGHTS_SCOPE_OPTIONS as loopsInsightsScopeOptions,
  InsightsSection as loopsInsightsSection,
  INSIGHTS_SECTION_OPTIONS as loopsInsightsSectionOptions,
  KpiFormat as loopsKpiFormat,
} from "@closedloop-ai/loops-api/insights";

export const INSIGHTS_FEATURE_FLAG_KEY = loopsInsightsFeatureFlagKey;
export const InsightsPeriod = loopsInsightsPeriod;
export const INSIGHTS_PERIOD_OPTIONS = loopsInsightsPeriodOptions;
export const InsightsSection = loopsInsightsSection;
export const INSIGHTS_SECTION_OPTIONS = loopsInsightsSectionOptions;
export const InsightsScope = loopsInsightsScope;
export const INSIGHTS_SCOPE_OPTIONS = loopsInsightsScopeOptions;
export const KpiFormat = loopsKpiFormat;

export type InsightsPeriod = LoopsInsightsPeriod;
export type InsightsSection = LoopsInsightsSection;
export type InsightsScope = LoopsInsightsScope;
export type KpiFormat = LoopsKpiFormat;
export type KpiStat = LoopsKpiStat;
export type CategoryBucket = LoopsCategoryBucket;
export type DonutSlice = LoopsDonutSlice;
export type TimeSeriesSeries = LoopsTimeSeriesSeries;
export type TimeSeriesPoint = LoopsTimeSeriesPoint;
export type TimeSeries = LoopsTimeSeries;
export type ActivityHeatmap = LoopsActivityHeatmap;
export type ReviewerRow = LoopsReviewerRow;
export type DeliveryInsightsResponse = LoopsDeliveryInsightsResponse;
export type UtilizationInsightsResponse = LoopsUtilizationInsightsResponse;
export type AgentsInsightsResponse = LoopsAgentsInsightsResponse;
